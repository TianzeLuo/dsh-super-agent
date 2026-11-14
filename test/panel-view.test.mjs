import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './client-bundle.mjs'

function storage(initial) {
  const rows = new Map(initial)
  return { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) }
}
function windowEvents() {
  const listeners = new Map()
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type) },
    fire: (type) => listeners.get(type)?.(),
    count: () => listeners.size,
  }
}
function host(initial = null) {
  const listeners = new Set()
  const calls = []
  let current = initial
  let registered = false
  const change = (id) => {
    if (current === id) return
    current = id
    for (const listener of [...listeners]) listener()
  }
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: current }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    selectPanel(id) {
      assert.equal(this, layout, 'the original receiver must be preserved')
      if (id === 'super-agent' && !registered) throw new Error('main panel is not registered')
      calls.push(id)
      change(id)
      return 'forwarded'
    },
  }
  return {
    layout, calls, change, listeners,
    isRegistered: () => registered,
    register: () => { registered = true },
    // Same order as native retainMainPanels: the registry changes, then the store clears.
    remove: () => { registered = false; if (current === 'super-agent') change(null) },
    current: () => current,
  }
}
const flush = () => new Promise((resolve) => queueMicrotask(resolve))
const bundle = () => loadClientBundle().__internals
function fixture(saved = 'panel', initial = null) {
  const api = bundle()
  const savedStorage = storage([[api.PANEL_VIEW_KEY, saved]])
  const eventTarget = windowEvents()
  const native = host(initial)
  const restore = api.createPanelViewRestore({ storage: savedStorage, eventTarget, isRegistered: native.isRegistered })
  return { api, savedStorage, eventTarget, native, restore }
}

test('reload waits for the real main slot and restores only once', async () => {
  const { native, restore } = fixture()
  restore.attach(native.layout)
  await flush()
  assert.deepEqual(native.calls, [], 'no selection before registration')
  native.register()
  restore.registered()
  await flush()
  assert.deepEqual(native.calls, ['super-agent'])
  native.layout.selectPanel(null)
  await flush()
  assert.equal(native.current(), null, 'restoration must never fight normal navigation')
  restore.dispose()
})

test('late layout service still restores the registered panel', async () => {
  const { native, restore } = fixture()
  native.register()
  restore.registered()
  await flush()
  restore.attach(native.layout)
  await flush()
  assert.equal(native.current(), 'super-agent')
  restore.dispose()
})

test('replacing the layout service restores once on the new service and detaches the old one', async () => {
  const { native, restore } = fixture()
  native.register()
  restore.attach(native.layout)
  restore.registered()
  await flush()
  const replacement = host()
  replacement.register()
  restore.attach(replacement.layout)
  await flush()
  assert.equal(native.listeners.size, 0)
  assert.equal(replacement.current(), 'super-agent')
  replacement.layout.selectPanel(null)
  await flush()
  assert.equal(replacement.current(), null)
  restore.dispose()
})

test('explicit session navigation cancels a queued restore even when the panel was already null', async () => {
  const { api, native, restore, savedStorage } = fixture()
  restore.attach(native.layout)
  native.register()
  restore.registered()
  assert.equal(native.layout.selectPanel(null), 'forwarded')
  await flush()
  assert.deepEqual(native.calls, [null])
  assert.equal(savedStorage.getItem(api.PANEL_VIEW_KEY), 'session')
  restore.dispose()
})

test('another main panel stays selected, before or during queued restoration', async () => {
  for (const initial of ['plugins', null]) {
    const { native, restore } = fixture('panel', initial)
    restore.attach(native.layout)
    native.register()
    restore.registered()
    if (initial === null) native.layout.selectPanel('plugins')
    await flush()
    assert.equal(native.current(), 'plugins')
    assert.equal(native.calls.includes('super-agent'), false)
    restore.dispose()
  }
})

test('HMR registry removal preserves intent and a new client restores without retaining observers', async () => {
  const { api, native, restore, savedStorage, eventTarget } = fixture('session')
  const original = native.layout.selectPanel
  native.register()
  restore.attach(native.layout)
  restore.registered()
  native.layout.selectPanel('super-agent')
  native.remove()
  assert.equal(savedStorage.getItem(api.PANEL_VIEW_KEY), 'panel')
  restore.dispose()
  assert.equal(native.layout.selectPanel, original)
  assert.equal(native.listeners.size, 0)
  assert.equal(eventTarget.count(), 0)
  const next = bundle().createPanelViewRestore({ storage: savedStorage, eventTarget, isRegistered: native.isRegistered })
  next.attach(native.layout)
  native.register()
  next.registered()
  await flush()
  assert.equal(native.current(), 'super-agent')
  assert.equal(native.listeners.size, 1)
  next.dispose()
})

