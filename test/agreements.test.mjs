import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agreementApplies,
  agreementStorePath,
  agreementTitle,
  agreementsForProject,
  agreementsMtime,
  normalizeAgreement,
  normalizeAgreementText,
  readAgreements,
  renderAgreements,
  writeAgreements,
} from '../lib/agreements.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-super-agent-agreements-'))
}

test('agreement store path is a project file and survives a dataDir reset', () => {
  const root = tempRoot()
  const path = agreementStorePath(root)
  assert.equal(path, join(root, '.dsh', 'super-agent.agreements.json'))
  assert.equal(agreementStorePath(root, 'custom.json'), join(root, '.dsh', 'custom.json'))
  assert.equal(agreementStorePath(root, '../escape.json'), path)
})

test('write/read roundtrip normalizes ids, text and scopes', () => {
  const root = tempRoot()
  const path = agreementStorePath(root)
  const item = normalizeAgreement({
    title: '  Reply briefly ',
    text: '  Prefer outcome-first answers.\n\nNo process narration.  ',
    project: root,
    mode: 'replace',
  }, { projectRoot: root })
  assert.equal(item.title, 'Reply briefly')
  assert.equal(item.text, 'Prefer outcome-first answers.\n\nNo process narration.')
  assert.equal(item.project, root)
  assert.equal(item.mode, 'replace')
  assert.equal(item.enabled, true)

  writeAgreements(path, [item])
  const read = readAgreements(path)
  assert.equal(read.items.length, 1)
  assert.equal(read.items[0].text, item.text)
  assert.ok(agreementsMtime(path) > 0)
  assert.match(readFileSync(path, 'utf8'), /outcome-first/)
})

test('normalization rejects empty text and caps absurd lengths', () => {
  assert.equal(normalizeAgreement({ text: '   ' }), undefined)
  const long = 'a'.repeat(5000)
  const item = normalizeAgreement({ text: long }, { maxChars: 2000 })
  assert.equal(item.text.length, 2000)
  assert.ok(item.title.endsWith('…'))
  assert.equal(agreementTitle('short line\nsecond'), 'short line')
  assert.equal(normalizeAgreementText('  a\r\nb  '), 'a\nb')
})

test('project rules append to globals, and replace suppresses globals for that project', () => {
  const root = tempRoot()
  const other = tempRoot()
  const items = [
    { id: 'agr_1', title: 'global', text: 'Be brief.', project: '', mode: 'append', enabled: true },
    { id: 'agr_2', title: 'repo', text: 'Run pnpm test.', project: root, mode: 'append', enabled: true },
  ]
  assert.deepEqual(agreementsForProject(items, root).map((item) => item.id), ['agr_1', 'agr_2'])
  assert.deepEqual(agreementsForProject(items, other).map((item) => item.id), ['agr_1'])
  assert.equal(agreementApplies(items[1], other), false)

  const replacing = [...items, { id: 'agr_3', title: 'override', text: 'Only repo rules.', project: root, mode: 'replace', enabled: true }]
  assert.deepEqual(agreementsForProject(replacing, root).map((item) => item.id), ['agr_2', 'agr_3'])
  assert.equal(agreementApplies(replacing[2], root), true)
})

test('disabled agreements are never injected but still listed', () => {
  const items = [
    { id: 'agr_1', title: 'on', text: 'A', project: '', enabled: true },
    { id: 'agr_2', title: 'off', text: 'B', project: '', enabled: false },
  ]
  assert.deepEqual(agreementsForProject(items, undefined).map((item) => item.id), ['agr_1'])
})

test('renderAgreements labels scope and respects the character budget', () => {
  const items = [
    { id: 'agr_1', title: 'global', text: 'Be brief.', project: '', mode: 'append', enabled: true },
    { id: 'agr_2', title: 'repo', text: 'Run tests before saying done.', project: '/repo', projectTitle: 'repo', mode: 'append', enabled: true },
  ]
  const rendered = renderAgreements(items, { maxChars: 1000 })
  assert.equal(rendered.shown, 2)
  assert.match(rendered.text, /\[global\] Be brief\./)
  assert.match(rendered.text, /\[project repo\] Run tests/)
  const clipped = renderAgreements(items, { maxChars: 12 })
  assert.equal(clipped.truncated, true)
  assert.ok(clipped.text.length <= 12)
  assert.equal(renderAgreements([], {}).text, '')
})

test('malformed files degrade to an empty list, never throw', () => {
  const root = tempRoot()
  const path = agreementStorePath(root)
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(path, '{not json')
  assert.deepEqual(readAgreements(path).items, [])
  writeFileSync(path, JSON.stringify({ items: [{ id: 'agr_1', text: 'ok' }] }))
  const items = readAgreements(path).items
  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'ok')
})
