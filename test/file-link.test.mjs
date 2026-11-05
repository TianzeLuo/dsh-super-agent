/**
 * file-link.test.mjs — 「点文件 → 内容可见」这条链上的纯函数与桥。
 *
 * 背景：super-agent 面板是全局 main 面板，右侧栏因此没有「屏上会话」，
 * 官方 `sidebarRight.openResource` 会抛 `sidebarRight: no session surface is mounted`。
 * 插件不能替官方挂 session surface（adopt/mounted 是 ui-sidebar-right 的私有状态），
 * 于是在面板挂载期间包装这个公开方法：只接管文件地址，其余原样调用。
 *
 * 这里不启动浏览器：在最小桩上真正执行 client bundle，直接断言地址解析、
 * 包装后的调用分支，以及「解析结果 → 读取请求」的参数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')

/** 在最小桩上求值 client bundle，返回它的导出与测试用内部函数。 */
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
  const run = new Function( // eslint-disable-line no-new-func
    'window',
    'document',
    'MutationObserver',
    'setInterval',
    'clearInterval',
    'fetch',
    'AbortController',
    source,
  )
  run(
    windowStub,
    { querySelectorAll: () => [], body: {} },
    class { observe() {} disconnect() {} },
    () => 0,
    () => {},
    async () => { throw new Error('client bundle must not fetch during load') },
    globalThis.AbortController,
  )
  return registration.factory(requireStub)
}

const client = loadClient()
const {
  parseFileAddress,
  filePreviewPlan,
  shouldBridgeFileOpen,
  fileReadRequest,
  bridgeFileOpens,
} = client.__internals

/** 官方 controller 在没有屏上会话时抛的原文（dsh-client-ui-sidebar-right/lib/client.js:2482）。 */
const NO_SURFACE = 'sidebarRight: no session surface is mounted'

/** 一个最小的 sidebarRight 桩：只保留 openResource 与 mounted。 */
function fakeSidebar({ mountedSession = undefined, openResource } = {}) {
  const calls = []
  const sidebar = {
    mounted: { getSnapshot: () => mountedSession },
    openResource: openResource ?? function openResource(address, options) {
      calls.push({ address, options })
      if (mountedSession === undefined) throw new Error(NO_SURFACE)
      return undefined
    },
  }
  return { sidebar, calls }
}

test('file addresses parse into a session, an absolute path, or nothing', () => {
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-abc/src/a%20b.ts'),
    { scope: 'session', sessionId: 'session-abc', path: 'src/a b.ts' },
  )
  // 会话内绝对路径（Windows 盘符的 `:` 在地址里保持字面量）。
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/session/session-abc/F:/proj/a.ts'),
    { scope: 'session', sessionId: 'session-abc', path: 'F:/proj/a.ts' },
  )
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/absolute/F:/proj/a.ts'),
    { scope: 'absolute', path: 'F:/proj/a.ts' },
  )
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/absolute/etc/hosts'),
    { scope: 'absolute', path: '/etc/hosts' },
  )
  assert.deepEqual(
    parseFileAddress('dsh-resource://file/absolute//server/share/a.ts'),
    { scope: 'absolute', path: '//server/share/a.ts' },
  )
  // 非文件地址、坏转义、空路径都不接管。
  assert.equal(parseFileAddress('dsh-resource://plan/session-abc/call-1'), undefined)
  assert.equal(parseFileAddress('https://example.com/a.ts'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/session/session-abc/%E0%A4%A'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/absolute/'), undefined)
  assert.equal(parseFileAddress(42), undefined)
})

test('a file preview plan keeps the requested line and the address scope', () => {
  assert.deepEqual(
    filePreviewPlan('dsh-resource://file/session/session-abc/src/app.js', { params: { line: 42 } }),
    { scope: 'session', sessionId: 'session-abc', path: 'src/app.js', line: 42 },
  )
  assert.deepEqual(
    filePreviewPlan('dsh-resource://file/absolute/F:/proj/a.ts'),
    { scope: 'absolute', path: 'F:/proj/a.ts', line: undefined },
  )
  assert.equal(filePreviewPlan('dsh-resource://plan/session-abc/call-1'), undefined)
  // 非法行号被忽略，而不是当成 0/负数传给读取端点。
  assert.equal(filePreviewPlan('dsh-resource://file/session/session-abc/a.ts', { params: { line: 0 } }).line, undefined)
})

test('the bridge only claims file opens while the sidebar has no on-screen session', () => {
  const address = 'dsh-resource://file/session/session-abc/a.ts'
  assert.equal(shouldBridgeFileOpen(address, undefined), true)
  assert.equal(shouldBridgeFileOpen(address, 'session-abc'), false)
  assert.equal(shouldBridgeFileOpen('dsh-resource://plan/x/y', undefined), false)
})

test('a file click opens the plugin preview instead of throwing', () => {
  const { sidebar, calls } = fakeSidebar()
  const opened = []
  const restore = bridgeFileOpens(sidebar, (plan) => { opened.push(plan); return true })
  assert.equal(typeof restore, 'function')

  // 修复前这一行会抛 `no session surface is mounted`。
  assert.doesNotThrow(() => sidebar.openResource('dsh-resource://file/session/session-abc/src/app.js', { params: { line: 7 } }))
  assert.deepEqual(opened, [{ scope: 'session', sessionId: 'session-abc', path: 'src/app.js', line: 7 }])
  assert.equal(calls.length, 0, 'the official controller must not be called when the bridge handles it')
  restore()
  assert.equal(sidebar.openResource.name, 'openResource')
  assert.throws(() => sidebar.openResource('dsh-resource://file/session/session-abc/a.ts'), new RegExp(NO_SURFACE))
})

