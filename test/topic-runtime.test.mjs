import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_TOPIC_ID, TopicRegistry } from '../lib/topics.js'
import { createTools } from '../lib/tools.js'
import { fakeProject, fakeRouter, setupRuntime, tick } from './fake-host.mjs'

function setup(options = {}) {
  const project = fakeProject()
  const topics = new TopicRegistry(project.root)
  topics.bind(MAIN_TOPIC_ID, 'session-router')
  const a = topics.create('Writing')
  const b = topics.create('Development', options.private ? 'private' : 'summary')
  const first = fakeRouter(project.root)
  first.id = 'session-topic-a'
  first.session.header.id = first.id
  const second = fakeRouter(project.root)
  second.id = 'session-topic-b'
  second.session.header.id = second.id
  topics.bind(a.id, first.id)
  topics.bind(b.id, second.id)
  const ctx = setupRuntime({ project, topics, config: { worker: { maxWorkers: options.maxWorkers ?? 4 }, schedule: { maxActive: options.maxSchedules ?? 20 } } })
  ctx.runtime.attachTopic(a.id, first)
  ctx.runtime.attachTopic(b.id, second)
  const aScope = { topicId: a.id, agent: first }
  const bScope = { topicId: b.id, agent: second }
  const tools = (scope) => new Map(createTools(ctx.runtime, scope).map((definition) => [definition.name, definition]))
  return { ...ctx, project, topics, a, b, first, second, aScope, bScope, aTools: tools(aScope), bTools: tools(bScope) }
}

test('msg:last attachments are resolved from the calling topic, never the owner or a concurrent topic', async () => {
  const ctx = setup()
  for (const [scope, marker] of [[ctx.aScope, 'A-ATTACHMENT'], [ctx.bScope, 'B-ATTACHMENT']]) {
    const path = join(ctx.project.root, `${marker}.md`)
    writeFileSync(path, marker)
    scope.attachmentSource = {
      sessionId: scope.agent.id,
      messages: [{ id: `${marker}-message`, role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId: `sha256:${marker.startsWith('A') ? 'a'.repeat(64) : 'b'.repeat(64)}`, name: 'notes.md', bytes: marker.length } }] }],
      fileHostPath: () => path,
    }
  }
  const [a, b] = await Promise.all([
    ctx.aTools.get('superagent_dispatch').execute({ title: 'Attachment A', brief: 'Read only A', attachments: ['msg:last'] }),
    ctx.bTools.get('superagent_dispatch').execute({ title: 'Attachment B', brief: 'Read only B', attachments: ['msg:last'] }),
  ])
  assert.equal(readFileSync(a.attachments[0], 'utf8'), 'A-ATTACHMENT')
  assert.equal(readFileSync(b.attachments[0], 'utf8'), 'B-ATTACHMENT')
  await tick()
  ctx.runtime.stop()
})

test('an unavailable topic attachment source never falls back to overview attachments', () => {
  const ctx = setup()
  ctx.runtime.attachmentSource = { messages: [{ role: 'user', content: [{ type: 'file', attachment: { attachmentId: 'overview-only' } }] }], fileHostPath: () => { throw new Error('overview source must not be touched') } }
  assert.throws(() => ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.dispatch({ title: 'No fallback', brief: 'Fixture', attachments: ['msg:last'] })), /live host session/)
  const unopened = ctx.topics.create('Unopened fixture')
  assert.equal(ctx.runtime.withConversation({ topicId: unopened.id }, () => ctx.runtime.currentAgent()), undefined)
  ctx.runtime.stop()
})

test('a failed shared schedule read cannot bypass the instance schedule quota', async () => {
  const ctx = setup({ maxSchedules: 1 })
  ctx.runtime.schedule.list = async () => { throw new Error('host temporarily unavailable') }
  await assert.rejects(ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.createSchedule({ title: 'No bypass', prompt: 'Fixture', after_seconds: 60 })), /could not verify the shared schedule pool/)
  ctx.runtime.stop()
})

test('private thread ids cannot be used to subscribe a worker or address an outbox reply', () => {
  const ctx = setup({ private: true })
  const event = ctx.runtime.withConversation(ctx.bScope, () => ctx.runtime.ingest({ source: 'fixture', kind: 'message', threadKey: 'private', text: 'PRIVATE THREAD', direct: true }))
  const threadId = event.threadId
  assert.throws(() => ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.dispatch({ title: 'No subscription', brief: 'Fixture', threadIds: [threadId] })), /not accessible/)
  assert.throws(() => ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.reply({ channel: 'fixture', text: 'No reply', threadId })), /not accessible/)
  assert.equal(ctx.store.listTasks().length, 0)
  ctx.runtime.stop()
})

