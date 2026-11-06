/**
 * approval.test.mjs — Worker 审批阻塞的检测、Router trigger、超时升级与策略接口。
 *
 * 真实宿主里审批由 `ctx.approval` 的 `approval/request` waterfall 回答，并由
 * ApprovalService 在 Worker Session 上追加 `approval/asked` / `approval/decided`。
 * 这里用假 Host 直接发这两类 session 事件，验证插件侧的程序行为；不调用模型。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  APPROVAL_MODES,
  createApprovalAnswerer,
  describeApprovalRequest,
  normalizeApprovalMode,
  suggestApproval,
} from '../lib/approval.js'
import { Store } from '../lib/store.js'
import { setupRuntime, tick } from './fake-host.mjs'

/** 从批次消息里取纯文本。 */
function messageText(message) {
  return message.content.map((block) => block.text ?? '').join('\n')
}

/** 读 journal 里的全部事件（测试诊断用；journal 只追加）。 */
function journalEvents(dataDir) {
  return readFileSync(join(dataDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** 启动一条 Worker 并取出它的假 Session。 */
async function startWorker(ctx, extra = {}) {
  const dispatched = ctx.runtime.dispatch({
    title: 'Run the test suite',
    brief: 'Run the repository tests and report the result with evidence.',
    ...extra,
  })
  await tick()
  const task = ctx.store.getTask(dispatched.taskId)
  const child = ctx.children.get(task.workerSessionId)
  assert.ok(child !== undefined, 'worker session should be attached')
  return { task, child, dispatched }
}

/** 发一次 tool/call，再发对应的 approval/asked。 */
function askApproval(child, { id = 'apr_1', callId = 'call-1', command = 'npm test', toolName = 'bash' } = {}) {
  child.sessionEvent({
    type: 'tool/call',
    data: { callId, name: toolName, arguments: JSON.stringify({ command }) },
  })
  child.sessionEvent({
    type: 'approval/asked',
    data: { id, toolName, callId, reason: 'command needs approval outside the sandbox' },
  })
}

test('worker approval marks the task blocked-approval and sends a Router trigger', async () => {
  const ctx = setupRuntime()
  const { task, child } = await startWorker(ctx)

  askApproval(child, { command: 'npm test --filter login' })

  const blocked = ctx.store.getTask(task.id)
  assert.equal(blocked.status, 'blocked-approval')
  assert.equal(blocked.pendingApproval.id, 'apr_1')
  assert.equal(blocked.pendingApproval.toolName, 'bash')
  assert.match(blocked.pendingApproval.summary, /npm test --filter login/)
  assert.equal(blocked.pendingApproval.policy, 'ask')
  assert.equal(blocked.pendingApproval.suggestion, undefined)

  assert.equal(ctx.store.pendingTriggers().length, 1)
  assert.equal(ctx.runtime.flushNow().flushed, 1)
  assert.equal(ctx.router.messages.length, 1)
  const text = messageText(ctx.router.messages[0])
  assert.match(text, new RegExp(task.id))
  assert.match(text, /approval/i)
  assert.match(text, /npm test/)
  assert.match(text, /blocked/i)

  const trigger = [...ctx.store.triggers.values()].find((item) => item.externalId === 'approval:apr_1')
  assert.equal(trigger.kind, 'approval-request')
  assert.equal(trigger.meta.taskId, task.id)
  assert.equal(trigger.meta.approvalId, 'apr_1')
  assert.equal(trigger.meta.toolName, 'bash')
  assert.match(trigger.meta.summary, /npm test/)

  const asked = journalEvents(ctx.dataDir).filter((event) => event.t === 'approval.asked')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].approval.id, 'apr_1')
  assert.equal(asked[0].approval.policy, 'ask')
  assert.match(asked[0].approval.summary, /npm test/)
  ctx.runtime.stop()
})

test('the same approval event is idempotent and does not duplicate the trigger', async () => {
  const ctx = setupRuntime()
  const { child } = await startWorker(ctx)

  askApproval(child)
  askApproval(child)

  assert.equal(ctx.store.pendingTriggers().length, 1)
  assert.equal(journalEvents(ctx.dataDir).filter((event) => event.t === 'approval.asked').length, 1)
  ctx.runtime.stop()
})

test('approval/decided clears the block, restores working and records the outcome', async () => {
  const ctx = setupRuntime()
  const { task, child } = await startWorker(ctx)

  askApproval(child)
  assert.equal(ctx.store.getTask(task.id).status, 'blocked-approval')

  child.sessionEvent({
    type: 'approval/decided',
    data: { id: 'apr_1', outcome: 'allowed-once' },
  })

  const resolved = ctx.store.getTask(task.id)
  assert.equal(resolved.status, 'working')
  assert.equal(resolved.pendingApproval, undefined)
  assert.equal(resolved.lastApproval.id, 'apr_1')
  assert.equal(resolved.lastApproval.outcome, 'allowed-once')
  assert.equal(resolved.lastApproval.decidedBy, 'host')

  const events = journalEvents(ctx.dataDir)
  assert.equal(events.filter((event) => event.t === 'approval.resolved').length, 1)
  assert.equal(events.find((event) => event.t === 'approval.resolved').outcome, 'allowed-once')
  // 原 approval trigger 还在 pending 队列：补一条 resolved trigger，避免 Router
  // 醒来后对已经解决的事情再问用户。
  assert.equal(ctx.store.pendingTriggers().length, 2)
  const resolvedTrigger = [...ctx.store.triggers.values()].find((item) => item.externalId === 'approval-resolved:apr_1')
  assert.equal(resolvedTrigger.kind, 'approval-resolved')
  assert.equal(resolvedTrigger.meta.outcome, 'allowed-once')
  ctx.runtime.stop()
})

test('watchdog escalates an approval that stays unanswered, once', async () => {
  let clock = 10_000_000
  const ctx = setupRuntime({
    config: { watchdog: { approvalTimeoutMs: 60_000 } },
    now: () => clock,
  })
  const { task, child } = await startWorker(ctx)
  askApproval(child)

  assert.equal(ctx.runtime.checkNow().issues.length, 0)
  clock += 61_000
  const escalated = ctx.runtime.checkNow()
  assert.equal(escalated.issues.length, 1)
  assert.match(escalated.issues[0].text, /waiting/i)
  assert.match(escalated.issues[0].text, /approval/i)
  assert.match(escalated.issues[0].text, /npm test/)
  assert.equal(ctx.store.getTask(task.id).status, 'blocked-approval')
  assert.ok(ctx.store.getTask(task.id).pendingApproval.escalatedAt > 0)

  assert.equal(journalEvents(ctx.dataDir).filter((event) => event.t === 'approval.escalated').length, 1)
  // 第二次检查不重复升级，也不重复写事件。
  assert.equal(ctx.runtime.checkNow().issues.length, 0)
  assert.equal(journalEvents(ctx.dataDir).filter((event) => event.t === 'approval.escalated').length, 1)

  ctx.runtime.flushNow()
  const text = ctx.router.messages.map(messageText).join('\n')
  assert.match(text, /waiting/i)
  assert.match(text, /approval/i)
  ctx.runtime.stop()
})

test('approved before the timeout never escalates', async () => {
  let clock = 20_000_000
  const ctx = setupRuntime({
    config: { watchdog: { approvalTimeoutMs: 60_000 } },
    now: () => clock,
  })
  const { child } = await startWorker(ctx)
  askApproval(child)
  clock += 30_000
  child.sessionEvent({ type: 'approval/decided', data: { id: 'apr_1', outcome: 'rejected' } })
  clock += 60_000
  assert.equal(ctx.runtime.checkNow().issues.length, 0)
  assert.equal(journalEvents(ctx.dataDir).filter((event) => event.t === 'approval.escalated').length, 0)
  ctx.runtime.stop()
})

test('dispatch records the approval policy; this build still records deferred modes', async () => {
  const ctx = setupRuntime({ config: { approval: { mode: 'deny-all' } } })
  const first = await startWorker(ctx)
  assert.equal(first.dispatched.approval, 'deny-all')
  assert.equal(first.task.approvalMode, 'deny-all')

  const explicit = ctx.runtime.dispatch({
    title: 'Need an explicit ask',
    brief: 'This task overrides the configured default for approval.',
    approval: 'ask',
  })
  assert.equal(explicit.approval, 'ask')
  await tick()
  assert.equal(ctx.store.getTask(explicit.taskId).approvalMode, 'ask')

  const workspace = ctx.runtime.dispatch({
    title: 'Workspace auto policy',
    brief: 'This records auto-workspace for the future policy answerer.',
    approval: 'auto-workspace',
  })
  assert.equal(workspace.approval, 'auto-workspace')
  assert.throws(
    () => ctx.runtime.dispatch({
      title: 'Bad policy',
      brief: 'This dispatch should be rejected because the policy is unknown.',
      approval: 'yolo',
    }),
    (error) => error?.code === 'invalid_approval_mode',
  )
  ctx.runtime.stop()
})

test('approval policy parsing and the conservative workspace suggestion', () => {
  assert.deepEqual(APPROVAL_MODES, ['ask', 'auto-workspace', 'deny-all'])
  assert.equal(normalizeApprovalMode('AUTO-WORKSPACE'), 'auto-workspace')
  assert.equal(normalizeApprovalMode(undefined), 'ask')
  assert.throws(() => normalizeApprovalMode('sometimes'), (error) => error?.code === 'invalid_approval_mode')

  const readonly = describeApprovalRequest({ toolName: 'bash', arguments: JSON.stringify({ command: 'git status --short' }) })
  assert.equal(readonly.command, 'git status --short')
  assert.equal(suggestApproval('auto-workspace', readonly)?.decision, 'allow')

  const tests = describeApprovalRequest({ toolName: 'bash', arguments: { command: 'npm test' } })
  assert.equal(suggestApproval('auto-workspace', tests)?.decision, 'allow')

  const destructive = describeApprovalRequest({ toolName: 'bash', arguments: { command: 'rm -rf dist' } })
  assert.equal(suggestApproval('auto-workspace', destructive)?.decision, 'deny')

  const unknown = describeApprovalRequest({ toolName: 'bash', arguments: { command: 'docker run alpine' } })
  assert.equal(suggestApproval('auto-workspace', unknown), undefined)
  assert.equal(suggestApproval('deny-all', unknown)?.decision, 'deny')
  assert.equal(suggestApproval('ask', readonly), undefined)

  const write = describeApprovalRequest({ toolName: 'write', arguments: { path: 'src/app.js', content: 'secret sk-abcdefghijklmnop' } })
  assert.match(write.summary, /src\/app\.js/)
  assert.match(write.argumentsPreview, /\[redacted\]/)
  assert.equal(suggestApproval('auto-workspace', write, { cwd: '/repo' })?.decision, 'allow')
  const outside = describeApprovalRequest({ toolName: 'write', arguments: { path: '/etc/passwd' } })
  assert.equal(suggestApproval('auto-workspace', outside, { cwd: '/repo' })?.decision, 'deny')
})

test('createApprovalAnswerer is the reserved B interface: scoped, next() for manual', async () => {
  assert.equal(createApprovalAnswerer({ mode: 'ask' }), undefined)

  const decisions = []
  const answerer = createApprovalAnswerer({
    mode: 'auto-workspace',
    onDecision: (record) => decisions.push(record),
  })
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return 'unavailable'
  }

  assert.equal(await answerer({ toolName: 'bash', arguments: { command: 'git log --oneline' } }, next), 'allowed-once')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].mode, 'auto-workspace')
  assert.equal(decisions[0].outcome, 'allowed-once')
  assert.match(decisions[0].rule, /read-only/)

  assert.equal(await answerer({ toolName: 'bash', arguments: { command: 'docker run alpine' } }, next), 'unavailable')
  assert.equal(nextCalls, 1)

  const denyAll = createApprovalAnswerer({ mode: 'deny-all' })
  assert.equal(await denyAll({ toolName: 'bash', arguments: { command: 'ls' } }, next), 'rejected')
})

test('approval state and audit fields survive journal replay', async () => {
  const ctx = setupRuntime()
  const { task, child } = await startWorker(ctx)
  askApproval(child)

  const replay = new Store({ dir: ctx.dataDir })
  replay.open({ readonly: true })
  const replayedTask = replay.getTask(task.id)
  assert.equal(replayedTask.status, 'blocked-approval')
  assert.equal(replayedTask.pendingApproval.id, 'apr_1')
  assert.match(replayedTask.pendingApproval.summary, /npm test/)
  assert.equal(replayedTask.approvalMode, 'ask')

  child.sessionEvent({ type: 'approval/decided', data: { id: 'apr_1', outcome: 'rejected' } })
  const replayAfter = new Store({ dir: ctx.dataDir })
  replayAfter.open({ readonly: true })
  const afterTask = replayAfter.getTask(task.id)
  assert.equal(afterTask.status, 'working')
  assert.equal(afterTask.pendingApproval, undefined)
  assert.equal(afterTask.lastApproval.outcome, 'rejected')
  ctx.runtime.stop()
})