test('the bridge defers ordinary sessions and non-file addresses to the official controller', () => {
  const withSession = fakeSidebar({ mountedSession: 'session-abc' })
  const opened = []
  const restoreSession = bridgeFileOpens(withSession.sidebar, (plan) => { opened.push(plan); return true })
  withSession.sidebar.openResource('dsh-resource://file/session/session-abc/a.ts', { params: { line: 3 } })
  assert.equal(opened.length, 0)
  assert.deepEqual(withSession.calls, [{ address: 'dsh-resource://file/session/session-abc/a.ts', options: { params: { line: 3 } } }])
  restoreSession()

  const noSession = fakeSidebar({ openResource: function openResource() { noSessionCalls.push(1) } })
  const noSessionCalls = []
  const restorePlain = bridgeFileOpens(noSession.sidebar, () => true)
  noSession.sidebar.openResource('dsh-resource://plan/session-abc/call-1')
  assert.equal(noSessionCalls.length, 1, 'non-file resources keep the official behavior')
  restorePlain()
})

test('a prototype method is shadowed on the instance and restored on dispose', () => {
  const calls = []
  const proto = {
    mounted: { getSnapshot: () => undefined },
    openResource(address) {
      calls.push(address)
      throw new Error(NO_SURFACE)
    },
  }
  const sidebar = Object.create(proto)
  const opened = []
  const restore = bridgeFileOpens(sidebar, (plan) => { opened.push(plan); return true })
  sidebar.openResource('dsh-resource://file/session/session-abc/a.ts')
  assert.equal(opened.length, 1)
  assert.equal(calls.length, 0)
  restore()
  assert.equal(Object.prototype.hasOwnProperty.call(sidebar, 'openResource'), false, 'the shadow is removed, not left behind')
  assert.throws(() => sidebar.openResource('dsh-resource://file/session/session-abc/a.ts'), new RegExp(NO_SURFACE))
  assert.equal(calls.length, 1, 'the prototype method is intact after dispose')
})

test('a preview with no mounted panel falls back to the official controller', () => {
  const { sidebar, calls } = fakeSidebar({ openResource: function openResource(address) { calls.push({ address }) } })
  const restore = bridgeFileOpens(sidebar, () => false)
  sidebar.openResource('dsh-resource://file/session/session-abc/a.ts')
  assert.deepEqual(calls, [{ address: 'dsh-resource://file/session/session-abc/a.ts' }])
  restore()
})

test('installing the bridge twice is a no-op and a missing service is tolerated', () => {
  const { sidebar } = fakeSidebar()
  const first = bridgeFileOpens(sidebar, () => true)
  assert.equal(bridgeFileOpens(sidebar, () => true), undefined)
  assert.equal(typeof first, 'function')
  first()
  assert.equal(bridgeFileOpens(undefined, () => true), undefined)
  assert.equal(bridgeFileOpens({}, () => true), undefined)
})

test('a preview plan becomes a bounded read request for remote.workspaceFiles', () => {
  assert.deepEqual(
    fileReadRequest({ sessionId: 'session-abc', path: 'src/app.js', line: 42 }, 'session-router'),
    { sessionId: 'session-abc', path: 'src/app.js', range: { offset: 34, limit: 400 }, targetLine: 42 },
  )
  assert.deepEqual(
    fileReadRequest({ path: 'src/app.js' }, 'session-router'),
    { sessionId: 'session-router', path: 'src/app.js', range: { offset: 1, limit: 400 }, targetLine: undefined },
  )
  // absolute 地址没有会话：用面板的 Router 会话做读取作用域。
  assert.deepEqual(
    fileReadRequest({ scope: 'absolute', path: 'F:/proj/a.ts', line: 2 }, 'session-router'),
    { sessionId: 'session-router', path: 'F:/proj/a.ts', range: { offset: 1, limit: 400 }, targetLine: 2 },
  )
  assert.equal(fileReadRequest(undefined, 'session-router'), undefined)
  assert.equal(fileReadRequest({ path: 'a.ts' }, ''), undefined)
})

test('click → plan → read request is one chain a mock can assert end to end', async () => {
  // 站点 1：右侧栏（无屏上会话）+ 官方 controller 会抛。
  const { sidebar } = fakeSidebar()
  // 站点 2：插件预览的读取端口。
  const reads = []
  const workspaceFiles = {
    async read(sessionId, path, range, signal) {
      reads.push({ sessionId, path, range, aborted: signal?.aborted === true })
      return { offset: range.offset, lines: 2, text: 'const a = 1\nconst b = 2', eof: true }
    },
  }
  let mounted
  const restore = bridgeFileOpens(sidebar, (plan) => {
    mounted = plan
    return true
  })
  // 用户点击对话里的 `src/app.js:42`（官方 chat 的 openFile → openResource）。
  sidebar.openResource('dsh-resource://file/session/session-abc/src/app.js', { params: { line: 42 } })
  const request = fileReadRequest(mounted, 'session-router')
  const controller = new AbortController()
  const page = await workspaceFiles.read(request.sessionId, request.path, request.range, controller.signal)
  restore()

  assert.deepEqual(reads, [{ sessionId: 'session-abc', path: 'src/app.js', range: { offset: 34, limit: 400 }, aborted: false }])
  assert.equal(page.lines, 2)
  assert.equal(page.eof, true)
  assert.equal(request.targetLine, 42, 'the panel highlights the line the link pointed at')
})
