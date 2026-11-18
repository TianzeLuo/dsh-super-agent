import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
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
  // These tests cover routing/version/budget invariants. Semantic decisions are
  // exercised separately, with both model-contract tests and real model calls.
  for (const agent of [first, second]) agent.session.deriveMessages = () => [{ id: `${agent.id}-human`, role: 'user', content: 'Remember the facts I explicitly supply for this test.' }]
  topics.bind(a.id, first.id)
  topics.bind(b.id, second.id)
  const ctx = setupRuntime({ project, topics, config: { worker: { maxWorkers: options.maxWorkers ?? 4 }, schedule: { maxActive: options.maxSchedules ?? 20 } } })
  ctx.runtime.models.complete = async (_selection, { input }) => JSON.stringify({ decision: 'apply', text: JSON.parse(input).proposal.text, reason: 'Fixture approval for the explicit human request.' })
  ctx.runtime.attachTopic(a.id, first)
  ctx.runtime.attachTopic(b.id, second)
  const aScope = { topicId: a.id, agent: first }
  const bScope = { topicId: b.id, agent: second }
  const tools = (scope) => new Map(createTools(ctx.runtime, scope).map((definition) => [definition.name, definition]))
  return { ...ctx, project, topics, a, b, first, second, aScope, bScope, aTools: tools(aScope), bTools: tools(bScope) }
}

test('reused Workers receive current decisions and review evidence is bound to the latest report and fact versions', async () => {
  const ctx = setup()
  const key = 'project.runtime'
  const save = (text, expected_revision) => ctx.topics.memoryAction(MAIN_TOPIC_ID, { action: 'save', scope: 'instance', key, text, expected_revision }, { kind: 'operator' }).entry
  const inspect = (id) => ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.recall(id).object)
  const initial = save('WSL_DEFAULT is the daily runtime. Public release requires approval.', 0)
  const first = await ctx.aTools.get('superagent_dispatch').execute({ title: 'Initial build', brief: 'Prepare the runbook and a verified runtime.' })
  await tick()
  const workerId = ctx.store.getTask(first.taskId).workerSessionId
  const child = ctx.children.get(workerId)
  child.finishTurn({ turn: 1, text: 'The first runbook describes a WSL default.' })
  assert.deepEqual(ctx.store.getTask(first.taskId).lastReport.decisionVersions, [{ id: initial.id, key, scope: 'instance', revision: 1 }])
  assert.equal(inspect(first.taskId).decisionReview, undefined)

  save('WINDOWS_NATIVE is the daily runtime. WSL is for compatibility checks. Public release requires approval.', 1)
  const firstReview = inspect(first.taskId).decisionReview
  assert.equal(firstReview.state, 'needs_review')
  assert.deepEqual(firstReview.changes.map(({ before, after }) => [before.revision, after.revision]), [[1, 2]])
  const continued = await ctx.aTools.get('superagent_dispatch').execute({ title: 'Revise the same runbook', brief: 'Recheck the documentation and its startup commands.', reuse_task_id: first.taskId })
  await tick()
  assert.equal(ctx.subagents.spawns.length, 1)
  assert.equal(ctx.store.getTask(continued.taskId).workerSessionId, workerId)
  const input = JSON.stringify(child.followups.at(-1))
  assert.match(input, /project\.runtime.*instance r1 → instance r2/)
  assert.match(input, /WINDOWS_NATIVE is the daily runtime/)
  assert.doesNotMatch(input, /WSL_DEFAULT/)
  child.finishTurn({ turn: 2, text: 'Updated the runbook and compatibility guide.' })
  const currentReview = inspect(continued.taskId).decisionReview
  assert.equal(currentReview.state, 'needs_review')
  assert.notEqual(currentReview.basis, firstReview.basis)
  assert.equal(ctx.store.getTask(continued.taskId).lastReport.decisionVersions[0].revision, 2)
  assert.ok(ctx.store.pendingTriggers(50).some((row) => row.text.startsWith(`Decision review needed for task ${continued.taskId}.`)))

  save('WINDOWS_NATIVE is the daily runtime and binds only to loopback. WSL is for compatibility checks. Public release requires approval.', 2)
  const evidence = 'Independent review checked README and compatibility commands at commit abc123, including the loopback health endpoint.'
  const close = (basis) => ctx.aTools.get('superagent_close').execute({ task_id: continued.taskId, verification: { basis, evidence } })
  await assert.rejects(close(currentReview.basis), /review basis.*changed/)
  assert.equal(ctx.store.getTask(continued.taskId).status, 'idle')
  ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.steer(continued.taskId, 'Update the remaining affected files.'))
  assert.match(JSON.stringify(child.steers.at(-1)), /project\.runtime.*instance r2 → instance r3/)
  child.finishTurn({ turn: 3, text: 'Verified the loopback service and updated both documents.' })
  await close(inspect(continued.taskId).decisionReview.basis)
  assert.equal(inspect(continued.taskId).decisionReview.state, 'reviewed')
  assert.equal(inspect(continued.taskId).decisionReview.verification.evidence, evidence)
  const journal = new Store({ dir: ctx.project.dataDir })
  journal.open()
  assert.equal(journal.getTask(continued.taskId).lastReport.decisionVersions[0].revision, 3)
  assert.equal(journal.getTask(continued.taskId).decisionVerification.evidence, evidence)

  save('WINDOWS_NATIVE now uses loopback port 4318. Public release requires approval.', 3)
  assert.equal(inspect(continued.taskId).decisionReview.state, 'needs_review')
  ctx.runtime.stop()
})

