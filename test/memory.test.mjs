import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TopicRegistry } from '../lib/topics.js'
import { MEMORY_LIMITS } from '../lib/memory.js'
import { renderAgreements } from '../lib/agreements.js'

function setup() {
  let time = 100
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const registry = new TopicRegistry(home, { now: () => ++time })
  const a = registry.create('Release')
  const b = registry.create('Reader')
  const save = (key, text, extra = {}) => registry.memoryAction(a.id, { action: 'save', key, text, ...extra }).entry
  return { home, registry, a, b, save }
}

test('same-key updates replace facts, preserve bounded previous versions and survive restart', () => {
  const { home, registry, a, save } = setup()
  let current = save('release.deadline', 'Deadline is March 1.', { scope: 'instance' })
  for (let i = 2; i <= 9; i++) current = save('RELEASE.DEADLINE', `Deadline is March ${i}.`, { scope: 'instance', expected_revision: current.revision })
  assert.equal(current.revision, 9)
  assert.equal(registry.sharedMemory.length, 1)
  const loaded = new TopicRegistry(home)
  const read = loaded.memoryAction(a.id, { action: 'read' })
  assert.equal(read.entries.length, 1)
  assert.equal(read.entries[0].text, 'Deadline is March 9.')
  assert.doesNotMatch(JSON.stringify(read), /March [1-8]\./)
  assert.equal(loaded.sharedMemory[0].history.length, MEMORY_LIMITS.history)
  assert.equal(loaded.sharedMemory[0].source.topicId, a.id)
})

test('a stale correction, archive or same-name create cannot overwrite the current revision', () => {
  const { registry, a, save } = setup()
  const old = save('owner', 'Owner is Alice.')
  const latest = save('owner', 'Owner is Bob.', { expected_revision: old.revision })
  assert.throws(() => save('owner', 'Owner is Charlie.', { expected_revision: old.revision }), /version conflict/)
  assert.throws(() => registry.memoryAction(a.id, { action: 'archive', id: old.id, expected_revision: old.revision }), /version conflict/)
  assert.throws(() => save('owner', 'Owner is stale.'), /version conflict/)
  assert.equal(registry.memoryAction(a.id, { action: 'read', id: latest.id }).entries[0].text, 'Owner is Bob.')
  registry.update(a.id, { notes: '', notes_revision: registry.get(a.id).memoryRevision })
  assert.throws(() => save('owner', 'Old writer must not resurrect Alice.', { expected_revision: old.revision }), /version conflict/)
  assert.equal(registry.memoryAction(a.id, { action: 'read' }).entries.length, 0)
})

test('archive withdraws even an important fact from defaults and context; restoration is explicit', () => {
  const { home, registry, a, save } = setup()
  const entry = save('approval', 'Temporary approval is valid.', { priority: 'important' })
  const archived = registry.memoryAction(a.id, { action: 'archive', id: entry.id, expected_revision: 1 }).entry
  assert.doesNotMatch(registry.context(a.id), /Temporary approval/)
  assert.equal(registry.memoryAction(a.id, { action: 'read' }).entries.length, 0)
  const loaded = new TopicRegistry(home)
  assert.equal(loaded.memoryAction(a.id, { action: 'read', include_archived: true }).entries[0].status, 'archived')
  loaded.memoryAction(a.id, { action: 'restore', id: entry.id, expected_revision: archived.revision })
  assert.match(loaded.context(a.id), /Temporary approval/)
})

test('local facts override same-name shared facts only in that topic; neither leaks to another local scope', () => {
  const { registry, a, b, save } = setup()
  save('deadline', 'Shared deadline is Friday.', { scope: 'instance' })
  save('deadline', 'Local exception is Monday.')
  assert.match(registry.context(a.id), /Local exception is Monday/)
  assert.doesNotMatch(registry.context(a.id), /Shared deadline is Friday/)
  assert.match(registry.context(b.id), /Shared deadline is Friday/)
  assert.doesNotMatch(registry.context(b.id), /Local exception/)
  const read = registry.memoryAction(a.id, { action: 'read' })
  assert.equal(read.entries.length, 1)
  assert.equal(registry.memoryAction(a.id, { action: 'read', scope: 'instance' }).entries[0].effective, false)
})

