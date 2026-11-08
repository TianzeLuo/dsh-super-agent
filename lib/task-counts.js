/**
 * task-counts.js — 任务计数的唯一派生处。
 *
 * `lost`（Worker 会话被宿主回收）和 `interrupted`（重启后没救回来）虽然还在
 * 等 Router 决策，但**没有 Worker 在跑**，不算「进行中」。以前 status 摘要、
 * 面板徽标和 Router 提示词各自数一遍，口径不一致——现在只有 `deriveTaskCounts`
 * 一处推导：
 *
 *   - 每个状态一份原始计数（journal/CLI 逐项展示要用）；
 *   - `active`：还需要 Router 继续推进的进行中任务数（不含 lost/interrupted）；
 *   - `lost`：单独给出，供摘要和面板区分「掉线」与「正在跑」。
 *
 * 所有统计出口（store.stats → status/CLI/面板徽标，renderStatus，Router 提示词）
 * 都必须读这里的字段，不要各自再写状态表。
 */

/** 算作「进行中」的状态：还有 Worker（或队列位置），Router 需继续推进。 */
export const ACTIVE_TASK_STATUSES = Object.freeze([
  'queued',
  'starting',
  'working',
  'blocked-approval',
  'blocked',
  'resumable',
])

/** 不算进行中、但单独计数的状态。 */
export const STALLED_TASK_STATUSES = Object.freeze(['interrupted', 'lost'])

/**
 * 从任务列表派生计数表。
 *
 * @param {Iterable<{ status?: string }>} [tasks] 任务记录。
 * @returns {{ queued: number, starting: number, working: number, 'blocked-approval': number,
 *   idle: number, blocked: number, failed: number, resumable: number, interrupted: number,
 *   lost: number, closed: number, active: number }} 计数表。
 */
export function deriveTaskCounts(tasks) {
  const counts = {
    queued: 0,
    starting: 0,
    working: 0,
    'blocked-approval': 0,
    idle: 0,
    blocked: 0,
    failed: 0,
    resumable: 0,
    interrupted: 0,
    lost: 0,
    closed: 0,
    active: 0,
  }
  for (const task of tasks ?? []) {
    const status = typeof task?.status === 'string' && task.status.length > 0 ? task.status : 'unknown'
    counts[status] = (counts[status] ?? 0) + 1
  }
  let active = 0
  for (const status of ACTIVE_TASK_STATUSES) active += counts[status] ?? 0
  counts.active = active
  return counts
}

/**
 * 状态是否算「进行中」。
 *
 * @param {string} status 任务状态。
 * @returns {boolean}
 */
export function isActiveTaskStatus(status) {
  return ACTIVE_TASK_STATUSES.includes(status)
}
