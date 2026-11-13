/**
 * activity-ui.test.mjs — 活动栏的分页/计数/收起状态机。
 *
 * 浏览器半部不能跑完整 React 组件，所以把状态迁移抽成纯函数后用真实 bundle
 * 求值；这比断言源码里的正则更能保护行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientBundle } from './client-bundle.mjs'

const { __internals: internals } = loadClientBundle()
const {
  initialActivityList,
  activityListNext,
  activityListSummary,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_DEFAULT_VISIBLE,
} = internals

test('activity UI defaults to one 20-row page while the title counts the total', () => {
  assert.equal(ACTIVITY_PAGE_SIZE, 20)
  assert.equal(ACTIVITY_DEFAULT_VISIBLE, 20)
  const list = initialActivityList({ loaded: 20, total: 126 })
  const summary = activityListSummary(list)
  assert.equal(summary.total, 126)
  assert.equal(summary.shown, 20)
  assert.equal(summary.allLoaded, false)
  assert.equal(summary.canLoadMore, true)
  assert.equal(summary.collapsed, false)
})

test('show more appends a batch, shows loading, and ends at all loaded', () => {
  let list = initialActivityList({ loaded: 20, total: 126 })
  list = activityListNext(list, { type: 'more-start' })
  assert.equal(activityListSummary(list).loading, true)
  assert.equal(activityListSummary(list).canLoadMore, false, 'loading blocks a second click')

  list = activityListNext(list, { type: 'more-done', added: 20, loaded: 40, total: 126, hasMore: true })
  assert.equal(activityListSummary(list).shown, 40)
  assert.equal(activityListSummary(list).total, 126)
  assert.equal(activityListSummary(list).canLoadMore, true)

  list = activityListNext(list, { type: 'more-done', added: 86, loaded: 126, total: 126, hasMore: false })
  assert.equal(activityListSummary(list).shown, 126)
  assert.equal(activityListSummary(list).allLoaded, true)
  assert.equal(activityListSummary(list).canLoadMore, false)
  assert.equal(activityListSummary(list).total, 126)
})

test('collapse keeps the total and expand restores the default count, not all rows', () => {
  let list = initialActivityList({ loaded: 60, total: 126 })
  list = activityListNext(list, { type: 'more-done', added: 40, loaded: 60, total: 126, hasMore: true })
  assert.equal(activityListSummary(list).shown, 60)

  list = activityListNext(list, { type: 'collapse' })
  assert.equal(activityListSummary(list).collapsed, true)
  assert.equal(activityListSummary(list).total, 126)
  assert.equal(activityListSummary(list).canLoadMore, false)

  list = activityListNext(list, { type: 'expand' })
  const summary = activityListSummary(list)
  assert.equal(summary.collapsed, false)
  assert.equal(summary.total, 126)
  assert.equal(summary.shown, 20, 'expanding restores the default 20, not all 60 loaded rows')
  assert.equal(summary.canLoadMore, true)

  list = activityListNext(list, { type: 'more-start' })
  list = activityListNext(list, { type: 'more-fail' })
  assert.equal(activityListSummary(list).loading, false)
  assert.equal(activityListSummary(list).shown, 20)
})

test('empty activity has no more button and a finished batch reports all loaded', () => {
  const empty = activityListSummary(initialActivityList({ loaded: 0, total: 0 }))
  assert.equal(empty.total, 0)
  assert.equal(empty.allLoaded, true)
  assert.equal(empty.canLoadMore, false)

  let list = initialActivityList({ loaded: 6, total: 6 })
  list = activityListNext(list, { type: 'more-done', added: 0, loaded: 6, total: 6, hasMore: false })
  assert.equal(activityListSummary(list).allLoaded, true)
  assert.equal(activityListSummary(list).canLoadMore, false)
})
