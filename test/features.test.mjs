import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fakeLegacySchedule, fakeModels, fakeProject, setupRuntime, tick } from './fake-host.mjs'
import { createTools } from '../lib/tools.js'

const catalog = {
  groups: [
    {
      id: 'qoder',
      name: 'Qoder',
      models: [
        { id: 'dfmodel', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
        { id: 'qfmodel', name: 'Qwen3.8-Flash', reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }], defaultEffort: 'medium' } },
      ],
    },
  ],
  failures: [],
  default: { provider: 'qoder', model: 'dfmodel', reasoningEffort: 'high' },
}

const modelConfig = {
  models: {
    allowed: [
      { id: 'pro', provider: 'qoder', model: 'dfmodel', label: 'Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      { id: 'flash', provider: 'qoder', model: 'qfmodel', label: 'Flash', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ],
    default: 'pro',
  },
}

test('dispatch records the chosen model and passes agentOptions to the subagent', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const result = await ctx.runtime.dispatch({ title: 'Review parser', brief: 'Review it.', model: 'flash', reasoningEffort: 'low' })
  assert.equal(result.ok, true)
  assert.equal(result.model, 'flash')
  assert.equal(result.modelLabel, 'Flash')
  assert.equal(result.reasoningEffort, 'low')
  const spec = ctx.subagents.spawns[0].spec
  assert.deepEqual(spec.agentOptions, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'low' })
  assert.deepEqual(spec.request.agentOptions, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'low' })
  const task = ctx.runtime.taskDetail(result.taskId)
  assert.equal(task.model, 'flash')
  assert.equal(task.modelLabel, 'Flash')
  assert.equal(task.reasoningEffort, 'low')
  assert.equal(task.status, 'working')
})

test('dispatch defaults to the configured allowlist default and rejects disallowed efforts', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const result = await ctx.runtime.dispatch({ title: 'Default model', brief: 'Go.' })
  assert.equal(result.model, 'pro')
  assert.equal(result.reasoningEffort, 'high')
  assert.deepEqual(ctx.subagents.spawns[0].spec.agentOptions, { provider: 'qoder', model: 'dfmodel', reasoningEffort: 'high' })
  assert.deepEqual(ctx.subagents.spawns[0].spec.request.agentOptions, { provider: 'qoder', model: 'dfmodel', reasoningEffort: 'high' })
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'Bad effort', brief: 'Go.', model: 'flash', reasoningEffort: 'max' }),
    /does not allow reasoning effort/,
  )
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'Bad model', brief: 'Go.', model: 'unknown' }),
    /unknown or disallowed model/,
  )
})

test('reuse keeps the worker model and rejects a conflicting model request', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const first = await ctx.runtime.dispatch({ title: 'First', brief: 'Do it.', model: 'pro' })
  ctx.children.get(ctx.subagents.spawns[0].childId).finishTurn({ text: 'first done' })
  await tick()
  assert.throws(
    () => ctx.runtime.dispatch({ title: 'Conflict', brief: 'Continue.', reuseTaskId: first.taskId, model: 'flash' }),
    /keeps its model/,
  )
  const reused = await ctx.runtime.dispatch({ title: 'Second', brief: 'Continue.', reuseTaskId: first.taskId })
  assert.equal(reused.model, 'pro')
  assert.equal(reused.reasoningEffort, 'high')
  assert.equal(reused.continuedFrom, first.taskId)
  assert.equal(ctx.subagents.spawns.length, 1, 'reuse must not spawn a new worker')
})

test('cross-project workers receive the model selection', async () => {
  const other = fakeProject()
  const ctx = setupRuntime({
    config: modelConfig,
    models: fakeModels(catalog),
    projects: () => [{ title: 'other', path: other.root }],
  })
  await tick()
  const result = await ctx.runtime.dispatch({ title: 'Other repo', brief: 'Work there.', project: 'other', model: 'flash', reasoningEffort: 'medium' })
  assert.equal(result.model, 'flash')
  const activation = ctx.sessionWorkers.calls[0]
  assert.deepEqual(activation.spec.modelSelection, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'medium' })
})

