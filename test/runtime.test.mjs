/**
 * runtime.test.mjs — 双层调度、批处理、直通、报告、watchdog 与恢复。
 *
 * 所有模型调用都被假 Agent 取代；这里验证的是文章 §2–§6 中“程序该负责”的部分：
 * 事件怎么排、什么时候合并、什么时候直通、Worker 的结果怎么回来、异常怎么自愈。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { threadId } from '../lib/ids.js'
import { Store } from '../lib/store.js'
import { RuntimeInputError } from '../lib/runtime.js'
import { fakeChild, fakeProject, fakeRouter, setupRuntime, tick } from './fake-host.mjs'

/** 从批次消息里取纯文本。 */
function messageText(message) {
  return message.content.map((block) => block.text ?? '').join('\n')
}

test('a new trigger is queued, then flushed as one bounded batch', () => {
  const ctx = setupRuntime()
  const result = ctx.runtime.ingest({
    source: 'im',
    threadKey: 'team:dev',
    externalId: 'm1',
    actor: 'alice',
    text: '@super-agent login is broken',
  })
  assert.equal(result.state, 'pending')
  assert.equal(ctx.store.pendingTriggers().length, 1)

  const flushed = ctx.runtime.flushNow()
  assert.equal(flushed.flushed, 1)
  assert.equal(ctx.router.messages.length, 1)
  assert.match(messageText(ctx.router.messages[0]), /\[super-agent\]/)
  assert.match(messageText(ctx.router.messages[0]), new RegExp(result.id))
  assert.equal(ctx.store.pendingTriggers().length, 0)
  assert.equal(ctx.store.getTrigger(result.id).state, 'delivered')
  ctx.runtime.stop()
})

test('duplicate external ids are idempotent and do not wake the router', () => {
  const ctx = setupRuntime()
  const first = ctx.runtime.ingest({ source: 'im', threadKey: 't', externalId: 'same', actor: 'a', text: '@super-agent fix' })
  const second = ctx.runtime.ingest({ source: 'im', threadKey: 't', externalId: 'same', actor: 'a', text: '@super-agent fix' })
  assert.equal(second.duplicate, true)
  assert.equal(second.id, first.id)
  assert.equal(ctx.store.pendingTriggers().length, 1)
  ctx.runtime.stop()
})

test('triggers arriving during a router turn are batched into the next turn', () => {
  const ctx = setupRuntime()
  ctx.router.status = 'running'
  for (let index = 0; index < 3; index += 1) {
    ctx.runtime.ingest({ source: 'github', threadKey: `pr:${index}`, actor: 'alice', text: `CI failure ${index}` })
  }
  assert.equal(ctx.runtime.flushNow().deferred, true)
  assert.equal(ctx.router.messages.length, 0)

  // Router finishes its current turn; the idle event schedules a flush.
  ctx.router.finish()
  ctx.timers.runTimeouts()
  assert.equal(ctx.router.messages.length, 1)
  assert.match(messageText(ctx.router.messages[0]), /3 trigger\(s\)/)
  assert.equal(ctx.store.pendingTriggers().length, 0)
  ctx.runtime.stop()
})

test('dispatch starts an isolated worker and returns immediately', async () => {
  const ctx = setupRuntime()
  const tid = threadId('im', 'team:dev')
  const dispatched = ctx.runtime.dispatch({ title: 'Fix login', brief: 'Reproduce the Safari bug and fix it', threadIds: [tid] })
  assert.equal(dispatched.ok, true)
  assert.match(dispatched.taskId, /^tsk_/)
  assert.match(dispatched.note, /do not wait/)

  await tick()
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'working')
  assert.equal(ctx.subagents.spawns.length, 1)
  const spawn = ctx.subagents.spawns[0]
  assert.equal(spawn.spec.provider, 'spawn')
  assert.equal(spawn.spec.delivery, 'caller')
  assert.equal(spawn.spec.request.cwd, ctx.root)
  assert.match(spawn.spec.request.prompt[0].text, /Fix login/)
  assert.match(spawn.spec.request.prompt[0].text, /Reproduce the Safari bug/)
  assert.equal(ctx.router.messages.length, 0)
  ctx.runtime.stop()
})

