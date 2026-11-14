import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './client-bundle.mjs'

function harness() {
  const state = []
  let cursor = 0
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((row) => row !== null && row !== undefined && row !== false) }),
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useRef(initial) { const index = cursor++; return state[index] ??= { current: initial } },
    useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const api = loadClientBundle({ react: React }).__internals
  return { api, render(component, props) { cursor = 0; return component(props) } }
}
function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap((row) => nodes(row, match))]
}
const t = (key) => key

test('mentions match complete names, punctuation and regex characters without accidental broadcasts', () => {
  const { api } = harness()
  const members = [{ id: 'a', name: '资料' }, { id: 'b', name: '资料专家' }, { id: 'c', name: 'Writer (A)+' }]
  assert.deepEqual(api.groupMentions('@资料专家，请查证。', members), ['b'])
  assert.deepEqual(api.groupMentions('@Writer (A)+ check this.', members), ['c'])
  assert.deepEqual(api.groupMentions('@everyone 请各自回复。', members), ['a', 'b', 'c'])
  assert.deepEqual(api.groupMentions('普通进度，不唤醒任何人。', members), [])
})

test('a failed delegation preserves its brief and stable idempotency key until success', async () => {
  const { api, render } = harness()
  const sent = []
  let closed = 0
  let accepted = false
  const props = { t, collaborators: [{ id: 'a', name: 'Research' }], onSend: async (body) => { sent.push(body); return accepted }, onCancel: () => closed++ }
  let tree = render(api.CollaborationRequestForm, props)
  nodes(tree, (row) => row.type === 'input')[0].props.onChange({ target: { value: 'Evidence' } })
  nodes(tree, (row) => row.type === 'textarea')[0].props.onChange({ target: { value: 'Preserve the qualifier: do not publish.' } })
  tree = render(api.CollaborationRequestForm, props)
  await tree.props.onSubmit({ preventDefault() {} })
  assert.equal(closed, 0)
  tree = render(api.CollaborationRequestForm, props)
  assert.match(nodes(tree, (row) => row.type === 'textarea')[0].props.value, /do not publish/)
  accepted = true
  await tree.props.onSubmit({ preventDefault() {} })
  assert.equal(sent[0].idempotency_key, sent[1].idempotency_key)
  assert.equal(closed, 1)
})

