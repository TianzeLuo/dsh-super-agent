import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../lib/store.js'
import { TopicRegistry, MAIN_TOPIC_ID } from '../lib/topics.js'
import { createTools } from '../lib/tools.js'
import { fakeProject, fakeRouter, setupRuntime, tick } from './fake-host.mjs'

function setup(options = {}) {
  const project = options.project ?? fakeProject()
  const topics = options.topics ?? new TopicRegistry(project.root)
  const members = topics.list().filter((row) => row.id !== MAIN_TOPIC_ID)
  const a = members[0] ?? topics.create('Research fixture', 'private')
  const b = members[1] ?? topics.create('Writing fixture', 'private')
  const c = members[2] ?? topics.create('Review fixture', 'private')
  const native = options.native ?? new Map()
  const ctx = setupRuntime({ project, topics, store: options.store, config: options.config, readTopicMessages: () => [{ id: 'private-message', role: 'user', content: [{ type: 'text', text: 'PRIVATE-TRANSCRIPT-CANARY' }] }],
    resolveCollaboration: async (context) => {
      await options.beforeResolve?.(context)
      if (!native.has(context.id)) {
        const agent = fakeRouter(project.root)
        agent.id = `session-collaboration-${native.size}`
        agent.session.header.id = agent.id
        native.set(context.id, agent)
      }
      const current = ctx.runtime.collaboration.state.contexts.get(context.id)
      if (!current.sessionId) ctx.runtime.collaboration.save('context', { ...current, sessionId: native.get(context.id).id })
      return native.get(context.id)
    },
  })
  const board = ctx.runtime.collaboration
  const operator = (fn) => ctx.runtime.withConversation({ topicId: MAIN_TOPIC_ID, operator: true }, fn)
  if (!options.store) operator(() => {
    for (const topic of [MAIN_TOPIC_ID, a.id, b.id, c.id]) board.configure({ topic_id: topic, enabled: true, role: topic === a.id ? 'Research approved material only.' : 'Complete your assigned stage.' })
    board.configure({ primary_topic_id: a.id })
  })
  const personal = (topicId, fn) => ctx.runtime.withConversation({ topicId }, fn)
  const scopeFor = (request, topicId = request.assigneeTopicId) => {
    const context = board.contextFor(topicId, { groupId: request.groupId, requestId: request.id })
    return { topicId, contextId: context.id, agent: native.get(context.id) }
  }
  const scoped = (request, fn, topicId) => ctx.runtime.withConversation(scopeFor(request, topicId), fn)
  const finish = (request, value = 'Group response fixture') => {
    const agent = native.get(board.contextFor(request.assigneeTopicId, { groupId: request.groupId, requestId: request.id }).id)
    const message = { id: `answer-${agent.messages.length}`, role: 'assistant', content: [{ type: 'text', text: value }] }
    agent.messages.push(message)
    agent.ctx.emit('assistant/message', { message })
    agent.ctx.emit('turn/end', { turn: agent.messages.length })
    agent.finish()
  }
  return { ...ctx, project, topics, a, b, c, board, native, operator, personal, scopeFor, scoped, finish }
}
const request = (ctx, extra = {}) => ctx.operator(() => ctx.board.delegate({ to_topic_id: ctx.a.id, title: 'Research stage', brief: 'Check the approved facts. Do not publish externally.', idempotency_key: 'stage-one', ...extra }))

test('existing instances stay opted out and only the operator changes roles and primary selection', () => {
  const project = fakeProject()
  const topics = new TopicRegistry(project.root)
  const ctx = setupRuntime({ project, topics })
  const board = ctx.runtime.collaboration
  assert.equal(board.profile(MAIN_TOPIC_ID).enabled, false)
  assert.equal(board.state.settings.primaryTopicId, null)
  assert.throws(() => board.configure({ topic_id: MAIN_TOPIC_ID, enabled: true }), /human operator/)
  ctx.runtime.stop()
})

