/**
 * runtime.js — Router/Worker 双层架构的运行时。
 *
 * 文章 §2–§6 的控制面都在这里：
 *
 *   - **双层**：Router 是宿主里这条根会话；Worker 是 `ctx.subagents` 起的隔离
 *     子会话。Worker 不直接面对人，结束时由 runtime 生成一条 `worker-report`
 *     Trigger 回到 Router。
 *   - **批处理**（§2.1）：Trigger 先进入 pending；Router 忙时继续积压，等
 *     `agent/status = idle` 后把积压合并成一条消息注入。单次唤醒的 trigger 数
 *     与字符数都有上限，剩下的留在下一批。
 *   - **事件驱动**（§3）：Trigger 有去重键、Thread 归属、订阅直通；已订阅的
 *     Thread 后续事件由程序直接 `followup` 给 Worker，不经过 Router。
 *   - **上下文组织**（§3.3）：批次只内联 id/actor/摘要；全文留在 journal，
 *     `superagent_recall` 沿引用图逐跳展开。
 *   - **异步 ReAct**（§4.1）：dispatch / steer / close 都立即返回，Worker 的
 *     结果以后续 Trigger 的形式到达。
 *   - **持久与自愈**（§5、§6）：状态在 journal；Watchdog 定期检查丢失/卡住的
 *     Worker，自动修复可确定的状态，并只在需要 Router 决策时升级。
 *
 * 运行时故意不依赖任何 `@deepseek-ai/*` 包：本包以 link 方式装进 profile 时，
 * 裸导入解析不到 profile 的 node_modules（见 dsh-academic-search 的说明）。
 * 对宿主只要求一个很小的结构契约：
 *
 *   agent: { id, status, ctx, session.header.cwd, followup(message) }
 *   subagents: { getProvider(name), startActivation(spec) }
 *   sessionWorkers?: { create(spec) -> activation }   # 跨项目普通 Session
 *   projects?: () => Array<{ id, title, path }>        # 宿主项目清单
 *   getAgent(id): Agent | undefined
 *
 * 这些对象由 index.js 从真实 DSH 服务里取；测试用同样的形状做假宿主。
 */

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

import { channelConfig, sourcePolicy } from './config.js'
import { filterEvent } from './filter.js'
import {
  batchId as newBatchId,
  eventId,
  reportId as newReportId,
  replyId as newReplyId,
  taskId as newTaskId,
  taskThreadId,
  threadId as deriveThreadId,
  triggerId as newTriggerId,
  workerSessionId,
} from './ids.js'
import { recall } from './recall.js'
import { inlineTrigger, renderBatch, renderStatus, renderWorkerEvent, renderWorkerTask } from './render.js'
import { clip, formatAge, isRecord, oneLine, redactSecrets, summaryOf, wordCount } from './text.js'

/** 工具/调度层可安全展示给模型的输入错误。 */
export class RuntimeInputError extends Error {
  /**
   * @param {string} message 修正导向的说明。
   * @param {string} [code] 稳定错误码。
   */
  constructor(message, code = 'invalid_input') {
    super(message)
    this.name = 'RuntimeInputError'
    this.code = code
  }
}

/** 线程直通时优先选择当前活动任务，而不是同 Worker 的旧 idle 任务。 */
function taskPriority(task) {
  if (task.status === 'starting') return 0
  if (task.status === 'working') return 1
  if (task.status === 'idle' || task.status === 'blocked') return 2
  return 3
}

/** 生成一条 DSH user 消息；不依赖 dsh-llm 的构造函数。 */
export function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(text) })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** 从 assistant/message 的内容块里取出文本。 */
function assistantText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** TurnEndReason → 任务状态/报告 reason。 */
function normalizeReason(kind) {
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
      return 'max-tokens'
    case 'interrupted':
      return 'interrupted'
    default:
      return typeof kind === 'string' ? kind : 'error'
  }
}

/** 只保留 JSON 安全、体量可控的 meta。 */
function safeMeta(meta) {
  if (!isRecord(meta)) return undefined
  try {
    const text = JSON.stringify(meta)
    if (text.length > 2000) return { truncated: true, preview: text.slice(0, 1800) }
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 读文件的一部分，返回字节；文件不存在/读失败返回 undefined。 */
function readSlice(path, offset, length) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, read)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 读失败已经返回 undefined。
      }
    }
  }
}

/**
 * 单项目运行时。一个 dataDir 在一个宿主进程里只应有一个实例；claim 由 index.js 做。
 */
export class SuperAgentRuntime {
  /**
   * @param {{
   *   agent: object,
   *   store: import('./store.js').Store,
   *   config: object,
   *   projectRoot: string,
   *   dataDir: string,
   *   subagents?: object,
   *   getAgent: (id: string) => object | undefined,
   *   logger?: object,
   *   now?: () => number,
   *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
   * }} options
   */
  constructor(options) {
    this.agent = options.agent
    this.store = options.store
    this.config = options.config
    this.projectRoot = options.projectRoot
    this.dataDir = options.dataDir
    this.subagents = options.subagents
    /**
     * 可选：跨项目 Worker 走普通 Session（header.cwd = 目标项目），因为 DSH
     * subagent 的 header.cwd 固定为父会话，fs sandbox 的 workspace-write 根不会
     * 跟着 request.cwd 走。接口：
     *   create({ cwd, taskId, title, signal }) -> { childId, agent, start(), dispose() }
     */
    this.sessionWorkers = options.sessionWorkers
    /**
     * 可选：宿主 workspace 清单。Router 通过 superagent_projects 自主选择目标，
     * UI 不再要求用户先手选一个“目标项目”。
     */
    this.projectsSource = typeof options.projects === 'function' ? options.projects : () => []
    this.getAgent = options.getAgent ?? (() => undefined)
    this.logger = options.logger ?? {}
    this.now = options.now ?? Date.now
    const timers = options.timers ?? {}
    this.timers = {
      setTimeout: timers.setTimeout ?? setTimeout,
      clearTimeout: timers.clearTimeout ?? clearTimeout,
      setInterval: timers.setInterval ?? setInterval,
      clearInterval: timers.clearInterval ?? clearInterval,
    }

    this.active = false
    this.startedAt = this.now()
    /** @type {Map<string, object>} taskId → activation */
    this.activations = new Map()
    /** @type {Map<string, AbortController>} taskId → controller */
    this.controllers = new Map()
    /** @type {Map<string, { taskId: string, disposers: Function[], lastError?: string }>} childId → state */
    this.children = new Map()
    /** 最近一条 assistant 文本；root 级 session/event 观察也写这里。 */
    this.childText = new Map()
    /** @type {Map<string, number>} issue key → last escalation time */
    this.reportedIssues = new Map()
    this.lastIssues = []
    this.lastCheckAt = undefined
    this.lastError = undefined
    this.flushTimer = undefined
    this.watchdogTimer = undefined
    this.inboxTimer = undefined
    this.inboxOffset = 0
    this.inboxRemainder = Buffer.alloc(0)
    this.pumping = false
    this.routerDisposers = []
    this.batchCount = 0
    this.dispatchCount = 0
    /** 兼容旧版 focus；新 dispatch 应显式给 project。 */
    this.focusProject = undefined
    this.closed = false
  }

  /** 日志。 */
  log(level, message, detail) {
    const fn = this.logger?.[level] ?? this.logger?.info
    try {
      fn?.(`[super-agent] ${message}`, detail)
    } catch {
      // 日志失败不影响调度。
    }
  }

