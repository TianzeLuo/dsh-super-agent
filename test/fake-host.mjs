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

/** 假 Worker。 */
export function fakeChild(id) {
  const ctx = fakeCtx()
  const child = {
    id,
    status: 'running',
    ctx,
    session: { id, header: { id, origin: 'subagent', delegationDepth: 1 } },
    messages: [],
    followup(message) {
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
  return child
}

/** 假 subagents 服务。 */
export function fakeSubagents(children) {
  const spawns = []
  return {
    spawns,
    getProvider(name) {
      return name === 'spawn' ? { name, capabilities: {} } : undefined
    },
    startActivation(spec) {
      const child = fakeChild(spec.childId)
      children.set(child.id, child)
      const result = Promise.withResolvers()
      const activation = {
        childId: child.id,
        messageId: 'msg-1',
        result: result.promise,
        disposed: false,
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
    },
  }
}

/** 假跨项目 Session Worker 服务。 */
export function fakeSessionWorkers(children) {
  const calls = []
  return {
    calls,
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
  const runtime = new SuperAgentRuntime({
    agent: router,
    store,
    config,
    projectRoot: project.root,
    dataDir: project.dataDir,
    subagents,
    sessionWorkers,
    projects,
    getAgent: (id) => children.get(id),
    logger: { warn: () => undefined, info: () => undefined },
    timers,
  })
  runtime.start()
  return { ...project, store, children, router, subagents, sessionWorkers, timers, config, runtime }
}

/** 让 microtask 链（startActivation → attachWorker）跑完。 */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}