test('a primary is a logical target and never replaces the owning Router', async () => {
  const ctx = setup()
  const owner = ctx.runtime.agent
  const created = ctx.operator(() => ctx.board.delegate({ title: 'Use primary', brief: 'Return one finding.', idempotency_key: 'primary' }))
  assert.equal(created.assigneeTopicId, ctx.a.id)
  await ctx.board.pump()
  assert.equal(ctx.runtime.agent, owner)
  assert.equal(ctx.router.messages.length, 0)
  assert.equal(ctx.native.size, 1)
  assert.equal(ctx.board.state.contexts.get(ctx.scopeFor(created).contextId).sessionId, [...ctx.native.values()][0].id, 'opening a session must not lose its persisted pointer')
  assert.equal([...ctx.native.values()][0].messages[0].id, [...ctx.board.state.messages.values()][0].id, 'native input requires a stable identified message for restart validation')
  assert.match([...ctx.native.values()][0].messages[0].content[0].text, /Return one finding/)
  ctx.runtime.stop()
})

test('handoff preserves the request and origin, rejects stale revisions and revokes old ownership', async () => {
  const ctx = setup()
  const created = request(ctx)
  await ctx.board.pump()
  const current = ctx.board.state.requests.get(created.id)
  assert.throws(() => ctx.scoped(current, () => ctx.board.act({ action: 'handoff', request_id: current.id, expected_revision: 1, to_topic_id: ctx.b.id, message: 'Write from verified material.' })), /version conflict/)
  const next = ctx.scoped(current, () => ctx.board.act({ action: 'handoff', request_id: current.id, expected_revision: current.revision, to_topic_id: ctx.b.id, message: 'Write from verified material.' }))
  assert.equal(next.id, created.id)
  assert.equal(next.requesterTopicId, MAIN_TOPIC_ID)
  assert.equal(next.assigneeTopicId, ctx.b.id)
  assert.equal(next.transfers.length, 1)
  assert.throws(() => ctx.scoped(created, () => ctx.runtime.dispatch({ title: 'Wrong owner', brief: 'Must fail.' }), ctx.a.id), /current assignee/)
  ctx.finish(created)
  await ctx.board.pump()
  assert.equal(ctx.native.size, 2)
  ctx.runtime.stop()
})

test('retrying the same delegation is idempotent and disabled recipients are rejected', () => {
  const ctx = setup()
  const first = request(ctx)
  const retry = request(ctx)
  assert.equal(first.id, retry.id)
  assert.equal(ctx.board.state.requests.size, 1)
  ctx.operator(() => ctx.board.configure({ topic_id: ctx.b.id, enabled: false }))
  assert.throws(() => request(ctx, { to_topic_id: ctx.b.id, idempotency_key: 'disabled' }), /not enabled/)
  assert.throws(() => request(ctx, { to_topic_id: 'topic-other-instance', idempotency_key: 'foreign' }), /not enabled/)
  ctx.runtime.stop()
})

test('isolated contexts exclude even their own private history, memories and permissions', async () => {
  const ctx = setup()
  ctx.personal(ctx.a.id, () => ctx.runtime.topicMemory({ action: 'save', key: 'private.fact', text: 'PRIVATE-MEMORY-CANARY' }))
  const created = request(ctx)
  await ctx.board.pump()
  const delivered = JSON.stringify([...ctx.native.values()][0].messages)
  assert.doesNotMatch(delivered, /PRIVATE-MEMORY-CANARY|PRIVATE-TRANSCRIPT-CANARY/)
  assert.throws(() => ctx.scoped(created, () => ctx.runtime.topicMemory({ action: 'read', scope: 'topic' })), /private topic memories/)
  assert.throws(() => ctx.scoped(created, () => ctx.runtime.topicHistory({ topic_id: ctx.a.id, detail: 'messages' })), /private topic history/)
  assert.throws(() => ctx.scoped(created, () => ctx.board.configure({ paused: false })), /human operator/)
  assert.throws(() => ctx.scoped(created, () => ctx.runtime.saveAgreement({ text: 'Invented permission' })), /cannot change/)
  assert.throws(() => ctx.scoped(created, () => ctx.runtime.reply({ channel: 'github', text: 'Must not leave the group.' })), /must remain/)
  ctx.runtime.stop()
})

test('group posts target named members or the coordinator; ordinary Bot updates wake nobody', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Editorial fixture', members: [ctx.a.id, ctx.b.id], coordinator_id: ctx.a.id }))
  const post = ctx.operator(() => ctx.board.post({ group_id: group.id, message: 'Research these approved sources.', idempotency_key: 'kickoff' }))
  assert.equal(post.requests.length, 1)
  assert.equal(post.requests[0].assigneeTopicId, ctx.a.id)
  assert.equal(post.requests[0].requesterTopicId, null)
  await ctx.board.pump()
  const before = ctx.board.state.requests.size
  ctx.scoped(post.requests[0], () => ctx.board.post({ message: 'Research is in progress.' }))
  assert.equal(ctx.board.state.requests.size, before)
  assert.equal(ctx.native.size, 1)
  assert.throws(() => ctx.scoped(post.requests[0], () => ctx.board.post({ message: 'No broadcast.', to_topic_ids: [ctx.a.id, ctx.b.id] })), /one group member/)
  ctx.runtime.stop()
})

