import assert from 'node:assert/strict'
import test from 'node:test'
import { changeMemory } from '../lib/memory.js'
import { MemoryReview, memoryEvidence, memorySnapshot, applyMemoryOperations } from '../lib/memory-review.js'
import { TopicRegistry } from '../lib/topics.js'
import { fakeProject, tick } from './fake-host.mjs'

const message = (id, text, role = 'user') => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'user' } })
const fact = (key, text, kind = 'consolidation') => changeMemory([], { action: 'save', key, text }, { kind }, 10).entry
const operation = (entry, text, evidence = ['u2']) => ({ action: 'save', id: entry.id, text, evidence, reason: 'The user corrected the previous value.' })

function fixture(options = {}) {
  let now = 100, enabled = true
  const idleMs = options.idleMs ?? 1000
  const data = { entries: options.entries ?? [], review: {}, busy: false, messages: options.messages ?? [message('u1', 'For future releases, Linux verification is required.')], calls: [], checks: [] }
  const target = () => ({ ...data, fingerprint: memorySnapshot(data.entries), messages: () => data.messages,
    commit(snapshot, entries, review) { assert.equal(memorySnapshot(data.entries), snapshot); data.entries = entries; data.review = review },
    record(review) { data.review = review },
  })
  const manager = new MemoryReview({ targets: () => ['topic:a'], target, enabled: () => enabled, now: () => now, idleMs,
    generate: async (request) => {
      const input = JSON.parse(request.input)
      if (input.phase === 'evidence_check') {
        data.checks.push(input)
        return options.verify ? options.verify(input, data) : approved(input)
      }
      data.calls.push(input)
      return options.generate ? options.generate(request, data) : JSON.stringify({ operations: [], reason: 'No useful durable change.' })
    },
  })
  return { data, manager, target, advance: (duration = idleMs + 1) => { now += duration }, disable: () => { enabled = false } }
}

const approved = (input) => JSON.stringify({ checks: input.changes.map(({ index }) => ({ index, supported: true, reason: 'Checked the fixture evidence.' })) })

test('evidence excludes tools, reasoning and generated snapshots; oversized messages are omitted whole', () => {
  const evidence = memoryEvidence([
    message('u1', 'Earlier context.'), message('u2', 'Do not remember the provisional choice.'),
    { ...message('snap', 'INTERNAL SNAPSHOT'), source: { kind: 'runtime-context' } },
    { id: 'tool', role: 'tool', content: 'TOOL SECRET' },
    { id: 'reason', role: 'assistant', content: [{ type: 'thinking', text: 'REASONING SECRET' }] },
    message('large', 'Oversized provisional choice. '.repeat(4000)), message('u3', 'Use Linux only after approval.'),
  ], 'u1')
  assert.deepEqual(evidence.messages.map((row) => row.id), ['u1', 'u2', 'u3'])
  assert.equal(evidence.messages[0].new, false)
  assert.equal(evidence.messages[1].new, true)
  assert.deepEqual(evidence.omittedIds, ['large'])
  assert.doesNotMatch(JSON.stringify(evidence), /INTERNAL SNAPSHOT|TOOL SECRET|REASONING SECRET|Oversized provisional/)
})

