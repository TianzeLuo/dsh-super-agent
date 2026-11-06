import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClientBundle } from './client-bundle.mjs'

/**
 * 造一个和宿主同形状的 layout 桩：`panelInfo.getSnapshot()` 给当前面板，
 * `selectPanel(id)` 记录并改写。
 *
 * @param {string|null} initial 初始 activePanelId。
 * @returns {object} layout 桩。
 */
function fakeLayout(initial) {
  const state = { activePanelId: initial }
  const calls = []
  return {
    state,
    calls,
    panelInfo: { getSnapshot: () => ({ ...state }) },
    selectPanel(id) {
      calls.push(id)
      state.activePanelId = id
    },
  }
}

/** 记录监听器的 document 桩，`fire(type)` 触发 capture 监听。 */
function fakeDocument() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const rows = listeners.get(type) ?? []
      const index = rows.indexOf(fn)
      if (index >= 0) rows.splice(index, 1)
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type })
    },
    count() {
      return [...listeners.values()].reduce((sum, rows) => sum + rows.length, 0)
    },
  }
}

test('没有用户手势的自动切换被拦下（宿主三条自动关闭路径都会走到这里）', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => null },
    isRegistered: () => true,
  })

  // 1) ui-layout 的 retainMainPanels：注册表瞬时缺条目 → activePanelId = null
  assert.equal(layout.selectPanel(null), false, '没手势的 selectPanel(null) 必须被拦下')
  // 2) ui-workspace 的 replaceMain(..., 'reveal')：openSession 内部关面板
  assert.equal(layout.selectPanel(null), false)
  // 3) 切到别的面板
  assert.equal(layout.selectPanel('paper-reader'), false)
  assert.deepEqual(layout.calls, [], '原方法一次都没被调到——面板没有被切走')
  assert.equal(layout.state.activePanelId, 'super-agent')

  guard()
})

test('用户手势（点击/按键/前进后退）之内的切换照常放行', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  let clock = 1_000
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => clock,
    storage: { getItem: () => null },
    isRegistered: () => true,
  })

  for (const type of ['pointerdown', 'mousedown', 'keydown', 'popstate', 'hashchange']) {
    // 每种手势都当成「另一次点击」（真实里不会 10ms 内连发五种），步长要大于
    // 同一次点击的合并窗口（350ms）。
    clock += 400
    doc.fire(type)
    assert.equal(layout.selectPanel(null), undefined, `${type} 之后应当放行`)
    assert.deepEqual(layout.calls.at(-1), null)
    layout.selectPanel('super-agent') // 复位
  }
  assert.equal(layout.calls.filter((id) => id === null).length, 5)
  guard()
})

test('手势是一次性令牌：点开面板那一下不给随后的自动关闭背书', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout(null)
  const doc = fakeDocument()
  let clock = 1_000
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => clock,
    storage: { getItem: () => null },
    isRegistered: () => true,
  })

  // 用户点左栏入口（pointerdown + 同一次点击的 mousedown）→ 打开面板，手势被消费
  doc.fire('pointerdown')
  clock += 20
  assert.equal(layout.selectPanel('super-agent'), undefined)
  assert.equal(layout.state.activePanelId, 'super-agent')
  doc.fire('mousedown') // 同一次点击的第二个事件，不能重新上膛
  clock += 5
  assert.equal(layout.selectPanel(null), false, 'pointerdown+mousedown 属同一次点击，只算一次手势')
  assert.equal(layout.state.activePanelId, 'super-agent')

  // 300ms 后宿主自动关面板（注册表抖动）：仍然要拦
  clock += 300
  assert.equal(layout.selectPanel(null), false, '打开面板的手势不能被随后的自动关闭复用')
  assert.equal(layout.state.activePanelId, 'super-agent')

  // 用户真的再点一下（另一次点击）：放行
  clock += 600
  doc.fire('pointerdown')
  clock += 20
  assert.equal(layout.selectPanel(null), undefined)
  assert.equal(layout.state.activePanelId, null)
  guard()
})

test('手势过期、打开本面板、面板不是我们时都不拦', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  let clock = 1_000
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => clock,
    storage: { getItem: () => null },
    isRegistered: () => true,
  })

  doc.fire('pointerdown')
  clock += internals.NAV_GESTURE_WINDOW_MS + 1
  assert.equal(layout.selectPanel(null), false, '超出手势窗口的自动切换仍要拦')

  clock += 10
  assert.equal(layout.selectPanel('super-agent'), undefined, '打开本面板永远放行')

  layout.state.activePanelId = null
  assert.equal(layout.selectPanel(null), undefined, '面板本来就没开时不拦')
  layout.state.activePanelId = 'other-panel'
  assert.equal(layout.selectPanel(null), undefined, '已经不在我们面板上时不拦')
  guard()
})