test('another topic can read a shared task report without receiving current local decision versions', async () => {
  const ctx = setup()
  ctx.topics.update(ctx.a.id, { sharing: 'history' })
  const input = { action: 'save', scope: 'topic', key: 'private.decision.key' }
  ctx.topics.memoryAction(ctx.a.id, { ...input, text: 'Local decision v1.' }, { kind: 'operator' })
  const task = await ctx.aTools.get('superagent_dispatch').execute({ title: 'Local work', brief: 'Record the checked files.' })
  await tick()
  ctx.children.get(ctx.store.getTask(task.taskId).workerSessionId).finishTurn({ text: 'Local work was implemented.' })
  ctx.topics.memoryAction(ctx.a.id, { ...input, text: 'Local decision v2.', expected_revision: 1 }, { kind: 'operator' })
  const own = ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.recall(task.taskId).object.decisionReview)
  assert.equal(own.changes[0].before.key, input.key)
  const shared = ctx.runtime.withConversation(ctx.bScope, () => ctx.runtime.recall(task.taskId))
  assert.equal(shared.ok, true)
  assert.doesNotMatch(JSON.stringify(shared), /private\.decision\.key|decisionReview|decisionVersions/)
  assert.throws(() => ctx.runtime.withConversation(ctx.bScope, () => ctx.runtime.close({ taskId: task.taskId, verification: { basis: own.basis, evidence: 'Wrong scope.' } })), /outside this conversation scope/)
  ctx.runtime.stop()
})