test('a subscribed thread routes new events directly to the worker, not the router', async () => {
  const ctx = setupRuntime()
  const tid = threadId('im', 'team:dev')
  const dispatched = ctx.runtime.dispatch({ title: 'Own the thread', brief: 'Handle follow-ups', threadIds: [tid] })
  await tick()
  const child = [...ctx.children.values()][0]

  const ingested = ctx.runtime.ingest({
    source: 'im',
    threadKey: 'team:dev',
    actor: 'alice',
    text: '@super-agent extra detail: it only fails in Safari',
  })
  assert.equal(ingested.state, 'delivered')
  assert.deepEqual(ingested.deliveredTo, [dispatched.taskId])
  assert.equal(child.messages.length, 1)
  assert.match(messageText(child.messages[0]), /extra detail/)
  assert.equal(ctx.router.messages.length, 0)
  assert.equal(ctx.store.getTrigger(ingested.id).deliveries[0].target, 'worker')
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'working')
  ctx.runtime.stop()
})

test('multiple workers subscribed to one thread all receive the event', async () => {
  const ctx = setupRuntime({ config: { worker: { maxWorkers: 4 } } })
  const tid = threadId('im', 'team:dev')
  ctx.runtime.dispatch({ title: 'Task A', brief: 'A', threadIds: [tid] })
  ctx.runtime.dispatch({ title: 'Task B', brief: 'B', threadIds: [tid] })
  await tick()
  assert.equal(ctx.children.size, 2)

  const ingested = ctx.runtime.ingest({ source: 'im', threadKey: 'team:dev', actor: 'alice', text: '@super-agent update' })
  assert.equal(ingested.state, 'delivered')
  assert.equal(ingested.deliveredTo.length, 2)
  for (const child of ctx.children.values()) {
    assert.equal(child.messages.length, 1)
    assert.match(messageText(child.messages[0]), /update/)
  }
  ctx.runtime.stop()
})

test('a worker turn end becomes a worker-report trigger and updates the task', async () => {
  const ctx = setupRuntime()
  const tid = threadId('im', 'team:dev')
  const dispatched = ctx.runtime.dispatch({ title: 'Fix login', brief: 'Do the work', threadIds: [tid] })
  await tick()
  const child = [...ctx.children.values()][0]

  child.finishTurn({ text: 'Fixed and verified with unit tests', turn: 1 })
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'idle')
  assert.equal(task.lastReport.reason, 'completed')
  const pending = ctx.store.pendingTriggers()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].source, 'worker')
  assert.equal(pending[0].kind, 'worker-report')

  ctx.runtime.flushNow()
  assert.equal(ctx.router.messages.length, 1)
  assert.match(messageText(ctx.router.messages[0]), /Fixed and verified/)
  assert.match(messageText(ctx.router.messages[0]), /worker-report/)
  ctx.runtime.stop()
})

test('repeated turn-end events for the same turn do not duplicate reports', async () => {
  const ctx = setupRuntime()
  const tid = threadId('im', 'team:dev')
  ctx.runtime.dispatch({ title: 'Fix login', brief: 'Do the work', threadIds: [tid] })
  await tick()
  const child = [...ctx.children.values()][0]
  child.finishTurn({ text: 'first', turn: 1 })
  child.finishTurn({ text: 'second', turn: 1 })
  const reports = [...ctx.store.tasks.values()][0].reports
  assert.equal(reports.length, 1)
  assert.match(reports[0].text, /first/)
  ctx.runtime.stop()
})

test('steer wakes an idle worker and records the steer', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'Fix login', brief: 'Do the work' })
  await tick()
  const child = [...ctx.children.values()][0]
  child.finishTurn({ text: 'done', turn: 1 })
  const steered = ctx.runtime.steer(dispatched.taskId, 'Also check the password reset flow')
  assert.equal(steered.status, 'accepted')
  assert.equal(child.messages.length, 1)
  assert.match(messageText(child.messages[0]), /password reset/)
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'working')
  assert.equal(ctx.store.getTask(dispatched.taskId).steerCount, 1)
  ctx.runtime.stop()
})

