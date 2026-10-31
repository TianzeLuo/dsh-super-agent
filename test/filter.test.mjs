/**
 * filter.test.mjs — 程序层快路径的行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, mergeConfig } from '../lib/config.js'
import { actorMatches, filterEvent, mentionsAgent } from '../lib/filter.js'

const config = mergeConfig(DEFAULTS)

test('direct messages pass even in addressed mode', () => {
  const result = filterEvent({ source: 'im', actor: 'alice', text: 'hello', direct: true }, config)
  assert.equal(result.pass, true)
  assert.equal(result.addressed, true)
})

test('IM requires a mention by default', () => {
  const miss = filterEvent({ source: 'im', actor: 'alice', text: 'hello there' }, config)
  assert.equal(miss.pass, false)
  assert.equal(miss.reason, 'not-addressed')

  const hit = filterEvent({ source: 'im', actor: 'alice', text: '@super-agent fix login' }, config)
  assert.equal(hit.pass, true)
  assert.equal(hit.addressed, true)
})

test('structured mentions count without @ in text', () => {
  const result = filterEvent({ source: 'im', actor: 'alice', text: 'look', mentions: ['@super-agent'] }, config)
  assert.equal(result.pass, true)
})

test('candidate sources pass without a mention and stay ambient', () => {
  const result = filterEvent({ source: 'github', actor: 'alice', text: 'CI failed on main' }, config)
  assert.equal(result.pass, true)
  assert.equal(result.addressed, false)
})

test('source ignore mode filters everything', () => {
  const custom = mergeConfig(config, { sources: { github: { mode: 'ignore' } } })
  const result = filterEvent({ source: 'github', actor: 'alice', text: 'anything', direct: true }, custom)
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'source-ignored')
})

test('actor deny and ignore lists use exact values and suffix wildcards', () => {
  assert.equal(actorMatches('bot-1', ['bot-*']), true)
  assert.equal(actorMatches('alice', ['bot-*']), false)

  const custom = mergeConfig(config, {
    sources: { github: { actorsDeny: ['dependabot*'] } },
    ignoreActors: ['spam*'],
  })
  assert.equal(filterEvent({ source: 'github', actor: 'dependabot[bot]', text: 'bump' }, custom).reason, 'actor-denied')
  assert.equal(filterEvent({ source: 'github', actor: 'spammer', text: 'buy' }, custom).reason, 'actor-ignored')
})

test('agent-authored messages are filtered as self messages', () => {
  const result = filterEvent({ source: 'im', actor: 'super-agent', text: '@super-agent done' }, config)
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'self-message')
})

test('empty text and ignore patterns are filtered', () => {
  assert.equal(filterEvent({ source: 'github', actor: 'a', text: '   ' }, config).reason, 'empty')
  const custom = mergeConfig(config, { sources: { github: { ignorePatterns: ['^\\[bot\\]'] } } })
  assert.equal(filterEvent({ source: 'github', actor: 'a', text: '[bot] weekly report' }, custom).reason, 'pattern-ignored')
})

test('internal events bypass the program-layer filter', () => {
  const result = filterEvent({ source: 'watchdog', actor: 'watchdog', text: 'problem', internal: true }, config)
  assert.equal(result.pass, true)
  assert.equal(result.addressed, true)
})

test('mention matching does not fire on hyphenated lookalikes', () => {
  assert.equal(mentionsAgent({ text: 'the super-agentic pattern', agentNames: ['super-agent'] }), false)
  assert.equal(mentionsAgent({ text: 'ask @super-agent please', agentNames: ['super-agent'] }), true)
  assert.equal(mentionsAgent({ text: '请助手看一下', agentNames: ['助手'] }), true)
})
