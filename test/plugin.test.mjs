/**
 * plugin.test.mjs — 用假 cordis/Agent 验证宿主接线：项目开关、单 Router、
 * 工具与提示词注册、HTTP 端点、dispose 后的租约释放。
 *
 * 这不是 DSH 集成测试；真实宿主的行为由 runtime.test.mjs 的假 Agent 契约覆盖。
 * 这里抓的是“装没装、装到哪条 scope、关的时候有没有解绑”这类接线错误。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../lib/index.js'
import { storePaths } from '../lib/store.js'

function project() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-super-agent-plugin-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.dsh'))
  writeFileSync(join(root, '.dsh', 'super-agent.json'), JSON.stringify({
    version: 1,
    enabled: true,
    router: { batchDebounceMs: 3_600_000 },
  }))
  return root
}

function bareProject() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-super-agent-bare-'))
  mkdirSync(join(root, '.git'))
  return root
}

function fakeCordis() {
  const handlers = new Map()
  const agents = new Map()
  const routes = new Map()
  const effects = []
  /** 等待服务就绪的 inject 回调（模拟 cordis 的 provide 通知）。 */
  const pending = []
  const scoped = {
    agents: {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => routes.delete(route.path)
        },
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
    get(name) {
      return scoped[name]
    },
    inject(names, callback) {
      // 与真 cordis 一致：依赖齐了就回调，否则等 provide 时再回调
      if (names.every((name) => scoped[name] !== undefined)) callback(scoped)
      else pending.push({ names, callback })
    },
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    provide() {},
  }
  const root = {
    inject(names, callback) {
      callback(scoped)
    },
  }
  return {
    root,
    scoped,
    agents,
    routes,
    effects,
    /**
     * 模拟某个插件注册服务（例如 awayNotify）：已有等待者时立刻回调它们，
     * 与 cordis 的 `provide` 通知语义一致。
     */
    provide(name, value) {
      scoped[name] = value
      for (const entry of [...pending]) {
        if (!entry.names.every((dependency) => scoped[dependency] !== undefined)) continue
        pending.splice(pending.indexOf(entry), 1)
        entry.callback(scoped)
      }
    },
    emit(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
    },
  }
}

function fakeAgent({ id, cwd, subagent = false }) {
  const handlers = new Map()
  const tools = new Map()
  const sections = []
  const contexts = []
  const messages = []
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
    emit(event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
    },
    count(event) {
      return handlers.get(event)?.size ?? 0
    },
    get(name) {
      return name === 'subagents' ? subagents : undefined
    },
    inject(names, callback) {
      callback(ctx)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(value) {
        sections.push(value)
        return () => undefined
      },
      context(value) {
        contexts.push(value)
        return () => undefined
      },
    },
  }
  const agent = {
    id,
    status: 'idle',
    ctx,
    session: { header: { id, cwd, ...(subagent ? { origin: 'subagent', delegationDepth: 1 } : {}) } },
    messages,
    tools,
    sections,
    contexts,
    followup(message) {
      messages.push(message)
      agent.status = 'running'
    },
  }
  return agent
}

const subagents = {
  getProvider: () => ({ name: 'spawn' }),
  startActivation: async () => {
    throw new Error('not used in this test')
  },
}

