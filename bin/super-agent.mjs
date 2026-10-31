#!/usr/bin/env node
/**
 * super-agent CLI — 在宿主之外做四件事：
 *
 *   1. 开关项目（init / enable / disable）；
 *   2. 把外部事件追加进 `<dataDir>/inbox.jsonl`，由运行中的插件消费；
 *   3. 只读查看 journal 派生的状态与链式召回；
 *   4. 查看 outbox，供频道桥接器取走要发给人的消息。
 *
 * 它不直接改 journal，也不调用模型；插件停止时事件仍会排队，等下一次宿主启动。
 * 所有写入都是追加或单文件 JSON 覆盖，没有删除/清理逻辑。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONFIG_RELATIVE,
  DEFAULT_DATA_DIR,
  PLUGIN_ID,
  findProjectRoot,
  loadProjectConfig,
  mergeConfig,
} from '../lib/config.js'
import { eventId, threadId } from '../lib/ids.js'
import { recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { formatAge, isoTime, oneLine } from '../lib/text.js'

const HELP = `super-agent — dsh-super-agent 的项目 CLI

用法:
  node bin/super-agent.mjs <command> [options]

命令:
  init                         在当前项目写 .dsh/super-agent.json（默认开启）
  enable | disable             改项目配置的 enabled 字段，保留其他键
  emit                         追加一条外部事件到 inbox.jsonl
  status [--full]              只读查看触发器/线程/任务/outbox
  recall <id> [--max-chars N]  链式召回一个对象
  outbox [--channel C]         查看 outbox 里排队的消息
  config                       打印解析后的配置与数据根
  help                         本帮助

通用选项:
  --project <dir>              项目目录（默认当前目录；会向上找 .git）
  --json                       输出 JSON
  --data-dir <dir>             emit/init 时覆盖数据根

emit 选项:
  --source <name>              im / github / email / ci ...
  --text <text>                正文（必填；也可以从 stdin 读）
  --thread <key>               线程键（群 id、PR 号、邮件串 id）
  --actor <name>               作者
  --kind <name>                message / comment / ci / mail ...
  --title <text>               可选标题
  --url <url>                  可选链接
  --mention <name>             可重复；结构化点名
  --direct                     明确直接发给 Agent
  --external-id <id>           去重键（同一来源下唯一）

示例:
  node bin/super-agent.mjs init
  node bin/super-agent.mjs emit --source im --thread team:dev \\
    --actor alice --mention super-agent --text "@super-agent 登录页在 Safari 上白屏"
  node bin/super-agent.mjs status --full
  node bin/super-agent.mjs recall trg_1234567890
  node bin/super-agent.mjs outbox --channel im
`

/** 解析顺序参数与 --flag。 */
function parse(argv) {
  const positional = []
  const flags = {}
  const lists = { mention: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      flags.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    let key = body
    let value
    const eq = body.indexOf('=')
    if (eq >= 0) {
      key = body.slice(0, eq)
      value = body.slice(eq + 1)
    } else {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        index += 1
      } else {
        value = true
      }
    }
    if (key === 'mention') {
      lists.mention.push(String(value))
      continue
    }
    if (flags[key] !== undefined) {
      if (!Array.isArray(flags[key])) flags[key] = [flags[key]]
      flags[key].push(value)
    } else {
      flags[key] = value
    }
  }
  flags.mention = lists.mention
  return { positional, flags }
}

/** 项目根与配置。 */
function resolveProject(flags, { allowMissing = true } = {}) {
  const cwd = flags.project !== undefined ? resolve(String(flags.project)) : process.cwd()
  const projectRoot = findProjectRoot(cwd)
  const configPath = resolve(projectRoot, CONFIG_RELATIVE)
  if (!existsSync(configPath) && !allowMissing) {
    throw new Error(`project is not initialized: ${configPath} (run: super-agent init)`)
  }
  const gate = loadProjectConfig({ cwd: projectRoot, allowMissing: true })
  if (!existsSync(configPath)) {
    gate.enabled = false
    gate.reason = `项目未开启（缺少 ${configPath}）`
  }
  const dataDir = flags['data-dir'] !== undefined
    ? resolve(String(flags['data-dir']))
    : gate.dataDir ?? resolve(projectRoot, DEFAULT_DATA_DIR)
  return { projectRoot, configPath, gate, dataDir }
}

/** 写项目配置（覆盖单文件；不删任何东西）。 */
function writeProjectConfig(configPath, value) {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`)
}

/** 读项目配置；坏文件抛错（CLI 可以给出明确诊断）。 */
function readProjectConfig(configPath) {
  if (!existsSync(configPath)) return { version: 1, enabled: true }
  const value = JSON.parse(readFileSync(configPath, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`config root must be an object: ${configPath}`)
  }
  return value
}

/** 只读打开 store。 */
function openReadOnly(dataDir) {
  const store = new Store({ dir: dataDir, logger: { warn: (message) => process.stderr.write(`warn: ${message}\n`) } })
  store.open({ readonly: true })
  return store
}

/** 打印 JSON 或人类文本。 */
function emitOutput(value, flags, renderText) {
  if (flags.json === true) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${renderText(value)}\n`)
}