test('group membership bounds messages, memories, handoffs and cross-group publishing', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Restricted group', members: [ctx.a.id, ctx.b.id] }))
  const other = ctx.operator(() => ctx.board.createGroup({ name: 'Other group', members: [ctx.a.id, ctx.c.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  assert.throws(() => ctx.personal(ctx.c.id, () => ctx.board.messages({ group_id: group.id })), /group member/)
  assert.throws(() => ctx.personal(ctx.c.id, () => ctx.board.memory({ group_id: group.id, action: 'read' })), /group member/)
  const current = ctx.board.state.requests.get(created.id)
  assert.throws(() => ctx.scoped(current, () => ctx.board.act({ action: 'handoff', request_id: current.id, expected_revision: current.revision, to_topic_id: ctx.c.id, message: 'Outside.' })), /cannot leave/)
  assert.throws(() => ctx.scoped(current, () => ctx.board.post({ group_id: other.id, message: 'Outside.' })), /different|context|group/)
  ctx.runtime.stop()
})

test('group memories update by revision and remain separate from topic and instance memories', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Versioned memory fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  const first = ctx.scoped(created, () => ctx.runtime.topicMemory({ action: 'save', scope: 'group', key: 'deadline', text: 'Friday', priority: 'important' }))
  const next = ctx.scoped(created, () => ctx.runtime.topicMemory({ action: 'save', scope: 'group', id: first.entry.id, expected_revision: first.entry.revision, text: 'Wednesday' }))
  assert.throws(() => ctx.scoped(created, () => ctx.runtime.topicMemory({ action: 'save', scope: 'group', id: first.entry.id, expected_revision: first.entry.revision, text: 'Old Friday' })), /version conflict/)
  const plan = ctx.scoped(created, () => ctx.runtime.durableContextPlan())
  assert.match(plan.text, /Wednesday/)
  assert.doesNotMatch(plan.text, /Friday/)
  assert.equal(ctx.topics.sharedMemory.length, 0)
  assert.equal(ctx.topics.get(ctx.a.id).memory.length, 0)
  assert.equal(next.entry.revision, 2)
  ctx.runtime.stop()
})

test('group Worker reports retain group context and are unavailable to nonmembers', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Report scope fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  const started = ctx.scoped(created, () => ctx.runtime.dispatch({ title: 'Group Worker', brief: 'Return approved fixture evidence.' }))
  await tick()
  const task = ctx.store.getTask(started.taskId)
  assert.equal(task.collaborationRequestId, created.id)
  assert.equal(task.conversationId, ctx.scopeFor(created).contextId)
  assert.equal(ctx.personal(ctx.c.id, () => ctx.runtime.canRecallObject(task.id)), false)
  assert.equal(ctx.personal(ctx.c.id, () => ctx.runtime.status('full').tasks.some((row) => row.id === task.id)), false)
  assert.throws(() => ctx.scoped(created, () => ctx.board.act({ action: 'handoff', request_id: created.id, expected_revision: ctx.board.state.requests.get(created.id).revision, to_topic_id: ctx.b.id, message: 'Too early.' })), /active Workers/)
  ctx.finish(created, 'Worker dispatched; waiting for its report.')
  ctx.children.get(task.workerSessionId).finishTurn({ text: 'GROUP-ONLY-REPORT' })
  ctx.runtime.flushNow()
  const native = ctx.native.get(task.conversationId)
  assert.match(JSON.stringify(native.messages), /GROUP-ONLY-REPORT/)
  assert.equal(ctx.router.messages.length, 0)
  ctx.runtime.stop()
})

test('queued delivery and logical request ids survive a journal replay', async () => {
  const ctx = setup()
  const created = request(ctx)
  ctx.runtime.stop()
  ctx.store.close()
  const store = new Store({ dir: ctx.project.dataDir }).open()
  const reloaded = setup({ project: ctx.project, topics: ctx.topics, store })
  await reloaded.board.pump()
  assert.equal(reloaded.board.state.requests.size, 1)
  assert.equal(reloaded.board.state.requests.has(created.id), true)
  const agent = [...reloaded.native.values()][0]
  assert.equal(agent.messages.length, 1)
  await reloaded.board.pump()
  assert.equal(agent.messages.length, 1)
  reloaded.runtime.stop()
})

test('cancellation and revoking collaboration prevent pending execution', async () => {
  const ctx = setup()
  const created = request(ctx)
  ctx.operator(() => ctx.board.act({ action: 'cancel', request_id: created.id, expected_revision: created.revision }))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 0)
  const pending = request(ctx, { idempotency_key: 'revoked' })
  ctx.operator(() => ctx.board.configure({ topic_id: ctx.a.id, enabled: false }))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 0)
  assert.equal([...ctx.board.state.messages.values()].find((row) => row.requestId === pending.id).deliveries[ctx.a.id], 'cancelled')
  ctx.runtime.stop()
})

