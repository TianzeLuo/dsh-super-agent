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
import { panelAlive, replyEffect } from './attendance.js'
import { InternalSessionClaims } from './internal-sessions.js'
import { agreementStorePath } from './agreements.js'
import { installHostGoalGuard } from './host-goals.js'
import { InstanceRegistry, DEFAULT_INSTANCE_ID } from './instances.js'
import { HTTP_PATHS } from './protocol.js'
import { routerContext, routerPrompt } from './prompt.js'
import { SuperAgentRuntime } from './runtime.js'
import { createScheduleBridge } from './schedule-bridge.js'
import { Store, storePaths } from './store.js'
import { createTools } from './tools.js'

/** 插件 id：用于日志与配置键。 */
export const name = PLUGIN_ID

/** 进程内的 dataDir 认领表：同一状态目录只允许一个 Router。
 * 用 globalThis 上的 Symbol 存，宿主 HMR 重新求值本模块时不会丢掉已有租约。 */
const CLAIMS_KEY = Symbol.for('dsh-super-agent.claims')
const claims = globalThis[CLAIMS_KEY] ?? new Map()
globalThis[CLAIMS_KEY] = claims

/** 读取一个 JSON 对象；缺失/坏文件一律当空对象，配置读取不能抛。 */
function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 从 `models.defaults` 读取已保存的默认集合；坏项静默跳过。 */
function readSavedModelDefaults(configPath) {
  const raw = readJsonObject(configPath)
  return cleanModelDefaults(raw?.models?.defaults, { strict: false })
}

/**
 * 默认模型集合的规范化。`strict` 时对 API 输入报错；加载配置文件时静默跳过坏项。
 *
 * @param {unknown} input
 * @param {{ strict?: boolean }} [options]
 * @returns {object[]}
 */
