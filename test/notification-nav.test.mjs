/**
 * notification-nav.test.mjs — 点通知回到「产生通知的实例 + 会话」，以及导航诊断开关。
 *
 * 背景（用户实测）：多实例下别的实例有消息会弹通知，**点通知不跳转**——人已经在
 * 面板里时更是毫无反应。根因是面板只把「面板 id + retain 来源」注册给
 * dsh-away-notify，没注册 `showSession`：点击最多把面板选中，面板仍停在它当时显示的
 * 实例上；away-notify 也没有任何实例概念。
 *
 * 这里覆盖三件事：
 *   1. 点击 → 面板、实例、会话三者都被请求（含「已经在目标上也照样定位」）；
 *   2. 会话 → 实例的映射只信 `/ui/state` 的 `routers`，认不出时不猜实例；
 *   3. `?navdebug=1` 才有诊断（订阅 + `window.__SA_NAV_LOG__`），默认零副作用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientBundle } from './client-bundle.mjs'

/** 两个实例各自一条 Router 会话的 `/ui/state` 应答。 */
function stateWithRoutes() {
  return {
    ok: true,
    activeInstanceId: 'default',
    routers: [
      { sessionId: 'session-default-router', instanceId: 'default' },
      { sessionId: 'session-other-router', instanceId: 'inst-other' },
    ],
    instances: [{ id: 'default', name: 'Super-agent' }, { id: 'inst-other', name: '副业' }],
  }
}

test('点通知：面板、目标实例、目标会话三者都被请求', async () => {
  const { __internals: internals } = loadClientBundle()
  const log = { opened: 0, enqueued: [] }

  const queued = await internals.revealNotificationSession('session-other-router', {
    openPanel: () => { log.opened += 1; return true },
    readState: async () => stateWithRoutes(),
    enqueue: (request) => { log.enqueued.push(request); return true },
  })

  assert.equal(queued, true)
  assert.equal(log.opened, 1, '必须先请求选中面板')
  assert.deepEqual(log.enqueued, [{
    sessionId: 'session-other-router',
    instanceId: 'inst-other',
    unresolved: false,
    reason: 'notification',
  }], '会话要连同所在实例一起交给面板')
})

test('已经在目标实例与面板上时，仍然重新定位会话（不是 no-op）', async () => {
  const { __internals: internals } = loadClientBundle()
  const log = { opened: 0, enqueued: [] }
  const deps = {
    openPanel: () => { log.opened += 1; return true },
    readState: async () => stateWithRoutes(),
    enqueue: (request) => { log.enqueued.push(request); return true },
  }

  // 同一会话点两次：第二次面板已经选中、实例也对，但请求必须照发。
  await internals.revealNotificationSession('session-default-router', deps)
  await internals.revealNotificationSession('session-default-router', deps)

  assert.equal(log.opened, 2, 'selectPanel 幂等，每次都调用')
  assert.equal(log.enqueued.length, 2)
  assert.deepEqual(log.enqueued[1], {
    sessionId: 'session-default-router',
    instanceId: 'default',
    unresolved: false,
    reason: 'notification',
  })
})

test('读不到状态、面板已经关了也不中止：请求照发，标记「认不出实例」', async () => {
  const { __internals: internals } = loadClientBundle()
  const enqueued = []

  const queued = await internals.revealNotificationSession('session-orphan', {
    openPanel: () => { throw new Error('layout: unavailable') },
    readState: async () => { throw new Error('offline') },
    enqueue: (request) => { enqueued.push(request); return true },
  })

  assert.equal(queued, true, '失败也要把定位请求交出去，让面板给出提示')
  assert.deepEqual(enqueued, [{
    sessionId: 'session-orphan',
    instanceId: undefined,
    unresolved: true,
    reason: 'notification',
  }])
})

test('会话 → 实例只信 routers；认不出时不猜实例', () => {
  const { __internals: internals } = loadClientBundle()
  const state = stateWithRoutes()

  assert.deepEqual(internals.revealTargetOf(state, 'session-other-router'), {
    sessionId: 'session-other-router',
    instanceId: 'inst-other',
  })
  assert.deepEqual(internals.revealTargetOf(state, 'session-unknown'), { sessionId: 'session-unknown' })
  assert.deepEqual(internals.revealTargetOf({ ok: true, routers: 'nope' }, 'session-x'), { sessionId: 'session-x' })
  assert.deepEqual(internals.revealTargetOf(undefined, 'session-x'), { sessionId: 'session-x' })
  assert.equal(internals.revealTargetOf(state, ''), undefined)
  assert.equal(internals.revealTargetOf(state, 42), undefined)
})

