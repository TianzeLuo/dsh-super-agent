/**
 * objectives.js — super-agent 原生目标（objective）的纯逻辑与持久化形状。
 *
 * 为什么不复用宿主 goal：宿主 goal 由 `dsh-goal-round-driver` 在每轮结束时
 * 自动续轮（`goal.phase === 'active' && goal.activation === 'armed'`，见
 * dsh-goal-round-driver/lib/index.js `drivable()`），对 Router 这种“只在事件
 * 到来时判断”的会话就是空转循环：一轮结束立刻被 `goal_round` 唤醒，没有新
 * 信息也不会有新进展。
 *
 * 这里的 objective 是**被动**的：目标 = 客观目标 + 里程碑 + 显式检查节奏。
 * 只有三种推进来源：
 *
 *   (i)  到点调度：宿主 `ctx.schedule` 唤醒一次，Router 显式 `check`；
 *   (ii) Worker 报告：挂在目标上的任务报告时自动记一条 check；
 *   (iii) 用户指令：用户说“继续/汇报/调整目标”时 Router 显式 check。
 *
 * 创建或更新目标本身**从不**唤醒会话（不派发 trigger、不 followup、不建 0 延迟
 * 调度）。所有函数都是纯函数；写入走 store 的追加式 journal。
 */

/** 目标状态机。`done` 是终态（close）。 */
export const OBJECTIVE_STATUSES = ['active', 'paused', 'done']

/** 允许的检查来源；与需求里的三种推进来源一一对应。 */
export const CHECK_SOURCES = ['user', 'schedule', 'report']

/** 一个目标最多多少里程碑/检查历史；超出直接拒绝，不静默丢弃。 */
const MAX_MILESTONES = 20
const MAX_OBJECTIVE_CHARS = 2000
const MAX_MILESTONE_CHARS = 280
const MAX_NOTE_CHARS = 1000
const MAX_CHECKS = 50

/** 输入校验错误；runtime 会把它转成 `RuntimeInputError`，工具层只给模型看消息。 */
export class ObjectiveInputError extends Error {
  /**
   * @param {string} message 面向模型的可读原因。
   * @param {string} [code] 稳定分类。
   */
  constructor(message, code = 'invalid_objective') {
    super(message)
    this.name = 'ObjectiveInputError'
    this.code = code
  }
}

/**
 * 必填文本：去首尾空白、限长。
 *
 * @param {unknown} value 原始值。
 * @param {string} field 字段名（错误消息用）。
 * @param {number} max 最大字符数。
 * @returns {string}
 */
function requireText(value, field, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObjectiveInputError(`${field} is required`)
  }
  const text = value.trim()
  if (text.length > max) throw new ObjectiveInputError(`${field} is too long (max ${max} characters)`)
  return text
}

/** 可选文本：空值归一成 undefined。 */
function optionalText(value, field, max) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ObjectiveInputError(`${field} must be a string`)
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > max) throw new ObjectiveInputError(`${field} is too long (max ${max} characters)`)
  return text
}

/** 里程碑 id 在目标内稳定：`ms_1..ms_n`；重排里程碑会重新编号。 */
function milestoneId(index) {
  return `ms_${index + 1}`
}

/**
 * 归一化里程碑列表。
 *
 * @param {unknown} input `string[]` 或 `{ text, done? }[]`。
 * @returns {{ id: string, text: string, done: boolean }[]}
 */
export function normalizeMilestones(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new ObjectiveInputError('milestones must be an array')
  if (input.length > MAX_MILESTONES) throw new ObjectiveInputError(`at most ${MAX_MILESTONES} milestones are allowed`)
  const out = []
  const seen = new Set()
  for (const item of input) {
    const raw = typeof item === 'string' ? item : item?.text
    const text = requireText(raw, 'milestone', MAX_MILESTONE_CHARS)
    if (seen.has(text)) continue
    seen.add(text)
    out.push({ id: milestoneId(out.length), text, done: typeof item === 'object' && item !== null && item.done === true })
  }
  return out
}

/**
 * 从调用参数里读检查节奏；等价于 schedule 工具的选择器，但默认 manual。
 *
 * @param {object} [input] 工具/HTTP 入参。
 * @returns {{ kind: 'manual'|'every'|'at'|'daily'|'weekly'|'cron' }}
 */