test('organization updates the same fact, archives redundancy, keeps qualifiers and records a no-op cursor', async () => {
  const old = fact('release.policy', 'Verify on Linux and Windows before publishing.')
  const duplicate = fact('release.policy.copy', old.text)
  let pass = 0
  const f = fixture({ entries: [old, duplicate], messages: [message('u2', 'The default is now Linux only, but publishing still requires approval.')], generate: () => JSON.stringify(++pass === 1
    ? { operations: [operation(old, 'Verify on Linux only; do not publish without approval.'), { action: 'archive', id: duplicate.id, evidence: [`memory:${old.id}`, `memory:${duplicate.id}`], reason: 'Duplicate merged into the release policy.' }], reason: 'Updated policy; duplicate archived.' }
    : { operations: [], reason: 'Current facts are already concise.' }) })
  await f.manager.organize('topic:a')
  assert.equal(f.data.entries.length, 2)
  assert.equal(f.data.entries[0].revision, 2)
  assert.equal(f.data.entries[0].text, 'Verify on Linux only; do not publish without approval.')
  assert.equal(f.data.entries[1].status, 'archived')
  assert.equal(f.data.review.cursor, 'u2')
  assert.equal(f.data.checks[0].changes.length, 2)
  await f.manager.organize('topic:a', { manual: true })
  assert.equal(f.data.entries[0].revision, 2, 'a no-op cannot rewrite the version')
  assert.equal(f.data.review.outcome, 'unchanged')
  assert.equal(f.data.checks.length, 1, 'a no-op requires no evidence model call')
})

test('invalid plans cannot partially change memory, expand scope or resurrect archived facts', () => {
  const old = fact('policy', 'Keep the original qualification.')
  const archived = changeMemory([old], { action: 'archive', id: old.id, expected_revision: 1 }, {}, 20).entry
  const evidence = memoryEvidence([message('u2', 'A confirmed correction.')])
  for (const bad of [
    { ...operation(old, 'Changed.'), scope: 'instance' },
    operation({ id: 'mem_unknown' }, 'Unknown scope.'),
    operation(old, 'Changed.', ['nonexistent-evidence']),
    operation(archived, 'Resurrected.'),
  ]) {
    const entries = bad.id === archived.id && bad.text === 'Resurrected.' ? [archived] : [old]
    const snapshot = memorySnapshot(entries)
    assert.throws(() => applyMemoryOperations(entries, { operations: [bad] }, evidence, {}, 30))
    assert.equal(memorySnapshot(entries), snapshot)
  }
  assert.throws(() => applyMemoryOperations([old], { operations: [operation(old, 'First.'), operation(old, 'Second.')] }, evidence, {}, 30), /Repeated/)
  assert.equal(old.text, 'Keep the original qualification.')
})

test('automatic organization preserves explicit memories; manual consolidation can refine them without losing protection', () => {
  const entry = fact('user.preference', 'Use English for public API names; write explanations in Chinese.', 'explicit')
  const evidence = memoryEvidence([message('u2', 'Please organize my saved preferences.')])
  const reply = { operations: [operation(entry, 'Public API names: English. Explanations: Chinese.', [`memory:${entry.id}`])] }
  assert.throws(() => applyMemoryOperations([entry], reply, evidence, {}, 30), /user-saved/)
  const result = applyMemoryOperations([entry], reply, evidence, { kind: 'consolidation' }, 30, { manual: true })
  assert.equal(result.entries[0].protected, true)
})

test('new facts require fresh human evidence, not an assistant assertion or old context', () => {
  const evidence = memoryEvidence([message('u1', 'Earlier one-off request.'), message('a1', 'I verified everything.', 'assistant')], 'u1')
  for (const id of ['u1', 'a1']) assert.throws(() => applyMemoryOperations([], { operations: [{ action: 'save', key: 'verified', text: 'Everything is verified.', evidence: [id], reason: 'Unjustified assertion.' }] }, evidence, {}, 30), /new human evidence/)
})

