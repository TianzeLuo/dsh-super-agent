/**
 * host-goals.js — 在 Router 会话里关掉宿主 goal 的自动续轮。
 *
 * 问题：宿主 goal 由 `dsh-goal-round-driver` 驱动——只要
 * `goal.phase === 'active' && goal.activation === 'armed'`，每轮结束驱动就再唤醒
 * 一次（`goal_round`），直到 `maxGoalRounds`。对 Router 这种“只在事件到来时判断”
 * 的会话，这就是空转：回合刚结束又被叫醒，没有新信息也不会有新进展。
 *
 * 处置只发生在**这一条 Router 会话**上，用三层公开接口，不改 DSH 内核：
 *
 *   1. `tools.restrict({ deny: ['create_goal', 'update_goal'] })`
 *      —— 从模型可见的工具表里摘掉，模型不会再想用它们；
 *   2. `tools.guard(fn)`（或 `tools/pre-execute` 兜底）
 *      —— 即使被并发/旧提示词调用也拒绝执行；
 *   3. `goals.disarm(agent)` 在安装时与每次 `goal/changed` 时调用
 *      —— 已存在或将来被 resume 的 goal 都拿不到续轮授权（驱动只看 activation）。
 *
 * `get_goal` 保留可见：只读，没有副作用，Router 仍可查历史。
 * 普通会话不经过本插件，完全不受影响。
 */

/** 在本会话里被禁用的宿主 goal 工具。 */
export const HOST_GOAL_TOOLS = ['create_goal', 'update_goal']

/** 拒绝执行时给模型看的说明（引导到原生目标）。 */
export const HOST_GOAL_DENY_REASON = 'Host goals are disabled in this super-agent Router session: the goal-round driver re-wakes the session at the end of every turn, which loops without new information. Use superagent_goal (action create/check/close) instead; it advances only on a scheduled check, a worker report, or an explicit user instruction.'

/**
 * 这个工具名是否属于被禁用的宿主 goal 工具。
 *
 * @param {unknown} name 工具名。
 * @returns {string|undefined} 拒绝原因；不相关时 undefined。
 */
export function goalToolDenial(name) {
  return typeof name === 'string' && HOST_GOAL_TOOLS.includes(name) ? HOST_GOAL_DENY_REASON : undefined
}

/**
 * 这个 goal 是否需要被 disarm（取消续轮授权）。
 *
 * 只看 activation：`armed` 就是驱动会继续叫醒我们的唯一条件；phase 是 paused 时
 * 驱动不会跑，但先 disarm 才能保证“之后有人 resume 也绝不会驱动”。
 *
 * @param {unknown} goal 宿主 goal 视图。
 * @returns {boolean}
 */
export function shouldDisarmGoal(goal) {
  return goal !== undefined && goal !== null && typeof goal === 'object' && goal.activation === 'armed'
}

/**
 * 在一条 Router 会话上安装宿主 goal 禁用层。
 *
 * 全部依赖可注入（tools/goals/agent 都是 duck-typed），因此可以在节点测试里用
 * 纯 mock 断言“restrict 调了哪些名字、guard 拒绝哪些调用、armed goal 会被 disarm”。
 *
 * @param {{
 *   agent: object,
 *   tools?: object,
 *   goals?: object,
 *   log?: (level: string, message: string) => void,
 * }} options
 * @returns {{
 *   restricted: string[],
 *   guarded: boolean,
 *   disarmed: number,
 *   notes: string[],
 *   dispose: () => void,
 * }}
 */
export function installHostGoalGuard(options) {
  const agent = options?.agent
  const tools = options?.tools
  const goals = options?.goals
  const log = typeof options?.log === 'function' ? options.log : () => {}
  const disposes = []
  const notes = []
  const restricted = []
  let guarded = false
  let disarmed = 0

  // 1. 从工具表里摘掉：模型看不到 schema，就不会再选中它们。
  if (tools !== undefined && tools !== null && typeof tools.restrict === 'function') {
    try {
      const handle = tools.restrict({ deny: [...HOST_GOAL_TOOLS] })
      if (typeof handle === 'function') disposes.push(handle)
      restricted.push(...HOST_GOAL_TOOLS)
    } catch (error) {
      notes.push(`could not hide host goal tools: ${error.message}`)
      log('warn', `禁用宿主 goal 工具失败：${error.message}`)
    }
  } else {
    notes.push('the host exposes no tools.restrict; host goal tools stay visible but are refused on execution')
  }

  // 2. 执行层兜底拒绝。
  if (tools !== undefined && tools !== null && typeof tools.guard === 'function') {
    try {
      const handle = tools.guard((execution) => goalToolDenial(execution?.tool?.name ?? execution?.name ?? execution?.toolName))
      if (typeof handle === 'function') disposes.push(handle)
      guarded = true
    } catch (error) {
      notes.push(`could not guard host goal tools: ${error.message}`)
      log('warn', `安装宿主 goal 工具守卫失败：${error.message}`)
    }
  }
  if (!guarded && agent?.ctx !== undefined && typeof agent.ctx.on === 'function') {
    try {
      const off = agent.ctx.on('tools/pre-execute', (execution, next) => {
        const name = execution?.tool?.name ?? execution?.name ?? execution?.toolName
        const denial = goalToolDenial(name)
        if (denial === undefined) return typeof next === 'function' ? next() : undefined
        return { kind: 'deny', reason: denial }
      })
      if (typeof off === 'function') disposes.push(off)
      guarded = true
    } catch (error) {
      notes.push(`could not hook tools/pre-execute: ${error.message}`)
    }
  }

  // 3. 已 armed 的 goal 立刻 disarm；之后每次变化再查一遍。
  const disarm = () => {
    if (goals === undefined || goals === null) return
    let goal
    try {
      goal = typeof goals.get === 'function' ? goals.get(agent) : undefined
    } catch (error) {
      log('debug', `读取宿主 goal 失败：${error.message}`)
      return
    }
    if (!shouldDisarmGoal(goal)) return
    try {
      goals.disarm(agent)
      disarmed += 1
    } catch (error) {
      notes.push(`could not disarm the host goal: ${error.message}`)
      log('warn', `解除宿主 goal 续轮失败：${error.message}`)
    }
  }
  disarm()
  if (goals !== undefined && goals !== null && agent?.ctx !== undefined && typeof agent.ctx.on === 'function') {
    try {
      // 事件形态在不同宿主版本里可能是 (goal)、(goal, agent) 或 ({ goal })；
      // 一律以 goals.get(agent) 为准，避免依赖载荷形状。
      const off = agent.ctx.on('goal/changed', () => disarm())
      if (typeof off === 'function') disposes.push(off)
    } catch (error) {
      notes.push(`could not watch goal/changed: ${error.message}`)
    }
  }

  return {
    restricted,
    guarded,
    disarmed,
    notes,
    dispose() {
      for (const dispose of disposes.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // 卸载时的清理失败不影响其它 dispose。
        }
      }
    },
  }
}
