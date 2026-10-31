/**
 * cli.test.mjs — 项目开关、inbox 追加、只读状态与召回。
 *
 * 直接调用导出的 main()，把 stdout 捕获成字符串；不启动宿主、不调用模型。
 * 每个用例用独立的临时项目，不清理（仓库规则 R2）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../bin/super-agent.mjs'
import { Store } from '../lib/store.js'

function project() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-super-agent-cli-'))
  mkdirSync(join(root, '.git'))
  return root
}

/** 捕获一次 main() 的 stdout。 */
function run(args) {
  const chunks = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const code = main(args)
    return { code, output: chunks.join('') }
  } finally {
    process.stdout.write = original
  }
}

test('init writes an enabled project config and is idempotent', () => {
  const root = project()
  const first = run(['init', '--project', root])
  assert.equal(first.code, 0)
  assert.match(first.output, /initialized/)
  const configPath = join(root, '.dsh', 'super-agent.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(config.enabled, true)
  assert.equal(config.version, 1)

  const again = run(['init', '--project', root])
  assert.match(again.output, /already initialized/)
})

test('enable and disable preserve unrelated config keys', () => {
  const root = project()
  mkdirSync(join(root, '.dsh'))
  const configPath = join(root, '.dsh', 'super-agent.json')
  writeFileSync(configPath, JSON.stringify({ enabled: true, dataDir: 'state', custom: 7 }))
  run(['disable', '--project', root])
  const disabled = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.custom, 7)
  run(['enable', '--project', root])
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).enabled, true)
})

test('emit appends one inbox line with a stable thread id', () => {
  const root = project()
  run(['init', '--project', root])
  const emitted = run([
    'emit', '--project', root,
    '--source', 'im',
    '--thread', 'team:dev',
    '--actor', 'alice',
    '--mention', 'super-agent',
    '--text', '@super-agent login is broken',
    '--json',
  ])
  const value = JSON.parse(emitted.output)
  assert.equal(value.ok, true)
  assert.match(value.id, /^evt_/)
  assert.match(value.threadId, /^thr_/)
  const inbox = readFileSync(join(root, '.dsh', 'super-agent', 'inbox.jsonl'), 'utf8')
  const event = JSON.parse(inbox.trim())
  assert.equal(event.id, value.id)
  assert.equal(event.source, 'im')
  assert.deepEqual(event.mentions, ['super-agent'])
})

test('status and recall read the journal without mutating it', () => {
  const root = project()
  run(['init', '--project', root])
  const dataDir = join(root, '.dsh', 'super-agent')
  const store = new Store({ dir: dataDir })
  store.open()
  store.append({
    t: 'trigger.received',
    trigger: {
      id: 'trg_1111111111',
      source: 'github',
      threadId: 'thr_2222222222',
      threadKey: 'pr:1',
      actor: 'alice',
      title: 'CI',
      summary: 'CI failed',
      text: 'CI failed on the login test',
      receivedAt: Date.now(),
      addressed: false,
      state: 'pending',
    },
  })
  store.close()

  const status = run(['status', '--project', root, '--json'])
  const snapshot = JSON.parse(status.output)
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.counts.pending, 1)
  assert.equal(snapshot.pending[0].id, 'trg_1111111111')

  const recalled = run(['recall', 'trg_1111111111', '--project', root, '--json'])
  const value = JSON.parse(recalled.output)
  assert.equal(value.kind, 'trigger')
  assert.match(value.object.text, /login test/)
})

test('outbox lists queued messages with channel filtering', () => {
  const root = project()
  run(['init', '--project', root])
  const dataDir = join(root, '.dsh', 'super-agent')
  mkdirSync(dataDir, { recursive: true })
  const store = new Store({ dir: dataDir })
  store.open()
  store.append({ t: 'reply.queued', reply: { id: 'rep_1', channel: 'im', text: 'hello', createdAt: Date.now() } })
  store.close()

  const all = JSON.parse(run(['outbox', '--project', root, '--json']).output)
  assert.equal(all.messages.length, 1)
  const none = JSON.parse(run(['outbox', '--project', root, '--channel', 'github', '--json']).output)
  assert.equal(none.messages.length, 0)
})

test('emit before init still queues into the default data dir and says it is disabled', () => {
  const root = project()
  const emitted = run(['emit', '--project', root, '--source', 'im', '--text', 'hello', '--json'])
  const value = JSON.parse(emitted.output)
  assert.equal(value.enabled, false)
  assert.ok(existsSync(join(root, '.dsh', 'super-agent', 'inbox.jsonl')))
})
