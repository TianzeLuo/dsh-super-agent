/**
 * objectives.test.mjs — super-agent 原生目标（objective）机制。
 *
 * 三条验收线：
 *   1. 创建目标不在同一轮唤醒 Router（无 trigger、无 followup、无 0 延迟调度）；
 *   2. Worker 报告能推进挂在目标上的进度；
 *   3. 到点的检查（以及用户指令）能推进，且推进本身不制造新的唤醒。
 *
 * 另外覆盖纯函数（地址无关）：里程碑、节奏校验、下一次检查时间、宿主 goal 迁移。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  adoptHostGoal,
  appendMilestones,
  applyCheck,
  cadenceFromSelectors,
  completeMilestones,
  createObjectiveRecord,
  milestoneProgress,
  nextCheckAt,
  normalizeCheck,
  objectiveDue,
  objectiveSummaryLine,
  renderObjective,
  scheduleSelector,
  toObjectiveView,
} from '../lib/objectives.js'
import { Store } from '../lib/store.js'
import { setupRuntime, tick } from './fake-host.mjs'

const NOW = Date.parse('2026-11-05T10:00:00Z')

function journalEvents(dataDir) {
  const path = `${dataDir}/journal.jsonl`
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('a new objective has no wake-up and no scheduled check unless a cadence is given', () => {
  const record = createObjectiveRecord({
    id: 'obj_1',
    objective: 'Ship M2 of dsh-chatgpt-ui',
    milestones: ['M2a', 'M2b'],
    now: NOW,
  })
  assert.equal(record.status, 'active')
  assert.equal(record.cadence.kind, 'manual')
  assert.equal(record.nextCheckAt, undefined)
  assert.equal(record.checks.length, 0)
  assert.equal(record.taskIds.length, 0)
  assert.deepEqual(record.milestones.map((milestone) => milestone.id), ['ms_1', 'ms_2'])
  assert.equal(objectiveDue(record, NOW + 86_400_000), false)
})

test('a cadence produces a future check time and a host schedule selector', () => {
  const every = createObjectiveRecord({ id: 'obj_2', objective: 'x', cadence: cadenceFromSelectors({ every_seconds: 1800 }), now: NOW })
  assert.equal(every.nextCheckAt, NOW + 1_800_000)
  assert.equal(objectiveDue(every, NOW + 1_800_000), true)
  assert.deepEqual(scheduleSelector(every.cadence), { every_seconds: 1800 })

  const at = createObjectiveRecord({ id: 'obj_3', objective: 'x', cadence: cadenceFromSelectors({ at: '2026-11-06T09:00:00Z' }), now: NOW })
  assert.equal(at.nextCheckAt, Date.parse('2026-11-06T09:00:00Z'))
  assert.deepEqual(scheduleSelector(at.cadence), { at: '2026-11-06T09:00:00.000Z' })

  // daily/weekly/cron 的墙钟与 Cron 展开交给宿主；插件只保存 schedule 返回的时间。
  const daily = createObjectiveRecord({ id: 'obj_4', objective: 'x', cadence: cadenceFromSelectors({ daily: { time: '09:00', time_zone: 'America/Los_Angeles' } }), now: NOW })
  assert.equal(daily.nextCheckAt, undefined)
  assert.deepEqual(scheduleSelector(daily.cadence), { daily: { time: '09:00', time_zone: 'America/Los_Angeles' } })
  assert.equal(nextCheckAt({ kind: 'cron', expression: '0 9 * * *' }, NOW), undefined)
})

test('cadence selectors reject ambiguous or malformed input', () => {
  assert.throws(() => cadenceFromSelectors({ every_seconds: 10 }), /at least 60/)
  assert.throws(() => cadenceFromSelectors({ every_seconds: 60, daily: { time: '09:00' } }), /at most one/)
  assert.throws(() => cadenceFromSelectors({ at: 'tomorrow' }), /RFC 3339/)
  assert.throws(() => cadenceFromSelectors({ weekly: { time: '09:00', weekdays: [9] } }), /ISO weekdays/)
  assert.deepEqual(cadenceFromSelectors({}), { kind: 'manual' })
})

test('milestones can be appended without losing done state, and completed by id or text', () => {
  const base = [{ id: 'ms_1', text: 'a', done: true }, { id: 'ms_2', text: 'b', done: false }]
  const appended = appendMilestones(base, ['b', 'c'])
  assert.deepEqual(appended.map((milestone) => milestone.id), ['ms_1', 'ms_2', 'ms_3'])
  assert.equal(appended[1].done, false, 'duplicate text is ignored, not renumbered')
  const completed = completeMilestones(appended, ['ms_2', 'c'], NOW)
  assert.deepEqual(completed.map((milestone) => milestone.done), [true, true, true])
  assert.equal(completed[2].doneAt, NOW)
  assert.equal(milestoneProgress({ milestones: completed }).done, 3)
  assert.throws(() => completeMilestones(appended, ['nope'], NOW), /no milestone matched/)
})

test('a check folds into the objective and renders for the model', () => {
  const record = createObjectiveRecord({ id: 'obj_5', objective: 'Ship M2', milestones: ['a'], cadence: cadenceFromSelectors({ every_seconds: 600 }), now: NOW })
  const check = normalizeCheck({ source: 'schedule', note: 'no change', at: NOW + 600_000 }, NOW)
  const next = applyCheck(record, check, { now: NOW + 600_000, nextCheckAt: NOW + 1_200_000 })
  assert.equal(next.lastCheckAt, NOW + 600_000)
  assert.equal(next.nextCheckAt, NOW + 1_200_000)
  assert.equal(next.checks.length, 1)
  assert.throws(() => normalizeCheck({ source: 'auto' }, NOW), /check source/)
  const view = toObjectiveView(next, NOW + 600_000)
  assert.equal(view.progress.total, 1)
  assert.match(renderObjective(next, NOW + 600_000), /obj_5 \[active\] Ship M2/)
  assert.match(objectiveSummaryLine(next, NOW + 600_000), /0\/1 milestones/)
})

test('a host goal migrates into a manual-cadence objective', () => {
  const record = adoptHostGoal({
    id: 'goal_1',
    objective: 'Deliver dsh-chatgpt-ui M1-M3',
    phase: 'paused',
    activation: 'armed',
    roundsStarted: 7,
  }, { id: 'obj_6', now: NOW })
  assert.equal(record.cadence.kind, 'manual')
  assert.equal(record.nextCheckAt, undefined)
  assert.equal(record.source, 'host-goal')
  assert.equal(record.hostGoalId, 'goal_1')
  assert.deepEqual(record.migrated, { from: 'host-goal', hostGoalId: 'goal_1', hostPhase: 'paused', roundsStarted: 7, activation: 'armed', at: NOW })
  assert.throws(() => adoptHostGoal(undefined, { id: 'obj_7' }), /no host goal/)
})

// ── 运行时（假宿主）─────────────────────────────────────────────────────

test('creating an objective does not wake the router in the same turn', async () => {
  const sys = setupRuntime()
  const messagesBefore = sys.router.messages.length
  const triggersBefore = sys.store.stats().triggers
  const timersBefore = sys.timers.pendingTimeouts

  const result = await sys.runtime.createObjective({
    objective: 'Ship M2 of dsh-chatgpt-ui',
    milestones: ['M2a', 'M2b'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.equal(result.objective.cadence.kind, 'manual')
  assert.equal(sys.router.messages.length, messagesBefore, 'no followup/user message')
  assert.equal(sys.store.stats().triggers, triggersBefore, 'no trigger created')
  assert.equal(sys.store.pendingTriggers().length, 0, 'nothing queued for the router')
  assert.equal(sys.schedule.records.size, 0, 'no wake-up schedule for a manual objective')
  assert.equal(sys.timers.pendingTimeouts, timersBefore, 'no zero-delay flush was scheduled')

  // journal 只有一条 objective.created，没有任何唤醒事实。
  const events = journalEvents(sys.dataDir)
  assert.deepEqual(events.filter((event) => event.t.startsWith('objective.') || event.t === 'trigger.received').map((event) => event.t), ['objective.created'])

  // 回放同样得到这条目标（跨进程仍然可读）。
  const replayed = new Store({ dir: sys.dataDir })
  replayed.open()
  assert.equal(replayed.listObjectives().length, 1)
  assert.equal(replayed.listObjectives()[0].milestones.length, 2)
})

test('a cadence creates exactly one future host schedule and no router wake-up', async () => {
  const sys = setupRuntime()
  const result = await sys.runtime.createObjective({ objective: 'Check M2 every hour', every_seconds: 3600 })
  assert.equal(sys.schedule.records.size, 1)
  const [schedule] = [...sys.schedule.records.values()]
  assert.equal(schedule.kind, 'every')
  assert.equal(schedule.everySeconds, 3600)
  assert.match(schedule.prompt, /scheduled check, not an automatic continuation/)
  assert.match(schedule.prompt, new RegExp(result.objective.id))
  assert.equal(sys.router.messages.length, 0)
  assert.ok(result.objective.nextCheckAt > Date.now())
  assert.equal(result.objective.scheduleId, schedule.id)
})

test('a worker report advances the objective it is linked to', async () => {
  const sys = setupRuntime()
  const created = await sys.runtime.createObjective({ objective: 'Ship M2', milestones: ['M2a'] })
  const objectiveId = created.objective.id

  const dispatched = sys.runtime.dispatch({
    title: 'Implement M2a',
    brief: 'Implement milestone M2a and report back.',
    objectiveId,
  })
  assert.equal(dispatched.ok, true)
  await tick()
  const child = [...sys.children.values()][0]
  assert.ok(child !== undefined, 'worker started')
  child.finishTurn({ text: 'M2a implemented and tested.', turn: 1 })
  await tick()

  const objective = sys.store.getObjective(objectiveId)
  const check = objective.checks.at(-1)
  assert.equal(check.source, 'report')
  assert.equal(check.taskId, dispatched.taskId)
  assert.match(check.note, /completed: M2a implemented/)
  assert.deepEqual(objective.taskIds, [dispatched.taskId])
  // 报告推进不额外制造目标调度：仍然只有报告这条 trigger。
  assert.equal(sys.store.stats().triggers, 1)
})

test('a due scheduled check advances the objective without adding a wake-up of its own', async () => {
  const sys = setupRuntime()
  const created = await sys.runtime.createObjective({ objective: 'Ship M2', every_seconds: 600, milestones: ['M2a', 'M2b'] })
  const objectiveId = created.objective.id
  const scheduleId = created.objective.scheduleId
  const messagesBefore = sys.router.messages.length
  const triggersBefore = sys.store.stats().triggers

  const result = await sys.runtime.checkObjective({
    objective_id: objectiveId,
    source: 'schedule',
    note: 'no new information; M2b still pending',
    complete_milestones: ['M2a'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.progress.done, 1)
  const objective = sys.store.getObjective(objectiveId)
  assert.equal(objective.lastCheckAt > 0, true)
  assert.equal(objective.checks.at(-1).source, 'schedule')
  // 宿主 schedule 仍是唯一的下一次唤醒来源，check 自己不再排新的。
  assert.equal(sys.schedule.records.size, 1)
  assert.equal([...sys.schedule.records.keys()][0], scheduleId)
  assert.equal(sys.router.messages.length, messagesBefore)
  assert.equal(sys.store.stats().triggers, triggersBefore)
})

test('closing an objective cancels its check schedule and hides it from the active list', async () => {
  const sys = setupRuntime()
  const created = await sys.runtime.createObjective({ objective: 'Ship M2', every_seconds: 900 })
  const objectiveId = created.objective.id
  assert.equal(sys.schedule.records.size, 1)

  const closed = await sys.runtime.closeObjective({ objective_id: objectiveId, reason: 'M2 shipped' })
  assert.equal(closed.objective.status, 'done')
  assert.equal(sys.schedule.records.size, 0)
  assert.equal(sys.runtime.listObjectives().objectives.length, 0)
  assert.equal(sys.runtime.listObjectives({ includeDone: true }).objectives.length, 1)
  // 关闭后不能再 check，也不会再被唤醒。
  await assert.rejects(() => sys.runtime.checkObjective({ objective_id: objectiveId }), /closed/)
  assert.equal(sys.router.messages.length, 0)
})

test('changing the cadence replaces the schedule; manual removes it', async () => {
  const sys = setupRuntime()
  const created = await sys.runtime.createObjective({ objective: 'Ship M2', every_seconds: 3600 })
  const objectiveId = created.objective.id
  const firstSchedule = created.objective.scheduleId

  const updated = await sys.runtime.updateObjective({ objective_id: objectiveId, every_seconds: 7200, add_milestones: ['M2c'] })
  assert.equal(updated.canceledScheduleId, firstSchedule)
  assert.equal(sys.schedule.records.size, 1)
  assert.equal([...sys.schedule.records.values()][0].everySeconds, 7200)
  assert.equal(updated.objective.milestones.length, 1)

  const manual = await sys.runtime.updateObjective({ objective_id: objectiveId, manual: true })
  assert.equal(sys.schedule.records.size, 0)
  assert.equal(manual.objective.cadence.kind, 'manual')
  assert.equal(manual.objective.nextCheckAt, undefined)
  assert.equal(sys.router.messages.length, 0)
})

test('dispatch rejects an unknown or closed objective', async () => {
  const sys = setupRuntime()
  assert.throws(() => sys.runtime.dispatch({ title: 'x', brief: 'y', objectiveId: 'obj_missing' }), /objective not found/)
  const created = await sys.runtime.createObjective({ objective: 'Ship M2' })
  await sys.runtime.closeObjective({ objective_id: created.objective.id })
  assert.throws(
    () => sys.runtime.dispatch({ title: 'x', brief: 'y', objectiveId: created.objective.id }),
    /is done/,
  )
})

test('the paused host goal can be imported as a manual objective and is disarmed', async () => {
  const sys = setupRuntime()
  let disarmed = 0
  sys.router.ctx.goals = {
    get: () => ({ id: 'goal_1', objective: 'Deliver dsh-chatgpt-ui M1-M3', phase: 'paused', activation: 'armed', roundsStarted: 4 }),
    disarm: () => { disarmed += 1 },
  }
  const result = await sys.runtime.importHostGoal()
  assert.equal(result.migrated, true)
  assert.equal(result.disarmed, true)
  assert.equal(disarmed, 1)
  assert.equal(result.objective.cadence.kind, 'manual')
  assert.equal(result.objective.source, 'host-goal')
  assert.equal(sys.schedule.records.size, 0, 'migration creates no wake-up')
  assert.equal(sys.router.messages.length, 0)
  assert.match(result.note, /host goal stays paused and disarmed/)
})

test('install-time migration is idempotent and never creates a wake-up', async () => {
  const sys = setupRuntime()
  let disarms = 0
  sys.router.ctx.goals = {
    get: () => ({ id: 'goal_9', objective: 'Deliver dsh-chatgpt-ui M1-M3', phase: 'paused', activation: 'armed', roundsStarted: 5 }),
    disarm: () => { disarms += 1 },
  }
  const first = await sys.runtime.migrateHostGoalOnce()
  assert.equal(first.migrated, true)
  assert.equal(first.disarmed, true)
  assert.equal(disarms, 1)
  const second = await sys.runtime.migrateHostGoalOnce()
  assert.equal(second.migrated, false)
  assert.equal(second.reason, 'already_migrated')
  assert.equal(second.objectiveId, first.objectiveId)
  assert.equal(sys.store.listObjectives({ includeDone: true }).length, 1, 'one objective per host goal')
  assert.equal(sys.schedule.records.size, 0, 'migration schedules nothing')
  assert.equal(sys.router.messages.length, 0, 'migration does not wake the router')

  // 已完成的宿主 goal 不再迁移。
  sys.router.ctx.goals.get = () => ({ id: 'goal_10', objective: 'done thing', phase: 'complete', activation: 'disarmed' })
  assert.equal((await sys.runtime.migrateHostGoalOnce()).reason, 'goal_complete')

  // 宿主没有 goal 服务时安全返回，不写任何东西。
  const bare = setupRuntime()
  assert.equal((await bare.runtime.migrateHostGoalOnce()).reason, 'goals_unavailable')
  assert.equal(bare.store.listObjectives({ includeDone: true }).length, 0)
})

test('update accepts a normalized cadence object as well as selectors', async () => {
  const sys = setupRuntime()
  const created = await sys.runtime.createObjective({ objective: 'Ship M2' })
  assert.equal(sys.schedule.records.size, 0)
  const updated = await sys.runtime.updateObjective({
    objective_id: created.objective.id,
    cadence: { kind: 'every', everySeconds: 1200 },
  })
  assert.equal(updated.objective.cadence.kind, 'every')
  assert.equal(updated.objective.cadence.everySeconds, 1200)
  assert.equal(sys.schedule.records.size, 1)
  assert.equal([...sys.schedule.records.values()][0].everySeconds, 1200)
})