test('enabled project installs tools, prompt and HTTP routes on exactly one root agent', async () => {
  const root = project()
  const sys = fakeCordis()
  apply(sys.root)

  const first = fakeAgent({ id: 'session-1', cwd: root })
  sys.agents.set(first.id, first)
  sys.emit('agent/created', { agent: first })

  assert.equal(name, 'super-agent')
  assert.deepEqual([...first.tools.keys()].sort(), [
    'superagent_close',
    'superagent_dispatch',
    'superagent_projects',
    'superagent_recall',
    'superagent_status',
    'superagent_steer',
    'superagent_tell',
  ])
  assert.equal(first.sections.length, 1)
  assert.equal(first.sections[0].name, 'super-agent:router')
  assert.match(first.sections[0].text, /two-layer super-agent/)
  assert.equal(first.contexts.length, 1)
  assert.equal(first.ctx.count('tools/pre-execute'), 1)
  assert.ok(existsSync(join(root, '.dsh', 'super-agent', 'journal.jsonl')))
  assert.ok(existsSync(join(root, '.dsh', 'super-agent', 'owner.json')))
  assert.deepEqual([...sys.routes.keys()].sort(), [
    '/api/super-agent/ingest',
    '/api/super-agent/outbox',
    '/api/super-agent/status',
    '/api/super-agent/ui/ensure',
    '/api/super-agent/ui/focus',
    '/api/super-agent/ui/reset',
    '/api/super-agent/ui/state',
  ])

  assert.ok(first.tools.get('superagent_dispatch').parameters.properties.reuse_task_id)
  const status = await first.tools.get('superagent_status').execute({}, {})
  assert.equal(status.ok, true)
  assert.match(status.summary, /super-agent/)

  // A second root session for the same project must not become a second router.
  const second = fakeAgent({ id: 'session-2', cwd: root })
  sys.agents.set(second.id, second)
  sys.emit('agent/created', { agent: second })
  assert.equal(second.tools.size, 0)

  // Workers never get router tools.
  const worker = fakeAgent({ id: 'worker-1', cwd: root, subagent: true })
  sys.agents.set(worker.id, worker)
  sys.emit('agent/created', { agent: worker })
  assert.equal(worker.tools.size, 0)

  sys.emit('agent/disposed', { agent: first })
  const owner = JSON.parse(readFileSync(storePaths(join(root, '.dsh', 'super-agent')).owner, 'utf8'))
  assert.ok(typeof owner.releasedAt === 'string')

  // The claim is released, so a later root session can take over.
  const third = fakeAgent({ id: 'session-3', cwd: root })
  sys.agents.set(third.id, third)
  sys.emit('agent/created', { agent: third })
  assert.equal(third.tools.size, 7)
  sys.emit('agent/disposed', { agent: third })
})

