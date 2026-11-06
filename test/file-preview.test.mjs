/**
 * file-preview.test.mjs — 面板自绘预览的读取契约与降级回归。
 *
 * 背景：面板是全局 main 面板，右侧栏没有「屏上会话」，官方 `openResource` 会抛
 * `sidebarRight: no session surface is mounted`。所以插件自己读宿主文件预览接口。
 *
 * 真实宿主里 `workspaceFiles` 不是 `ctx.remote` 上的普通属性，而是 api-gateway 装出来的
 * 独立 Cordis 服务 `remote.workspaceFiles`；cordis 的嵌套服务转发按**调用方 fiber 的
 * inject** 过滤，没声明过就抛 `cannot get property … without inject`。上一轮修复用假
 * ctx 测试，没暴露这一点。这里用宿主真实导出（`WorkspaceFiles` 类）+ 真 Cordis 做形状
 * 断言，并覆盖接口缺失时的降级文案。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadClientBundle } from './client-bundle.mjs'

const client = loadClientBundle()
const internals = client.__internals

/**
 * 找宿主安装目录（Node 里能直接 import 的 @deepseek-ai 包目录）。
 *
 * 依次看：显式环境变量 → 当前 node 的全局 node_modules（nvm/系统安装的 dsh 就在这）。
 * 找不到就跳过需要宿主的用例（CI 未装 DSH），其余用例照跑。
 */
function findHostNodeModules() {
  const candidates = []
  if (typeof process.env.DSH_HOST_NODE_MODULES === 'string' && process.env.DSH_HOST_NODE_MODULES.length > 0) {
    candidates.push(process.env.DSH_HOST_NODE_MODULES)
  }
  if (typeof process.env.DSH_HOST_ROOT === 'string' && process.env.DSH_HOST_ROOT.length > 0) {
    candidates.push(join(process.env.DSH_HOST_ROOT, 'node_modules'), process.env.DSH_HOST_ROOT)
  }
  const bin = dirname(process.execPath)
  candidates.push(join(bin, '..', 'lib', 'node_modules'), join(bin, 'node_modules'))
  for (const base of candidates) {
    // 全局安装时 dsh 自带一层 node_modules，工作区文件包在它下面。
    for (const root of [base, join(base, '@deepseek-ai', 'dsh', 'node_modules')]) {
      if (existsSync(join(root, '@deepseek-ai/dsh-api-workspace-files/lib/index.js'))
        && existsSync(join(root, '@deepseek-ai/cordis/lib/index.js'))) return root
    }
  }
  return undefined
}

const HOST = findHostNodeModules()
const HOST_SKIP = HOST === undefined
  ? 'DSH host packages not found; set DSH_HOST_ROOT to the @deepseek-ai node_modules dir'
  : false

/**
 * 用宿主真实 `WorkspaceFiles` 服务搭一个最小浏览器侧现场：
 * 真 Cordis root + 真宿主服务，按 api-gateway 的方式把命名空间注册成
 * `remote.workspaceFiles`，再由本插件的 `bindWorkspaceFiles` 取到。
 *
 * @returns {Promise<{ root: object, host: object, real: object, pluginCtx: object, face: object }>}
 */
async function mountHostFace() {
  const cordis = await import(pathToFileURL(join(HOST, '@deepseek-ai/cordis/lib/index.js')).href)
  const hostModule = await import(pathToFileURL(join(HOST, '@deepseek-ai/dsh-api-workspace-files/lib/index.js')).href)
  const root = new cordis.Context()
  // 宿主默认配置（packages/api/workspace-files/src/index.ts 的 Config 默认值）。
  const real = new hostModule.WorkspaceFiles(root, {
    maxBytes: 2 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxLines: 5_000,
    maxEntries: 2_000,
  })

  // 和 api-gateway 一样：命名空间是**另一个插件 fiber** 提供的独立服务
  // （`super(ctx, 'remote.workspaceFiles')`），不是 root 上的属性。
  await root.plugin({
    name: 'remote.workspaceFiles',
    apply: (gatewayCtx) => {
      gatewayCtx.plugin({
        name: 'remote.workspaceFiles.namespace',
        apply: (scope) => { scope.provide(internals.WORKSPACE_FILES_SERVICE, real) },
      })
    },
  })

  let pluginCtx
  await root.plugin({ name: 'super-agent-test', apply: (ctx) => { pluginCtx = ctx } })
  assert.notEqual(pluginCtx, undefined, 'the plugin context must be active')

  internals.bindWorkspaceFiles(pluginCtx)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const face = internals.resolveWorkspaceFiles(pluginCtx)
  return { root, host: hostModule, real, pluginCtx, face }
}

