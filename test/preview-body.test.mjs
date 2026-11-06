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
    languageForPath: (path) => (path.endsWith('.ts') ? 'typescript' : undefined),
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