test('HTTP ingest and outbox routes operate on the runtime', async () => {
  const root = project()
  const sys = fakeCordis()
  apply(sys.root)
  const agent = fakeAgent({ id: 'session-http', cwd: root })
  sys.agents.set(agent.id, agent)
  sys.emit('agent/created', { agent })

  const ingest = sys.routes.get('/api/super-agent/ingest')
  const response = await ingest.fetch(new Request('http://127.0.0.1/api/super-agent/ingest', {
    method: 'POST',
    body: JSON.stringify({
      id: 'evt_ext_1',
      source: 'im',
      threadKey: 'team:dev',
      actor: 'alice',
      text: '@super-agent login is broken',
    }),
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.match(body.id, /^trg_/)
  assert.equal(body.state, 'pending')

  // The same external id is idempotent over HTTP.
  const duplicate = await ingest.fetch(new Request('http://127.0.0.1/api/super-agent/ingest', {
    method: 'POST',
    body: JSON.stringify({ id: 'evt_ext_1', source: 'im', threadKey: 'team:dev', actor: 'alice', text: 'again' }),
  }))
  const duplicateBody = await duplicate.json()
  assert.equal(duplicateBody.duplicate, true)

  const tell = await agent.tools.get('superagent_tell').execute({ channel: 'im', text: 'Fixed login.' }, {})
  assert.equal(tell.status, 'queued')

  const outbox = await sys.routes.get('/api/super-agent/outbox').fetch(new Request('http://127.0.0.1/api/super-agent/outbox'))
  const outboxBody = await outbox.json()
  assert.equal(outboxBody.messages.length, 1)
  assert.match(outboxBody.messages[0].text, /Fixed login/)

  const recall = await agent.tools.get('superagent_recall').execute({ id: body.id }, {})
  assert.equal(recall.ok, true)
  assert.equal(recall.kind, 'trigger')

  const status = await sys.routes.get('/api/super-agent/status').fetch(new Request('http://127.0.0.1/api/super-agent/status'))
  const statusBody = await status.json()
  assert.equal(statusBody.ok, true)
  assert.equal(statusBody.snapshot.counts.triggers, 1)

  sys.emit('agent/disposed', { agent })
})

test('an uninitialized project stays inert', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-super-agent-plugin-off-'))
  mkdirSync(join(root, '.git'))
  const sys = fakeCordis()
  apply(sys.root)
  const agent = fakeAgent({ id: 'session-off', cwd: root })
  sys.agents.set(agent.id, agent)
  sys.emit('agent/created', { agent })
  assert.equal(agent.tools.size, 0)
  assert.equal(agent.sections.length, 0)
  // UI 入口必须先于 Router 存在；工具/提示词仍然完全不注册。
  assert.equal(sys.routes.size, 7)
})

test('UI ensure creates a Router through the generic Session API and focus updates it', async () => {
  const root = project()
  const sys = fakeCordis()
  let nextId = 'session-ui-router'
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const id = sessionId ?? nextId
      const agent = fakeAgent({ id, cwd })
      sys.agents.set(id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async rename() {},
  }
  apply(sys.root)
  assert.ok(sys.routes.has('/api/super-agent/ui/ensure'))

  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const response = await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: JSON.stringify({ cwd: root }),
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.match(body.sessionId, /^session-/)
  assert.equal(body.reused, false)
  const pointer = JSON.parse(readFileSync(join(root, '.dsh', 'super-agent', 'router.json'), 'utf8'))
  assert.equal(pointer.ui, true)
  assert.equal(pointer.sessionId, body.sessionId)
  const router = sys.agents.get(body.sessionId)
  assert.equal(router.tools.size, 7)

  const state = await sys.routes.get('/api/super-agent/ui/state').fetch(
    new Request('http://127.0.0.1/api/super-agent/ui/state'),
  )
  const stateBody = await state.json()
  assert.equal(stateBody.ok, true)
  assert.equal(stateBody.active, true)
  assert.equal(stateBody.router.sessionId, body.sessionId)

  const focus = await sys.routes.get('/api/super-agent/ui/focus').fetch(new Request('http://127.0.0.1/api/super-agent/ui/focus', {
    method: 'POST',
    body: JSON.stringify({ cwd: root }),
  }))
  const focusBody = await focus.json()
  assert.equal(focusBody.ok, true)
  assert.equal(focusBody.focusProject, root)

  // A second ensure returns the same Router instead of minting another.
  const again = await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: JSON.stringify({ cwd: root }),
  }))
  const againBody = await again.json()
  assert.equal(againBody.sessionId, body.sessionId)
  assert.equal(againBody.reused, true)

  // Once the project is UI-managed, a fresh blank root session must not steal
  // the Router before the panel gets a chance to resume the pinned one.
  const blank = fakeAgent({ id: 'session-fresh-blank', cwd: root })
  sys.agents.set(blank.id, blank)
  sys.emit('agent/created', { agent: blank })
  assert.equal(blank.tools.size, 0)

  sys.emit('agent/disposed', { agent: router })
})