test('agreements are listed by scope and injected into worker prompts', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const global = ctx.runtime.saveAgreement({ text: 'Always answer in Chinese.' })
  const project = ctx.runtime.saveAgreement({ text: 'Run pnpm test before reporting done.', project: ctx.root })
  assert.equal(global.ok, true)
  assert.match(global.agreement.id, /^agr_/)
  assert.equal(ctx.runtime.listAgreements().length, 2)
  assert.match(ctx.runtime.agreementContext(), /Always answer in Chinese/)
  assert.match(ctx.runtime.agreementContext(), /Run pnpm test/)
  await ctx.runtime.dispatch({ title: 'With agreements', brief: 'Do it.' })
  const prompt = ctx.subagents.spawns[0].spec.request.prompt[0].text
  assert.match(prompt, /Always answer in Chinese/)
  assert.match(prompt, /Run pnpm test before reporting done/)
  ctx.runtime.toggleAgreement(project.agreement.id, false)
  assert.doesNotMatch(ctx.runtime.agreementContext(), /Run pnpm test/)
  const removed = ctx.runtime.removeAgreement(global.agreement.id)
  assert.equal(removed.ok, true)
  assert.equal(ctx.runtime.listAgreements().length, 1)
})

test('agreement updates keep their project unless explicitly changed', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const saved = ctx.runtime.saveAgreement({ text: 'Scoped rule.', project: ctx.root })
  const updated = ctx.runtime.saveAgreement({ id: saved.agreement.id, text: 'Scoped rule v2.' })
  assert.equal(updated.agreement.project, ctx.root)
  assert.equal(updated.agreement.text, 'Scoped rule v2.')
})

test('task detail exposes reports, threads and activity in reverse chronological order', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const result = await ctx.runtime.dispatch({ title: 'Report me', brief: 'Do it.' })
  const child = ctx.children.get(ctx.subagents.spawns[0].childId)
  child.finishTurn({ text: 'Implemented the change. Tests pass.' })
  await tick()
  const detail = ctx.runtime.taskDetail(result.taskId)
  assert.equal(detail.status, 'idle')
  assert.equal(detail.reports.length, 1)
  assert.match(detail.reports[0].text, /Implemented the change/)
  assert.equal(detail.workerLive, true)
  assert.equal(detail.threadIds.length, 0)
  assert.equal(detail.threads.length, 0)
  const activity = ctx.runtime.activity(10)
  assert.equal(activity[0].id, result.taskId)
  assert.equal(activity[0].reportCount, 1)
  assert.match(activity[0].lastReport.preview, /Implemented the change/)
  assert.equal(ctx.runtime.status('compact').activity[0].id, result.taskId)
})

test('activity keeps closed tasks for history', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const result = await ctx.runtime.dispatch({ title: 'Close me', brief: 'Do it.' })
  await ctx.runtime.close({ taskId: result.taskId })
  const live = ctx.runtime.activity(10)
  assert.equal(live.length, 1)
  assert.equal(live[0].status, 'closed')
  assert.equal(ctx.runtime.activity(10, { includeClosed: false }).length, 0)
})

test('closing a cross-project task keeps its session openable in activity', async () => {
  const other = fakeProject()
  const ctx = setupRuntime({
    config: modelConfig,
    models: fakeModels(catalog),
    projects: () => [{ title: 'other', path: other.root }],
  })
  await tick()
  const result = await ctx.runtime.dispatch({ title: 'Keep history', brief: 'Do it.', project: 'other' })
  const workerId = ctx.sessionWorkers.calls[0].childId
  await ctx.runtime.close({ taskId: result.taskId })
  await tick()
  assert.equal(ctx.sessionWorkers.archives.length, 0, 'close must not archive the worker session')
  const detail = ctx.runtime.taskDetail(result.taskId)
  assert.equal(detail.status, 'closed')
  assert.equal(detail.workerSessionId, workerId)
  assert.equal(detail.workerLive, false)
  assert.equal(ctx.runtime.activity(10)[0].workerSessionId, workerId)
})

