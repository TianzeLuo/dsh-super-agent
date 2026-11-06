/**
 * attendance.js — 「用户此刻是否真的看着这个面板」的唯一判定。
 *
 * 未读的 **+1** 与 **清零** 必须走同一个判断：面板可见时收到的回复直接算已读，
 * 面板不可见时才计数。两处各写一份条件、靠人肉保持同步，正是「人就在面板里还
 * 记未读」「切回来又不清零」这类问题的来源。
 *
 * 判定的输入全部是宿主侧事实：
 *   - activeInstanceId：UI 当前选中的实例（由面板上报）；
 *   - panelActive / panelSeenAt：面板仍在（心跳新鲜），见 PANEL_STALE_MS；
 *   - uiVisible：页面可见（浏览器半部按 document.visibilityState 上报）。
 *
 * 纯函数、无 IO，方便在 node 里直接测。
 */

/** 面板心跳外的宽限；避免浏览器崩溃后永远把未读当作“正在看”。 */
export const PANEL_STALE_MS = 60_000

/**
 * 面板是否仍然活着（最后一次心跳在宽限期内）。
 *
 * @param {number} seenAt 最后一次“面板还开着”的上报时间（毫秒）；0 表示从未上报。
 * @param {number} [now] 当前时间（毫秒），测试可注入。
 * @returns {boolean}
 */
export function panelAlive(seenAt, now = Date.now()) {
  const value = Number(seenAt)
  if (!Number.isFinite(value) || value <= 0) return false
  return now - value < PANEL_STALE_MS
}

/**
 * 用户是否正在看着某个实例的面板。
 *
 * 三者缺一不可：面板活着、页面可见、这个实例就是当前实例。
 *
 * @param {object} input 判定输入。
 * @param {string} input.instanceId 回复所属实例。
 * @param {string} input.activeInstanceId UI 当前实例。
 * @param {boolean} input.panelActive 面板是否还挂着（心跳语义）。
 * @param {number} input.panelSeenAt 最后一次面板心跳时间。
 * @param {boolean} input.visible 页面是否可见。
 * @param {number} [input.now] 当前时间（测试注入）。
 * @returns {boolean}
 */
export function attended({ instanceId, activeInstanceId, panelActive, panelSeenAt, visible, now = Date.now() }) {
  if (instanceId !== activeInstanceId) return false
  if (panelActive !== true) return false
  if (visible !== true) return false
  return panelAlive(panelSeenAt, now)
}

/**
 * 一回合结束时的未读处理方式。
 *
 * - `ignore`：这一回合没有可见回复（只有工具调用），不动计数；
 * - `clear`：用户正看着面板 —— 回复已读，顺手把历史残留清零；
 * - `count`：用户不在 —— +1。
 *
 * @param {object} input 判定输入（见 {@link attended}）加上 `replied`。
 * @param {boolean} input.replied 这一回合是否有可见的 assistant 文本。
 * @returns {'ignore'|'clear'|'count'}
 */
export function replyEffect(input) {
  if (input?.replied !== true) return 'ignore'
  return attended(input) ? 'clear' : 'count'
}
