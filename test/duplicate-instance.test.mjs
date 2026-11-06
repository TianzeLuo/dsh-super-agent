/**
 * duplicate-instance.test.mjs — 同一页面把 client bundle 求值两次（宿主可能把同一个包
 * 同时放进聚合 boot combo 与单独的 graph row，见 `dsh-client-modules` 的
 * `buildCombo` / `graphRow`）时，**运行时只能注册一份**。
 *
 * 每份求值都有自己的模块闭包，所以模块级 WeakMap 挡不住重复；约束必须落在
 * `window` 的全局槽上：单实例标记、守卫注册表、navdebug 注册表。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientBundle } from './client-bundle.mjs'

/** 同一页面：两次求值共用一个 window 对象。 */
function twoCopies(env = {}) {
  const scope = {}
  const first = loadClientBundle({}, { ...env, window: scope, reuseWindow: true })
  const second = loadClientBundle({}, { ...env, window: scope, reuseWindow: true })
  return { scope, first, second }
}

/** 最小 layout 桩：`selectPanel` 记录调用，panelInfo 支持订阅/退订。 */
function fakeLayout(activePanelId = null) {
  const listeners = new Set()
  let current = activePanelId
  const layout = {
    selectPanel: (id) => { layout.calls.push(id); current = id },
    calls: [],
    panelInfo: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => ({ activePanelId: current }),
    },
    listeners,
  }
  return layout
}

test('两份 client 求值共用同一 layout：守卫只包一层，第二份接管第一份', () => {
  const { scope, first, second } = twoCopies()
  const layout = fakeLayout()

  const restoreFirst = first.__internals.installNavGuard({}, {
    layout,
    document: { addEventListener: () => {}, removeEventListener: () => {} },
    now: () => 1_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
  })
  const wrapped = layout.selectPanel
  const token = scope[first.__internals.NAV_GUARD_REGISTRY_KEY]
  assert.equal(token.layout, layout, '注册表落在 window 上（跨闭包可见）')

  const restoreSecond = second.__internals.installNavGuard({}, {
    layout,
    document: { addEventListener: () => {}, removeEventListener: () => {} },
    now: () => 2_000,
    storage: { getItem: () => 'on' },
    isRegistered: () => true,
  })

  assert.equal(layout.selectPanel, wrapped, '第二份不再叠一层包装')
  assert.equal(restoreSecond, restoreFirst, '拿回同一个还原句柄')
  assert.equal(scope[second.__internals.NAV_GUARD_REGISTRY_KEY].layout, layout)

  restoreSecond()
  assert.equal(scope[second.__internals.NAV_GUARD_REGISTRY_KEY], undefined, '还原后注册表清空')
})

test('两份 client 求值：navdebug 只有一份订阅（前一份被拆掉），日志不翻倍', () => {
  const { scope, first, second } = twoCopies({ location: { search: '?navdebug=1' } })
  const layout = fakeLayout()

  let unsubscribed = 0
  const originalSubscribe = layout.panelInfo.subscribe
  layout.panelInfo.subscribe = (listener) => {
    const off = originalSubscribe(listener)
    return () => {
      unsubscribed += 1
      off()
    }
  }

  first.__internals.installNavDebug({ get: () => layout })
  assert.equal(layout.listeners.size, 1)

  second.__internals.installNavDebug({ get: () => layout })
  assert.equal(unsubscribed, 1, '第二份安装时先退订第一份')
  assert.equal(layout.listeners.size, 1, '任何时刻只有一份订阅')

  const before = (scope.__SA_NAV_LOG__ ?? []).length
  for (const listener of layout.listeners) listener()
  const entries = scope.__SA_NAV_LOG__ ?? []
  const panelEntries = entries.slice(before).filter((entry) => entry.kind === 'panel')
  assert.equal(panelEntries.length, 1, '一次面板变化只记一条')
  assert.equal(panelEntries[0].source, 'layout.panelInfo')
})

test('单实例标记：第二份 claim 销毁第一份，release 只让出自己的槽位', () => {
  const { scope, first } = twoCopies()
  const instance = first.__internals.claimInstance()

  let disposed = 0
  instance.onDispose(() => { disposed += 1 })
  const token = scope[first.__internals.INSTANCE_KEY]
  assert.equal(typeof token.dispose, 'function')

  const instance2 = first.__internals.claimInstance()
  assert.equal(disposed, 1, '第二份接管时销毁第一份的安装')
  const token2 = scope[first.__internals.INSTANCE_KEY]
  assert.notEqual(token2, token)

  instance.release()
  assert.equal(scope[first.__internals.INSTANCE_KEY], token2, '旧实例 release 不能删掉新实例')
  instance2.release()
  assert.equal(scope[first.__internals.INSTANCE_KEY], undefined)
})

test('导航日志是结构化一行：type/source/target 在 JSON 里，栈是短字符串', () => {
  const { scope, first } = twoCopies({ location: { search: '?navdebug=1' } })
  const lines = []
  const originalInfo = console.info
  console.info = (...args) => { lines.push(args) }
  try {
    first.__internals.navLog('panel', { from: 'a', to: 'b' }, 'layout.selectPanel')
  } finally {
    console.info = originalInfo
  }

  assert.equal(lines.length, 1)
  const [tag, json, frames] = lines[0]
  assert.equal(tag, '[super-agent][nav]')
  const payload = JSON.parse(json)
  assert.equal(payload.type, 'panel')
  assert.equal(payload.source, 'layout.selectPanel')
  assert.equal(payload.target, 'b', 'target 取 detail.to')
  assert.match(frames, /client\.js|navLog/, '栈只留调用点')
  assert.doesNotMatch(frames, /\n/, '不打印多行栈')
  assert.deepEqual(scope.__SA_NAV_LOG__.at(-1).detail, { from: 'a', to: 'b' })
})