export function cadenceFromSelectors(input) {
  const source = input ?? {}
  const present = ['every_seconds', 'at', 'daily', 'weekly', 'cron']
    .filter((key) => source[key] !== undefined && source[key] !== null)
  if (present.length === 0) return { kind: 'manual' }
  if (present.length > 1) {
    throw new ObjectiveInputError('supply at most one check cadence: every_seconds, at, daily, weekly or cron')
  }
  const key = present[0]
  if (key === 'every_seconds') {
    const seconds = Number(source.every_seconds)
    if (!Number.isSafeInteger(seconds) || seconds < 60) {
      throw new ObjectiveInputError('every_seconds must be an integer of at least 60 seconds')
    }
    return { kind: 'every', everySeconds: seconds }
  }
  if (key === 'at') {
    const at = requireText(source.at, 'at', 80)
    const parsed = Date.parse(at)
    if (Number.isNaN(parsed)) throw new ObjectiveInputError('at must be an RFC 3339 instant, for example 2026-11-06T09:00:00-08:00')
    return { kind: 'at', at: new Date(parsed).toISOString() }
  }
  if (key === 'daily') {
    const time = requireText(source.daily?.time, 'daily.time', 20)
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) throw new ObjectiveInputError('daily.time must be HH:mm or HH:mm:ss')
    const zone = optionalText(source.daily?.time_zone, 'daily.time_zone', 80)
    return { kind: 'daily', time, ...(zone === undefined ? {} : { timeZone: zone }) }
  }
  if (key === 'weekly') {
    const time = requireText(source.weekly?.time, 'weekly.time', 20)
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) throw new ObjectiveInputError('weekly.time must be HH:mm or HH:mm:ss')
    const weekdays = source.weekly?.weekdays
    if (!Array.isArray(weekdays) || weekdays.length === 0) throw new ObjectiveInputError('weekly.weekdays must list ISO weekdays (Monday=1)')
    const normalized = [...new Set(weekdays.map(Number))]
    if (normalized.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new ObjectiveInputError('weekly.weekdays must be ISO weekdays between 1 and 7')
    }
    const zone = optionalText(source.weekly?.time_zone, 'weekly.time_zone', 80)
    return { kind: 'weekly', time, weekdays: normalized.sort((a, b) => a - b), ...(zone === undefined ? {} : { timeZone: zone }) }
  }
  const expression = requireText(source.cron?.expression, 'cron.expression', 120)
  const zone = optionalText(source.cron?.time_zone, 'cron.time_zone', 80)
  return { kind: 'cron', expression, ...(zone === undefined ? {} : { timeZone: zone }) }
}

/**
 * 校验并归一化一个已经成形的 cadence（journal 回放/迁移用）。
 *
 * @param {unknown} value cadence 对象。
 * @returns {object} 归一化后的 cadence。
 */
export function normalizeCadence(value) {
  if (value === undefined || value === null) return { kind: 'manual' }
  if (typeof value !== 'object' || Array.isArray(value)) throw new ObjectiveInputError('cadence must be an object')
  switch (value.kind) {
    case 'manual':
      return { kind: 'manual' }
    case 'every':
      return cadenceFromSelectors({ every_seconds: value.everySeconds })
    case 'at':
      return cadenceFromSelectors({ at: value.at })
    case 'daily':
      return cadenceFromSelectors({ daily: { time: value.time, time_zone: value.timeZone } })
    case 'weekly':
      return cadenceFromSelectors({ weekly: { time: value.time, weekdays: value.weekdays, time_zone: value.timeZone } })
    case 'cron':
      return cadenceFromSelectors({ cron: { expression: value.expression, time_zone: value.timeZone } })
    default:
      throw new ObjectiveInputError(`unknown cadence kind "${value.kind}"`)
  }
}

/**
 * cadence → 宿主 schedule 的创建参数；manual 返回 undefined。
 *
 * 墙钟类（daily/weekly/cron）在 0.2.2 的宿主级 API 里必须带显式时区，所以
 * cadence 没记时区时用 `defaultZone` 补上；旧宿主也接受显式时区。
 *
 * @param {object} cadence 归一化后的 cadence。
 * @param {string} [defaultZone] 配置/系统时区。
 * @returns {object|undefined}
 */
