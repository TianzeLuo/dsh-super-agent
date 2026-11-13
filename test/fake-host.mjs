/**
 * fake-host.mjs — 用最小形状模拟 DSH 的 Agent / subagents / 事件总线。
 *
 * 只实现 runtime.js 真正用到的契约：
 *   agent: { id, status, ctx, session.header.cwd, followup(message) }
 *   child: 同上（+ ctx.emit session/event）
 *   subagents: { getProvider(name), startActivation(spec) }
 *
 * 这不是 DSH 的替代品；它让调度、批处理、直通、报告、watchdog 和恢复逻辑
 * 可以在没有模型调用、没有真实 Session 的情况下被确定性地测试。
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, mergeConfig } from '../lib/config.js'
import { SuperAgentRuntime } from '../lib/runtime.js'
import { Store } from '../lib/store.js'

/** 极小事件总线。 */
export function fakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
    },
    get() {
      return undefined
    },
    count(event) {
      return handlers.get(event)?.size ?? 0
    },
  }
}

/** 假 timers：测试自己决定何时跑定时器。 */
export function fakeTimers() {
  let next = 0
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimeout(callback) {
      const id = ++next
      timeouts.set(id, callback)
      return { id, unref() {} }
    },
    clearTimeout(handle) {
      if (handle?.id !== undefined) timeouts.delete(handle.id)
    },
    setInterval(callback) {
      const id = ++next
      intervals.set(id, callback)
      return { id, unref() {} }
    },
    clearInterval(handle) {
      if (handle?.id !== undefined) intervals.delete(handle.id)
    },
    runTimeouts() {
      const pending = [...timeouts.entries()]
      timeouts.clear()
      for (const [, callback] of pending) callback()
      return pending.length
    },
    runIntervals() {
      for (const callback of intervals.values()) callback()
      return intervals.size
    },
    get pendingTimeouts() {
      return timeouts.size
    },
    get activeIntervals() {
      return intervals.size
    },
  }
}

/** 假 Router。 */
export function fakeRouter(cwd, messages = []) {
  const ctx = fakeCtx()
  const router = {
    id: 'session-router',
    status: 'idle',
    ctx,
    session: { header: { id: 'session-router', cwd } },
    messages,
    followup(message) {
      messages.push(message)
      router.status = 'running'
    },
    finish() {
      router.status = 'idle'
      ctx.emit('agent/status', { status: 'idle', agent: router })
    },
    dispose() {
      ctx.emit('agent/disposed', { agent: router })
    },
  }
  return router
}

/** 假 Worker。`options.steer: false` 模拟没有 step 级注入能力的旧宿主。 */
export function fakeChild(id, options = {}) {
  const ctx = fakeCtx()
  const child = {
    id,
    status: 'running',
    ctx,
    session: { id, header: { id, origin: 'subagent', delegationDepth: 1 } },
    messages: [],
    steers: [],
    followups: [],
    followup(message) {
      child.followups.push(message)
      child.messages.push(message)
      child.status = 'running'
    },
    steer(message) {
      child.steers.push(message)
      child.messages.push(message)
      child.status = 'running'
    },
    sessionEvent(event) {
      ctx.emit('session/event', child.session, event)
    },
    finishTurn({ text = 'done', reason = 'completed', turn = 1 } = {}) {
      if (text !== undefined) {
        child.sessionEvent({ type: 'assistant/message', message: { content: [{ type: 'text', text }] } })
      }
      child.status = 'idle'
      child.sessionEvent({ type: 'turn/end', turn, reason: { kind: reason } })
    },
    dispose() {
      child.ctx.emit('agent/disposed', { agent: child })
    },
  }
  if (options.steer === false) delete child.steer
  return child
}

/** 登记一条假 activation，供两种宿主形状共用。 */
function fakeActivation(children, spawns, spec, childId, parentId) {
  const child = fakeChild(childId)
  children.set(child.id, child)
  const result = Promise.withResolvers()
  const activation = {
    childId: child.id,
    messageId: 'msg-1',
    result: result.promise,
    disposed: false,
    parentId,
    async dispose() {
      activation.disposed = true
      children.delete(child.id)
      child.dispose()
      result.resolve({ stopOutput: [], stopReason: 'completed' })
    },
    spec,
  }
  spawns.push(activation)
  return Promise.resolve(activation)
}

/**
 * 假 subagents 服务（DSH 0.2.2 形状）：`startActivation` 在创建 child 之前直接读
 * `spec.parent.id`，任务字段只读顶层。旧 request 形状在这里会抛和宿主一样的
 * `TypeError: Cannot read properties of undefined (reading 'id')`。
 */
export function fakeSubagents(children) {
  const spawns = []
  return {
    spawns,
    getProvider(name) {
      return name === 'spawn' ? { name, capabilities: {} } : undefined
    },
    startActivation(spec) {
      const parentId = spec.parent.id
      if (!Array.isArray(spec.prompt)) throw new TypeError('spec.prompt must be a ContentBlock[]')
      return fakeActivation(children, spawns, spec, spec.childId, parentId)
    },
  }
}

/**
 * 假 subagents 服务（DSH 0.2.1 形状）：只读 `spec.request.*`，顶层任务字段一律忽略。
 * 新宿主里它读不到 parent 会抛同样的 TypeError，所以两种形状都真的有断言。
 */
export function fakeLegacySubagents(children) {
  const spawns = []
  return {
    spawns,
    getProvider(name) {
      return name === 'spawn' ? { name, capabilities: {} } : undefined
    },
    startActivation(spec) {
      const request = spec.request
      const parentId = request.parent.id
      if (!Array.isArray(request.prompt)) throw new TypeError('spec.request.prompt must be a ContentBlock[]')
      return fakeActivation(children, spawns, spec, spec.childId, parentId)
    },
  }
}

