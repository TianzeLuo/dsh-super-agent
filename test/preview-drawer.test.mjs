import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadClientBundle } from './client-bundle.mjs'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/**
 * 记录型 React：`createElement` 只留 type/props，hooks 返回初值。
 *
 * 用来直接调用组件函数、检查它请求的子元素（例如抽屉拿到了哪个 variant），
 * 不执行真正的渲染。`Component` 是一个最小可实例化基类，供错误边界用。
 *
 * @returns {object} React 桩。
 */
function recordingReact() {
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  }
  return {
    Component,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

test('预览是面板里的一列（对话区让位），宽度固定、有上限、无遮罩', () => {
  const { __internals: internals } = loadClientBundle()
  const panel = internals.styles.drawerPanel
  const wide = internals.styles.drawerPanelWide

  // 停靠列：flex 子项，不再 position:absolute 浮在对话上（那会盖住内容且对话区不缩宽）。
  assert.equal(panel.position, undefined, '停靠列不靠 absolute 覆盖对话区')
  assert.equal(Object.prototype.hasOwnProperty.call(panel, 'inset'), false, '不能出现 inset: 0')
  assert.match(panel.flex, /0 0 auto/, '固定宽度、不参与伸缩')
  assert.ok(panel.width >= 480 && panel.width <= 640, `宽度应在 480–640：${panel.width}`)
  assert.ok(wide.width >= 480 && wide.width <= 640, `宽版宽度应在 480–640：${wide.width}`)
  assert.match(String(panel.maxWidth), /%/, '窄窗口下按比例收，不盖满整屏')
  assert.equal(panel.minHeight, 0)
  assert.match(panel.background, /var\(--dsw-alias-bg-layer-1/, '背景跟随宿主主题')
  assert.equal(panel.pointerEvents, undefined, '不能整体禁掉指针事件')

  // 对话区让位：flex 1 1 auto + minWidth 0，才能跟着变窄而不是被挤出去。
  const area = internals.styles.conversationArea
  assert.match(area.flex, /1 1 auto/)
  assert.equal(area.minWidth, 0)

  // 正文独立滚动，列本身不裁掉内容。
  assert.equal(internals.styles.drawerBody.overflowY, 'auto')
  assert.equal(internals.styles.drawerBody.minHeight, 0)
})

test('文件预览请求的是右侧抽屉变体，而不是居中弹层', () => {
  const React = recordingReact()
  const { __internals: internals } = loadClientBundle({ react: React })
  const tree = internals.FilePreview({
    t: (key) => key,
    plan: { path: 'src/app.ts', kind: 'file' },
    sessionId: 's-1',
    pluginCtx: {},
    onClose: () => {},
  })

  assert.equal(tree.type, internals.Drawer, '外壳仍是共享的 Drawer，不另造一套')
  assert.equal(tree.props.variant, 'drawer')
  assert.equal(tree.props.wide, true)

  // 正文包在错误边界里：官方渲染器崩了只坏这一块。
  const body = tree.children.find((child) => child !== null && child !== undefined && child.type === internals.RenderBoundary)
  assert.ok(body, '抽屉正文必须有错误边界')
  assert.equal(typeof body.props.fallback, 'function')
})

test('Esc 与点抽屉外关闭；点抽屉里不关；解绑后不再响应', () => {
  const listeners = new Map()
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  }
  let closed = 0
  const unbind = loadClientBundle().__internals.bindDrawerDismiss(target, {
    isInside: (event) => event?.target === 'inside',
    onClose: () => { closed += 1 },
  })

  assert.deepEqual([...listeners.keys()].sort(), ['keydown', 'mousedown'])
  listeners.get('keydown')({ key: 'Escape' })
  assert.equal(closed, 1)
  listeners.get('keydown')({ key: 'a' })
  assert.equal(closed, 1, '其它键不关')

  listeners.get('mousedown')({ target: 'inside' })
  assert.equal(closed, 1, '点抽屉里不关')
  listeners.get('mousedown')({ target: 'outside' })
  assert.equal(closed, 2, '点抽屉外关闭')

  // 在输入框里按 Esc 是取消输入，不是关抽屉（模型/规则抽屉里有输入框）。
  listeners.get('keydown')({ key: 'Escape', target: { tagName: 'TEXTAREA' } })
  assert.equal(closed, 2, '输入框里的 Esc 不关抽屉')
  listeners.get('keydown')({ key: 'Escape', target: { tagName: 'INPUT' } })
  assert.equal(closed, 2)
  listeners.get('keydown')({ key: 'Escape', target: { tagName: 'DIV' } })
  assert.equal(closed, 3, '普通元素上的 Esc 关闭')

  unbind()
  assert.equal(listeners.size, 0, '解绑后不留监听')
  assert.doesNotThrow(() => loadClientBundle().__internals.bindDrawerDismiss(undefined, { isInside: () => false, onClose: () => {} }))
})

test('抽屉里弹出的下拉菜单算「里面」，点它不会顺带关掉抽屉', () => {
  const React = recordingReact()
  const { __internals: internals } = loadClientBundle({ react: React })
  const listeners = new Map()
  const target = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: () => {} }
  let closed = 0
  const panelNode = { contains: (node) => node.id === 'sheet' }
  const sheet = { id: 'sheet' }
  const option = { id: 'opt', closest: (selector) => (selector === '[data-super-agent-popup]' ? { id: 'menu' } : null) }
  const outside = { id: 'outside', closest: () => null }

  // 直接测真实的 isInsideDrawer：抽屉里、抽屉自己的下拉里都算「里面」。
  assert.equal(internals.isInsideDrawer(panelNode, sheet), true)
  assert.equal(internals.isInsideDrawer(panelNode, option), true)
  assert.equal(internals.isInsideDrawer(panelNode, outside), false)
  assert.equal(internals.isInsideDrawer(undefined, sheet), false, '抽屉还没挂上时不误判')
  assert.equal(internals.isInsideDrawer(panelNode, null), false)

  internals.bindDrawerDismiss(target, {
    isInside: (event) => internals.isInsideDrawer(panelNode, event?.target),
    onClose: () => { closed += 1 },
  })
  listeners.get('mousedown')({ target: sheet })
  listeners.get('mousedown')({ target: option })
  assert.equal(closed, 0, '抽屉与它自己的下拉菜单都算里面')
  listeners.get('mousedown')({ target: outside })
  assert.equal(closed, 1)
})

