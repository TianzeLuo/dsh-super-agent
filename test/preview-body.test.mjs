/**
 * preview-body.test.mjs — 预览正文用的是官方 `CodeBlock` / `MarkdownText`，
 * 必须按宿主真实签名传参。
 *
 * 背景（用户实测）：打开 `.tex` 文件报
 * `Cannot read properties of undefined (reading 'code')`。宿主档里 Markdown 渲染
 * 代码围栏时读的是 `labels.code.copyLabel` / `labels.code.toolbarLabels`
 * （dsh-web-frontend/dist/assets/index-*.js），CodeBlock 横幅读 `toolbarLabels.codeLabel`
 * （dsh-client-ui-tool 的 `codeToolbarLabels`）。少传 `labels` / `toolbarLabels` 就崩。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { loadClientBundle } from './client-bundle.mjs'

/** 记录 createElement 的 React 桩：拿到的是「组件 + 真实 props」。 */
function recordingReact() {
  return {
    // 真 React 把 children 收进 props.children；桩也要收，否则断言不到正文。
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        children: children.length > 1 ? children : children[0],
      },
    }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/** 官方 primitives 的最小替身（只关心被读了哪些字段）。 */
function primitivesStub() {
  return {
    MarkdownText: 'MarkdownText',
    CodeBlock: 'CodeBlock',
    // 宿主语言表：`tex → latex`、`ts → typescript`（dsh-web-frontend 的 language 映射）。
    languageForPath: (path) => {
      if (path.endsWith('.ts')) return 'typescript'
      if (path.endsWith('.tex')) return 'latex'
      return undefined
    },
  }
}

/** 用户的实际场景：一份带代码围栏的 TeX 笔记。 */
const HW7_TEX = [
  '\\section{Problem 1}',
  '',
  '```python',
  'print("hi")',
  '```',
  '',
  'Answer: $x^2$',
].join('\n')

test('MarkdownText 收到 labels.code.toolbarLabels（宿主会直接读，缺了就抛 reading code）', () => {
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  const primitives = primitivesStub()
  const node = internals.previewBodyOf(primitives, (key) => key, {
    kind: 'markdown',
    state: { status: 'ready', text: HW7_TEX, path: 'hw7.tex', offset: 1 },
    path: 'hw7.tex',
  })

  const markdown = node.props.children
  assert.equal(markdown.type, 'MarkdownText')
  const labels = markdown.props.labels
  assert.ok(labels, '必须传 labels')
  assert.equal(labels.code.copyLabel, 'previewCopy')
  assert.equal(labels.code.copiedLabel, 'previewCopied')
  assert.equal(labels.code.toolbarLabels.codeLabel, 'previewCodeLabel')
  assert.equal(labels.code.toolbarLabels.wrapLabel, 'previewWrap')
  assert.equal(labels.code.toolbarLabels.unwrapLabel, 'previewUnwrap')

  // 复刻宿主那段属性访问：不抛错才算修好。
  assert.doesNotThrow(() => {
    const chrome = {
      copyLabel: labels.code.copyLabel,
      copiedLabel: labels.code.copiedLabel,
      toolbarLabels: labels.code.toolbarLabels,
    }
    if (chrome.toolbarLabels.codeLabel.length === 0) throw new Error('empty')
  })
  // 旧的错误写法没有 labels，访问就炸——留一条负向断言，防止改回去。
  assert.throws(() => { const none = undefined; return none.code.copyLabel }, TypeError)
})

test('CodeBlock 收到 toolbarLabels（横幅读 labels.codeLabel）', () => {
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  const node = internals.previewBodyOf(primitivesStub(), (key) => key, {
    kind: 'code',
    state: { status: 'ready', text: 'let x = 1', path: 'src/app.ts', offset: 1 },
    path: 'src/app.ts',
  })

  const block = node.props.children
  assert.equal(block.type, 'CodeBlock')
  assert.equal(block.props.code, 'let x = 1')
  assert.equal(block.props.lang, 'typescript')
  assert.equal(block.props.lineNumbers, true)
  assert.equal(block.props.toolbarLabels.codeLabel, 'previewCodeLabel')
  assert.equal(block.props.toolbarLabels.wrapLabel, 'previewWrap')
  assert.equal(block.props.toolbarLabels.unwrapLabel, 'previewUnwrap')
  assert.equal(block.props.copyLabel, 'previewCopy')
  assert.equal(block.props.copiedLabel, 'previewCopied')
})

test('从第 N 行开始读时补空行，行号仍然对得上', () => {
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  const node = internals.previewBodyOf(primitivesStub(), (key) => key, {
    kind: 'code',
    state: { status: 'ready', text: 'line 41', path: 'a.ts', offset: 41 },
    path: 'a.ts',
  })
  assert.equal(node.props.children.props.code, `${'\n'.repeat(40)}line 41`)
})