test('插件卸载/条目真的消失时放行（不硬撑一个不存在的面板）', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => null },
    isRegistered: () => false,
  })
  assert.equal(layout.selectPanel(null), undefined)
  assert.deepEqual(layout.calls, [null])
  guard()
})

test('解绑后恢复原方法、移除监听；关掉开关就完全不改宿主', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const original = layout.selectPanel
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => null },
    isRegistered: () => true,
  })
  assert.notEqual(layout.selectPanel, original)
  assert.equal(doc.count(), 5, '五个手势监听')
  guard()
  assert.equal(layout.selectPanel, original, '解绑后恢复')
  assert.equal(doc.count(), 0, '解绑后不留监听')

  const offLayout = fakeLayout('super-agent')
  const offDoc = fakeDocument()
  const offOriginal = offLayout.selectPanel
  const off = internals.installNavGuard({}, {
    layout: offLayout,
    document: offDoc,
    now: () => 1_000,
    storage: { getItem: () => 'off' },
    isRegistered: () => true,
  })
  assert.equal(offLayout.selectPanel, offOriginal, '关掉后不包装')
  assert.equal(offDoc.count(), 0, '关掉后不监听')
  assert.equal(internals.navGuardEnabled({ getItem: () => 'off' }), false)
  assert.equal(internals.navGuardEnabled({ getItem: () => null }), true)
  assert.equal(internals.navGuardEnabled({ getItem: () => { throw new Error('denied') } }), true)
  off()
})

test('宿主直接写 store（retainMainPanels）也会被拦：条目还在就恢复，条目没了就放行', async () => {
  const { __internals: internals } = loadClientBundle()
  const state = { activePanelId: 'super-agent' }
  const subscribers = new Set()
  const emit = () => { for (const fn of [...subscribers]) fn() }
  let registered = true
  const layout = {
    panelInfo: { getSnapshot: () => ({ ...state }), subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn) } },
    selectPanel(id) { state.activePanelId = id; emit() },
  }
  const doc = fakeDocument()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => null },
    isRegistered: () => registered,
  })

  // ui-layout:410 —— 注册表瞬时缺条目，直接置 null，不经过 selectPanel
  state.activePanelId = null
  emit()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(state.activePanelId, 'super-agent', '条目还在：把面板恢复回来，用户不会被切走')

  // 条目真的没了（插件卸载）：不硬撑
  registered = false
  state.activePanelId = null
  emit()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(state.activePanelId, null, '条目消失时放行')

  // 用户自己关（有手势）时不恢复
  registered = true
  state.activePanelId = 'super-agent'
  doc.fire('pointerdown')
  state.activePanelId = null
  emit()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(state.activePanelId, null, '合法导航不被拉回')
  guard()
})

test('冻结的 layout / 缺失的 layout 都不会让插件崩', () => {
  const { __internals: internals } = loadClientBundle()
  const frozen = Object.freeze({ panelInfo: { getSnapshot: () => ({ activePanelId: 'super-agent' }) }, selectPanel() {} })
  const doc = fakeDocument()
  assert.doesNotThrow(() => {
    const dispose = internals.installNavGuard({}, { layout: frozen, document: doc, now: () => 1_000, storage: { getItem: () => null } })
    dispose()
  })
  assert.doesNotThrow(() => internals.installNavGuard({}, { layout: undefined, document: undefined })())
})

test('同一个 layout 只包一层（ctx.inject 重复回调也不会叠包装）', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const original = layout.selectPanel
  const first = internals.installNavGuard({}, { layout, document: doc, now: () => 1_000, storage: { getItem: () => null }, isRegistered: () => true })
  const second = internals.installNavGuard({}, { layout, document: doc, now: () => 1_000, storage: { getItem: () => null }, isRegistered: () => true })
  assert.equal(doc.count(), 5, '第二层不再挂监听')
  assert.equal(layout.selectPanel(null), false, '只有一层照样拦')
  second()
  assert.equal(layout.selectPanel(null), false, '一次解绑不会把守卫拆掉')
  first()
  assert.equal(layout.selectPanel, original, '真正解绑后恢复原方法')
  assert.equal(doc.count(), 0)
})

/** 造一个「主视图 retain 着 s-1」的 sessions 服务桩。 */
function fakeSessions(current = 's-1') {
  const byId = {}
  if (current !== undefined) byId[current] = { retainedBy: { mainView: 1 } }
  const opened = []
  return {
    opened,
    list: { getSnapshot: () => ({ byId, phase: 'ready' }) },
    // 宿主 0.1.6 的会话打开器之一，守卫必须和 openSession 一样包住。
    open: (target) => { opened.push(target) },
  }
}

