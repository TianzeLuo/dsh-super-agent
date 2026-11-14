import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './client-bundle.mjs'

function harness(env = {}) {
  const slots = []
  let cursor = 0
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const api = loadClientBundle({ react: React }, env).__internals
  return { api, render(component, props) { cursor = 0; return component(props) } }
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flatMap((child) => nodes(child, predicate))]
}
const t = (key) => key
const keyEvent = (key) => ({ key, preventDefault() {}, stopPropagation() {} })

test('new chat keeps its name and sharing choice on rejection, then creates and switches only on success', async () => {
  const { api, render } = harness()
  const calls = []
  let success = false
  let closed = 0
  let refocused = 0
  const props = { t, onCreate: async (...values) => { calls.push(values); return success }, onCancel: () => closed++ }
  let tree = render(api.TopicCreateForm, props)
  nodes(tree, (node) => node.type === 'input')[0].props.ref.current = { focus: () => refocused++ }
  await tree.props.onSubmit({ preventDefault() {} })
  assert.equal(calls.length, 0, 'an empty name must not create a chat')
  nodes(tree, (node) => node.type === 'input')[0].props.onChange({ target: { value: '  Research fixture  ' } })
  nodes(tree, (node) => node.type === api.SelectMenu)[0].props.onChange('private')
  tree = render(api.TopicCreateForm, props)
  await tree.props.onSubmit({ preventDefault() {} })
  tree = render(api.TopicCreateForm, props)
  assert.equal(nodes(tree, (node) => node.type === 'input')[0].props.value, '  Research fixture  ')
  assert.equal(nodes(tree, (node) => node.type === api.SelectMenu)[0].props.value, 'private')
  assert.equal(closed, 0)
  assert.equal(refocused, 1, 'rejected creation returns the keyboard to the editable name')
  success = true
  await tree.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(calls, [['Research fixture', 'private'], ['Research fixture', 'private']])
  assert.equal(closed, 1)
})

test('new chat is reachable from the memory page and cancel returns to the same page', () => {
  const { api, render } = harness()
  const props = { t, topicId: 'main', topics: [{ id: 'main', name: 'Overview fixture', state: {}, sharing: 'summary' }] }
  let tree = render(api.TopicsPanel, props)
  nodes(tree, (node) => node.props.role === 'tab' && node.children.includes('memoryTabFacts'))[0].props.onClick()
  tree = render(api.TopicsPanel, props)
  nodes(tree, (node) => node.type === 'button' && node.children.includes('topicNew'))[0].props.onClick()
  tree = render(api.TopicsPanel, props)
  const form = nodes(tree, (node) => node.type === api.TopicCreateForm)[0]
  assert.ok(form)
  assert.equal(nodes(tree, (node) => node.props.role === 'tab').length, 0, 'creation focuses on one form')
  form.props.onCancel()
  tree = render(api.TopicsPanel, props)
  assert.equal(nodes(tree, (node) => node.props.role === 'tab' && node.props['aria-selected'])[0].children[0], 'memoryTabFacts')
})

test('quick creation opens the creation form directly, without a settings step', () => {
  const { api, render } = harness()
  const tree = render(api.TopicsPanel, { t, topicId: 'main', topics: [], initialCreate: true })
  assert.equal(nodes(tree, (node) => node.type === api.TopicCreateForm).length, 1)
  assert.equal(nodes(tree, (node) => node.type === 'input').length, 0, 'unrelated settings are not shown during creation')
})

test('chat strip keeps stable targets, hides archived chats and uses the same controls when expanded', () => {
  const { api, render } = harness()
  const selected = []
  const props = { id: 'chat-strip', t, topicId: 'topic-b', expanded: false, topics: [{ id: 'main', name: 'Overview' }, { id: 'topic-b', name: 'Long name '.repeat(5) }, { id: 'topic-hidden', name: 'Hidden', archived: true }], onSelect: (id) => selected.push(id) }
  assert.equal(render(api.TopicStrip, props).props.hidden, true)
  const tree = render(api.TopicStrip, { ...props, expanded: true })
  const tabs = nodes(tree, (node) => node.props.role === 'tab')
  assert.equal(tabs.length, 2)
  assert.equal(tabs[1].props['aria-selected'], true)
  tabs[0].props.onClick()
  assert.deepEqual(selected, ['main'])
})

