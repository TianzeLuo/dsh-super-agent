/**
 * recovery.test.mjs — 重启后任务与 Worker 会话的持久化、恢复与续做。
 *
 * 「重启」用真的重建 runtime 来模拟：task 只在 journal 里，Worker 会话只在宿主
 * 的磁盘上。假宿主提供 `resumeWorker` 桥来模拟 DSH 的 `sessionController.resolveAgent`，
 * 所以这里能确定性地验证「会话能救回来 → resumable / 救不回来 → interrupted」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { threadId } from '../lib/ids.js'
import { Store } from '../lib/store.js'
import {
  INTERRUPTED,
  RESUMABLE,
  interruptedPatch,
  isRunningState,
  planRecovery,
  recoveryText,
  resumedPatch,
} from '../lib/recovery.js'
import { fakeChild, fakeProject, fakeRouter, setupRuntime, tick } from './fake-host.mjs'

const NOW = 1_700_000_000_000

/** 让 start() 里发起的异步恢复跑完。 */
async function settle() {
  for (let index = 0; index < 4; index += 1) await tick()
}

/** 重建一个 runtime，等价于进程重启：内存里的 Worker 全都没了。 */
function restart(project, options = {}) {
  const store = new Store({ dir: project.dataDir })
  store.open()
  return setupRuntime({ project, store, router: fakeRouter(project.root), ...options })
}

// ── 纯逻辑 ────────────────────────────────────────────────────────────────

test('planRecovery decides attach, resume or interrupted from task state', () => {
  const task = (patch) => ({ id: 'tsk_1', title: 'T', status: 'working', workerSessionId: 'session-1', ...patch })
  assert.equal(planRecovery(undefined, {}), 'skip')
  assert.equal(planRecovery(task({ status: 'closed' }), { live: false, canResume: true }), 'skip')
  assert.equal(planRecovery(task({ status: 'queued' }), { live: false, canResume: true }), 'skip')
  assert.equal(planRecovery(task({ workerSessionId: undefined }), { live: false, canResume: true }), 'skip')
  // 宿主已经有这条会话（runtime 自己重启的情况）：直接挂监听。
  assert.equal(planRecovery(task({}), { live: true, canResume: false }), 'attach')
  // 重启：会话在磁盘上，交给宿主救回来。
  assert.equal(planRecovery(task({}), { live: false, canResume: true }), 'resume')
  assert.equal(planRecovery(task({ status: 'idle' }), { live: false, canResume: true }), 'resume')
  assert.equal(planRecovery(task({ status: 'blocked' }), { live: false, canResume: true }), 'resume')
  // 宿主没有恢复能力：只有「本该在跑」的判中断，空闲任务保持原样。
  assert.equal(planRecovery(task({}), { live: false, canResume: false }), 'interrupted')
  assert.equal(planRecovery(task({ status: 'idle' }), { live: false, canResume: false }), 'skip')
  // 已经判过中断、也提醒过的任务不再反复重试。
  assert.equal(planRecovery(task({ status: 'interrupted' }), { live: false, canResume: true }), 'skip')
  assert.equal(planRecovery(task({ status: 'lost' }), { live: false, canResume: true }), 'skip')
})

test('resumedPatch only rewrites tasks that were supposed to be running', () => {
  assert.equal(isRunningState('working'), true)
  assert.equal(isRunningState('idle'), false)
  const working = resumedPatch({ status: 'working' }, NOW)
  assert.equal(working.status, RESUMABLE)
  assert.equal(working.resumedAt, NOW)
  assert.equal('interruptedAt' in working, false)
  const idle = resumedPatch({ status: 'idle' }, NOW)
  assert.equal(idle.status, 'idle')
  assert.equal(idle.resumedAt, NOW)
  const interrupted = interruptedPatch(NOW)
  assert.equal(interrupted.status, INTERRUPTED)
  assert.equal(interrupted.interruptedAt, NOW)
  assert.equal(interrupted.recoveryNotifiedAt, NOW)
})

test('recovery text says what the router can actually do', () => {
  const resumed = recoveryText('resumed', { title: 'Persist tasks' })
  assert.match(resumed, /Host restarted/)
  assert.match(resumed, /reuse_task_id/)
  assert.match(resumed, /half-finished turn is never replayed/)
  const interrupted = recoveryText('interrupted', { title: 'Persist tasks' })
  assert.match(interrupted, /Host restarted/)
  assert.match(interrupted, /could not be resumed/)
  assert.match(interrupted, /original brief/)
})

// ── 重启：任务注册表读回 ──────────────────────────────────────────────────