test('close releases the worker and keeps the journal record', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'Fix login', brief: 'Do the work' })
  await tick()
  const activation = ctx.subagents.spawns[0]
  const closed = ctx.runtime.close({ taskId: dispatched.taskId, reason: 'done' })
  assert.equal(closed.status, 'closing')
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'closed')
  await tick()
  assert.equal(activation.disposed, true)
  assert.equal(ctx.children.size, 0)
  ctx.runtime.stop()
})

test('unsubscribing one thread leaves the task alive', async () => {
  const ctx = setupRuntime()
  const tid = threadId('im', 'team:dev')
  const other = threadId('github', 'pr:1')
  const dispatched = ctx.runtime.dispatch({ title: 'Task', brief: 'Do', threadIds: [tid, other] })
  const result = ctx.runtime.close({ taskId: dispatched.taskId, threadId: other })
  assert.equal(result.status, 'unsubscribed')
  assert.deepEqual(ctx.store.getTask(dispatched.taskId).threadIds, [tid])
  assert.notEqual(ctx.store.getTask(dispatched.taskId).status, 'closed')
  ctx.runtime.stop()
})

test('maxWorkers queues the next task until a slot opens', async () => {
  const ctx = setupRuntime({ config: { worker: { maxWorkers: 1 } } })
  const first = ctx.runtime.dispatch({ title: 'First', brief: 'A' })
  await tick()
  const second = ctx.runtime.dispatch({ title: 'Second', brief: 'B' })
  assert.equal(ctx.store.getTask(second.taskId).status, 'queued')

  ctx.runtime.close({ taskId: first.taskId })
  await tick()
  assert.equal(ctx.store.getTask(second.taskId).status, 'working')
  ctx.runtime.stop()
})

test('an idle completed worker frees the execution slot for the next task', async () => {
  const ctx = setupRuntime({ config: { worker: { maxWorkers: 1 } } })
  const first = ctx.runtime.dispatch({ title: 'First', brief: 'A' })
  await tick()
  const second = ctx.runtime.dispatch({ title: 'Second', brief: 'B' })
  assert.equal(ctx.store.getTask(second.taskId).status, 'queued')

  const child = [...ctx.children.values()][0]
  child.finishTurn({ text: 'first done', turn: 1 })
  await tick()
  assert.equal(ctx.store.getTask(first.taskId).status, 'idle')
  assert.equal(ctx.store.getTask(second.taskId).status, 'working')
  assert.equal(ctx.subagents.spawns.length, 2)
  ctx.runtime.stop()
})

test('a task can reuse an idle Worker while keeping its context', async () => {
  const ctx = setupRuntime()
  const first = ctx.runtime.dispatch({ title: 'Phase one', brief: 'Build the thing' })
  await tick()
  const child = [...ctx.children.values()][0]
  const workerId = child.id
  child.finishTurn({ text: 'phase one done', turn: 1 })
  await tick()
  assert.equal(ctx.store.getTask(first.taskId).status, 'idle')

  const second = ctx.runtime.dispatch({
    title: 'Phase two',
    brief: 'Continue from the previous result',
    reuseTaskId: first.taskId,
  })
  await tick()
  assert.equal(second.workerSessionId, workerId)
  assert.equal(second.continuedFrom, first.taskId)
  assert.equal(ctx.store.getTask(second.taskId).status, 'working')
  assert.equal(ctx.store.getTask(first.taskId).status, 'idle')
  assert.equal(ctx.children.size, 1)
  assert.equal(child.messages.length, 1)
  assert.match(messageText(child.messages[0]), /Phase two/)
  assert.match(messageText(child.messages[0]), /Continues task/)

  child.finishTurn({ text: 'phase two done', turn: 2 })
  await tick()
  assert.equal(ctx.store.getTask(second.taskId).status, 'idle')
  assert.equal(ctx.store.getTask(first.taskId).status, 'idle')

  // Closing the old task must not kill the Worker still owned by the new task.
  const closed = ctx.runtime.close({ taskId: first.taskId })
  assert.equal(closed.workerRetained, true)
  assert.equal(ctx.children.size, 1)
  ctx.runtime.close({ taskId: second.taskId })
  await tick()
  assert.equal(ctx.children.size, 0)
  ctx.runtime.stop()
})