test('collapse preference survives reopening and storage denial still permits a local toggle', () => {
  const { api } = harness()
  const values = new Map()
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }
  assert.equal(api.topicBarPreference(storage), false)
  assert.equal(api.topicBarPreference(storage, true), true)
  assert.equal(api.topicBarPreference(storage), true)
  assert.equal(api.topicBarPreference(storage, false), false)
  assert.equal(api.topicBarPreference({ getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }, true), true)
})

test('task scope is controlled from recent activity and sends an explicit target scope', () => {
  const { api, render } = harness()
  const selected = []
  const tree = render(api.ActivityRail, { t, tasks: [], scope: 'topic', onScopeChange: (value) => selected.push(value) })
  const scope = nodes(tree, (node) => node.type === api.SelectMenu)[0]
  assert.equal(scope.props.ariaLabel, 'topicActivityScope')
  assert.equal(scope.props.value, 'topic')
  scope.props.onChange('instance')
  assert.deepEqual(selected, ['instance'])
  assert.ok(scope.props.options.every((option) => option.description))
})

test('sharing choices explain their boundaries and the select supports keyboard navigation and escape', () => {
  const document = { activeElement: undefined }
  const { api, render } = harness({ document, window: { innerWidth: 390, innerHeight: 600 } })
  const values = []
  const props = { value: 'summary', options: api.sharingOptions(t), onChange: (value) => values.push(value), ariaLabel: 'sharing fixture' }
  let focused = 0
  const trigger = { getBoundingClientRect: () => ({ left: 20, top: 40, bottom: 70, width: 320 }), focus: () => focused++ }
  let tree = render(api.SelectMenu, props)
  nodes(tree, (node) => node.type === 'button')[0].props.ref.current = trigger
  tree.props.onKeyDown(keyEvent('ArrowDown'))
  tree = render(api.SelectMenu, props)
  const choices = nodes(tree, (node) => node.props.role === 'option')
  assert.equal(choices.length, 3)
  assert.ok(choices.every((choice) => choice.children.length === 2), 'every sharing option includes its description')
  const domChoices = choices.map(() => ({ focus() { document.activeElement = this } }))
  tree.props.ref.current = { querySelectorAll: () => domChoices }
  document.activeElement = domChoices[1]
  tree.props.onKeyDown(keyEvent('ArrowDown'))
  assert.equal(document.activeElement, domChoices[2])
  tree.props.onKeyDown(keyEvent('Home'))
  assert.equal(document.activeElement, domChoices[0])
  const capture = new Map()
  let drawersClosed = 0
  api.bindDrawerDismiss({ addEventListener: (name, handler) => capture.set(name, handler) }, { isInside: () => true, onClose: () => drawersClosed++ })
  const escape = { ...keyEvent('Escape'), target: { tagName: 'BUTTON', closest: () => ({}) } }
  capture.get('keydown')(escape)
  tree.props.onKeyDown(escape)
  assert.equal(drawersClosed, 0, 'the document capture listener must yield to the inner popup')
  tree = render(api.SelectMenu, props)
  assert.equal(nodes(tree, (node) => node.props.role === 'listbox').length, 0)
  assert.equal(focused, 1)
  capture.get('keydown')({ ...keyEvent('Escape'), target: { tagName: 'BUTTON', closest: () => null } })
  assert.equal(drawersClosed, 1, 'a later Escape closes the surrounding drawer')
  tree.props.onKeyDown(keyEvent('ArrowDown'))
  tree = render(api.SelectMenu, props)
  nodes(tree, (node) => node.props.role === 'option')[0].props.onClick()
  assert.deepEqual(values, ['private'])
})

test('more actions preserve the reset confirmation and escape returns focus to the trigger', () => {
  const { api, render } = harness()
  let invoked = 0
  let focused = 0
  const props = { t, actions: [{ key: 'reset', label: 'Reset fixture', keepOpen: true, run: () => invoked++ }] }
  const tree = render(api.ToolbarMore, props)
  const root = { open: true, querySelector: () => ({ focus: () => focused++ }) }
  tree.props.ref.current = root
  nodes(tree, (node) => node.type === 'button')[0].props.onClick()
  assert.equal(invoked, 1)
  assert.equal(root.open, true)
  tree.props.onKeyDown(keyEvent('Escape'))
  assert.equal(root.open, false)
  assert.equal(focused, 1)
})