test('one repair receives the validator error and original evidence, then commits the grounded plan', async () => {
  const saved = { action: 'save', key: 'release.check', text: 'Verify releases on Linux.', evidence: ['u1'], reason: 'The user stated a lasting release requirement.' }
  const rejected = { ...saved, text: 'Unverified draft.', evidence: ['a1'] }
  let input
  const f = fixture({ messages: [message('u1', 'For future releases, verify on Linux.'), message('a1', 'I will verify the current run.', 'assistant')],
    generate: (request, data) => {
      if (data.calls.length === 1) {
        input = JSON.parse(request.input)
        return JSON.stringify({ operations: [rejected] })
      }
      const { validation_feedback, ...retry } = JSON.parse(request.input)
      assert.deepEqual(retry, input)
      assert.match(validation_feedback, /New memory requires new human evidence/)
      assert.doesNotMatch(request.input, /Unverified draft/)
      assert.deepEqual(data.entries, [])
      assert.deepEqual(data.review, {})
      return { text: JSON.stringify({ operations: [saved], reason: 'Kept the release requirement.' }), provider: 'qoder', model: 'dfmodel' }
    },
  })
  const result = await f.manager.organize('topic:a')
  assert.equal(f.data.calls.length, 2)
  assert.equal(f.data.checks.length, 1)
  assert.equal(result.review.cursor, 'a1')
  assert.equal(result.review.outcome, 'updated')
  assert.equal(result.review.model, 'qoder/dfmodel')
  assert.deepEqual(f.data.entries.map((entry) => [entry.key, entry.text, entry.source.evidence]), [[saved.key, saved.text, ['u1']]])
})

test('a valid source ID cannot bypass review of an unrelated clause in the proposed text', async () => {
  const grounded = 'Public release requires Windows and Linux compatibility checks and maintainer approval.'
  const invented = ' Keep the acceptance records permanently and use blue buttons.'
  const candidate = { action: 'save', key: 'release', evidence: ['u1'], reason: 'Confirmed release requirements.' }
  const f = fixture({ messages: [message('u1', `${grounded} Blue is for this preview only.`), message('a1', 'Unrelated assistant draft.', 'assistant')],
    generate: ({ input }, data) => {
      assert.deepEqual(data.entries, [], 'the initial proposal remains uncommitted during repair')
      const { validation_feedback } = JSON.parse(input)
      if (data.calls.length === 2) assert.match(validation_feedback, /Permanent retention and blue buttons/)
      return JSON.stringify({ operations: [{ ...candidate, text: data.calls.length === 1 ? grounded + invented : grounded }] })
    },
    verify: (input, data) => {
      assert.deepEqual(input.messages.map(({ id }) => id), ['u1'])
      assert.deepEqual(input.changes[0].evidence, ['u1'])
      return data.checks.length === 1 ? JSON.stringify({ checks: [{ index: 1, supported: false, reason: 'Permanent retention and blue buttons lack lasting user evidence.' }] }) : approved(input)
    },
  })
  await f.manager.organize('topic:a')
  assert.equal(f.data.checks.length, 2)
  assert.equal(f.data.entries[0].text, grounded)
})

test('incomplete evidence verdicts cannot commit half a plan, even after retry', async () => {
  const prior = fact('release', 'Check Windows and wait for review.')
  const f = fixture({ entries: [prior], messages: [message('u2', 'Also check Linux and keep the staging environment isolated.')],
    generate: () => JSON.stringify({ operations: [operation(prior, 'Check Windows and Linux and wait for review.'),
      { action: 'save', key: 'staging', text: 'Keep staging isolated.', evidence: ['u2'], reason: 'Confirmed requirement.' }] }),
    verify: () => JSON.stringify({ checks: [{ index: 1, supported: true, reason: 'Applicable.' }] }),
  })
  await assert.rejects(f.manager.organize('topic:a'), /did not cover every change/)
  assert.equal(f.data.checks.length, 2)
  assert.deepEqual(f.data.entries, [prior])
  assert.equal(f.data.review.attempted, 'u2')
  assert.equal(f.data.review.cursor, undefined)
})

test('a newer human message during evidence checking invalidates the approved plan', async () => {
  const f = fixture({
    generate: () => JSON.stringify({ operations: [{ action: 'save', key: 'release', text: 'Verify on Linux.', evidence: ['u1'], reason: 'Required test.' }] }),
    verify(input, data) { data.messages.push(message('u2', 'Use Windows instead.')); return approved(input) },
  })
  await assert.rejects(f.manager.organize('topic:a'), /inputs changed/)
  assert.equal(f.data.calls.length, 1)
  assert.deepEqual(f.data.entries, [])
})