test('定位请求在面板挂载前排队，挂载后取一次就清空', () => {
  const { __internals: internals } = loadClientBundle()

  assert.equal(internals.takePanelReveal(), undefined, '没有请求时取不到东西')
  assert.equal(internals.requestPanelReveal({ sessionId: '' }), false, '空会话 id 不接受')
  assert.equal(internals.requestPanelReveal({ sessionId: 'session-a', instanceId: 'default' }), true)

  const queued = internals.takePanelReveal()
  assert.equal(queued.sessionId, 'session-a')
  assert.equal(queued.instanceId, 'default')
  assert.equal(internals.takePanelReveal(), undefined, '取过就没了，不会重复定位')
})

test('navdebug 默认关闭：不订阅面板、不在 window 上留任何东西', () => {
  const bundle = loadClientBundle()
  const { __internals: internals } = bundle
  let subscribed = 0
  const ctx = {
    get: () => ({
      panelInfo: {
        subscribe: () => { subscribed += 1; return () => {} },
      },
    }),
  }

  assert.equal(internals.navDebugOn, false)
  internals.installNavDebug(ctx)
  internals.navLog('panel', { from: 'super-agent', to: null })

  assert.equal(subscribed, 0, '关闭时不能多一个订阅（那会改变导航本身）')
  assert.equal(bundle.__window.__SA_NAV_LOG__, undefined, '关闭时不能在 window 上留日志')
})

test('?navdebug=1：activePanelId 变化带调用栈进 __SA_NAV_LOG__', () => {
  const bundle = loadClientBundle({}, { location: { search: '?navdebug=1' } })
  const { __internals: internals } = bundle
  const listeners = []
  let activePanelId = 'super-agent'
  const panelInfo = {
    subscribe: (listener) => { listeners.push(listener); return () => {} },
    getSnapshot: () => ({ activePanelId }),
  }

  assert.equal(internals.navDebugOn, true)
  internals.installNavDebug({ get: () => ({ panelInfo }) })
  assert.equal(listeners.length, 1, '开启后订阅一次')

  internals.navLog('instance', { from: 'default', to: 'inst-other' })
  activePanelId = null
  listeners[0]()

  const entries = bundle.__window.__SA_NAV_LOG__
  assert.ok(Array.isArray(entries))
  assert.deepEqual(entries.map((entry) => entry.kind), ['navdebug.on', 'instance', 'panel'])
  const panelEntry = entries[2]
  assert.deepEqual(panelEntry.detail.from, 'super-agent')
  assert.equal(panelEntry.detail.to, null)
  assert.match(panelEntry.stack, /notification-nav\.test\.mjs|client\.js/, '每条都要带调用栈')
  assert.equal(typeof panelEntry.at, 'number')
  // 「谁切的」标签：面板变化来自 layout 的 panelInfo store。
  assert.equal(panelEntry.source, 'layout.panelInfo')
  assert.equal(entries[1].source, null, '显式调用 navLog 时允许没有来源标签')
})

test('navdebug 的来源标签能区分 away-notify / layout 服务 / 我们自己的守卫', async () => {
  const bundle = loadClientBundle({}, { location: { search: '?navdebug=1' } })
  const { __internals: internals } = bundle

  await internals.revealNotificationSession('session-other-router', {
    openPanel: () => true,
    readState: async () => stateWithRoutes(),
    enqueue: () => true,
  })

  // layout.selectPanel 的包装（面板守卫）也要带标签：假装我们的面板在台上。
  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId: 'super-agent' }), subscribe: () => () => {} },
    selectPanel: () => {},
  }
  const doc = { addEventListener: () => {}, removeEventListener: () => {} }
  const dispose = internals.installNavGuard({}, {
    layout,
    document: doc,
    now: () => 1_000,
    storage: { getItem: () => null },
    isRegistered: () => true,
  })
  layout.selectPanel(null)
  dispose()

  const entries = bundle.__window.__SA_NAV_LOG__
  const bySource = (source) => entries.filter((entry) => entry.source === source)
  const reveal = bySource('away-notify.showSession')
  assert.equal(reveal.length, 1, '点通知落点标 away-notify.showSession')
  assert.equal(reveal[0].kind, 'reveal.notification')
  assert.equal(reveal[0].detail.sessionId, 'session-other-router')
  assert.equal(reveal[0].detail.instanceId, 'inst-other')
  assert.ok(['foreground', 'regain'].includes(reveal[0].detail.trigger), '带一个粗判触发时机')
  assert.equal(typeof reveal[0].detail.env.visibility, 'string')

  const blocked = bySource('layout.selectPanel').filter((entry) => entry.kind === 'nav.blocked')
  assert.equal(blocked.length, 1, '自动切走标 layout.selectPanel')
  assert.equal(blocked[0].detail.to, null)
  assert.match(blocked[0].stack, /navLog|guardedSelectPanel/, '仍带调用栈')
})

