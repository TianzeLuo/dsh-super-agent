/**
 * index.js — DSH 宿主侧入口。
 *
 * 一个项目里只有**一个** Router：本项目第一个开启插件、且不是 subagent 的根会话
 * 会认领该项目的 dataDir；后开的会话不会重复装工具，也不会重复消费 Trigger。
 * 这对应文章 §2 的“常驻 Router 层”——Router 是一个职责，不是每个会话各来一个。
 *
 * 安装链路：
 *
 *   agent/created
 *     → 跳过 subagent（header.origin / delegationDepth）
 *     → 读 <项目根>/.dsh/super-agent.json（默认关闭）
 *     → 认领 dataDir（owner.json + 进程内 claim）
 *     → 打开 journal，启动 runtime（恢复任务、watchdog、inbox watcher）
 *     → 把六个工具 + Router 提示词注册到这条 agent 的 scope 上
 *     → 若宿主有 connection 服务，注册 /api/super-agent/* 端点
 *
 * 失败绝不连坐：配置坏了、目录不可写、端口已经被别的 DSH 实例占用，都只记一条
 * warn，本次会话不装任何东西；`agent/created` 本身不能因为插件失败而失败。
 *
 * 状态目录里唯一会被覆盖的文件是 `owner.json`（租约）和 `cursor.json`（读取偏移），
 * 都是本进程自己的写入边界；从不删除、不递归移动任何东西。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

import { loadProjectConfig, PLUGIN_ID } from './config.js'
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
     * 尝试安装到一条根会话。
     *
     * @param {object} agent 新建/恢复的 agent。
     */
    const maybeInstall = (agent) => {
      if (records.has(agent)) return
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
        runtime = new SuperAgentRuntime({
          agent,
          store,
          config: gate.config,
          projectRoot: gate.projectRoot,
          dataDir,
          subagents,
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
        disposers: [],
        closed: false,
      }
      records.set(agent, record)
      log('info', `Router 已启动：${agent.id} · ${dataDir}`)

      registerTools(record, agent, runtime, log)
      registerPrompt(record, agent, runtime, gate.config, log)
      registerGuard(record, agent, gate.config, log)
      registerHttp(record, scoped, runtime, log)

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

/** 注册 HTTP 端点；没有 web 载体时静默跳过。 */
function registerHttp(record, scoped, runtime, log) {
  scoped.inject(['connection'], (scope) => {
    if (record.closed) return
    const register = scope.connection?.fetch?.register
    if (typeof register !== 'function') return

    const addRoute = (route) => {
      try {
        const dispose = register.call(scope.connection.fetch, route)
        if (dispose !== undefined) record.disposers.push(() => Promise.resolve().then(() => dispose()).catch(() => undefined))
      } catch (error) {
        log('warn', `注册 HTTP 端点 ${route.path} 失败（${error.message}）`)
      }
    }

    addRoute({
      path: HTTP_PATHS.ingest,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return jsonResponse({ ok: false, error: 'body must be JSON' }, 400)
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return jsonResponse({ ok: false, error: 'body must be a JSON object' }, 400)
        }
        try {
          const result = runtime.ingest({ ...body, externalId: body.externalId ?? body.id })
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
      fetch: async () => jsonResponse({ ok: true, ...runtime.health(), snapshot: runtime.status('compact') }, 200),
    })

    addRoute({
      path: HTTP_PATHS.outbox,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const channel = url.searchParams.get('channel') ?? undefined
        const sinceRaw = url.searchParams.get('since')
        const since = sinceRaw === null ? undefined : Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : Date.parse(sinceRaw)
        const limitRaw = Number(url.searchParams.get('limit') ?? 50)
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50
        return jsonResponse({ ok: true, messages: readOutbox(runtime.store.paths.outbox, { channel, since, limit }) }, 200)
      },
    })
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