test('instance and group pauses preserve queued assignments and resume each delivery once', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Paused queue fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  ctx.operator(() => ctx.board.configure({ paused: true }))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 0)
  assert.equal(ctx.board.state.requests.get(created.id).status, 'queued')
  ctx.operator(() => { ctx.board.updateGroup(group.id, { paused: true }); ctx.board.configure({ paused: false }) })
  await ctx.board.pump()
  assert.equal(ctx.native.size, 0)
  ctx.operator(() => ctx.board.updateGroup(group.id, { paused: false }))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 1)
  const agent = [...ctx.native.values()][0]
  assert.equal(agent.messages.length, 1)
  await ctx.board.pump()
  assert.equal(agent.messages.length, 1)
  ctx.runtime.stop()
})

test('complete bounded context never silently cuts mandatory constraints', async () => {
  const ctx = setup({ config: { context: { maxChars: 1000 } } })
  request(ctx, { brief: `${'Required material '.repeat(100)} NEVER publish the draft.` })
  await ctx.board.pump()
  assert.equal([...ctx.native.values()][0].messages.length, 0)
  assert.match([...ctx.board.errors.values()][0], /complete.*budget/)
  ctx.runtime.stop()
})

test('model tool definitions expose cooperation but never settings and membership mutation', async () => {
  const ctx = setup()
  const tools = new Map(createTools(ctx.runtime, { topicId: ctx.a.id }).map((item) => [item.name, item]))
  const view = await tools.get('superagent_collaborate').execute({ action: 'list' })
  assert.equal(view.collaborators.length, 4)
  assert.equal(tools.get('superagent_collaborate').parameters.properties.action.enum.includes('configure'), false)
  assert.equal(tools.get('superagent_group').parameters.properties.action.enum.includes('create_group'), false)
  ctx.runtime.stop()
})

test('disabling a primary blocks its work, clears the role and requires explicit resume', async () => {
  const ctx = setup()
  const created = request(ctx)
  ctx.operator(() => ctx.board.configure({ topic_id: ctx.a.id, enabled: false }))
  assert.equal(ctx.board.state.settings.primaryTopicId, null)
  assert.equal(ctx.board.state.requests.get(created.id).status, 'blocked')
  ctx.operator(() => ctx.board.configure({ topic_id: ctx.a.id, enabled: true }))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 0)
  const pending = ctx.board.state.requests.get(created.id)
  ctx.operator(() => ctx.board.act({ action: 'resume', request_id: pending.id, expected_revision: pending.revision }))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 1)
  ctx.runtime.stop()
})

test('permission changes during asynchronous session creation prevent delivery', async () => {
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const ctx = setup({ beforeResolve: () => ready })
  const created = request(ctx)
  const pumping = ctx.board.pump()
  ctx.operator(() => ctx.board.configure({ topic_id: ctx.a.id, enabled: false }))
  release()
  await pumping
  assert.equal([...ctx.native.values()][0].messages.length, 0)
  assert.equal(ctx.board.state.requests.get(created.id).status, 'blocked')
  ctx.runtime.stop()
})