test('a separate reviewer records a verdict for the selected report and bytes, and can review a later version', async (t) => {
  const ctx = setup()
  t.after(() => ctx.runtime.stop())
  const dispatch = (args) => ctx.aTools.get('superagent_dispatch').execute({ title: 'Delivery check', brief: 'Check the startup instructions.', ...args })
  const read = (id) => ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.recall(id).object)
  const finish = async (taskId, text, turn) => {
    await tick()
    const task = ctx.store.getTask(taskId)
    ctx.children.get(task.workerSessionId).finishTurn({ text, turn })
    return task.lastReport.id
  }
  const cwd = join(ctx.project.root, 'delivery')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'README.md'), 'Start on port 4317')
  const delivery = await dispatch({ cwd })
  const deliveryReport = await finish(delivery.taskId, 'Startup instructions delivered.')
  const binding = { task_id: delivery.taskId, files: ['README.md'] }
  await assert.rejects(dispatch({ reuse_task_id: delivery.taskId, review_of: binding }), /separate reviewer/)
  await assert.rejects(dispatch({ reuse_task_id: delivery.taskId, cwd: ctx.project.root }), /Omit cwd to inherit/)
  await assert.rejects(dispatch({ review_of: { ...binding, files: ['../escape.txt'] } }), /inside the task directory/)
  const outside = join(ctx.project.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'private.txt'), 'Not part of the delivery')
  symlinkSync(outside, join(cwd, 'linked'), 'junction')
  await assert.rejects(dispatch({ review_of: { ...binding, files: ['linked/private.txt'] } }), /inside the task directory/)

  const review = await dispatch({ review_of: binding })
  assert.equal(review.cwd, cwd)
  assert.equal(review.reviewOf.reportId, deliveryReport)
  const verify = (task, reportId, outcome) => ctx.aTools.get('superagent_review').execute({
    review_task_id: task.taskId, report_id: reportId, outcome, evidence: 'Read the startup instructions and checked the port.',
  })
  await assert.rejects(verify(review, deliveryReport, 'pass'), /current completed report/)
  const reportId = await finish(review.taskId, 'Needs changes: the configured port is 4318.')
  assert.notEqual(ctx.store.getTask(review.taskId).workerSessionId, ctx.store.getTask(delivery.taskId).workerSessionId)
  const prompt = JSON.stringify(ctx.subagents.spawns.at(-1).spec)
  assert.ok(prompt.includes(deliveryReport))
  assert.ok(prompt.includes(review.reviewOf.files[0].sha256))
  assert.match(prompt, /acceptance criteria in your current review brief/)
  assert.ok(ctx.store.pendingTriggers(50).some((row) => row.text.includes('superagent_review') && row.text.includes(reportId)))
  await assert.rejects(verify(delivery, deliveryReport, 'pass'), /declare review_of/)
  await assert.rejects(verify(review, deliveryReport, 'pass'), /current completed report/)
  await verify(review, reportId, 'needs_changes')
  assert.equal(ctx.store.getTask(delivery.taskId).status, 'idle')
  assert.deepEqual([read(delivery.taskId).acceptance.state, read(delivery.taskId).acceptance.outcome], ['current', 'needs_changes'])

  writeFileSync(join(cwd, 'README.md'), 'Start on port 4318')
  assert.equal(read(delivery.taskId).acceptance.state, 'stale')
  await assert.rejects(verify(review, reportId, 'pass'), /report, decisions or files have changed/)
  const next = await dispatch({ review_of: binding, reuse_task_id: review.taskId })
  assert.notEqual(next.reviewOf.files[0].sha256, review.reviewOf.files[0].sha256)
  const nextReport = await finish(next.taskId, 'Pass: the instructions and configured port both say 4318.', 2)
  assert.equal(ctx.store.getTask(next.taskId).workerSessionId, ctx.store.getTask(review.taskId).workerSessionId)
  await verify(next, nextReport, 'pass')
  const detail = ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.taskDetail(delivery.taskId))
  assert.equal(detail.acceptance.state, 'current')
  assert.equal(detail.acceptance.fileCount, 1)
  assert.equal(detail.acceptance.outcome, 'pass')
  const journal = new Store({ dir: ctx.project.dataDir })
  journal.open()
  assert.equal(journal.getTask(delivery.taskId).acceptance.reviewerReportId, nextReport)
  assert.deepEqual(journal.getTask(next.taskId).reviewOf, next.reviewOf)
  await ctx.aTools.get('superagent_steer').execute({ task_id: delivery.taskId, message: 'Revise the report.' })
  await finish(delivery.taskId, 'A new delivery report.', 2)
  assert.equal(read(delivery.taskId).acceptance.state, 'stale')
  await assert.rejects(verify(next, nextReport, 'pass'), /report, decisions or files have changed/)
})