export function scheduleSelector(cadence, defaultZone) {
  const zone = typeof cadence?.timeZone === 'string' && cadence.timeZone.length > 0
    ? cadence.timeZone
    : (typeof defaultZone === 'string' && defaultZone.length > 0 ? defaultZone : undefined)
  const zoneField = zone === undefined ? {} : { time_zone: zone }
  switch (cadence?.kind) {
    case 'every':
      return { every_seconds: cadence.everySeconds }
    case 'at':
      return { at: cadence.at }
    case 'daily':
      return { daily: { time: cadence.time, ...zoneField } }
    case 'weekly':
      return { weekly: { time: cadence.time, weekdays: cadence.weekdays, ...zoneField } }
    case 'cron':
      return { cron: { expression: cadence.expression, ...zoneField } }
    default:
      return undefined
  }
}

/**
 * 下一次检查的理论时间（毫秒）。
 *
 * 只对 `every` / `at` 做本地推算；`daily` / `weekly` / `cron` 的墙钟与 Cron
 * 展开由宿主 schedule 负责（记录里保存它返回的 `scheduledAt`），避免在插件里
 * 复刻一份时区/Cron 计算。`manual` 没有到点唤醒。
 *
 * @param {object} cadence 归一化后的 cadence。
 * @param {number} from 起始毫秒。
 * @returns {number|undefined}
 */
