/**
 * preview-tabs.test.mjs — 预览列的多标签行为（对齐宿主右侧栏）。
 *
 * 用户实测的问题：点第一个文件开右侧，点第二个文件直接把右侧关掉/替换，不能累积。
 * 这里把标签状态收敛成纯函数测：新增不覆盖、重复去重、关闭后激活相邻、关到
 * 最后一个才收起；列宽按面板宽度自适应并给对话区留最小宽度。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientBundle } from './client-bundle.mjs'

const { __internals: internals } = loadClientBundle()

const planOf = (path) => ({ path, scope: 'absolute' })

test('打开新文件：追加标签并激活，已有标签一个都不关', () => {
  const first = internals.previewTabsAdd([], planOf('/a.ts'))
  assert.deepEqual(first.tabs.map((tab) => tab.id), ['/a.ts'])
  assert.equal(first.activeId, '/a.ts')

  const second = internals.previewTabsAdd(first.tabs, planOf('/b.md'))
  assert.deepEqual(second.tabs.map((tab) => tab.id), ['/a.ts', '/b.md'], '第二个文件是新增，不是替换')
  assert.equal(second.activeId, '/b.md', '新标签自动激活')
  assert.deepEqual(second.tabs[0].plan, { path: '/a.ts', scope: 'absolute' }, '保留原标签的 plan')
  assert.equal(first.tabs.length, 1, '不改原数组（React 状态不可变）')
})

test('同一个文件重复点击：只激活已有标签，不重复开', () => {
  const state = internals.previewTabsAdd(internals.previewTabsAdd([], planOf('/a.ts')).tabs, planOf('/b.md'))
  const again = internals.previewTabsAdd(state.tabs, planOf('/a.ts'))

  assert.equal(again.tabs.length, 2, '仍然只有两个标签')
  assert.equal(again.activeId, '/a.ts', '切回已开标签')
  assert.equal(again.tabs, state.tabs, '标签数组原样复用（不新建对象）')
})

test('关闭活动标签：激活相邻标签；关到最后一个才收起整列', () => {
  const state = { tabs: [{ id: '/a.ts', plan: planOf('/a.ts') }, { id: '/b.md', plan: planOf('/b.md') }, { id: '/c.json', plan: planOf('/c.json') }], activeId: '/b.md' }

  const middle = internals.previewTabsClose(state.tabs, state.activeId, '/b.md')
  assert.deepEqual(middle.tabs.map((tab) => tab.id), ['/a.ts', '/c.json'])
  assert.equal(middle.activeId, '/c.json', '关中间的活动标签，激活右邻')

  const last = internals.previewTabsClose(middle.tabs, middle.activeId, '/c.json')
  assert.deepEqual(last.tabs.map((tab) => tab.id), ['/a.ts'])
  assert.equal(last.activeId, '/a.ts', '关到最后一个，激活左邻')

  const empty = internals.previewTabsClose(last.tabs, last.activeId, '/a.ts')
  assert.deepEqual(empty, { tabs: [], activeId: '' }, '最后一个关掉 → 整列收起')
})

test('关闭非活动标签：活动标签不变', () => {
  const tabs = [{ id: '/a.ts', plan: planOf('/a.ts') }, { id: '/b.md', plan: planOf('/b.md') }]
  const next = internals.previewTabsClose(tabs, '/b.md', '/a.ts')
  assert.deepEqual(next.tabs.map((tab) => tab.id), ['/b.md'])
  assert.equal(next.activeId, '/b.md', '不因为关别人而切走')
})

test('列宽：宽屏 640、面板 < 1000 降到 480，任何情况下给对话留 320', () => {
  assert.equal(internals.previewWidthFor(1176, undefined), 640)
  assert.equal(internals.previewWidthFor(1000, undefined), 640, '刚好 1000 仍算宽屏')
  assert.equal(internals.previewWidthFor(999, undefined), 480, '面板 < 1000 用 480')
  assert.equal(internals.previewWidthFor(820, undefined), 480)
  assert.equal(internals.previewWidthFor(700, undefined), 380, '再窄就继续收，保证对话 ≥ 320')
  assert.equal(internals.previewWidthFor(0, undefined), 640, '宽度未知按宽屏')
})

test('列宽拖拽值走同一套上下限，不会把对话区挤没', () => {
  assert.equal(internals.previewWidthFor(1176, 800), 720, '最宽 720')
  assert.equal(internals.previewWidthFor(1176, 200), 360, '最窄 360')
  assert.equal(internals.previewWidthFor(700, 640), 380, '面板很窄时拖宽也受 320 对话下限约束')
  assert.equal(internals.previewWidthFor(1176, 520), 520, '拖到哪就是哪')
})

test('标签名与图标：文件名取最后一段，按扩展名给图标', () => {
  assert.equal(internals.previewFileName('<local>/proj/src/app.ts'), 'app.ts')
  assert.equal(internals.previewFileName('F:\\proj\\docs\\readme.md'), 'readme.md')
  assert.equal(internals.previewFileName('/a/b/'), 'b', '去掉结尾分隔符')
  assert.equal(internals.previewIconFor('/a/app.ts'), 'fileCode')
  assert.equal(internals.previewIconFor('/a/readme.md'), 'fileMarkdown')
  assert.equal(internals.previewIconFor('/a/shot.png'), 'fileImage')
  assert.equal(internals.previewIconFor('/a/LICENSE'), 'file')
})

test('活动栏：预览收起时渲染，有标签就隐藏，关到最后一个才回来', () => {
  assert.equal(internals.activityRailVisible(undefined), true, '没有预览状态 → 显示')
  assert.equal(internals.activityRailVisible({ tabs: [], activeId: '' }), true, '空标签 → 显示')
  const one = internals.previewTabsAdd([], { path: '/a.ts' })
  assert.equal(internals.activityRailVisible(one), false, '打开预览 → 隐藏')
  const two = internals.previewTabsAdd(one.tabs, { path: '/b.md' })
  assert.equal(internals.activityRailVisible(two), false, '多标签仍隐藏')
  const left = internals.previewTabsClose(two.tabs, two.activeId, two.activeId)
  assert.equal(internals.activityRailVisible(left), false, '还剩一个标签也得让位')
  const none = internals.previewTabsClose(left.tabs, left.activeId, left.activeId)
  assert.equal(internals.activityRailVisible(none), true, '关到最后一个才恢复活动栏')
})
