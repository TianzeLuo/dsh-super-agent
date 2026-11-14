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

test('activity UI defaults to six rows while the title counts the total', () => {
  assert.equal(ACTIVITY_PAGE_SIZE, 6)
  assert.equal(ACTIVITY_DEFAULT_VISIBLE, 6)
  const list = initialActivityList({ loaded: 6, total: 15 })
  const summary = activityListSummary(list)
  assert.equal(summary.total, 15)
  assert.equal(summary.shown, 6)
  assert.equal(summary.allLoaded, false)
  assert.equal(summary.canLoadMore, true)
  assert.equal(summary.collapsed, false)
})

test('show more appends a batch, shows loading, and ends at all loaded', () => {
  let list = initialActivityList({ loaded: 6, total: 15 })
  list = activityListNext(list, { type: 'more-start' })
  assert.equal(activityListSummary(list).loading, true)
  assert.equal(activityListSummary(list).canLoadMore, false, 'loading blocks a second click')

  list = activityListNext(list, { type: 'more-done', added: 6, loaded: 12, total: 15, hasMore: true })
  assert.equal(activityListSummary(list).shown, 12)
  assert.equal(activityListSummary(list).total, 15)
  assert.equal(activityListSummary(list).canLoadMore, true)

  list = activityListNext(list, { type: 'more-done', added: 3, loaded: 15, total: 15, hasMore: false })
  assert.equal(activityListSummary(list).shown, 15)
  assert.equal(activityListSummary(list).allLoaded, true)
  assert.equal(activityListSummary(list).canLoadMore, false)
  assert.equal(activityListSummary(list).total, 15)
})

test('collapse keeps the total and expand restores the default count, not all rows', () => {
  let list = initialActivityList({ loaded: 18, total: 126 })
  list = activityListNext(list, { type: 'more-done', added: 12, loaded: 18, total: 126, hasMore: true })
  assert.equal(activityListSummary(list).shown, 18)

  list = activityListNext(list, { type: 'collapse' })
  assert.equal(activityListSummary(list).collapsed, true)
  assert.equal(activityListSummary(list).total, 126)
  assert.equal(activityListSummary(list).canLoadMore, false)

  list = activityListNext(list, { type: 'expand' })
  const summary = activityListSummary(list)
  assert.equal(summary.collapsed, false)
  assert.equal(summary.total, 126)
  assert.equal(summary.shown, 6, 'expanding restores six rows instead of showing the entire cache')
  assert.equal(summary.canLoadMore, true)

  list = activityListNext(list, { type: 'more-start' })
  list = activityListNext(list, { type: 'more-fail' })
  assert.equal(activityListSummary(list).loading, false)
  assert.equal(activityListSummary(list).shown, 6)
})

test('a fully loaded list can reveal its cached rows again after collapse', () => {
  let list = initialActivityList({ loaded: 6, total: 15 })
  list = activityListNext(list, { type: 'more-done', added: 9, loaded: 15, total: 15, hasMore: false })
  assert.equal(activityListSummary(list).allLoaded, true)
  list = activityListNext(list, { type: 'collapse' })
  list = activityListNext(list, { type: 'expand' })
  assert.equal(activityListSummary(list).shown, 6)
  assert.equal(activityListSummary(list).canLoadMore, true)
  list = activityListNext(list, { type: 'reveal-more' })
  assert.equal(activityListSummary(list).shown, 12)
  list = activityListNext(list, { type: 'reveal-more' })
  assert.equal(activityListSummary(list).shown, 15)
  assert.equal(activityListSummary(list).allLoaded, true)
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
