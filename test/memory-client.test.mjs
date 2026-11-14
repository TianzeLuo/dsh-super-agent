import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './client-bundle.mjs'

function harness() {
  const state = []
  let cursor = 0
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useEffect() {}, useRef: (current) => ({ current }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const api = loadClientBundle({ react: React }).__internals
  return { api, render(component, props) { cursor = 0; return component(props) } }
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flatMap((child) => nodes(child, predicate))]
}
const t = (key) => key

test('memory editor preserves a draft on conflict and only adopts the latest fact after an explicit reload', async () => {
  const { api, render } = harness()
  const saved = []
  let closed = 0
  const props = { t, entry: { id: 'mem_fixture', key: 'deadline', text: 'Friday.', revision: 1, priority: 'important' }, onSave: async (body) => { saved.push(body); return false }, onCancel: () => closed++ }
  let tree = render(api.MemoryEditor, props)
  nodes(tree, (node) => node.type === 'textarea')[0].props.onChange({ target: { value: 'My unsaved correction.' } })
  tree = render(api.MemoryEditor, props)
  await tree.props.onSubmit({ preventDefault() {} })
  assert.equal(saved[0].expected_revision, 1)
  assert.equal(saved[0].id, 'mem_fixture')
  assert.equal(closed, 0, 'a rejected save must not discard the form')
  props.entry = { ...props.entry, text: 'Latest value is Monday.', revision: 2 }
  tree = render(api.MemoryEditor, props)
  assert.equal(nodes(tree, (node) => node.type === 'textarea')[0].props.value, 'My unsaved correction.')
  assert.equal(nodes(tree, (node) => node.props.type === 'submit')[0].props.disabled, true)
  nodes(tree, (node) => node.type === 'button' && node.children.includes('memoryReload'))[0].props.onClick()
  tree = render(api.MemoryEditor, props)
  assert.equal(nodes(tree, (node) => node.type === 'textarea')[0].props.value, 'Latest value is Monday.')
  assert.equal(nodes(tree, (node) => node.props.type === 'submit')[0].props.disabled, false)
})

test('a new fact closes its editor only after a successful save and retains its chosen priority', async () => {
  const { api, render } = harness()
  let payload
  let closed = 0
  const props = { t, onSave: async (body) => { payload = body; return true }, onCancel: () => closed++ }
  let tree = render(api.MemoryEditor, props)
  nodes(tree, (node) => node.type === 'input')[0].props.onChange({ target: { value: 'Release condition' } })
  nodes(tree, (node) => node.type === 'textarea')[0].props.onChange({ target: { value: 'Prepared, but do not publish before approval.' } })
  nodes(tree, (node) => node.props.label === 'memoryImportant')[0].props.onChange(true)
  tree = render(api.MemoryEditor, props)
  await tree.props.onSubmit({ preventDefault() {} })
  assert.equal(payload.priority, 'important')
  assert.equal(payload.memory_action, 'save')
  assert.ok(!('expected_revision' in payload))
  assert.equal(closed, 1)
})

test('topic-state edits also preserve unsaved qualifiers when another conversation changes the state', () => {
  const { api, render } = harness()
  const props = { t, topic: { id: 'topic-a', stateRevision: 1, state: { result: 'Prepared.' } }, onSave: async () => false }
  let tree = render(api.TopicStateEditor, props)
  nodes(tree, (node) => node.type === 'textarea')[1].props.onChange({ target: { value: 'Prepared; certification has NOT passed.' } })
  props.topic = { ...props.topic, stateRevision: 2, state: { result: 'A newer check failed.' } }
  tree = render(api.TopicStateEditor, props)
  assert.equal(nodes(tree, (node) => node.type === 'textarea')[1].props.value, 'Prepared; certification has NOT passed.')
  assert.equal(nodes(tree, (node) => node.props.type === 'submit')[0].props.disabled, true)
})

test('scope switching shows only that collection, and archive actions carry its exact scope and version', async () => {
  const { api, render } = harness()
  const calls = []
  const props = { t, topicId: 'topic-a', topics: [{ id: 'topic-a', name: 'Fixture', sharing: 'summary', state: {} }], memory: {
    topic: [{ id: 'mem_local', key: 'LOCAL', text: 'Local fact.', status: 'active', revision: 2, updatedAt: 0, history: [] }],
    instance: [{ id: 'mem_shared', key: 'SHARED', text: 'Shared fact.', status: 'active', revision: 4, updatedAt: 0, history: [] }],
  }, onAction: async (body) => { calls.push(body); return true } }
  let tree = render(api.TopicsPanel, props)
  nodes(tree, (node) => node.props.role === 'tab' && node.children.includes('memoryTabFacts'))[0].props.onClick()
  tree = render(api.TopicsPanel, props)
  assert.equal(nodes(tree, (node) => node.type === 'article').length, 1)
  assert.equal(nodes(tree, (node) => node.type === 'article')[0].children[1].children[0], 'Local fact.')
  nodes(tree, (node) => node.type === 'button' && node.children.includes('memoryShared'))[0].props.onClick()
  tree = render(api.TopicsPanel, props)
  assert.equal(nodes(tree, (node) => node.type === 'article')[0].children[1].children[0], 'Shared fact.')
  await nodes(tree, (node) => node.type === 'button' && node.children.includes('memoryArchive'))[0].props.onClick()
  assert.deepEqual(calls[0], { action: 'memory', scope: 'instance', memory_action: 'archive', id: 'mem_shared', expected_revision: 4 })
})

test('context preview exposes complete selected facts and a real required-overflow warning', () => {
  const { api, render } = harness()
  const text = 'Package prepared, but it MUST NOT be released until verification passes.'
  const props = { t, topicId: 'topic-a', topics: [{ id: 'topic-a', name: 'Fixture', state: {} }], contextPlan: { maxChars: 1200, usedChars: 1100, importantOmitted: 1, selected: [{ id: 'mem_a', key: 'Condition', kind: 'memory', scope: 'instance', text, reason: 'important' }], omitted: [] } }
  let tree = render(api.TopicsPanel, props)
  nodes(tree, (node) => node.props.role === 'tab' && node.children.includes('memoryTabContext'))[0].props.onClick()
  tree = render(api.TopicsPanel, props)
  assert.equal(nodes(tree, (node) => node.type === 'progress')[0].props.value, 1100)
  assert.ok(nodes(tree, (node) => node.props.role === 'alert').some((node) => node.children.includes('memoryOverflow')))
  assert.ok(nodes(tree, (node) => node.type === 'p').some((node) => node.children.includes(text)))
})
