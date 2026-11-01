/**
 * index.js — DSH 宿主侧入口。
 *
 * 一个项目里只有**一个** Router：本项目第一个开启插件、且不是 subagent 的根会话
 * 会认领该项目的 dataDir；后开的会话不会重复装工具，也不会重复消费 Trigger。
 * UI 存在的项目会把 Router 指针写成 `ui:true`，让面板 ensure 恢复同一条会话，而
 * 不是让每次 DSH 启动时的空白会话抢走 Router。这对应文章 §2 的“常驻 Router 层”。
 *
 * 安装链路：
 *
 *   agent/created
 *     → 跳过 subagent（header.origin / delegationDepth）
 *     → 读 <项目根>/.dsh/super-agent.json（默认关闭）
 *     → 认领 dataDir（owner.json + 进程内 claim）
 *     → 打开 journal，启动 runtime（恢复任务、watchdog、inbox watcher）
 *     → 把七个工具 + Router 提示词注册到这条 agent 的 scope 上
 *     → 若宿主有 connection 服务，注册 /api/super-agent/* 与 /ui/* 端点
 *     → UI ensure 用 sessionController 创建/恢复 Router，跨项目任务用普通 Session
 *
 * 失败绝不连坐：配置坏了、目录不可写、端口已经被别的 DSH 实例占用，都只记一条
 * warn，本次会话不装任何东西；`agent/created` 本身不能因为插件失败而失败。
 *
 * 状态目录里唯一会被覆盖的文件是 `owner.json`（租约）、`cursor.json`（读取偏移）
 * 与 `router.json`（UI Router 指针），都是本进程自己的写入边界；从不删除、
 * 不递归移动任何东西。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  checkDataDir,
  CONFIG_RELATIVE,
  defaultSuperAgentWorkspaceHome,
  findProjectRoot,
  isSuperAgentWorkspace,
  loadProjectConfig,
  PLUGIN_ID,
  SUPER_AGENT_WORKSPACE_MARKER,
  SUPER_AGENT_WORKSPACE_TITLE,
} from './config.js'
import { InternalSessionClaims } from './internal-sessions.js'
import { HTTP_PATHS } from './protocol.js'
import { routerContext, routerPrompt } from './prompt.js'
import { SuperAgentRuntime } from './runtime.js'
import { Store, storePaths } from './store.js'
import { createTools } from './tools.js'

/** 插件 id：用于日志与配置键。 */
export const name = PLUGIN_ID

/** 进程内的 dataDir 认领表：同一状态目录只允许一个 Router。
 * 用 globalThis 上的 Symbol 存，宿主 HMR 重新求值本模块时不会丢掉已有租约。 */
const CLAIMS_KEY = Symbol.for('dsh-super-agent.claims')
const claims = globalThis[CLAIMS_KEY] ?? new Map()
globalThis[CLAIMS_KEY] = claims

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx profile 根层的插件上下文。
 * @param {object} [config] profile 行配置（可选）。
 */
