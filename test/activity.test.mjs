/**
 * activity.test.mjs — 近期活动的数据层排序、总数与游标分页。
 *
 * 这些断言保护三件容易被前端“顺手排序”破坏的事：
 *   1. 进行中永远排在已完成/已关闭之前；
 *   2. 同一时间戳用 id 倒序做稳定 tie-break，分页不跳行；
 *   3. 计数是总数，不是当前批次数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activityPage, activityGroup, compareActivity, sortActivity } from '../lib/activity.js'
import { Store } from '../lib/store.js'
import { fakeProject, setupRuntime } from './fake-host.mjs'

function task(id, status, at, extra = {}) {
  return {
    id,
    title: id,
    status,
    createdAt: at,
    updatedAt: at,
    ...extra,
  }
}

test('active tasks sort before completed ones even when completed are newer', () => {
  const rows = [
    task('done-new', 'idle', 9_000),
    task('working-old', 'working', 1_000),
    task('closed-new', 'closed', 10_000),
    task('approval-old', 'blocked-approval', 2_000),
    task('done-old', 'failed', 8_000),
    task('starting-old', 'starting', 3_000),
    task('queued-old', 'queued', 4_000),
  ]
  assert.deepEqual(sortActivity(rows).map((row) => row.id), [
    'queued-old',
    'starting-old',
    'approval-old',
    'working-old',
    'closed-new',
    'done-new',
    'done-old',
  ])
  assert.equal(activityGroup('queued'), 0)
  assert.equal(activityGroup('idle'), 1)
  assert.equal(activityGroup('closed'), 1)
})

test('same timestamp falls back to id descending so pages never swap rows', () => {
  const rows = [
    task('task-b', 'idle', 5_000),
    task('task-a', 'idle', 5_000),
    task('task-c', 'idle', 5_000),
  ]
  assert.deepEqual(sortActivity(rows).map((row) => row.id), ['task-c', 'task-b', 'task-a'])
  assert.equal(compareActivity(rows[1], rows[0]) > 0, true)
})

test('activityPage returns stable batches with a total and an opaque cursor', () => {
  const rows = []
  for (let index = 0; index < 5; index += 1) rows.push(task(`active-${index}`, 'working', 1_000 + index))
  for (let index = 0; index < 40; index += 1) rows.push(task(`done-${index}`, 'idle', 10_000 + index))

  const first = activityPage(rows, { limit: 20 })
  assert.equal(first.rows.length, 20)
  assert.equal(first.hasMore, true)
  assert.equal(first.rows[0].id, 'active-4')
  assert.equal(first.rows[4].id, 'active-0')
  assert.equal(typeof first.nextCursor, 'string')

  const second = activityPage(rows, { limit: 20, cursor: first.nextCursor })
  assert.equal(second.rows.length, 20)
  assert.equal(second.hasMore, true)

  const third = activityPage(rows, { limit: 20, cursor: second.nextCursor })
  assert.equal(third.rows.length, 5)
  assert.equal(third.hasMore, false)

  const seen = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id)
  assert.equal(new Set(seen).size, 45, 'batches must not duplicate or skip rows')
  assert.deepEqual(seen, sortActivity(rows).map((row) => row.id))
})

test('same-timestamp page boundary neither duplicates nor skips', () => {
  const rows = Array.from({ length: 10 }, (_, index) => task(`same-${String(index).padStart(2, '0')}`, 'closed', 7_000))
  const pages = []
  let cursor
  for (let page = 0; page < 4; page += 1) {
    const result = activityPage(rows, { limit: 3, cursor })
    pages.push(...result.rows)
    cursor = result.nextCursor
    if (!result.hasMore) break
  }
  assert.equal(pages.length, 10)
  assert.equal(new Set(pages.map((row) => row.id)).size, 10)
})

test('bad cursor falls back to the first page instead of throwing', () => {
  const rows = [task('a', 'idle', 1_000), task('b', 'idle', 2_000)]
  const result = activityPage(rows, { limit: 1, cursor: 'not-a-cursor' })
  assert.equal(result.rows[0].id, 'b')
  assert.equal(result.hasMore, true)
})

test('runtime exposes total plus cursor pages and puts active rows first', async () => {
  const project = fakeProject()
  let clock = 1_000
  const store = new Store({ dir: project.dataDir, now: () => clock })
  store.open()
  const definitions = [
    ['done-1', 'idle', 9_000],
    ['done-2', 'closed', 10_000],
    ['done-3', 'failed', 8_000],
    ['active-1', 'working', 1_000],
    ['active-2', 'starting', 2_000],
    ['active-3', 'blocked-approval', 3_000],
  ]
  for (const [id, status, updatedAt] of definitions) {
    clock = updatedAt
    store.append({
      t: 'task.created',
      task: { id, title: id, brief: 'brief', cwd: project.root, status, threadIds: [], createdAt: updatedAt, updatedAt },
    })
  }
  const ctx = setupRuntime({ project, store, config: { watchdog: { enabled: false } } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(ctx.runtime.activityTotal(), 6)
  assert.deepEqual(ctx.runtime.activity(2).map((row) => row.id), ['active-3', 'active-2'])
  const snapshot = ctx.runtime.status('compact')
  assert.equal(snapshot.activityTotal, 6)
  assert.equal(snapshot.activityHasMore, false, 'default snapshot page is 20 and all 6 fit')

  const first = ctx.runtime.activityPage({ limit: 2 })
  assert.equal(first.total, 6)
  assert.equal(first.activity.length, 2)
  assert.equal(first.hasMore, true)
  const second = ctx.runtime.activityPage({ limit: 2, cursor: first.nextCursor })
  assert.equal(second.activity.length, 2)
  assert.equal(second.hasMore, true)
  const third = ctx.runtime.activityPage({ limit: 2, cursor: second.nextCursor })
  assert.equal(third.activity.length, 2)
  assert.equal(third.hasMore, false)
  assert.equal(new Set([...first.activity, ...second.activity, ...third.activity].map((row) => row.id)).size, 6)
})