test('an assignment cannot overwrite newer handoffs while its native session is opening', async () => {
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const ctx = setup({ beforeResolve: () => ready })
  const created = request(ctx)
  const pumping = ctx.board.pump()
  const second = ctx.operator(() => ctx.board.act({ action: 'handoff', request_id: created.id, expected_revision: created.revision, to_topic_id: ctx.b.id, message: 'Intermediate brief.' }))
  const latest = ctx.operator(() => ctx.board.act({ action: 'handoff', request_id: created.id, expected_revision: second.revision, to_topic_id: ctx.a.id, message: 'LATEST-COMPLETE-BRIEF; do not revive the original instruction.' }))
  release()
  await pumping
  assert.equal(ctx.board.state.requests.get(created.id).revision, latest.revision)
  assert.equal([...ctx.native.values()][0].messages.length, 0)
  await ctx.board.pump()
  assert.equal(ctx.board.state.requests.get(created.id).transfers.length, 2)
  const agent = [...ctx.native.values()][0]
  assert.equal(agent.messages.length, 1)
  assert.match(JSON.stringify(agent.messages), /LATEST-COMPLETE-BRIEF/)
  ctx.runtime.stop()
})

test('a persisted group post repairs its missing requests without duplicate assignments', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Outbox fixture', members: [ctx.a.id, ctx.b.id] }))
  const original = ctx.board.dispatchPost
  ctx.board.dispatchPost = () => { throw new Error('simulated crash after journal append') }
  assert.throws(() => ctx.operator(() => ctx.board.post({ group_id: group.id, message: 'Durable group instruction.', to_topic_ids: [ctx.a.id, ctx.b.id], idempotency_key: 'post-replay' })), /simulated crash/)
  ctx.board.dispatchPost = original
  await ctx.board.pump()
  assert.equal(ctx.board.state.requests.size, 2)
  const retry = ctx.operator(() => ctx.board.post({ group_id: group.id, message: 'Durable group instruction.', to_topic_ids: [ctx.a.id, ctx.b.id], idempotency_key: 'post-replay' }))
  assert.equal(retry.requests.length, 2)
  assert.equal(ctx.board.state.requests.size, 2)
  assert.equal([...ctx.board.state.messages.values()].filter((row) => row.kind === 'human').length, 1)
  assert.equal(ctx.native.size, 1, 'one group turn runs at a time')
  ctx.runtime.stop()
})

test('nested coordination shares a finite budget and cancellation stops the whole request tree', async () => {
  const ctx = setup()
  const parent = request(ctx)
  await ctx.board.pump()
  const children = []
  for (let index = 0; index < 7; index++) children.push(ctx.scoped(parent, () => ctx.board.delegate({ to_topic_id: ctx.b.id, title: `Stage ${index}`, brief: 'Return a fact.', idempotency_key: `nested-${index}` })))
  assert.throws(() => ctx.scoped(parent, () => ctx.board.delegate({ to_topic_id: ctx.c.id, title: 'Too many', brief: 'This must stop.', idempotency_key: 'ninth' })), /automatic collaboration limit/)
  assert.throws(() => ctx.scoped(parent, () => ctx.board.act({ action: 'complete', request_id: parent.id, expected_revision: ctx.board.state.requests.get(parent.id).revision, message: 'Too early.' })), /active Workers or collaboration/)
  ctx.operator(() => ctx.board.act({ action: 'cancel', request_id: parent.id, expected_revision: ctx.board.state.requests.get(parent.id).revision }))
  assert.ok(children.every((row) => ctx.board.state.requests.get(row.id).status === 'cancelled'))
  await ctx.board.pump()
  assert.equal(ctx.native.size, 1)
  ctx.runtime.stop()
})

test('a coordinator can inspect its children and retry a completed delegation without starting another stage', async () => {
  const ctx = setup()
  const parent = request(ctx)
  await ctx.board.pump()
  const args = { to_topic_id: ctx.b.id, title: 'Child evidence', brief: 'Return the approved evidence.', idempotency_key: 'child-once' }
  const child = ctx.scoped(parent, () => ctx.board.delegate(args))
  assert.equal(ctx.scoped(parent, () => ctx.board.request(child.id)).id, child.id)
  assert.throws(() => ctx.scoped(child, () => ctx.board.request(parent.id)), /not available/)
  ctx.scoped(child, () => ctx.board.act({ action: 'complete', request_id: child.id, expected_revision: child.revision, message: 'Child evidence completed.' }))
  ctx.scoped(parent, () => ctx.board.act({ action: 'complete', request_id: parent.id, expected_revision: ctx.board.state.requests.get(parent.id).revision, message: 'Parent completed.' }))
  const retry = ctx.scoped(parent, () => ctx.board.delegate(args))
  assert.equal(retry.id, child.id)
  assert.equal(ctx.board.state.requests.size, 2)
  ctx.runtime.stop()
})