export function apply(ctx, config = {}) {
  ctx.inject(['agents'], (scoped) => {
    /** 每个 agent 的安装记录；用强引用是为了关停时能枚举。 */
    const records = new Map()

    /** 独立的 super-agent workspace：Router 的宿主目录，绝不是用户项目。 */
    const dedicatedHome = (() => {
      const configured = typeof config?.superAgentHome === 'string' ? config.superAgentHome.trim() : ''
      if (configured.length > 0) return resolve(configured)
      return defaultSuperAgentWorkspaceHome(process.env)
    })()

    /**
     * 确保独立 workspace 目录存在并注册到 DSH。目录只是 Router 会话的宿主；
     * `superagent_projects` 会把它排除在用户项目清单之外。
     */
    const ensureDedicatedWorkspace = async () => {
      if (!isAbsolute(dedicatedHome)) throw new Error(`super-agent workspace must be absolute: ${dedicatedHome}`)
      const accountDsh = join(homedir(), '.dsh')
      if (dedicatedHome === accountDsh || dedicatedHome.startsWith(`${accountDsh}${sep}`)) {
        throw new Error(`super-agent workspace cannot live under ~/.dsh: ${dedicatedHome}`)
      }
      mkdirSync(dedicatedHome, { recursive: true })
      const marker = join(dedicatedHome, SUPER_AGENT_WORKSPACE_MARKER)
      if (!existsSync(marker)) {
        writeFileSync(marker, `${JSON.stringify({ version: 1, purpose: 'super-agent-router-home' }, null, 2)}\n`)
      }
      const registry = safeGet(scoped, 'workspaceRegistry')
      let workspace
      if (typeof registry?.create === 'function') {
        try {
          workspace = await registry.create(dedicatedHome, SUPER_AGENT_WORKSPACE_TITLE)
        } catch (error) {
          log('warn', `注册 Super-agent 独立工作区失败（不影响 Router）：${error.message}`)
        }
      }
      if (workspace === undefined && typeof registry?.list === 'function') {
        try {
          workspace = registry.list().find((candidate) => candidate?.path === dedicatedHome)
        } catch {
          // 列表失败时不影响 Router 会话本身。
        }
      }
      return { home: dedicatedHome, workspace }
    }

    /** 把 Router 会话挂到独立 workspace 的会话分组里。 */
    const attachDedicatedWorkspace = async (workspace, sessionId) => {
      if (workspace === undefined || typeof workspace.attachSession !== 'function') return
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        log('warn', `把 Router 会话挂到独立工作区失败：${error.message}`)
      }
    }

    /** 独立 workspace 里的会话 id；UI 只显示当前 Router，旧 Router 在侧栏隐藏。 */
    const listWorkspaceSessions = () => {
      const registry = safeGet(scoped, 'workspaceRegistry')
      if (typeof registry?.list !== 'function') return []
      try {
        const row = registry.list().find((candidate) => isSuperAgentWorkspace(candidate?.path, dedicatedHome))
        return Array.isArray(row?.sessionIds) ? [...row.sessionIds] : []
      } catch {
        return []
      }
    }

    /**
     * 统一的日志出口。没有 logger 服务时退回 console，但只用于真正需要排查的
     * 失败，不往正常路径刷屏。
     */
    const log = (level, message, detail) => {
      try {
        const logger = scoped.logger
        if (typeof logger?.[level] === 'function') logger[level](`[${name}] ${message}`)
        else if (level === 'warn' || level === 'error') console.warn(`[${name}] ${message}`)
        if (detail !== undefined && typeof logger?.debug === 'function') logger.debug(detail)
      } catch {
        // 日志失败不影响会话。
      }
    }

    /** 判断是否为 subagent（Worker 不应该拿到 Router 工具）。 */
    const isSubagent = (agent) => {
      const header = agent?.session?.header
      return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
    }

    /**
     * Host-side project inventory for the Router. The UI deliberately has no
     * project picker: the Router asks for projects by title/path and chooses.
     */
    const listProjects = () => {
      let rows = []
      try {
        const registry = safeGet(scoped, 'workspaceRegistry')
        if (typeof registry?.list === 'function') rows = registry.list()
        else if (typeof registry?.snapshot === 'function') rows = registry.snapshot()
      } catch (error) {
        log('warn', `读取项目列表失败：${error.message}`)
        return []
      }
      const seen = new Set()
      const projects = []
      for (const row of Array.isArray(rows) ? rows : []) {
        const path = typeof row?.path === 'string' ? row.path : ''
        if (path.length === 0 || seen.has(path)) continue
        if (isSuperAgentWorkspace(path, dedicatedHome)) continue
        seen.add(path)
        projects.push({
          id: String(row.id ?? path),
          title: typeof row.title === 'string' && row.title.length > 0 ? row.title : basename(path),
          path,
        })
      }
      return projects
    }

    /**
     * 尝试安装到一条根会话。
     *
     * @param {object} agent 新建/恢复的 agent。
     */
    /** UI / 跨项目任务创建的普通 Session；它们绝不能反过来变成 Router。 */
    const reservedWorkerSessions = new Set()
    /** UI ensure 刚创建、还没有被 agent/created 安装的 Router 会话。 */
    const expectedRouterSessions = new Set()

    /**
     * 内部 worker 会话 → 通知抑制登记。
     *
     * worker 是普通 Session（header 上没有 subagent 标记），dsh-away-notify 只能按
     * 标题前缀兜底识别；由创建方主动登记后，用户改标题也不会再弹通知。服务缺失、
     * 没有 `markInternal`、调用抛错都静默降级，worker 创建/关闭完全不受影响。
     * 见 lib/internal-sessions.js。
     */
    const internalSessions = new InternalSessionClaims({
      service: () => safeGet(scoped, 'awayNotify'),
      log,
    })

    // away-notify 可能晚于本插件就绪，也可能热重载换实例：两种情况都重新登记一遍。
    try {
      scoped.inject?.(['awayNotify'], () => {
        try {
          internalSessions.sync()
        } catch (error) {
          log('debug', `同步内部会话登记失败：${error.message}`)
        }
      })
    } catch (error) {
      log('debug', `注入 awayNotify 失败（内部 worker 退回标题前缀）：${error.message}`)
    }

    const readRouterPointer = (dataDir) => {
      try {
        return JSON.parse(readFileSync(join(dataDir, 'router.json'), 'utf8'))
      } catch {
        return undefined
      }
    }

    const markRouterPointer = (record) => {
      try {
        writeFileSync(
          join(record.dataDir, 'router.json'),
          `${JSON.stringify({
            sessionId: record.agent.id,
            projectRoot: record.projectRoot,
            ui: true,
            updatedAt: new Date().toISOString(),
          }, null, 2)}\n`,
        )
      } catch (error) {
        log('warn', `写 UI Router 指针失败：${error.message}`)
      }
    }

    const maybeInstall = (agent) => {
      if (records.has(agent)) return
      if (reservedWorkerSessions.has(agent?.id)) return
      if (isSubagent(agent)) return
      const cwd = agent?.session?.header?.cwd
      const gate = loadProjectConfig({ cwd, pluginConfig: config })
      for (const warning of gate.warnings ?? []) log('warn', warning)
      if (!gate.enabled) {
        log('debug', gate.reason ?? '项目未开启')
        return
      }
      if (gate.config?.router?.sessionId && gate.config.router.sessionId !== agent.id) {
        log('debug', `Router 固定为 ${gate.config.router.sessionId}，跳过 ${agent.id}`)
        return
      }

      const dataDir = gate.dataDir
      const pointer = readRouterPointer(dataDir)
      if (pointer?.ui === true && pointer.sessionId !== agent.id && !expectedRouterSessions.has(agent.id)) {
        // 这个项目由 UI 管理，且上次的 Router 不是当前会话；不要抢在 UI
        // resume 之前把新开的空白会话变成 Router（否则每次重启都换会话）。
        log('debug', `UI Router 固定为 ${pointer.sessionId}，跳过 ${agent.id}`)
        return
      }
      if (!claim(dataDir, agent, log)) return
      const owner = claimOwnership(dataDir, agent, gate.projectRoot, log)
      if (!owner.ok) {
        claims.delete(dataDir)
        log('warn', owner.reason)
        return
      }

      let store
      let runtime
      try {
        store = new Store({ dir: dataDir, logger: { warn: (message) => log('warn', message) } })
        store.open()
        const subagents = safeGet(agent.ctx, 'subagents')

        /**
         * 跨项目 Worker：普通 Session 在目标项目里创建，header.cwd 就是目标，
         * 因而 fs sandbox 的 workspace-write 真正覆盖那个项目。只创建会话；
         * prompt 延迟到 runtime 把 workerSessionId 写进 journal、挂上事件监听之后。
         */
        const createSessionWorker = async ({ cwd, taskId, title, signal, prompt }) => {
          const controller = safeGet(scoped, 'sessionController')
          if (controller === undefined || typeof controller.create !== 'function' || typeof controller.resolveAgent !== 'function') {
            throw new Error('sessionController is unavailable for cross-project workers')
          }
          if (signal?.aborted) throw Object.assign(new Error('worker start aborted'), { name: 'AbortError' })
          const requestedId = `session-${randomUUID()}`
          reservedWorkerSessions.add(requestedId)
          const created = await controller.create({ cwd, sessionId: requestedId })
          const sessionId = created?.sessionId
          if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('worker session creation returned no id')
          reservedWorkerSessions.add(sessionId)
          const resolved = await controller.resolveAgent(sessionId)
          if (resolved?.agent === undefined) {
            throw new Error(`worker session ${sessionId} could not be resolved: ${resolved?.error?.message ?? 'unknown error'}`)
          }
          const workerAgent = resolved.agent
          // 从这一刻起这条会话就是内部 worker：通知侧据登记静默（标题前缀只是后备）。
          // 放在 resolveAgent 之后，失败路径不会留下没人释放的登记。
          internalSessions.register(sessionId)
          try {
            await controller.rename?.({
              sessionId,
              title: `Super-agent worker · ${String(title).slice(0, 80)}`,
            })
          } catch (error) {
            log('warn', `重命名 worker 会话失败：${error.message}`)
          }
          return {
            childId: sessionId,
            agent: workerAgent,
            async start() {
              if (signal?.aborted) throw Object.assign(new Error('worker start aborted'), { name: 'AbortError' })
              await controller.prompt({
                sessionId,
                mode: 'queue',
                requestId: `request-${randomUUID()}`,
                content: [{ type: 'text', text: String(prompt) }],
              }, signal)
            },
            async dispose() {
              try {
                await workerAgent.cancel?.({ kind: 'parent' })
              } catch {
                // 关任务时取消失败不影响 journal。
              }
              // 任务关闭后这条会话不会再跑；撤销登记，避免集合长期增长
              internalSessions.release(sessionId)
            },
            async archive() {
              internalSessions.release(sessionId)
              const registry = safeGet(scoped, 'workspaceRegistry')
              if (typeof registry?.archiveSession !== 'function') return
              try {
                await registry.archiveSession(sessionId, { stopActivity: true })
              } catch (error) {
                log('warn', `归档 Worker 会话失败：${error.message}`)
              }
            },
          }
        }

        runtime = new SuperAgentRuntime({
          agent,
          store,
          config: gate.config,
          projectRoot: gate.projectRoot,
          dataDir,
          subagents,
          sessionWorkers: { create: createSessionWorker },
          projects: listProjects,
          getAgent: (id) => {
            try {
              return scoped.agents.get(id)
            } catch {
              return undefined
            }
          },
          logger: {
            info: (message, detail) => log('info', message, detail),
            warn: (message, detail) => log('warn', message, detail),
            debug: (message, detail) => log('debug', message, detail),
            error: (message, detail) => log('error', message, detail),
          },
        })
        runtime.start()
        // UI 重启后用来恢复同一条 Router 会话；只是指针，不删除任何东西。
        try {
          const ui = expectedRouterSessions.has(agent.id) || pointer?.ui === true
          writeFileSync(
            join(gate.dataDir, 'router.json'),
            `${JSON.stringify({ sessionId: agent.id, projectRoot: gate.projectRoot, ui, updatedAt: new Date().toISOString() }, null, 2)}\n`,
          )
        } catch (error) {
          log('warn', `写 Router 会话指针失败：${error.message}`)
        }
      } catch (error) {
        try {
          store?.close()
        } catch {
          // 打开失败已经记录了原因。
        }
        releaseOwnership(dataDir, agent)
        claims.delete(dataDir)
        log('warn', `启动失败，本项目保持关闭：${error.message}`)
        return
      }

      const record = {
        agent,
        runtime,
        store,
        dataDir,
        projectRoot: gate.projectRoot,
        disposers: [],
        closed: false,
      }
      records.set(agent, record)
      log('info', `Router 已启动：${agent.id} · ${dataDir}`)

      registerTools(record, agent, runtime, log)
      registerPrompt(record, agent, runtime, gate.config, log)
      registerGuard(record, agent, gate.config, log)

      // 让其它插件/运维能看到这个项目有一条 Router。
      try {
        scoped.provide?.('superAgent', {
          version: 1,
          sessionId: agent.id,
          projectRoot: gate.projectRoot,
          dataDir,
          status: () => runtime.status('compact'),
          ingest: (event) => runtime.ingest(event),
        })
      } catch {
        // 服务名被占用或部署不支持 provide：不影响本插件。
      }
    }

    /** 解绑一条会话。 */
    const cleanup = (agent) => {
      const record = records.get(agent)
      if (record === undefined) return
      records.delete(agent)
      record.closed = true
      try {
        record.runtime.stop()
      } catch (error) {
        log('warn', `停止 runtime 失败：${error.message}`)
      }
      for (const dispose of record.disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          log('warn', `解绑注册失败：${error.message}`)
        }
      }
      try {
        record.store.close()
      } catch {
        // 关闭失败不再放大。
      }
      releaseOwnership(record.dataDir, agent)
      if (claims.get(record.dataDir)?.agentId === agent.id) claims.delete(record.dataDir)
    }

    /** 当前进程里仍活着的 Router；优先 UI 的独立 workspace。 */
    const activeRecord = () => {
      const live = [...records.values()].filter((candidate) => !candidate.closed)
      return live.find((candidate) => candidate.projectRoot === dedicatedHome)
        ?? live.find((candidate) => isSuperAgentWorkspace(candidate.projectRoot, dedicatedHome))
        ?? live[0]
    }

    /** 按项目根找 Router，找不到再退回任意 live Router。 */
    const recordForProject = (projectRoot) =>
      [...records.values()].find((candidate) => !candidate.closed && candidate.projectRoot === projectRoot)
      ?? activeRecord()

    /**
     * UI 的统一入口：确保这个 DSH 进程有一条 super-agent Router 会话。
     *
     * 面板不再要求用户选择工作区，也不借用用户项目。没有显式 cwd 时，Router
     * 固定在独立的 Super-agent workspace 里运行；这个 workspace 只属于 Router，
     * 不会出现在 `superagent_projects` 的项目清单里。具体任务仍由 Router 通过
     * `superagent_projects` / dispatch(project) 自主选择用户项目。
     *
     * @param {{ cwd?: string }} input 可选的显式运行目录（兼容脚本/测试）。
     * @returns {Promise<object>} 会话与项目信息。
     */
    const ensureRouter = async (input = {}) => {
      const explicit = typeof input.cwd === 'string' && input.cwd.length > 0 ? resolve(input.cwd) : undefined
      if (explicit !== undefined && !isAbsolute(explicit)) throw new Error('cwd must be absolute')
      if (explicit !== undefined) {
        let isDirectory = false
        try {
          isDirectory = statSync(explicit).isDirectory()
        } catch {
          isDirectory = false
        }
        if (!isDirectory) throw new Error(`project directory does not exist: ${explicit}`)
      }

      const dedicated = explicit === undefined ? await ensureDedicatedWorkspace() : undefined
      const requested = dedicated?.home ?? explicit
      const projectRoot = findProjectRoot(requested)
      const existing = explicit === undefined
        ? [...records.values()].find((candidate) => !candidate.closed && candidate.projectRoot === projectRoot)
        : recordForProject(projectRoot)
      if (existing !== undefined) {
        if (explicit !== undefined) {
          try {
            existing.runtime.setFocusProject(explicit)
          } catch (error) {
            log('warn', `设置 focus project 失败：${error.message}`)
          }
        }
        if (dedicated !== undefined) await attachDedicatedWorkspace(dedicated.workspace, existing.agent.id)
        markRouterPointer(existing)
        return {
          sessionId: existing.agent.id,
          projectRoot: existing.projectRoot,
          focusProject: existing.runtime.focusProject,
          status: existing.runtime.status('compact'),
          reused: true,
        }
      }

      let gate = loadProjectConfig({ cwd: projectRoot, pluginConfig: config })
      const configPath = join(projectRoot, CONFIG_RELATIVE)
      if (!gate.enabled && !existsSync(configPath) && !/profile 配置/.test(gate.reason ?? '')) {
        // 写配置之前先按默认/overlay 算一次数据根；拒绝把配置写进 ~/.dsh 等
        // 受保护位置，避免「写了一半才失败」。
        const probe = loadProjectConfig({ cwd: projectRoot, pluginConfig: config, allowMissing: true })
        if (probe?.dataDir !== undefined) {
          const problem = checkDataDir(probe.dataDir)
          if (problem !== undefined) throw new Error(problem)
        }
        // 用户从 UI 明确选择了这个项目；写最小开启配置，不覆盖已有文件。
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, `${JSON.stringify({ version: 1, enabled: true }, null, 2)}\n`)
        gate = loadProjectConfig({ cwd: projectRoot, pluginConfig: config })
      }
      if (!gate.enabled) throw new Error(gate.reason ?? 'project is not enabled')
      if (!gate.projectRoot || !gate.dataDir) throw new Error('project configuration did not resolve a data directory')

      const controller = safeGet(scoped, 'sessionController')
      if (controller === undefined || typeof controller.create !== 'function') {
        throw new Error('sessionController is unavailable in this deployment')
      }

      // 先尝试恢复上次这条 Router（`.dsh/super-agent/router.json`），避免每次
      // 重启 web 都新建一条会话。恢复失败（归档、被删、旧配置）才新建。
      let resumedId
      try {
        const pointer = JSON.parse(readFileSync(join(gate.dataDir, 'router.json'), 'utf8'))
        if (typeof pointer?.sessionId === 'string' && pointer.sessionId.length > 0) {
          const archived = safeGet(scoped, 'workspaceRegistry')?.archivedSessionIds
          if (Array.isArray(archived) && archived.includes(pointer.sessionId)) {
            throw new Error(`Router 会话 ${pointer.sessionId} 已归档`)
          }
          // 刚杀掉的旧 web 进程可能还在释放 Session writer，给恢复留一点重试窗口。
          let resolved
          for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
              resolved = await controller.resolveAgent(pointer.sessionId)
            } catch (error) {
              resolved = { error }
            }
            if (resolved?.agent !== undefined) break
            if (attempt === 0 || attempt === 7 || attempt === 19) {
              log('debug', `恢复 Router ${pointer.sessionId} 第 ${attempt + 1} 次失败：${resolved?.error?.message ?? 'no agent'}`)
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
          }
          if (resolved?.agent !== undefined) {
            // 恢复已有会话时 DSH 不保证重新发 agent/created；这里直接补一次安装，
            // 让重启后的 Router 有工具和提示词。安装是幂等的（records.has）。
            maybeInstall(resolved.agent)
            resumedId = pointer.sessionId
          } else {
            log('warn', `Router 会话 ${pointer.sessionId} 无法恢复，将新建一条：${resolved?.error?.message ?? 'unknown error'}`)
          }
        }
      } catch {
        // 没有指针或指针损坏：按首次启动处理。
      }
      if (resumedId !== undefined) {
        const deadline = Date.now() + 8_000
        let resumed
        while (Date.now() < deadline) {
          resumed = [...records.values()].find((candidate) => !candidate.closed && candidate.agent.id === resumedId)
          if (resumed !== undefined) break
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 60))
        }
        if (resumed !== undefined) {
          log('debug', `UI ensure 恢复 Router ${resumed.agent.id}`)
          if (explicit !== undefined) {
            try {
              resumed.runtime.setFocusProject(explicit)
            } catch (error) {
              log('warn', `设置 focus project 失败：${error.message}`)
            }
          }
          if (dedicated !== undefined) await attachDedicatedWorkspace(dedicated.workspace, resumed.agent.id)
          markRouterPointer(resumed)
          return {
            sessionId: resumed.agent.id,
            projectRoot: resumed.projectRoot,
            focusProject: resumed.runtime.focusProject,
            dataDir: resumed.dataDir,
            status: resumed.runtime.status('compact'),
            reused: true,
            resumed: true,
          }
        }
        log('warn', `Router 会话 ${resumedId} 恢复后 8 秒内没有激活，将新建一条`)
      }

      const expectedId = `session-${randomUUID()}`
      expectedRouterSessions.add(expectedId)
      const created = await controller.create({ cwd: projectRoot, sessionId: expectedId })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        expectedRouterSessions.delete(expectedId)
        throw new Error('session creation returned no session id')
      }
      if (sessionId !== expectedId) expectedRouterSessions.add(sessionId)

      // agent/created 是串行派发的；给插件最多 8 秒完成认领与注册。
      const deadline = Date.now() + 8_000
      let record
      while (Date.now() < deadline) {
        record = [...records.values()].find((candidate) => !candidate.closed && candidate.agent.id === sessionId)
        if (record !== undefined) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 60))
      }
      if (record === undefined) {
        throw new Error('session was created, but super-agent did not activate; check the project configuration and host logs')
      }
      if (explicit !== undefined) {
        try {
          record.runtime.setFocusProject(explicit)
        } catch (error) {
          log('warn', `设置 focus project 失败：${error.message}`)
        }
      }
      try {
        await controller.rename?.({
          sessionId,
          title: isSuperAgentWorkspace(projectRoot, dedicatedHome) ? SUPER_AGENT_WORKSPACE_TITLE : `Super-agent · ${basename(projectRoot)}`,
        })
      } catch (error) {
        log('warn', `重命名 Router 会话失败：${error.message}`)
      }
      expectedRouterSessions.delete(expectedId)
      expectedRouterSessions.delete(sessionId)
      if (dedicated !== undefined) await attachDedicatedWorkspace(dedicated.workspace, sessionId)
      markRouterPointer(record)
      return {
        sessionId,
        projectRoot,
        focusProject: record.runtime.focusProject,
        dataDir: record.dataDir,
        status: record.runtime.status('compact'),
        reused: false,
      }
    }

    /**
     * 重置 UI Router：中止当前 Worker，切到一个全新的 dataDir generation，
     * 再创建一条新 Router 会话。旧 journal / 旧会话都保留，不删除；旧 Worker 归档，旧 Router 保留但由 UI 隐藏。
     */
    const resetRouter = async () => {
      const active = [...records.values()].find(
        (candidate) => !candidate.closed && candidate.projectRoot === dedicatedHome,
      )
      if (active === undefined) {
        const next = await ensureRouter()
        return { ...next, reset: false, created: true }
      }
      const previousSessionId = active.agent.id
      const previousDataDir = active.dataDir
      const generation = join(
        dedicatedHome,
        '.dsh',
        'super-agent-resets',
        `gen-${Date.now()}-${randomUUID().slice(0, 8)}`,
      )
      let previous = {}
      try {
        const parsed = JSON.parse(readFileSync(join(dedicatedHome, CONFIG_RELATIVE), 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed
      } catch {
        // 没有/损坏的配置：reset 会写一份新的最小配置。
      }
      const previousRouter = previous.router !== null && typeof previous.router === 'object' && !Array.isArray(previous.router)
        ? { ...previous.router }
        : {}
      delete previousRouter.sessionId
      const nextConfig = {
        ...previous,
        version: 1,
        enabled: true,
        dataDir: generation,
        router: previousRouter,
      }
      try {
        writeFileSync(join(dedicatedHome, CONFIG_RELATIVE), `${JSON.stringify(nextConfig, null, 2)}\n`)
      } catch (error) {
        throw new Error(`reset could not write the new generation config: ${error.message}`)
      }

      const workerSessionIds = await active.runtime.abortWorkers()
      try {
        active.agent.cancel?.({ kind: 'parent' })
      } catch {
        // 旧 Router 正在结束 turn 时取消失败不影响 reset。
      }
      cleanup(active.agent)

      const registry = safeGet(scoped, 'workspaceRegistry')
      const archived = []
      if (typeof registry?.archiveSession === 'function') {
        await Promise.allSettled(workerSessionIds.map(async (sessionId) => {
          try {
            await registry.archiveSession(sessionId, { stopActivity: true })
            archived.push(sessionId)
          } catch (error) {
            log('warn', `reset 归档旧 Worker 会话 ${sessionId} 失败：${error.message}`)
          }
        }))
      }

      const next = await ensureRouter()
      return {
        ...next,
        reset: true,
        previousSessionId,
        previousDataDir,
        generation,
        archived,
        abortedWorkers: workerSessionIds.length,
      }
    }

    // UI 端点必须早于 Router 存在，否则第一次点击按钮没有入口可调。
    registerHttpRoutes(scoped, records, activeRecord, ensureRouter, resetRouter, listProjects, listWorkspaceSessions, log)

    // 恢复已有会话时也要判定一次（resume 会触发 agent/created）。
    for (const agent of scoped.agents.list()) {
      try {
        maybeInstall(agent)
      } catch (error) {
        log('warn', `恢复会话安装失败：${error.message}`)
      }
    }

    // Session 事件在 profile scope 上最可靠；转接给每个 runtime，由 worker
    // session id 过滤。Worker 自己的 agent ctx 监听是补充，不是唯一路径。
    scoped.on('session/event', (session, event) => {
      for (const record of records.values()) {
        try {
          record.runtime.observeSessionEvent(session, event)
        } catch {
          // 观察失败不影响 Session 本身。
        }
      }
    })

    scoped.on('agent/created', ({ agent }) => {
      try {
        maybeInstall(agent)
      } catch (error) {
        // 插件失败绝不能影响会话创建。
        log('warn', `安装失败，本次会话保持关闭：${error.message}`)
      }
    })

    scoped.on('agent/disposed', ({ agent }) => {
      // worker 会话被销毁（归档/宿主关停）时也要撤销通知登记，别让集合长期增长
      try {
        internalSessions.release(agent?.id)
      } catch {
        // 登记撤销失败不影响会话销毁。
      }
      try {
        cleanup(agent)
      } catch (error) {
        log('warn', `清理失败：${error.message}`)
      }
    })

    scoped.effect(() => () => {
      for (const agent of [...records.keys()]) {
        try {
          cleanup(agent)
        } catch {
          // 关停阶段不再放大错误。
        }
      }
      // 插件卸载后不该继续替已经不存在的 worker 抑制通知
      try {
        internalSessions.clear()
      } catch {
        // 关停阶段不再放大错误。
      }
    }, 'super-agent:runtimes()')
  })
}

