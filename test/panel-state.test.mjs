/**
 * panel-state.test.mjs — 「未读 / 当前会话 / 面板可见性」的纯逻辑回归。
 *
 * 三类问题都发生在没有 UI 可点的地方，只能靠状态逻辑测：
 *   1. 人在面板里，回复仍然 +1；切回来又不清零 —— 判定必须唯一（宿主 attendance.js）；
 *   2. 切回面板落到「新会话」—— 重挂要续接原会话，不能靠 ensure 现建；
 *   3. 打字时被切走 —— 事件回调不得改写当前会话（sessionTransition）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PANEL_STALE_MS, attended, panelAlive, replyEffect } from '../lib/attendance.js'
import { InstanceRegistry } from '../lib/instances.js'
import { loadClientBundle } from './client-bundle.mjs'

const internals = loadClientBundle().__internals

/** 面板可见、心跳新鲜的基线输入。 */
function watching(overrides = {}) {
  const now = 1_000_000
  return {
    instanceId: 'default',
    activeInstanceId: 'default',
    panelActive: true,
    panelSeenAt: now - 5_000,
    visible: true,
    now,
    replied: true,
    ...overrides,
  }
}

function registryRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-super-agent-panel-'))
}

test('a reply that lands while the panel is visible is read, not counted', () => {
  assert.equal(attended(watching()), true)
  assert.equal(replyEffect(watching()), 'clear')
  // 只推进工具、没有可见文本的回合不改计数。
  assert.equal(replyEffect(watching({ replied: false })), 'ignore')
})

test('three replies while away count 3, and becoming visible clears them', () => {
  const registry = new InstanceRegistry(registryRoot())
  const away = watching({ visible: false })

  for (let index = 0; index < 3; index += 1) {
    const effect = replyEffect(away)
    assert.equal(effect, 'count')
    if (effect === 'count') registry.addUnread('default')
  }
  assert.equal(registry.unreadTotal(), 3)

  // 回来（页面可见）时的同一判定给出 clear —— 清零走的就是 +1 的判定。
  assert.equal(replyEffect(watching()), 'clear')
  if (replyEffect(watching()) === 'clear') registry.clearUnread('default')
  assert.equal(registry.unreadTotal(), 0)
})

test('a stale heartbeat, another instance, or a closed panel counts as away', () => {
  assert.equal(panelAlive(0), false)
  assert.equal(panelAlive(1_000, 1_000 + PANEL_STALE_MS), false)
  assert.equal(replyEffect(watching({ panelSeenAt: 1_000, now: 1_000 + PANEL_STALE_MS + 1 })), 'count')
  assert.equal(replyEffect(watching({ instanceId: 'other' })), 'count')
  assert.equal(replyEffect(watching({ panelActive: false })), 'count')
  assert.equal(replyEffect(watching({ visible: false })), 'count')
})

test('panel visibility is page visibility plus the active main panel', () => {
  const panelId = internals.SUPER_AGENT_PANEL_ID
  assert.equal(internals.panelVisible({ hidden: true, activePanelId: panelId, panelId }), false)
  assert.equal(internals.panelVisible({ hidden: false, activePanelId: 'other-panel', panelId }), false)
  assert.equal(internals.panelVisible({ hidden: false, activePanelId: panelId, panelId }), true)
  // null = 主视图是会话，本面板不在屏上。
  assert.equal(internals.panelVisible({ hidden: false, activePanelId: null, panelId }), false)
  // 老宿主读不到选择源（undefined）：组件挂着就当作可见（面板只在被选中时挂载）。
  assert.equal(internals.panelVisible({ hidden: false, panelId }), true)
})

test('the layout panel selection is read through the real store shape', () => {
  // dsh-client-ui-layout 暴露的是 store：panelInfo.getSnapshot().activePanelId。
  assert.equal(internals.panelIdFromLayout({ getSnapshot: () => ({ activePanelId: 'super-agent' }) }), 'super-agent')
  assert.equal(internals.panelIdFromLayout({ getSnapshot: () => ({ activePanelId: null }) }), null)
  // 裸对象（旧形态）也认。
  assert.equal(internals.panelIdFromLayout({ activePanelId: 'other-panel' }), 'other-panel')
  // 读不到 / 抛错一律「未知」。
  assert.equal(internals.panelIdFromLayout(undefined), undefined)
  assert.equal(internals.panelIdFromLayout({}), undefined)
  assert.equal(internals.panelIdFromLayout({ getSnapshot: () => { throw new Error('gone') } }), undefined)
})

test('a remount resumes the remembered session instead of starting a new one', () => {
  assert.equal(internals.cachedPanelSession('inst-a'), '')
  internals.rememberPanelSession('inst-a', 'session-router')
  assert.equal(internals.cachedPanelSession('inst-a'), 'session-router')
  // 不同实例互不串线。
  assert.equal(internals.cachedPanelSession('inst-b'), '')
  // 空值不写缓存，避免把「还没有会话」记成一条。
  internals.rememberPanelSession('inst-b', '')
  assert.equal(internals.cachedPanelSession('inst-b'), '')

  // 挂载时的宿主快照是唯一允许改写当前会话的事件。
  assert.equal(internals.sessionTransition('', { kind: 'bootstrap', sessionId: 'session-router' }), 'session-router')
  assert.equal(internals.sessionTransition('session-old', { kind: 'bootstrap', sessionId: 'session-router' }), 'session-router')
})

test('event callbacks never move the panel to another session', () => {
  const current = 'session-router'
  // 轮询、未读、徽标、worker 报告等都不是用户动作。
  assert.equal(internals.sessionTransition(current, undefined), current)
  assert.equal(internals.sessionTransition(current, null), current)
  assert.equal(internals.sessionTransition(current, { kind: 'event', sessionId: 'session-worker' }), current)
  assert.equal(internals.sessionTransition(current, { kind: 'unread', sessionId: 'session-worker' }), current)
  assert.equal(internals.sessionTransition(current, { sessionId: 'session-worker' }), current)
  // 用户动作（切实例 / Reset / 重试）才是唯一写入口。
  assert.equal(internals.sessionTransition(current, { kind: 'user', sessionId: 'session-other' }), 'session-other')
  assert.equal(internals.sessionTransition(current, { kind: 'user', sessionId: '' }), '')
})
