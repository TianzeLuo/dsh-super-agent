/**
 * store.js — 单写者的追加式 journal 与内存折叠。
 *
 * 文章 §5 的“计算与状态分离”在单机插件里的最小实现：
 *
 *   - 事实写进 `<dataDir>/journal.jsonl`，一行一个事件，只追加；
 *   - 内存里的 Trigger / Thread / Task / Reply 索引全部由 journal 重放得到；
 *   - 进程重启后不需要任何外部数据库，也不依赖 DSH Session 是否还活着；
 *   - 插件是 journal 的唯一写者；CLI 只读 journal，外部事件走 `inbox.jsonl`。
 *
 * 为什么不用更复杂的库：这里要的是可检查、可 `grep`、崩溃后能手工看懂的状态。
 * 每次写入都很小（< 8 KiB），`writeSync` 到 O_APPEND fd 在单进程内足够；跨进程
 * 追加由操作系统的 O_APPEND 保证不交错到同一行中间（超出单次写上限的超长事件
 * 会被 runtime 截断）。
 *
 * 注意：**不做清理、不做轮转、不删旧行。** 需要压缩时另写显式工具，不能在
 * 启动/关闭路径里偷偷删。当前规模下 journal 体积不是瓶颈。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { parseJsonLine } from './text.js'

/** journal 版本；未来不兼容变更时用于迁移。 */
export const JOURNAL_VERSION = 1

/** 内存里每个任务保留的报告数（journal 仍保留全部）。 */
const MAX_IN_MEMORY_REPORTS = 50

/** 路径集合。 */
export function storePaths(dataDir) {
  return {
    dir: dataDir,
    journal: join(dataDir, 'journal.jsonl'),
    inbox: join(dataDir, 'inbox.jsonl'),
    cursor: join(dataDir, 'cursor.json'),
    outbox: join(dataDir, 'outbox.jsonl'),
    owner: join(dataDir, 'owner.json'),
  }
}

/**
 * 追加式 Store。
 */
export class Store {
  /**
   * @param {{ dir: string, now?: () => number, logger?: { warn?: (m: string) => void } }} options
   */
  constructor(options) {
    this.dir = options.dir
    this.paths = storePaths(options.dir)
    this.now = options.now ?? Date.now
    this.logger = options.logger
    this.readonly = false
    this.fd = undefined
    this.seq = 0
    this.badLines = 0
    this.opened = false

    /** @type {Map<string, object>} */
    this.triggers = new Map()
    /** @type {Map<string, object>} */
    this.threads = new Map()
    /** @type {Map<string, object>} */
    this.tasks = new Map()
    /** @type {Map<string, object>} */
    this.batches = new Map()
    /** @type {Map<string, object>} */
    this.replies = new Map()
    /** @type {Map<string, string>} */
    this.dedupe = new Map()
    /** @type {string[]} */
    this.triggerOrder = []
    /** @type {string[]} */
    this.taskOrder = []
    /** @type {string[]} */
    this.replyOrder = []
    this.lastWatchdog = undefined
  }

  /**
   * 打开并重放 journal。
   *
   * @param {{ readonly?: boolean }} [options]
   */
  open(options = {}) {
    if (this.opened) return this
    this.readonly = options.readonly === true
    if (!this.readonly) mkdirSync(this.dir, { recursive: true })
    if (existsSync(this.paths.journal)) {
      const content = readFileSync(this.paths.journal, 'utf8')
      let lineNo = 0
      for (const line of content.split('\n')) {
        lineNo += 1
        if (line.trim().length === 0) continue
        const record = parseJsonLine(line)
        if (record === undefined) {
          this.badLines += 1
          this.logger?.warn?.(`journal 第 ${lineNo} 行无法解析，已跳过`)
          continue
        }
        try {
          this.apply(record)
        } catch (error) {
          this.badLines += 1
          this.logger?.warn?.(`journal 第 ${lineNo} 行应用失败：${error.message}`)
        }
      }
    }
    if (!this.readonly) this.fd = openSync(this.paths.journal, 'a')
    this.opened = true
    return this
  }

