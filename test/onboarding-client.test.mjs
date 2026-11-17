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

test('recent activity shows six rows and reveals cached pages after collapse without fetching again', () => {
  const { api, render } = harness()
  const tasks = Array.from({ length: 13 }, (_, i) => ({ id: `fixture-${i}`, status: 'closed' }))
  let requests = 0
  const props = { t, tasks, total: tasks.length, scope: 'instance', onLoadMore: () => { requests++; throw new Error('cached rows must not be fetched again') } }
  let tree
  const shown = () => nodes(tree, (node) => node.type === api.ActivityGroup).reduce((count, node) => count + node.props.group.tasks.length, 0)
  const more = () => nodes(tree, (node) => node.props.className === 'sa-more-button')[0]
  const toggle = () => nodes(tree, (node) => node.props.className === 'sa-activity-collapse')[0]
  tree = render(api.ActivityRail, props)
  assert.equal(shown(), 6)
  more().props.onClick()
  tree = render(api.ActivityRail, props)
  assert.equal(shown(), 12)
  more().props.onClick()
  tree = render(api.ActivityRail, props)
  assert.equal(shown(), 13)
  assert.equal(more().props.disabled, true)
  toggle().props.onClick()
  tree = render(api.ActivityRail, props)
  assert.equal(shown(), 0)
  toggle().props.onClick()
  tree = render(api.ActivityRail, props)
  assert.equal(shown(), 6)
  assert.equal(more().props.disabled, false)
  more().props.onClick()
  tree = render(api.ActivityRail, props)
  assert.equal(shown(), 12)
  assert.equal(requests, 0)
})

test('activity grouping tracks actual sessions and retains the active round while separating a fresh recovery', () => {
  const { api } = harness()
  const groups = api.groupActivities([
    { id: 'closed-latest', workerSessionId: 'one', status: 'closed', createdAt: 1, updatedAt: 40 },
    { id: 'active', workerSessionId: 'one', continuedFrom: 'closed-latest', status: 'working', createdAt: 2, updatedAt: 30 },
    { id: 'fresh', workerSessionId: 'two', resumedFrom: 'closed-latest', status: 'idle', createdAt: 3 },
    { id: 'pending', status: 'queued', createdAt: 4 },
  ])
  assert.equal(groups.length, 3)
  assert.equal(groups[0].current.id, 'active')
  assert.deepEqual(groups[0].tasks.map((row) => row.id), ['closed-latest', 'active'])
  assert.equal(groups[1].current.id, 'fresh')
  assert.notEqual(groups[0].key, groups[1].key)
  const finished = api.groupActivities([
    { id: 'old-closed-late', workerSessionId: 'one', status: 'closed', createdAt: 1, updatedAt: 40 },
    { id: 'latest-delivery', workerSessionId: 'one', status: 'idle', createdAt: 2, updatedAt: 30 },
  ])
  assert.equal(finished[0].current.id, 'latest-delivery', 'closing an old round must not replace the latest delivery on its collapsed card')
})

test('Worker groups disclose chronological rounds with distinct links and stable accessibility targets', () => {
  const { api, render } = harness()
  const selections = []
  const group = api.groupActivities([
    { id: 'second', workerSessionId: 'one', status: 'working', createdAt: 20 },
    { id: 'first', workerSessionId: 'one', status: 'idle', createdAt: 10 },
  ])[0]
  const props = { group, t, onSelect: (task) => selections.push(task.id) }
  let tree = render(api.ActivityGroup, props)
  assert.equal(nodes(tree, (row) => row.props.role === 'region').length, 0)
  const toggle = nodes(tree, (row) => row.props['aria-controls'])[0]
  assert.equal(toggle.props['aria-expanded'], false)
  toggle.props.onClick()
  tree = render(api.ActivityGroup, props)
  const region = nodes(tree, (row) => row.props.role === 'region')[0]
  assert.equal(region.props.id, toggle.props['aria-controls'])
  assert.deepEqual(nodes(region, (row) => row.type === api.ActivityRow).map((row) => row.props.task.id), ['first', 'second'])
  const row = nodes(region, (row) => row.type === api.ActivityRow)[0]
  render(api.ActivityRow, row.props).props.onClick()
  assert.deepEqual(selections, ['first'])
})

test('rule editing preserves audience/scenes on rejected save and normalizes labels without broadening the rule', async () => {
  const { api, render } = harness()
  const calls = []
  const entry = { id: 'agr_fixture', title: 'Narration rule', text: 'Keep source evidence.', project: '', audience: 'worker', scenes: ['video'], enabled: true }
  const props = { t, data: { agreements: [entry], projects: [] }, onSave: async (draft) => { calls.push(draft); return undefined } }
  let tree = render(api.AgreementsPanel, props)
  nodes(tree, (row) => row.type === 'button' && row.children.includes('rulesEdit'))[0].props.onClick()
  tree = render(api.AgreementsPanel, props)
  assert.equal(nodes(tree, (row) => row.type === api.SelectMenu && row.props.ariaLabel === 'rulesAudience')[0].props.value, 'worker')
  nodes(tree, (row) => row.props['aria-label'] === 'rulesScenes')[0].props.onChange({ target: { value: 'Video, 口播, video' } })
  tree = render(api.AgreementsPanel, props)
  nodes(tree.props.footer, (row) => row.children.includes('rulesSave'))[0].props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls[0].scenes, ['video', '口播'])
  assert.equal(calls[0].audience, 'worker')
  tree = render(api.AgreementsPanel, props)
  assert.equal(nodes(tree, (row) => row.props['aria-label'] === 'rulesScenes')[0].props.value, 'Video, 口播, video')
})

test('the page sends the full rule draft to the server, including ownership and routing conditions', async () => {
  const requests = []
  const { api, render } = harness({ fetch: async (url, options) => {
    requests.push({ url, options })
    return { ok: true, json: async () => ({ ok: true, agreements: [] }) }
  } })
  const props = { t }
  let tree = render(api.SuperAgentPage, props)
  nodes(tree, (row) => row.type === 'button' && row.children.includes('rules'))[0].props.onClick()
  await Promise.resolve()
  tree = render(api.SuperAgentPage, props)
  const panel = nodes(tree, (row) => row.type === api.AgreementsPanel)[0]
  assert.ok(panel)
  await panel.props.onSave({ title: 'Topic video rule', text: 'Retain sources.', scope: 'topic', audience: 'worker', scenes: ['视频'], enabled: true, mode: 'append', project: '' })
  const submitted = JSON.parse(requests.findLast((entry) => entry.options?.method === 'POST').options.body)
  assert.equal(submitted.scope, 'topic')
  assert.equal(submitted.audience, 'worker')
  assert.deepEqual(submitted.scenes, ['视频'])
})

test('narrow activity uses one detail surface and preserves back navigation after a failed task load', () => {
  const { api, render } = harness()
  const tree = render(api.ActivityRail, { t, tasks: [{ id: 'one', status: 'idle' }], total: 1, embedded: true, selectedId: 'missing', detailError: 'Task unavailable' })
  assert.equal(nodes(tree, (row) => row.type === 'aside')[0].props.style.display, 'none')
  const detail = nodes(tree, (row) => row.type === api.ActivityDetail)[0]
  assert.ok(detail)
  assert.equal(detail.props.error, 'Task unavailable')
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