test('错误边界接住渲染异常并显示在抽屉/面板内，界面不整页崩', () => {
  const React = recordingReact()
  const { __internals: internals } = loadClientBundle({ react: React })
  const boundary = internals.RenderBoundary

  assert.equal(typeof boundary, 'function')
  assert.deepEqual(boundary.getDerivedStateFromError(new Error('boom')), { error: new Error('boom') })

  let retried = 0
  const instance = new boundary({ fallback: (error, reset) => ({ error, reset }) })
  Object.assign(instance.state, boundary.getDerivedStateFromError(new Error('boom')))
  const out = instance.render()
  assert.equal(out.error.message, 'boom')
  retried += 0
  out.reset()
  assert.equal(instance.state.error, undefined, '重试后清掉错误态，重新渲染')

  // 没出错时直通 children。
  const ok = new boundary({ children: 'child' })
  assert.equal(ok.render(), 'child')

  const note = internals.CrashNote({ t: (key) => key, error: new Error('boom'), onRetry: () => { retried += 1 } })
  assert.equal(note.type, 'div')
  const [title, detail, retry] = note.children
  assert.deepEqual(title.children, ['renderFailed'])
  assert.deepEqual(detail.children, ['boom'])
  retry.props.onClick()
  assert.equal(retried, 1)
})

test('错误摘要不把整段栈塞进界面', () => {
  const { __internals: internals } = loadClientBundle()
  assert.equal(internals.errorSummaryOf(undefined), 'unknown')
  assert.equal(internals.errorSummaryOf({}), '[object Object]')
  assert.equal(internals.errorSummaryOf(new Error('短消息')), '短消息')
  const long = internals.errorSummaryOf(new Error('x'.repeat(400)))
  assert.equal(long.length, 241)
  assert.ok(long.endsWith('…'))
})

test('面板槽位整体包在错误边界里（最坏情况也不再是黑屏）', () => {
  assert.match(SOURCE, /fallback: \(error, reset\) => h\(PanelCrash[\s\S]{0,300}h\(SuperAgentPage/)
})