/** 造一个记录 openSession 的 uiWorkspace 桩。 */
function fakeWorkspace() {
  const opened = []
  return {
    opened,
    openSession: (target) => { opened.push(target) },
  }
}

test('无手势的跨会话跳转被拦下（away-notify 的 pendingFocus 走 openSession，绕过 selectPanel）', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions: fakeSessions('s-1'),
    workspace,
  })

  workspace.openSession('s-2')
  assert.deepEqual(workspace.opened, [], '没有手势：不切会话')
  const queued = internals.takePanelReveal()
  assert.equal(queued?.sessionId, 's-2', '降级成面板内定位提示')
  assert.equal(queued?.reason, 'blocked-switch')
  guard()
  assert.equal(typeof workspace.openSession, 'function')
})

test('点通知（页面内有手势）后同一个跳转放行；手势窗口过了就恢复拦截', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  let clock = 5_000
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => clock,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions: fakeSessions('s-1'),
    workspace,
  })
  internals.takePanelReveal()

  doc.fire('pointerdown')
  workspace.openSession('s-2')
  assert.deepEqual(workspace.opened, ['s-2'], '点击引发的跳转照常')

  // 手势窗口（1.5s）过后，又一个「无人点」的 pendingFocus 回来 → 拦。
  clock += internals.NAV_GESTURE_WINDOW_MS + 500
  workspace.openSession('s-3')
  assert.deepEqual(workspace.opened, ['s-2'], '没有手势就拦')
  guard()
})

test('用户主动点会话（目标就是当前会话 / 启动时没有会话）都放行', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout(null)
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions: fakeSessions(undefined),
    workspace,
  })

  workspace.openSession('s-1')
  assert.deepEqual(workspace.opened, ['s-1'], '还没有当前会话（启动/launch URL）→ 放行')
  workspace.openSession('s-1')
  assert.deepEqual(workspace.opened, ['s-1', 's-1'], '目标就是当前会话 → 放行')
  guard()
})

test('守卫还原时把 openSession 换回原函数（不留包装）', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  const original = workspace.openSession
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions: fakeSessions('s-1'),
    workspace,
  })
  assert.notEqual(workspace.openSession, original, '装上后是包装函数')
  guard()
  assert.equal(workspace.openSession, original, '还原必须换回宿主原函数')
})

test('sessions.open 也被包住：无手势跨会话被拦，还原后换回原函数', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  const sessions = fakeSessions('s-1')
  const originalOpen = sessions.open
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions,
    workspace,
  })
  assert.notEqual(sessions.open, originalOpen, 'sessions.open 也是会话打开器，必须包住')
  sessions.open('s-2')
  assert.deepEqual(sessions.opened, [], '无手势的跨会话跳转被拦')
  assert.deepEqual(workspace.opened, [], '不会绕道 openSession')
  guard()
  assert.equal(sessions.open, originalOpen, '还原必须换回宿主原函数')
  sessions.open('s-2')
  assert.deepEqual(sessions.opened, ['s-2'], '还原后放行')
})

test('ctx.inject 回调重复跑也只包一层（还原后不留包装）', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const workspace = fakeWorkspace()
  const original = workspace.openSession
  // 模拟宿主服务重启后再次回调：同一份 workspace 会被交给两次。
  const ctx = {
    inject: (deps, callback) => {
      callback({ uiWorkspace: workspace })
      callback({ uiWorkspace: workspace })
    },
  }
  const guard = internals.installNavGuard(ctx, {
    layout,
    document: fakeDocument(),
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions: fakeSessions('s-1'),
  })
  guard()
  assert.equal(workspace.openSession, original, '叠了两层的话还原只会拆掉最外层，守卫会泄漏')
})

test('我们不在台上（面板条目已消失）时不干预会话切换', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout(null)
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => false,
    sessions: fakeSessions('s-1'),
    workspace,
  })
  workspace.openSession('s-2')
  assert.deepEqual(workspace.opened, ['s-2'])
  guard()
})

test('我们自己的用户意图导航（await 过、手势已过期）可以用显式授权放行', () => {
  const { __internals: internals } = loadClientBundle()
  const layout = fakeLayout('super-agent')
  const doc = fakeDocument()
  const workspace = fakeWorkspace()
  const guard = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
    sessions: fakeSessions('s-1'),
    workspace,
  })
  internals.takePanelReveal()

  workspace.openSession('worker-1')
  assert.deepEqual(workspace.opened, [], '没有授权时照拦')

  internals.authorizeNavigation()
  workspace.openSession('worker-1')
  assert.deepEqual(workspace.opened, ['worker-1'], '显式授权后放行（「在会话中打开」）')
  guard()
})