  /** 关闭文件句柄；不删除任何文件。 */
  close() {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd)
      } catch {
        // 关闭失败不再放大；journal 已经落盘。
      }
      this.fd = undefined
    }
    this.opened = false
  }

  /**
   * 追加一条事实并立即折叠进内存。
   *
   * @param {object} event 不含 seq/at 的事件。
   * @returns {object} 带 seq/at 的完整记录。
   */
  append(event) {
    if (this.readonly) throw new Error('store is read-only')
    const record = {
      v: JOURNAL_VERSION,
      seq: this.seq,
      at: this.now(),
      ...event,
    }
    const line = `${JSON.stringify(record)}\n`
    if (this.fd !== undefined) writeSync(this.fd, line)
    this.seq += 1
    this.apply(record)
    return record
  }

  /**
   * 折叠一条记录。重放与实时追加共用这一条路径。
   *
   * @param {object} record journal 记录。
   */
  apply(record) {
    if (typeof record.seq === 'number' && record.seq >= this.seq) this.seq = record.seq + 1
    switch (record.t) {
      case 'trigger.received':
      case 'trigger.filtered':
        this.#applyTrigger(record)
        break
      case 'trigger.delivered':
        this.#applyDelivered(record)
        break
      case 'trigger.failed':
        this.#applyFailed(record)
        break
      case 'batch.created':
        this.#applyBatch(record)
        break
      case 'task.created':
        this.#applyTaskCreated(record)
        break
      case 'task.updated':
        this.#applyTaskUpdated(record)
        break
      case 'task.subscribed':
        this.#applySubscribed(record)
        break
      case 'task.unsubscribed':
        this.#applyUnsubscribed(record)
        break
      case 'task.reported':
        this.#applyReported(record)
        break
      case 'task.steered':
        this.#applySteered(record)
        break
      case 'task.closed':
        this.#applyClosed(record)
        break
      case 'reply.queued':
        this.#applyReply(record)
        break
      case 'watchdog.checked':
        this.lastWatchdog = {
          at: record.at,
          issues: record.issues ?? [],
          repairs: record.repairs ?? [],
        }
        break
      default:
        // 未知事件类型保留前向兼容：不折叠，但 journal 仍完整。
        break
    }
  }

  #threadFor(trigger) {
    let thread = this.threads.get(trigger.threadId)
    if (thread === undefined) {
      thread = {
        id: trigger.threadId,
        source: trigger.source,
        key: trigger.threadKey,
        title: trigger.title || trigger.summary || trigger.threadId,
        triggerIds: [],
        taskIds: new Set(),
        createdAt: trigger.receivedAt ?? this.now(),
        updatedAt: trigger.receivedAt ?? this.now(),
      }
      this.threads.set(trigger.threadId, thread)
    }
    return thread
  }

  #applyTrigger(record) {
    const incoming = record.trigger
    if (!incoming || typeof incoming.id !== 'string') return
    if (this.triggers.has(incoming.id)) return
    const trigger = {
      ...incoming,
      state: record.t === 'trigger.filtered' ? 'filtered' : (incoming.state ?? 'pending'),
      receivedSeq: typeof record.seq === 'number' ? record.seq : this.triggerOrder.length,
      deliveries: [],
    }
    this.triggers.set(trigger.id, trigger)
    this.triggerOrder.push(trigger.id)
    if (trigger.dedupeKey !== undefined) this.dedupe.set(trigger.dedupeKey, trigger.id)
    const thread = this.#threadFor(trigger)
    if (!thread.triggerIds.includes(trigger.id)) thread.triggerIds.push(trigger.id)
    thread.updatedAt = trigger.receivedAt ?? thread.updatedAt
    if (trigger.state === 'filtered' && record.reason !== undefined) trigger.filterReason = record.reason
  }

  #applyDelivered(record) {
    const trigger = this.triggers.get(record.triggerId)
    if (trigger === undefined) return
    if (trigger.state !== 'filtered') trigger.state = 'delivered'
    trigger.updatedAt = record.at
    trigger.deliveries.push({
      batchId: record.batchId,
      target: record.target,
      taskId: record.taskId,
      at: record.at,
    })
  }

  #applyFailed(record) {
    const trigger = this.triggers.get(record.triggerId)
    if (trigger === undefined) return
    // 失败回退为 pending：下一轮 watcher / watchdog 可以再试。
    if (trigger.state !== 'filtered') trigger.state = 'pending'
    trigger.lastError = record.reason
    trigger.updatedAt = record.at
  }

  #applyBatch(record) {
    if (typeof record.batchId !== 'string') return
    this.batches.set(record.batchId, {
      id: record.batchId,
      triggerIds: Array.isArray(record.triggerIds) ? [...record.triggerIds] : [],
      target: record.target ?? 'router',
      createdAt: record.at,
      renderedChars: record.renderedChars,
    })
  }

  #applyTaskCreated(record) {
    const incoming = record.task
    if (!incoming || typeof incoming.id !== 'string' || this.tasks.has(incoming.id)) return
    const task = {
      ...incoming,
      status: incoming.status ?? 'queued',
      threadIds: Array.isArray(incoming.threadIds) ? [...new Set(incoming.threadIds)] : [],
      reports: [],
      createdAt: incoming.createdAt ?? record.at,
      updatedAt: incoming.updatedAt ?? record.at,
    }
    this.tasks.set(task.id, task)
    this.taskOrder.push(task.id)
    for (const threadId of task.threadIds) {
      const thread = this.threads.get(threadId)
      if (thread !== undefined) thread.taskIds.add(task.id)
    }
  }

  #applyTaskUpdated(record) {
    const task = this.tasks.get(record.taskId)
    if (task === undefined) return
    const patch = record.patch
    if (!patch || typeof patch !== 'object') return
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'threadIds') {
        task.threadIds = Array.isArray(value) ? [...new Set(value)] : task.threadIds
      } else if (key !== 'reports' && key !== 'id') {
        task[key] = value
      }
    }
    task.updatedAt = record.at
  }

  #applySubscribed(record) {
    const task = this.tasks.get(record.taskId)
    if (task === undefined) return
    if (!task.threadIds.includes(record.threadId)) task.threadIds.push(record.threadId)
    let thread = this.threads.get(record.threadId)
    if (thread === undefined) {
      thread = {
        id: record.threadId,
        source: record.source ?? 'unknown',
        key: record.key,
        title: record.title ?? record.threadId,
        triggerIds: [],
        taskIds: new Set(),
        createdAt: record.at,
        updatedAt: record.at,
      }
      this.threads.set(thread.id, thread)
    }
    thread.taskIds.add(record.taskId)
    task.updatedAt = record.at
  }

  #applyUnsubscribed(record) {
    const task = this.tasks.get(record.taskId)
    if (task === undefined) return
    task.threadIds = task.threadIds.filter((id) => id !== record.threadId)
    this.threads.get(record.threadId)?.taskIds.delete(record.taskId)
    task.updatedAt = record.at
  }

  #applyReported(record) {
    const task = this.tasks.get(record.taskId)
    if (task === undefined) return
    const report = {
      id: record.report?.id,
      at: record.at,
      reason: record.report?.reason ?? 'completed',
      text: record.report?.text ?? '',
      turn: record.report?.turn,
      triggerId: record.report?.triggerId,
    }
    if (report.reason === 'completed') {
      task.status = 'idle'
    } else if (report.reason === 'blocked') {
      task.status = 'blocked'
    } else if (report.reason === 'lost') {
      task.status = 'lost'
    } else if (report.reason === 'aborted' || report.reason === 'interrupted') {
      task.status = 'interrupted'
    } else {
      task.status = 'failed'
    }
    task.reports.push(report)
    if (task.reports.length > MAX_IN_MEMORY_REPORTS) task.reports.shift()
    task.lastReport = report
    task.lastReportAt = record.at
    task.lastReportTurn = report.turn
    task.updatedAt = record.at
  }

  #applySteered(record) {
    const task = this.tasks.get(record.taskId)
    if (task === undefined) return
    task.steerCount = (task.steerCount ?? 0) + 1
    task.lastSteerAt = record.at
    task.updatedAt = record.at
  }

  #applyClosed(record) {
    const task = this.tasks.get(record.taskId)
    if (task === undefined) return
    task.status = 'closed'
    task.closedAt = record.at
    task.closeReason = record.reason
    task.updatedAt = record.at
    task.closedThreadIds = [...task.threadIds]
    for (const threadId of task.threadIds) this.threads.get(threadId)?.taskIds.delete(task.id)
    task.threadIds = []
  }

  #applyReply(record) {
    const reply = record.reply
    if (!reply || typeof reply.id !== 'string' || this.replies.has(reply.id)) return
    const stored = {
      ...reply,
      createdAt: reply.createdAt ?? record.at,
      status: reply.status ?? 'queued',
    }
    this.replies.set(stored.id, stored)
    this.replyOrder.push(stored.id)
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  /** 是否已经见过这个去重键。 */
  hasDedupe(key) {
    return this.dedupe.has(key)
  }

  /** 去重键对应的 Trigger id。 */
  dedupeId(key) {
    return this.dedupe.get(key)
  }

  getTrigger(id) {
    return this.triggers.get(id)
  }

  getThread(id) {
    return this.threads.get(id)
  }

  getTask(id) {
    return this.tasks.get(id)
  }

  getBatch(id) {
    return this.batches.get(id)
  }

  getReply(id) {
    return this.replies.get(id)
  }

  /** release 状态的 Trigger，按接收顺序。 */
  pendingTriggers(limit = 100) {
    const out = []
    for (const id of this.triggerOrder) {
      const trigger = this.triggers.get(id)
      if (trigger?.state === 'pending') out.push(trigger)
      if (out.length >= limit) break
    }
    return out
  }

  /** 所有 Trigger，最新在前。 */
  recentTriggers(limit = 20) {
    const out = []
    for (let index = this.triggerOrder.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const trigger = this.triggers.get(this.triggerOrder[index])
      if (trigger !== undefined) out.push(trigger)
    }
    return out
  }

  /** 任务列表；默认不含 closed。 */
  listTasks({ includeClosed = false } = {}) {
    const out = []
    for (const id of this.taskOrder) {
      const task = this.tasks.get(id)
      if (task === undefined) continue
      if (!includeClosed && task.status === 'closed') continue
      out.push(task)
    }
    return out
  }

  /** 线程列表，最新更新在前。 */
  listThreads({ limit = 100 } = {}) {
    return [...this.threads.values()]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit)
  }

  /** 某个线程上订阅中的任务。 */
  tasksForThread(threadId) {
    const thread = this.threads.get(threadId)
    if (thread === undefined) return []
    return [...thread.taskIds]
      .map((id) => this.tasks.get(id))
      .filter((task) => task !== undefined && task.status !== 'closed')
  }

  /** 通过 worker Session id 找任务；优先活动任务，其次最新的未关闭任务。 */
  taskForWorkerSession(sessionId) {
    let latest
    for (const task of this.tasks.values()) {
      if (task.workerSessionId !== sessionId || task.status === 'closed') continue
      if (task.status === 'starting' || task.status === 'working') return task
      latest = task
    }
    return latest
  }

  /** 某个 Trigger 之后的同线程上下文（用于初始 worker prompt）。 */
  contextTriggers(threadId, beforeTriggerId, limit = 4) {
    const thread = this.threads.get(threadId)
    if (thread === undefined) return []
    const index = beforeTriggerId === undefined ? thread.triggerIds.length : thread.triggerIds.indexOf(beforeTriggerId)
    const end = index < 0 ? thread.triggerIds.length : index
    const ids = thread.triggerIds.slice(Math.max(0, end - limit), end)
    return ids.map((id) => this.triggers.get(id)).filter((trigger) => trigger !== undefined && trigger.state !== 'filtered')
  }

  /** 队列中的回复，按写入顺序。 */
  queuedReplies(limit = 50) {
    const out = []
    for (const id of this.replyOrder) {
      const reply = this.replies.get(id)
      if (reply !== undefined) out.push(reply)
      if (out.length >= limit) break
    }
    return out
  }

  /** 供状态视图使用的计数。 */
  stats() {
    const tasks = { queued: 0, starting: 0, working: 0, idle: 0, blocked: 0, failed: 0, interrupted: 0, lost: 0, closed: 0 }
    for (const task of this.tasks.values()) {
      tasks[task.status] = (tasks[task.status] ?? 0) + 1
    }
    let pending = 0
    let filtered = 0
    for (const trigger of this.triggers.values()) {
      if (trigger.state === 'pending') pending += 1
      if (trigger.state === 'filtered') filtered += 1
    }
    const byChannel = {}
    for (const reply of this.replies.values()) byChannel[reply.channel] = (byChannel[reply.channel] ?? 0) + 1
    return {
      triggers: this.triggers.size,
      pending,
      filtered,
      threads: this.threads.size,
      tasks,
      batches: this.batches.size,
      replies: this.replies.size,
      repliesByChannel: byChannel,
      journalBadLines: this.badLines,
      journalSeq: this.seq,
    }
  }
}