test('UI ensure without cwd uses an independent Super-agent workspace', async () => {
  const root = project()
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-home-'))
  const sys = fakeCordis()
  const created = []
  const attached = []
  sys.scoped.workspaceRegistry = {
    list: () => [
      { id: 'ws-user', title: 'alpha', path: root, sessionIds: [] },
      ...created,
    ],
    create(path, title) {
      const workspace = {
        id: 'ws-super-agent',
        title,
        path,
        sessionIds: [],
        attachSession: async (sessionId) => {
          attached.push(sessionId)
          workspace.sessionIds.unshift(sessionId)
        },
      }
      created.push(workspace)
      return workspace
    },
  }
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const agent = fakeAgent({ id: sessionId, cwd })
      sys.agents.set(agent.id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: agent.id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async prompt() {},
    async rename() {},
  }
  apply(sys.root, { superAgentHome: home })
  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const response = await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: '{}',
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.projectRoot, home)
  assert.ok(existsSync(join(home, '.dsh-super-agent-workspace')))
  assert.ok(existsSync(join(home, '.dsh', 'super-agent.json')))
  assert.deepEqual(created.map((workspace) => [workspace.title, workspace.path]), [['Super-agent Workspace', home]])
  assert.deepEqual(attached, [body.sessionId])
  assert.equal(sys.agents.get(body.sessionId).tools.size, 7)
  const projectTool = await sys.agents.get(body.sessionId).tools.get('superagent_projects').execute({}, {})
  assert.deepEqual(projectTool.projects.map((project) => project.title), ['alpha'])
  const state = await sys.routes.get('/api/super-agent/ui/state').fetch(
    new Request('http://127.0.0.1/api/super-agent/ui/state'),
  )
  const stateBody = await state.json()
  assert.deepEqual(stateBody.projects.map((project) => project.title), ['alpha'])
  assert.deepEqual(stateBody.workspaceSessions, [body.sessionId])
  sys.emit('agent/disposed', { agent: sys.agents.get(body.sessionId) })
})

test('UI ensure starts without any user project', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-home-empty-'))
  const sys = fakeCordis()
  sys.scoped.workspaceRegistry = {
    list: () => [],
    create: (path, title) => ({ id: 'ws-home', title, path, attachSession: async () => undefined }),
  }
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const agent = fakeAgent({ id: sessionId, cwd })
      sys.agents.set(agent.id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: agent.id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async rename() {},
  }
  apply(sys.root, { superAgentHome: home })
  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const response = await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: '{}',
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.projectRoot, home)
  const projectTool = await sys.agents.get(body.sessionId).tools.get('superagent_projects').execute({}, {})
  assert.deepEqual(projectTool.projects, [])
  sys.emit('agent/disposed', { agent: sys.agents.get(body.sessionId) })
})

test('the dedicated Router takes precedence over an older project Router', async () => {
  const root = project()
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-home-priority-'))
  const sys = fakeCordis()
  sys.scoped.workspaceRegistry = {
    list: () => [{ id: 'ws-user', title: 'alpha', path: root, sessionIds: [] }],
    create: (path, title) => ({ id: 'ws-home', title, path, attachSession: async () => undefined }),
  }
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const agent = fakeAgent({ id: sessionId, cwd })
      sys.agents.set(agent.id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: agent.id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async rename() {},
  }
  apply(sys.root, { superAgentHome: home })
  const old = fakeAgent({ id: 'session-old-project-router', cwd: root })
  sys.agents.set(old.id, old)
  sys.emit('agent/created', { agent: old })
  assert.equal(old.tools.size, 7)

  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const response = await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: '{}',
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.projectRoot, home)
  assert.notEqual(body.sessionId, old.id)
  assert.equal(sys.agents.get(body.sessionId).tools.size, 7)
  const state = await sys.routes.get('/api/super-agent/ui/state').fetch(
    new Request('http://127.0.0.1/api/super-agent/ui/state'),
  )
  const stateBody = await state.json()
  assert.equal(stateBody.router.projectRoot, home)
  assert.equal(stateBody.router.sessionId, body.sessionId)
  assert.equal(stateBody.routers.length, 2)
  sys.emit('agent/disposed', { agent: sys.agents.get(body.sessionId) })
  sys.emit('agent/disposed', { agent: old })
})