export function nextCheckAt(cadence, from) {
  if (cadence === undefined || cadence === null) return undefined
  if (cadence.kind === 'every') return from + cadence.everySeconds * 1000
  if (cadence.kind === 'at') {
    const parsed = Date.parse(cadence.at)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * 是否到了检查点（只用于展示与测试；到点真正唤醒的是宿主 schedule）。
 *
 * @param {object} objective 目标记录。
 * @param {number} now 当前毫秒。
 * @returns {boolean}
 */
export function objectiveDue(objective, now) {
  return objective?.status === 'active'
    && Number.isFinite(objective?.nextCheckAt)
    && now >= objective.nextCheckAt
}

/**
 * 新建一条目标记录（不写 journal、不唤醒会话）。
 *
 * @param {{
 *   id: string, objective: string, milestones?: object[], cadence?: object,
 *   source?: string, hostGoalId?: string, now: number, status?: string,
 * }} input
 * @returns {object}
 */
export function createObjectiveRecord(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const cadence = normalizeCadence(input.cadence)
  const status = OBJECTIVE_STATUSES.includes(input.status) ? input.status : 'active'
  const record = {
    id: input.id,
    objective: requireText(input.objective, 'objective', MAX_OBJECTIVE_CHARS),
    milestones: normalizeMilestones(input.milestones),
    cadence,
    status,
    createdAt: now,
    updatedAt: now,
    checks: [],
    taskIds: [],
    source: typeof input.source === 'string' && input.source.length > 0 ? input.source : 'router',
    nextCheckAt: nextCheckAt(cadence, now),
  }
  if (typeof input.hostGoalId === 'string' && input.hostGoalId.length > 0) record.hostGoalId = input.hostGoalId
  return record
}

/**
 * 归一化一条检查记录。
 *
 * @param {{ source?: string, note?: string, taskId?: string, milestoneId?: string, at?: number }} input
 * @param {number} fallbackAt 没给 at 时用它。
 * @returns {{ at: number, source: string, note?: string, taskId?: string, milestoneId?: string }}
 */
export function normalizeCheck(input, fallbackAt) {
  const source = input?.source === undefined ? 'user' : String(input.source)
  if (!CHECK_SOURCES.includes(source)) {
    throw new ObjectiveInputError(`check source must be one of ${CHECK_SOURCES.join(', ')}`)
  }
  const note = optionalText(input?.note, 'note', MAX_NOTE_CHARS)
  const taskId = optionalText(input?.taskId, 'task_id', 80)
  const milestoneId = optionalText(input?.milestoneId, 'milestone_id', 40)
  const at = Number.isFinite(input?.at) ? input.at : fallbackAt
  return {
    at,
    source,
    ...(note === undefined ? {} : { note }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(milestoneId === undefined ? {} : { milestoneId }),
  }
}

/**
 * 把一条检查折叠进目标（纯函数，返回新对象）。
 *
 * @param {object} objective 目标记录。
 * @param {object} check 归一化后的检查。
 * @param {{ now: number, nextCheckAt?: number }} options
 * @returns {object}
 */
export function applyCheck(objective, check, options) {
  const now = Number.isFinite(options?.now) ? options.now : check.at
  const checks = [...(objective.checks ?? []), check].slice(-MAX_CHECKS)
  return {
    ...objective,
    checks,
    lastCheckAt: check.at,
    nextCheckAt: options?.nextCheckAt === undefined ? objective.nextCheckAt : options.nextCheckAt,
    updatedAt: now,
  }
}

/**
 * 追加里程碑：保留已有 id（完成状态不丢），新条目从最大编号继续。
 *
 * @param {object[]} existing 现有里程碑。
 * @param {unknown} extra 新里程碑（string[] 或 {text}[]）。
 * @returns {object[]}
 */
export function appendMilestones(existing, extra) {
  const base = Array.isArray(existing) ? existing.map((milestone) => ({ ...milestone })) : []
  const incoming = normalizeMilestones(extra)
  const texts = new Set(base.map((milestone) => milestone.text))
  let next = base.reduce((max, milestone) => {
    const match = /^ms_(\d+)$/.exec(String(milestone.id))
    return match === null ? max : Math.max(max, Number(match[1]))
  }, 0)
  for (const milestone of incoming) {
    if (texts.has(milestone.text)) continue
    next += 1
    base.push({ id: `ms_${next}`, text: milestone.text, done: false })
    texts.add(milestone.text)
  }
  if (base.length > MAX_MILESTONES) throw new ObjectiveInputError(`at most ${MAX_MILESTONES} milestones are allowed`)
  return base
}

/**
 * 按 id 或原文标记里程碑完成；一个都没匹配上就报错（避免静默无效）。
 *
 * @param {object[]} existing 现有里程碑。
 * @param {unknown} refs milestone id 或原文列表。
 * @param {number} at 完成时间。
 * @returns {object[]}
 */
export function completeMilestones(existing, refs, at) {
  const wanted = Array.isArray(refs) ? refs.map(String) : []
  if (wanted.length === 0) return Array.isArray(existing) ? existing.map((milestone) => ({ ...milestone })) : []
  const keys = new Set(wanted)
  let matched = 0
  const out = (existing ?? []).map((milestone) => {
    if (!keys.has(milestone.id) && !keys.has(milestone.text)) return { ...milestone }
    matched += 1
    return { ...milestone, done: true, doneAt: at }
  })
  if (matched === 0) throw new ObjectiveInputError(`no milestone matched ${wanted.join(', ')}`, 'not_found')
  return out
}

/**
 * 里程碑进度。
 *
 * @param {object} objective 目标记录。
 * @returns {{ done: number, total: number, pending: object[] }}
 */
export function milestoneProgress(objective) {
  const milestones = Array.isArray(objective?.milestones) ? objective.milestones : []
  const done = milestones.filter((milestone) => milestone.done).length
  return { done, total: milestones.length, pending: milestones.filter((milestone) => !milestone.done) }
}

/**
 * 给模型/UI 看的稳定视图（不暴露内部可变引用）。
 *
 * @param {object} objective 目标记录。
 * @param {number} now 当前毫秒。
 * @returns {object}
 */
export function toObjectiveView(objective, now = Date.now()) {
  const progress = milestoneProgress(objective)
  return {
    id: objective.id,
    objective: objective.objective,
    status: objective.status,
    milestones: (objective.milestones ?? []).map((milestone) => ({ ...milestone })),
    progress: { done: progress.done, total: progress.total },
    cadence: { ...(objective.cadence ?? { kind: 'manual' }) },
    taskIds: [...(objective.taskIds ?? [])],
    source: objective.source,
    ...(objective.hostGoalId === undefined ? {} : { hostGoalId: objective.hostGoalId }),
    ...(objective.migrated === undefined ? {} : { migrated: { ...objective.migrated } }),
    createdAt: objective.createdAt,
    updatedAt: objective.updatedAt,
    ...(objective.lastCheckAt === undefined ? {} : { lastCheckAt: objective.lastCheckAt }),
    ...(objective.nextCheckAt === undefined ? {} : { nextCheckAt: objective.nextCheckAt }),
    due: objectiveDue(objective, now),
    ...(objective.scheduleId === undefined ? {} : { scheduleId: objective.scheduleId }),
    ...(objective.closedAt === undefined ? {} : { closedAt: objective.closedAt }),
    ...(objective.closeReason === undefined ? {} : { closeReason: objective.closeReason }),
    checks: (objective.checks ?? []).slice(-5).map((check) => ({ ...check })),
  }
}

/**
 * 一行摘要（提示词动态上下文、status 用）。
 *
 * @param {object} objective 目标记录。
 * @param {number} now 当前毫秒。
 * @returns {string}
 */
export function objectiveSummaryLine(objective, now = Date.now()) {
  const progress = milestoneProgress(objective)
  const cadence = objective?.cadence?.kind ?? 'manual'
  const due = objectiveDue(objective, now) ? ' · DUE' : ''
  return `${objective.id} [${objective.status}] ${objective.objective} · ${progress.done}/${progress.total} milestones · cadence ${cadence}${due}`
}

/**
 * 多行渲染（superagent_goal 的列表/详情输出）。
 *
 * @param {object} objective 目标记录。
 * @param {number} now 当前毫秒。
 * @returns {string}
 */
export function renderObjective(objective, now = Date.now()) {
  const progress = milestoneProgress(objective)
  const lines = [`${objective.id} [${objective.status}] ${objective.objective}`]
  const cadence = objective?.cadence ?? { kind: 'manual' }
  const next = objective.nextCheckAt === undefined ? 'no scheduled check' : `next check ${new Date(objective.nextCheckAt).toISOString()}`
  lines.push(`  milestones ${progress.done}/${progress.total} · cadence ${cadence.kind} · ${next}${objectiveDue(objective, now) ? ' · DUE NOW' : ''}`)
  for (const milestone of objective.milestones ?? []) {
    lines.push(`  ${milestone.done ? '[x]' : '[ ]'} ${milestone.text}`)
  }
  if ((objective.taskIds ?? []).length > 0) lines.push(`  linked tasks: ${objective.taskIds.join(', ')}`)
  const last = (objective.checks ?? []).at(-1)
  if (last !== undefined) {
    const note = last.note === undefined ? '' : ` · ${last.note}`
    lines.push(`  last check ${new Date(last.at).toISOString()} (${last.source}${last.taskId === undefined ? '' : ` ${last.taskId}`})${note}`)
  }
  if (objective.closeReason !== undefined) lines.push(`  closed: ${objective.closeReason}`)
  return lines.join('\n')
}

/**
 * 把宿主 goal 迁移成 super-agent objective（“转新机制”方案）。
 *
 * 只读宿主 goal 的文本与阶段，不复制它的续轮状态：cadence 是 manual，所以
 * 迁移后的目标没有任何自动唤醒；宿主 goal 由调用方保持 paused（并 disarm）。
 *
 * @param {object} hostGoal 宿主 goal 视图（`ctx.goals.get(agent)`）。
 * @param {{ id: string, now?: number }} options id 与时间。
 * @returns {object} 目标记录。
 */
export function adoptHostGoal(hostGoal, options) {
  if (hostGoal === undefined || hostGoal === null) {
    throw new ObjectiveInputError('this Router session has no host goal to migrate', 'no_host_goal')
  }
  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  const record = createObjectiveRecord({
    id: options.id,
    objective: hostGoal.objective,
    milestones: [],
    cadence: { kind: 'manual' },
    source: 'host-goal',
    hostGoalId: typeof hostGoal.id === 'string' ? hostGoal.id : undefined,
    now,
    status: hostGoal.phase === 'complete' ? 'done' : 'active',
  })
  record.migrated = {
    from: 'host-goal',
    hostGoalId: typeof hostGoal.id === 'string' ? hostGoal.id : undefined,
    hostPhase: typeof hostGoal.phase === 'string' ? hostGoal.phase : undefined,
    roundsStarted: Number.isFinite(hostGoal.roundsStarted) ? hostGoal.roundsStarted : 0,
    activation: typeof hostGoal.activation === 'string' ? hostGoal.activation : undefined,
    at: now,
  }
  return record
}
