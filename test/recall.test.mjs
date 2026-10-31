/**
 * recall.test.mjs — 链式召回的引用图与有界输出。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-super-agent-recall-'))
  const store = new Store({ dir })
  store.open()
  const text = 'line one\nline two\n' + 'z'.repeat(500)
  store.append({
    t: 'trigger.received',
    trigger: {
      id: 'trg_0000000001',
      source: 'im',
      threadId: 'thr_aaaaaaaaaa',
      threadKey: 'team:dev',
      kind: 'message',
      actor: 'alice',
      title: 'Login',
      summary: 'login broken',
      text,
      receivedAt: 1000,
      addressed: true,
      state: 'pending',
      fullChars: Array.from(text).length,
      truncated: false,
    },
  })
  store.append({
    t: 'task.created',
    task: {
      id: 'tsk_0000000001',
      title: 'Fix login',
      brief: 'Reproduce and fix the Safari login issue',
      cwd: '/tmp/project',
      status: 'queued',
      threadIds: [],
      createdAt: 1000,
    },
  })
  store.append({ t: 'task.subscribed', taskId: 'tsk_0000000001', threadId: 'thr_aaaaaaaaaa', source: 'im' })
  store.append({ t: 'task.updated', taskId: 'tsk_0000000001', patch: { status: 'working', workerSessionId: 's1' } })
  store.append({
    t: 'task.reported',
    taskId: 'tsk_0000000001',
    report: { id: 'rpt_1', reason: 'completed', text: 'fixed and verified', turn: 1 },
  })
  store.append({
    t: 'reply.queued',
    reply: { id: 'rep_1', channel: 'im', text: 'Done: fixed login', taskId: 'tsk_0000000001', createdAt: 2000 },
  })
  store.append({ t: 'batch.created', batchId: 'bat_1', target: 'router', triggerIds: ['trg_0000000001'], renderedChars: 100 })
  return store
}

test('trigger recall returns full bounded text plus thread/task/batch links', () => {
  const store = setup()
  const result = recall(store, 'trg_0000000001', { maxChars: 120, now: 3000 })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'trigger')
  assert.equal(result.object.truncated, true)
  assert.ok(result.object.text.length <= 120)
  assert.ok(result.object.fullChars > 500)
  const kinds = new Set(result.links.map((link) => link.kind))
  assert.deepEqual(kinds, new Set(['thread', 'task', 'batch']))
  assert.ok(result.links.some((link) => link.id === 'tsk_0000000001'))
  store.close()
})

test('thread recall links recent triggers and subscribed tasks', () => {
  const store = setup()
  const result = recall(store, 'thr_aaaaaaaaaa', { maxChars: 500 })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'thread')
  assert.equal(result.object.triggerCount, 1)
  assert.match(result.object.recent, /login broken/)
  assert.ok(result.links.some((link) => link.kind === 'trigger' && link.id === 'trg_0000000001'))
  assert.ok(result.links.some((link) => link.kind === 'task' && link.id === 'tsk_0000000001'))
  store.close()
})

test('task recall shows reports and links back to threads', () => {
  const store = setup()
  const result = recall(store, 'tsk_0000000001', { maxChars: 2000 })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'task')
  assert.equal(result.object.status, 'idle')
  assert.match(result.object.brief, /Safari/)
  assert.equal(result.object.reports.length, 1)
  assert.ok(result.links.some((link) => link.id === 'thr_aaaaaaaaaa'))
  assert.ok(result.links.some((link) => link.id === 'rpt_1' && link.kind === 'report'))
  store.close()
})

test('report and reply recall are first-class', () => {
  const store = setup()
  const report = recall(store, 'rpt_1')
  assert.equal(report.ok, true)
  assert.equal(report.kind, 'report')
  assert.match(report.object.text, /verified/)
  assert.ok(report.links.some((link) => link.id === 'tsk_0000000001'))

  const reply = recall(store, 'rep_1')
  assert.equal(reply.ok, true)
  assert.equal(reply.kind, 'reply')
  assert.equal(reply.object.channel, 'im')
  store.close()
})

test('batch recall expands its triggers', () => {
  const store = setup()
  const result = recall(store, 'bat_1')
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'batch')
  assert.equal(result.object.triggerCount, 1)
  assert.ok(result.links.some((link) => link.id === 'trg_0000000001'))
  store.close()
})

test('unknown ids fail closed with a correction hint', () => {
  const store = setup()
  const result = recall(store, 'trg_missing')
  assert.equal(result.ok, false)
  assert.match(result.error, /not found/)
  const unknown = recall(store, 'wat_1')
  assert.equal(unknown.ok, false)
  assert.match(unknown.hint, /trg_/)
  store.close()
})

test('task recall keeps brief, reports and lastReport within the requested budget', () => {
  const store = setup()
  store.append({
    t: 'task.created',
    task: {
      id: 'tsk_budget_0001',
      title: 'Budgeted task',
      brief: 'b'.repeat(5000),
      cwd: '/tmp/project',
      status: 'queued',
      threadIds: [],
      createdAt: 1000,
    },
  })
  // 直接构造足够长的报告，验证召回不会把 5 份全文一次性倒出来。
  for (let i = 0; i < 5; i += 1) {
    store.append({
      t: 'task.reported',
      taskId: 'tsk_budget_0001',
      report: { id: `rpt_budget_${i}`, reason: 'completed', text: 'x'.repeat(2000), turn: i + 1 },
    })
  }
  const result = recall(store, 'tsk_budget_0001', { maxChars: 2000, now: Date.now() })
  const object = result.object
  const total = object.brief.length
    + object.reports.reduce((sum, report) => sum + report.text.length, 0)
    + (object.lastReport?.text.length ?? 0)
  assert.ok(total <= 2000, `recall returned ${total} chars`)
  assert.equal(object.briefTruncated, true)
  store.close()
})
