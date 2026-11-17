import assert from 'node:assert/strict'
import test from 'node:test'
import { completeMemoryText } from '../lib/memory-model.js'

const selection = { provider: 'fixture', model: 'memory', reasoningEffort: 'high' }
const request = { system: 'Distill the evidence.', input: '{"scope":"topic:a"}' }
async function* completed() {
  yield { type: 'reasoning-delta', text: 'Never part of the structured output.' }
  yield { type: 'text-delta', text: '{"operations":' }
  yield { type: 'text-delta', text: '[]}' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('memory calls use the prepared host configuration and expose no tools or extra session', async () => {
  let received
  const llm = { stream: () => { throw new Error('prepared stream must be used') }, prepareCall: async (config) => {
    assert.equal(config.provider, 'fixture')
    return { config: { ...config, maxTokens: 8192 }, stream: (options) => { received = options; return completed() } }
  } }
  const result = await completeMemoryText(llm, selection, request)
  assert.equal(result.text, '{"operations":[]}')
  assert.equal(received.maxTokens, 8192)
  assert.deepEqual(received.tools, [])
  assert.equal(received.messages.length, 1)
  assert.equal(received.messages[0].content[0].text, request.input)
  assert.equal(received.system, request.system)
})

test('unsupported hosts, partial outputs, tool calls and oversized output preserve previous memory', async () => {
  await assert.rejects(completeMemoryText({}, selection, request), /does not expose/)
  await assert.rejects(completeMemoryText({ stream: completed }, {}, request), /Select/)
  for (const chunks of [
    [{ type: 'text-delta', text: '{"operations":[]}' }],
    [{ type: 'text-delta', text: '{"operations":[]}' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
    [{ type: 'block-start', blockType: 'tool-call' }],
    [{ type: 'text-delta', text: 'x'.repeat(64001) }],
    [{ type: 'finish', reason: { kind: 'completed' } }],
  ]) await assert.rejects(completeMemoryText({ stream: async function* () { yield* chunks } }, selection, request))
})
