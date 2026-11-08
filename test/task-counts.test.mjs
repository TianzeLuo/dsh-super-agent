/**
 * task-counts.test.mjs — 任务计数的口径（lost/interrupted 不算进行中）。
 *
 * 统计出口有四个：`store.stats()`（status 工具/HTTP、CLI、面板徽标共用）、
 * `renderStatus`（状态摘要）、`routerContext`（Router 提示词）和浏览器徽标。
 * 这里先断言派生函数本身，再逐个出口断言同一口径，避免各处各算一次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientBundle } from './client-bundle.mjs'
import { routerContext } from '../lib/prompt.js'
import { renderStatus } from '../lib/render.js'
import { ACTIVE_TASK_STATUSES, deriveTaskCounts, isActiveTaskStatus } from '../lib/task-counts.js'
import { fakeProject, setupRuntime, tick } from './fake-host.mjs'

/** 直接写一条任务事实。 */
function createTask(store, id, status, title = id) {
  store.append({
    t: 'task.created',
    task: {
      id,
      title,
      brief: 'brief',
      cwd: '/tmp/project',
      status,
      threadIds: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  })
}

test('deriveTaskCounts keeps lost/interrupted out of the active count', () => {
  const counts = deriveTaskCounts([
    { status: 'lost' },
    { status: 'working' },
    { status: 'working' },
    { status: 'idle' },
    { status: 'idle' },
    { status: 'queued' },
    { status: 'interrupted' },
  ])
  assert.equal(counts.lost, 1)
  assert.equal(counts.interrupted, 1)
  assert.equal(counts.idle, 2)
  assert.equal(counts.queued, 1)
  assert.equal(counts.active, 3, 'working + working + queued；lost/interrupted/idle 都不算')
  assert.equal(counts.active, ACTIVE_TASK_STATUSES.filter((status) => counts[status] > 0)
    .reduce((sum, status) => sum + counts[status], 0))
})

test('deriveTaskCounts reports lost separately when only lost tasks exist', () => {
  const counts = deriveTaskCounts([{ status: 'lost' }, { status: 'lost' }])
  assert.equal(counts.active, 0, 'lost 不是进行中')
  assert.equal(counts.lost, 2)
  assert.equal(isActiveTaskStatus('lost'), false)
  assert.equal(isActiveTaskStatus('interrupted'), false)
  assert.equal(isActiveTaskStatus('working'), true)
  assert.equal(deriveTaskCounts([]).active, 0)
})

test('status, renderStatus and the router prompt all read the same active/lost counts', async () => {
  const ctx = setupRuntime()
  createTask(ctx.store, 'tsk_lost000001', 'lost', 'Stale worker')
  createTask(ctx.store, 'tsk_idle000001', 'idle', 'Done already')
  const first = ctx.runtime.dispatch({ title: 'Running task', brief: 'Do the work end to end' })
  await tick()
  assert.equal(ctx.store.getTask(first.taskId).status, 'working')

  const counts = ctx.store.stats().tasks
  assert.equal(counts.active, 1, '只有 working 算进行中')
  assert.equal(counts.lost, 1, 'lost 单独计数')
  assert.equal(counts.idle, 1)

  const snapshot = ctx.runtime.status('compact')
  assert.equal(snapshot.counts.tasks.active, 1)
  assert.equal(snapshot.counts.tasks.lost, 1)

  const rendered = renderStatus(snapshot, 'compact')
  assert.match(rendered, /1 active/)
  assert.match(rendered, /1 lost/)
  assert.match(rendered, /Active tasks:/)
  const activeBlock = rendered.split('Active tasks:')[1].split('Lost/interrupted')[0]
  assert.doesNotMatch(activeBlock, /tsk_lost000001/, 'lost 任务不进 Active tasks 列表')
  assert.match(rendered, /Lost\/interrupted \(not running\): tsk_lost000001\[lost\]/)

  const prompt = routerContext(ctx.runtime)
  assert.match(prompt, /1 active task\(s\): tsk_/)
  assert.match(prompt, /1 lost task\(s\) not running/)
  ctx.runtime.stop()
})

test('panel badge count uses the server-derived active count', () => {
  const bundle = loadClientBundle()
  const summary = bundle.__internals.summarizeStatus({
    status: {
      router: { status: 'running', activeWorkers: 1, pendingTriggers: 0 },
      counts: { tasks: { working: 2, queued: 1, lost: 3, interrupted: 1, idle: 4, active: 3 } },
    },
  })
  assert.equal(summary.tasks, 3, 'lost/interrupted 不计入面板计数')
  assert.equal(summary.lost, 3)
})
