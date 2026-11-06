/**
 * approval.js — Worker 审批（permission request）的策略解析与展示辅助。
 *
 * 宿主事实（0.2.1-rc.1，源码在 `@deepseek-ai/dsh-user-approval`）：
 *
 *   - 审批服务是 `ctx.approval`（`ApprovalService`），没有 `approvals.*` 注册表；
 *   - 等待决定通过 Cordis waterfall `approval/request` 派发，answerer 就是普通
 *     listener：`ChildCtx.on('approval/request', (request, next) => ...)`；
 *   - 派发是 **agent/session 作用域** 的（`scopeTarget(req.agent, req.agent)`），
 *     所以注册在某个 Worker 的 `agent.ctx` 上就只会收到那条 Worker 的请求；
 *   - answerer 只能返回四个值：`allowed-once` / `rejected` / `cancelled` /
 *     `unavailable`；不返回就 `next()` 交给下一个 answerer（最终是人工面板）。
 *   - 宿主要求请求发生在打开的 turn 内，并自己追加 `approval/asked` +
 *     `approval/decided` 两类 session 事件（本项目靠它们做检测与审计）。
 *
 * 本版本只启用 **A（检测与可见性）**：`dispatch(approval)` 解析并记录策略，
 * 审批请求一律继续转人工。下面的 `createApprovalAnswerer` 是 B 阶段的预留接口，
 * 不在这里注册。将来接线时只需在 Worker 的 agent ctx 上：
 *
 *   child.ctx.on('approval/request', createApprovalAnswerer({
 *     mode: task.approvalMode,
 *     // B 阶段：把 { mode, outcome, rule, descriptor } 写成 approval.resolved
 *     // 审计事件（decidedBy 用 `policy:<mode>`），不要静默回答。
 *     onDecision: (decision) => { ... },
 *   }))
 *
 * 每个自动决定都要带 `mode`、命中的规则和理由，写入 journal（见
 * `approval.resolved` 的 `decidedBy` / `rule` 字段），不能静默放行。
 */

import { clip, isRecord, oneLine, redactSecrets } from './text.js'

/** 可选的审批策略。`ask` 是默认值，也是本版本唯一会真正转人工的行为。 */
export const APPROVAL_MODES = Object.freeze(['ask', 'auto-workspace', 'deny-all'])

/** 宿主 answerer 的完整返回值集合。 */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** 审批策略的人类可读说明（日志/trigger 用）。 */
export const APPROVAL_MODE_TEXT = Object.freeze({
  ask: 'ask the user for every request',
  'auto-workspace': 'auto-answer only requests covered by the workspace allowlist',
  'deny-all': 'reject every request without asking (testing only)',
})

/** 只读命令白名单：auto-workspace 命中这些片段才可能自动 allow。 */
const READ_ONLY_PATTERNS = Object.freeze([
  /^(?:git\s+(?:status|diff|log|show|rev-parse|ls-files|grep|blame|branch\s+--show-current))\b/i,
  /^(?:ls|dir|pwd|cat|head|tail|wc|rg|grep|find|stat|file|du|df|tree)\b/i,
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|check|typecheck))\b/i,
  /^(?:node|python|python3)\s+--version$/i,
])

/** 明显破坏性命令：auto-workspace 命中就建议 deny（仍需人工确认，不会自动执行）。 */
const DESTRUCTIVE_PATTERNS = Object.freeze([
  /\brm\b/i,
  /\b(?:del|rmdir|rd)\b/i,
  /\bgit\s+(?:push|reset|clean|rebase|restore|checkout\s+--)\b/i,
  /\b(?:sudo|su|runas)\b/i,
  /\b(?:chmod|chown|mkfs|fdisk|diskpart|shutdown|reboot)\b/i,
  /\bdd\s+if=/i,
  /\bnpm\s+publish\b/i,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
])

/** 参数里可能携带命令/路径的字段。 */
const COMMAND_KEYS = Object.freeze(['command', 'cmd', 'command_line', 'commandLine', 'script'])
const PATH_KEYS = Object.freeze(['path', 'file_path', 'filePath', 'notebook_path', 'target', 'destination', 'source', 'cwd', 'dir', 'directory'])