/** 假跨项目 Session Worker 服务。 */
export function fakeSessionWorkers(children) {
  const calls = []
  const archives = []
  return {
    calls,
    archives,
    async archive(sessionId) {
      archives.push(sessionId)
    },
    create(spec) {
      const id = spec.sessionId ?? `session-worker-${calls.length + 1}`
      const child = fakeChild(id)
      child.session.header.cwd = spec.cwd
      children.set(id, child)
      const activation = {
        childId: id,
        agent: child,
        started: false,
        disposed: false,
        async start() {
          activation.started = true
          activation.prompt = spec.prompt
        },
        async dispose() {
          activation.disposed = true
          children.delete(id)
          child.dispose()
        },
        spec,
      }
      calls.push(activation)
      return Promise.resolve(activation)
    },
  }
}

/** 假模型目录/选择桥；记录每次为普通 Session 选择模型。 */
export function fakeModels(catalog = { groups: [], failures: [] }, defaultSelection = undefined) {
  const selections = []
  return {
    selections,
    calls: 0,
    async catalog() {
      this.calls += 1
      return catalog
    },
    defaultSelection() {
      return defaultSelection
    },
    async selectSession(sessionId, selection) {
      selections.push({ sessionId, selection })
    },
  }
}

/** 假宿主 schedule 服务；只实现 runtime 用到的 create/list/delete。 */
export function fakeSchedule() {
  const records = new Map()
  let next = 0
  return {
    records,
    async list(sessionId) {
      return [...records.values()].filter((record) => record.sessionId === sessionId)
    },
    async create(sessionId, request) {
      next += 1
      const id = `sched_test_${next}`
      const record = {
        id,
        sessionId,
        title: request.title,
        prompt: request.prompt,
        kind: request.after_seconds !== undefined
          ? 'after'
          : request.every_seconds !== undefined
            ? 'every'
            : request.daily !== undefined
              ? 'daily'
              : request.weekly !== undefined
                ? 'weekly'
                : request.cron !== undefined
                  ? 'cron'
                  : 'at',
        ...(request.after_seconds !== undefined ? { afterSeconds: request.after_seconds } : {}),
        ...(request.every_seconds !== undefined ? { everySeconds: request.every_seconds } : {}),
        ...(request.at !== undefined ? { scheduledAt: new Date(Date.now() + 60_000).toISOString() } : {}),
        ...(request.daily !== undefined ? { time: request.daily.time, timeZone: request.daily.time_zone } : {}),
        ...(request.weekly !== undefined ? { time: request.weekly.time, timeZone: request.weekly.time_zone, weekdays: request.weekly.weekdays } : {}),
        ...(request.cron !== undefined ? { expression: request.cron.expression, timeZone: request.cron.time_zone } : {}),
        ...(request.after_seconds !== undefined ? { scheduledAt: new Date(Date.now() + request.after_seconds * 1000).toISOString() } : {}),
        ...(request.every_seconds !== undefined ? { scheduledAt: new Date(Date.now() + request.every_seconds * 1000).toISOString() } : {}),
        state: 'scheduled',
      }
      records.set(id, record)
      return record
    },
    async cancel(sessionId, id) {
      const record = records.get(id)
      if (record === undefined || record.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      records.delete(id)
      return { id, deleted: true }
    },
    async delete({ sessionId, id }) {
      return this.cancel(sessionId, id)
    },
  }
}

/** 造一个带 .git 与数据目录的项目。 */
export function fakeProject() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-super-agent-runtime-'))
  mkdirSync(join(root, '.git'))
  const dataDir = join(root, '.dsh', 'super-agent')
  mkdirSync(dataDir, { recursive: true })
  return { root, dataDir }
}

/**
 * 组装一个已启动的 runtime。
 *
 * @param {{ config?: object, store?: Store, router?: object, children?: Map }} [options]
 */
export function setupRuntime(options = {}) {
  const project = options.project ?? fakeProject()
  const store = options.store ?? new Store({ dir: project.dataDir })
  if (!store.opened) store.open()
  const children = options.children ?? new Map()
  const router = options.router ?? fakeRouter(project.root)
  const subagents = options.subagents ?? fakeSubagents(children)
  const sessionWorkers = options.sessionWorkers ?? fakeSessionWorkers(children)
  const projects = options.projects ?? (() => [])
  const timers = options.timers ?? fakeTimers()
  const config = mergeConfig(DEFAULTS, options.config ?? {})
  const models = options.models ?? fakeModels()
  const schedule = options.schedule ?? fakeSchedule()
  const now = options.now ?? Date.now
  const runtime = new SuperAgentRuntime({
    agent: router,
    store,
    config,
    projectRoot: project.root,
    dataDir: project.dataDir,
    subagents,
    sessionWorkers,
    attachmentSource: options.attachmentSource,
    projects,
    models,
    schedule,
    agreementsPath: options.agreementsPath ?? join(project.root, '.dsh', 'super-agent.agreements.json'),
    getAgent: (id) => children.get(id),
    resumeWorker: options.resumeWorker,
    logger: { warn: () => undefined, info: () => undefined },
    timers,
    now,
  })
  runtime.start()
  return { ...project, store, children, router, subagents, sessionWorkers, timers, config, runtime, models, schedule }
}

/** 让 microtask 链（startActivation → attachWorker）跑完。 */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}