test('a handoff draft survives a concurrent ownership revision and requires refresh', async () => {
  const { api, render } = harness()
  const calls = []
  const props = { t, request: { id: 'req', revision: 2, status: 'working', assigneeTopicId: 'a', brief: 'Source material.' }, collaborators: [{ id: 'a' }, { id: 'b' }], groups: [], topicName: (id) => id, onAction: async (body) => { calls.push(body); return true } }
  let tree = render(api.CollaborationRequestDetail, props)
  nodes(tree, (row) => row.type === 'button' && row.children.includes('collabHandoff'))[0].props.onClick()
  tree = render(api.CollaborationRequestDetail, props)
  nodes(tree, (row) => row.type === 'textarea')[0].props.onChange({ target: { value: 'Keep the important restriction.' } })
  props.request = { ...props.request, revision: 3 }
  tree = render(api.CollaborationRequestDetail, props)
  assert.equal(nodes(tree, (row) => row.type === 'textarea')[0].props.value, 'Keep the important restriction.')
  assert.equal(nodes(tree, (row) => row.props.type === 'submit')[0].props.disabled, true)
  await nodes(tree, (row) => row.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(calls.length, 0)
  nodes(tree, (row) => row.type === 'button' && row.children.includes('refresh'))[0].props.onClick()
  tree = render(api.CollaborationRequestDetail, props)
  await nodes(tree, (row) => row.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(calls[0].expected_revision, 3)
  assert.equal(calls[0].to_topic_id, 'b')
})

test('editing an existing group fact uses a distinct React identity and cancel leaves its row intact', () => {
  const { api, render } = harness()
  const fact = { id: 'mem_fixture', key: 'approval', text: 'Draft only.', status: 'active', revision: 1 }
  const props = { t, group: { id: 'group', members: ['a', 'b'], memory: [fact] }, messages: [], collaborators: [], topicName: (id) => id, onAction: async () => true }
  let tree = render(api.CollaborationGroupChat, props)
  nodes(tree, (row) => row.type === 'button' && row.children.includes('memoryEdit'))[0].props.onClick()
  tree = render(api.CollaborationGroupChat, props)
  const editor = nodes(tree, (row) => row.type === api.MemoryEditor)[0]
  const details = nodes(tree, (row) => row.type === 'details')[0]
  const keys = details.children.filter((row) => row?.props?.key).map((row) => row.props.key)
  assert.equal(new Set(keys).size, keys.length, 'duplicate editor and row keys can leave orphaned DOM after cancel')
  editor.props.onCancel()
  props.group = { ...props.group, memory: [{ ...fact }] }
  tree = render(api.CollaborationGroupChat, props)
  assert.equal(nodes(tree, (row) => row.type === api.MemoryEditor).length, 0)
  assert.equal(nodes(tree, (row) => row.type === 'article').length, 1)
})

test('collaboration help is adjacent to the title, closes before the drawer on Escape and leads to setup', () => {
  const { api, render } = harness()
  let setups = 0
  let closed = 0
  const props = { t, onSetup: () => setups++, onClose: () => closed++ }
  let tree = render(api.CollaborationHeader, props)
  const help = nodes(tree, (row) => row.type === 'button' && row.children.includes('collabHowTo'))[0]
  assert.equal(help.props['aria-expanded'], false)
  assert.equal(nodes(tree, (row) => row.props.role === 'region').length, 0)
  help.props.onClick()
  tree = render(api.CollaborationHeader, props)
  const region = nodes(tree, (row) => row.props.role === 'region')[0]
  const trigger = nodes(tree, (row) => row.type === 'button' && row.children.includes('collabHowTo'))[0]
  assert.equal(trigger.props['aria-controls'], region.props.id)
  assert.equal(region.props['data-super-agent-popup'], '')
  let prevented = 0
  region.props.onKeyDown({ key: 'Escape', preventDefault: () => prevented++, stopPropagation: () => prevented++ })
  tree = render(api.CollaborationHeader, props)
  assert.equal(prevented, 2)
  assert.equal(closed, 0)
  assert.equal(nodes(tree, (row) => row.props.role === 'region').length, 0)
  nodes(tree, (row) => row.type === 'button' && row.children.includes('collabHowTo'))[0].props.onClick()
  tree = render(api.CollaborationHeader, props)
  nodes(tree, (row) => row.type === api.CollaborationHelp)[0].props.onSetup()
  tree = render(api.CollaborationHeader, props)
  assert.equal(setups, 1)
  assert.equal(nodes(tree, (row) => row.props.role === 'region').length, 0)
})

test('first-time setup shows opt-in roles before a disabled primary selector and never chooses a primary automatically', () => {
  const { api, render } = harness()
  const actions = []
  const props = { t, topics: [{ id: 'a', name: 'Research' }, { id: 'hidden', name: 'Hidden', archived: true }], profiles: {}, collaborators: [], settings: { primaryTopicId: null, paused: false }, onAction: (body) => actions.push(body) }
  let tree = render(api.CollaborationSettings, props)
  const sections = nodes(tree, (row) => row.type === 'section')
  assert.deepEqual(sections.map((row) => row.props['aria-label']), ['collabEnableStep', 'collabPrimaryStep'])
  assert.equal(nodes(tree, (row) => row.type === api.CollaborationRole).length, 1)
  let select = nodes(tree, (row) => row.type === api.SelectMenu)[0]
  assert.equal(select.props.disabled, true)
  assert.equal(select.props.options[0].label, 'collabPrimaryLockedOption')
  assert.ok(nodes(tree, (row) => row.children.includes('collabPrimaryLocked')).length)
  props.collaborators = [{ id: 'a', name: 'Research' }]
  props.profiles = { a: { enabled: true } }
  tree = render(api.CollaborationSettings, props)
  select = nodes(tree, (row) => row.type === api.SelectMenu)[0]
  assert.equal(select.props.disabled, false)
  assert.equal(select.props.value, '')
  assert.equal(actions.length, 0)
  select.props.onChange('a')
  assert.deepEqual(actions[0], { action: 'configure', primary_topic_id: 'a' })
})

test('the prominent opt-in switch preserves an unsaved role and keeps busy controls disabled', async () => {
  const { api, render } = harness()
  const calls = []
  const props = { t, topic: { id: 'a', name: 'Research' }, profile: { enabled: false, role: '' }, onSave: async (body) => { calls.push(body); return false } }
  let tree = render(api.CollaborationRole, props)
  nodes(tree, (row) => row.type === 'textarea')[0].props.onChange({ target: { value: 'Keep sources and constraints.' } })
  tree = render(api.CollaborationRole, props)
  const toggle = nodes(tree, (row) => row.props.role === 'switch')[0]
  assert.equal(toggle.props['aria-checked'], false)
  assert.ok(toggle.children.includes('collabEnableAction'))
  await toggle.props.onClick()
  assert.deepEqual(calls[0], { topic_id: 'a', enabled: true })
  props.profile = { enabled: true, role: '' }
  props.busy = true
  tree = render(api.CollaborationRole, props)
  const enabled = nodes(tree, (row) => row.props.role === 'switch')[0]
  assert.equal(enabled.props['aria-checked'], true)
  assert.equal(enabled.props.disabled, true)
  assert.ok(enabled.children.includes('collabEnabled'))
  assert.equal(nodes(tree, (row) => row.type === 'textarea')[0].props.value, 'Keep sources and constraints.')
})