test('late important facts survive a saturated budget with their complete trailing qualification', () => {
  const { registry, a, save } = setup()
  for (let i = 0; i < 50; i++) save(`ordinary-${i}`, `Background fact ${i}. ${'Routine planning information. '.repeat(8)}`)
  const text = `${'The release package was prepared. '.repeat(14)}However it MUST NOT be released until the safety review passes.`
  const critical = save('release.condition', text, { priority: 'important' })
  const plan = registry.contextPlan(a.id, { maxChars: 3000 })
  assert.ok(plan.usedChars <= 3000)
  assert.ok(plan.omitted.length > 0)
  assert.ok(plan.selected.some((row) => row.id === critical.id))
  assert.ok(plan.text.includes(text), 'whole negative qualification must survive')
  assert.equal(plan.importantOmitted, 0)
  const oldPrefix = registry.get(a.id).notes.slice(0, 2000)
  assert.ok(!oldPrefix.includes('MUST NOT'), 'the old prefix baseline misses this late condition')
  const omitted = plan.omitted.find((row) => row.kind === 'memory')
  const exact = registry.memoryAction(a.id, { action: 'read', id: omitted.id })
  assert.equal(exact.entries[0].text, omitted.text)
})

test('important overflow is explicit; no record body or negation is partially injected', () => {
  const { registry, a, save } = setup()
  for (let i = 0; i < 8; i++) save(`critical-${i}`, `${'Required condition. '.repeat(35)}Do not approve item ${i}.`, { priority: 'important' })
  const plan = registry.contextPlan(a.id, { maxChars: 2200 })
  assert.ok(plan.importantOmitted > 0)
  assert.match(plan.text, /IMPORTANT:.*required item\(s\) omitted/)
  assert.ok(plan.usedChars <= 2200)
  for (const entry of plan.selected) assert.ok(plan.text.includes(entry.text))
  for (const entry of plan.omitted) assert.ok(!plan.text.includes(entry.text))
})

test('memory reads page complete records with actual serialized bounds and no historical values by default', () => {
  const { registry, a, save } = setup()
  for (let i = 0; i < 30; i++) save(`row-${i}`, `Row ${i}: ${'Quoted "data" \\ '.repeat(25)}`)
  const seen = []
  let after
  do {
    const result = registry.memoryAction(a.id, { action: 'read', max_chars: 2000, after })
    assert.ok(JSON.stringify(result).length <= 2000)
    assert.ok(result.entries.every((row) => row.text.endsWith('\\')))
    seen.push(...result.entries.map((row) => row.id))
    after = result.next_after
  } while (after)
  assert.equal(seen.length, 30)
  assert.equal(new Set(seen).size, 30)
})

test('legacy multiline text migrates intact with deterministic ids and can be queried when not selected', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-v1-'))
  mkdirSync(join(home, '.dsh'))
  const original = `${'Original background.\n'.repeat(150)}BUT DO NOT RELEASE.`
  const path = join(home, '.dsh', 'super-agent.topics.json')
  writeFileSync(path, JSON.stringify({ version: 1, sharedNotes: original, topics: [{ id: 'main', name: 'Overview', sharing: 'summary', notes: '', summary: '' }] }))
  const one = new TopicRegistry(home)
  const two = new TopicRegistry(home)
  assert.equal(one.sharedMemory[0].id, two.sharedMemory[0].id)
  assert.equal(one.sharedMemory[0].text, original)
  const plan = one.contextPlan('main', { maxChars: 1500 })
  assert.equal(plan.selected.length, 0)
  assert.ok(!plan.text.includes('Original background'))
  assert.equal(one.memoryAction('main', { action: 'read', id: one.sharedMemory[0].id }).entries[0].text, original)
  one.save()
  assert.equal(JSON.parse(readFileSync(`${path}.v1-backup`, 'utf8')).sharedNotes, original)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2)
  assert.equal(new TopicRegistry(home).sharedMemory[0].text, original)
})

