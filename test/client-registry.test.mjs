/**
 * client-registry.test.mjs — 面板来源登记给 dsh-away-notify 的运行时契约。
 *
 * 为什么单独一个文件：`test/client.test.mjs` 只做源码形状断言；这里在最小桩上
 * **真正执行** client bundle 的 `apply`，验证可选契约 `awayNotifyPanels.register`
 * 的调用参数、生命周期（卸载注销）、幂等，以及 away-notify 缺席/服务晚到/调用抛错
 * 时的静默降级——这些都只在运行时才看得出来。
 *
 * 桩只覆盖 apply 会碰到的面：locale、slots、effect、inject、get。React 组件不渲染。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')

/** 在最小桩上求值 client bundle，返回 loader 注册信息与导出的插件对象。 */
function loadClient() {
  let registration
  const windowStub = { __ModuleLoader__: { load: (value) => { registration = value } } }
  /** 只在组件里用到；这里只需要「存在且是函数」。 */
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
    'window',
    'document',
    'MutationObserver',
    'setInterval',
    'clearInterval',
    'fetch',
    source,
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

/** 最小 cordis 上下文：`inject` 在依赖就绪时立刻回调，否则挂起（模拟服务晚到）。 */
function makeCtx({ panels } = {}) {
  const services = new Map()
  if (panels !== undefined) services.set('awayNotifyPanels', panels)
  const pending = []
  const disposers = []
  const ctx = {
    services,
    pending,
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: () => {}, register: () => ({}) },
    get: (name) => services.get(name),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: (deps, callback) => {
      if (deps.every((name) => services.has(name))) callback(ctx)
      else pending.push({ deps, callback })
    },
    /** 模拟 away-notify 晚于本插件加载（或热重载后重新 provide）。 */
    ready: (name, service) => {
      services.set(name, service)
      for (const run of pending.splice(0)) {
        if (run.deps.every((dep) => services.has(dep))) run.callback(ctx)
      }
    },
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  return ctx
}

/** `awayNotifyPanels` 替身：记录注册参数与注销调用。 */
function makePanels() {
  const calls = []
  const released = []
  return {
    calls,
    released,
    service: {
      version: 1,
      register(entry) {
        calls.push(entry)
        return () => released.push(entry)
      },
    },
  }
}

test('client bundle exports the expected loader id and static inject list', () => {
  const { registration, exports } = loadClient()
  assert.equal(registration.id, 'dsh-super-agent')
  // 关键：awayNotifyPanels 不能进静态 inject，否则没装 away-notify 时整个插件不加载
  assert.deepEqual(exports.inject, ['sessions', 'slots', 'locale'])
  assert.equal(exports.PANEL_ID, 'super-agent')
})

test('apply 把面板 id 与 retain 来源显式注册给 awayNotifyPanels（替代 15s 自动学习）', () => {
  const panels = makePanels()
  const ctx = makeCtx({ panels: panels.service })
  const { exports } = loadClient()

  assert.doesNotThrow(() => exports.apply(ctx))
  assert.equal(panels.calls.length, 1, '注册一次，且只注册一次')
  assert.deepEqual(panels.calls[0], { panelId: 'super-agent', sources: ['superAgentUi'] })
  ctx.dispose()
})

test('面板卸载（插件卸载/热重载）时调用注册返回的注销函数，不残留', () => {
  const panels = makePanels()
  const ctx = makeCtx({ panels: panels.service })
  const { exports } = loadClient()

  exports.apply(ctx)
  assert.deepEqual(panels.released, [], '挂载期间不应注销')
  ctx.dispose()
  assert.equal(panels.released.length, 1, '卸载时必须注销')
  assert.deepEqual(panels.released[0], { panelId: 'super-agent', sources: ['superAgentUi'] })
})

test('重复 apply（重新挂载）各自注册、各自注销，不累积', () => {
  const first = makePanels()
  const second = makePanels()
  const firstCtx = makeCtx({ panels: first.service })
  const secondCtx = makeCtx({ panels: second.service })
  const { exports } = loadClient()

  exports.apply(firstCtx)
  exports.apply(secondCtx)
  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 1)
  firstCtx.dispose()
  assert.equal(first.released.length, 1)
  assert.equal(second.released.length, 0, '注销自己那份，不能顺手撤掉别人的')
  secondCtx.dispose()
  assert.equal(second.released.length, 1)
})

test('awayNotifyPanels 不存在（没装 away-notify）时 apply 不抛错、也不注册', () => {
  const ctx = makeCtx()
  const { exports } = loadClient()

  assert.doesNotThrow(() => exports.apply(ctx))
  assert.equal(ctx.services.has('awayNotifyPanels'), false)
  ctx.dispose()
})

test('服务晚到：away-notify 后加载时补注册（auto 学习不需要再兜底）', () => {
  const ctx = makeCtx()
  const { exports } = loadClient()
  exports.apply(ctx)
  const panels = makePanels()

  ctx.ready('awayNotifyPanels', panels.service)
  assert.equal(panels.calls.length, 1, '服务出现后必须补注册')
  assert.deepEqual(panels.calls[0], { panelId: 'super-agent', sources: ['superAgentUi'] })
  ctx.dispose()
  assert.equal(panels.released.length, 1)
})

test('register 抛错时 apply 不抛错（面板照常打开）', () => {
  const ctx = makeCtx({
    panels: {
      version: 1,
      register() {
        throw new Error('away-notify: registry is closed')
      },
    },
  })
  const { exports } = loadClient()
  assert.doesNotThrow(() => exports.apply(ctx))
  ctx.dispose()
})

test('注销函数抛错时卸载不抛错', () => {
  const ctx = makeCtx({
    panels: {
      version: 1,
      register() {
        return () => { throw new Error('away-notify: already disposed') }
      },
    },
  })
  const { exports } = loadClient()
  exports.apply(ctx)
  assert.doesNotThrow(() => ctx.dispose())
})

test('服务对象没有 register（旧版 away-notify）时静默跳过', () => {
  const ctx = makeCtx({ panels: { version: 1 } })
  const { exports } = loadClient()
  assert.doesNotThrow(() => exports.apply(ctx))
  ctx.dispose()
})

test('retain 与注册共用同一个来源常量，改名字不会错位', () => {
  assert.match(source, /const PANEL_SOURCE = 'superAgentUi'/)
  assert.match(source, /sessionsService\.retain\(sessionId, \{ source: PANEL_SOURCE \}\)/)
  assert.match(source, /\{ panelId: PANEL_ID, sources: \[PANEL_SOURCE\] \}/)
  assert.doesNotMatch(source, /source: 'superAgentUi'/, 'retain 里不该再硬编码来源名')
})