test('decision updates stale a report-only review and shared history cannot use its review binding', async (t) => {
  const ctx = setup()
  t.after(() => ctx.runtime.stop())
  ctx.topics.update(ctx.a.id, { sharing: 'history' })
  const input = { action: 'save', scope: 'topic', key: 'project.runtime' }
  ctx.topics.memoryAction(ctx.a.id, { ...input, text: 'Use the Windows runtime for verification.' }, { kind: 'operator' })
  const args = { title: 'Startup check', brief: 'Check the configured runtime.' }
  const dispatch = (options = {}) => ctx.aTools.get('superagent_dispatch').execute({ ...args, ...options })
  const finish = async (result) => {
    await tick()
    const task = ctx.store.getTask(result.taskId)
    ctx.children.get(task.workerSessionId).finishTurn({ text: 'Checked the startup instructions.' })
    return task.lastReport.id
  }
  const delivery = await dispatch()
  await finish(delivery)
  const review_of = { task_id: delivery.taskId }
  await assert.rejects(ctx.bTools.get('superagent_dispatch').execute({ ...args, review_of }), /must be in this conversation/)
  const review = await dispatch({ review_of })
  const verdict = { review_task_id: review.taskId, report_id: await finish(review), outcome: 'inconclusive', evidence: 'Only documentation was available.' }
  await assert.rejects(ctx.bTools.get('superagent_review').execute(verdict), /outside this conversation scope/)
  await ctx.aTools.get('superagent_review').execute(verdict)
  const shared = ctx.runtime.withConversation(ctx.bScope, () => ctx.runtime.recall(delivery.taskId))
  assert.equal(shared.ok, true)
  assert.equal(shared.object.acceptance, undefined)
  const sharedDetail = ctx.runtime.withConversation({ ...ctx.bScope, activityTopicId: ctx.b.id }, () => ctx.runtime.taskDetail(delivery.taskId))
  assert.equal(sharedDetail.status, 'idle')
  assert.equal(sharedDetail.acceptance, undefined)
  ctx.topics.memoryAction(ctx.a.id, { ...input, text: 'Use the native Windows runtime and check port 4318.', expected_revision: 1 }, { kind: 'operator' })
  assert.equal(ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.recall(delivery.taskId)).object.acceptance.state, 'stale')
  await assert.rejects(ctx.aTools.get('superagent_review').execute(verdict), /report, decisions or files have changed/)
})

test('a queued review fails before starting a Worker when the selected delivery files change', async (t) => {
  const ctx = setup({ maxWorkers: 1 })
  t.after(() => ctx.runtime.stop())
  const dispatch = (args) => ctx.aTools.get('superagent_dispatch').execute({ title: 'Queued check', brief: 'Check this fixture.', ...args })
  const file = join(ctx.project.root, 'release.txt')
  writeFileSync(file, 'v1')
  const delivery = await dispatch()
  await tick()
  ctx.children.get(ctx.store.getTask(delivery.taskId).workerSessionId).finishTurn()
  const blocker = await dispatch()
  await tick()
  const review = await dispatch({ review_of: { task_id: delivery.taskId, files: ['release.txt'] } })
  assert.equal(review.status, 'queued')
  writeFileSync(file, 'v2')
  ctx.children.get(ctx.store.getTask(blocker.taskId).workerSessionId).finishTurn()
  assert.equal(ctx.store.getTask(review.taskId).status, 'failed')
  assert.equal(ctx.store.getTask(review.taskId).workerSessionId, undefined)
  assert.equal(ctx.subagents.spawns.length, 2)
})

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

test('agreement tools narrow and share the same rule while preserving all other conditions', async () => {
  const ctx = setup()
  const tool = ctx.aTools.get('superagent_agreement')
  const created = await tool.execute({ action: 'save', title: 'Testing requirement', text: 'Verify relevant tests.', audience: 'worker', scenes: ['代码开发'], project: ctx.project.root, mode: 'replace', scope: 'instance' })
  const id = created.agreement.id
  assert.ok((await ctx.bTools.get('superagent_agreement').execute({ action: 'list' })).agreements.some((row) => row.id === id))
  const local = await tool.execute({ action: 'save', agreement_id: id, text: created.agreement.text, scope: 'topic' })
  assert.equal(local.agreement.id, id)
  assert.equal(local.agreement.title, 'Testing requirement')
  assert.equal(local.agreement.topicId, ctx.a.id)
  assert.equal(local.agreement.audience, 'worker')
  assert.deepEqual(local.agreement.scenes, ['代码开发'])
  assert.equal(local.agreement.project, ctx.project.root)
  assert.equal(local.agreement.mode, 'replace')
  assert.equal((await ctx.bTools.get('superagent_agreement').execute({ action: 'list' })).agreements.length, 0)
  await assert.rejects(ctx.bTools.get('superagent_agreement').execute({ action: 'save', agreement_id: id, text: 'Do not move another private rule.', scope: 'instance' }), /another topic/)
  const shared = await tool.execute({ action: 'save', agreement_id: id, text: local.agreement.text, scope: 'instance', project: '', scenes: [] })
  assert.equal(shared.agreement.topicId, undefined)
  assert.equal(shared.agreement.project, '')
  assert.equal(shared.agreement.projectTitle, undefined)
  assert.deepEqual(shared.agreement.scenes, [])
  assert.equal(shared.count, 1)
  await assert.rejects(tool.execute({ action: 'save', agreement_id: id, text: shared.agreement.text, scope: 'unknown' }), /scope/)
  assert.throws(() => ctx.runtime.saveAgreement({ id, text: shared.agreement.text, scope: 'topic' }), /open an agent chat/)
  ctx.runtime.stop()
})

