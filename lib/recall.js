/**
 * recall.js — 链式召回（Chain of Recall）。
 *
 * 文章 §3.3：每个对象都有唯一 id；注入时只内联紧密关联对象的 id，模型需要时
 * 沿引用关系逐跳展开。这里把 Trigger / Thread / Task / Batch / Reply 放在同一张
 * 引用图里，`superagent_recall(id)` 返回：
 *
 *   - 当前对象的完整（但有上限的）内容；
 *   - `links`：下一跳对象的 id 与一行标签。
 *
 * 返回值永远有界。`max_chars` 由调用方给，默认 6000；正文被截断时明确说明原始
 * 长度，模型可以再次调用并指定更大的上限。
 */

import { clip, formatAge, oneLine, summaryOf } from './text.js'

/** 默认单次召回预算。 */
export const DEFAULT_RECALL_CHARS = 6000

/**
 * 召回一个对象。
 *
 * @param {object} store Store 实例。
 * @param {string} id 对象 id。
 * @param {{ maxChars?: number, now?: number }} [options]
 * @returns {object} 结构化结果。
 */
export function recall(store, id, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : DEFAULT_RECALL_CHARS
  const now = options.now ?? Date.now()
  const value = String(id ?? '').trim()
  if (value.length === 0) return { ok: false, error: 'id is required' }

  if (value.startsWith('trg_')) {
    const trigger = store.getTrigger(value)
    if (trigger === undefined) return { ok: false, error: `trigger not found: ${value}` }
    return recallTrigger(store, trigger, maxChars, now)
  }
  if (value.startsWith('thr_')) {
    const thread = store.getThread(value)
    if (thread === undefined) return { ok: false, error: `thread not found: ${value}` }
    return recallThread(store, thread, maxChars, now)
  }
  if (value.startsWith('tsk_')) {
    const task = store.getTask(value)
    if (task === undefined) return { ok: false, error: `task not found: ${value}` }
    return recallTask(store, task, maxChars, now)
  }
  if (value.startsWith('bat_')) {
    const batch = store.getBatch(value)
    if (batch === undefined) return { ok: false, error: `batch not found: ${value}` }
    return recallBatch(store, batch, maxChars, now)
  }
  if (value.startsWith('rep_')) {
    const reply = store.getReply(value)
    if (reply === undefined) return { ok: false, error: `reply not found: ${value}` }
    return {
      ok: true,
      kind: 'reply',
      object: {
        id: reply.id,
        channel: reply.channel,
        threadId: reply.threadId,
        taskId: reply.taskId,
        words: reply.words,
        createdAt: reply.createdAt,
        text: clip(reply.text, maxChars),
        truncated: String(reply.text ?? '').length > maxChars,
      },
      links: [],
    }
  }
  if (value.startsWith('rpt_')) {
    for (const task of store.tasks.values()) {
      const report = (task.reports ?? []).find((item) => item.id === value)
      if (report !== undefined) {
        return {
          ok: true,
          kind: 'report',
          object: {
            id: report.id,
            taskId: task.id,
            reason: report.reason,
            turn: report.turn,
            at: report.at,
            text: clip(report.text, maxChars),
            truncated: String(report.text ?? '').length > maxChars,
          },
          links: [
            { id: task.id, kind: 'task', label: `${task.title} [${task.status}]` },
            ...[...new Set([...(task.closedThreadIds ?? []), ...task.threadIds])]
              .map((threadId) => ({ id: threadId, kind: 'thread', label: threadLabel(store, threadId) })),
          ],
        }
      }
    }
    return { ok: false, error: `report not found: ${value}` }
  }
  return { ok: false, error: `unknown id prefix: ${value}`, hint: 'use trg_/thr_/tsk_/bat_/rep_ ids from a batch or status' }
}

function recallTrigger(store, trigger, maxChars, now) {
  const full = String(trigger.text ?? '')
  const text = clip(full, maxChars)
  const thread = store.getThread(trigger.threadId)
  const tasks = store.tasksForThread(trigger.threadId)
  return {
    ok: true,
    kind: 'trigger',
    object: {
      id: trigger.id,
      source: trigger.source,
      kind: trigger.kind,
      actor: trigger.actor,
      threadId: trigger.threadId,
      threadKey: trigger.threadKey,
      externalId: trigger.externalId,
      title: trigger.title,
      url: trigger.url,
      addressed: trigger.addressed,
      priority: trigger.addressed ? 'addressed' : 'ambient',
      state: trigger.state,
      receivedAt: trigger.receivedAt,
      age: trigger.receivedAt ? formatAge(now - trigger.receivedAt) : undefined,
      summary: trigger.summary,
      fullChars: Array.from(full).length,
      truncated: text.length < full.length || Array.from(full).length > maxChars,
      text,
      filterReason: trigger.filterReason,
      lastError: trigger.lastError,
      deliveries: trigger.deliveries,
      meta: trigger.meta,
    },
    links: [
      ...(thread !== undefined ? [{ id: thread.id, kind: 'thread', label: threadLabel(store, thread.id) }] : []),
      ...tasks.map((task) => ({ id: task.id, kind: 'task', label: `${task.title} [${task.status}]` })),
      ...[...new Set([
        ...trigger.deliveries.map((delivery) => delivery.batchId).filter((id) => typeof id === 'string'),
        ...[...store.batches.values()].filter((batch) => batch.triggerIds.includes(trigger.id)).map((batch) => batch.id),
      ])].map((id) => ({ id, kind: 'batch', label: `batch ${id}` })),
    ],
  }
}

