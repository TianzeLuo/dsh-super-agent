/**
 * host-goals.test.mjs — 在 Router 会话里关掉宿主 goal 的自动续轮。
 *
 * 宿主 `dsh-goal-round-driver` 只看 `goal.phase === 'active' && activation === 'armed'`
 * 就每轮结束再唤醒一次；插件不能用私有 API，所以用三层公开面处理：
 * `tools.restrict` 摘工具、`tools.guard`（或 `tools/pre-execute`）拒绝执行、
 * `goals.disarm` 取消续轮授权。这里用 mock 断言三层都生效，且只作用于这一条会话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOST_GOAL_DENY_REASON,
  HOST_GOAL_TOOLS,
  goalToolDenial,
  installHostGoalGuard,
  shouldDisarmGoal,
} from '../lib/host-goals.js'
import { fakeCtx } from './fake-host.mjs'

/** 最小 tools 服务桩：记录 restrict/guard。 */
function fakeTools({ withGuard = true, withRestrict = true } = {}) {
  const restricted = []
  const guards = []
  const tools = {}
  if (withRestrict) {
    tools.restrict = (options) => {
      restricted.push(options)
      return () => { restricted.push({ disposed: true }) }
    }
  }
  if (withGuard) {
    tools.guard = (fn) => {
      guards.push(fn)
      return () => { guards.push(undefined) }
    }
  }
  return { tools, restricted, guards }
}

/** 最小 goals 服务桩。 */
function fakeGoals(initial) {
  const state = { goal: initial, disarms: 0 }
  return {
    state,
    get: () => state.goal,
    disarm: () => { state.disarms += 1 },
  }
}

test('only the mutating host goal tools are denied; get_goal stays available', () => {
  assert.deepEqual(HOST_GOAL_TOOLS, ['create_goal', 'update_goal'])
  assert.equal(goalToolDenial('create_goal'), HOST_GOAL_DENY_REASON)
  assert.equal(goalToolDenial('update_goal'), HOST_GOAL_DENY_REASON)
  assert.equal(goalToolDenial('get_goal'), undefined)
  assert.equal(goalToolDenial('superagent_goal'), undefined)
  assert.equal(goalToolDenial(undefined), undefined)
  assert.match(HOST_GOAL_DENY_REASON, /superagent_goal/)
})

test('an armed goal is the only thing that needs disarming', () => {
  assert.equal(shouldDisarmGoal({ activation: 'armed', phase: 'active' }), true)
  assert.equal(shouldDisarmGoal({ activation: 'armed', phase: 'paused' }), true)
  assert.equal(shouldDisarmGoal({ activation: 'disarmed', phase: 'active' }), false)
  assert.equal(shouldDisarmGoal(undefined), false)
})

test('install hides the tools, refuses execution and disarms an armed goal', () => {
  const agent = { id: 'session-router', ctx: fakeCtx() }
  const { tools, restricted, guards } = fakeTools()
  const goals = fakeGoals({ id: 'goal_1', phase: 'active', activation: 'armed', roundsStarted: 2 })

  const handle = installHostGoalGuard({ agent, tools, goals })
  assert.deepEqual(restricted, [{ deny: ['create_goal', 'update_goal'] }])
  assert.deepEqual(handle.restricted, HOST_GOAL_TOOLS)
  assert.equal(handle.guarded, true)
  assert.equal(goals.state.disarms, 1, 'the existing armed goal is disarmed immediately')
  assert.equal(handle.disarmed, 1)

  // guard 只看工具名：goal 工具被拒，其余放行。
  assert.equal(guards.length, 1)
  assert.equal(guards[0]({ tool: { name: 'create_goal' } }), HOST_GOAL_DENY_REASON)
  assert.equal(guards[0]({ tool: { name: 'update_goal' } }), HOST_GOAL_DENY_REASON)
  assert.equal(guards[0]({ tool: { name: 'get_goal' } }), undefined)
  assert.equal(guards[0]({ tool: { name: 'superagent_dispatch' } }), undefined)

  // 之后有人 resume：goal/changed 里再次 armed，仍然被 disarm。
  goals.state.goal = { id: 'goal_1', phase: 'active', activation: 'armed' }
  agent.ctx.emit('goal/changed', { goal: goals.state.goal })
  assert.equal(goals.state.disarms, 2)

  handle.dispose()
  assert.equal(restricted.length, 2, 'disposing releases restrict')
  agent.ctx.emit('goal/changed', { goal: goals.state.goal })
  assert.equal(goals.state.disarms, 2, 'after dispose the plugin no longer watches')
})