test('tasks survive a restart and each gets a recovery state', async () => {
  const project = fakeProject()
  const first = setupRuntime({ project })
  const tid = threadId('im', 'team:dev')
  const kept = first.runtime.dispatch({ title: 'Revive me', brief: 'Keep the context', threadIds: [tid] })
  const gone = first.runtime.dispatch({ title: 'Session is gone', brief: 'Start again from the brief' })
  const idle = first.runtime.dispatch({ title: 'Was blocked', brief: 'Waiting on a decision' })
  await settle()
  const blocked = [...first.children.values()].at(-1)
  blocked.finishTurn({ text: 'need input', reason: 'blocked', turn: 1 })
  assert.equal(first.store.getTask(idle.taskId).status, 'blocked')
  first.runtime.close({ taskId: idle.taskId, reason: 'not part of this restart' })
  const closed = first.store.getTask(idle.taskId)
  assert.equal(closed.status, 'closed')
  first.runtime.stop()
  first.store.close()

  // 进程重启：内存里的 Agent 全没了，只有磁盘上的会话。
  const children = new Map()
  const revivedIds = []
  const second = restart(project, {
    children,
    resumeWorker: async (sessionId) => {
      // 只有第一条任务对应的会话还能救回来。
      if (sessionId !== first.store.getTask(kept.taskId).workerSessionId) return undefined
      const child = fakeChild(sessionId)
      children.set(sessionId, child)
      revivedIds.push(sessionId)
      return child
    },
  })
  await settle()

  const keptAfter = second.store.getTask(kept.taskId)
  assert.equal(keptAfter.status, RESUMABLE)
  assert.equal(keptAfter.workerSessionId, first.store.getTask(kept.taskId).workerSessionId)
  assert.equal(revivedIds.length, 1)
  assert.equal(children.get(keptAfter.workerSessionId).id, keptAfter.workerSessionId)

  const goneAfter = second.store.getTask(gone.taskId)
  assert.equal(goneAfter.status, INTERRUPTED)
  assert.ok(goneAfter.recoveryNotifiedAt !== undefined)
  assert.match(goneAfter.brief, /Start again from the brief/)
  // closed 不复活，也不产生新的提醒。
  assert.equal(second.store.getTask(idle.taskId).status, 'closed')
  assert.equal(second.store.stats().tasks.resumable, 1)
  assert.equal(second.store.stats().tasks.interrupted, 1)

  const texts = second.store.pendingTriggers().map((trigger) => trigger.text).join('\n')
  assert.match(texts, /was resumed and is idle now/)
  assert.match(texts, /could not be resumed/)

  // Router 要能直接从 status 拿到「怎么继续」：状态 + 原 brief。
  const full = second.runtime.status('full')
  const goneRow = full.tasks.find((row) => row.id === gone.taskId)
  assert.equal(goneRow.status, INTERRUPTED)
  assert.match(goneRow.brief, /Start again from the brief/)
  const keptRow = full.tasks.find((row) => row.id === kept.taskId)
  assert.equal(keptRow.status, RESUMABLE)
  assert.equal(keptRow.workerSessionId, keptAfter.workerSessionId)
  assert.ok(keptRow.resumedAt !== undefined)
  // compact 视图不塞 brief（避免每轮状态查询都带一堆长文本）。
  const compactRow = second.runtime.status('compact').tasks.find((row) => row.id === gone.taskId)
  assert.equal(compactRow.brief, undefined)

  second.runtime.stop()
  second.store.close()
})

test('a second restart of a resumable task resumes it again without re-notifying', async () => {
  const project = fakeProject()
  const first = setupRuntime({ project })
  const dispatched = first.runtime.dispatch({ title: 'Still resumable', brief: 'Keep going' })
  await settle()
  const sessionId = first.store.getTask(dispatched.taskId).workerSessionId
  first.runtime.stop()
  first.store.close()

  const revive = (children) => async (id) => {
    if (id !== sessionId) return undefined
    const child = fakeChild(id)
    children.set(id, child)
    return child
  }
  const secondChildren = new Map()
  const second = restart(project, { children: secondChildren, resumeWorker: revive(secondChildren) })
  await settle()
  assert.equal(second.store.getTask(dispatched.taskId).status, RESUMABLE)
  const resumedReports = (store) => store.pendingTriggers().filter((trigger) => /was resumed and is idle now/.test(trigger.text)).length
  assert.equal(resumedReports(second.store), 1)
  second.runtime.stop()
  second.store.close()

  const thirdChildren = new Map()
  const third = restart(project, { children: thirdChildren, resumeWorker: revive(thirdChildren) })
  await settle()
  assert.equal(third.store.getTask(dispatched.taskId).status, RESUMABLE)
  assert.equal(third.store.getTask(dispatched.taskId).recoveryNotifiedAt, undefined)
  // 上一次重启的提醒还留在 pending 里（没被投递），但这次重启不再追加新的。
  assert.equal(resumedReports(third.store), 1)
  third.runtime.stop()
  third.store.close()
})