/** 安全读取可选服务。 */
function safeGet(ctx, key) {
  try {
    return ctx?.get?.(key)
  } catch {
    return undefined
  }
}

/** 认领 dataDir；不同 agent 不能同时成为同一项目的 Router。 */
function claim(dataDir, agent, log) {
  const existing = claims.get(dataDir)
  if (existing !== undefined && existing.agentId !== agent.id) {
    log('warn', `状态目录已被 Router ${existing.agentId} 认领，会话 ${agent.id} 不安装工具：${dataDir}`)
    return false
  }
  claims.set(dataDir, { agentId: agent.id, at: Date.now() })
  return true
}

/**
 * 文件租约：防止两个 DSH 进程同时写同一个 journal。
 *
 * 租约只用于“避免同时写”，不是安全边界；同一进程内多会话由 claims 处理。
 * 进程崩溃后留下 owner.json 不影响下次启动：pid 不存活就会被覆盖。
 */
function claimOwnership(dataDir, agent, projectRoot, log) {
  try {
    mkdirSync(dataDir, { recursive: true })
    const path = storePaths(dataDir).owner
    if (existsSync(path)) {
      try {
        const existing = JSON.parse(readFileSync(path, 'utf8'))
        if (existing?.pid !== process.pid && !existing?.releasedAt && isAlive(existing?.pid)) {
          return {
            ok: false,
            reason: `状态目录被另一个 DSH 进程（pid ${existing.pid}）占用：${dataDir}`,
          }
        }
      } catch {
        // 坏文件按过期处理；下一次写入会覆盖。
      }
    }
    writeFileSync(path, `${JSON.stringify({
      v: 1,
      pid: process.pid,
      host: hostname(),
      sessionId: agent.id,
      project: projectRoot,
      startedAt: new Date().toISOString(),
      releasedAt: null,
    }, null, 2)}\n`)
    return { ok: true }
  } catch (error) {
    log('warn', `无法写状态目录租约：${error.message}`)
    return { ok: false, reason: `无法写状态目录：${error.message}` }
  }
}