test('different topic callers share one worker quota, and each report returns only to its originating conversation', async () => {
  const ctx = setup({ maxWorkers: 1 })
  const a = await ctx.aTools.get('superagent_dispatch').execute({ title: 'A work', brief: 'A brief' })
  const b = await ctx.bTools.get('superagent_dispatch').execute({ title: 'B work', brief: 'B brief' })
  await tick()
  assert.equal(ctx.store.getTask(a.taskId).topicId, ctx.a.id)
  assert.equal(ctx.store.getTask(b.taskId).sourceSessionId, ctx.second.id)
  assert.equal(ctx.store.getTask(b.taskId).status, 'queued')
  assert.equal(ctx.subagents.spawns.length, 1)
  ctx.router.status = 'running'
  ctx.children.get(ctx.store.getTask(a.taskId).workerSessionId).finishTurn({ text: 'WRITING-RESULT' })
  await tick()
  ctx.runtime.flushNow()
  assert.match(JSON.stringify(ctx.first.messages), /WRITING-RESULT/)
  assert.equal(ctx.second.messages.length, 0)
  assert.equal(ctx.router.messages.length, 0)
  assert.equal(ctx.subagents.spawns.length, 2)
  ctx.children.get(ctx.store.getTask(b.taskId).workerSessionId).finishTurn({ text: 'DEVELOPMENT-RESULT' })
  ctx.runtime.flushNow()
  assert.match(JSON.stringify(ctx.second.messages), /DEVELOPMENT-RESULT/)
  assert.doesNotMatch(JSON.stringify(ctx.first.messages), /DEVELOPMENT-RESULT/)
  assert.equal((readFileSync(ctx.store.paths.journal, 'utf8').match(/"t":"task.created"/g) ?? []).length, 2)
  ctx.runtime.stop()
})

test('a busy topic does not block another topic; source ids and Thread keys are namespaced by topic', () => {
  const ctx = setup()
  ctx.first.status = 'running'
  const a = ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.ingest({ source: 'github', externalId: 'same', threadKey: 'shared-key', text: 'ONLY-A' }))
  const b = ctx.runtime.withConversation(ctx.bScope, () => ctx.runtime.ingest({ source: 'github', externalId: 'same', threadKey: 'shared-key', text: 'ONLY-B' }))
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.threadId, b.threadId)
  assert.equal(ctx.runtime.flushNow().flushed, 1)
  assert.equal(ctx.first.messages.length, 0)
  assert.match(JSON.stringify(ctx.second.messages), /ONLY-B/)
  ctx.first.finish()
  ctx.timers.runTimeouts()
  assert.match(JSON.stringify(ctx.first.messages), /ONLY-A/)
  assert.doesNotMatch(JSON.stringify(ctx.second.messages), /ONLY-A/)
  assert.equal(ctx.store.pendingTriggers().length, 0)
  ctx.runtime.stop()
})

test('private topic details cannot leak through status, activity, object recall or worker reuse', async () => {
  const ctx = setup({ private: true })
  const task = await ctx.bTools.get('superagent_dispatch').execute({ title: 'PRIVATE-TITLE', brief: 'PRIVATE-BRIEF' })
  await tick()
  ctx.children.get(ctx.store.getTask(task.taskId).workerSessionId).finishTurn({ text: 'PRIVATE-RESULT' })
  const flushed = ctx.runtime.flushNow()
  const stored = ctx.store.getTask(task.taskId)
  const report = stored.lastReport
  const trigger = [...ctx.store.triggers.values()].find((row) => row.externalId === report.id)
  const reply = ctx.runtime.withConversation(ctx.bScope, () => ctx.runtime.reply({ channel: 'im', text: 'PRIVATE-REPLY', taskId: stored.id }))
  const status = await ctx.aTools.get('superagent_status').execute({ detail: 'full' })
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/)
  for (const id of [stored.id, report.id, trigger.id, trigger.threadId, flushed.batchId, reply.replyId]) {
    assert.equal((await ctx.aTools.get('superagent_recall').execute({ id })).ok, false, id)
  }
  await assert.rejects(ctx.aTools.get('superagent_dispatch').execute({ title: 'reuse', brief: 'continue', reuse_task_id: stored.id }), /allowed topic/)
  await assert.rejects(ctx.aTools.get('superagent_steer').execute({ task_id: stored.id, message: 'inspect private work' }), /allowed topic/)
  ctx.runtime.stop()
})

