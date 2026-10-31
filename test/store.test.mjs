/**
 * store.test.mjs — journal 折叠、任务状态与重启重放。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store, storePaths } from '../lib/store.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-super-agent-store-'))
  const warnings = []
  const store = new Store({ dir, logger: { warn: (message) => warnings.push(message) } })
  store.open()
  return { dir, store, warnings }
}

function trigger(overrides = {}) {
  const id = overrides.id ?? 'trg_0000000001'
  return {
    id,
    source: 'im',
    threadId: 'thr_aaaaaaaaaa',
    threadKey: 'team:dev',
    dedupeKey: 'im\u0000m1',
    kind: 'message',
    actor: 'alice',
    title: 'login bug',
    summary: 'login is broken',
    text: 'login is broken on Safari',
    receivedAt: 1000,
    addressed: true,
    priority: 'addressed',
    state: 'pending',
    fullChars: 28,
    truncated: false,
    ...overrides,
  }
}

test('trigger records create threads and dedupe entries', () => {
  const { store } = tempStore()
  store.append({ t: 'trigger.received', trigger: trigger() })
  assert.equal(store.pendingTriggers().length, 1)
  assert.equal(store.hasDedupe('im\u0000m1'), true)
  assert.equal(store.getThread('thr_aaaaaaaaaa').triggerIds.length, 1)
  assert.equal(store.getThread('thr_aaaaaaaaaa').title, 'login bug')
  store.close()
})

test('filtered triggers are recorded but never pending', () => {
  const { store } = tempStore()
  store.append({
    t: 'trigger.filtered',
    trigger: { ...trigger(), text: '', state: 'filtered' },
    reason: 'not-addressed',
  })
  assert.equal(store.pendingTriggers().length, 0)
  assert.equal(store.getTrigger('trg_0000000001').filterReason, 'not-addressed')
  assert.equal(store.stats().filtered, 1)
  store.close()
})

test('task lifecycle folds subscriptions, reports and close', () => {
  const { store } = tempStore()
  store.append({
    t: 'task.created',
    task: {
      id: 'tsk_0000000001',
      title: 'Fix login',
      brief: 'do it',
      cwd: '/tmp/project',
      status: 'queued',
      threadIds: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  })
  store.append({ t: 'task.subscribed', taskId: 'tsk_0000000001', threadId: 'thr_aaaaaaaaaa', source: 'im' })
  assert.deepEqual(store.getTask('tsk_0000000001').threadIds, ['thr_aaaaaaaaaa'])
  assert.deepEqual([...store.getThread('thr_aaaaaaaaaa').taskIds], ['tsk_0000000001'])

  store.append({ t: 'task.updated', taskId: 'tsk_0000000001', patch: { status: 'working', workerSessionId: 's1' } })
  store.append({
    t: 'task.reported',
    taskId: 'tsk_0000000001',
    report: { id: 'rpt_1', reason: 'completed', text: 'fixed', turn: 2 },
  })
  assert.equal(store.getTask('tsk_0000000001').status, 'idle')
  assert.equal(store.getTask('tsk_0000000001').lastReportTurn, 2)
  assert.equal(store.getTask('tsk_0000000001').lastReport.text, 'fixed')

  store.append({ t: 'task.closed', taskId: 'tsk_0000000001', reason: 'done' })
  assert.equal(store.getTask('tsk_0000000001').status, 'closed')
  assert.deepEqual(store.getTask('tsk_0000000001').threadIds, [])
  assert.equal(store.listTasks().length, 0)
  store.close()
})

test('delivery and failure keep trigger state consistent', () => {
  const { store } = tempStore()
  store.append({ t: 'trigger.received', trigger: trigger() })
  store.append({ t: 'trigger.delivered', triggerId: 'trg_0000000001', batchId: 'bat_1', target: 'router' })
  assert.equal(store.getTrigger('trg_0000000001').state, 'delivered')
  assert.equal(store.pendingTriggers().length, 0)

  store.append({ t: 'trigger.failed', triggerId: 'trg_0000000001', reason: 'router down' })
  assert.equal(store.getTrigger('trg_0000000001').state, 'pending')
  assert.equal(store.getTrigger('trg_0000000001').lastError, 'router down')
  store.close()
})

test('journal replay reconstructs the same state', () => {
  const { dir, store } = tempStore()
  store.append({ t: 'trigger.received', trigger: trigger() })
  store.append({
    t: 'task.created',
    task: {
      id: 'tsk_0000000001',
      title: 'Fix login',
      brief: 'do it',
      cwd: '/tmp/project',
      status: 'queued',
      threadIds: [],
      createdAt: 1000,
    },
  })
  store.append({ t: 'task.subscribed', taskId: 'tsk_0000000001', threadId: 'thr_aaaaaaaaaa', source: 'im' })
  store.append({ t: 'reply.queued', reply: { id: 'rep_1', channel: 'im', text: 'on it', createdAt: 1001 } })
  const before = store.stats()
  store.close()

  const reopened = new Store({ dir })
  reopened.open({ readonly: true })
  assert.deepEqual(reopened.stats(), before)
  assert.equal(reopened.pendingTriggers().length, 1)
  assert.equal(reopened.getTask('tsk_0000000001').title, 'Fix login')
  assert.equal(reopened.queuedReplies()[0].text, 'on it')
  reopened.close()
})

test('malformed journal lines are counted, not fatal', () => {
  const { dir, store } = tempStore()
  store.append({ t: 'trigger.received', trigger: trigger() })
  store.close()
  appendFileSync(storePaths(dir).journal, '{broken json\n')
  const reopened = new Store({ dir, logger: { warn: () => undefined } })
  reopened.open({ readonly: true })
  assert.equal(reopened.badLines, 1)
  assert.equal(reopened.pendingTriggers().length, 1)
  reopened.close()
})

test('append writes one JSON line per fact', () => {
  const { dir, store } = tempStore()
  store.append({ t: 'trigger.received', trigger: trigger() })
  store.close()
  const lines = readFileSync(storePaths(dir).journal, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.v, 1)
  assert.equal(record.t, 'trigger.received')
  assert.equal(record.seq, 0)
})