test('ordinary peers cannot steer another owner\'s group Worker', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Ownership fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  const result = ctx.scoped(created, () => ctx.runtime.dispatch({ title: 'Owned task', brief: 'Work on approved material.' }))
  await tick()
  assert.throws(() => ctx.personal(ctx.b.id, () => ctx.runtime.steer(result.taskId, 'Change owner work.')), /current assignee/)
  ctx.runtime.stop()
})

test('a completed group result is projected once, without the final acknowledgement', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Projection fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  ctx.scoped(created, () => ctx.board.act({ action: 'complete', request_id: created.id, expected_revision: ctx.board.state.requests.get(created.id).revision, message: 'Verified result.' }))
  ctx.finish(created, 'Acknowledgement that repeats Verified result.')
  const messages = ctx.operator(() => ctx.board.messages({ group_id: group.id })).messages
  assert.equal(messages.filter((row) => row.kind === 'result').length, 1)
  assert.equal(messages.filter((row) => row.kind === 'response').length, 0)
  ctx.runtime.stop()
})

test('an interrupted native turn is exposed for review rather than replayed blindly', async () => {
  const ctx = setup()
  const created = request(ctx)
  await ctx.board.pump()
  const native = ctx.native
  for (const agent of native.values()) agent.status = 'idle'
  ctx.runtime.stop()
  ctx.store.close()
  const reloaded = setup({ project: ctx.project, topics: ctx.topics, native, store: new Store({ dir: ctx.project.dataDir }).open() })
  await reloaded.board.pump()
  assert.equal([...native.values()][0].messages.length, 1)
  assert.equal(reloaded.board.state.requests.get(created.id).status, 'blocked')
  assert.match(reloaded.board.state.requests.get(created.id).result, /interrupted/)
  reloaded.runtime.stop()
})

test('a native response persisted before a restart is recovered exactly once', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Recovery fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  const native = ctx.native
  const agent = [...native.values()][0]
  agent.messages.push({ id: 'persisted-answer', role: 'assistant', content: [{ type: 'text', text: 'Recovered progress.' }] })
  agent.status = 'idle'
  ctx.runtime.stop()
  ctx.store.close()
  const reloaded = setup({ project: ctx.project, topics: ctx.topics, native, store: new Store({ dir: ctx.project.dataDir }).open() })
  await reloaded.board.pump()
  await reloaded.board.pump()
  assert.equal([...reloaded.board.state.messages.values()].filter((row) => row.kind === 'response').length, 1)
  reloaded.runtime.stop()
})

test('an explicit human delegation returns to its private conversation even if that topic opts out', async () => {
  const ctx = setup()
  ctx.operator(() => ctx.board.configure({ topic_id: MAIN_TOPIC_ID, enabled: false }))
  const created = request(ctx)
  await ctx.board.pump()
  ctx.scoped(created, () => ctx.board.act({ action: 'complete', request_id: created.id, expected_revision: ctx.board.state.requests.get(created.id).revision, message: 'Human-requested result.' }))
  ctx.finish(created)
  await ctx.board.pump()
  assert.equal(ctx.router.messages.length, 1)
  assert.match(JSON.stringify(ctx.router.messages), /Human-requested result/)
  ctx.router.finish()
  await ctx.board.pump()
  assert.equal(ctx.router.messages.length, 1)
  ctx.runtime.stop()
})

test('private human-facing callers may request a primary without accepting incoming collaboration', async () => {
  const ctx = setup()
  ctx.operator(() => ctx.board.configure({ topic_id: MAIN_TOPIC_ID, enabled: false }))
  const created = ctx.personal(MAIN_TOPIC_ID, () => ctx.board.delegate({ title: 'Ask a colleague', brief: 'Verify approved material.', idempotency_key: 'private-primary' }))
  assert.equal(created.assigneeTopicId, ctx.a.id)
  assert.equal(ctx.personal(MAIN_TOPIC_ID, () => ctx.board.request(created.id)).id, created.id)
  await ctx.board.pump()
  ctx.scoped(created, () => ctx.board.act({ action: 'complete', request_id: created.id, expected_revision: ctx.board.state.requests.get(created.id).revision, message: 'Private caller result.' }))
  ctx.finish(created)
  await ctx.board.pump()
  assert.match(JSON.stringify(ctx.router.messages), /Private caller result/)
  assert.throws(() => ctx.scoped(created, () => ctx.board.delegate({ to_topic_id: MAIN_TOPIC_ID, title: 'Unsolicited', brief: 'Should not wake opted-out chat.', idempotency_key: 'unsolicited' })), /not enabled/)
  ctx.runtime.stop()
})