test('reusing a worker rejects a busy or closed context', async () => {
  const ctx = setupRuntime()
  const first = ctx.runtime.dispatch({ title: 'Phase one', brief: 'Build the thing' })
  await tick()
  const child = [...ctx.children.values()][0]
  child.finishTurn({ text: 'done', turn: 1 })
  await tick()

  const second = ctx.runtime.dispatch({ title: 'Phase two', brief: 'Continue', reuseTaskId: first.taskId })
  await tick()
  assert.equal(ctx.store.getTask(second.taskId).status, 'working')
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'Parallel', brief: 'Must not share a busy worker', reuseTaskId: first.taskId }),
    /busy/i,
  )
  ctx.runtime.close({ taskId: first.taskId })
  ctx.runtime.close({ taskId: second.taskId })
  await tick()
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'After close', brief: 'No live worker', reuseTaskId: first.taskId }),
    /cannot be reused|no longer live|no live worker|not found/i,
  )
  ctx.runtime.stop()
})

test('watchdog marks a missing worker lost and reports to the router', async () => {
  const ctx = setupRuntime()
  const tid = threadId('im', 'team:dev')
  const dispatched = ctx.runtime.dispatch({ title: 'Fix login', brief: 'Do the work', threadIds: [tid] })
  await tick()
  const child = [...ctx.children.values()][0]
  ctx.children.delete(child.id) // 模拟 Worker 会话被宿主回收

  const result = ctx.runtime.checkNow()
  assert.ok(result.issues.some((issue) => issue.key.startsWith('task-lost')))
  assert.ok(result.repairs.length > 0)
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'lost')
  const pending = ctx.store.pendingTriggers()
  assert.ok(pending.some((trigger) => trigger.kind === 'worker-report'))
  ctx.runtime.stop()
})

test('watchdog stays silent when nothing is wrong', async () => {
  const ctx = setupRuntime()
  const result = ctx.runtime.checkNow()
  assert.equal(result.issues.length, 0)
  assert.equal(result.repairs.length, 0)
  assert.equal(ctx.router.messages.length, 0)
  ctx.runtime.stop()
})

test('reply enforces channel word limits and writes the outbox', () => {
  const ctx = setupRuntime()
  assert.throws(
    () => ctx.runtime.reply({ channel: 'im', text: Array.from({ length: 101 }, (_, i) => `w${i}`).join(' ') }),
    (error) => error instanceof RuntimeInputError && error.code === 'too_long',
  )
  const ok = ctx.runtime.reply({ channel: 'im', text: 'Fixed login; verified in Safari.', taskId: 'tsk_1' })
  assert.equal(ok.status, 'queued')
  assert.equal(ok.words, 5)
  const lines = readFileSync(join(ctx.dataDir, 'outbox.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(JSON.parse(lines[0]).text, /Fixed login/)
  ctx.runtime.stop()
})

test('redaction happens before trigger storage', () => {
  const ctx = setupRuntime()
  const result = ctx.runtime.ingest({
    source: 'github',
    threadKey: 'pr:1',
    actor: 'alice',
    text: 'token is sk-abcdefghijklmnopqrstuvwx please rotate',
  })
  const trigger = ctx.store.getTrigger(result.id)
  assert.doesNotMatch(trigger.text, /sk-abcdefghijklmnopqrstuvwx/)
  assert.match(trigger.text, /\[redacted\]/)
  ctx.runtime.stop()
})

test('inbox polling consumes appended events once and advances the cursor', () => {
  const ctx = setupRuntime()
  const path = join(ctx.dataDir, 'inbox.jsonl')
  appendFileSync(path, `${JSON.stringify({
    v: 1,
    id: 'evt_1',
    source: 'im',
    threadKey: 'team:dev',
    actor: 'alice',
    text: '@super-agent from the CLI',
  })}\n`)
  assert.equal(ctx.runtime.pollInbox(), 1)
  assert.equal(ctx.runtime.pollInbox(), 0)
  assert.equal(ctx.store.pendingTriggers().length, 1)
  assert.ok(readFileSync(join(ctx.dataDir, 'cursor.json'), 'utf8').includes('offset'))
  ctx.runtime.stop()
})

test('startup recovery marks open tasks interrupted and reports once', async () => {
  const project = fakeProject()
  const first = setupRuntime({ project })
  const tid = threadId('im', 'team:dev')
  const dispatched = first.runtime.dispatch({ title: 'Survives restart', brief: 'Work', threadIds: [tid] })
  await tick()
  first.runtime.stop()
  first.store.close()

  const store = new Store({ dir: project.dataDir })
  store.open()
  const second = setupRuntime({ project, store, router: fakeRouter(project.root), children: new Map() })
  const task = second.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'interrupted')
  assert.ok(task.recoveryNotifiedAt !== undefined)
  assert.ok(second.store.pendingTriggers().some((trigger) => trigger.kind === 'worker-report'))
  assert.match(second.store.pendingTriggers()[0].text, /Host restarted/)
  second.runtime.stop()
  second.store.close()
})

test('speculative tasks are marked and carry the no-irreversible-action rule', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({
    title: 'Probe Safari layout',
    brief: 'Investigate whether this is a CSS bug and prepare a minimal fix',
    speculative: true,
  })
  await tick()
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.speculative, true)
  const prompt = ctx.subagents.spawns[0].spec.request.prompt[0].text
  assert.match(prompt, /speculative run/)
  assert.match(prompt, /irreversible external actions/)

  const child = [...ctx.children.values()][0]
  child.finishTurn({ text: 'Found a likely Safari flex-basis issue; prepared a one-line fix.', turn: 1 })
  const pending = ctx.store.pendingTriggers()
  assert.equal(pending[0].title, 'Speculative report: Probe Safari layout')
  assert.match(pending[0].summary, /^\[speculative\]/)
  ctx.runtime.stop()
})

