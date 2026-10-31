/**
 * filter.js — 事件过滤的第一层：程序层快路径（Fast Path）。
 *
 * 文章 §3.1 的两级过滤：
 *
 *   1. 程序层：来源、群组、actor 白/黑名单、是否点名、明显噪音——确定性代码，
 *      零模型调用，在事件进入 Router 之前砍掉大部分。
 *   2. 语义层：通过快路径的候选事件被合批注入 Router，由提示词判断“要不要行动”。
 *
 * 本文件只做第 1 层。它返回 `addressed` / `ambient` 作为语义层的提示：
 * Router 仍然可以对 ambient 事件选择沉默或投机处理。
 *
 * 规则保持“可解释”：每次过滤都给出稳定的 reason code，写进 journal，便于
 * 事后回答“为什么这条消息没进来”。
 */

import { sourcePolicy } from './config.js'
import { oneLine } from './text.js'

/** 过滤原因码 → 一行人类可读说明。 */
export const FILTER_REASONS = Object.freeze({
  empty: '正文为空',
  'actor-ignored': 'actor 在忽略名单里',
  'self-message': '是 Agent 自己发出的消息',
  'source-ignored': '来源策略为 ignore',
  'actor-denied': 'actor 在该来源的黑名单里',
  'pattern-ignored': '正文命中忽略规则',
  'not-addressed': '来源要求明确点名，但这条消息没有点名',
})

/**
 * 判断 actor 是否匹配一个模式（支持末尾 `*`）。
 *
 * @param {string} actor 事件作者。
 * @param {string} pattern 精确值或 `prefix*`。
 * @returns {boolean}
 */
function matchActor(actor, pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  const value = actor.toLowerCase()
  const candidate = pattern.toLowerCase()
  if (candidate.endsWith('*')) return value.startsWith(candidate.slice(0, -1))
  return value === candidate
}

/**
 * actor 是否命中任一模式。
 *
 * @param {string} actor actor。
 * @param {string[] | undefined} patterns 模式列表。
 * @returns {boolean}
 */
export function actorMatches(actor, patterns) {
  if (!Array.isArray(patterns)) return false
  return patterns.some((pattern) => matchActor(actor, pattern))
}

/**
 * 是否点名了 Agent。
 *
 * 认三种形态：显式 `direct: true`、结构化的 `mentions` 数组、正文里的
 * `@name` 或中文名。最后一种只是兜底，频道适配器应当尽量提供前两种。
 *
 * @param {{text?: string, mentions?: string[], agentNames?: string[]}} input 事件。
 * @returns {boolean}
 */
export function mentionsAgent(input) {
  const mentions = Array.isArray(input.mentions) ? input.mentions.map((item) => String(item).replace(/^@/, '').toLowerCase()) : []
  const names = Array.isArray(input.agentNames) && input.agentNames.length > 0
    ? input.agentNames.map((item) => String(item).toLowerCase())
    : ['super-agent', 'superagent']
  for (const name of names) {
    if (mentions.includes(name)) return true
  }

  const text = String(input.text ?? '').toLowerCase()
  if (text.length === 0) return false
  for (const name of names) {
    if (text.includes(`@${name}`)) return true
    // 中文名没有词边界，直接包含即可；英文名要求前后不是字母数字，避免
    // “super-agentic” 这类误命中。
    if (/[^\x00-\x7f]/.test(name) && text.includes(name)) return true
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, 'i').test(text)) return true
  }
  return false
}

/**
 * 程序层过滤决策。
 *
 * @param {{
 *   source: string,
 *   actor?: string,
 *   text?: string,
 *   direct?: boolean,
 *   mentions?: string[],
 *   internal?: boolean,
 * }} input 归一化后的事件。
 * @param {object} config 合并后的配置。
 * @returns {{
 *   pass: boolean,
 *   reason?: string,
 *   reasonText?: string,
 *   addressed: boolean,
 *   mode: 'addressed'|'candidate'|'ignore',
 * }}
 */
export function filterEvent(input, config) {
  if (input.internal === true) {
    return { pass: true, addressed: true, mode: 'candidate' }
  }

  const source = String(input.source ?? 'unknown')
  const actor = String(input.actor ?? '')
  const text = String(input.text ?? '')
  const policy = sourcePolicy(config, source)
  const mode = policy.mode === 'candidate' || policy.mode === 'ignore' ? policy.mode : 'addressed'
  const agentNames = Array.isArray(config?.agents) ? config.agents : []
  const addressed = input.direct === true || mentionsAgent({ text, mentions: input.mentions, agentNames })

  if (oneLine(text).length === 0) {
    return { pass: false, reason: 'empty', reasonText: FILTER_REASONS.empty, addressed, mode }
  }
  if (actorMatches(actor, config?.ignoreActors)) {
    return { pass: false, reason: 'actor-ignored', reasonText: FILTER_REASONS['actor-ignored'], addressed, mode }
  }
  if (actor.length > 0 && (actorMatches(actor, agentNames) || matchesAgentName(actor, agentNames))) {
    return { pass: false, reason: 'self-message', reasonText: FILTER_REASONS['self-message'], addressed, mode }
  }
  if (mode === 'ignore') {
    return { pass: false, reason: 'source-ignored', reasonText: FILTER_REASONS['source-ignored'], addressed, mode }
  }
  if (actorMatches(actor, policy.actorsDeny)) {
    return { pass: false, reason: 'actor-denied', reasonText: FILTER_REASONS['actor-denied'], addressed, mode }
  }
  for (const pattern of policy.ignorePatterns ?? []) {
    try {
      if (new RegExp(pattern).test(text)) {
        return { pass: false, reason: 'pattern-ignored', reasonText: FILTER_REASONS['pattern-ignored'], addressed, mode }
      }
    } catch {
      // 配置校验已经警告过；运行期忽略坏正则。
    }
  }
  if (mode === 'addressed' && !addressed && policy.requireMention !== false) {
    return { pass: false, reason: 'not-addressed', reasonText: FILTER_REASONS['not-addressed'], addressed, mode }
  }

  return {
    pass: true,
    addressed,
    mode,
  }
}

/** actor 精确等于某个 Agent 名（大小写不敏感）。 */
function matchesAgentName(actor, agentNames) {
  const value = actor.toLowerCase()
  return agentNames.some((name) => value === String(name).toLowerCase())
}

/**
 * 一条事件的优先级提示，供 Router 的批次渲染使用。
 *
 * @param {boolean} addressed 是否点名。
 * @returns {'addressed'|'ambient'}
 */
export function priorityOf(addressed) {
  return addressed ? 'addressed' : 'ambient'
}
