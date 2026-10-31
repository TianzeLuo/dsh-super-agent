/**
 * render.test.mjs — Inline/Spill 投影、有界批次与字数/脱敏。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, channelConfig, mergeConfig } from '../lib/config.js'
import { inlineTrigger, renderBatch, renderStatus, renderWorkerEvent, renderWorkerTask } from '../lib/render.js'
import { Store } from '../lib/store.js'
import { clip, redactSecrets, summaryOf, wordCount } from '../lib/text.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = mergeConfig(DEFAULTS)

function trigger(id, overrides = {}) {
  return {
    id,
    source: 'im',
    threadId: 'thr_aaaaaaaaaa',
    kind: 'message',
    actor: 'alice',
    title: 'Login bug',
    summary: 'login broken',
    text: 'login is broken on Safari please fix it',
    receivedAt: 1000,
    addressed: true,
    ...overrides,
  }
}

test('inlineTrigger includes id, thread, actor and a bounded summary', () => {
  const line = inlineTrigger(trigger('trg_1', { text: 'x'.repeat(500) }), { inlineChars: 80, now: 2000 })
  assert.match(line, /trg_1/)
  assert.match(line, /thr_aaaaaaaaaa/)
  assert.match(line, /alice/)
  assert.match(line, /recall trg_1/)
  assert.match(line, /500 chars/)
  assert.ok(line.length < 500)
})

test('renderBatch respects maxBatch and maxBatchChars, leaving the rest pending', () => {
  const triggers = Array.from({ length: 10 }, (_, index) => trigger(`trg_${index}`, { text: `event ${index} ` + 'y'.repeat(200) }))
  const small = mergeConfig(config, { router: { maxBatch: 4, maxBatchChars: 1200 } })
  const rendered = renderBatch({ triggers, batchId: 'bat_1', config: small, pendingAfter: 4, now: 2000 })
  assert.ok(rendered.triggerIds.length > 0)
  assert.ok(rendered.triggerIds.length < triggers.length)
  assert.ok(rendered.chars <= small.router.maxBatchChars)
  assert.match(rendered.text, /remain pending|not inlined/)
  assert.match(rendered.text, /batch bat_1/)
})

test('renderBatch includes addressed/ambient counts', () => {
  const rendered = renderBatch({
    triggers: [trigger('trg_1'), trigger('trg_2', { addressed: false })],
    batchId: 'bat_1',
    config,
    now: 2000,
  })
  assert.match(rendered.text, /1 addressed, 1 ambient/)
})

test('worker event carries full text, thread context and the reporting rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-super-agent-render-'))
  const store = new Store({ dir })
  store.open()
  store.append({
    t: 'trigger.received',
    trigger: {
      ...trigger('trg_prev', { text: 'earlier context', receivedAt: 1 }),
      state: 'pending',
    },
  })
  store.append({
    t: 'trigger.received',
    trigger: {
      ...trigger('trg_cur', { text: 'new detail', receivedAt: 2 }),
      state: 'pending',
    },
  })
  const task = { id: 'tsk_1', title: 'Fix login', threadIds: ['thr_aaaaaaaaaa'] }
  const rendered = renderWorkerEvent({ trigger: store.getTrigger('trg_cur'), config, task, store })
  assert.match(rendered, /untrusted data/)
  assert.match(rendered, /new detail/)
  assert.match(rendered, /Earlier on this thread/)
  assert.match(rendered, /login broken/)
  assert.match(rendered, /report to the Router/)
  store.close()
})

test('worker task prompt is standalone and repeats the no-human-contact rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-super-agent-render-'))
  const store = new Store({ dir })
  store.open()
  const task = { id: 'tsk_1', title: 'Fix login', brief: 'Reproduce and fix', cwd: '/tmp/project', threadIds: ['thr_aaaaaaaaaa'] }
  const text = renderWorkerTask({ task, config, store, projectRoot: '/tmp/project' })
  assert.match(text, /isolated Worker/)
  assert.match(text, /Fix login/)
  assert.match(text, /Reproduce and fix/)
  assert.match(text, /Never reply to people directly/)
  assert.match(text, /final assistant message is your report/)
  store.close()
})

test('status rendering is compact and includes the important counts', () => {
  const text = renderStatus({
    projectRoot: '/tmp/project',
    router: { sessionId: 'session-1', status: 'idle', pendingTriggers: 3, batches: 2 },
    counts: {
      threads: 1,
      triggers: 5,
      filtered: 1,
      tasks: { working: 1, idle: 0, queued: 1, closed: 0 },
    },
    outbox: { total: 1, byChannel: { im: 1 } },
    watchdog: { lastCheckAt: Date.now(), issues: [] },
    tasks: [{ id: 'tsk_1', title: 'Fix login', status: 'working', threadIds: ['thr_1'] }],
    threads: [],
  }, 'compact')
  assert.match(text, /super-agent/)
  assert.match(text, /3 pending/)
  assert.match(text, /1 working/)
  assert.match(text, /im:1/)
})

test('wordCount counts CJK characters as words', () => {
  assert.equal(wordCount('fix the login bug'), 4)
  assert.equal(wordCount('修一下登录问题'), 7)
  assert.equal(wordCount('修一下 login bug'), 3 + 2)
  assert.equal(channelConfig(config, 'im').maxWords, 100)
})

test('redaction covers common secret shapes without destroying normal text', () => {
  const text = 'use sk-abcdefghijklmnop and Bearer abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwx'
  const redacted = redactSecrets(text)
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop/)
  assert.doesNotMatch(redacted, /Bearer abcdefghijklmnop/)
  assert.doesNotMatch(redacted, /ghp_abcdefghijklmnopqrstuvwx/)
  assert.match(redacted, /\[redacted\]/)
  assert.equal(redactSecrets('plain message'), 'plain message')
})

test('clip is code-point safe and reports nothing extra when under budget', () => {
  assert.equal(clip('hello', 10), 'hello')
  assert.equal(clip('😀😀😀', 2), '😀…')
  assert.equal(summaryOf('a\n\nb', 10), 'a b')
})

test('inlineTrigger falls back to the stored summary when full text is off', () => {
  const line = inlineTrigger(trigger('trg_spill', { text: '', summary: 'summary survives' }), { inlineChars: 80, now: 2000 })
  assert.match(line, /summary survives/)
})