test('a missing host interface resolves to undefined instead of throwing', () => {
  // 必须在任何 bind 之前跑：resolve 会先看模块级缓存。
  assert.equal(internals.resolveWorkspaceFiles(undefined), undefined)
  assert.equal(internals.resolveWorkspaceFiles({}), undefined)
  assert.doesNotThrow(() => internals.bindWorkspaceFiles(undefined))
  assert.doesNotThrow(() => internals.bindWorkspaceFiles({}))
})

test('the face resolved from ctx is the host WorkspaceFiles service and really has read', { skip: HOST_SKIP }, async () => {
  const { host, real, pluginCtx, face } = await mountHostFace()

  // 契约来自宿主真实导出：五个 @Remote 方法，参数个数与签名一致。
  assert.equal(typeof host.WorkspaceFiles, 'function')
  assert.equal(typeof real.read, 'function')
  assert.equal(real.read.length, 4, 'read(workspaceFileScope, path, range, signal)')
  assert.equal(real.stat.length, 3, 'stat(workspaceFileScope, path, signal)')
  assert.equal(real.readBytes.length, 4, 'readBytes(workspaceFileScope, path, options, signal)')
  assert.equal(real.list.length, 3, 'list(workspaceFileScope, path, signal)')
  assert.equal(real.changes.length, 3, 'changes(workspaceFileScope, path, signal)')
  // 读取作用域来自会话头，所以这个能力是 session 作用域的。
  assert.ok(Array.isArray(host.WorkspaceFiles.inject) && host.WorkspaceFiles.inject.includes('sessions'))

  // 上一轮失败的取法：没在插件 inject 里声明，cordis 直接抛，而不是返回 undefined。
  assert.throws(
    () => pluginCtx[internals.WORKSPACE_FILES_SERVICE],
    /without inject/,
    'the namespace must be injected, not read as a plain ctx property',
  )

  // 现在的取法：从 ctx 拿到的确实是宿主服务实例（宿主类 + 宿主服务名），read 可调用。
  assert.notEqual(face, undefined)
  assert.ok(face instanceof host.WorkspaceFiles, 'the face must be the host WorkspaceFiles instance')
  assert.equal(face.name, 'workspaceFiles')
  assert.equal(typeof face.read, 'function')
})

test('a preview reads one page through the injected face with the host call shape', { skip: HOST_SKIP }, async () => {
  const { real, pluginCtx } = await mountHostFace()
  // 只替换 I/O（真实宿主会去读文件系统），接口对象本身仍是宿主服务。
  const calls = []
  Object.defineProperty(real, 'read', {
    configurable: true,
    writable: true,
    value: (...args) => {
      calls.push(args)
      return Promise.resolve({
        ok: true,
        value: {
          offset: 34,
          text: 'const a = 1\nconst b = 2',
          lines: 2,
          eof: false,
          absolutePath: 'F:/proj/a.ts',
          version: 'v1',
        },
      })
    },
  })

  const controller = new AbortController()
  const state = await internals.readFilePreview(
    () => internals.resolveWorkspaceFiles(pluginCtx),
    { scope: 'session', sessionId: 'session-abc', path: 'F:/proj/a.ts', line: 42 },
    'session-router',
    controller.signal,
  )

  assert.equal(calls.length, 1)
  // 线上首参是 workspaceFileScopeId（会话 id），不是路径。
  assert.deepEqual(calls[0].slice(0, 3), ['session-abc', 'F:/proj/a.ts', { offset: 34, limit: 400 }])
  assert.equal(calls[0][3], controller.signal)
  assert.equal(state.status, 'ready')
  assert.equal(state.offset, 34)
  assert.equal(state.lines, 2)
  assert.equal(state.eof, false)
  assert.equal(state.text, 'const a = 1\nconst b = 2')
  assert.equal(state.targetLine, 42)
})

