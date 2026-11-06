/**
 * recovery.js — 重启后「这条任务还能不能接着用原来的 Worker」的判定。
 *
 * 为什么单独一个模块：这个判断只依赖任务记录和两个宿主事实（会话是否还活着、
 * 宿主能不能把它恢复起来），不依赖定时器、文件或 DSH 对象。抽出来就能在 node
 * 里直接测，runtime 只负责把判定换成 IO。
 *
 * 三个状态的含义（不要混用）：
 *   - `resumable`：进程重启后 Worker **会话被救回来了**，上下文完整、当前空闲，
 *     可以用 `reuse_task_id` 接着做。
 *   - `interrupted`：重启后会话没救回来（文件不在/宿主拒绝恢复）。任务与 brief
 *     仍在 journal 里，可以用原 brief 起一个新 Worker。
 *   - `lost`：仍在跑的时候 Worker 会话被宿主回收（进程内事件，不是重启）。
 */

/** 会话被救回来、上下文可续。 */
export const RESUMABLE = 'resumable'

/** 会话没救回来，但任务上下文还在。 */
export const INTERRUPTED = 'interrupted'

/**
 * 进程退出时可能正占着一个 Worker 的状态：这些状态在会话恢复后要改写成
 * `resumable`（它们代表「本该在跑」）。
 */
const RUNNING_STATES = Object.freeze(['starting', 'working', 'blocked-approval', RESUMABLE])

/** 重启时需要尝试接管会话的状态（含空闲的，否则 reuse_task_id 会突然失效）。 */
const RESTORABLE_STATES = Object.freeze(['starting', 'working', 'blocked-approval', RESUMABLE, 'idle', 'blocked'])

/** 这些状态下的任务算「本该在跑」。 */
export function isRunningState(status) {
  return RUNNING_STATES.includes(status)
}

/** 有 Worker 会话 id 才算可恢复的候选。 */
export function hasWorkerSession(task) {
  return typeof task?.workerSessionId === 'string' && task.workerSessionId.length > 0
}

/**
 * 规划一条任务的恢复动作。
 *
 * @param {object} task journal 折叠后的任务记录。
 * @param {{ live?: boolean, canResume?: boolean }} facts
 *   `live`：宿主现在就有这条会话（无需恢复）；`canResume`：宿主提供恢复能力。
 * @returns {'skip'|'attach'|'resume'|'interrupted'}
 *   `attach` 直接挂监听，`resume` 先让宿主把会话救回来，`interrupted` 直接判定
 *   会话已不在（宿主没有恢复能力时的老行为）。
 */
export function planRecovery(task, facts = {}) {
  if (task === null || task === undefined || typeof task !== 'object') return 'skip'
  if (task.status === 'closed' || task.status === 'queued') return 'skip'
  if (!hasWorkerSession(task)) return 'skip'
  if (facts.live === true) return 'attach'
  // 宿主没有恢复能力时退化成老行为：只有「本该在跑」的才判中断，空闲任务原样留着。
  if (facts.canResume !== true) return isRunningState(task.status) ? 'interrupted' : 'skip'
  return RESTORABLE_STATES.includes(task.status) ? 'resume' : 'skip'
}

/**
 * 恢复成功后要落盘的状态补丁。
 *
 * 本来在跑的任务改写成 `resumable`（会话回来了但那一轮没了）；本来就空闲的
 * 保持原状态，避免把 idle/blocked 的语义搅混。
 *
 * @param {object} task
 * @param {number} now
 * @returns {object} 直接作为 `task.updated` 的 patch。
 */
export function resumedPatch(task, now) {
  const status = isRunningState(task?.status) ? RESUMABLE : task?.status
  // 不覆盖 interruptedAt：保留「哪次重启把它打断、哪次把它救回来」这条历史。
  return { status, resumedAt: now }
}

/**
 * 恢复失败要落盘的状态补丁。`recoveryNotifiedAt` 让同一个任务在一次重启后
 * 只提醒 Router 一次。
 *
 * @param {number} now
 * @returns {object}
 */
export function interruptedPatch(now) {
  return { status: INTERRUPTED, interruptedAt: now, recoveryNotifiedAt: now }
}

/**
 * 给 Router 看的恢复说明。恢复成功时明确说「可以接着做」，失败时说「用原 brief
 * 起新 Worker」——避免 Router 在拿不到上下文时假装能续上一轮。
 *
 * @param {'resumed'|'interrupted'} outcome
 * @param {object} task
 * @returns {string}
 */
export function recoveryText(outcome, task) {
  const name = typeof task?.title === 'string' && task.title.length > 0 ? `"${task.title}"` : 'Task'
  if (outcome === 'resumed') {
    return [
      `Host restarted; the Worker session for ${name} was resumed and is idle now.`,
      'The earlier turn is gone (a half-finished turn is never replayed), but the conversation context is intact:',
      'continue with superagent_dispatch using reuse_task_id, or close the task.',
    ].join(' ')
  }
  return [
    `Host restarted and the Worker session for ${name} could not be resumed.`,
    'The task brief and journal survived.',
    'Either close it, or dispatch a new Worker from the original brief (superagent_recall shows it; reuse_task_id also works and starts a fresh Worker).',
  ].join(' ')
}