test('root-scope session observation also produces a report', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'Root observe', brief: 'Work' })
  await tick()
  const child = [...ctx.children.values()][0]
  ctx.runtime.observeSessionEvent(child.session, {
    type: 'assistant/message',
    message: { content: [{ type: 'text', text: 'observed via root scope' }] },
  })
  ctx.runtime.observeSessionEvent(child.session, { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'idle')
  assert.match(task.lastReport.text, /observed via root scope/)
  assert.equal(task.lastReportTurn, 3)
  ctx.runtime.stop()
})

test('DSH-shaped session events ({type,data}) are normalized', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'DSH shape', brief: 'Work' })
  await tick()
  const child = [...ctx.children.values()][0]
  ctx.runtime.observeSessionEvent(child.session, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 2, message: { content: [{ type: 'text', text: 'wrapped report' }] } },
  })
  ctx.runtime.observeSessionEvent(child.session, {
    type: 'turn/end',
    seq: 2,
    time: Date.now(),
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'idle')
  assert.equal(task.lastReport.reason, 'completed')
  assert.match(task.lastReport.text, /wrapped report/)
  assert.equal(task.lastReportTurn, 2)
  ctx.runtime.stop()
})

test('a late activation cannot resurrect a task closed during startup', async () => {
  const project = fakeProject()
  const gate = Promise.withResolvers()
  let activation
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: {} }),
    startActivation(spec) {
      const child = fakeChild(spec.childId)
      const result = Promise.withResolvers()
      activation = {
        childId: child.id,
        messageId: 'msg-1',
        result: result.promise,
        disposed: false,
        spec,
        async dispose() {
          activation.disposed = true
          child.dispose()
          result.resolve({ stopOutput: [], stopReason: 'completed' })
        },
      }
      return gate.promise
    },
  }
  const ctx = setupRuntime({ project, subagents })
  const dispatched = ctx.runtime.dispatch({ title: 'Slow start', brief: 'Work' })
  await tick()
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'starting')
  ctx.runtime.close({ taskId: dispatched.taskId, reason: 'cancel during startup' })
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'closed')
  gate.resolve(activation)
  await tick()
  assert.equal(activation.disposed, true)
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'closed')
  ctx.runtime.stop()
})