test('UI reset starts a fresh dataDir generation and archives active workers', async () => {
  const alpha = project()
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-home-reset-'))
  const sys = fakeCordis()
  const archived = []
  sys.scoped.workspaceRegistry = {
    list: () => [{ id: 'ws-alpha', title: 'alpha', path: alpha, sessionIds: [] }],
    create: (path, title) => ({ id: 'ws-home', title, path, attachSession: async () => undefined }),
    archiveSession: async (sessionId) => { archived.push(sessionId) },
  }
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const agent = fakeAgent({ id: sessionId, cwd })
      sys.agents.set(agent.id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: agent.id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async rename() {},
  }
  apply(sys.root, { superAgentHome: home })
  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const first = await (await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST', body: '{}',
  }))).json()
  const oldSession = first.sessionId
  const oldDataDir = first.dataDir
  const dispatch = await sys.agents.get(oldSession).tools.get('superagent_dispatch').execute({
    title: 'Active reset worker',
    brief: 'do the reset probe',
    project: 'alpha',
  }, {})
  assert.ok(['queued', 'starting'].includes(dispatch.status))
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  const activeState = await (await sys.routes.get('/api/super-agent/ui/state').fetch(
    new Request('http://127.0.0.1/api/super-agent/ui/state'),
  )).json()
  const activeWorker = activeState.router.status.tasks.find((task) => task.title === 'Active reset worker')?.workerSessionId
  assert.match(activeWorker, /^session-/)

  const reset = sys.routes.get('/api/super-agent/ui/reset')
  const response = await reset.fetch(new Request('http://127.0.0.1/api/super-agent/ui/reset', {
    method: 'POST', body: '{}',
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.reset, true)
  assert.equal(body.previousSessionId, oldSession)
  assert.notEqual(body.sessionId, oldSession)
  assert.notEqual(body.dataDir, oldDataDir)
  assert.match(body.dataDir, /super-agent-resets[\\/]gen-/)
  assert.ok(archived.every((sessionId) => sessionId !== oldSession))
  assert.ok(archived.includes(activeWorker))
  assert.equal(sys.agents.get(body.sessionId).tools.size, 7)
  const state = await (await sys.routes.get('/api/super-agent/ui/state').fetch(
    new Request('http://127.0.0.1/api/super-agent/ui/state'),
  )).json()
  assert.equal(state.router.sessionId, body.sessionId)
  assert.deepEqual(state.router.status.tasks, [])
  assert.equal(JSON.parse(readFileSync(join(home, '.dsh', 'super-agent.json'), 'utf8')).dataDir, body.dataDir)
  sys.emit('agent/disposed', { agent: sys.agents.get(body.sessionId) })
})