function recallThread(store, thread, maxChars, now) {
  const recent = thread.triggerIds
    .slice(-12)
    .map((id) => store.getTrigger(id))
    .filter((trigger) => trigger !== undefined && trigger.state !== 'filtered')
  const tasks = store.tasksForThread(thread.id)
  const lines = recent.map((trigger) => `- ${trigger.id} ${trigger.actor ? `${trigger.actor}: ` : ''}${trigger.summary || summaryOf(trigger.text || trigger.summary, 180)}`)
  const contextText = lines.join('\n')
  const taskLines = tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`)
  return {
    ok: true,
    kind: 'thread',
    object: {
      id: thread.id,
      source: thread.source,
      key: thread.key,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      triggerCount: thread.triggerIds.length,
      triggerIds: thread.triggerIds.slice(-12),
      tasks: taskLines,
      recent: clip(contextText, maxChars),
      recentTruncated: contextText.length > maxChars,
      age: thread.updatedAt ? formatAge(now - thread.updatedAt) : undefined,
    },
    links: [
      ...recent.map((trigger) => ({ id: trigger.id, kind: 'trigger', label: `${trigger.actor ?? '?'}: ${summaryOf(trigger.text, 80)}` })),
      ...tasks.map((task) => ({ id: task.id, kind: 'task', label: `${task.title} [${task.status}]` })),
    ],
  }
}

function recallTask(store, task, maxChars, now) {
  const sourceReports = (task.reports ?? []).slice(-5)
  const reportBudget = Math.max(200, Math.floor((maxChars * 0.4) / Math.max(1, sourceReports.length)))
  const brief = clip(task.brief, Math.max(200, maxChars - reportBudget * sourceReports.length - 600))
  const reports = sourceReports.map((report) => ({
    id: report.id,
    at: report.at,
    reason: report.reason,
    turn: report.turn,
    text: clip(report.text, reportBudget),
  }))
  const lastReport = task.lastReport === undefined
    ? undefined
    : { ...task.lastReport, text: clip(task.lastReport.text, 600) }
  return {
    ok: true,
    kind: 'task',
    object: {
      id: task.id,
      title: task.title,
      status: task.status,
      workerSessionId: task.workerSessionId,
      cwd: task.cwd,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      age: task.updatedAt ? formatAge(now - task.updatedAt) : undefined,
      threadIds: task.threadIds,
      closedThreadIds: task.closedThreadIds,
      brief,
      briefTruncated: String(task.brief ?? '').length > brief.length,
      reports,
      lastReport,
      steerCount: task.steerCount ?? 0,
      closeReason: task.closeReason,
    },
    links: [
      ...[...new Set([...(task.closedThreadIds ?? []), ...task.threadIds])]
        .map((threadId) => ({ id: threadId, kind: 'thread', label: threadLabel(store, threadId) })),
      ...reports.filter((report) => report.id !== undefined).map((report) => ({ id: report.id, kind: 'report', label: `report ${report.reason}` })),
    ],
  }
}

function recallBatch(store, batch, maxChars, now) {
  const triggers = batch.triggerIds.map((id) => store.getTrigger(id)).filter((trigger) => trigger !== undefined)
  const lines = triggers.map((trigger) => `- ${trigger.id} ${trigger.actor ? `${trigger.actor}: ` : ''}${summaryOf(trigger.text || trigger.summary, 200)}`)
  const text = lines.join('\n')
  return {
    ok: true,
    kind: 'batch',
    object: {
      id: batch.id,
      createdAt: batch.createdAt,
      target: batch.target,
      triggerIds: batch.triggerIds,
      triggerCount: triggers.length,
      renderedChars: batch.renderedChars,
      age: batch.createdAt ? formatAge(now - batch.createdAt) : undefined,
      text: clip(text, maxChars),
      truncated: text.length > maxChars,
    },
    links: triggers.map((trigger) => ({ id: trigger.id, kind: 'trigger', label: `${trigger.actor ?? '?'}: ${summaryOf(trigger.text || trigger.summary, 80)}` })),
  }
}

function threadLabel(store, threadId) {
  const thread = store.getThread(threadId)
  if (thread === undefined) return threadId
  return `${threadId}${thread.title ? ` "${clip(oneLine(thread.title), 60)}"` : ''}`
}