test('a host without tools.guard still denies via tools/pre-execute', () => {
  // 需要拿到监听器的返回值，所以这里用一个会收集返回值的 ctx（fakeCtx 的 emit 丢弃返回值）。
  const handlers = new Map()
  const agent = {
    id: 'session-router',
    ctx: {
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, new Set())
        handlers.get(event).add(handler)
        return () => handlers.get(event)?.delete(handler)
      },
      count(event) {
        return handlers.get(event)?.size ?? 0
      },
    },
  }
  const invoke = (event, ...args) => {
    let result
    for (const handler of handlers.get(event) ?? []) {
      const value = handler(...args)
      if (value !== undefined) result = value
    }
    return result
  }
  const { tools } = fakeTools({ withGuard: false })
  const goals = fakeGoals(undefined)
  const handle = installHostGoalGuard({ agent, tools, goals })
  assert.equal(handle.guarded, true)
  assert.equal(agent.ctx.count('tools/pre-execute'), 1)

  const next = () => 'allowed'
  assert.deepEqual(invoke('tools/pre-execute', { tool: { name: 'create_goal' } }, next), {
    kind: 'deny',
    reason: HOST_GOAL_DENY_REASON,
  })
  assert.equal(invoke('tools/pre-execute', { tool: { name: 'superagent_status' } }, next), 'allowed')
  handle.dispose()
  assert.equal(agent.ctx.count('tools/pre-execute'), 0)
})

test('a host without tools.restrict keeps the tools visible but refuses execution', () => {
  const agent = { id: 'session-router', ctx: fakeCtx() }
  const { tools, restricted } = fakeTools({ withRestrict: false })
  const goals = fakeGoals(undefined)
  const handle = installHostGoalGuard({ agent, tools, goals })
  assert.deepEqual(handle.restricted, [])
  assert.equal(restricted.length, 0)
  assert.equal(handle.guarded, true)
  assert.ok(handle.notes.some((note) => note.includes('tools.restrict')))
})

test('a paused goal is left paused and nothing is disarmed before it arms', () => {
  const agent = { id: 'session-router', ctx: fakeCtx() }
  const { tools } = fakeTools()
  const goals = fakeGoals({ id: 'goal_1', phase: 'paused', activation: 'disarmed' })
  const handle = installHostGoalGuard({ agent, tools, goals })
  assert.equal(goals.state.disarms, 0)
  assert.equal(handle.disarmed, 0)
  // resume → armed → disarm，但不会去改 phase（用户的暂停/恢复状态不被插件覆盖）。
  goals.state.goal = { id: 'goal_1', phase: 'active', activation: 'armed' }
  agent.ctx.emit('goal/changed')
  assert.equal(goals.state.disarms, 1)
  assert.equal(goals.state.goal.phase, 'active')
})

test('a host without a goal service installs harmlessly', () => {
  const agent = { id: 'session-router', ctx: fakeCtx() }
  const { tools } = fakeTools()
  const handle = installHostGoalGuard({ agent, tools, goals: undefined })
  assert.equal(handle.guarded, true)
  assert.equal(handle.disarmed, 0)
  assert.equal(typeof handle.dispose, 'function')
  handle.dispose()
})
