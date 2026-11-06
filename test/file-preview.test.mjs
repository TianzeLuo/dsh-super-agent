/**
 * file-preview.test.mjs — 面板文件预览的读取契约、正文类别与降级回归。
 *
 * 背景：面板是全局 main 面板，右侧栏没有「屏上会话」，官方 `openResource` 会抛
 * `sidebarRight: no session surface is mounted`（官方右栏座位在面板激活时整体隐藏，
 * 见 lib/client.js 中 file-link 注释的出处）。所以面板自己出抽屉，但正文复用
 * 官方 primitives（`CodeBlock` / `MarkdownText`），读取走公开的 `remote.workspaceFiles`。
 *
 * 真实宿主里 `workspaceFiles` 不是 `ctx.remote` 上的普通属性，而是 api-gateway 装出来的
 * 独立 Cordis 服务 `remote.workspaceFiles`；cordis 的嵌套服务转发按**调用方 fiber 的
 * inject** 过滤，没声明过就抛 `cannot get property … without inject`。这里用宿主真实导出
 * （`WorkspaceFiles` 类）+ 真 Cordis 做形状断言，并覆盖接口缺失时的降级文案。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadClientBundle } from './client-bundle.mjs'

/** 官方 primitives 的最小替身：只提供 bundle 会读的那几个导出。 */
const PRIMITIVES_STUB = {
  CodeBlock: () => null,
  MarkdownText: () => null,
  classifyFileType: (path) => {
    const suffix = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    if (['png', 'jpg', 'svg'].includes(suffix)) return 'image'
    if (['md', 'markdown', 'mdx'].includes(suffix)) return 'markdown'
    if (suffix === 'pdf') return 'pdf'
    if (suffix === 'docx') return 'word'
    if (suffix === 'xlsx') return 'excel'
    if (suffix === 'pptx') return 'ppt'
    if (suffix === 'mp4') return 'video'
    return 'code'
  },
  languageForPath: (path) => (path.endsWith('.ts') ? 'typescript' : undefined),
}

const client = loadClientBundle({ '@deepseek-ai/dsh-client-ui-primitives': PRIMITIVES_STUB })
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
  assert.deepEqual(calls[0].slice(0, 3), ['session-abc', 'F:/proj/a.ts', { offset: 34, limit: 2000 }])
  assert.equal(calls[0][3], controller.signal)
  assert.equal(state.status, 'ready')
  assert.equal(state.offset, 34)
  assert.equal(state.lines, 2)
  assert.equal(state.eof, false)
  assert.equal(state.text, 'const a = 1\nconst b = 2')
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
    range: { offset: 34, limit: 2000 },
  })
  // 宿主返回 RemoteResult，预览这里拆开后才拿得到正文。
  assert.equal(state.status, 'ready')
  assert.equal(state.offset, 34)
  assert.equal(state.text, 'const a = 1')
})

test('the drawer picks the official body per file type', () => {
  const { previewKindOf } = internals
  const classify = PRIMITIVES_STUB.classifyFileType

  // bundle 真的拿到了官方 primitives（抽屉里就是它的 CodeBlock/MarkdownText）。
  assert.equal(internals.primitives, PRIMITIVES_STUB)

  assert.equal(previewKindOf(classify, 'src/app.ts'), 'code')
  assert.equal(previewKindOf(classify, 'README.md'), 'markdown')
  assert.equal(previewKindOf(classify, 'docs/logo.png'), 'image')
  // 面板没有 PDF/Office/视频渲染器：明确说不能预览，而不是把二进制读成文本。
  assert.equal(previewKindOf(classify, 'spec/notes.pdf'), 'binary')
  assert.equal(previewKindOf(classify, 'slides/deck.pptx'), 'binary')
  // 没有官方分类器（老宿主）时按代码读，正文缺失由 noRenderer 状态兜住。
  assert.equal(previewKindOf(undefined, 'src/app.ts'), 'code')
  // 登记表里没有的图片后缀不当图片，避免 Blob 类型错。
  assert.equal(previewKindOf(() => 'image', 'a.unknownimg'), 'code')
  // CSV/TSV 官方归到表格类，但字节是文本：按代码正文读，不冒充二进制。
  assert.equal(previewKindOf(() => 'excel', 'data/rows.csv'), 'code')
  assert.equal(previewKindOf(() => 'excel', 'data/rows.TSV'), 'code')
  assert.equal(previewKindOf(() => 'excel', 'data/sheet.xlsx'), 'binary')
})

test('image suffixes map onto Blob media types', () => {
  const { imageMediaTypeOf } = internals
  assert.equal(imageMediaTypeOf('C:/p/logo.PNG'), 'image/png')
  assert.equal(imageMediaTypeOf('assets\\icon.svg'), 'image/svg+xml')
  assert.equal(imageMediaTypeOf('shots/a.jpeg'), 'image/jpeg')
  assert.equal(imageMediaTypeOf('src/app.ts'), undefined)
  assert.equal(imageMediaTypeOf('noext'), undefined)
  assert.equal(imageMediaTypeOf(undefined), undefined)
})