/** 标记租约释放；不删除文件。 */
function releaseOwnership(dataDir, agent) {
  try {
    const path = storePaths(dataDir).owner
    if (!existsSync(path)) return
    let existing = {}
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      existing = {}
    }
    if (existing.sessionId !== undefined && existing.sessionId !== agent.id) return
    writeFileSync(path, `${JSON.stringify({
      ...existing,
      releasedAt: new Date().toISOString(),
    }, null, 2)}\n`)
  } catch {
    // 释放失败只会让下次启动看到租约；pid 已死就会被覆盖。
  }
}

/** pid 是否还活着；EPERM 视为活着。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 注册工具；inject 回调可能晚于关闭，用 record.closed 兜底。 */
function registerTools(record, agent, runtime, log) {
  agent.ctx.inject(['tools'], (scope) => {
    if (record.closed) return
    try {
      for (const definition of createTools(runtime)) {
        const dispose = scope.tools.register(definition)
        if (typeof dispose === 'function') record.disposers.push(dispose)
      }
    } catch (error) {
      log('warn', `注册工具失败：${error.message}`)
    }
  })
}

/** 注册 Router 系统提示词与动态上下文。 */
function registerPrompt(record, agent, runtime, config, log) {
  agent.ctx.inject(['systemPrompt'], (scope) => {
    if (record.closed) return
    try {
      const offSection = scope.systemPrompt.section({
        name: 'super-agent:router',
        order: 650,
        text: routerPrompt(config),
      })
      if (typeof offSection === 'function') record.disposers.push(offSection)
      const offContext = scope.systemPrompt.context({
        name: 'super-agent:router-state',
        order: 650,
        text: () => {
          if (record.closed || !runtime.active) return ''
          try {
            return routerContext(runtime)
          } catch {
            return ''
          }
        },
      })
      if (typeof offContext === 'function') record.disposers.push(offContext)
    } catch (error) {
      log('warn', `注册 Router 提示词失败：${error.message}`)
    }
  })
}

