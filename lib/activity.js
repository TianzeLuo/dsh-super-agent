/**
 * activity.js — 近期活动的数据层顺序与游标分页。
 *
 * 为什么顺序放在这里而不是面板 CSS：
 *
 * 1. 「显示更多」是按游标分批取的。只要排序在数据层固定下来，两批之间就不会
 *    因为 CSS `order` 或前端二次排序而跳动；同一时间戳的项再用 id 倒序做稳定
 *    的 tie-break。
 * 2. 分组规则只有一份：进行中（starting / working / blocked-approval / queued）
 *    永远在已完成、已关闭之前；两组内部都按最近更新时间倒序。
 * 3. 游标是不透明字符串，前端只负责把它原样传回。这样新任务插到顶部时，
 *    后续批次也不会重复或跳过已加载的行。
 *
 * 本模块纯函数，不依赖文件、宿主或时钟，便于单测。
 */

/** 仍在进行、应排在已完成/已关闭之前的任务状态。 */
export const ACTIVE_TASK_STATUSES = Object.freeze([
  'queued',
  'starting',
  'working',
  'blocked-approval',
])

const ACTIVE = new Set(ACTIVE_TASK_STATUSES)

/** 0 = 进行中，1 = 已完成/已关闭/未知状态。 */
export function activityGroup(status) {
  return ACTIVE.has(status) ? 0 : 1
}

/** 任务最近一次活动时间（毫秒）；缺省按 0 处理。 */
export function activityTime(row) {
  const value = row?.updatedAt ?? row?.createdAt ?? 0
  return Number.isFinite(value) ? value : 0
}

/**
 * 活动列表排序：进行中优先；组内按时间倒序；同一时间戳按 id 倒序。
 *
 * id tie-break 是分页稳定性的关键：同一毫秒创建的两条任务不会在两批之间交换位置。
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareActivity(a, b) {
  const group = activityGroup(a?.status) - activityGroup(b?.status)
  if (group !== 0) return group
  const time = activityTime(b) - activityTime(a)
  if (time !== 0) return time
  return String(b?.id ?? '').localeCompare(String(a?.id ?? ''))
}

/** 排序副本；不修改入参。 */
export function sortActivity(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort(compareActivity)
}

/**
 * 一条活动的游标。
 *
 * @param {object} row
 * @returns {string|undefined}
 */
export function activityCursor(row) {
  if (row === undefined || row === null) return undefined
  const at = activityTime(row)
  const id = String(row.id ?? '')
  if (id.length === 0) return undefined
  return Buffer.from(JSON.stringify([activityGroup(row.status), at, id])).toString('base64url')
}

/**
 * 解析游标；坏游标返回 undefined，调用方按「无游标」处理首屏，不抛错。
 *
 * @param {string|undefined|null} value
 * @returns {{ group: number, at: number, id: string }|undefined}
 */
export function decodeActivityCursor(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
    const [group, at, id] = parsed
    if (group !== 0 && group !== 1) return undefined
    if (!Number.isFinite(at) || typeof id !== 'string' || id.length === 0) return undefined
    return { group, at, id }
  } catch {
    return undefined
  }
}

/** 排序键比较：行是否严格排在游标之后。 */
function isAfterCursor(row, cursor) {
  if (cursor === undefined) return true
  const group = activityGroup(row?.status)
  if (group !== cursor.group) return group > cursor.group
  const time = activityTime(row)
  if (time !== cursor.at) return time < cursor.at
  return String(row?.id ?? '').localeCompare(cursor.id) < 0
}

/**
 * 取一页活动。
 *
 * @param {object[]} rows 已排序或未排序的活动行。
 * @param {{ limit?: number, cursor?: string, includeStatus?: (row: object) => boolean }} [options]
 * @returns {{ rows: object[], nextCursor?: string, hasMore: boolean }}
 */
export function activityPage(rows, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit))) : 20
  const cursor = decodeActivityCursor(options.cursor)
  const sorted = sortActivity(rows).filter((row) => options.includeStatus?.(row) !== false)
  const remaining = cursor === undefined ? sorted : sorted.filter((row) => isAfterCursor(row, cursor))
  const page = remaining.slice(0, limit)
  return {
    rows: page,
    nextCursor: page.length > 0 ? activityCursor(page[page.length - 1]) : undefined,
    hasMore: remaining.length > page.length,
  }
}
