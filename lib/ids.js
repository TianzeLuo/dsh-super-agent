/**
 * ids.js — 稳定的对象 id。
 *
 * Trigger / Task / Reply / Batch 用随机短 id；Thread 用 `(source, key)` 的哈希，
 * 这样 CLI 在宿主进程之外也能算出同一个 Thread id，订阅与直通不依赖内存状态。
 *
 * 前缀是有意义的：`superagent_recall` 只看 id 前缀就能判断该展开哪一类对象，
 * Router 不必记住 id 的“类型”。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** 生成 `pfx_<10 hex>`。 */
export function newId(prefix, bytes = 5) {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}

/** Trigger id。 */
export function triggerId() {
  return newId('trg')
}

/** Task id。 */
export function taskId() {
  return newId('tsk')
}

/** Batch id。 */
export function batchId() {
  return newId('bat')
}

/** Reply id。 */
export function replyId() {
  return newId('rep')
}

/** Worker report id。 */
export function reportId() {
  return newId('rpt')
}

/** 外部投递事件的客户端 id。 */
export function eventId() {
  return newId('evt')
}

/** DSH Session id；worker 会话使用标准 UUID，便于宿主持久化与恢复。 */
export function workerSessionId() {
  return randomUUID()
}

/**
 * 由来源与线程键推导稳定 Thread id。
 *
 * @param {string} source 来源名。
 * @param {string | undefined} key 线程键（群聊 id、PR 号、邮件串 id…）。
 * @param {string} [fallback] 没有键时的回退字符串（通常是 Trigger id）。
 * @returns {string} `thr_<10 hex>`。
 */
export function threadId(source, key, fallback) {
  const material = `${source}\u0000${key ?? fallback ?? ''}`
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 10)
  return `thr_${digest}`
}

/** 内部 worker 报告线程：一个任务一条。 */
export function taskThreadId(id) {
  return `thr_task_${String(id).replace(/^tsk_/, '')}`
}

/** 内部 watchdog 线程：一个项目一条。 */
export function watchdogThreadId(projectRoot) {
  return threadId('watchdog', projectRoot)
}

/**
 * 从 id 前缀判断对象类型。
 *
 * @param {string} id 对象 id。
 * @returns {'trigger'|'thread'|'task'|'batch'|'reply'|'report'|'unknown'}
 */
export function idKind(id) {
  if (typeof id !== 'string') return 'unknown'
  if (id.startsWith('trg_')) return 'trigger'
  if (id.startsWith('thr_')) return 'thread'
  if (id.startsWith('tsk_')) return 'task'
  if (id.startsWith('bat_')) return 'batch'
  if (id.startsWith('rep_')) return 'reply'
  if (id.startsWith('rpt_')) return 'report'
  return 'unknown'
}