  /**
   * 兼容旧版 UI / 脚本的 focus project。新面板不再调用；正常 dispatch 应显式传
   * `project`。只影响未给 project/cwd 的 dispatch 的兜底 cwd，不改 Router 状态。
   *
   * @param {string | null | undefined} value 绝对目录；空值清除。
   * @returns {{ ok: boolean, focusProject?: string }}
   */
  setFocusProject(value) {
    if (value === undefined || value === null || value === '') {
      this.focusProject = undefined
      return { ok: true }
    }
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new RuntimeInputError('focus project must be an absolute path')
    }
    const resolved = resolve(value)
    let isDirectory = false
    try {
      isDirectory = statSync(resolved).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) throw new RuntimeInputError(`focus project is not a directory: ${resolved}`)
    this.focusProject = resolved
    return { ok: true, focusProject: resolved }
  }

  /** 当前 Router 状态；宿主对象没有 status 时按 idle。 */
  routerStatus() {
    return this.agent?.status === 'running' ? 'running' : 'idle'
  }

  /** 启动：恢复任务、挂监听、开 Watchdog 与 inbox watcher。 */
  start() {
    if (this.active) return this
    this.active = true
    this.startedAt = this.now()
    this.#attachRouter()
    this.#loadCursor()
    this.#recover()
    this.#pump()
    if (this.config?.watchdog?.enabled !== false) this.#startWatchdog()
    this.#startInboxWatcher()
    // 首轮 flush 延后一点，让 agent/created 的其他监听器先完成注册。
    this.scheduleFlush(50)
    return this
  }

  /** 停止：只解绑监听与定时器；不删除状态，也不主动杀 Worker。 */
  stop() {
    this.active = false
    this.closed = true
    if (this.flushTimer !== undefined) this.timers.clearTimeout(this.flushTimer)
    if (this.watchdogTimer !== undefined) this.timers.clearInterval(this.watchdogTimer)
    if (this.inboxTimer !== undefined) this.timers.clearInterval(this.inboxTimer)
    this.flushTimer = undefined
    this.watchdogTimer = undefined
    this.inboxTimer = undefined
    for (const dispose of this.routerDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 关闭阶段不放大错误。
      }
    }
    for (const [childId, state] of this.children) {
      for (const dispose of state.disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 同上。
        }
      }
      this.children.delete(childId)
    }
    this.childText.clear()
  }

  /**
   * Reset 前中止所有 Worker：取消运行中的 turn、释放 activation、解绑监听。
   * 不写 task.closed，也不删除 journal——调用方会切换到一个全新的 dataDir
   * generation，旧 journal 保留为审计记录。
   *
   * @returns {Promise<string[]>} 旧任务里出现过的 Worker Session id。
   */
  async abortWorkers() {
    const workerIds = new Set()
    for (const task of this.store.listTasks()) {
      if (typeof task.workerSessionId === 'string' && task.workerSessionId.length > 0) workerIds.add(task.workerSessionId)
    }
    for (const controller of this.controllers.values()) {
      try {
        controller.abort()
      } catch {
        // abort 失败不影响后续释放。
      }
    }
    const jobs = []
    for (const [childId, activation] of this.activations) {
      workerIds.add(childId)
      try {
        jobs.push(Promise.resolve(activation.dispose?.()).catch(() => undefined))
      } catch {
        // dispose 同步失败时继续释放其它 Worker。
      }
    }
    for (const childId of [...this.children.keys()]) this.#detachWorker(childId)
    for (const childId of [...workerIds]) {
      const child = this.getAgent(childId)
      try {
        child?.cancel?.({ kind: 'parent' })
      } catch {
        // 已释放的 Worker 不需要再取消。
      }
    }
    this.activations.clear()
    this.controllers.clear()
    this.childText.clear()
    await Promise.allSettled(jobs)
    return [...workerIds]
  }

  /**
   * 观察任意 Session 事件；index.js 在 profile scope 上转接 `session/event`。
   *
   * 为什么不在子 Agent 的 ctx 上只听一次：真实宿主里 Session 事件是
   * `Scoped<Session>` 派发的，root 级监听最可靠；child.ctx 监听作为补充。
   * 两条路径都走这里，靠 turn 去重与 `lastReportTurn` 防重复。
   *
   * @param {object} session Session。
   * @param {object} event Session 事件。
   */
  observeSessionEvent(session, event) {
    if (!this.active || this.closed) return
    const childId = typeof session?.id === 'string' ? session.id : session?.header?.id
    if (typeof childId !== 'string') return
    const activeId = this.children.get(childId)?.taskId
    const task = activeId === undefined ? this.store.taskForWorkerSession(childId) : this.store.getTask(activeId)
    if (task === undefined) return
    // DSH 的 Session 事件是 `{ type, seq, time, data }`；测试与部分适配层
    // 可能直接展开 data。两种形状都接受。
    const data = isRecord(event?.data) ? event.data : event
    if (event?.type === 'assistant/message') {
      const text = assistantText(data?.message)
      if (text.length > 0) this.childText.set(childId, text)
      return
    }
    if (event?.type === 'turn/end') {
      this.#handleTurnEnd(task.id, childId, data)
    }
  }

  // ── Router 绑定与批处理 ──────────────────────────────────────────────────

  #attachRouter() {
    const ctx = this.agent?.ctx
    if (ctx && typeof ctx.on === 'function') {
      const offStatus = ctx.on('agent/status', (payload) => {
        if (payload?.status === 'idle' && this.active) this.scheduleFlush(0)
      })
      if (typeof offStatus === 'function') this.routerDisposers.push(offStatus)
      const offDisposed = ctx.on('agent/disposed', () => {
        this.active = false
      })
      if (typeof offDisposed === 'function') this.routerDisposers.push(offDisposed)
    }
  }

  /**
   * 安排一次 flush。Router 忙时只保留 timer 语义：等 idle 事件再 flush。
   *
   * @param {number} [delayMs] 延迟。
   */
  scheduleFlush(delayMs = this.config?.router?.batchDebounceMs ?? 200) {
    if (!this.active || this.closed) return
    if (this.routerStatus() === 'running') return
    if (this.flushTimer !== undefined) this.timers.clearTimeout(this.flushTimer)
    const delay = Math.max(0, Number(delayMs) || 0)
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined
      try {
        this.flushNow()
      } catch (error) {
        this.lastError = error.message
        this.log('warn', `flush 失败：${error.message}`)
      }
    }, delay)
    this.flushTimer?.unref?.()
  }

  /**
   * 立即把 pending Trigger 合并成一批注入 Router。
   *
   * @returns {{ flushed: number, batchId?: string, deferred?: boolean, error?: string }}
   */
  flushNow() {
    if (!this.active || this.closed) return { flushed: 0 }
    if (this.routerStatus() === 'running') return { flushed: 0, deferred: true }
    const pendingBefore = this.store.pendingTriggers(1000)
    if (pendingBefore.length === 0) return { flushed: 0 }

    const batch = newBatchId()
    const rendered = renderBatch({
      triggers: pendingBefore,
      batchId: batch,
      config: this.config,
      pendingAfter: 0,
      now: this.now(),
    })
    if (rendered.triggerIds.length === 0) return { flushed: 0 }

    try {
      this.store.append({
        t: 'batch.created',
        batchId: batch,
        target: 'router',
        triggerIds: rendered.triggerIds,
        renderedChars: rendered.chars,
      })
      for (const triggerId of rendered.triggerIds) {
        this.store.append({
          t: 'trigger.delivered',
          triggerId,
          batchId: batch,
          target: 'router',
        })
      }
      this.agent.followup(userMessage(rendered.text))
      this.batchCount += 1
      return { flushed: rendered.triggerIds.length, batchId: batch }
    } catch (error) {
      this.lastError = error.message
      for (const triggerId of rendered.triggerIds) {
        this.store.append({ t: 'trigger.failed', triggerId, reason: `router delivery failed: ${error.message}` })
      }
      this.log('warn', `注入 Router 失败：${error.message}`)
      return { flushed: 0, error: error.message }
    }
  }

  // ── Trigger intake ───────────────────────────────────────────────────────

  /**
   * 接收一条环境事件。
   *
   * @param {{
   *   source?: string,
   *   threadKey?: string,
   *   externalId?: string,
   *   kind?: string,
   *   actor?: string,
   *   title?: string,
   *   text?: string,
   *   url?: string,
   *   mentions?: string[],
   *   direct?: boolean,
   *   meta?: object,
   *   receivedAt?: number,
   *   internal?: boolean,
   * }} input 事件。
   * @returns {object} `{ ok, id?, threadId?, state?, duplicate?, filtered? }`
   */
  ingest(input) {
    if (!this.active) return { ok: false, error: 'runtime is not active' }
    const source = typeof input?.source === 'string' && input.source.trim().length > 0 ? input.source.trim() : 'unknown'
    const rawText = typeof input?.text === 'string' ? input.text : ''
    const externalId = typeof input?.externalId === 'string' && input.externalId.length > 0 ? input.externalId : undefined
    const dedupeKey = externalId !== undefined ? `${source}\u0000${externalId}` : undefined
    if (dedupeKey !== undefined && this.store.hasDedupe(dedupeKey)) {
      const existing = this.store.dedupeId(dedupeKey)
      return { ok: true, duplicate: true, id: existing, threadId: this.store.getTrigger(existing)?.threadId }
    }

    const policy = sourcePolicy(this.config, source)
    const maxText = Number.isFinite(policy.maxTextChars) ? policy.maxTextChars : 8000
    const redacted = this.config?.redact !== false ? redactSecrets(rawText) : rawText
    const clipped = clip(redacted, maxText)
    const fullChars = Array.from(redacted).length
    const text = this.config?.storeFullText === false ? '' : clipped
    const summary = summaryOf(redacted, 180)
    const id = newTriggerId()
    const receivedAt = Number.isFinite(input?.receivedAt) ? input.receivedAt : this.now()
    const threadKey = typeof input?.threadKey === 'string' && input.threadKey.length > 0 ? input.threadKey : undefined
    const thread = deriveThreadId(source, threadKey, id)
    const decision = filterEvent({
      source,
      actor: input?.actor,
      text: redacted,
      direct: input?.direct === true,
      mentions: Array.isArray(input?.mentions) ? input.mentions : [],
      internal: input?.internal === true,
    }, this.config)

    const trigger = {
      id,
      source,
      threadId: thread,
      threadKey,
      externalId,
      dedupeKey,
      kind: typeof input?.kind === 'string' ? input.kind : undefined,
      actor: typeof input?.actor === 'string' ? input.actor : undefined,
      title: typeof input?.title === 'string' ? clip(oneLine(input.title), 160) : summaryOf(redacted, 120),
      summary,
      text: decision.pass ? text : '',
      url: typeof input?.url === 'string' ? input.url : undefined,
      meta: safeMeta(input?.meta),
      receivedAt,
      addressed: decision.addressed,
      priority: decision.addressed ? 'addressed' : 'ambient',
      mode: decision.mode,
      state: decision.pass ? 'pending' : 'filtered',
      fullChars,
      truncated: clipped.length < redacted.length || (this.config?.storeFullText === false && redacted.length > 0),
    }

    if (!decision.pass) {
      this.store.append({
        t: 'trigger.filtered',
        trigger: { ...trigger, text: '', state: 'filtered' },
        reason: decision.reason,
      })
      return {
        ok: true,
        id,
        threadId: thread,
        state: 'filtered',
        filtered: true,
        reason: decision.reason,
        reasonText: decision.reasonText,
      }
    }

    try {
      this.store.append({ t: 'trigger.received', trigger })
    } catch (error) {
      this.lastError = error.message
      return { ok: false, error: `journal write failed: ${error.message}` }
    }

    const routed = this.#routeToWorkers(trigger)
    if (!routed.delivered) this.scheduleFlush()
    return {
      ok: true,
      id,
      threadId: thread,
      state: routed.delivered ? 'delivered' : 'pending',
      direct: routed.delivered,
      deliveredTo: routed.tasks,
      addressed: decision.addressed,
    }
  }

  /**
   * 已订阅 Thread 的 Fast Path：直接投给所有 live Worker。
   *
   * @param {object} trigger Trigger 记录。
   * @returns {{ delivered: boolean, tasks: string[] }}
   */
  #routeToWorkers(trigger) {
    const tasks = this.store.tasksForThread(trigger.threadId)
    const deliveredTo = []
    // 同一个 Worker 可能服务多个顺序任务；每个 Worker 只投一次，优先当前活动任务。
    const byWorker = new Map()
    for (const task of tasks) {
      if (task.status === 'closed' || task.status === 'lost') continue
      if (typeof task.workerSessionId !== 'string') continue
      const previous = byWorker.get(task.workerSessionId)
      if (previous === undefined || taskPriority(task) < taskPriority(previous)
        || (taskPriority(task) === taskPriority(previous) && (task.updatedAt ?? task.createdAt ?? 0) > (previous.updatedAt ?? previous.createdAt ?? 0))) {
        byWorker.set(task.workerSessionId, task)
      }
    }
    for (const task of byWorker.values()) {
      const child = this.getAgent(task.workerSessionId)
      if (child === undefined) {
        // starting：Worker 还没 materialize，事件先留在 pending，等它启动后
        // 由 Router/下一批处理；不能在这里把正在启动的任务判 lost。
        // idle/blocked/failed：会话被宿主回收，事件回到 Router 即可。
        if (task.status === 'working') this.#markTaskLost(task, 'worker session is not live')
        continue
      }
      const activeOther = this.store.listTasks().find((candidate) => (
        candidate.id !== task.id
        && candidate.workerSessionId === task.workerSessionId
        && (candidate.status === 'starting' || candidate.status === 'working')
      ))
      if (activeOther !== undefined) continue
      try {
        this.#attachWorker(task, child)
        child.followup(userMessage(renderWorkerEvent({ trigger, config: this.config, task, store: this.store })))
        this.store.append({
          t: 'trigger.delivered',
          triggerId: trigger.id,
          target: 'worker',
          taskId: task.id,
        })
        this.#updateTask(task, { status: 'working' })
        deliveredTo.push(task.id)
      } catch (error) {
        this.log('warn', `投递 Worker ${task.id} 失败：${error.message}`)
        this.store.append({
          t: 'trigger.failed',
          triggerId: trigger.id,
          target: 'worker',
          taskId: task.id,
          reason: error.message,
        })
      }
    }
    return { delivered: deliveredTo.length > 0, tasks: deliveredTo }
  }

  // ── 项目与 Worker 生命周期 ────────────────────────────────────────────

  /**
   * 宿主注册的项目清单（去重、保留宿主顺序）。项目是 Router 自主选择的目标，
   * 不是 UI 的必填项；拿不到 workspace 服务时返回空数组。
   *
   * @returns {{id: string, title: string, path: string}[]}
   */
  listProjects() {
    let rows
    try {
      rows = this.projectsSource()
    } catch (error) {
      this.log('warn', `读取项目清单失败：${error.message}`)
      return []
    }
    const seen = new Set()
    const projects = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = typeof row?.path === 'string' ? resolve(row.path) : ''
      if (path.length === 0 || seen.has(path)) continue
      seen.add(path)
      projects.push({
        id: typeof row?.id === 'string' && row.id.length > 0 ? row.id : path,
        title: typeof row?.title === 'string' && row.title.length > 0 ? row.title : path,
        path,
      })
    }
    return projects
  }

  /** 把一个项目标题/id/路径解析成唯一项目，歧义时给出候选路径。 */
  #resolveProject(reference) {
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      throw new RuntimeInputError('project must be a non-empty project title, id, or absolute path', 'missing_field')
    }
    const query = reference.trim()
    const projects = this.listProjects()
    if (projects.length === 0) {
      throw new RuntimeInputError('no projects are registered with the host; pass an absolute cwd only if the user explicitly gave one', 'no_projects')
    }
    const exact = projects.filter((project) => project.id === query || project.title === query || project.path === query)
    const wanted = query.toLowerCase()
    const matches = exact.length > 0 ? exact : projects.filter((project) => (
      project.title.toLowerCase() === wanted
      || project.id.toLowerCase() === wanted
      || project.path.toLowerCase() === wanted
      || project.path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === wanted
    ))
    if (matches.length === 1) return matches[0]
    const known = projects.map((project) => `${project.title} (${project.path})`).join('; ')
    if (matches.length === 0) {
      throw new RuntimeInputError(`no project matched "${query}". Known projects: ${known}`, 'not_found')
    }
    throw new RuntimeInputError(
      `project "${query}" is ambiguous: ${matches.map((project) => project.path).join(', ')}. Use the absolute path.`,
      'ambiguous',
    )
  }

  /**
   * 创建一个 Worker 任务。立即返回；worker 启动、失败、报告都在后台。
   *
   * `reuseTaskId` 让新任务复用该任务的 Worker Session：共享上下文，适合同一项目
   * 的连续工作。只允许在源任务已结束且 Worker 正空闲时复用，避免覆盖正在执行的
   * turn。
   *
   * @param {{ title: string, brief: string, threadIds?: string[], project?: string, cwd?: string, speculative?: boolean, reuseTaskId?: string }} input
   * @returns {object}
   */
  dispatch(input) {
    if (!this.active) throw new RuntimeInputError('runtime is not active')
    const title = requireText(input?.title, 'title', 160)
    const brief = requireText(input?.brief, 'brief', 20_000)
    const threadIds = normalizeThreadIds(input?.threadIds)
    const reuseTaskId = typeof input?.reuseTaskId === 'string' && input.reuseTaskId.length > 0
      ? input.reuseTaskId
      : undefined
    let source
    let project
    let cwd
    if (reuseTaskId !== undefined) {
      source = this.#requireTask(reuseTaskId)
      if (!['idle', 'blocked'].includes(source.status)) {
        throw new RuntimeInputError(`task ${source.id} cannot be reused while it is ${source.status}; wait for it to finish or dispatch a new worker`, 'busy')
      }
      if (typeof source.workerSessionId !== 'string' || source.workerSessionId.length === 0) {
        throw new RuntimeInputError(`task ${source.id} has no Worker session to reuse`, 'not_found')
      }
      if (this.getAgent(source.workerSessionId) === undefined) {
        throw new RuntimeInputError(`the Worker for task ${source.id} is no longer live; dispatch a new worker`, 'not_found')
      }
      const busy = this.store.listTasks().find((task) => (
        task.id !== source.id
        && task.workerSessionId === source.workerSessionId
        && (task.status === 'starting' || task.status === 'working')
      ))
      if (busy !== undefined) {
        throw new RuntimeInputError(`the Worker for task ${source.id} is busy with task ${busy.id} (${busy.title})`, 'busy')
      }
      cwd = source.cwd
      project = source.project === undefined
        ? undefined
        : { title: source.project, id: source.projectId, path: source.cwd }
      if (typeof input?.project === 'string' && input.project.trim().length > 0) {
        const requested = this.#resolveProject(input.project)
        if (requested.path !== cwd) {
          throw new RuntimeInputError(`reused worker runs in ${cwd}, not ${requested.path}; use a new worker for a different project`, 'invalid')
        }
        project = requested
      }
      if (typeof input?.cwd === 'string' && input.cwd.length > 0) {
        const requestedCwd = this.#resolveCwd(input.cwd)
        if (requestedCwd !== cwd) {
          throw new RuntimeInputError(`reused worker runs in ${cwd}, not ${requestedCwd}`, 'invalid')
        }
      }
    } else {
      project = typeof input?.project === 'string' && input.project.trim().length > 0
        ? this.#resolveProject(input.project)
        : undefined
      cwd = project === undefined ? this.#resolveCwd(input?.cwd) : project.path
    }
    const id = newTaskId()
    const now = this.now()
    const task = {
      id,
      title,
      brief,
      cwd,
      project: project?.title,
      projectId: project?.id,
      status: 'queued',
      speculative: input?.speculative === true,
      threadIds: [],
      workerSessionId: source?.workerSessionId,
      continuedFrom: source?.id,
      createdAt: now,
      updatedAt: now,
      createdBy: this.agent?.id,
    }
    this.store.append({ t: 'task.created', task })
    for (const thread of threadIds) {
      this.store.append({ t: 'task.subscribed', taskId: id, threadId: thread, source: 'unknown' })
    }
    this.dispatchCount += 1
    this.#pump()
    const current = this.store.getTask(id)
    return {
      ok: true,
      status: current?.status ?? 'queued',
      taskId: id,
      threadIds,
      cwd,
      project: project?.title,
      workerSessionId: source?.workerSessionId,
      continuedFrom: source?.id,
      note: source === undefined
        ? 'Worker starts in the background. Its report will arrive as a new trigger; do not wait for it.'
        : 'Continues in the same Worker session with its prior context. Its report will arrive as a new trigger; do not wait for it.',
    }
  }

  /**
   * 向 Worker 发一条消息。立即返回 accepted。
   *
   * @param {string} taskId 任务 id。
   * @param {string} message 消息。
   * @returns {object}
   */
  steer(taskId, message) {
    const task = this.#requireTask(taskId)
    if (task.status === 'closed') throw new RuntimeInputError(`task ${task.id} is closed`)
    const text = requireText(message, 'message', 20_000)
    const child = typeof task.workerSessionId === 'string' ? this.getAgent(task.workerSessionId) : undefined
    if (child === undefined) throw new RuntimeInputError(`task ${task.id} has no live worker (status ${task.status})`)
    const busy = this.store.listTasks().find((candidate) => (
      candidate.id !== task.id
      && candidate.workerSessionId === task.workerSessionId
      && (candidate.status === 'starting' || candidate.status === 'working')
    ))
    if (busy !== undefined) throw new RuntimeInputError(`the shared Worker is busy with task ${busy.id} (${busy.title})`, 'busy')
    this.#attachWorker(task, child)
    child.followup(userMessage(text))
    this.store.append({ t: 'task.steered', taskId: task.id })
    this.#updateTask(task, { status: 'working' })
    return { ok: true, status: 'accepted', taskId: task.id, note: 'Delivered to the worker; its report will arrive as a trigger.' }
  }

  /**
   * 关闭任务，或只退掉一个 Thread 订阅。
   *
   * @param {{ taskId: string, threadId?: string, reason?: string }} input
   * @returns {object}
   */
  close(input) {
    const task = this.#requireTask(input?.taskId)
    if (typeof input?.threadId === 'string' && input.threadId.length > 0) {
      if (!task.threadIds.includes(input.threadId)) {
        throw new RuntimeInputError(`task ${task.id} is not subscribed to thread ${input.threadId}`)
      }
      this.store.append({ t: 'task.unsubscribed', taskId: task.id, threadId: input.threadId })
      return { ok: true, status: 'unsubscribed', taskId: task.id, threadId: input.threadId, remaining: task.threadIds }
    }
    if (task.status === 'closed') return { ok: true, status: 'closed', taskId: task.id, alreadyClosed: true }
    const reason = typeof input?.reason === 'string' ? clip(input.reason, 500) : 'closed by router'
    this.store.append({ t: 'task.closed', taskId: task.id, reason })
    const shared = typeof task.workerSessionId === 'string' && this.store.listTasks().some((candidate) => (
      candidate.id !== task.id
      && candidate.workerSessionId === task.workerSessionId
      && candidate.status !== 'closed'
    ))
    if (shared) {
      // 同一个 Worker 的历史/续接任务仍然存在；关闭其中一个不能把 Worker 掐掉。
      this.#pump()
      return { ok: true, status: 'closed', taskId: task.id, workerRetained: true, note: 'Task closed; the shared Worker remains for its other task(s).' }
    }
    this.#detachWorker(task.workerSessionId ?? task.id)
    const activationEntry = this.#activationForWorker(task.workerSessionId)
    if (activationEntry !== undefined) this.activations.delete(activationEntry.key)
    const controllerEntry = this.#controllerForWorker(task.workerSessionId)
    if (controllerEntry !== undefined) this.controllers.delete(controllerEntry.key)
    controllerEntry?.controller?.abort?.()
    if (activationEntry !== undefined) {
      Promise.resolve()
        .then(() => activationEntry.activation.dispose())
        .then(() => activationEntry.activation.archive?.())
        .catch((error) => this.log('warn', `释放 Worker ${task.id} 失败：${error.message}`))
    } else if (typeof task.workerSessionId === 'string') {
      // 重启后认领的 Worker 没有原 activation 句柄；至少中止它当前的 turn。
      const child = this.getAgent(task.workerSessionId)
      try {
        child?.cancel?.({ kind: 'parent' })
      } catch {
        // 取消失败不影响任务已关闭的事实。
      }
      Promise.resolve()
        .then(() => this.sessionWorkers?.archive?.(task.workerSessionId))
        .catch((error) => this.log('warn', `归档 Worker ${task.id} 失败：${error.message}`))
    }
    this.#pump()
    return { ok: true, status: 'closing', taskId: task.id, note: 'Worker is being released in the background.' }
  }

  /** 找到某个 Worker 对应的 activation；复用任务没有自己的 activation。 */
  #activationForWorker(workerSessionId) {
    if (typeof workerSessionId !== 'string') return undefined
    for (const [key, activation] of this.activations) {
      if (activation?.childId === workerSessionId) return { key, activation }
    }
    return undefined
  }

  /** 找到某个 Worker 对应的 controller；复用任务没有自己的 controller。 */
  #controllerForWorker(workerSessionId) {
    if (typeof workerSessionId !== 'string') return undefined
    for (const [key, controller] of this.controllers) {
      const owner = this.store.getTask(key)
      if (owner?.workerSessionId === workerSessionId) return { key, controller }
    }
    return undefined
  }

  /** 确保容量允许后，按创建顺序启动 queued 任务。 */
  #pump() {
    if (this.pumping || !this.active) return
    this.pumping = true
    try {
      for (;;) {
        if (this.#liveWorkerCount() >= (this.config?.worker?.maxWorkers ?? 4)) break
        const next = this.store.listTasks().find((task) => task.status === 'queued')
        if (next === undefined) break
        if (typeof next.continuedFrom === 'string') void this.#startReuseTask(next)
        else void this.#spawnTask(next)
      }
    } finally {
      this.pumping = false
    }
  }

  #liveWorkerCount() {
    let count = 0
    for (const task of this.store.listTasks()) {
      // idle 的 Worker 可能仍驻留（供 steer / Thread 直通），但不占“正在执行”
      // 的槽位；否则 Router 不 close 时，后续任务会永远排队。
      if (task.status === 'starting') count += 1
      else if (task.status === 'working' && typeof task.workerSessionId === 'string') count += 1
    }
    return count
  }

  /** 目标目录是否在 Router 的 sandbox workspace 之外。 */
  #outsideProject(cwd) {
    const rel = relative(this.projectRoot, cwd)
    return rel !== '' && (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
  }

  async #spawnTask(task) {
    const provider = this.config?.worker?.spawnProvider ?? 'spawn'
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const sessionId = workerSessionId()
    this.store.append({
      t: 'task.updated',
      taskId: task.id,
      patch: { status: 'starting', workerSessionId: sessionId, startedAt: this.now() },
    })
    try {
      const prompt = renderWorkerTask({
        task: { ...task, workerSessionId: sessionId },
        config: this.config,
        store: this.store,
        projectRoot: this.projectRoot,
      })
      let activation
      if (this.sessionWorkers?.create !== undefined && this.#outsideProject(task.cwd)) {
        // 跨项目：普通 Session 的 header.cwd 是目标项目，sandbox workspace-write
        // 才会真正覆盖目标目录。先只建会话，等任务写入 workerSessionId 后再发 prompt。
        activation = await this.sessionWorkers.create({
          cwd: task.cwd,
          taskId: task.id,
          title: task.title,
          prompt,
          signal: controller.signal,
        })
      } else {
        if (this.subagents === undefined || typeof this.subagents.startActivation !== 'function') {
          throw new Error('ctx.subagents is unavailable in this deployment')
        }
        if (typeof this.subagents.getProvider === 'function' && this.subagents.getProvider(provider) === undefined) {
          throw new Error(`subagent provider "${provider}" is not registered`)
        }
        activation = await this.subagents.startActivation({
          provider,
          label: task.title,
          childId: sessionId,
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: this.agent,
            cwd: task.cwd,
          },
          signal: controller.signal,
          delivery: 'caller',
        })
      }
      const current = this.store.getTask(task.id)
      if (current === undefined || current.status !== 'starting') {
        // 启动期间可能被 close/watchdog 改成了 closed/lost/failed；
        // 迟到的 activation 不能再把任务复活。
        await activation.dispose().catch(() => undefined)
        return
      }
      this.activations.set(task.id, activation)
      this.store.append({
        t: 'task.updated',
        taskId: task.id,
        patch: { status: 'working', workerSessionId: activation.childId, startedAt: this.now() },
      })
      const child = this.getAgent(activation.childId) ?? activation.agent
      if (child !== undefined) this.#attachWorker(task, child)
      if (typeof activation.start === 'function') await activation.start()
      Promise.resolve(activation.result).catch((error) => {
        this.log('warn', `Worker ${task.id} activation 结束异常：${error.message}`)
        const latest = this.store.getTask(task.id)
        if (latest !== undefined && !['closed', 'failed', 'lost', 'interrupted'].includes(latest.status)) {
          this.#report(task, 'error', `worker activation failed: ${error.message}`, undefined, true)
        }
        this.#pump()
      })
    } catch (error) {
      this.lastError = error.message
      this.controllers.delete(task.id)
      this.log('warn', `启动 Worker ${task.id} 失败：${error.message}`)
      const current = this.store.getTask(task.id)
      if (current !== undefined && current.status === 'starting') {
        this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'failed' } })
        this.#report(task, 'error', `failed to start worker: ${error.message}`, undefined, false)
      }
      this.#pump()
    }
  }

  /**
   * 在已有 Worker Session 上启动一个续接任务，不创建新会话。
   * 上下文由 Session 自身保留；这里只负责 prompt、状态和报告监听。
   */
  async #startReuseTask(task) {
    this.store.append({
      t: 'task.updated',
      taskId: task.id,
      patch: { status: 'starting', startedAt: this.now() },
    })
    try {
      const child = typeof task.workerSessionId === 'string' ? this.getAgent(task.workerSessionId) : undefined
      if (child === undefined) throw new Error('the reused Worker session is no longer live')
      const busy = this.store.listTasks().find((candidate) => (
        candidate.id !== task.id
        && candidate.workerSessionId === task.workerSessionId
        && (candidate.status === 'starting' || candidate.status === 'working')
      ))
      if (busy !== undefined) throw new Error(`the Worker is already running task ${busy.id}`)
      const prompt = renderWorkerTask({
        task,
        config: this.config,
        store: this.store,
        projectRoot: this.projectRoot,
      })
      this.#attachWorker(task, child)
      const current = this.store.getTask(task.id)
      if (current === undefined || current.status !== 'starting') return
      child.followup(userMessage(prompt))
      this.store.append({
        t: 'task.updated',
        taskId: task.id,
        patch: { status: 'working', startedAt: this.now() },
      })
      this.#pump()
    } catch (error) {
      this.lastError = error.message
      this.log('warn', `启动续接任务 ${task.id} 失败：${error.message}`)
      const current = this.store.getTask(task.id)
      if (current !== undefined && current.status === 'starting') {
        this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'failed' } })
        this.#report(task, 'error', `failed to continue in the reused Worker: ${error.message}`, undefined, false)
      }
      this.#pump()
    }
  }

  #attachWorker(task, child) {
    const existing = this.children.get(child.id)
    if (existing !== undefined) {
      const current = this.store.getTask(existing.taskId)
      // 同一个 Worker 可能被多个顺序任务复用。不要用旧的 idle 任务覆盖
      // 正在 starting/working 的新任务；反过来则把活动任务切到新任务上。
      if (current !== undefined && ['starting', 'working'].includes(current.status)
        && !['starting', 'working'].includes(task.status)) return
      existing.taskId = task.id
      existing.lastError = undefined
      this.childText.delete(child.id)
      return
    }
    const state = { taskId: task.id, disposers: [], lastError: undefined }
    this.children.set(child.id, state)
    const ctx = child.ctx
    if (ctx && typeof ctx.on === 'function') {
      const offSession = ctx.on('session/event', (session, event) => {
        this.observeSessionEvent(session ?? child.session, event)
      })
      if (typeof offSession === 'function') state.disposers.push(offSession)
      const offError = ctx.on('agent/error', (payload) => {
        state.lastError = payload?.error?.message ?? String(payload?.error ?? 'unknown error')
      })
      if (typeof offError === 'function') state.disposers.push(offError)
      const offDisposed = ctx.on('agent/disposed', () => {
        this.#detachWorker(child.id)
        const current = this.store.getTask(state.taskId)
        if (current !== undefined && current.status !== 'closed' && current.status !== 'lost') {
          this.#markTaskLost(current, 'worker session was disposed')
        }
      })
      if (typeof offDisposed === 'function') state.disposers.push(offDisposed)
    }
  }

  #detachWorker(childId) {
    const state = this.children.get(childId)
    if (state === undefined) return
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 解绑失败不影响后续状态。
      }
    }
    this.children.delete(childId)
  }

  #handleTurnEnd(taskId, childId, event) {
    const task = this.store.getTask(taskId)
    if (task === undefined || task.status === 'closed') return
    const state = this.children.get(childId)
    const turn = typeof event?.turn === 'number' ? event.turn : undefined
    if (turn !== undefined && task.lastReportTurn === turn) return
    const reason = normalizeReason(event?.reason?.kind)
    const lastText = this.childText.get(childId) ?? ''
    const text = lastText.trim().length > 0
      ? lastText
      : `(worker ended without a text report; last error: ${state?.lastError ?? 'none'})`
    this.childText.delete(childId)
    this.#report(task, reason, text, turn, false)
  }

  /**
   * 写一条任务报告，并把摘要作为新 Trigger 送回 Router。
   *
   * @param {object} task 任务。
   * @param {string} reason 结束/报告原因。
   * @param {string} text 报告正文。
   * @param {number | undefined} turn turn 号。
   * @param {boolean} synthesized 是否由 runtime/watchdog 合成。
   */
  #report(task, reason, text, turn, synthesized) {
    const current = this.store.getTask(task.id)
    if (current === undefined || current.status === 'closed') return
    const reportId = newReportId()
    const clippedText = clip(this.config?.redact !== false ? redactSecrets(text) : text, this.config?.worker?.maxReportChars ?? 4000)
    this.store.append({
      t: 'task.reported',
      taskId: task.id,
      report: {
        id: reportId,
        reason,
        text: clippedText,
        turn,
        synthesized: synthesized === true,
      },
    })
    const trigger = {
      id: newTriggerId(),
      source: 'worker',
      threadId: taskThreadId(task.id),
      threadKey: `task:${task.id}`,
      externalId: reportId,
      dedupeKey: `worker\u0000${reportId}`,
      kind: 'worker-report',
      actor: current.workerSessionId ?? 'worker',
      title: task.speculative ? `Speculative report: ${task.title}` : `Report: ${task.title}`,
      summary: summaryOf(`${task.speculative ? '[speculative] ' : ''}${reason}: ${clippedText}`, 180),
      text: [
        `Task ${task.id} "${task.title}"${task.speculative ? ' (speculative run)' : ''} reported ${reason}${turn === undefined ? '' : ` at turn ${turn}`}.`,
        '',
        clippedText,
        '',
        'Decide whether to tell a person, continue the task, or close it. Use superagent_recall for the task brief and thread links.',
      ].join('\n'),
      receivedAt: this.now(),
      addressed: true,
      priority: 'addressed',
      mode: 'candidate',
      fullChars: text.length,
      truncated: clippedText.length < text.length,
    }
    this.store.append({ t: 'trigger.received', trigger })
    this.scheduleFlush(0)
    // 完成后空出执行槽位，让 queued 任务继续启动；idle Worker 仍可保留
    // 供 steer / Thread 直通，但不再阻塞新任务。
    this.#pump()
  }

  /** 把任务标记为 lost，并让 Router 知道。只做一次。 */
  #markTaskLost(task, reason) {
    const current = this.store.getTask(task.id)
    if (current === undefined || current.status === 'closed' || current.status === 'lost') return
    this.controllers.get(task.id)?.abort?.()
    this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'lost', lostReason: reason } })
    this.#report(current, 'lost', `Worker session is gone: ${reason}. Decide whether to retry the task or close it.`, undefined, true)
    this.#pump()
  }

  #updateTask(task, patch) {
    this.store.append({ t: 'task.updated', taskId: task.id, patch })
  }

  #requireTask(taskId) {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new RuntimeInputError('task_id is required')
    const task = this.store.getTask(taskId)
    if (task === undefined) throw new RuntimeInputError(`task not found: ${taskId}`, 'not_found')
    return task
  }

  #resolveCwd(value) {
    const fallback = this.focusProject || this.config?.worker?.defaultCwd || this.projectRoot
    const candidate = typeof value === 'string' && value.length > 0 ? value : fallback
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(this.projectRoot, candidate)
    if (!existsSync(resolved)) {
      this.log('warn', `worker cwd 不存在，回退到项目根：${resolved}`)
      return this.projectRoot
    }
    return resolved
  }

  // ── 面向人的信道 ────────────────────────────────────────────────────────

  /**
   * 排队一条面向人的消息。IM 等信道有硬性字数上限。
   *
   * @param {{ channel: string, text: string, threadId?: string, taskId?: string }} input
   * @returns {object}
   */
  reply(input) {
    if (!this.active) throw new RuntimeInputError('runtime is not active')
    const channel = requireText(input?.channel, 'channel', 80)
    const text = requireText(input?.text, 'text', 20_000)
    const style = channelConfig(this.config, channel)
    const words = wordCount(text)
    if (style.maxWords > 0 && words > style.maxWords) {
      throw new RuntimeInputError(
        `reply is ${words} words; channel "${channel}" allows ${style.maxWords}. Shorten it. Guidance: ${style.guidance}`,
        'too_long',
      )
    }
    const redacted = this.config?.redact !== false ? redactSecrets(text) : text
    const reply = {
      id: newReplyId(),
      channel,
      text: redacted,
      threadId: typeof input?.threadId === 'string' ? input.threadId : undefined,
      taskId: typeof input?.taskId === 'string' ? input.taskId : undefined,
      words,
      createdAt: this.now(),
      status: 'queued',
    }
    this.store.append({ t: 'reply.queued', reply })
    let outboxError
    try {
      mkdirSync(this.dataDir, { recursive: true })
      appendFileSync(this.store.paths.outbox, `${JSON.stringify(reply)}\n`)
    } catch (error) {
      outboxError = error.message
      this.log('warn', `写 outbox 失败（journal 仍有记录）：${error.message}`)
    }
    return {
      ok: true,
      status: 'queued',
      replyId: reply.id,
      channel,
      words,
      maxWords: style.maxWords,
      outbox: this.store.paths.outbox,
      outboxError,
      note: 'A channel bridge reads outbox.jsonl; this plugin does not post to external services itself.',
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /**
   * 状态快照。
   *
   * @param {'compact'|'full'} [detail]
   * @returns {object}
   */
  status(detail = 'compact') {
    const stats = this.store.stats()
    const tasks = this.store.listTasks().map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      threadIds: [...task.threadIds],
      workerSessionId: task.workerSessionId,
      cwd: task.cwd,
      project: task.project,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      continuedFrom: task.continuedFrom,
      speculative: task.speculative === true,
      age: formatAge(this.now() - (task.updatedAt ?? this.now())),
      lastReport: task.lastReport === undefined ? undefined : { reason: task.lastReport.reason, at: task.lastReport.at },
    }))
    const threads = this.store.listThreads({ limit: detail === 'full' ? 100 : 12 }).map((thread) => ({
      id: thread.id,
      source: thread.source,
      title: thread.title,
      triggerCount: thread.triggerIds.length,
      taskIds: [...thread.taskIds],
      updatedAt: thread.updatedAt,
      age: formatAge(this.now() - (thread.updatedAt ?? this.now())),
    }))
    const pending = this.store.pendingTriggers(detail === 'full' ? 50 : 12).map((trigger) => ({
      id: trigger.id,
      source: trigger.source,
      threadId: trigger.threadId,
      priority: trigger.addressed ? 'addressed' : 'ambient',
      age: formatAge(this.now() - (trigger.receivedAt ?? this.now())),
      summary: trigger.summary,
    }))
    const snapshot = {
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      focusProject: this.focusProject,
      router: {
        sessionId: this.agent?.id,
        status: this.routerStatus(),
        pendingTriggers: stats.pending,
        batches: stats.batches,
        uptime: formatAge(this.now() - this.startedAt),
      },
      counts: stats,
      tasks,
      threads,
      pending,
      outbox: {
        total: stats.replies,
        byChannel: stats.repliesByChannel,
        path: this.store.paths.outbox,
        latest: this.store.queuedReplies(1)[0]?.id,
      },
      watchdog: {
        lastCheckAt: this.lastCheckAt,
        issues: this.lastIssues,
        reported: this.reportedIssues.size,
        enabled: this.config?.watchdog?.enabled !== false,
      },
      health: {
        activeWorkers: this.children.size,
        maxWorkers: this.config?.worker?.maxWorkers ?? 4,
        dispatches: this.dispatchCount,
        journalBadLines: stats.journalBadLines,
        lastError: this.lastError,
      },
    }
    if (detail === 'full') snapshot.pending = pending
    return snapshot
  }

  /** 人类可读状态文本。 */
  statusText(detail = 'compact') {
    return renderStatus(this.status(detail), detail)
  }

  /** 链式召回；直接委托给 recall.js。 */
  recall(id, options = {}) {
    return recall(this.store, id, { now: this.now(), ...options })
  }

  /** 强制跑一次 Watchdog（工具/测试用）。 */
  checkNow() {
    return this.#checkWatchdog()
  }

  // ── Watchdog ─────────────────────────────────────────────────────────────

  #startWatchdog() {
    const interval = this.config?.watchdog?.intervalMs ?? 30_000
    this.watchdogTimer = this.timers.setInterval(() => {
      try {
        this.#checkWatchdog()
      } catch (error) {
        this.lastError = error.message
        this.log('warn', `watchdog 检查失败：${error.message}`)
      }
    }, interval)
    this.watchdogTimer?.unref?.()
  }

  /**
   * 外部 Control Loop。它只做两类事：
   *   1. 修复确定性的状态（丢失的 worker、卡住的 starting、可 flush 的积压）；
   *   2. 把需要模型判断的问题合成一条 watchdog Trigger，交给 Router。
   *
   * 没有问题时完全安静；同一个问题在 repeatMs 内不重复升级。
   */
  #checkWatchdog() {
    if (!this.active) return { issues: [], repairs: [] }
    const now = this.now()
    this.lastCheckAt = now
    const issues = []
    const repairs = []

    for (const task of this.store.listTasks()) {
      if (task.status === 'closed') continue
      const age = now - (task.startedAt ?? task.createdAt ?? now)
      if (task.status === 'starting' && age > (this.config?.watchdog?.startTimeoutMs ?? 120_000)) {
        issues.push({
          key: `task-start:${task.id}`,
          text: `task ${task.id} "${task.title}" has been ${task.status} for ${formatAge(age)}`,
          taskId: task.id,
        })
        this.controllers.get(task.id)?.abort?.()
        this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'failed' } })
        this.#report(task, 'error', `worker did not start within ${formatAge(age)}; task marked failed. Decide whether to retry or close.`, undefined, true)
        repairs.push(`task ${task.id} marked failed`)
        continue
      }
      if (typeof task.workerSessionId === 'string' && this.getAgent(task.workerSessionId) === undefined) {
        // 只有“本应在跑”的任务才算 lost。idle/blocked/failed 已经交过报告，
        // 会话被宿主回收不等于任务丢失；等后续 Thread 事件或 Router 决定。
        if (task.status === 'starting' || task.status === 'working') {
          issues.push({
            key: `task-lost:${task.id}`,
            text: `task ${task.id} "${task.title}" has no live worker session`,
            taskId: task.id,
          })
          this.#markTaskLost(task, 'watchdog could not find the worker session')
          repairs.push(`task ${task.id} marked lost`)
        }
        continue
      }
      const child = typeof task.workerSessionId === 'string' ? this.getAgent(task.workerSessionId) : undefined
      if (child !== undefined && task.status === 'working' && child.status === 'idle') {
        const since = now - (task.updatedAt ?? now)
        if (since > (this.config?.watchdog?.idleStaleMs ?? 300_000)) {
          issues.push({
            key: `task-idle:${task.id}`,
            text: `task ${task.id} is working but its worker has been idle for ${formatAge(since)} with no report`,
            taskId: task.id,
          })
          this.#report(task, 'completed', 'Worker is idle and no turn report was captured. It may have finished; inspect the worker session before closing.', undefined, true)
          repairs.push(`task ${task.id} synthesized a report`)
        }
      }
    }

    const pending = this.store.pendingTriggers(1000)
    if (pending.length > 0 && this.routerStatus() === 'idle') {
      const oldest = pending[0]
      const age = now - (oldest.receivedAt ?? now)
      if (age > (this.config?.watchdog?.pendingStaleMs ?? 90_000)) {
        issues.push({
          key: 'pending-backlog',
          text: `${pending.length} trigger(s) pending; oldest ${oldest.id} is ${formatAge(age)} old while the router is idle`,
        })
        this.flushNow()
        repairs.push('flushed pending triggers')
      }
    }

    if (this.store.listTasks().some((task) => task.status === 'queued')) this.#pump()

    const fresh = []
    const repeatMs = this.config?.watchdog?.repeatMs ?? 600_000
    for (const issue of issues) {
      const last = this.reportedIssues.get(issue.key)
      if (last !== undefined && now - last < repeatMs) continue
      this.reportedIssues.set(issue.key, now)
      fresh.push(issue)
    }
    const activeKeys = new Set(issues.map((issue) => issue.key))
    for (const key of [...this.reportedIssues.keys()]) {
      if (!activeKeys.has(key)) this.reportedIssues.delete(key)
    }
    this.lastIssues = issues

    if (fresh.length > 0) {
      this.store.append({
        t: 'watchdog.checked',
        issues: issues.map((issue) => ({ key: issue.key, text: issue.text, taskId: issue.taskId })),
        repairs,
      })
      const text = [
        'Watchdog found a problem that may need a decision:',
        ...fresh.map((issue) => `- ${issue.text}`),
        repairs.length > 0 ? `\nRepairs already applied: ${repairs.join('; ')}` : '',
        '\nUse superagent_status / superagent_recall to inspect. Close or steer affected tasks; do not re-dispatch blindly.',
      ].join('\n')
      this.ingest({
        source: 'watchdog',
        threadKey: 'watchdog',
        externalId: `watchdog:${now}`,
        kind: 'watchdog',
        actor: 'watchdog',
        title: 'Watchdog',
        text,
        direct: true,
        internal: true,
        meta: { issues: fresh.map((issue) => issue.key) },
      })
      this.scheduleFlush(0)
    }
    return { issues, repairs }
  }

  // ── 持久化恢复与 inbox watcher ─────────────────────────────────────────

  #recover() {
    const now = this.now()
    for (const task of this.store.listTasks()) {
      if (task.status === 'closed' || task.status === 'queued') continue
      if (typeof task.workerSessionId === 'string') {
        const child = this.getAgent(task.workerSessionId)
        if (child !== undefined) {
          this.#attachWorker(task, child)
          if (task.status === 'starting') this.#updateTask(task, { status: 'working' })
          continue
        }
      }
      // 只有“本应在跑”的任务需要恢复提示。idle/blocked/failed/lost 已经有
      // 报告；每次重启都重复通知只会制造噪音。
      if (task.status !== 'starting' && task.status !== 'working') continue
      if (task.recoveryNotifiedAt !== undefined) continue
      this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'interrupted', recoveryNotifiedAt: now } })
      this.#report(
        task,
        'interrupted',
        'Host restarted and this worker session is not live. The task brief and journal survived; decide whether to retry the work or close it.',
        undefined,
        true,
      )
    }
  }

  #loadCursor() {
    try {
      if (!existsSync(this.store.paths.cursor)) return
      const value = JSON.parse(readFileSync(this.store.paths.cursor, 'utf8'))
      if (Number.isFinite(value?.offset) && value.offset >= 0) this.inboxOffset = value.offset
    } catch {
      this.inboxOffset = 0
    }
  }

  #saveCursor(offset = this.inboxOffset) {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.store.paths.cursor, `${JSON.stringify({ offset, at: this.now() })}\n`)
    } catch (error) {
      this.log('warn', `写 cursor 失败（回退到去重键）：${error.message}`)
    }
  }

  #startInboxWatcher() {
    const interval = this.config?.inbox?.pollMs ?? 400
    this.inboxTimer = this.timers.setInterval(() => {
      try {
        this.pollInbox()
      } catch (error) {
        this.lastError = error.message
        this.log('warn', `inbox 轮询失败：${error.message}`)
      }
    }, interval)
    this.inboxTimer?.unref?.()
    // 启动时先读一次，避免最多等一个轮询周期。
    try {
      this.pollInbox()
    } catch {
      // 首次读取失败由下一轮重试。
    }
  }

  /**
   * 读取 `inbox.jsonl` 中尚未消费的行。CLI 只负责追加；这里按字节偏移消费，
   * 崩溃后从 cursor 继续。重复行由 `externalId` 去重兜底。
   *
   * @returns {number} 本次消费的事件数。
   */
  pollInbox() {
    if (!this.active) return 0
    const path = this.store.paths.inbox
    if (!existsSync(path)) return 0
    let size
    try {
      size = statSync(path).size
    } catch {
      return 0
    }
    if (size < this.inboxOffset) {
      this.inboxOffset = 0
      this.inboxRemainder = Buffer.alloc(0)
    }
    if (size === this.inboxOffset) return 0
    const chunk = readSlice(path, this.inboxOffset, size - this.inboxOffset)
    if (chunk === undefined) return 0
    // 只在完整行上推进 cursor；末尾可能是半行，也可能正好切在多字节
    // UTF-8 字符中间。保留字节 remainder，下一次拼接后再解码。
    const combined = Buffer.concat([this.inboxRemainder ?? Buffer.alloc(0), chunk])
    const lastNewline = combined.lastIndexOf(0x0a)
    const complete = lastNewline >= 0 ? combined.subarray(0, lastNewline + 1) : Buffer.alloc(0)
    this.inboxRemainder = lastNewline >= 0 ? combined.subarray(lastNewline + 1) : combined
    let consumed = 0
    for (const line of complete.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        this.log('warn', 'inbox 行不是合法 JSON，已跳过')
        continue
      }
      if (!isRecord(event)) continue
      const result = this.ingest({
        source: event.source,
        threadKey: event.threadKey,
        externalId: event.id ?? event.externalId ?? eventId(),
        kind: event.kind,
        actor: event.actor,
        title: event.title,
        text: event.text,
        url: event.url,
        mentions: event.mentions,
        direct: event.direct,
        meta: event.meta,
        receivedAt: Number.isFinite(event.receivedAt) ? event.receivedAt : undefined,
      })
      if (result?.ok) consumed += 1
    }
    this.inboxOffset += chunk.length
    // cursor 指向 remainder 的起点：若进程在半个多字节字符处退出，下次会
    // 从该字节重新读取，而不是从半个字符之后开始。
    this.#saveCursor(this.inboxOffset - this.inboxRemainder.length)
    return consumed
  }

  // ── 供工具层调用的便捷读 ───────────────────────────────────────────────

  /** pending Trigger 的 Inline 行，用于状态/调试。 */
  pendingLines(limit = 20) {
    return this.store.pendingTriggers(limit).map((trigger) => inlineTrigger(trigger, {
      inlineChars: this.config?.router?.inlineChars,
      now: this.now(),
    }))
  }

  /** 当前配置里的信道名，供工具描述使用。 */
  channelNames() {
    return Object.keys(this.config?.channels ?? {})
  }

  /** 自检信息（HTTP /status）。 */
  health() {
    return {
      ok: this.active && !this.closed,
      router: this.agent?.id,
      pending: this.store.pendingTriggers(1000).length,
      pendingLines: this.pendingLines(8),
      lastError: this.lastError,
      lastCheckAt: this.lastCheckAt,
      issues: this.lastIssues,
    }
  }
}

/** 必填字符串 + 长度上限。 */
function requireText(value, field, maxChars) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeInputError(`${field} is required and must be non-empty`, 'missing_field')
  }
  if (Array.from(value).length > maxChars) {
    throw new RuntimeInputError(`${field} is longer than ${maxChars} characters`, 'too_long')
  }
  return value
}

/** Thread id 列表：去重、最多 8 个、只接受 thr_ 前缀。 */
function normalizeThreadIds(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RuntimeInputError('thread_ids must be an array of thread ids')
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.startsWith('thr_')) {
      throw new RuntimeInputError(`thread_ids entries must start with thr_: ${String(item)}`)
    }
    if (!out.includes(item)) out.push(item)
    if (out.length > 8) throw new RuntimeInputError('at most 8 thread ids can be attached to one task')
  }
  return out
}