/** 可选的机制约束：Router 不直接执行任务。默认关闭，避免影响普通使用。 */
function registerGuard(record, agent, config, log) {
  if (config?.router?.guardExecutionTools !== true) return
  const guarded = new Set(Array.isArray(config.router.guardTools) ? config.router.guardTools : [])
  try {
    const off = agent.ctx.on('tools/pre-execute', (exec, next) => {
      if (guarded.has(exec?.name)) {
        return {
          kind: 'deny',
          reason: `super-agent router does not execute tasks directly (${exec.name}). Use superagent_dispatch to start a worker, or turn off router.guardExecutionTools.`,
        }
      }
      return next()
    })
    if (typeof off === 'function') record.disposers.push(off)
  } catch (error) {
    log('warn', `注册 Router 工具守卫失败：${error.message}`)
  }
}

/**
 * 注册全局 HTTP 端点。路由只注册一份：Router 可能还没有（UI 需要先调
 * `/ui/ensure` 创建它），所以不能像旧版那样把路由挂在某条 record 上。
 */
function registerHttpRoutes(scoped, records, activeRecord, ensureRouter, resetRouter, listProjects, listWorkspaceSessions, log) {
  scoped.inject(['connection'], (scope) => {
    const register = scope.connection?.fetch?.register
    if (typeof register !== 'function') return
    const disposers = []

    const addRoute = (route) => {
      try {
        const dispose = register.call(scope.connection.fetch, route)
        if (typeof dispose === 'function') {
          disposers.push(() => Promise.resolve().then(() => dispose()).catch(() => undefined))
        }
      } catch (error) {
        log('warn', `注册 HTTP 端点 ${route.path} 失败（${error.message}）`)
      }
    }

    const readJson = async (request) => {
      try {
        const body = await request.json()
        return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : undefined
      } catch {
        return undefined
      }
    }

    const routerView = (record) => ({
      sessionId: record.agent.id,
      projectRoot: record.projectRoot,
      dataDir: record.dataDir,
      focusProject: record.runtime.focusProject,
      status: record.runtime.status('compact'),
    })

    addRoute({
      path: HTTP_PATHS.ingest,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJson(request)
        if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router; open the Super-agent panel first' }, 409)
        try {
          const result = record.runtime.ingest({ ...body, externalId: body.externalId ?? body.id })
          return jsonResponse(result, result.ok ? 200 : 503)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.status,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 200)
        return jsonResponse({ ok: true, ...record.runtime.health(), snapshot: record.runtime.status('compact') }, 200)
      },
    })

    addRoute({
      path: HTTP_PATHS.outbox,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const url = new URL(request.url)
        const channel = url.searchParams.get('channel') ?? undefined
        const sinceRaw = url.searchParams.get('since')
        const since = sinceRaw === null ? undefined : Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : Date.parse(sinceRaw)
        const limitRaw = Number(url.searchParams.get('limit') ?? 50)
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50
        return jsonResponse({ ok: true, messages: readOutbox(record.runtime.store.paths.outbox, { channel, since, limit }) }, 200)
      },
    })

    addRoute({
      path: HTTP_PATHS.uiState,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const active = activeRecord()
        return jsonResponse({
          ok: true,
          active: active !== undefined,
          router: active === undefined ? null : routerView(active),
          routers: [...records.values()].filter((record) => !record.closed).map(routerView),
          projects: listProjects(),
          workspaceSessions: listWorkspaceSessions(),
        }, 200)
      },
    })

    addRoute({
      path: HTTP_PATHS.uiEnsure,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = (await readJson(request)) ?? {}
        if (body.cwd !== undefined && typeof body.cwd !== 'string') {
          return jsonResponse({ ok: false, error: 'cwd must be a string when provided' }, 400)
        }
        try {
          const result = await ensureRouter(body.cwd === undefined ? {} : { cwd: body.cwd })
          return jsonResponse({ ok: true, ...result }, 200)
        } catch (error) {
          log('warn', `UI ensure 失败：${error.message}`)
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiReset,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const result = await resetRouter()
          return jsonResponse({ ok: true, ...result }, 200)
        } catch (error) {
          log('warn', `UI reset 失败：${error.message}`)
          return jsonResponse({ ok: false, error: error.message }, 500)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiFocus,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJson(request)
        if (body === undefined || typeof body.cwd !== 'string') {
          return jsonResponse({ ok: false, error: 'cwd is required' }, 400)
        }
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        try {
          const result = record.runtime.setFocusProject(body.cwd)
          return jsonResponse({ ok: true, ...result }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    if (typeof scope.effect === 'function') {
      scope.effect(() => () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose()
          } catch {
            // 路由关闭失败不影响插件卸载。
          }
        }
      }, 'super-agent:http-routes')
    }
  })
}

/** 读 outbox 的尾部；只读，不标记已发送。 */
function readOutbox(path, options) {
  if (!existsSync(path)) return []
  let lines
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return []
  }
  const messages = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (options.channel !== undefined && value.channel !== options.channel) continue
    if (options.since !== undefined && Number.isFinite(options.since) && value.createdAt < options.since) continue
    messages.push(value)
  }
  return messages.slice(-options.limit)
}

/** 标准 JSON 响应。 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
