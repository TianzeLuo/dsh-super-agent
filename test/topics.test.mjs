import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAIN_TOPIC_ID, TOPIC_LIMITS, TopicRecall, TopicRegistry } from '../lib/topics.js'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-topics-'))
  const registry = new TopicRegistry(home)
  registry.bind(MAIN_TOPIC_ID, 'session-overview')
  const a = registry.create('Writing')
  const b = registry.create('Development', 'private')
  registry.bind(a.id, 'session-writing')
  registry.bind(b.id, 'session-development')
  return { home, registry, a, b }
}

test('topic identity, notes, ownership and unread survive a reload independently of a runtime generation', () => {
  const { home, registry, a } = setup()
  registry.remember(a.id, 'Use a small release checklist.')
  registry.remember(a.id, 'The release is Friday.', true)
  registry.reply(a.id, 'Draft prepared; verification still pending.', 'message-draft')
  registry.addUnread(a.id)
  const loaded = new TopicRegistry(home)
  assert.equal(loaded.get(a.id).sessionId, 'session-writing')
  assert.equal(loaded.get(a.id).notes, 'Use a small release checklist.')
  assert.equal(loaded.sharedNotes, 'The release is Friday.')
  assert.equal(loaded.get(a.id).sourceMessageId, 'message-draft')
  assert.equal(loaded.get(a.id).unread, 1)
  assert.throws(() => loaded.bind(a.id, 'session-development'), /another topic/)
  assert.equal(loaded.get(a.id).sessionId, 'session-writing')
})

test('sharing never publishes a private title, notes or arbitrary session id', () => {
  const { registry, a, b } = setup()
  registry.update(b.id, { name: 'PRIVATE-IDENTITY', notes: 'PRIVATE-NOTE' })
  registry.reply(b.id, 'PRIVATE-REPLY', 'private-message')
  registry.updateState(b.id, { result: 'PRIVATE-STATE' }, 0)
  assert.doesNotMatch(JSON.stringify(registry.visible(a.id)), /PRIVATE|session-development/)
  assert.doesNotMatch(registry.context(a.id), /PRIVATE/)
  registry.update(b.id, { sharing: 'summary' })
  assert.match(registry.context(a.id), /PRIVATE-STATE/)
  assert.doesNotMatch(registry.context(a.id), /PRIVATE-REPLY/, 'reply prefixes are no longer injected as progress')
  assert.doesNotMatch(registry.context(a.id), /PRIVATE-NOTE|session-development/)
})

test('notes remain local unless instance scope is explicit, and overflow preserves the previous notes', () => {
  const { registry, a, b } = setup()
  registry.remember(a.id, 'ONLY-WRITING')
  registry.remember(a.id, 'ONLY-WRITING')
  registry.remember(a.id, 'COMMON-DECISION', true)
  assert.doesNotMatch(registry.context(b.id), /ONLY-WRITING/)
  assert.match(registry.context(b.id), /COMMON-DECISION/)
  assert.equal(registry.get(a.id).notes, 'ONLY-WRITING')
  assert.throws(() => registry.remember(a.id, 'x'.repeat(4000)), /memory text/)
  assert.equal(registry.get(a.id).notes, 'ONLY-WRITING')
  registry.remember(a.id, 'api_key=abcdefghijklmnop')
  assert.doesNotMatch(registry.get(a.id).notes, /abcdefghijklmnop/)
})

test('topic registry corruption is reported without overwriting the existing file', () => {
  const { home, registry } = setup()
  writeFileSync(registry.path, '{incomplete')
  assert.throws(() => new TopicRegistry(home))
  assert.equal(readFileSync(registry.path, 'utf8'), '{incomplete')
})

test('an external registry change rejects a sharing update without changing the in-memory access policy', () => {
  const { registry, b } = setup()
  const external = `${readFileSync(registry.path, 'utf8')} `
  writeFileSync(registry.path, external)
  assert.throws(() => registry.update(b.id, { sharing: 'history' }), /changed outside/)
  assert.equal(registry.get(b.id).sharing, 'private')
  assert.equal(readFileSync(registry.path, 'utf8'), external)
})

test('topic registry rejects symbolic-link write targets', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-topic-link-'))
  const registry = new TopicRegistry(home)
  const destination = join(home, 'original.json')
  writeFileSync(destination, 'original')
  registry.save()
  const alternate = new TopicRegistry(mkdtempSync(join(tmpdir(), 'dsh-super-agent-topic-link-')))
  alternate.path = join(home, 'linked.json')
  try { symlinkSync(destination, alternate.path, 'file') } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('host cannot create file symlinks'); return }
    throw error
  }
  assert.throws(() => alternate.save(), /symbolic link/)
  assert.equal(readFileSync(destination, 'utf8'), 'original')
})