test('UI ensure initializes a bare project with the minimal enable config', async () => {
  const root = bareProject()
  const sys = fakeCordis()
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const id = sessionId ?? 'session-bare-router'
      const agent = fakeAgent({ id, cwd })
      sys.agents.set(id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async rename() {},
  }
  apply(sys.root)
  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const response = await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: JSON.stringify({ cwd: root }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.match(body.sessionId, /^session-/)
  assert.ok(existsSync(join(root, '.dsh', 'super-agent.json')))
  const config = JSON.parse(readFileSync(join(root, '.dsh', 'super-agent.json'), 'utf8'))
  assert.equal(config.enabled, true)
  assert.equal(config.version, 1)
  assert.equal(sys.agents.get(body.sessionId).tools.size, 7)
  sys.emit('agent/disposed', { agent: sys.agents.get(body.sessionId) })
})

// ── 决策 1：把 worker 会话登记给 dsh-away-notify ────────────────────────────
//
// worker 是普通 Session（header 没有 origin / delegationDepth），away-notify 只能按
// 标题前缀 `Super-agent worker · …` 兜底识别；用户一改名就漏。这里验证由创建方主动
// 登记（awayNotify.markInternal）：创建时增量登记、关闭时释放、服务缺失时静默降级、
// 服务晚到时补登记。

/** 一个假的 awayNotify 服务：记录登记/释放。 */
function fakeAwayNotify() {
  const calls = []
  const released = []
  return {
    version: 1,
    calls,
    released,
    markInternal(sessionId, reason) {
      calls.push([sessionId, reason])
      return () => {
        released.push(sessionId)
        return true
      }
    },
  }
}

/**
 * 跨项目 worker 的最小装置：独立 workspace（Router）+ 目标项目 alpha。
 *
 * @param {{ away?: object }} [options] away 服务；不传表示 away-notify 没装。
 * @returns {Promise<object>} 装置与本次 dispatch 出来的 worker 信息。
 */
async function workerRig({ away } = {}) {
  const alpha = project()
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-home-away-'))
  const sys = fakeCordis()
  if (away !== undefined) sys.provide('awayNotify', away)
  sys.scoped.workspaceRegistry = {
    list: () => [{ id: 'ws-alpha', title: 'alpha', path: alpha, sessionIds: [] }],
    create: (path, title) => ({ id: 'ws-home', title, path, attachSession: async () => undefined }),
    archiveSession: async () => undefined,
  }
  sys.scoped.sessionController = {
    async create({ cwd, sessionId }) {
      const agent = fakeAgent({ id: sessionId, cwd })
      sys.agents.set(agent.id, agent)
      sys.emit('agent/created', { agent })
      return { sessionId: agent.id }
    },
    async resolveAgent(id) {
      const agent = sys.agents.get(id)
      return agent === undefined ? { error: { message: 'missing' } } : { agent }
    },
    async prompt() {},
    async rename() {},
  }
  apply(sys.root, { superAgentHome: home })
  const ensure = sys.routes.get('/api/super-agent/ui/ensure')
  const router = await (await ensure.fetch(new Request('http://127.0.0.1/api/super-agent/ui/ensure', {
    method: 'POST',
    body: '{}',
  }))).json()
  const tools = sys.agents.get(router.sessionId).tools
  const dispatch = await tools.get('superagent_dispatch').execute({
    title: 'away probe',
    brief: 'probe the notification registration',
    project: 'alpha',
  }, {})
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  const state = await (await sys.routes.get('/api/super-agent/ui/state').fetch(
    new Request('http://127.0.0.1/api/super-agent/ui/state'),
  )).json()
  const task = state.router.status.tasks.find((candidate) => candidate.title === 'away probe')
  return { sys, alpha, home, router, tools, dispatch, task, workerId: task?.workerSessionId }
}

test('worker 创建时登记给 awayNotify，任务关闭时释放', async () => {
  const away = fakeAwayNotify()
  const rig = await workerRig({ away })
  assert.match(rig.workerId, /^session-/)
  assert.deepEqual(away.calls, [[rig.workerId, 'super-agent-worker']], '创建时登记一次（幂等）')
  assert.equal(away.released.length, 0)

  await rig.tools.get('superagent_close').execute({ task_id: rig.task.id }, {})
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  assert.deepEqual(away.released, [rig.workerId], '任务关闭后必须撤销登记，不能长期占着')

  rig.sys.emit('agent/disposed', { agent: rig.sys.agents.get(rig.router.sessionId) })
});

test('awayNotify 缺失时 worker 照常创建（静默降级，不抛）', async () => {
  const rig = await workerRig({})
  assert.match(rig.workerId, /^session-/, '没有 away-notify 也要正常派工')
  assert.ok(rig.sys.agents.get(rig.workerId) !== undefined)
  rig.sys.emit('agent/disposed', { agent: rig.sys.agents.get(rig.router.sessionId) })
});

test('awayNotify 晚于 super-agent 就绪：补登记已经存在的 worker', async () => {
  const rig = await workerRig({})
  assert.match(rig.workerId, /^session-/)
  const away = fakeAwayNotify()
  rig.sys.provide('awayNotify', away)
  assert.deepEqual(away.calls, [[rig.workerId, 'super-agent-worker']], '服务就绪时应补登记活着的 worker')
  rig.sys.emit('agent/disposed', { agent: rig.sys.agents.get(rig.router.sessionId) })
});