test('restart does not re-notify an already reported idle task', async () => {
  const project = fakeProject()
  const first = setupRuntime({ project })
  const dispatched = first.runtime.dispatch({ title: 'Already done', brief: 'Work' })
  await tick()
  const child = [...first.children.values()][0]
  child.finishTurn({ text: 'done', turn: 1 })
  assert.equal(first.store.getTask(dispatched.taskId).status, 'idle')
  const pendingBefore = first.store.pendingTriggers().length
  first.runtime.stop()
  first.store.close()

  const store = new Store({ dir: project.dataDir })
  store.open()
  const second = setupRuntime({ project, store, router: fakeRouter(project.root), children: new Map() })
  const task = second.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'idle')
  assert.equal(task.recoveryNotifiedAt, undefined)
  assert.equal(second.store.pendingTriggers().length, pendingBefore)
  assert.ok(!second.store.pendingTriggers().some((trigger) => trigger.text.includes('Host restarted')))
  second.runtime.stop()
  second.store.close()
})

test('watchdog leaves an idle task alone when its worker session is gone', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'Idle and gone', brief: 'Work' })
  await tick()
  const child = [...ctx.children.values()][0]
  child.finishTurn({ text: 'done', turn: 1 })
  ctx.children.delete(child.id)
  const result = ctx.runtime.checkNow()
  assert.equal(result.issues.length, 0)
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'idle')
  ctx.runtime.stop()
})

test('inbox polling does not corrupt a multi-byte character split across reads', () => {
  const ctx = setupRuntime()
  const line = `${JSON.stringify({
    id: 'evt_split_1',
    source: 'im',
    threadKey: 'team:i18n',
    actor: 'alice',
    text: '@super-agent 登录页白屏',
    mentions: ['super-agent'],
  })}\n`
  const bytes = Buffer.from(line, 'utf8')
  const char = Buffer.from('登', 'utf8')
  const cut = bytes.indexOf(char) + 1
  appendFileSync(ctx.store.paths.inbox, bytes.subarray(0, cut))
  assert.equal(ctx.runtime.pollInbox(), 0)
  appendFileSync(ctx.store.paths.inbox, bytes.subarray(cut))
  assert.equal(ctx.runtime.pollInbox(), 1)
  const trigger = ctx.store.recentTriggers(1)[0]
  assert.equal(trigger.text, '@super-agent 登录页白屏')
  ctx.runtime.stop()
})

test('steering a closed task is rejected', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'Closed', brief: 'Work' })
  await tick()
  ctx.runtime.close({ taskId: dispatched.taskId, reason: 'done' })
  assert.throws(
    () => ctx.runtime.steer(dispatched.taskId, 'more'),
    (error) => error instanceof RuntimeInputError && /closed/.test(error.message),
  )
  ctx.runtime.stop()
})

test('an event on a subscribed thread during startup does not kill the starting task', async () => {
  const project = fakeProject()
  const gate = Promise.withResolvers()
  let activation
  const subagents = {
    getProvider: () => ({ name: 'spawn', capabilities: {} }),
    startActivation(spec) {
      const child = fakeChild(spec.childId)
      const result = Promise.withResolvers()
      activation = {
        childId: child.id,
        messageId: 'msg-1',
        result: result.promise,
        disposed: false,
        spec,
        async dispose() {
          activation.disposed = true
          child.dispose()
          result.resolve({ stopOutput: [], stopReason: 'completed' })
        },
      }
      return gate.promise
    },
  }
  const ctx = setupRuntime({ project, subagents })
  const tid = threadId('im', 'team:startup')
  const dispatched = ctx.runtime.dispatch({ title: 'Slow start', brief: 'Work', threadIds: [tid] })
  await tick()
  const ingested = ctx.runtime.ingest({
    source: 'im', threadKey: 'team:startup', actor: 'alice', text: '@super-agent more info', mentions: ['super-agent'],
  })
  assert.equal(ingested.direct, false)
  assert.equal(ingested.state, 'pending')
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'starting')
  gate.resolve(activation)
  await tick()
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'working')
  assert.equal(ctx.store.getTask(dispatched.taskId).status === 'lost', false)
  ctx.runtime.stop()
})