test('cancelled requests keep reports recallable without waking their old owner', async () => {
  const ctx = setup()
  const created = request(ctx)
  await ctx.board.pump()
  const started = ctx.scoped(created, () => ctx.runtime.dispatch({ title: 'Pending report fixture', brief: 'Compute a fixture result.' }))
  await tick()
  ctx.finish(created)
  const task = ctx.store.getTask(started.taskId)
  ctx.children.get(task.workerSessionId).finishTurn({ text: 'Pending report before cancellation.' })
  ctx.operator(() => ctx.board.act({ action: 'cancel', request_id: created.id, expected_revision: ctx.board.state.requests.get(created.id).revision }))
  const agent = [...ctx.native.values()][0]
  const before = agent.messages.length
  ctx.runtime.flushNow()
  assert.equal(agent.messages.length, before)
  assert.ok(ctx.store.getTask(started.taskId).reports.length)
  assert.equal(ctx.store.pendingTriggers().length, 0)
  ctx.runtime.stop()
})

test('group facts override same-key instance facts and important qualifiers survive a tight budget', async () => {
  const ctx = setup({ config: { context: { maxChars: 3000 } } })
  ctx.operator(() => ctx.runtime.topicMemory({ action: 'save', scope: 'instance', key: 'release.deadline', text: 'OUTDATED-INSTANCE-FRIDAY', priority: 'important' }))
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Budget fixture', members: [ctx.a.id, ctx.b.id] }))
  const critical = ctx.operator(() => ctx.board.memory({ group_id: group.id, action: 'save', key: 'release.deadline', text: 'Wednesday. Draft only; approval has NOT been granted.', priority: 'important' })).entry
  for (let index = 0; index < 15; index++) ctx.operator(() => ctx.board.memory({ group_id: group.id, action: 'save', key: `background.${index}`, text: `Optional background ${index}. `.repeat(12) }))
  const created = request(ctx, { group_id: group.id, brief: 'Check the release deadline and approval condition.' })
  await ctx.board.pump()
  const plan = ctx.scoped(created, () => ctx.runtime.durableContextPlan())
  assert.ok(plan.usedChars <= 3000)
  assert.equal(plan.importantOmitted, 0)
  assert.equal(plan.selected.find((row) => row.id === critical.id).scope, 'group')
  assert.match(plan.text, /Wednesday\. Draft only; approval has NOT been granted\./)
  assert.doesNotMatch(plan.text, /OUTDATED-INSTANCE-FRIDAY/)
  assert.ok(plan.omitted.some((row) => row.kind === 'memory'))
  ctx.runtime.stop()
})

test('watchdog messages retain group provenance instead of leaking into private summaries', async () => {
  const ctx = setup()
  const group = ctx.operator(() => ctx.board.createGroup({ name: 'Watchdog fixture', members: [ctx.a.id, ctx.b.id] }))
  const created = request(ctx, { group_id: group.id })
  await ctx.board.pump()
  const started = ctx.scoped(created, () => ctx.runtime.dispatch({ title: 'GROUP-ONLY-WATCHDOG', brief: 'Approved synthetic material.' }))
  await tick()
  const task = ctx.store.getTask(started.taskId)
  ctx.children.get(task.workerSessionId).status = 'idle'
  ctx.runtime.now = () => Date.now() + 600_000
  ctx.runtime.checkNow()
  const watchdog = [...ctx.store.triggers.values()].find((row) => row.source === 'watchdog')
  assert.ok(watchdog)
  assert.equal(watchdog.conversationId, task.conversationId)
  assert.equal(watchdog.collaborationRequestId, created.id)
  assert.equal(ctx.personal(ctx.c.id, () => ctx.runtime.canRecallObject(watchdog.id)), false)
  assert.equal(ctx.router.messages.length, 0)
  ctx.runtime.stop()
})