test('自动跟随开关：默认关，只有显式 on 才跟随（隐私模式下也按关处理）', () => {
  const { __internals: internals } = loadClientBundle()
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) },
  }

  assert.equal(internals.navFollowEnabled(storage), false, '默认不跟随：焦点/可见性恢复不再自动跳')
  assert.equal(internals.setNavFollow(true, storage), true)
  assert.equal(internals.navFollowEnabled(storage), true, '显式打开后恢复跟随')
  assert.equal(internals.setNavFollow(false, storage), false)
  assert.equal(internals.navFollowEnabled(storage), false, '关掉后持久化，刷新仍然关')
  assert.equal(internals.navFollowEnabled({ getItem: () => 'on' }), true)

  // 隐私模式：读写都抛错时不能炸，也按「关」处理（宁可不跳，不要悄悄切走用户）。
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(internals.navFollowEnabled(broken), false)
  assert.doesNotThrow(() => internals.setNavFollow(true, broken))
  assert.equal(internals.navFollowEnabled({}), false, '没有存储时默认关')
  assert.equal(internals.navFollowEnabled(), false, '真实环境默认关')
})

test('默认不跟随：到场的通知请求只出提示条，不会自动导航', async () => {
  const { __internals: internals } = loadClientBundle()
  // 源码契约：落点 effect 里先看开关，关了就走 offer 分支（提示 + 「定位」按钮），
  // 绝不调用 applyReveal。
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const effect = source.slice(source.indexOf('// 通知点击的落点。'))
  assert.match(effect, /if \(!navFollowEnabled\(\)\) \{[\s\S]{0,900}?kind: 'offer'/)
  assert.ok(effect.indexOf('if (!navFollowEnabled())') < effect.indexOf('void applyReveal(request)'),
    '先判开关再导航')

  // 开关关着时，请求仍然照收：只是交给提示条，不是丢弃。
  internals.requestPanelReveal({ sessionId: 'sess-notify', instanceId: 'inst-b', reason: 'showSession' })
  const queued = internals.takePanelReveal()
  assert.equal(queued?.sessionId, 'sess-notify')
  assert.equal(internals.navFollowEnabled(), false)
})

test('通知点击不被开关挡住：面板照常被激活、请求照常入队', async () => {
  const { __internals: internals } = loadClientBundle()
  const log = { opened: 0, enqueued: [] }
  const queued = await internals.revealNotificationSession('session-other-router', {
    openPanel: () => { log.opened += 1; return true },
    readState: async () => stateWithRoutes(),
    enqueue: (request) => { log.enqueued.push(request); return true },
  })
  assert.equal(queued, true)
  assert.equal(log.opened, 1, '默认关也只影响「自动跳」，不影响点通知选中面板')
  assert.equal(log.enqueued.length, 1, '请求照常交给面板（面板顶部给「定位」）')
  assert.equal(internals.navFollowEnabled(), false)
})

test('注册给 away-notify 的 showSession 真的会把请求交给面板队列', async () => {
  const { __internals: internals } = loadClientBundle()
  // 面板还没挂载：请求要留在队列里，等挂载后消费（不能丢）。
  const ok = await internals.revealNotificationSession('session-other-router', {
    openPanel: () => false,
    readState: async () => stateWithRoutes(),
  })
  assert.equal(ok, true)
  const queued = internals.takePanelReveal()
  assert.equal(queued.sessionId, 'session-other-router')
  assert.equal(queued.instanceId, 'inst-other')
  assert.equal(queued.reason, 'notification')
})