test('summary sharing exposes task status but does not expose report previews or briefs', async () => {
  const ctx = setup()
  const task = await ctx.bTools.get('superagent_dispatch').execute({ title: 'Public status', brief: 'HIDDEN-BRIEF' })
  await tick()
  ctx.children.get(ctx.store.getTask(task.taskId).workerSessionId).finishTurn({ text: 'HIDDEN-REPORT' })
  const status = await ctx.aTools.get('superagent_status').execute({ detail: 'full' })
  assert.ok(status.tasks.some((row) => row.id === task.taskId))
  assert.doesNotMatch(JSON.stringify(status), /HIDDEN/)
  ctx.topics.update(ctx.b.id, { sharing: 'history' })
  assert.match(JSON.stringify(await ctx.aTools.get('superagent_recall').execute({ id: task.taskId })), /HIDDEN-BRIEF/)
  ctx.runtime.stop()
})

test('asynchronous schedule calls keep each caller identity, and due runs route to their owner', async () => {
  const ctx = setup()
  const [a, b] = await Promise.all([
    ctx.aTools.get('superagent_schedule').execute({ action: 'create', title: 'A timer', prompt: 'A check', after_seconds: 60 }),
    ctx.bTools.get('superagent_schedule').execute({ action: 'create', title: 'B timer', prompt: 'B check', after_seconds: 60 }),
  ])
  assert.equal(a.schedule.ownerSessionId, ctx.first.id)
  assert.equal(b.schedule.ownerSessionId, ctx.second.id)
  assert.equal(ctx.schedule.records.get(a.schedule.id).target.sessionId, ctx.first.id)
  assert.equal(ctx.schedule.records.get(b.schedule.id).target.sessionId, ctx.second.id)
  await ctx.runtime.withConversation({ operator: true }, () => ctx.runtime.runScheduleNow(b.schedule.id))
  ctx.runtime.flushNow()
  assert.match(JSON.stringify(ctx.second.messages), /B check/)
  assert.equal(ctx.first.messages.length, 0)
  assert.equal((await ctx.runtime.withConversation({ operator: true }, () => ctx.runtime.cancelAllSchedules())).canceled.length, 2)
  assert.equal(ctx.schedule.records.size, 0)
  ctx.runtime.stop()
})

test('concurrent topic schedules cannot exceed the shared instance schedule allowance', async () => {
  const ctx = setup({ maxSchedules: 1 })
  const results = await Promise.allSettled([
    ctx.aTools.get('superagent_schedule').execute({ action: 'create', title: 'A', prompt: 'A check', after_seconds: 60 }),
    ctx.bTools.get('superagent_schedule').execute({ action: 'create', title: 'B', prompt: 'B check', after_seconds: 60 }),
  ])
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1)
  assert.equal(ctx.schedule.records.size, 1)
  ctx.runtime.stop()
})

test('local agreements reach only their originating workers, and explicit instance agreements reach both', async () => {
  const ctx = setup()
  await ctx.aTools.get('superagent_agreement').execute({ action: 'save', text: 'LOCAL-WRITING-RULE' })
  await ctx.aTools.get('superagent_agreement').execute({ action: 'save', text: 'INSTANCE-RULE', scope: 'instance' })
  await ctx.aTools.get('superagent_memory').execute({ action: 'remember', text: 'LOCAL-WRITING-FACT' })
  await ctx.aTools.get('superagent_dispatch').execute({ title: 'A', brief: 'A task' })
  await ctx.bTools.get('superagent_dispatch').execute({ title: 'B', brief: 'B task' })
  await tick()
  assert.match(JSON.stringify(ctx.subagents.spawns[0].spec.prompt), /LOCAL-WRITING-RULE|LOCAL-WRITING-FACT/)
  assert.doesNotMatch(JSON.stringify(ctx.subagents.spawns[1].spec.prompt), /LOCAL-WRITING/)
  assert.match(JSON.stringify(ctx.subagents.spawns[0].spec.prompt), /INSTANCE-RULE/)
  assert.match(JSON.stringify(ctx.subagents.spawns[1].spec.prompt), /INSTANCE-RULE/)
  assert.doesNotMatch(JSON.stringify(await ctx.bTools.get('superagent_agreement').execute({ action: 'list' })), /LOCAL-WRITING/)
  ctx.runtime.stop()
})

test('topic objectives keep their own schedules and are excluded from other topic contexts', async () => {
  const ctx = setup()
  const result = await ctx.bTools.get('superagent_goal').execute({ action: 'create', objective: 'PRIVATE-OBJECTIVE', every_seconds: 300 })
  const record = ctx.store.getObjective(result.objective.id)
  assert.equal(record.topicId, ctx.b.id)
  assert.equal(ctx.schedule.records.get(record.scheduleId).target.sessionId, ctx.second.id)
  assert.doesNotMatch(JSON.stringify(await ctx.aTools.get('superagent_goal').execute({ action: 'list' })), /PRIVATE-OBJECTIVE/)
  await ctx.bTools.get('superagent_goal').execute({ action: 'close', objective_id: record.id })
  assert.equal(ctx.schedule.records.size, 0)
  ctx.runtime.stop()
})