/** CLI 的 status 投影（不依赖 runtime/agent）。 */
function statusValue(env) {
  const { gate, dataDir, projectRoot, configPath } = env
  const exists = existsSync(dataDir)
  let store
  let stats = undefined
  let tasks = []
  let threads = []
  let pending = []
  let outbox = []
  if (exists) {
    store = openReadOnly(dataDir)
    stats = store.stats()
    tasks = store.listTasks().map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      threadIds: [...task.threadIds],
      workerSessionId: task.workerSessionId,
      lastReport: task.lastReport === undefined ? undefined : { reason: task.lastReport.reason, at: task.lastReport.at },
    }))
    threads = store.listThreads({ limit: 30 }).map((thread) => ({
      id: thread.id,
      source: thread.source,
      title: thread.title,
      triggerCount: thread.triggerIds.length,
      taskIds: [...thread.taskIds],
    }))
    pending = store.pendingTriggers(30).map((trigger) => ({
      id: trigger.id,
      source: trigger.source,
      threadId: trigger.threadId,
      addressed: trigger.addressed,
      age: trigger.receivedAt ? formatAge(Date.now() - trigger.receivedAt) : undefined,
      summary: trigger.summary,
    }))
    outbox = readOutboxLines(store.paths.outbox).slice(-20)
    store.close()
  }
  return {
    plugin: PLUGIN_ID,
    projectRoot,
    configPath,
    dataDir,
    enabled: gate.enabled,
    reason: gate.reason,
    config: gate.config ?? undefined,
    dataDirExists: exists,
    counts: stats,
    tasks,
    threads,
    pending,
    outbox,
  }
}

/** 读 outbox JSONL。 */
function readOutboxLines(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 坏行跳过；journal 仍是权威记录。
    }
  }
  return out
}

/**
 * 主流程。
 *
 * @param {string[]} argv 参数。
 */