test('scheduled tasks create, list, cancel and run immediately', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  const created = await ctx.runtime.createSchedule({
    title: 'Morning review',
    prompt: 'Review open tasks and report.',
    context: 'Project: parser',
    after_seconds: 120,
  })
  assert.equal(created.ok, true)
  assert.match(created.schedule.id, /^sched_/)
  // 0.2.2 宿主级 API：typed timing + 本会话投递目标，创建者作为 actor 记入 involved。
  assert.deepEqual(ctx.schedule.calls.create[0].request.timing, { kind: 'after', after_seconds: 120 })
  assert.deepEqual(ctx.schedule.calls.create[0].request.target, { kind: 'session', sessionId: ctx.router.id })
  assert.equal(ctx.schedule.calls.create[0].actorSessionId, ctx.router.id)
  assert.match(ctx.schedule.records.get(created.schedule.id).prompt, /\[super-agent scheduled task\]/)
  assert.match(ctx.schedule.records.get(created.schedule.id).prompt, /Project: parser/)
  const list = await ctx.runtime.scheduleView(true)
  assert.equal(list.available, true)
  assert.equal(list.schedules.length, 1)
  assert.equal(list.schedules[0].kind, 'after')
  assert.equal(list.schedules[0].state, 'active')
  const ran = await ctx.runtime.runScheduleNow(created.schedule.id)
  assert.equal(ran.ok, true)
  assert.equal(ctx.store.pendingTriggers().length, 1)
  await ctx.runtime.cancelSchedule(created.schedule.id)
  assert.deepEqual(ctx.schedule.calls.edit.at(-1).request, { id: created.schedule.id, action: 'delete' })
  const after = await ctx.runtime.scheduleView(true)
  assert.equal(after.schedules.length, 0)
})

test('a pre-0.2.2 per-session schedule service still creates, lists and cancels', async () => {
  const ctx = setupRuntime({ schedule: fakeLegacySchedule() })
  await tick()
  const created = await ctx.runtime.createSchedule({ title: 'Legacy host', prompt: 'Check in.', every_seconds: 600 })
  assert.match(created.schedule.id, /^sched_/)
  assert.equal(created.schedule.state, 'scheduled')
  const list = await ctx.runtime.scheduleView(true)
  assert.equal(list.available, true)
  assert.deepEqual(list.schedules.map((row) => row.id), [created.schedule.id])
  await ctx.runtime.cancelSchedule(created.schedule.id)
  assert.equal((await ctx.runtime.scheduleView(true)).schedules.length, 0)
  assert.equal(ctx.schedule.records.size, 0)
})

test('reset-style cancelAllSchedules clears every active reminder', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  await ctx.runtime.createSchedule({ title: 'One', prompt: 'First.', after_seconds: 60 })
  await ctx.runtime.createSchedule({ title: 'Two', prompt: 'Second.', every_seconds: 120 })
  assert.equal((await ctx.runtime.scheduleView(true)).schedules.length, 2)
  const canceled = await ctx.runtime.cancelAllSchedules()
  assert.equal(canceled.canceled.length, 2)
  assert.deepEqual(canceled.failed, [])
  assert.equal((await ctx.runtime.scheduleView(true)).schedules.length, 0)
})

test('schedule validation enforces one selector and safe intervals', async () => {
  const ctx = setupRuntime({ config: modelConfig, models: fakeModels(catalog) })
  await tick()
  await assert.rejects(
    ctx.runtime.createSchedule({ title: 'Two', prompt: 'x', after_seconds: 10, every_seconds: 60 }),
    /exactly one timing selector/,
  )
  await assert.rejects(
    ctx.runtime.createSchedule({ title: 'Fast', prompt: 'x', every_seconds: 30 }),
    />= 60/,
  )
  await assert.rejects(
    ctx.runtime.createSchedule({ title: 'No prompt', prompt: '', after_seconds: 60 }),
    /prompt is required/,
  )
})

test('superagent_steer forwards the interrupt flag to the runtime', async () => {
  const calls = []
  const tools = createTools({
    steer(taskId, message, options) {
      calls.push([taskId, message, options])
      return { ok: true }
    },
  })
  const steer = tools.find((candidate) => candidate.name === 'superagent_steer')
  assert.equal(steer.parameters.properties.interrupt.type, 'boolean')
  await steer.execute({ task_id: 'tsk_test', message: 'go', interrupt: false })
  await steer.execute({ task_id: 'tsk_test', message: 'go' })
  assert.deepEqual(calls[0], ['tsk_test', 'go', { attachments: undefined, interrupt: false }])
  assert.deepEqual(calls[1], ['tsk_test', 'go', { attachments: undefined, interrupt: undefined }])
})