test('cross-project dispatch uses an ordinary Session worker so the target project is writable', async () => {
  const ctx = setupRuntime()
  const outside = mkdtempSync(join(tmpdir(), 'dsh-super-agent-other-'))
  const dispatched = ctx.runtime.dispatch({ title: 'Cross project', brief: 'Write into the other project', cwd: outside })
  await tick()

  assert.equal(ctx.subagents.spawns.length, 0)
  assert.equal(ctx.sessionWorkers.calls.length, 1)
  const activation = ctx.sessionWorkers.calls[0]
  assert.equal(activation.spec.cwd, outside)
  assert.equal(activation.started, true)
  assert.match(activation.prompt, /Cross project/)
  assert.match(activation.prompt, /Write into the other project/)
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.status, 'working')
  assert.equal(task.workerSessionId, activation.childId)

  activation.agent.finishTurn({ text: 'cross-project report', reason: 'completed', turn: 1 })
  await tick()
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'idle')
  ctx.timers.runTimeouts()
  assert.match(messageText(ctx.router.messages.at(-1)), /cross-project report/)

  // Closing the task cancels the ordinary Session worker without deleting it.
  ctx.runtime.close({ taskId: dispatched.taskId, reason: 'done' })
  await tick()
  assert.equal(activation.disposed, true)
  ctx.runtime.stop()
})

test('project registry resolves titles and dispatch(project) targets that project', async () => {
  const local = fakeProject()
  const other = fakeProject()
  const ctx = setupRuntime({
    project: local,
    projects: () => [
      { id: 'p-local', title: 'Alpha', path: local.root },
      { id: 'p-other', title: 'Beta', path: other.root },
      { id: 'p-other-duplicate', title: 'Beta', path: local.root },
    ],
  })
  assert.deepEqual(ctx.runtime.listProjects().map((project) => project.title), ['Alpha', 'Beta'])
  const dispatched = ctx.runtime.dispatch({
    title: 'Autonomous target',
    brief: 'Use the Beta project selected by the Router',
    project: 'beta',
  })
  await tick()
  assert.equal(ctx.store.getTask(dispatched.taskId).project, 'Beta')
  assert.equal(ctx.store.getTask(dispatched.taskId).cwd, other.root)
  assert.equal(ctx.sessionWorkers.calls.length, 1)
  assert.equal(ctx.sessionWorkers.calls[0].spec.cwd, other.root)
  ctx.runtime.close({ taskId: dispatched.taskId, reason: 'done' })
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'Unknown', brief: 'Unknown project', project: 'nope' }),
    (error) => error instanceof RuntimeInputError && /no project matched/.test(error.message),
  )
  ctx.runtime.stop()
})

test('same-project dispatch keeps the isolated subagent path', async () => {
  const ctx = setupRuntime()
  const dispatched = ctx.runtime.dispatch({ title: 'Local task', brief: 'Stay in this project' })
  await tick()
  assert.equal(ctx.sessionWorkers.calls.length, 0)
  assert.equal(ctx.subagents.spawns.length, 1)
  assert.equal(ctx.store.getTask(dispatched.taskId).status, 'working')
  ctx.runtime.stop()
})

test('dispatch without cwd uses the UI focus project, including a cross-project session worker', async () => {
  const ctx = setupRuntime()
  const outside = mkdtempSync(join(tmpdir(), 'dsh-super-agent-focus-'))
  ctx.runtime.setFocusProject(outside)
  assert.equal(ctx.runtime.status('compact').focusProject, outside)
  const dispatched = ctx.runtime.dispatch({ title: 'Focused task', brief: 'Work in the selected project' })
  await tick()
  assert.equal(ctx.sessionWorkers.calls.length, 1)
  assert.equal(ctx.sessionWorkers.calls[0].spec.cwd, outside)
  assert.equal(ctx.store.getTask(dispatched.taskId).cwd, outside)
  ctx.runtime.stop()
})

test('focus project validation rejects missing directories and clears explicitly', () => {
  const ctx = setupRuntime()
  assert.throws(() => ctx.runtime.setFocusProject('relative/path'), /absolute path/)
  assert.throws(() => ctx.runtime.setFocusProject(join(ctx.root, 'does-not-exist')), /not a directory/)
  ctx.runtime.setFocusProject(ctx.root)
  assert.equal(ctx.runtime.status('compact').focusProject, ctx.root)
  ctx.runtime.setFocusProject(null)
  assert.equal(ctx.runtime.status('compact').focusProject, undefined)
  ctx.runtime.stop()
})