test('image previews read complete bytes through the same injected face', async () => {
  const data = new Uint8Array([137, 80, 78, 71])
  const calls = []
  const face = {
    readBytes: (...args) => {
      calls.push(args)
      return Promise.resolve({ ok: true, value: { offset: 0, data, eof: true, size: data.length, version: 'v1' } })
    },
  }
  const state = await internals.readFileBytes(() => face, { sessionId: 'session-abc', path: 'docs/logo.png' }, 'session-router')

  assert.equal(calls.length, 1)
  // readBytes(workspaceFileScope, path, options, signal)：整文件读取不传 range。
  assert.deepEqual(calls[0].slice(0, 3), ['session-abc', 'docs/logo.png', {}])
  assert.equal(state.status, 'ready')
  assert.equal(state.mediaType, 'image/png')
  assert.equal(state.data, data)
  assert.equal(state.eof, true)

  // RemoteResult 失败 → error 状态，不是异常。
  const denied = await internals.readFileBytes(
    () => ({ readBytes: async () => ({ ok: false, error: { code: 'workspace-file/not-found', message: 'gone' } }) }),
    { sessionId: 'session-abc', path: 'docs/logo.png' },
    '',
  )
  assert.equal(denied.status, 'error')
  assert.equal(denied.error, 'gone')

  // 接口缺失 → 降级提示；缺 readBytes 也算缺失。
  const missing = await internals.readFileBytes(() => undefined, { sessionId: 'session-abc', path: 'docs/logo.png' }, '')
  assert.equal(missing.status, 'unavailable')
  const misshapen = await internals.readFileBytes(() => ({ readBytes: 'nope' }), { sessionId: 'session-abc', path: 'a.png' }, '')
  assert.equal(misshapen.status, 'unavailable')

  // 未登记后缀 → 明确错误，不去猜媒体类型。
  const unsupported = await internals.readFileBytes(() => face, { sessionId: 'session-abc', path: 'a.bin' }, '')
  assert.equal(unsupported.status, 'error')
  assert.match(unsupported.error, /unsupported image suffix/)
})

test('non-body states carry a readable message in both dictionaries', () => {
  const zh = (key) => internals.DICT.zh[key]
  const en = (key) => internals.DICT.en[key]
  const path = 'spec/notes.pdf'

  assert.match(internals.previewMessage(zh, { status: 'binary', path }), /PDF/)
  assert.match(internals.previewMessage(en, { status: 'binary', path }), /PDF/)
  assert.match(internals.previewMessage(zh, { status: 'noRenderer', path }), /dsh-client-ui-primitives/)
  assert.match(internals.previewMessage(en, { status: 'noRenderer', path }), /dsh-client-ui-primitives/)
  // 正文态没有文案；未知态也不乱写。
  assert.equal(internals.previewMessage(zh, { status: 'ready', path }), undefined)
  assert.equal(internals.previewMessage(zh, { status: 'cancelled', path }), undefined)
  assert.equal(internals.previewMessage(zh, undefined), undefined)
})

test('the drawer body hands code, markdown and images to the official components', () => {
  // 记录 createElement 的最小 React：正文构造是纯函数，不需要 hooks 真跑。
  const recordingReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const bundle = loadClientBundle({
    react: recordingReact,
    '@deepseek-ai/dsh-client-ui-primitives': PRIMITIVES_STUB,
  })
  const { previewBodyOf } = bundle.__internals
  const t = (key) => bundle.__internals.DICT.en[key]
  const inner = (element) => element.children[0]

  const code = previewBodyOf(PRIMITIVES_STUB, t, {
    kind: 'code',
    state: { status: 'ready', path: 'src/app.ts', text: 'const a = 1\nconst b = 2', offset: 12, lines: 2, eof: true },
    imageUrl: undefined,
    path: 'src/app.ts',
  })
  const block = inner(code)
  assert.equal(block.type, PRIMITIVES_STUB.CodeBlock, '代码正文必须由官方 CodeBlock 渲染')
  assert.equal(block.props.lineNumbers, true, '官方行号')
  assert.equal(block.props.wrap, true)
  assert.equal(block.props.lang, 'typescript', '后缀 → shiki 语言走官方 languageForPath')
  assert.equal(block.props.copyLabel, 'Copy')
  assert.equal(block.props.copiedLabel, 'Copied')
  // 从第 12 行开始读：补 11 个空行，行号才和文件真实行号一致。
  assert.equal(block.props.code, `${'\n'.repeat(11)}const a = 1\nconst b = 2`)

  const markdown = inner(previewBodyOf(PRIMITIVES_STUB, t, {
    kind: 'markdown',
    state: { status: 'ready', path: 'README.md', text: '# 标题', offset: 1, lines: 1, eof: true },
    imageUrl: undefined,
    path: 'README.md',
  }))
  assert.equal(markdown.type, PRIMITIVES_STUB.MarkdownText, 'markdown 正文由官方 MarkdownText 渲染')
  assert.equal(markdown.props.text, '# 标题')

  const picture = inner(previewBodyOf(PRIMITIVES_STUB, t, {
    kind: 'image',
    state: { status: 'ready', path: 'docs/logo.png', mediaType: 'image/png', data: new Uint8Array([1]), eof: true },
    imageUrl: 'blob:preview',
    path: 'docs/logo.png',
  }))
  assert.equal(picture.type, 'img', '图片用 readBytes 的字节转 object URL')
  assert.equal(picture.props.src, 'blob:preview')
  assert.equal(picture.props.alt, 'docs/logo.png')

  // 面板没有 PDF/Office 渲染器：不猜、不读成文本，给一条说明。
  const binary = previewBodyOf(PRIMITIVES_STUB, t, {
    kind: 'binary',
    state: { status: 'binary', path: 'spec/notes.pdf' },
    imageUrl: undefined,
    path: 'spec/notes.pdf',
  })
  assert.match(String(inner(binary)), /PDF/)

  // 宿主没有官方组件：明确说无法渲染，而不是白屏。
  const noRenderer = previewBodyOf(undefined, t, {
    kind: 'code',
    state: { status: 'ready', path: 'a.ts', text: 'x', offset: 1, lines: 1, eof: true },
    imageUrl: undefined,
    path: 'a.ts',
  })
  assert.match(String(inner(noRenderer)), /dsh-client-ui-primitives/)
})