test('a missing interface shows the fallback message, not a crash', async () => {
  const plan = { scope: 'session', sessionId: 'session-abc', path: 'src/app.ts', line: 7 }
  const state = await internals.readFilePreview(() => undefined, plan, 'session-router')

  assert.equal(state.status, 'unavailable')
  assert.equal(state.path, 'src/app.ts')

  // 面板渲染的就是这条文案，路径要出现在里面。
  const zh = internals.previewMessage((key) => internals.DICT.zh[key], state)
  assert.match(zh, /remote\.workspaceFiles/)
  assert.match(zh, /src\/app\.ts/)
  const en = internals.previewMessage((key) => internals.DICT.en[key], state)
  assert.match(en, /no file-reading interface/)
  assert.match(en, /src\/app\.ts/)

  // 没有 read 方法（接口形状不对）同样降级。
  const misshapen = await internals.readFilePreview(() => ({ read: 'not-a-function' }), plan, 'session-router')
  assert.equal(misshapen.status, 'unavailable')
})

test('read failures and RemoteResult errors become an error state', async () => {
  const plan = { sessionId: 'session-abc', path: 'a.ts' }

  const failed = await internals.readFilePreview(
    () => ({ read: async () => ({ ok: false, error: { code: 'workspace-file/not-found', message: 'no entry at "a.ts"' } }) }),
    plan,
    'session-router',
  )
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /no entry/)
  assert.match(internals.previewMessage((key) => internals.DICT.zh[key], failed), /no entry/)

  const thrown = await internals.readFilePreview(
    () => ({ read: () => { throw new Error('boom') } }),
    plan,
    'session-router',
  )
  assert.equal(thrown.status, 'error')
  assert.equal(thrown.error, 'boom')

  // 没有会话可用 → 一样是降级，不是异常。
  const impossible = await internals.readFilePreview(() => undefined, { scope: 'absolute', path: 'F:/proj/a.ts' }, '')
  assert.equal(impossible.status, 'unavailable')
  assert.equal(impossible.path, 'F:/proj/a.ts')
})

test('the real Client Remote maps our four arguments onto the workspaceFiles/read wire call', { skip: HOST_SKIP }, async () => {
  const cordis = await import(pathToFileURL(join(HOST, '@deepseek-ai/cordis/lib/index.js')).href)
  const gateway = await import(pathToFileURL(join(HOST, '@deepseek-ai/dsh-api-gateway/lib/client.node.js')).href)
  const registry = await import(pathToFileURL(join(HOST, '@deepseek-ai/dsh-typert-registry/lib/client.node.js')).href)
  const contribution = await import(pathToFileURL(join(HOST, '@deepseek-ai/dsh-api-workspace-files/lib/typert.remote-client.js')).href)

  // 唯一的手搓件是载体（没有浏览器 WebSocket）；命名空间、编码、结果包络全是宿主的。
  const calls = []
  const root = new cordis.Context()
  root.provide('connection', {
    interactions: 'none',
    isLoopback: true,
    generation: { getSnapshot: () => ({ host: { home: '/tmp' } }) },
    rpc: {
      call: async (_path, endpoint, body) => {
        calls.push({ endpoint, body })
        return { ok: true, value: { offset: 34, text: 'const a = 1', lines: 1, eof: true, absolutePath: 'F:/proj/a.ts', version: 'v1' } }
      },
    },
    start: () => ({ stop() {} }),
    openWebSocket: () => { throw new Error('no websocket in this test') },
  })
  registry.apply(root)
  gateway.apply(root)
  await root.get('remote').$mount(contribution.TYPERT_REMOTE)

  let face
  root.plugin({ name: 'super-agent-remote-consumer', inject: ['remote.workspaceFiles'], apply: (ctx) => { face = ctx['remote.workspaceFiles'] } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(typeof face?.read, 'function')

  const controller = new AbortController()
  const state = await internals.readFilePreview(
    () => face,
    { scope: 'session', sessionId: 'session-abc', path: 'F:/proj/a.ts', line: 42 },
    '',
    controller.signal,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].endpoint, 'workspaceFiles/read')
  // 首参落到 workspaceFileScopeId（会话 id），range 原样上行。
  assert.deepEqual({ ...calls[0].body.args }, {
    workspaceFileScopeId: 'session-abc',
    path: 'F:/proj/a.ts',
    range: { offset: 34, limit: 400 },
  })
  // 宿主返回 RemoteResult，预览这里拆开后才拿得到正文。
  assert.equal(state.status, 'ready')
  assert.equal(state.offset, 34)
  assert.equal(state.text, 'const a = 1')
  assert.equal(state.targetLine, 42)
})
