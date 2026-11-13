/**
 * schedule-bridge.test.mjs — 两代宿主 `ctx.schedule` 契约的适配。
 *
 * 0.2.1 及更早按会话：create(sessionId, request) / list({sessionId}) /
 * delete({sessionId, id})；0.2.2 起改成宿主级：create({title, prompt, timing,
 * target}, actorSessionId) / list 分页 / edit 删除。桥把两代整理成 runtime 认的
 * 扁平记录；这里直接断言线上形状，避免插件“测试绿、真宿主失败”。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createScheduleBridge, scheduleBelongsTo, scheduleTiming } from '../lib/schedule-bridge.js'
import { fakeLegacySchedule, fakeSchedule } from './fake-host.mjs'

test('scheduleTiming maps every flat selector to the 0.2.2 typed timing', () => {
  assert.deepEqual(scheduleTiming({ after_seconds: 120 }), { kind: 'after', after_seconds: 120 })
  assert.deepEqual(scheduleTiming({ at: '2026-11-06T09:00:00.000Z' }), { kind: 'at', at: '2026-11-06T09:00:00.000Z' })
  assert.deepEqual(scheduleTiming({ every_seconds: 600 }), { kind: 'every', every_seconds: 600 })
  const daily = { time: '09:00:00', time_zone: 'UTC' }
  assert.deepEqual(scheduleTiming({ daily }), { kind: 'daily', daily })
  const weekly = { time: '09:00:00', weekdays: [1, 3], time_zone: 'UTC' }
  assert.deepEqual(scheduleTiming({ weekly }), { kind: 'weekly', weekly })
  const cron = { expression: '*/15 * * * *', time_zone: 'UTC' }
  assert.deepEqual(scheduleTiming({ cron }), { kind: 'cron', cron })
  assert.throws(() => scheduleTiming({}), /one timing selector/)
})

test('scheduleBelongsTo matches the delivery target and the involved sessions', () => {
  assert.equal(scheduleBelongsTo({ target: { kind: 'session', sessionId: 's1' } }, 's1'), true)
  assert.equal(scheduleBelongsTo({ target: { kind: 'session', sessionId: 's2' } }, 's1'), false)
  assert.equal(scheduleBelongsTo({ target: { kind: 'new' }, involvedSessionIds: ['s1'] }, 's1'), true)
  assert.equal(scheduleBelongsTo({ target: { kind: 'new_once', sessionId: 'reserved' }, involvedSessionIds: ['s1'] }, 's1'), true)
  assert.equal(scheduleBelongsTo({ target: { kind: 'new' }, involvedSessionIds: [] }, 's1'), false)
  assert.equal(scheduleBelongsTo({ target: { kind: 'session', sessionId: 's1' } }, ''), false)
})

test('the bridge speaks the 0.2.2 host-wide API', async () => {
  const service = fakeSchedule()
  const bridge = createScheduleBridge(() => service)
  assert.equal(bridge.available, true)
  const created = await bridge.create('session-router', {
    title: 'Daily',
    prompt: 'Review.',
    daily: { time: '09:00:00', time_zone: 'UTC' },
  })
  assert.match(created.id, /^sched_/)
  assert.deepEqual(service.calls.create[0], {
    request: {
      title: 'Daily',
      prompt: 'Review.',
      timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } },
      target: { kind: 'session', sessionId: 'session-router' },
    },
    actorSessionId: 'session-router',
  })

  const listed = await bridge.list('session-router')
  assert.deepEqual(listed.map((row) => row.id), [created.id])
  // 别的会话看不到这条任务。
  assert.deepEqual(await bridge.list('session-other'), [])

  const canceled = await bridge.cancel('session-router', created.id)
  assert.deepEqual(canceled, { id: created.id, deleted: true })
  assert.deepEqual(service.calls.edit[0], {
    request: { id: created.id, action: 'delete' },
    actorSessionId: 'session-router',
  })
  assert.deepEqual(await bridge.list('session-router'), [])
})

test('the bridge hides paused host tasks and lists tasks that target the session', async () => {
  const service = fakeSchedule()
  const bridge = createScheduleBridge(() => service)
  const paused = await service.create(
    { title: 'Paused', prompt: 'x', timing: { kind: 'every', every_seconds: 600 }, target: { kind: 'session', sessionId: 'session-router' } },
    'session-router',
  )
  service.records.get(paused.id).status = 'paused'
  const delivered = await service.create(
    { title: 'Elsewhere', prompt: 'y', timing: { kind: 'every', every_seconds: 600 }, target: { kind: 'session', sessionId: 'session-router' } },
    'session-other',
  )
  const listed = await bridge.list('session-router')
  assert.deepEqual(listed.map((row) => row.id), [delivered.id])
})

test('the bridge keeps the 0.2.1 per-session API working', async () => {
  const service = fakeLegacySchedule()
  const bridge = createScheduleBridge(() => service)
  const created = await bridge.create('session-router', { title: 'Legacy', prompt: 'Work.', every_seconds: 600 })
  assert.match(created.id, /^sched_/)
  assert.equal(service.records.get(created.id).sessionId, 'session-router')
  assert.equal((await bridge.list('session-router')).length, 1)
  assert.deepEqual(await bridge.cancel('session-router', created.id), { id: created.id, deleted: true })
  assert.equal((await bridge.list('session-router')).length, 0)
})

test('a missing schedule service lists nothing and rejects mutations', async () => {
  const bridge = createScheduleBridge(() => undefined)
  assert.equal(bridge.available, false)
  assert.deepEqual(await bridge.list('session'), [])
  await assert.rejects(() => bridge.create('session', { title: 'x', prompt: 'y', after_seconds: 60 }), /unavailable/)
  await assert.rejects(() => bridge.cancel('session', 'sched_1'), /unavailable/)
})