test('an invalid repair preserves all entries and the last successful cursor and stops after two calls', async () => {
  const old = fact('release.policy', 'Run the original checks.')
  const invalid = { action: 'save', key: 'unverified', text: 'Unverified assertion.', evidence: ['a1'], reason: 'No human evidence.' }
  const f = fixture({ entries: [old], messages: [message('u1', 'Original policy.'), message('u2', 'Update the existing policy.'), message('a1', 'Everything is verified.', 'assistant')],
    generate: () => JSON.stringify({ operations: [operation(old, 'Run the new checks.'), invalid] }),
  })
  f.data.review = { cursor: 'u1', outcome: 'unchanged' }
  await assert.rejects(f.manager.organize('topic:a'), /new human evidence/)
  assert.equal(f.data.calls.length, 2)
  assert.deepEqual(f.data.entries, [old])
  assert.equal(f.data.review.cursor, 'u1')
  assert.equal(f.data.review.attempted, 'a1')
  assert.equal(f.data.review.outcome, 'error')
  assert.match(f.data.review.reason, /new human evidence/)
})

test('changed input aborts validation or repair without committing an outdated plan', async () => {
  for (const changeOnCall of [1, 2]) {
    const f = fixture({ generate: (_request, data) => {
      if (data.calls.length === changeOnCall) data.messages.push(message('u2', 'A later correction.'))
      return data.calls.length === 1 ? 'invalid JSON' : JSON.stringify({ operations: [], reason: 'No useful change.' })
    } })
    await assert.rejects(f.manager.organize('topic:a'), /inputs changed/)
    assert.equal(f.data.calls.length, changeOnCall)
    assert.deepEqual(f.data.entries, [])
    assert.equal(f.data.review.cursor, undefined)
    assert.equal(f.data.review.attempted, 'u1')
  }
})

test('manual reconsideration accepts older human evidence and canonicalizes only visible memory references', () => {
  const entry = fact('existing', 'A durable fact.', 'operator')
  const evidence = memoryEvidence([message('u1', 'A confirmed lasting default.')], 'u1')
  const result = applyMemoryOperations([entry], { operations: [operation(entry, 'A concise durable fact.', [entry.id]), { action: 'save', key: 'new-default', text: 'A confirmed lasting default.', evidence: ['u1'], reason: 'Manual reconsideration of complete human evidence.' }] }, evidence, { kind: 'consolidation' }, 30, { manual: true })
  assert.deepEqual(result.entries[0].source.evidence, [`memory:${entry.id}`])
  assert.equal(result.entries.length, 2)
})

test('a merge at full capacity archives redundancy before adding a distilled fact', () => {
  const entries = Array.from({ length: 128 }, (_, n) => fact(`key-${n}`, `Fact ${n}.`))
  const evidence = memoryEvidence([message('u2', 'Always run the compatibility test before release.')])
  const reply = { operations: [{ action: 'save', key: 'release.check', text: 'Run compatibility tests before release.', evidence: ['u2'], reason: 'Durable release default.' }, { action: 'archive', id: entries[0].id, evidence: [`memory:${entries[0].id}`], reason: 'Obsolete duplicate.' }] }
  const result = applyMemoryOperations(entries, reply, evidence, {}, 30)
  assert.equal(result.entries.filter((row) => row.status === 'active').length, 128)
})

test('a new message or concurrent memory edit invalidates an in-flight organization result', async () => {
  for (const mutation of [
    (data) => data.messages.push(message('u3', 'A later correction.')),
    (data) => data.entries.push(fact('concurrent', 'Human saved this while the model was running.', 'operator')),
    (data) => { data.busy = true },
  ]) {
    const f = fixture({ generate: (_request, data) => { mutation(data); return JSON.stringify({ operations: [], reason: 'Outdated result.' }) } })
    await assert.rejects(f.manager.organize('topic:a'), /inputs changed/)
    assert.equal(f.data.entries.some((row) => row.key === 'concurrent'), f.data.entries.length > 0)
    assert.equal(f.data.review.outcome, 'error')
  }
})