test('status injection has a bounded number of other topics even with long multibyte text', () => {
  const { registry, a } = setup()
  for (let index = 0; index < 20; index++) {
    const row = registry.create(`${index} ${'主题'.repeat(20)}`)
    registry.updateState(row.id, { result: '进展'.repeat(100) }, 0)
  }
  const plan = registry.contextPlan(a.id, { maxChars: 3500 })
  const context = plan.text
  const count = plan.selected.filter((row) => row.kind === 'state').length
  assert.ok(count > 0 && count <= TOPIC_LIMITS.contextItems)
  assert.ok(context.length <= 3500)
  assert.ok(plan.omitted.length > 0)
  assert.match(context, /Omitted/)
})

test('summary recall does not read a transcript; denied history cannot touch the host', async () => {
  const { registry, a, b } = setup()
  let reads = 0
  const recall = new TopicRecall(registry, () => { reads++; return [] })
  const result = await recall.read(a.id, { topic_id: 'main' })
  assert.equal(result.messages.length, 0)
  assert.equal(reads, 0)
  await assert.rejects(recall.read(a.id, { topic_id: b.id }), /not shared/)
  await assert.rejects(recall.read(a.id, { topic_id: 'main', detail: 'messages' }), /status only/)
  await assert.rejects(recall.read(a.id, { topic_id: '../foreign-session', detail: 'messages' }), /not found/)
  assert.equal(reads, 0)
})

test('history retrieval returns cited visible messages, omits tool/thinking payloads, and has a real paging cursor', async () => {
  const { registry, a, b } = setup()
  registry.update(b.id, { sharing: 'history' })
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `discussion ${index}` }, { type: 'thinking', text: 'PRIVATE-REASONING' }] }))
  messages.push({ id: 'tool-secret', role: 'tool', content: 'PRIVATE-TOOL' })
  const seen = []
  const recall = new TopicRecall(registry, (sessionId) => { seen.push(sessionId); return messages })
  const first = await recall.read(a.id, { topic_id: b.id, detail: 'messages', limit: 3 })
  assert.deepEqual(first.messages.map((row) => row.id), ['m-9', 'm-10', 'm-11'])
  const second = await recall.read(a.id, { topic_id: b.id, detail: 'messages', before: first.next_before, query: 'discussion', limit: 3 })
  assert.deepEqual(second.messages.map((row) => row.id), ['m-6', 'm-7', 'm-8'])
  assert.deepEqual(seen, ['session-development', 'session-development'])
  assert.doesNotMatch(JSON.stringify([first, second]), /PRIVATE/)
})

test('history sharing withdrawal during a host read takes effect before returning content', async () => {
  const { registry, a, b } = setup()
  registry.update(b.id, { sharing: 'history' })
  const pending = Promise.withResolvers()
  const recall = new TopicRecall(registry, () => pending.promise)
  const read = recall.read(a.id, { topic_id: b.id, detail: 'messages' })
  registry.update(b.id, { sharing: 'private' })
  pending.resolve([{ id: 'secret', role: 'user', content: 'DO-NOT-RETURN' }])
  await assert.rejects(read, /withdrawn/)
})

test('history result and cumulative turn budget remain bounded under very large messages', async () => {
  const { registry, a } = setup()
  const messages = Array.from({ length: 30 }, (_, index) => ({ id: `m-${index}`, role: 'user', content: 'x'.repeat(40_000) }))
  const recall = new TopicRecall(registry, () => messages)
  recall.beginTurn(a.id, 1)
  const first = await recall.read(a.id, { detail: 'messages', max_chars: 3000 })
  const second = await recall.read(a.id, { detail: 'messages', max_chars: 3000 })
  assert.ok(JSON.stringify(first).length <= 3000)
  assert.ok(JSON.stringify(second).length <= 3000)
  assert.ok(JSON.stringify(first).length + JSON.stringify(second).length <= TOPIC_LIMITS.recall)
  assert.equal(first.truncated, true)
  await assert.rejects(recall.read(a.id), /budget exhausted/)
  recall.beginTurn(a.id, 1)
  await assert.rejects(recall.read(a.id), /budget exhausted/)
  recall.beginTurn(a.id, 2)
  assert.equal((await recall.read(a.id)).ok, true)
})

test('small recall budgets include escaped metadata, citations and the size field', async () => {
  const { registry, a } = setup()
  registry.update(a.id, { name: '"'.repeat(60) })
  registry.reply(a.id, '"'.repeat(180), 'source')
  const recall = new TopicRecall(registry, () => [{ id: 'message-source', role: 'user', content: '\\"'.repeat(8000) }])
  const result = await recall.read(a.id, { detail: 'messages', max_chars: 400 })
  assert.ok(JSON.stringify(result).length <= 400)
  assert.equal(result.truncated, true)
  assert.equal(result.topic.id, a.id)
})
