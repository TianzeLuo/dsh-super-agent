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
    doc.fire(type)
    clock += 10
    assert.equal(layout.selectPanel(null), undefined, `${type} 之后应当放行`)
    assert.deepEqual(layout.calls.at(-1), null)
    layout.selectPanel('super-agent') // 复位
    clock += 10
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

  // 用户点左栏入口：手势被这次「打开」消费掉
  doc.fire('pointerdown')
  clock += 20
  assert.equal(layout.selectPanel('super-agent'), undefined)
  assert.equal(layout.state.activePanelId, 'super-agent')

  // 300ms 后宿主自动关面板（注册表抖动）：仍然要拦，不能因为刚才点过就放行
  clock += 300
  assert.equal(layout.selectPanel(null), false, '打开面板的手势不能被随后的自动关闭复用')
  assert.equal(layout.state.activePanelId, 'super-agent')

  // 用户真的再点一下：放行
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