/**
 * 宽松读取一个策略值；不认识返回 undefined（用于配置校验，不抛错）。
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function readApprovalMode(value) {
  if (typeof value !== 'string') return undefined
  const mode = value.trim().toLowerCase()
  return APPROVAL_MODES.includes(mode) ? mode : undefined
}

/**
 * 解析策略值；`undefined` 使用 fallback。非法值抛错，由调用方转成面向模型的
 * 输入错误（dispatch 不应该悄悄忽略用户写错的策略）。
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeApprovalMode(value, fallback = 'ask') {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) return fallback
  const mode = readApprovalMode(value)
  if (mode !== undefined) return mode
  const error = new Error(`unknown approval mode ${JSON.stringify(value)}; expected one of ${APPROVAL_MODES.join(', ')}`)
  error.code = 'invalid_approval_mode'
  throw error
}

/**
 * 解析一次 dispatch 的有效策略：显式参数优先，其次配置默认值。
 *
 * @param {object} [config] 合并后的插件配置。
 * @param {unknown} [requested] dispatch 的 `approval` 参数。
 * @returns {string}
 */
export function approvalModeFor(config, requested) {
  if (requested !== undefined && requested !== null && !(typeof requested === 'string' && requested.trim().length === 0)) {
    return normalizeApprovalMode(requested, 'ask')
  }
  return readApprovalMode(config?.approval?.mode) ?? 'ask'
}

/** 是否属于“本版本只记录、不自动回答”的策略。 */
export function isDeferredApprovalMode(mode) {
  return mode === 'auto-workspace' || mode === 'deny-all'
}

/** 把参数文本解析成对象；失败返回 undefined。 */
function parseArguments(value) {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 从对象里取第一个非空字符串。 */
function firstString(object, keys) {
  if (object === undefined) return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim().length > 0)
      if (first !== undefined) return first
    }
  }
  return undefined
}

/** 收集参数里的路径值（去重、限量）。 */
function collectPaths(object) {
  if (object === undefined) return []
  const seen = new Set()
  const paths = []
  for (const key of PATH_KEYS) {
    const value = object[key]
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (typeof item !== 'string' || item.trim().length === 0) continue
      const path = item.trim()
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
      if (paths.length >= 8) return paths
    }
  }
  return paths
}

/**
 * 把一次审批请求压缩成 Router/用户可读的摘要。不读取会话历史，只使用审批事件
 * 自带的 reason 与同一 tool call 的参数（由 runtime 从 `tool/call` 事件缓存）。
 *
 * @param {{ toolName?: string, arguments?: unknown, callId?: string, reason?: string }} input
 * @returns {{
 *   toolName: string,
 *   callId?: string,
 *   reason?: string,
 *   command?: string,
 *   paths: string[],
 *   summary: string,
 *   argumentsPreview?: string,
 * }}
 */
export function describeApprovalRequest(input = {}) {
  const toolName = typeof input.toolName === 'string' && input.toolName.length > 0 ? input.toolName : 'unknown'
  const argsObject = parseArguments(input.arguments)
  const command = firstString(argsObject, COMMAND_KEYS)
  const code = firstString(argsObject, ['code'])
  const paths = collectPaths(argsObject)
  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? clip(oneLine(input.reason), 400) : undefined

  const rawArguments = typeof input.arguments === 'string'
    ? input.arguments
    : input.arguments === undefined
      ? ''
      : (() => {
          try {
            return JSON.stringify(input.arguments)
          } catch {
            return ''
          }
      })()
  const argumentsPreview = rawArguments.length > 0 ? clip(redactSecrets(oneLine(rawArguments)), 600) : undefined

  let summary
  if (command !== undefined) summary = clip(redactSecrets(oneLine(command)), 400)
  else if (paths.length > 0) summary = clip(paths.map((path) => redactSecrets(path)).join(', '), 400)
  else if (code !== undefined) summary = clip(redactSecrets(oneLine(code)), 400)
  else if (reason !== undefined) summary = reason
  else summary = `tool ${toolName}`

  return {
    toolName,
    ...(typeof input.callId === 'string' && input.callId.length > 0 ? { callId: input.callId } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(command === undefined ? {} : { command: clip(redactSecrets(oneLine(command)), 400) }),
    paths,
    summary,
    ...(argumentsPreview === undefined ? {} : { argumentsPreview }),
  }
}

/** 路径是否位于 root 内（root 为空视为未知，返回 false）。 */
function isInside(root, path) {
  if (typeof root !== 'string' || root.length === 0 || typeof path !== 'string' || path.length === 0) return false
  const relative = path.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!relative.startsWith('/') && !/^[A-Za-z]:\//.test(relative)) {
    // 相对路径：没有 `..` 越界段就按 repo 内处理。B 阶段仍会交给真实 sandbox
    // 决策；这里只用于给出**建议**，不是权限边界。
    return !relative.split('/').includes('..')
  }
  return relative === normalizedRoot || relative.startsWith(`${normalizedRoot}/`)
}

