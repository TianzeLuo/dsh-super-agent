/**
 * client-badge.test.mjs — composer 状态徽标（M3）。
 *
 * 徽标的三种失败都不会在宿主里报错：装上后永远不出现、点下去没反应、
 * 没装皮肤时样式塌掉。所以这里直接跑 bundle 的 `apply`，断言槽位注册参数
 * 与点击路由，并单独验证计数派生（0/0 隐藏、负数与 NaN 归零）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')

/** 在最小桩上求值 client bundle（同 client-registry.test.mjs 的写法）。 */
function loadClient() {
  let registration
  const windowStub = { __ModuleLoader__: { load: (value) => { registration = value } } }
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  const documentStub = { querySelectorAll: () => [], body: {} }
  const run = new Function( // eslint-disable-line no-new-func
    'window', 'document', 'MutationObserver', 'setInterval', 'clearInterval', 'fetch', source,
  )
  run(
    windowStub,
    documentStub,
    class { observe() {} disconnect() {} },
    () => 0,
    () => {},
    async () => { throw new Error('client bundle must not fetch during apply') },
  )
  return { registration, exports: registration.factory(requireStub) }
}

/** 记录槽位注册的最小 ctx。 */
function makeCtx({ layout, failBadgeSlot = false } = {}) {
  const registered = []
  const services = new Map()
  if (layout !== undefined) services.set('layout', layout)
  const disposers = []
  const ctx = {
    registered,
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options) => {
        if (failBadgeSlot && options.name === 'conversation.input.left') {
          throw new Error('slot "conversation.input.left" is not declared')
        }
        registered.push(options)
        return {}
      },
    },
    get: (name) => services.get(name),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: (deps, callback) => {
      if (deps.every((name) => services.has(name))) callback(ctx)
    },
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  return ctx
}

test('计数派生：0/0 隐藏，正数成对出现，脏值归零', () => {
  const { exports } = loadClient()
  const { badgeSummary, badgeCount } = exports.__internals

  assert.equal(badgeSummary({ running: 0, unread: 0 }), null)
  assert.equal(badgeSummary({}), null)
  assert.equal(badgeSummary(undefined), null)
  assert.deepEqual(badgeSummary({ running: 2, unread: 0 }), { running: 2, unread: 0 })
  assert.deepEqual(badgeSummary({ running: 0, unread: 5 }), { running: 0, unread: 5 })
  assert.deepEqual(badgeSummary({ running: '3', unread: '4.9' }), { running: 3, unread: 4 })
  assert.deepEqual(badgeSummary({ running: -2, unread: Number.NaN }), null)
  assert.equal(badgeCount('7'), 7)
  assert.equal(badgeCount('x'), 0)
})

test('文案分段：只列非零项，键走字典', () => {
  const { exports } = loadClient()
  const { badgeParts } = exports.__internals
  const t = (key) => ({ badgeRunning: '{count} running', badgeUnread: '{count} unread' })[key] ?? key

  assert.deepEqual(badgeParts(t, null), [])
  assert.deepEqual(badgeParts(t, { running: 2, unread: 0 }), ['2 running'])
  assert.deepEqual(badgeParts(t, { running: 0, unread: 9 }), ['9 unread'])
  assert.deepEqual(badgeParts(t, { running: 1, unread: 3 }), ['1 running', '3 unread'])
})

test('apply 注册 conversation.input.left（list 槽，带 id/order/locale）', () => {
  const ctx = makeCtx()
  const { exports } = loadClient()

  exports.apply(ctx)
  const badge = ctx.registered.find((options) => options.name === 'conversation.input.left')
  assert.ok(badge !== undefined, 'must register the composer badge')
  assert.equal(badge.id, 'super-agent-status')
  assert.equal(typeof badge.order, 'number')
  assert.equal(badge.locale, exports.NS)
  ctx.dispose()
})

test('槽位未声明时 apply 不抛错（旧宿主/精简宿主）', () => {
  const ctx = makeCtx({ failBadgeSlot: true })
  const { exports } = loadClient()
  assert.doesNotThrow(() => exports.apply(ctx))
  ctx.dispose()
})

test('点击徽标路由到 layout.selectPanel(super-agent)', () => {
  const calls = []
  const ctx = makeCtx({ layout: { selectPanel: (id) => calls.push(id) } })
  const { exports } = loadClient()
  exports.apply(ctx)

  assert.equal(exports.__internals.openSuperAgentPanel(ctx), true)
  assert.deepEqual(calls, ['super-agent'])
  ctx.dispose()
})

test('layout 缺席或 selectPanel 抛错时点击静默失败', () => {
  const { exports } = loadClient()
  const bare = makeCtx()
  exports.apply(bare)
  assert.equal(exports.__internals.openSuperAgentPanel(bare), false)
  bare.dispose()

  const throws = { selectPanel: () => { throw new Error('panel key missing') } }
  assert.equal(exports.__internals.openSuperAgentPanel({ get: () => throws }), false)
  assert.equal(exports.__internals.openSuperAgentPanel(undefined), false)
})

test('徽标不依赖皮肤：bundle 里没有 chatgpt-ui 的类名/令牌', () => {
  assert.doesNotMatch(source, /chatgpt-ui|data-chatgpt-mode|--dsh-chatgpt/)
  assert.match(source, /data-super-agent-badge/)
})