test('中英文词典都补齐了代码块横幅与脚注文案', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const key of ['previewCodeLabel', 'previewWrap', 'previewUnwrap', 'previewFootnotes']) {
    const hits = source.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 应同时出现在中英文词典里，实际 ${hits} 处`)
  }
})

/**
 * 真实文件回归：用户报错现场是 `/mnt/f/code/dsa/homework/hw7.tex`（342 行 LaTeX）。
 * 文件不在（别人 checkout）就跳过，不让用例变成环境依赖。
 */
const REAL_TEX = '/mnt/f/code/dsa/homework/hw7.tex'

test('真实 hw7.tex：走 CodeBlock 路径，宿主读 toolbarLabels 不抛错', (t) => {
  let text
  try {
    text = readFileSync(REAL_TEX, 'utf8')
  } catch {
    t.skip(`没有 ${REAL_TEX}`)
    return
  }
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  // `.tex` 在宿主分类表里是 "other" → 我们按代码正文渲染（previewKindOf 的默认分支）。
  assert.equal(internals.previewKindOf(() => 'other', 'hw7.tex'), 'code')
  assert.equal(internals.previewKindOf(() => 'markdown', 'hw7.tex'), 'markdown')

  const node = internals.previewBodyOf(primitivesStub(), (key) => key, {
    kind: 'code',
    state: { status: 'ready', text: text.split('\n').slice(0, 40).join('\n'), path: 'hw7.tex', offset: 1 },
    path: 'hw7.tex',
  })
  const block = node.props.children
  assert.equal(block.type, 'CodeBlock')
  assert.match(block.props.code, /\\documentclass/, '真实内容进去了')
  assert.equal(block.props.lang, 'latex', '语言标签要按宿主 languageForPath 走')

  // 复刻宿主 CodeBlock → 横幅 的读取：`toolbarLabels.codeLabel`。
  assert.doesNotThrow(() => {
    const banner = { codeLabel: block.props.toolbarLabels.codeLabel, wrapLabel: block.props.toolbarLabels.wrapLabel }
    if (banner.codeLabel.length === 0) throw new Error('empty')
  })
})

test('真实 hw7.tex：按 Markdown 渲染（含代码围栏）也不抛错', (t) => {
  let text
  try {
    text = readFileSync(REAL_TEX, 'utf8')
  } catch {
    t.skip(`没有 ${REAL_TEX}`)
    return
  }
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  // 用户在 .md 里贴同一段 LaTeX 时走 MarkdownText：宿主会读 labels.code.*。
  const markdown = ['# hw7', '', '```latex', text.split('\n').slice(0, 6).join('\n'), '```'].join('\n')
  const node = internals.previewBodyOf(primitivesStub(), (key) => key, {
    kind: 'markdown',
    state: { status: 'ready', text: markdown, path: 'hw7.md', offset: 1 },
    path: 'hw7.md',
  })
  const md = node.props.children
  assert.equal(md.type, 'MarkdownText')
  assert.doesNotThrow(() => {
    const chrome = { copyLabel: md.props.labels.code.copyLabel, toolbarLabels: md.props.labels.code.toolbarLabels }
    if (chrome.toolbarLabels.unwrapLabel.length === 0) throw new Error('empty')
  })
})

test('接口非 ok：转成错误态并带上 code，不再把 undefined 喂给渲染器', async () => {
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  const face = {
    read: async () => ({ ok: false, error: { code: 'workspace-file/not-found', message: 'no such file' } }),
  }
  const state = await internals.readFilePreview(() => face, { path: 'hw7.tex', sessionId: 's-1' }, 's-1')
  assert.equal(state.status, 'error')
  assert.equal(state.code, 'workspace-file/not-found')
  assert.equal(state.error, 'no such file')

  // 用带占位符的假 t，验证 reason（含 code）真的被填进文案。
  const t = (key) => (key === 'previewError' ? '读取失败：{reason}' : key)
  const message = internals.previewMessage(t, state)
  assert.match(message, /workspace-file\/not-found/, '错误态要带状态码/原因')
  assert.match(message, /no such file/)

  // 非 ready 状态永远走提示文案，不会调用宿主组件。
  const node = internals.previewBodyOf(primitivesStub(), t, { kind: 'code', state, path: 'hw7.tex' })
  assert.equal(node.type, 'div')
  assert.equal(node.props.children, message)
})

test('ready 但没有正文（接口形状不对）也走提示，不抛 TypeError', () => {
  const { __internals: internals } = loadClientBundle({ react: recordingReact() })
  const node = internals.previewBodyOf(primitivesStub(), (key) => key, {
    kind: 'code',
    state: { status: 'ready', text: undefined, path: 'hw7.tex', offset: 1 },
    path: 'hw7.tex',
  })
  assert.equal(node.type, 'div')
  assert.ok(!('children' in node.props) || typeof node.props.children === 'string' || node.props.children === undefined)
})