test('overview tools advertise only supported rule scopes while agent chats retain local rules', async () => {
  const ctx = setup()
  const overview = new Map(createTools(ctx.runtime).map((definition) => [definition.name, definition])).get('superagent_agreement')
  assert.deepEqual(overview.parameters.properties.scope.enum, ['instance'])
  assert.deepEqual(ctx.aTools.get('superagent_agreement').parameters.properties.scope.enum, ['topic', 'instance'])
  await assert.rejects(overview.execute({ action: 'save', scope: 'topic', text: 'Do not silently widen this scope.' }), /open an agent chat/)
  assert.equal(ctx.runtime.listAgreements().length, 0)
  const saved = await overview.execute({ action: 'save', scope: 'instance', text: 'Project-specific acceptance requirement.', project: ctx.project.root })
  assert.equal(saved.agreement.topicId, undefined)
  assert.equal(saved.agreement.project, ctx.project.root)
  ctx.runtime.stop()
})

test('memory writes capture the caller message source and state writes cannot redirect to another topic', async () => {
  const ctx = setup()
  ctx.first.session.deriveMessages = () => [{ id: 'fixture-user-source', role: 'user', content: [{ type: 'text', text: 'Remember this current fact.' }] }]
  const result = await ctx.aTools.get('superagent_memory').execute({ action: 'save', key: 'current-fact', text: 'Current value with its qualification.', scope: 'instance' })
  assert.equal(result.entry.source.messageId, 'fixture-user-source')
  assert.equal(result.entry.source.topicId, ctx.a.id)
  await ctx.aTools.get('superagent_memory').execute({ action: 'state', topic_id: ctx.b.id, expected_revision: 0, state: { result: 'Prepared, but verification remains pending.' } })
  assert.match(ctx.topics.get(ctx.a.id).state.result, /verification remains pending/)
  assert.equal(ctx.topics.get(ctx.b.id).stateRevision, 0)
  ctx.runtime.stop()
})

test('workers use the same bounded selection, retain late critical conditions and exclude another topic local facts', async () => {
  const ctx = setup()
  ctx.runtime.config.context = { maxChars: 2600 }
  for (let i = 0; i < 24; i++) await ctx.aTools.get('superagent_memory').execute({ action: 'save', key: `background-${i}`, text: 'Ordinary working background. '.repeat(6) })
  const condition = `${'The draft is prepared. '.repeat(15)}But it MUST NOT be published until the review passes.`
  await ctx.aTools.get('superagent_memory').execute({ action: 'save', key: 'release.condition', text: condition, priority: 'important' })
  await ctx.bTools.get('superagent_memory').execute({ action: 'save', key: 'private-local', text: 'OTHER-TOPIC-LOCAL fixture' })
  await ctx.aTools.get('superagent_dispatch').execute({ title: 'Check required conditions', brief: 'Verify before publishing.' })
  await tick()
  const prompt = JSON.stringify(ctx.subagents.spawns[0].spec.prompt)
  assert.ok(prompt.includes(condition))
  assert.doesNotMatch(prompt, /OTHER-TOPIC-LOCAL/)
  assert.match(prompt, /Omitted/)
  ctx.runtime.stop()
})

test('native direct user-message events capture query and source before a later context read', async () => {
  const ctx = setup()
  ctx.runtime.observeSessionEvent(ctx.first.session, { type: 'user/message', data: { role: 'user', id: 'native-fixture-source', content: [{ type: 'text', text: 'release certification review' }] } })
  for (const kind of ['runtime-context', 'time-context']) ctx.runtime.observeSessionEvent(ctx.first.session, { type: 'user/message', data: { role: 'user', id: `${kind}-snapshot`, source: { kind }, content: [{ type: 'text', text: 'Generated context must not replace the human request.' }] } })
  assert.equal(ctx.runtime.withConversation(ctx.aScope, () => ctx.runtime.topicInput().query), 'release certification review')
  const result = await ctx.aTools.get('superagent_memory').execute({ action: 'save', key: 'source', text: 'Current source test.' })
  assert.equal(result.entry.source.messageId, 'native-fixture-source')
  ctx.runtime.stop()
})
