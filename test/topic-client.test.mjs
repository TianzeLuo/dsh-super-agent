import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './client-bundle.mjs'

test('topic requests retain cursor parameters and carry this surface\'s explicit instance, topic and visibility', () => {
  const { __internals: api } = loadClientBundle()
  const request = api.topicRequestUrl('/api/super-agent/ui/activity?cursor=a%2Fb', { instanceId: 'inst-one', topicId: 'topic-a', clientId: 'surface-a', activityScope: 'topic', visible: false })
  const url = new URL(request, 'http://localhost')
  assert.equal(url.searchParams.get('cursor'), 'a/b')
  assert.equal(url.searchParams.get('instance_id'), 'inst-one')
  assert.equal(url.searchParams.get('topic_id'), 'topic-a')
  assert.equal(url.searchParams.get('activity_scope'), 'topic')
  assert.equal(url.searchParams.get('visible'), '0')
  const updated = new URL(api.topicRequestUrl(request, { instanceId: 'inst-two', topicId: 'topic-b' }), 'http://localhost')
  assert.deepEqual(updated.searchParams.getAll('instance_id'), ['inst-two'])
  assert.deepEqual(updated.searchParams.getAll('topic_id'), ['topic-b'])
})

test('topic notifications resolve the exact topic instead of the last active conversation', () => {
  const { __internals: api } = loadClientBundle()
  const state = { activeInstanceId: 'another-instance', routers: [
    { sessionId: 'main-session', instanceId: 'inst-one', topicId: 'main' },
    { sessionId: 'topic-session', instanceId: 'inst-one', topicId: 'topic-a' },
  ] }
  assert.deepEqual(api.revealTargetOf(state, 'topic-session'), { sessionId: 'topic-session', instanceId: 'inst-one', topicId: 'topic-a' })
  assert.deepEqual(api.revealTargetOf(state, 'unknown-session'), { sessionId: 'unknown-session' })
})