/** 命令是否全部由只读白名单片段组成（允许 `&&`/`;`/`|` 串联）。 */
function isReadOnlyCommand(command) {
  const segments = String(command)
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) return false
  return segments.every((segment) => READ_ONLY_PATTERNS.some((pattern) => pattern.test(segment)))
}

/** 命令是否命中破坏性模式。 */
function isDestructiveCommand(command) {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(String(command)))
}

/**
 * 给 trigger 一个**建议**（不是自动决定）。auto-workspace 只在证据足够时给
 * allow/deny，其余返回 undefined，让 Router/用户自己判断。`ask` 永远不给建议。
 *
 * @param {string} mode
 * @param {ReturnType<typeof describeApprovalRequest>} descriptor
 * @param {{ cwd?: string }} [context]
 * @returns {{ decision: 'allow'|'deny', rationale: string } | undefined}
 */
export function suggestApproval(mode, descriptor, context = {}) {
  if (mode === 'deny-all') {
    return { decision: 'deny', rationale: 'dispatch approval policy is deny-all' }
  }
  if (mode !== 'auto-workspace') return undefined
  if (descriptor?.command !== undefined) {
    if (isDestructiveCommand(descriptor.command)) {
      return { decision: 'deny', rationale: 'command matches a destructive pattern' }
    }
    if (isReadOnlyCommand(descriptor.command)) {
      return { decision: 'allow', rationale: 'command is in the read-only allowlist' }
    }
    return undefined
  }
  if (Array.isArray(descriptor?.paths) && descriptor.paths.length > 0) {
    const root = context.cwd
    if (descriptor.paths.every((path) => isInside(root, path))) {
      return { decision: 'allow', rationale: 'all target paths are inside the worker workspace' }
    }
    return { decision: 'deny', rationale: 'at least one target path is outside the worker workspace' }
  }
  return undefined
}

/**
 * B 阶段预留：根据策略生成一个 agent-scoped `approval/request` answerer。
 *
 * 本版本不注册它。行为约定：
 *   - `ask` 返回 undefined，调用方不应注册；
 *   - `auto-workspace` 只在白名单命中时回答，其余 `next()` 转人工；
 *   - `deny-all` 直接 `rejected`（测试用）；
 *   - 每次回答都通过 `onDecision` 交出 `{ outcome, decision, rule, descriptor }`，
 *     供 runtime 写一条可审计的 journal 事件。
 *
 * @param {{
 *   mode: string,
 *   decide?: (request: object, descriptor: object) => ({ decision?: string, rationale?: string } | undefined),
 *   onDecision?: (record: object) => void,
 * }} options
 * @returns {undefined | ((request: object, next: () => Promise<string>) => Promise<string>)}
 */
export function createApprovalAnswerer(options = {}) {
  const mode = normalizeApprovalMode(options.mode, 'ask')
  if (mode === 'ask') return undefined
  return async (request, next) => {
    const descriptor = describeApprovalRequest({
      toolName: request?.toolName,
      arguments: request?.arguments,
      callId: request?.callId,
      reason: request?.reason,
    })
    let verdict
    if (typeof options.decide === 'function') {
      verdict = await options.decide(request, descriptor)
    } else {
      verdict = suggestApproval(mode, descriptor)
    }
    if (verdict === undefined || verdict.decision === 'ask' || verdict.decision === undefined) return next()
    const outcome = verdict.decision === 'allow' ? 'allowed-once' : verdict.decision === 'deny' ? 'rejected' : 'unavailable'
    try {
      options.onDecision?.({
        mode,
        outcome,
        decision: verdict.decision,
        rule: verdict.rationale ?? 'policy',
        descriptor,
        toolName: descriptor.toolName,
      })
    } catch {
      // 审计回调失败不能把审批回答变成抛错；失败会由上层日志记录。
    }
    return outcome
  }
}