test('idle debounce waits for work to finish, persists no-op cursors and avoids repeating failed evidence', async () => {
  const f = fixture()
  f.manager.start()
  try {
    f.data.busy = true
    await f.manager.tick(); f.advance(); await f.manager.tick()
    assert.equal(f.data.calls.length, 0)
    f.data.busy = false
    await f.manager.tick(); f.advance(); await f.manager.tick(); await tick()
    assert.equal(f.data.calls.length, 1)
    assert.equal(f.data.review.outcome, 'unchanged')
    f.advance(); await f.manager.tick(); await tick()
    assert.equal(f.data.calls.length, 1)
    f.manager.generate = async () => { f.data.calls.push('failure'); throw new Error('temporary model error') }
    f.data.messages.push(message('u2', 'New input.'))
    await f.manager.tick(); f.advance(); await f.manager.tick(); await tick()
    assert.equal(f.data.review.attempted, 'u2')
    f.advance(); await f.manager.tick(); await tick()
    assert.equal(f.data.calls.length, 2, 'same failed evidence is not retried endlessly')
    f.disable(); f.data.messages.push(message('u3', 'Another input.'))
    f.advance(); await f.manager.tick()
    assert.equal(f.data.calls.length, 2)
  } finally { f.manager.stop() }
})

test('fifteen idle minutes only qualify new material, and scheduled no-ops do not recur', async () => {
  const f = fixture({ idleMs: 900_000, messages: [] })
  f.manager.start()
  await f.manager.tick()
  f.advance(1_800_000)
  await f.manager.tick()
  assert.equal(f.data.calls.length, 0)
  f.data.messages.push(message('u1', 'A temporary discussion.'))
  await f.manager.tick()
  f.advance(899_999)
  await f.manager.tick()
  assert.equal(f.data.calls.length, 0)
  f.advance(1)
  await f.manager.tick()
  await tick()
  assert.equal(f.data.review.outcome, 'unchanged')
  assert.equal(f.data.calls.length, 1)
  f.advance(900_000)
  await f.manager.tick()
  assert.equal(f.data.calls.length, 1)
  f.manager.stop()
})

test('only one background call runs and stopping aborts it without committing partial data', async () => {
  let release
  const f = fixture({ generate: () => new Promise((resolve) => { release = resolve }) })
  const pending = f.manager.organize('topic:a')
  await tick()
  await assert.rejects(f.manager.organize('topic:b'), /Another memory organization/)
  f.manager.stop()
  release(JSON.stringify({ operations: [], reason: 'Too late.' }))
  await assert.rejects(pending, /abort/i)
  assert.deepEqual(f.data.entries, [])
  assert.deepEqual(f.data.review, {})
})

test('foreground checks defer ordinary discussion and bind an applied correction to the original snapshot', async () => {
  const f = fixture({ generate: () => JSON.stringify({ decision: 'defer', reason: 'This is a provisional task parameter.' }) })
  let writes = 0
  const input = { action: 'save', key: 'color', text: 'Use blue.' }
  const result = await f.manager.write('topic:a', input, { id: 'u2', role: 'user', text: 'Maybe try blue in this draft.' }, () => writes++)
  assert.equal(result.deferred, true)
  assert.equal(writes, 0)
  const absent = await f.manager.write('topic:a', input, undefined, () => writes++)
  assert.equal(absent.deferred, true)
  assert.equal(f.data.calls.length, 1)
  f.manager.generate = async () => { f.data.entries.push(fact('changed', 'Concurrent edit.')); return JSON.stringify({ decision: 'apply', text: 'Use blue for this project only.', reason: 'Explicit request.' }) }
  await assert.rejects(f.manager.write('topic:a', input, { id: 'u3', role: 'user', text: 'Remember blue for this project.' }, () => writes++), /changed during intent/)
  assert.equal(writes, 0)
})