export function cleanModelDefaults(input, options = {}) {
  if (!Array.isArray(input)) {
    if (options.strict === true) throw new Error('defaults must be an array')
    return []
  }
  const out = []
  for (const [index, entry] of input.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      if (options.strict === true) throw new Error(`defaults[${index}] must be an object`)
      continue
    }
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (provider.length === 0 || model.length === 0) {
      if (options.strict === true) throw new Error(`defaults[${index}] requires provider and model`)
      continue
    }
    const clean = { provider, model }
    if (typeof entry.id === 'string' && entry.id.trim().length > 0) clean.id = entry.id.trim()
    if (typeof entry.label === 'string' && entry.label.trim().length > 0) clean.label = entry.label.trim()
    if (Array.isArray(entry.efforts)) {
      clean.efforts = entry.efforts
        .filter((effort) => typeof effort === 'string' && effort.trim().length > 0)
        .map((effort) => effort.trim())
    }
    if (typeof entry.defaultEffort === 'string' && entry.defaultEffort.trim().length > 0) clean.defaultEffort = entry.defaultEffort.trim()
    if (typeof entry.note === 'string' && entry.note.trim().length > 0) clean.note = entry.note.trim()
    if (out.some((candidate) => candidate.provider === clean.provider && candidate.model === clean.model)) continue
    out.push(clean)
  }
  return out
}

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
     * 多实例注册表。默认实例固定占用锚点根目录（旧数据原地升级）；新实例在
     * `instances/<id>` 下拥有独立 home/config/dataDir，但不再登记第二个 DSH
     * workspace —— 侧栏只保留一个 Super-agent Workspace 入口。
     */
    const instances = new InstanceRegistry(dedicatedHome, {
      log: (level, message) => {
        try {
          const logger = scoped.logger
          if (typeof logger?.[level] === 'function') logger[level](`[${name}] ${message}`)
          else if (level === 'warn' || level === 'error') console.warn(`[${name}] ${message}`)
        } catch {
          // 注册表日志失败不影响插件。
        }
      },
    })
    let activeInstanceId = DEFAULT_INSTANCE_ID
    let panelActive = false
    let panelSeenAt = 0
    let uiVisible = true

    /** 未读的 +1 与清零共用的唯一判定见 attendance.js（replyEffect）。 */
    const panelIsActive = () => panelActive && panelAlive(panelSeenAt)

    /** 当前 UI 选中的实例；无效 id 回退默认实例。 */
    const selectedInstance = (id) => {
      const requested = typeof id === 'string' && id.length > 0 ? id : activeInstanceId
      return instances.get(requested) ?? instances.getDefault()
    }

    /** 按实例 id 找 live Router；绝不跨实例回退，避免 UI 看到另一个实例的状态。 */
    const recordForInstance = (id) => [...records.values()].find(
      (candidate) => !candidate.closed && candidate.instanceId === id,
    )

    /** 确保实例 home/config 存在；只补缺，不覆盖用户配置。 */
    const ensureInstanceHome = async (instance) => {
      const home = instance.home
      if (!isAbsolute(home)) throw new Error(`super-agent instance home must be absolute: ${home}`)
      const accountDsh = join(homedir(), '.dsh')
      if (home === accountDsh || home.startsWith(`${accountDsh}${sep}`)) {
        throw new Error(`super-agent instance cannot live under ~/.dsh: ${home}`)
      }
      mkdirSync(home, { recursive: true })
      const marker = join(home, SUPER_AGENT_WORKSPACE_MARKER)
      if (!existsSync(marker)) {
        writeFileSync(marker, `${JSON.stringify({ version: 1, purpose: 'super-agent-router-home', instanceId: instance.id }, null, 2)}\n`)
      }
      const configPath = join(home, CONFIG_RELATIVE)
      if (!existsSync(configPath)) {
        // 新实例继承 profile 级默认集合：有就写进自己的 config；没有才保持空
        // （空 models 仍按宿主目录全量，兼容旧行为）。
        const saved = readSavedModelDefaults(join(dedicatedHome, CONFIG_RELATIVE))
        const fallback = cleanModelDefaults(config?.models?.defaults, { strict: false })
        const defaults = saved.length > 0 ? saved : fallback
        const next = { version: 1, enabled: true }
        if (defaults.length > 0) next.models = { defaults }
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`)
      }
      return home
    }

    /** 所有受管实例的 live Router session id；客户端据此隐藏内部会话行。 */
    const listRouterSessionIds = () => [...records.values()]
      .filter((record) => !record.closed && typeof record.instanceId === 'string')
      .map((record) => record.agent.id)

    /** 把实例目录挂到唯一锚点 workspace；非默认实例不登记新的 workspace。 */
    const attachInstanceWorkspace = async (instance, workspace, sessionId) => {
      if (instance.id !== DEFAULT_INSTANCE_ID) return
      await attachDedicatedWorkspace(workspace, sessionId)
    }

    /** 锚点 workspace 只注册一次；重复 ensure 不制造第二个侧栏条目。 */
    let dedicatedWorkspaceCache

    /**
     * 确保独立 workspace 目录存在并注册到 DSH。目录只是 Router 会话的宿主；
     * `superagent_projects` 会把它排除在用户项目清单之外。
     */
    const ensureDedicatedWorkspace = async () => {
      if (dedicatedWorkspaceCache !== undefined) return dedicatedWorkspaceCache
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
      const resolved = { home: dedicatedHome, workspace }
      if (workspace !== undefined) dedicatedWorkspaceCache = resolved
      return resolved
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

    // ── 宿主服务桥：模型目录 / 模型选择 / 定时任务 / 配置写回 ─────────────

    /** 宿主模型目录缓存；catalog 可能比较贵，30 秒内复用。 */
    let modelCatalogCache
    let modelCatalogAt = 0

    const readModelCatalog = async (force = false) => {
      const controller = safeGet(scoped, 'sessionController')
      if (typeof controller?.modelCatalog !== 'function') {
        return { groups: [], failures: [{ provider: 'session-controller', message: 'modelCatalog is unavailable' }], default: undefined }
      }
      if (!force && modelCatalogCache !== undefined && Date.now() - modelCatalogAt < 30_000) return modelCatalogCache
      try {
        modelCatalogCache = await controller.modelCatalog()
        modelCatalogAt = Date.now()
        return modelCatalogCache
      } catch (error) {
        log('warn', `读取模型目录失败：${error.message}`)
        return { groups: [], failures: [{ provider: 'session-controller', message: error.message }], default: undefined }
      }
    }

    const defaultModelSelection = () => {
      try {
        const service = safeGet(scoped, 'agentDefaultModel')
        return typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 给一条普通 Session（跨项目 Worker）设置模型。`selectModel` 会把选择保存成
     * 部署默认值；Worker 只是临时借用，所以在它之后立刻恢复用户原来的默认值。
     * 用一条 promise 链串行化，避免多个 Worker 交错把默认值改乱。
     */
    let modelSelectionChain = Promise.resolve()
    const selectSessionModel = (sessionId, selection) => {
      const run = async () => {
        const controller = safeGet(scoped, 'sessionController')
        if (typeof controller?.selectModel !== 'function') {
          throw new Error('sessionController.selectModel is unavailable')
        }
        const defaults = safeGet(scoped, 'agentDefaultModel')
        let previous
        try {
          previous = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
        } catch {
          previous = undefined
        }
        await controller.selectModel({ sessionId, ...selection })
        if (previous !== undefined && typeof defaults?.saveSelection === 'function') {
          try {
            await defaults.saveSelection(previous)
          } catch (error) {
            log('warn', `恢复默认模型失败（Worker 已完成选择）：${error.message}`)
          }
        }
      }
      const next = modelSelectionChain.then(run, run)
      modelSelectionChain = next.catch(() => undefined)
      return next
    }

    /** 宿主 ctx.schedule 的薄适配；0.2.1 与 0.2.2 两代契约见 schedule-bridge.js。 */
    const scheduleBridge = createScheduleBridge(() => safeGet(scoped, 'schedule'))

    /**
     * 把 UI 的修改写回项目配置文件。只合并顶层 patch，不把合并后的默认值整份
     * 落盘（否则以后升级默认值会被旧配置钉死）。
     */
    const persistConfigPatch = (configPath, patch) => {
      if (typeof configPath !== 'string' || configPath.length === 0) {
        throw new Error('project config path is unavailable')
      }
      let raw = {}
      try {
        if (existsSync(configPath)) {
          const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed
        }
      } catch (error) {
        throw new Error(`cannot read project config: ${error.message}`)
      }
      const next = { ...raw, ...patch }
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      return next
    }

    /** 只合并 models 子对象，避免为了写 defaults 把 allowed/default 等整块覆盖掉。 */
    const patchModelsConfig = (configPath, patch) => {
      let raw = {}
      try {
        if (existsSync(configPath)) {
          const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed
        }
      } catch (error) {
        throw new Error(`cannot read project config: ${error.message}`)
      }
      const current = raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models) ? raw.models : {}
      return persistConfigPatch(configPath, { models: { ...current, ...patch } })
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
         * 当前 Router 会话的附件桥：把聊天里粘贴/上传的附件（`user/message`
         * 的 image/file content part）解析成宿主磁盘对象，交给 runtime 复制进
         * worker 暂存目录。只读：不写宿主 attachment store。
         *
         * `agent.session` 是宿主 live Session（`deriveMessages()` 读当前历史）；
         * 个别宿主版本若只暴露 session store，则回退到 `ctx.sessions.get(id)`。
         * attachment service 可能挂在 agent scope 或 root scope，两处都试。
         */
        const attachmentStore = safeGet(agent.ctx, 'attachments') ?? safeGet(scoped, 'attachments')
        const liveSession = () => {
          if (agent.session !== undefined && typeof agent.session?.deriveMessages === 'function') return agent.session
          return safeGet(agent.ctx, 'sessions')?.get?.(agent.id) ?? safeGet(scoped, 'sessions')?.get?.(agent.id)
        }
        const attachmentSource = {
          sessionId: agent.id,
          messages: () => {
            const session = liveSession()
            if (typeof session?.deriveMessages !== 'function') {
              throw new Error('the live Router session is unavailable')
            }
            return session.deriveMessages()
          },
          imageHostPath: (ref) => attachmentStore?.imageHostPath?.(ref),
          fileHostPath: (ref) => attachmentStore?.fileHostPath?.(ref),
        }

        /**
         * 跨项目 Worker：普通 Session 在目标项目里创建，header.cwd 就是目标，
         * 因而 fs sandbox 的 workspace-write 真正覆盖那个项目。只创建会话；
         * prompt 延迟到 runtime 把 workerSessionId 写进 journal、挂上事件监听之后。
         */
        const createSessionWorker = async ({ cwd, taskId, title, signal, prompt, modelSelection }) => {
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
          // 宿主可能把传入的 session id 规范化（或省略 `session-` 前缀）后再返回；
          // resolveAgent 给出的 agent.id 才是后续 prompt/rename/事件订阅都能用的 canonical id。
          const headerId = workerAgent.session?.header?.id
          const childId = typeof headerId === 'string' && headerId.length > 0
            ? headerId
            : (typeof workerAgent.id === 'string' && workerAgent.id.length > 0 ? workerAgent.id : sessionId)
          reservedWorkerSessions.add(childId)
          // 从这一刻起这条会话就是内部 worker：通知侧据登记静默（标题前缀只是后备）。
          // 放在 resolveAgent 之后，失败路径不会留下没人释放的登记。
          internalSessions.register(childId)
          if (modelSelection !== undefined) {
            try {
              await selectSessionModel(childId, modelSelection)
            } catch (error) {
              // 登记用的是 canonical childId；释放也必须用同一个 id。
              internalSessions.release(childId)
              try {
                await workerAgent.cancel?.({ kind: 'parent' })
              } catch {
                // 取消失败不影响原始错误。
              }
              throw new Error(`could not set worker model: ${error.message}`)
            }
          }
          try {
            await controller.rename?.({
              sessionId,
              title: `Super-agent worker · ${String(title).slice(0, 80)}`,
            })
          } catch (error) {
            log('warn', `重命名 worker 会话失败：${error.message}`)
          }
          return {
            childId,
            agent: workerAgent,
            async start() {
              if (signal?.aborted) throw Object.assign(new Error('worker start aborted'), { name: 'AbortError' })
              await controller.prompt({
                sessionId: childId,
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
              internalSessions.release(childId)
            },
            async archive() {
              internalSessions.release(childId)
              const registry = safeGet(scoped, 'workspaceRegistry')
              if (typeof registry?.archiveSession !== 'function') return
              try {
                await registry.archiveSession(childId, { stopActivity: true })
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
          attachmentSource,
          sessionWorkers: { create: createSessionWorker },
          models: {
            catalog: readModelCatalog,
            defaultSelection: defaultModelSelection,
            selectSession: selectSessionModel,
          },
          schedule: scheduleBridge,
          agreementsPath: agreementStorePath(gate.projectRoot, gate.config?.agreements?.fileName),
          projects: listProjects,
          getAgent: (id) => {
            try {
              return scoped.agents.get(id)
            } catch {
              return undefined
            }
          },
          // 重启恢复：Worker 会话的正文只在磁盘上（`~/.dsh/sessions/<project>/<id>/`），
          // 必须由 sessionController 把它重新装回内存才能继续对话。
          resumeWorker: async (sessionId) => {
            const controller = safeGet(scoped, 'sessionController')
            if (controller === undefined || typeof controller.resolveAgent !== 'function') return undefined
            try {
              const found = await controller.resolveAgent(sessionId)
              const workerAgent = found?.agent
              if (workerAgent === undefined) {
                log('warn', `恢复 worker 会话 ${sessionId} 失败：${found?.error?.message ?? 'unknown error'}`)
                return undefined
              }
              const headerId = workerAgent.session?.header?.id
              // 救回来的会话仍然是内部 worker：重新登记，让通知侧继续静默。
              internalSessions.register(typeof headerId === 'string' && headerId.length > 0 ? headerId : sessionId)
              return workerAgent
            } catch (error) {
              log('warn', `恢复 worker 会话 ${sessionId} 失败：${error.message}`)
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
        // 一次性迁移：会话里已存在的宿主 goal 复制成 manual 节奏的原生目标（幂等）。
        // 不 await：agent/created 不能因为迁移慢而阻塞；失败只记日志。
        void runtime.migrateHostGoalOnce().then((adoption) => {
          if (adoption?.migrated === true) {
            log('info', `已把宿主 goal 迁移成原生目标：${adoption.objectiveId}`)
          } else if (adoption?.reason === 'already_migrated') {
            log('debug', `宿主 goal 已迁移过：${adoption.objectiveId}`)
          }
        }).catch((error) => log('warn', `迁移宿主 goal 失败：${error.message}`))
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
        instanceId: instances.findByHome(gate.projectRoot)?.id,
        configPath: gate.configPath,
        disposers: [],
        closed: false,
      }
      records.set(agent, record)
      log('info', `Router 已启动：${agent.id} · ${dataDir}`)

      registerTools(record, agent, runtime, log)
      registerPrompt(record, agent, runtime, gate.config, log)
      registerGuard(record, agent, gate.config, log)

      // 宿主 goal 在本 Router 会话里只读：摘掉 create_goal/update_goal、拒绝执行、
      // 并 disarm 掉已有的续轮授权。否则每轮结束 goal-round-driver 都会再唤醒一次。
      // 只作用于这一条会话，普通会话不装本插件，因此不受影响。
      try {
        const hostGoals = installHostGoalGuard({
          agent,
          tools: safeGet(agent.ctx, 'tools'),
          goals: safeGet(agent.ctx, 'goals'),
          log,
        })
        if (typeof hostGoals.dispose === 'function') record.disposers.push(hostGoals.dispose)
        for (const note of hostGoals.notes ?? []) log('debug', note)
        log('info', `宿主 goal 已禁用：restrict=${hostGoals.restricted.length ? hostGoals.restricted.join(',') : '-'} · guard=${hostGoals.guarded} · disarmed=${hostGoals.disarmed}`)
      } catch (error) {
        log('warn', `禁用宿主 goal 失败：${error.message}`)
      }

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

    /** 当前 UI 实例的 live Router；跨实例不兜底，只允许旧版显式项目会话作为测试/兼容路径。 */
    const activeRecord = () => recordForInstance(activeInstanceId)
      ?? [...records.values()].find((candidate) => !candidate.closed && candidate.instanceId === undefined)

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

      // 无显式 cwd 是 UI 路径：选实例 home；显式 cwd 保留原有跨项目/测试语义。
      const instance = explicit === undefined ? selectedInstance(input.instanceId) : undefined
      if (instance !== undefined) activeInstanceId = instance.id
      const dedicated = explicit === undefined ? await ensureDedicatedWorkspace() : undefined
      if (instance !== undefined) await ensureInstanceHome(instance)
      const requested = instance?.home ?? explicit
      const projectRoot = findProjectRoot(requested)
      const existing = instance !== undefined
        ? recordForInstance(instance.id)
        : recordForProject(projectRoot)
      if (existing !== undefined) {
        if (explicit !== undefined) {
          try {
            existing.runtime.setFocusProject(explicit)
          } catch (error) {
            log('warn', `设置 focus project 失败：${error.message}`)
          }
        }
        if (instance !== undefined) await attachInstanceWorkspace(instance, dedicated?.workspace, existing.agent.id)
        markRouterPointer(existing)
        return {
          sessionId: existing.agent.id,
          instanceId: instance?.id ?? existing.instanceId,
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
          if (instance !== undefined) await attachInstanceWorkspace(instance, dedicated?.workspace, resumed.agent.id)
          markRouterPointer(resumed)
          return {
            sessionId: resumed.agent.id,
            instanceId: instance?.id ?? resumed.instanceId,
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
          title: instance === undefined
            ? (isSuperAgentWorkspace(projectRoot, dedicatedHome) ? SUPER_AGENT_WORKSPACE_TITLE : `Super-agent · ${basename(projectRoot)}`)
            : (instance.id === DEFAULT_INSTANCE_ID ? SUPER_AGENT_WORKSPACE_TITLE : `Super-agent · ${instance.name}`),
        })
      } catch (error) {
        log('warn', `重命名 Router 会话失败：${error.message}`)
      }
      expectedRouterSessions.delete(expectedId)
      expectedRouterSessions.delete(sessionId)
      if (instance !== undefined) await attachInstanceWorkspace(instance, dedicated?.workspace, sessionId)
      markRouterPointer(record)
      return {
        sessionId,
        instanceId: instance?.id ?? record.instanceId,
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
    const resetRouter = async (requestedInstanceId) => {
      const instance = selectedInstance(requestedInstanceId)
      if (instance === undefined) throw new Error('no super-agent instance is available')
      activeInstanceId = instance.id
      await ensureInstanceHome(instance)
      const active = recordForInstance(instance.id)
      if (active === undefined) {
        const next = await ensureRouter({ instanceId: instance.id })
        return { ...next, reset: false, created: true }
      }
      const previousSessionId = active.agent.id
      const previousDataDir = active.dataDir
      const generation = join(
        instance.home,
        '.dsh',
        'super-agent-resets',
        `gen-${Date.now()}-${randomUUID().slice(0, 8)}`,
      )
      let previous = {}
      try {
        const parsed = JSON.parse(readFileSync(join(instance.home, CONFIG_RELATIVE), 'utf8'))
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
        writeFileSync(join(instance.home, CONFIG_RELATIVE), `${JSON.stringify(nextConfig, null, 2)}\n`)
      } catch (error) {
        throw new Error(`reset could not write the new generation config: ${error.message}`)
      }

      // 定时任务绑定 Router 会话；Reset 前必须取消，否则旧 reminder 会唤醒
      // 已经隐藏的旧 Router，而新 Router 看不到这些任务。
      let schedulesCanceled = 0
      try {
        const canceled = await active.runtime.cancelAllSchedules()
        schedulesCanceled = canceled.canceled.length
        for (const failure of canceled.failed) log('warn', `Reset 取消定时任务 ${failure.id} 失败：${failure.error}`)
      } catch (error) {
        log('warn', `Reset 取消定时任务失败：${error.message}`)
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

      const next = await ensureRouter({ instanceId: instance.id })
      return {
        ...next,
        reset: true,
        previousSessionId,
        previousDataDir,
        generation,
        archived,
        abortedWorkers: workerSessionIds.length,
        schedulesCanceled,
      }
    }

    /** UI 需要的实例摘要；未读总数由注册表实时汇总。 */
    const instancesState = () => ({
      instances: instances.list(),
      activeInstanceId,
      unreadTotal: instances.unreadTotal(),
      routerSessionIds: listRouterSessionIds(),
      panelActive: panelIsActive(),
      uiVisible,
    })

    /** UI 切换实例时同步活跃/可见状态；read=true 用“进入即已读”的语义。 */
    const activateInstance = (id, options = {}) => {
      const instance = instances.get(id)
      if (instance === undefined) throw new Error(`未知实例：${id}`)
      activeInstanceId = instance.id
      if (typeof options.panel === 'boolean') {
        panelActive = options.panel
        panelSeenAt = options.panel ? Date.now() : 0
      }
      if (typeof options.visible === 'boolean') uiVisible = options.visible
      if (options.read === true) instances.clearUnread(instance.id)
      return instancesState()
    }

    /** 创建实例只落注册表与独立 home；Router 在用户切过去时再 ensure。 */
    const createInstance = async (name) => {
      const instance = instances.create(name)
      await ensureInstanceHome(instance)
      return instance
    }

    /**
     * 保存“默认勾选集合”。
     *
     * 同时写两处：
     *   - profile 级（默认实例的 config）：新建实例从这里继承；
     *   - 当前实例的 config：本实例的 dispatch / 新会话立即按它生效。
     * 不改 allowed；只把 `models.defaults` 合并进去，避免覆盖用户已有配置。
     */
    const saveModelDefaults = async (input) => {
      const defaults = cleanModelDefaults(input, { strict: true })
      const record = activeRecord()
      if (record === undefined) throw new Error('no active super-agent router')
      const profileConfigPath = join(dedicatedHome, CONFIG_RELATIVE)
      patchModelsConfig(profileConfigPath, { defaults })
      if (record.configPath !== profileConfigPath) patchModelsConfig(record.configPath, { defaults })
      record.runtime.setModels({ ...(record.runtime.config?.models ?? {}), defaults })
      return record.runtime.modelView(true)
    }

    // UI 端点必须早于 Router 存在，否则第一次点击按钮没有入口可调。
    registerHttpRoutes(scoped, records, activeRecord, ensureRouter, resetRouter, listProjects, listWorkspaceSessions, log, {
      persistConfigPatch,
      readModelCatalog,
      defaultModelSelection,
      instancesState,
      activateInstance,
      createInstance,
      renameInstance: (id, name) => instances.rename(id, name),
      saveModelDefaults,
    })

    // 恢复已有会话时也要判定一次（resume 会触发 agent/created）。
    for (const agent of scoped.agents.list()) {
      try {
        maybeInstall(agent)
      } catch (error) {
        log('warn', `恢复会话安装失败：${error.message}`)
      }
    }

    // Router 每回合只记一次未读：assistant/message 记下“这一回合有可见回复”，
    // turn/end 时若 UI 不在该实例/不可见才 +1。工具中间步骤不会把计数放大。
    const pendingReplyTurns = new Map()
    const assistantText = (message) => {
      if (!message || !Array.isArray(message.content)) return ''
      return message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim()
    }

    // Session 事件在 profile scope 上最可靠；转接给每个 runtime，由 worker
    // session id 过滤。Worker 自己的 agent ctx 监听是补充，不是唯一路径。
    scoped.on('session/event', (session, event) => {
      const sessionId = typeof session?.id === 'string' ? session.id : session?.header?.id
      const owner = typeof sessionId === 'string'
        ? [...records.values()].find((record) => !record.closed && record.agent.id === sessionId && typeof record.instanceId === 'string')
        : undefined
      if (owner !== undefined) {
        const data = event?.data !== null && typeof event?.data === 'object' ? event.data : event
        if (event?.type === 'assistant/message' && assistantText(data?.message).length > 0) {
          pendingReplyTurns.set(sessionId, data?.turn)
        } else if (event?.type === 'turn/end') {
          const replied = pendingReplyTurns.get(sessionId) === data?.turn
          pendingReplyTurns.delete(sessionId)
          // 同一个判定既决定 +1 也决定清零：看着面板时回复即已读，
          // 顺手抹掉之前离开期间留下的计数（不能只“跳过 +1”）。
          const effect = replyEffect({ replied, instanceId: owner.instanceId, activeInstanceId, panelActive, panelSeenAt, visible: uiVisible })
          if (effect === 'count') instances.addUnread(owner.instanceId)
          else if (effect === 'clear') instances.clearUnread(owner.instanceId)
        }
      }
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
function registerHttpRoutes(scoped, records, activeRecord, ensureRouter, resetRouter, listProjects, listWorkspaceSessions, log, host = {}) {
  scoped.inject(['connection'], (scope) => {
    const register = scope.connection?.fetch?.register
    if (typeof register !== 'function') return
    const disposers = []
    /**
     * 同一 path 的 GET/POST 必须合并成一条路由再注册：宿主的路由表按 path
     * 建索引，重复注册同 path 只会保留第一条，后注册的方法会变成 404。
     */
    const pendingRoutes = new Map()

    const addRoute = (route) => {
      let entry = pendingRoutes.get(route.path)
      if (entry === undefined) {
        entry = { handlers: [], methods: new Set() }
        pendingRoutes.set(route.path, entry)
      }
      const methods = (Array.isArray(route.methods) && route.methods.length > 0 ? route.methods : ['GET'])
        .map((method) => String(method).toUpperCase())
      entry.handlers.push({ methods, fetch: route.fetch })
      for (const method of methods) entry.methods.add(method)
    }

    const flushRoutes = () => {
      for (const [path, entry] of pendingRoutes) {
        const route = {
          path,
          methods: [...entry.methods],
          requestBody: 'buffered',
          fetch: async (request) => {
            const method = String(request.method ?? 'GET').toUpperCase()
            const handler = entry.handlers.find((candidate) => candidate.methods.includes(method))
            if (handler === undefined) {
              return new Response('method not allowed', { status: 405, headers: { allow: [...entry.methods].join(', ') } })
            }
            return handler.fetch(request)
          },
        }
        try {
          const dispose = register.call(scope.connection.fetch, route)
          if (typeof dispose === 'function') {
            disposers.push(() => Promise.resolve().then(() => dispose()).catch(() => undefined))
          }
        } catch (error) {
          log('warn', `注册 HTTP 端点 ${route.path} 失败（${error.message}）`)
        }
      }
      pendingRoutes.clear()
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
      instanceId: record.instanceId,
      projectRoot: record.projectRoot,
      dataDir: record.dataDir,
      focusProject: record.runtime.focusProject,
      status: record.runtime.status('compact'),
    })

    const instanceData = () => (typeof host.instancesState === 'function' ? host.instancesState() : {})
    const activate = (id, options) => (typeof host.activateInstance === 'function' ? host.activateInstance(id, options) : instanceData())

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
          ...instanceData(),
        }, 200)
      },
    })

    addRoute({
      path: HTTP_PATHS.uiInstances,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const method = String(request.method ?? 'GET').toUpperCase()
        if (method === 'GET') return jsonResponse({ ok: true, ...instanceData() }, 200)
        const body = await readJson(request)
        if (body === undefined || typeof body.name !== 'string') {
          return jsonResponse({ ok: false, error: 'name is required' }, 400)
        }
        try {
          if (typeof host.createInstance !== 'function') throw new Error('instance creation is unavailable')
          const instance = await host.createInstance(body.name)
          activate(instance.id, { panel: true, read: true })
          return jsonResponse({ ok: true, instance, ...instanceData() }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiInstanceActive,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJson(request)
        if (body === undefined || typeof body.instance_id !== 'string') {
          return jsonResponse({ ok: false, error: 'instance_id is required' }, 400)
        }
        if (body.panel !== undefined && typeof body.panel !== 'boolean') {
          return jsonResponse({ ok: false, error: 'panel must be a boolean' }, 400)
        }
        if (body.visible !== undefined && typeof body.visible !== 'boolean') {
          return jsonResponse({ ok: false, error: 'visible must be a boolean' }, 400)
        }
        try {
          const state = activate(body.instance_id, {
            panel: body.panel,
            visible: body.visible,
            read: body.read === true,
          })
          return jsonResponse({ ok: true, ...state }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiInstanceRename,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJson(request)
        if (body === undefined || typeof body.instance_id !== 'string' || typeof body.name !== 'string') {
          return jsonResponse({ ok: false, error: 'instance_id and name are required' }, 400)
        }
        try {
          if (typeof host.renameInstance !== 'function') throw new Error('instance rename is unavailable')
          const instance = host.renameInstance(body.instance_id, body.name)
          return jsonResponse({ ok: true, instance, ...instanceData() }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
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
        if (body.instance_id !== undefined && typeof body.instance_id !== 'string') {
          return jsonResponse({ ok: false, error: 'instance_id must be a string when provided' }, 400)
        }
        try {
          const input = body.cwd === undefined ? {} : { cwd: body.cwd }
          if (body.instance_id !== undefined && body.cwd === undefined) input.instanceId = body.instance_id
          const result = await ensureRouter(input)
          if (result.instanceId !== undefined) activate(result.instanceId, { panel: true, read: true })
          return jsonResponse({ ok: true, ...result, ...instanceData() }, 200)
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
          if (result.instanceId !== undefined) activate(result.instanceId, { panel: true, read: true })
          return jsonResponse({ ok: true, ...result, ...instanceData() }, 200)
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

    addRoute({
      path: HTTP_PATHS.uiTask,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const url = new URL(request.url)
        const taskId = url.searchParams.get('task_id')
        if (typeof taskId !== 'string' || taskId.length === 0) {
          return jsonResponse({ ok: false, error: 'task_id is required' }, 400)
        }
        try {
          return jsonResponse({ ok: true, task: record.runtime.taskDetail(taskId) }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiTaskSteer,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        const taskId = body.task_id ?? body.id
        // interrupt 默认 true（插队）；mode 只是给脚本/旧调用方的等价别名。
        const interrupt = typeof body.interrupt === 'boolean'
          ? body.interrupt
          : body.mode === 'queue'
            ? false
            : body.mode === 'interrupt'
              ? true
              : undefined
        try {
          const result = await record.runtime.steer(taskId, body.text ?? body.message, { interrupt })
          return jsonResponse({ ok: true, ...result, task: record.runtime.taskDetail(taskId) }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiActivity,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const url = new URL(request.url)
        const limitRaw = Number(url.searchParams.get('limit') ?? 20)
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 20
        const includeClosed = url.searchParams.get('include_closed') !== '0'
        const cursor = url.searchParams.get('cursor') ?? undefined
        const page = record.runtime.activityPage({ limit, cursor, includeClosed })
        return jsonResponse({ ok: true, ...page, limit, includeClosed }, 200)
      },
    })

    addRoute({
      path: HTTP_PATHS.uiModels,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const url = new URL(request.url)
        try {
          const view = await record.runtime.modelView(url.searchParams.get('refresh') === '1')
          return jsonResponse({ ok: true, ...view }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiModels,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        const source = body.models !== null && typeof body.models === 'object' ? body.models : body
        if (!Array.isArray(source.allowed)) {
          return jsonResponse({ ok: false, error: 'allowed must be an array' }, 400)
        }
        const allowed = []
        for (const [index, entry] of source.allowed.entries()) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return jsonResponse({ ok: false, error: `allowed[${index}] must be an object` }, 400)
          }
          if (typeof entry.provider !== 'string' || entry.provider.trim().length === 0
            || typeof entry.model !== 'string' || entry.model.trim().length === 0) {
            return jsonResponse({ ok: false, error: `allowed[${index}] requires provider and model` }, 400)
          }
          const clean = {
            provider: entry.provider.trim(),
            model: entry.model.trim(),
          }
          if (typeof entry.id === 'string' && entry.id.trim().length > 0) clean.id = entry.id.trim()
          if (typeof entry.label === 'string' && entry.label.trim().length > 0) clean.label = entry.label.trim()
          if (Array.isArray(entry.efforts)) {
            clean.efforts = entry.efforts.filter((effort) => typeof effort === 'string' && effort.trim().length > 0).map((effort) => effort.trim())
          }
          if (typeof entry.defaultEffort === 'string' && entry.defaultEffort.trim().length > 0) clean.defaultEffort = entry.defaultEffort.trim()
          if (typeof entry.note === 'string' && entry.note.trim().length > 0) clean.note = entry.note.trim()
          if (entry.enabled === false) clean.enabled = false
          allowed.push(clean)
        }
        const defaultId = typeof source.default === 'string' ? source.default.trim() : (typeof source.defaultId === 'string' ? source.defaultId.trim() : undefined)
        const defaultEffort = typeof source.defaultEffort === 'string' ? source.defaultEffort.trim() : undefined
        // 来源过滤是可选的「只暴露某渠道」配置；UI 的「使用全部 DSH 模型」
        // 会显式传空字符串/空数组把它清掉。省略字段时保持原值。
        let onlyProvider
        if (source.onlyProvider !== undefined) {
          if (typeof source.onlyProvider !== 'string') {
            return jsonResponse({ ok: false, error: 'onlyProvider must be a string when provided' }, 400)
          }
          onlyProvider = source.onlyProvider.trim()
        }
        let onlyNames
        if (source.onlyNames !== undefined) {
          if (!Array.isArray(source.onlyNames)) {
            return jsonResponse({ ok: false, error: 'onlyNames must be an array when provided' }, 400)
          }
          onlyNames = source.onlyNames
            .filter((name) => typeof name === 'string' && name.trim().length > 0)
            .map((name) => name.trim())
        }
        const nextModels = {
          ...(record.runtime.config?.models ?? {}),
          allowed,
          ...(defaultId === undefined ? {} : { default: defaultId }),
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
          ...(onlyProvider === undefined ? {} : { onlyProvider }),
          ...(onlyNames === undefined ? {} : { onlyNames }),
        }
        try {
          host.persistConfigPatch?.(record.configPath, { models: nextModels })
          record.runtime.setModels(nextModels)
          const view = await record.runtime.modelView(true)
          log('info', `Worker 模型 allowlist 已更新：${allowed.length} 项，默认 ${view.defaultId ?? '-'}`)
          return jsonResponse({ ok: true, ...view }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiModelDefaults,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        if (typeof host.saveModelDefaults !== 'function') {
          return jsonResponse({ ok: false, error: 'saving model defaults is unavailable' }, 400)
        }
        const defaults = Array.isArray(body.defaults) ? body.defaults : body.models?.defaults
        try {
          const view = await host.saveModelDefaults(defaults)
          return jsonResponse({ ok: true, ...view }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiAgreements,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        return jsonResponse({
          ok: true,
          agreements: record.runtime.listAgreements(),
          projects: listProjects(),
          path: record.runtime.agreementsPath,
        }, 200)
      },
    })

    addRoute({
      path: HTTP_PATHS.uiAgreements,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        try {
          const action = body.action ?? 'save'
          if (action === 'remove') {
            const result = record.runtime.removeAgreement(body.agreement_id ?? body.id)
            return jsonResponse({ ok: true, ...result, agreements: record.runtime.listAgreements() }, 200)
          }
          if (action === 'toggle') {
            const result = record.runtime.toggleAgreement(body.agreement_id ?? body.id, body.enabled !== false)
            return jsonResponse({ ok: true, ...result, agreements: record.runtime.listAgreements() }, 200)
          }
          const result = record.runtime.saveAgreement({
            id: body.agreement_id ?? body.id,
            title: body.title,
            text: body.text,
            project: body.project,
            mode: body.mode,
            enabled: body.enabled,
          })
          return jsonResponse({ ok: true, ...result, agreements: record.runtime.listAgreements() }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message, code: error.code }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiSchedules,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        try {
          return jsonResponse({ ok: true, ...(await record.runtime.scheduleView(true)) }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiSchedules,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        try {
          const result = await record.runtime.createSchedule(body)
          return jsonResponse({ ok: true, ...result, ...(await record.runtime.scheduleView(true)) }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message, code: error.code }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiSchedulesCancel,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        try {
          if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
          const result = await record.runtime.cancelSchedule(body.schedule_id ?? body.id)
          return jsonResponse({ ok: true, ...result, ...(await record.runtime.scheduleView(true)) }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message, code: error.code }, 400)
        }
      },
    })

    addRoute({
      path: HTTP_PATHS.uiSchedulesRun,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const record = activeRecord()
        if (record === undefined) return jsonResponse({ ok: false, error: 'no active super-agent router' }, 409)
        const body = await readJson(request)
        try {
          if (body === undefined) return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
          const result = await record.runtime.runScheduleNow(body.schedule_id ?? body.id)
          return jsonResponse({ ok: true, ...result, ...(await record.runtime.scheduleView(true)) }, 200)
        } catch (error) {
          return jsonResponse({ ok: false, error: error.message, code: error.code }, 400)
        }
      },
    })

    flushRoutes()

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