test('reuse_task_id on an interrupted task starts a fresh worker from the original brief', async () => {
  const project = fakeProject()
  const first = setupRuntime({ project })
  const tid = threadId('im', 'team:dev')
  const source = first.runtime.dispatch({ title: 'Long job', brief: 'Original brief', threadIds: [tid] })
  await settle()
  const sourceTask = first.store.getTask(source.taskId)
  const objective = await first.runtime.createObjective({ objective: 'Ship the migration' })
  first.store.append({ t: 'objective.updated', objectiveId: objective.objective.id, patch: { taskIds: [source.taskId] } })
  first.store.append({ t: 'task.updated', taskId: source.taskId, patch: { objectiveId: objective.objective.id } })
  first.runtime.stop()
  first.store.close()

  const second = restart(project, { children: new Map() })
  await settle()
  assert.equal(second.store.getTask(source.taskId).status, INTERRUPTED)

  const continued = second.runtime.dispatch({
    title: 'Long job (retry)',
    brief: 'Original brief, second attempt',
    reuseTaskId: source.taskId,
  })
  assert.equal(continued.resumedFrom, source.taskId)
  assert.equal(continued.continuedFrom, undefined)
  assert.equal(continued.workerSessionId, undefined)
  assert.match(continued.note, /fresh Worker/)
  assert.equal(continued.cwd, sourceTask.cwd)
  // 线程、目标、模型都从源任务继承，目标链不会悄悄断掉。
  assert.deepEqual(continued.threadIds, [tid])
  const created = second.store.getTask(continued.taskId)
  assert.equal(created.objectiveId, objective.objective.id)
  assert.equal(created.modelId, sourceTask.modelId)
  assert.deepEqual(created.threadIds, [tid])

  await settle()
  const running = second.store.getTask(continued.taskId)
  assert.equal(running.status, 'working')
  // 起的是**新** Worker：旧会话 id 没被假装复用。
  assert.notEqual(running.workerSessionId, sourceTask.workerSessionId)
  assert.equal(second.subagents.spawns.length, 1)
  second.runtime.stop()
  second.store.close()
})

test('reuse_task_id on a resumable task continues in the same worker session', async () => {
  const project = fakeProject()
  const first = setupRuntime({ project })
  const source = first.runtime.dispatch({ title: 'First half', brief: 'Do the first half' })
  await settle()
  const sessionId = first.store.getTask(source.taskId).workerSessionId
  await settle()
  const child = first.children.get(sessionId)
  child.finishTurn({ text: 'first half done', turn: 1 })
  assert.equal(first.store.getTask(source.taskId).status, 'idle')
  first.runtime.stop()
  first.store.close()

  const children = new Map()
  const revived = fakeChild(sessionId)
  children.set(sessionId, revived)
  const second = restart(project, {
    children,
    resumeWorker: async (id) => children.get(id),
  })
  await settle()
  assert.equal(second.store.getTask(source.taskId).status, 'idle')

  const continued = second.runtime.dispatch({
    title: 'Second half',
    brief: 'Continue with the second half',
    reuseTaskId: source.taskId,
  })
  assert.equal(continued.continuedFrom, source.taskId)
  assert.equal(continued.workerSessionId, sessionId)
  assert.equal(continued.resumedFrom, undefined)
  await settle()
  const running = second.store.getTask(continued.taskId)
  assert.equal(running.status, 'working')
  assert.equal(revived.messages.length, 1)
  assert.match(revived.messages[0].content[0].text, /Continue with the second half/)
  second.runtime.stop()
  second.store.close()
})

test('reuse_task_id still refuses a task that is actively running', async () => {
  const ctx = setupRuntime()
  const source = ctx.runtime.dispatch({ title: 'Busy', brief: 'Work' })
  await settle()
  assert.equal(ctx.store.getTask(source.taskId).status, 'working')
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'Again', brief: 'Work', reuseTaskId: source.taskId }),
    (error) => error.code === 'busy',
  )
  ctx.runtime.stop()
})

// ── 旧 journal ────────────────────────────────────────────────────────────

test('a journal written by an older version still loads and recovers', async () => {
  const project = fakeProject()
  const journal = join(project.dataDir, 'journal.jsonl')
  // 旧版本：没有 resumable/resumedFrom/interruptedAt/objectiveId 这些字段。
  const legacy = [
    { t: 'task.created', at: NOW - 5_000, task: { id: 'tsk_legacy', title: 'Old task', brief: 'Old brief', cwd: project.root, status: 'working', threadIds: [], workerSessionId: 'session-legacy' } },
    { t: 'task.created', at: NOW - 4_000, task: { id: 'tsk_done', title: 'Closed long ago', brief: 'Old brief', cwd: project.root, status: 'closed', threadIds: [] } },
    { t: 'task.reported', at: NOW - 3_000, taskId: 'tsk_legacy', report: { id: 'rep_1', reason: 'completed', text: 'done' } },
  ]
  appendFileSync(journal, `${legacy.map((record) => JSON.stringify(record)).join('\n')}\n`)

  const store = new Store({ dir: project.dataDir })
  store.open()
  assert.equal(store.getTask('tsk_legacy').status, 'idle')
  assert.equal(store.getTask('tsk_legacy').resumedFrom, undefined)
  assert.equal(store.getTask('tsk_legacy').interruptedAt, undefined)
  assert.equal(store.stats().tasks.resumable, 0)

  const runtime = setupRuntime({ project, store, router: fakeRouter(project.root), children: new Map() })
  await settle()
  // 空闲任务在「宿主没有恢复能力」时不被打成 interrupted。
  assert.equal(store.getTask('tsk_legacy').status, 'idle')
  runtime.runtime.stop()
  store.close()
})