export function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv)
  const command = positional[0] ?? 'help'
  if (command === 'help' || flags.help === true) {
    process.stdout.write(HELP)
    return 0
  }

  if (command === 'init') {
    const env = resolveProject(flags)
    if (existsSync(env.configPath) && flags.force !== true) {
      process.stdout.write(`already initialized: ${env.configPath}\n`)
      return 0
    }
    const existing = existsSync(env.configPath) ? readProjectConfig(env.configPath) : {}
    const value = mergeConfig({ version: 1, enabled: true }, existing)
    value.enabled = true
    if (flags['data-dir'] !== undefined) value.dataDir = String(flags['data-dir'])
    writeProjectConfig(env.configPath, value)
    process.stdout.write(`initialized ${env.configPath}\n`)
    process.stdout.write(`data dir: ${env.dataDir}\n`)
    return 0
  }

  if (command === 'enable' || command === 'disable') {
    const env = resolveProject(flags)
    const value = readProjectConfig(env.configPath)
    value.enabled = command === 'enable'
    if (value.version === undefined) value.version = 1
    writeProjectConfig(env.configPath, value)
    process.stdout.write(`${command}d ${env.configPath} (enabled=${value.enabled})\n`)
    return 0
  }

  if (command === 'emit') {
    const env = resolveProject(flags)
    const source = typeof flags.source === 'string' ? flags.source : 'im'
    const text = typeof flags.text === 'string'
      ? flags.text
      : readStdinIfPiped()
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('emit requires --text <text> (or piped stdin)')
    }
    const id = eventId()
    const threadKey = typeof flags.thread === 'string' ? flags.thread : undefined
    const event = {
      v: 1,
      id,
      at: new Date().toISOString(),
      receivedAt: Date.now(),
      source,
      threadKey,
      kind: typeof flags.kind === 'string' ? flags.kind : undefined,
      actor: typeof flags.actor === 'string' ? flags.actor : undefined,
      title: typeof flags.title === 'string' ? flags.title : undefined,
      text,
      url: typeof flags.url === 'string' ? flags.url : undefined,
      mentions: flags.mention.length > 0 ? flags.mention : undefined,
      direct: flags.direct === true,
      externalId: typeof flags['external-id'] === 'string' ? flags['external-id'] : undefined,
    }
    mkdirSync(env.dataDir, { recursive: true })
    const path = resolve(env.dataDir, 'inbox.jsonl')
    appendFileSync(path, `${JSON.stringify(event)}\n`)
    const tid = threadId(source, threadKey, id)
    const value = {
      ok: true,
      id,
      threadId: tid,
      source,
      inbox: path,
      enabled: env.gate.enabled,
      note: env.gate.enabled
        ? 'The running plugin will ingest this on its next inbox poll.'
        : `Project is not enabled (${env.gate.reason ?? 'no config'}); event is queued and will be consumed after enable + restart.`,
    }
    emitOutput(value, flags, (result) => [
      `queued ${result.id} on ${result.threadId} (${result.source})`,
      `inbox: ${result.inbox}`,
      `enabled: ${result.enabled}`,
      result.note,
    ].join('\n'))
    return 0
  }

  if (command === 'status') {
    const env = resolveProject(flags)
    const value = statusValue(env)
    emitOutput(value, flags, (snapshot) => {
      const lines = [
        `${snapshot.plugin} · ${snapshot.projectRoot}`,
        `config: ${snapshot.configPath} (${snapshot.enabled ? 'enabled' : `disabled: ${snapshot.reason ?? 'unknown'}`})`,
        `data: ${snapshot.dataDir}${snapshot.dataDirExists ? '' : ' (not created yet)'}`,
      ]
      if (snapshot.counts === undefined) {
        lines.push('no journal yet')
      } else {
        const counts = snapshot.counts
        lines.push(
          `triggers ${counts.triggers} (${counts.pending} pending, ${counts.filtered} filtered) · threads ${counts.threads} · batches ${counts.batches}`,
          `tasks: ${Object.entries(counts.tasks).filter(([, value]) => value > 0).map(([key, value]) => `${key}:${value}`).join(' ') || 'none'}`,
          `outbox: ${counts.replies} (${Object.entries(counts.repliesByChannel).map(([key, value]) => `${key}:${value}`).join(', ') || 'empty'})`,
        )
      }
      if (snapshot.pending.length > 0) {
        lines.push('', 'Pending:')
        for (const item of snapshot.pending) lines.push(`- ${item.id} [${item.source}] ${item.summary}`)
      }
      if (snapshot.tasks.length > 0) {
        lines.push('', 'Tasks:')
        for (const task of snapshot.tasks) lines.push(`- ${task.id} [${task.status}] ${task.title}`)
      }
      if (snapshot.threads.length > 0) {
        lines.push('', 'Threads:')
        for (const thread of snapshot.threads.slice(0, 15)) lines.push(`- ${thread.id} [${thread.source}] ${oneLine(thread.title)}`)
      }
      return lines.join('\n')
    })
    return 0
  }

  if (command === 'recall') {
    const target = positional[1]
    if (target === undefined) throw new Error('recall requires an object id')
    const env = resolveProject(flags)
    const store = openReadOnly(env.dataDir)
    try {
      const maxChars = flags['max-chars'] !== undefined ? Number(flags['max-chars']) : undefined
      const value = recall(store, target, Number.isFinite(maxChars) ? { maxChars } : {})
      emitOutput(value, flags, (result) => JSON.stringify(result, null, 2))
    } finally {
      store.close()
    }
    return 0
  }

  if (command === 'outbox') {
    const env = resolveProject(flags)
    const channel = typeof flags.channel === 'string' ? flags.channel : undefined
    const sinceRaw = typeof flags.since === 'string' ? flags.since : undefined
    const since = sinceRaw === undefined ? undefined : Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : Date.parse(sinceRaw)
    const limit = flags.limit !== undefined ? Math.max(1, Math.min(500, Number(flags.limit) || 50)) : 50
    const fileMessages = readOutboxLines(resolve(env.dataDir, 'outbox.jsonl'))
    let journalMessages = []
    if (existsSync(env.dataDir)) {
      const store = openReadOnly(env.dataDir)
      try {
        journalMessages = store.queuedReplies(500)
      } finally {
        store.close()
      }
    }
    const byId = new Map()
    for (const message of [...journalMessages, ...fileMessages]) {
      if (message?.id !== undefined) byId.set(message.id, message)
    }
    const messages = [...byId.values()]
      .filter((message) => channel === undefined || message.channel === channel)
      .filter((message) => since === undefined || message.createdAt >= since)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .slice(-limit)
    emitOutput({ ok: true, messages }, flags, (result) => {
      if (result.messages.length === 0) return 'outbox is empty'
      return result.messages.map((message) => [
        `${message.id} [${message.channel}]${message.threadId ? ` ${message.threadId}` : ''} · ${isoTime(message.createdAt) ?? '?'}`,
        message.text,
      ].join('\n')).join('\n---\n')
    })
    return 0
  }

  if (command === 'config') {
    const env = resolveProject(flags)
    const value = {
      projectRoot: env.projectRoot,
      configPath: env.configPath,
      dataDir: env.dataDir,
      enabled: env.gate.enabled,
      reason: env.gate.reason,
      config: env.gate.config,
      warnings: env.gate.warnings,
    }
    emitOutput(value, flags, (result) => JSON.stringify(result, null, 2))
    return 0
  }

  throw new Error(`unknown command: ${command}\n\n${HELP}`)
}

/** 管道输入（`echo ... | super-agent emit --source im`）。 */
function readStdinIfPiped() {
  if (process.stdin.isTTY) return undefined
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return undefined
  }
}

// 只有直接执行才跑 main；被测试 import 时不自动执行。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = main()
    process.exitCode = code
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = 1
  }
}
