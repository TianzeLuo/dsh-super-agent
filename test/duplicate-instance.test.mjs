/**
 * duplicate-instance.test.mjs — 同一页面把 client bundle 求值两次时，**运行时只能注册
 * 一份**。两次求值的真实来源：启动时的聚合 boot combo，加上 `dsh-client-hmr` 对
 * `lib/client.js` 的 500ms stat 轮询——mtime/size 一变就 `clientModules.rebuilt(id)`，
 * 浏览器改用这条行的 one-resource combo（`plugins/??dsh-super-agent/client.js&rev=…`）
 * 重新求值（宿主正常会先拆掉旧 fiber，这里是兜底）。
 *
 * 每份求值都有自己的模块闭包，所以模块级 WeakMap 挡不住重复；约束必须落在
 * `window` 的全局槽上：单实例标记（先到者持有，后到者退出）、守卫注册表、
 * navdebug 注册表。
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

test('两份 client 求值共用同一 layout：守卫只包一层，第二份复用第一份的还原句柄', () => {
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

test('单实例标记：第二份 claim 直接退出（undefined），不销毁、不接管第一份', () => {
  const { scope, first, second } = twoCopies()
  const instance = first.__internals.claimInstance()
  const token = scope[first.__internals.INSTANCE_KEY]
  assert.equal(token, instance, '先到者持有全局槽')

  const secondInstance = second.__internals.claimInstance()
  assert.equal(secondInstance, undefined, '后到者拿不到令牌（apply 里据此直接退出）')
  assert.equal(scope[second.__internals.INSTANCE_KEY], token, '第一份的令牌不受影响')

  instance.release()
  assert.equal(scope[first.__internals.INSTANCE_KEY], undefined, '卸载时让出槽位')

  // 让出之后新的求值可以重新持有（HMR 正常拆掉旧 fiber 的路径）。
  const third = second.__internals.claimInstance()
  assert.notEqual(third, undefined)
  assert.equal(scope[second.__internals.INSTANCE_KEY], third)
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