test('replacing the main slot in the same client restores after a registry-only null', async () => {
  const { native, restore } = fixture('session')
  restore.attach(native.layout)
  native.register()
  const remove = restore.registered()
  native.layout.selectPanel('super-agent')
  remove()
  native.remove()
  native.register()
  restore.registered()
  await flush()
  assert.equal(native.current(), 'super-agent')
  restore.dispose()
})

test('manual Session and other-panel choices survive a full reload', async () => {
  for (const target of [null, 'plugins']) {
    const { native, restore, savedStorage } = fixture()
    native.register()
    restore.attach(native.layout)
    restore.registered()
    await flush()
    native.layout.selectPanel(target)
    restore.dispose()
    const reloaded = host()
    const next = bundle().createPanelViewRestore({ storage: savedStorage, isRegistered: reloaded.isRegistered })
    next.attach(reloaded.layout)
    reloaded.register()
    next.registered()
    await flush()
    assert.equal(reloaded.current(), null, 'the plugin should leave native restoration in charge')
    next.dispose()
  }
})

test('pagehide captures direct store navigation, and unrelated layout updates do not erase pending intent', async () => {
  const { api, native, restore, eventTarget, savedStorage } = fixture()
  restore.attach(native.layout)
  for (const notify of native.listeners) notify()
  native.register()
  restore.registered()
  await flush()
  native.change(null)
  eventTarget.fire('pagehide')
  assert.equal(savedStorage.getItem(api.PANEL_VIEW_KEY), 'session')
  restore.dispose()
})

test('failed selection does not erase saved intent or retry in a loop', async () => {
  const { api, native, restore, savedStorage } = fixture()
  restore.attach(native.layout)
  restore.registered()
  await flush()
  assert.throws(() => native.layout.selectPanel('super-agent'), /not registered/)
  assert.equal(savedStorage.getItem(api.PANEL_VIEW_KEY), 'panel')
  assert.deepEqual(native.calls, [])
  restore.dispose()
})

test('a selection rejected after registration is attempted once and never steals a later user choice', async () => {
  const { api, savedStorage, native, restore: unused } = fixture()
  unused.dispose()
  let attempts = 0
  const original = native.layout.selectPanel
  native.layout.selectPanel = function (id) {
    if (id === 'super-agent') { attempts++; throw new Error('entry changed during selection') }
    return original.call(this, id)
  }
  const restore = api.createPanelViewRestore({ storage: savedStorage, isRegistered: () => true })
  restore.attach(native.layout)
  restore.registered()
  await flush()
  await flush()
  assert.equal(attempts, 1)
  assert.equal(savedStorage.getItem(api.PANEL_VIEW_KEY), 'panel')
  native.layout.selectPanel('plugins')
  await flush()
  assert.equal(native.current(), 'plugins')
  assert.equal(attempts, 1)
  restore.dispose()
})

test('disposal cancels pending restore and releases wrappers in either lifecycle order', async () => {
  for (const detachFirst of [true, false]) {
    const { native, restore } = fixture()
    const original = native.layout.selectPanel
    const detach = restore.attach(native.layout)
    native.register()
    restore.registered()
    if (detachFirst) detach()
    restore.dispose()
    detach()
    await flush()
    assert.deepEqual(native.calls, [])
    assert.equal(native.layout.selectPanel, original)
    assert.equal(native.listeners.size, 0)
  }
})

test('window-scoped storage keeps the Session window independent from the panel window', async () => {
  const panel = fixture('panel')
  const session = fixture('session')
  for (const item of [panel, session]) {
    item.restore.attach(item.native.layout)
    item.native.register()
    item.restore.registered()
  }
  await flush()
  assert.equal(panel.native.current(), 'super-agent')
  assert.equal(session.native.current(), null)
  panel.restore.dispose()
  session.restore.dispose()
})