test('organization status and toggle survive restart; no-op does not advance the collection version', () => {
  const project = fakeProject(), registry = new TopicRegistry(project.root)
  const topic = registry.create('Memory fixture')
  const revision = topic.memoryRevision
  registry.setMemoryAuto(false)
  registry.commitMemoryReview(topic.id, 'topic', memorySnapshot(topic.memory), topic.memory, { cursor: 'u1', outcome: 'unchanged', at: 42, reason: 'Already concise.' })
  const restored = new TopicRegistry(project.root)
  assert.equal(restored.memoryAuto, false)
  assert.equal(restored.get(topic.id).memoryReview.cursor, 'u1')
  assert.equal(restored.get(topic.id).memoryRevision, revision)
})

test('manual organization can compact saved memory without loading or creating a conversation', async () => {
  const entry = fact('gate', 'Approval required. Approval required.', 'operator')
  const f = fixture({ entries: [entry], generate: ({ input }) => {
    assert.equal(JSON.parse(input).evidence.available, false)
    return JSON.stringify({ operations: [operation(entry, 'Approval required.', [entry.id])], reason: 'Removed repeated wording from saved memory.' })
  } })
  f.data.messages = undefined
  f.data.review = { cursor: 'previous-source' }
  await f.manager.organize('topic:a', { manual: true })
  assert.equal(f.data.entries[0].text, 'Approval required.')
  assert.equal(f.data.review.cursor, 'previous-source')
})

test('foreground checking redacts recognized secrets in both the proposal and the human evidence', async () => {
  const secret = 'sk-' + 'synthetic-secret'.repeat(3)
  const f = fixture({ generate: ({ input }) => {
    assert.doesNotMatch(input, /synthetic-secret/)
    assert.match(input, /redacted/)
    return JSON.stringify({ decision: 'defer', reason: 'Credentials are not durable facts.' })
  } })
  const result = await f.manager.write('topic:a', { action: 'save', key: 'credential', text: secret }, { id: 'u2', role: 'user', text: `Remember ${secret}.` }, () => { throw new Error('must not commit') })
  assert.equal(result.deferred, true)
})

test('correction generation uses canonical memory and human evidence without a rewritten draft', async () => {
  const entry = fact('project.runtime', 'Run the local service in WSL. No public release this round.', 'explicit')
  const f = fixture({ entries: [entry], generate: ({ input }) => {
    const request = JSON.parse(input)
    assert.equal(request.existing.text, entry.text)
    assert.equal(request.proposal.text, undefined)
    assert.match(request.human.text, /Windows/)
    assert.doesNotMatch(input, /UNREQUESTED_BAN/)
    return JSON.stringify({ decision: 'apply', text: 'Run locally in Windows Node; use WSL for compatibility checks. No public release this round.', reason: 'Only the runtime changed; the public-release boundary is retained.' })
  } })
  let committed
  const result = await f.manager.write('topic:a', { action: 'save', id: entry.id, key: entry.key, expected_revision: 1,
    text: 'Windows Node. UNREQUESTED_BAN: never launch or deploy any local service.' },
  { id: 'u2', role: 'user', text: 'Change the default to Windows Node; keep WSL for compatibility checks and preserve the public-release boundary.' },
  (input, source) => { committed = changeMemory(f.data.entries, input, source, 40); return committed })
  assert.equal(result.entry.id, entry.id)
  assert.equal(result.entry.revision, 2)
  assert.match(committed.entry.text, /No public release/)
  assert.doesNotMatch(committed.entry.text, /never launch|UNREQUESTED_BAN/)
})