test('identical migrated text in different scopes has distinct ids and a correct effective flag', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-scoped-v1-'))
  mkdirSync(join(home, '.dsh'))
  writeFileSync(join(home, '.dsh', 'super-agent.topics.json'), JSON.stringify({ version: 1, sharedNotes: 'Same legacy fact.', topics: [{ id: 'main', name: 'Overview', sharing: 'summary', notes: 'Same legacy fact.', summary: '' }] }))
  const registry = new TopicRegistry(home)
  const local = registry.get('main').memory[0]
  const shared = registry.sharedMemory[0]
  assert.notEqual(local.id, shared.id)
  assert.equal(registry.memoryAction('main', { action: 'read', scope: 'instance' }).entries[0].effective, false)
  assert.deepEqual(registry.memoryAction('main', { action: 'read' }).entries.map((row) => row.id), [local.id])
})

test('bulk legacy replacement rejects an outdated collection and preserves keyed updates', () => {
  const { registry, a, save } = setup()
  save('latest', 'Do not discard this fact.', { scope: 'instance' })
  assert.throws(() => registry.setSharedNotes('Stale form', a.id), /version conflict/)
  assert.match(registry.sharedNotes, /Do not discard/)
})

test('topic progress preserves full fields, uses state time, and favors a relevant old state over unrelated new ones', () => {
  const { registry, a, save } = setup()
  const source = registry.create('Release review')
  registry.updateState(source.id, { goal: 'Review release', result: 'Package prepared; safety checks NOT passed.', blocker: 'Safety approval missing.', next_step: 'Wait for approval.' }, 0)
  for (let i = 0; i < 10; i++) {
    const row = registry.create(`Unrelated ${i}`)
    registry.updateState(row.id, { result: `Unrelated update ${i}` }, 0)
  }
  for (let i = 0; i < 25; i++) save(`ordinary-${i}`, 'Unrelated exhibition background. '.repeat(7))
  const plan = registry.contextPlan(a.id, { query: 'release safety review', maxChars: 3000 })
  assert.ok(plan.selected.some((row) => row.id === source.id))
  assert.match(plan.text, /safety checks NOT passed/)
  assert.throws(() => registry.updateState(source.id, { result: 'x'.repeat(241) }, 1), /state.result/)
  assert.throws(() => registry.updateState(source.id, { result: 'Stale' }, 0), /version conflict/)
  registry.update(source.id, { sharing: 'private' })
  assert.doesNotMatch(registry.context(a.id), /safety checks NOT passed/)
})

test('an oversized agreement is never clipped into a misleading approval', () => {
  const text = `${'Release prepared. '.repeat(40)}But approval is still missing.`
  const agreements = [{ id: 'agr_large', title: 'Release condition', text, project: '', updatedAt: 1 }, { id: 'agr_small', title: 'Short', text: 'Do not publish.', project: '', updatedAt: 2 }]
  const result = renderAgreements(agreements, { maxChars: 100 })
  assert.equal(result.shown, 1)
  assert.match(result.text, /Do not publish/)
  assert.doesNotMatch(result.text, /Release prepared/)
})

test('archiving an obsolete fact frees active capacity, while restoring at capacity preserves the archived state', () => {
  const { registry, a, save } = setup()
  let first
  for (let i = 0; i < MEMORY_LIMITS.entries; i++) {
    const entry = save(`capacity-${i}`, `Current fact ${i}.`)
    first ??= entry
  }
  assert.throws(() => save('new-fact', 'Cannot silently evict another fact.'), /active memories/)
  const archived = registry.memoryAction(a.id, { action: 'archive', id: first.id, expected_revision: first.revision }).entry
  save('new-fact', 'New current fact without losing archived evidence.')
  assert.equal(registry.get(a.id).memory.length, MEMORY_LIMITS.entries + 1)
  assert.throws(() => registry.memoryAction(a.id, { action: 'restore', id: first.id, expected_revision: archived.revision }), /active memories/)
  assert.equal(registry.get(a.id).memory.find((entry) => entry.id === first.id).status, 'archived')
})

test('minimum budgets retain their warning even with long multibyte topic and memory names', () => {
  const { registry, a, save } = setup()
  registry.update(a.id, { name: '🐣'.repeat(60) })
  for (let i = 0; i < 4; i++) save(`${i}${'🐣'.repeat(60)}`, 'A complete required condition. '.repeat(20), { priority: 'important' })
  const plan = registry.contextPlan(a.id, { maxChars: 1000 })
  assert.ok(plan.importantOmitted > 0)
  assert.ok(plan.usedChars <= 1000)
  assert.match(plan.text, /THIS request/)
})