test('denied storage and missing layout services degrade without blocking navigation', async () => {
  const api = bundle()
  const native = host()
  const restore = api.createPanelViewRestore({
    storage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } },
    isRegistered: native.isRegistered,
  })
  restore.attach(undefined)()
  restore.attach({ selectPanel() {} })()
  restore.attach(native.layout)
  native.register()
  restore.registered()
  native.layout.selectPanel('super-agent')
  native.remove()
  native.register()
  restore.registered()
  await flush()
  assert.equal(native.current(), 'super-agent')
  native.layout.selectPanel(null)
  assert.equal(native.current(), null)
  restore.dispose()
})

test('cold startup waits for the native Session directory and honors navigation while loading', async () => {
  for (const navigate of [false, true]) {
    const { api, native, restore: unused, savedStorage } = fixture()
    unused.dispose()
    let phase = 'loading'
    const listeners = new Set()
    const restore = api.createPanelViewRestore({
      storage: savedStorage, isRegistered: native.isRegistered,
      sessions: { list: { getSnapshot: () => ({ phase }), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } } },
    })
    restore.attach(native.layout)
    native.register()
    restore.registered()
    await flush()
    assert.deepEqual(native.calls, [])
    if (navigate) native.layout.selectPanel(null)
    phase = 'ready'
    for (const listener of listeners) listener()
    await flush()
    assert.equal(native.current(), navigate ? null : 'super-agent')
    restore.dispose()
    assert.equal(listeners.size, 0)
  }
})

test('explicit notification links take priority over the saved panel view', async () => {
  const api = loadClientBundle({}, { location: { search: '?dshAwayNotifyFocus=ordinary-session' } }).__internals
  const native = host()
  const restore = api.createPanelViewRestore({ storage: storage([[api.PANEL_VIEW_KEY, 'panel']]), isRegistered: native.isRegistered })
  restore.attach(native.layout)
  native.register()
  restore.registered()
  await flush()
  assert.deepEqual(native.calls, [])
  restore.dispose()
})

/** Cordis consumes every generator yield during setup; yielded functions dispose later. */
function pluginContext(native) {
  const disposers = []
  const entries = []
  const collect = (value) => {
    if (typeof value === 'function') disposers.push(value)
    else if (value?.[Symbol.iterator]) for (const resource of value) collect(resource)
  }
  const ctx = {
    layout: native.layout,
    sessions: {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      entries: (name) => entries.filter((row) => row.options.name === name),
      register(options) {
        const entry = { options }
        entries.push(entry)
        if (options.name === 'main') native.register()
        return () => {
          entries.splice(entries.indexOf(entry), 1)
          if (options.name === 'main') native.remove()
        }
      },
      inject: (_name, factory) => collect(factory()),
    },
    get: (name) => ctx[name],
    effect: (factory) => collect(factory()),
    inject: (names, callback) => { if (names.every((name) => ctx[name])) callback(ctx) },
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
  return ctx
}

test('actual apply restores after generator setup, then survives disposing and reapplying the whole plugin', async () => {
  const key = bundle().PANEL_VIEW_KEY
  const window = { ...windowEvents(), sessionStorage: storage([[key, 'panel']]) }
  const native = host()
  for (let reload = 0; reload < 2; reload++) {
    const client = loadClientBundle({}, { window, reuseWindow: true })
    const ctx = pluginContext(native)
    client.apply(ctx)
    await flush()
    assert.equal(native.current(), 'super-agent')
    assert.equal(native.listeners.size, 1)
    ctx.dispose()
    assert.equal(native.current(), null)
    assert.equal(native.listeners.size, 0)
  }
})

test('apply removes a stale disabled navigation guard before observing navigation', async () => {
  const key = bundle().PANEL_VIEW_KEY
  const window = { ...windowEvents(), sessionStorage: storage([[key, 'panel']]) }
  const native = host('super-agent')
  native.register()
  const legacy = loadClientBundle({}, { window, reuseWindow: true })
  legacy.__internals.installNavGuard({}, {
    layout: native.layout, storage: { getItem: () => 'on' }, isRegistered: () => true,
  })
  assert.equal(native.layout.selectPanel(null), false, 'the old opt-in guard is still installed')
  const client = loadClientBundle({}, { window, reuseWindow: true })
  const ctx = pluginContext(native)
  client.apply(ctx)
  await flush()
  native.layout.selectPanel(null)
  assert.equal(native.current(), null, 'the default-off guard must not survive inside the observer')
  ctx.dispose()
})
