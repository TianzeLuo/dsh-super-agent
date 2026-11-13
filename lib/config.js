/**
 * config.js — 项目级开关、默认配置与数据根的安全边界。
 *
 * 设计取舍：
 *
 * 1. **默认关闭。** 插件可以装进 profile，但只有项目里写了
 *    `<项目根>/.dsh/super-agent.json`（或 profile 配置明确 `enabled: true`）时，
 *    这个项目的根会话才会成为 Router。没有开启的项目既看不到工具，也不背任何
 *    系统提示词——和仓库里 `dsh-academic-search` / `dsh-autoresearch` 的做法一致。
 *
 * 2. **配置坏了不连坐。** 解析失败、路径非法、字段类型不对，一律返回
 *    `{ enabled: false, reason }`，由调用方记一条 warn。`agent/created` 的监听器
 *    抛错会让会话创建失败，这里绝不能抛。
 *
 * 3. **数据根不是删除目标。** 插件只往 `<dataDir>` 里追加 journal / inbox /
 *    outbox；从不清理、不镜像、不递归移动。状态目录可以放在项目里，也可以放在
 *    任意明确写出的绝对路径下，但拒绝盘符根、系统目录和账户的 `~/.dsh`。
 *
 * 4. **配置合并顺序**：默认值 → profile 行配置 → 项目配置。项目配置优先；
 *    profile 的 `enabled: false` 可以一票否决。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

import { APPROVAL_MODES, readApprovalMode } from './approval.js'

/** 插件 id：项目配置键、日志前缀、服务名。 */
export const PLUGIN_ID = 'super-agent'

/** 相对项目根的配置文件。 */
export const CONFIG_RELATIVE = join('.dsh', 'super-agent.json')

/** 相对项目根的默认数据目录。 */
export const DEFAULT_DATA_DIR = join('.dsh', 'super-agent')

/** 独立 super-agent workspace 的展示名。 */
export const SUPER_AGENT_WORKSPACE_TITLE = 'Super-agent Workspace'

/** 独立 workspace 的边界/识别标记；放在 workspace 根目录。 */
export const SUPER_AGENT_WORKSPACE_MARKER = '.dsh-super-agent-workspace'

/**
 * 独立 super-agent workspace 的默认目录。
 *
 * 这是 Router 根会话的宿主，不是用户项目。优先用 `DSH_SUPER_AGENT_HOME`；
 * 否则使用平台的应用数据目录（Linux XDG、macOS Application Support、
 * Windows LOCALAPPDATA）。绝不使用 `~/.dsh`：那里是 DSH 凭据/会话数据的家。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @param {NodeJS.Platform} [platform] 平台。
 * @param {string} [home] 用户主目录。
 * @returns {string} 绝对路径。
 */
export function defaultSuperAgentWorkspaceHome(env = process.env, platform = process.platform, home = homedir()) {
  const configured = typeof env?.DSH_SUPER_AGENT_HOME === 'string' ? env.DSH_SUPER_AGENT_HOME.trim() : ''
  if (configured.length > 0) return resolve(configured)
  if (platform === 'win32') {
    const base = typeof env?.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0
      ? env.LOCALAPPDATA
      : join(home, 'AppData', 'Local')
    return join(base, 'dsh-super-agent', 'workspace')
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'dsh-super-agent', 'workspace')
  const base = typeof env?.XDG_DATA_HOME === 'string' && isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : join(home, '.local', 'share')
  return join(base, 'dsh-super-agent', 'workspace')
}

/**
 * 判断一个路径是否就是独立的 super-agent workspace。
 *
 * 先比较显式 home，再检查标记文件；后者让 `DSH_SUPER_AGENT_HOME` 改变后，
 * 旧 workspace 仍然不会被 `superagent_projects` 当成用户项目。
 */
export function isSuperAgentWorkspace(path, home) {
  if (typeof path !== 'string' || path.length === 0) return false
  const resolved = resolve(path)
  if (typeof home === 'string' && home.length > 0 && resolved === resolve(home)) return true
  try {
    return statSync(join(resolved, SUPER_AGENT_WORKSPACE_MARKER)).isFile()
  } catch {
    return false
  }
}

/** 合入项目配置之前的默认值。 */
export const DEFAULTS = Object.freeze({
  version: 1,
  // 文件存在时默认开启；文件不存在时由 loadProjectConfig 另外决定。
  enabled: true,

  // 数据根：相对项目根，或绝对路径。journal/inbox/outbox 都在这里。
  dataDir: DEFAULT_DATA_DIR,

  // 哪些来源被视为“明确点名”。实际判定见 filter.js。
  agents: ['super-agent', 'superagent', 'super agent', '助手'],

  // 程序层快路径（Fast Path）的默认策略。
  sources: {
    im: {
      mode: 'addressed',
      requireMention: true,
      actorsDeny: [],
      ignorePatterns: [],
      maxTextChars: 8000,
    },
    github: {
      mode: 'candidate',
      requireMention: false,
      actorsDeny: [],
      ignorePatterns: [],
      maxTextChars: 8000,
    },
    email: {
      mode: 'candidate',
      requireMention: false,
      actorsDeny: [],
      ignorePatterns: [],
      maxTextChars: 8000,
    },
    ci: {
      mode: 'candidate',
      requireMention: false,
      actorsDeny: [],
      ignorePatterns: [],
      maxTextChars: 8000,
    },
    // 插件自己产生的 worker 报告与 watchdog 事件；内部事件不过滤。
    worker: { mode: 'candidate', requireMention: false },
    watchdog: { mode: 'candidate', requireMention: false },
  },

  // 未列出的来源套用这一组。
  defaultSource: {
    mode: 'addressed',
    requireMention: false,
    actorsDeny: [],
    ignorePatterns: [],
    maxTextChars: 8000,
  },

  // 全局忽略的 actor（支持末尾 `*` 通配）。
  ignoreActors: [],

  // 落盘前脱敏常见凭据形态；事件正文仍视为不可信输入。
  redact: true,

  // false 时只保存摘要，不保存全文（recall 只能拿到摘要）。
  storeFullText: true,

  // Worker 可调用的模型子集。allowed 为空时退回宿主完整目录（开箱可用）。
  // 每条：{ id?, label?, provider, model, efforts?: string[], defaultEffort?, note? }
  models: {
    allowed: [],
    // 用户保存的默认勾选集合：allowed 为空时作为可调用模型集合，新建实例也用它。
    // 每项 { provider, model, id?, label?, efforts?, defaultEffort? }。
    defaults: [],
    default: '',
    defaultEffort: '',
    // 可选的来源过滤：allowlist 为空时，只把指定 provider / 显示名暴露给 Router。
    onlyProvider: '',
    onlyNames: [],
  },

  // 长期工作约定：跨 generation 的配置文件，不随 Reset 丢失。
  agreements: {
    fileName: 'super-agent.agreements.json',
    maxItems: 40,
    maxCharsPerItem: 2_000,
    injectChars: 6_000,
  },

  // 定时任务：使用宿主 ctx.schedule（dsh-schedule）；到点向 Router 投递唤醒提示。
  schedule: {
    maxActive: 20,
    timeZone: '',
    frame: true,
  },

  // 回复风格。Router 面向人说话时的默认克制程度。
  voice: {
    // 'brief' 默认先给结论；'balanced' 允许一段解释；'detailed' 允许分点。
    style: 'brief',
    // 简短回复的建议上限（CJK 按字计，拉丁按词计）；0 表示不限制。
    maxWords: 120,
    // 用户明确要求详细时，是否允许突破上面的上限。
    expandWhenAsked: true,
  },

  router: {
    // 一次唤醒最多合并多少条 Trigger。
    maxBatch: 24,
    // Trigger 到达后等一小段再唤醒，让同一波事件合并。
    batchDebounceMs: 200,
    // 一次批次消息的字符预算；超出部分留在 pending，下一批再送。
    maxBatchChars: 12000,
    // 每条 Trigger 内联到批次里的摘要长度。
    inlineChars: 280,
    // Router 会话 id 固定值；留空表示“本项目第一个根会话”。
    sessionId: '',
    // true 时在 Router 上禁用执行类工具，从机制上保证“只分派、不亲自做”。
    guardExecutionTools: true,
    guardTools: [
      'bash',
      'pwsh',
      'run_code',
      'write',
      'edit',
      'str_replace_editor',
    ],
  },

  // 审批策略：本版本只记录到任务，所有请求仍转人工；策略 answerer 是 B 阶段预留。
  approval: {
    // ask | auto-workspace | deny-all（见 lib/approval.js）。
    mode: 'ask',
  },

  worker: {
    // ctx.subagents 上的 provider 名；DSH 默认的 spawn provider 是 `spawn`。
    spawnProvider: 'spawn',
    // 同时驻留的 worker 上限；超出时任务进入 queued。
    maxWorkers: 4,
    // 单条 worker 报告注入 Router 的字符上限。
    maxReportChars: 4000,
    // 新 worker 的默认工作目录；留空则用项目根。
    defaultCwd: '',
    // 初始任务提示里附带的 Thread 上下文预算。
    initialContextChars: 12000,
    // 直接路由给 worker 的单条事件字符上限。
    routeTextChars: 8000,
    // dispatch/steer 附件的复制上限（见 lib/attachments.js）。
    attachments: {
      maxFiles: 8,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 30 * 1024 * 1024,
    },
  },

  watchdog: {
    enabled: true,
    // 外部 Control Loop 的节拍。
    intervalMs: 30_000,
    // 任务等待人工审批超过这个时间就升级给 Router（只提醒，不自动回答）。
    approvalTimeoutMs: 60_000,
    // pending Trigger 超过这个年龄且 Router 空闲 → 认为唤醒链路卡住。
    pendingStaleMs: 90_000,
    // starting 任务超过这个时间没有 worker → 报错并修复。
    startTimeoutMs: 120_000,
    // working/blocked-approval 首次查不到 worker 后，至少等这么久（并在下一次
    // 检查时二次探测）才落 lost；避免启动收尾/宿主换实例时误杀。
    lostGraceMs: 10_000,
    // working 任务但 worker 已 idle 且没有报告 → 补一条报告。
    idleStaleMs: 300_000,
    // 同一个问题在这段时间内不重复升级。
    repeatMs: 600_000,
  },

  // 面向人的信道：字数上限与提示词片段。0 表示不限。
  channels: {
    im: {
      maxWords: 100,
      guidance: 'One decision or result per message. No tool detail, no reasoning, no bullet list longer than three lines.',
    },
    github: {
      maxWords: 600,
      guidance: 'Structured and asynchronous: context, what changed, how it was verified, remaining risk.',
    },
    email: {
      maxWords: 500,
      guidance: 'Complete sentences, explicit ask, no internal jargon.',
    },
    router: {
      maxWords: 0,
      guidance: 'Human-facing output only; the Router speaks for the whole agent.',
    },
  },

  inbox: {
    fileName: 'inbox.jsonl',
    pollMs: 400,
  },

  outbox: {
    fileName: 'outbox.jsonl',
  },
})

/** 简单的深合并：对象递归，数组与标量整体替换。 */
export function mergeConfig(...layers) {
  const out = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value)
      else out[key] = clone(value)
    }
  }
  return out
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clone(item)
    return out
  }
  return value
}

/**
 * 从会话工作目录向上找项目根：最近的含 `.git` 的祖先；没有则用工作目录本身。
 *
 * 与 `dsh-skill-filesystem` / `dsh-academic-search` 同一条规则：`.git` 可以是
 * 目录，也可以是 worktree 的文件。
 *
 * @param {string} cwd 会话工作目录。
 * @returns {string} 绝对项目根。
 */
export function findProjectRoot(cwd) {
  const start = resolve(cwd)
  let current = start
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, SUPER_AGENT_WORKSPACE_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * 数据根安全边界。
 *
 * 只做“拒绝明显危险的位置”，不试图枚举所有敏感目录。规则：
 *   - 必须是绝对路径；
 *   - 不能是盘符根 / `/`；
 *   - 不能落在账户目录 `~/.dsh` 下（那是 DSH 凭据与会话数据的家）；
 *   - 不能是系统目录本身或其子目录（`/etc`、`/usr`、`C:\Windows` 等）。
 *
 * @param {string} dataDir 候选数据根。
 * @returns {string | undefined} 不可用时的原因。
 */
export function checkDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return '数据根为空'
  if (dataDir.startsWith('~')) return `数据根不能使用 ~ 展开：${dataDir}`
  if (!isAbsolute(dataDir)) return `数据根不是绝对路径：${dataDir}`

  const resolved = resolve(dataDir)
  // 从解析后的路径取根；Windows 上直接把 '/' 交给 parse() 会得到 '\\'，
  // 与 resolve('/') 的盘符根不一致，会绕过“文件系统根”检查。
  const root = parse(resolved).root
  if (resolved === root) return `数据根不能是文件系统根：${resolved}`

  const windows = process.platform === 'win32'
  const key = (value) => windows ? value.toLowerCase() : value
  const accountDsh = join(homedir(), '.dsh')
  if (key(resolved) === key(accountDsh) || key(resolved).startsWith(key(accountDsh) + sep)) {
    return `数据根不能落在账户目录 ~/.dsh 下：${resolved}`
  }

  // 不能整棵拒绝 C:\Users：Windows 的默认数据根就在
  // %LOCALAPPDATA%\dsh-super-agent\workspace 下。账户自己的 ~/.dsh 已在上方
  // 单独保护；这里只保留真正的系统目录。
  const forbidden = windows
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/mnt/c/Windows', '/mnt/c/Program Files', '/mnt/c/Program Files (x86)', '/mnt/c/ProgramData', '/mnt/c/Users']
  for (const prefix of forbidden) {
    if (key(resolved) === key(prefix) || key(resolved).startsWith(key(prefix) + sep)) {
      return `数据根不能落在系统目录下：${resolved}`
    }
  }
  return undefined
}

/**
 * 读取项目配置并完成合并/校验。永不抛错。
 *
 * @param {{
 *   cwd: string | undefined,
 *   pluginConfig?: object,
 *   env?: NodeJS.ProcessEnv,
 *   allowMissing?: boolean,
 * }} options 输入。
 * @returns {{
 *   enabled: boolean,
 *   reason?: string,
 *   warnings: string[],
 *   projectRoot?: string,
 *   configPath?: string,
 *   dataDir?: string,
 *   config?: object,
 * }}
 */
export function loadProjectConfig(options) {
  const warnings = []
  const cwd = options?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
    return { enabled: false, reason: '会话没有可用的工作目录', warnings }
  }

  const projectRoot = findProjectRoot(cwd)
  const configPath = join(projectRoot, CONFIG_RELATIVE)
  const pluginConfig = isPlainObject(options.pluginConfig) ? options.pluginConfig : {}
  const env = options.env ?? process.env

  let fileConfig
  let fileExists = false
  try {
    if (existsSync(configPath)) {
      const stat = statSync(configPath)
      if (!stat.isFile()) return { enabled: false, reason: `配置路径不是文件：${configPath}`, warnings }
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      if (!isPlainObject(fileConfig)) return { enabled: false, reason: `配置根必须是对象：${configPath}`, warnings }
      fileExists = true
    }
  } catch (error) {
    return { enabled: false, reason: `配置读取失败：${error.message}`, warnings }
  }

  const envEnabled = env?.DSH_SUPER_AGENT_ENABLED === '1'
  const defaultDataDir = resolve(projectRoot, pluginConfig.dataDir ?? DEFAULT_DATA_DIR)
  if (!fileExists && pluginConfig.enabled !== true && !envEnabled && options.allowMissing !== true) {
    return {
      enabled: false,
      reason: `项目未开启（缺少 ${configPath}）`,
      warnings,
      projectRoot,
      configPath,
      dataDir: defaultDataDir,
    }
  }

  const merged = mergeConfig(DEFAULTS, pluginConfig, fileConfig)
  if (pluginConfig.enabled === false) {
    return {
      enabled: false,
      reason: 'profile 配置显式关闭了 super-agent',
      warnings,
      projectRoot,
      configPath,
      dataDir: defaultDataDir,
    }
  }
  if (!fileExists && envEnabled) merged.enabled = true
  if (merged.enabled === false) {
    return {
      enabled: false,
      reason: '项目配置里 enabled=false',
      warnings,
      projectRoot,
      configPath,
      dataDir: defaultDataDir,
    }
  }

  validateConfig(merged, warnings)

  const rawDataDir = typeof merged.dataDir === 'string' && merged.dataDir.length > 0 ? merged.dataDir : DEFAULT_DATA_DIR
  const dataDir = isAbsolute(rawDataDir) ? resolve(rawDataDir) : resolve(projectRoot, rawDataDir)
  const problem = checkDataDir(dataDir)
  if (problem !== undefined) {
    return { enabled: false, reason: problem, warnings, projectRoot, configPath, dataDir }
  }

  return {
    enabled: true,
    warnings,
    projectRoot,
    configPath,
    dataDir,
    config: merged,
  }
}

/** 把字段问题收集成 warnings；不在运行期抛错。 */
function validateConfig(config, warnings) {
  for (const key of ['router', 'worker', 'watchdog']) {
    if (!isPlainObject(config[key])) {
      warnings.push(`${key} 必须是对象，已回退默认值`)
      config[key] = clone(DEFAULTS[key])
    }
  }
  const modes = new Set(['addressed', 'candidate', 'ignore'])
  for (const [name, source] of Object.entries({ ...config.sources, default: config.defaultSource })) {
    if (!isPlainObject(source)) {
      warnings.push(`sources.${name} 不是对象，已忽略`)
      continue
    }
    if (source.mode !== undefined && !modes.has(source.mode)) {
      warnings.push(`sources.${name}.mode 未知：${String(source.mode)}（会按 addressed 处理）`)
    }
    for (const pattern of source.ignorePatterns ?? []) {
      if (typeof pattern !== 'string') {
        warnings.push(`sources.${name}.ignorePatterns 含非字符串项，已忽略`)
        continue
      }
      try {
        new RegExp(pattern)
      } catch {
        warnings.push(`sources.${name}.ignorePatterns 正则无效：${pattern}`)
      }
    }
  }
  for (const key of ['maxBatch', 'batchDebounceMs', 'maxBatchChars', 'inlineChars']) {
    const min = key === 'maxBatch' ? 1 : 0
    if (!Number.isFinite(config.router[key]) || config.router[key] < min) {
      warnings.push(`router.${key} 不是非负数，已回退默认值`)
      config.router[key] = DEFAULTS.router[key]
    }
  }
  if (!Number.isFinite(config.worker.maxWorkers) || config.worker.maxWorkers < 1) {
    warnings.push('worker.maxWorkers 必须是正整数，已回退默认值')
    config.worker.maxWorkers = DEFAULTS.worker.maxWorkers
  }
  if (!Number.isFinite(config.watchdog.intervalMs) || config.watchdog.intervalMs < 1000) {
    warnings.push('watchdog.intervalMs 必须 >= 1000，已回退默认值')
    config.watchdog.intervalMs = DEFAULTS.watchdog.intervalMs
  }
  if (!Number.isFinite(config.watchdog.approvalTimeoutMs) || config.watchdog.approvalTimeoutMs < 1000) {
    warnings.push('watchdog.approvalTimeoutMs 必须 >= 1000，已回退默认值')
    config.watchdog.approvalTimeoutMs = DEFAULTS.watchdog.approvalTimeoutMs
  }
  if (!Number.isFinite(config.watchdog.lostGraceMs) || config.watchdog.lostGraceMs < 0) {
    warnings.push('watchdog.lostGraceMs 必须是非负数，已回退默认值')
    config.watchdog.lostGraceMs = DEFAULTS.watchdog.lostGraceMs
  }
  if (!isPlainObject(config.approval)) {
    warnings.push('approval 必须是对象，已回退默认值')
    config.approval = clone(DEFAULTS.approval)
  }
  if (readApprovalMode(config.approval.mode) === undefined) {
    warnings.push(`approval.mode 未知：${String(config.approval.mode)}；可用值为 ${APPROVAL_MODES.join(', ')}，已回退 ask`)
    config.approval.mode = DEFAULTS.approval.mode
  }

  if (!isPlainObject(config.models)) {
    warnings.push('models 必须是对象，已回退默认值')
    config.models = clone(DEFAULTS.models)
  }
  if (!Array.isArray(config.models.allowed)) {
    warnings.push('models.allowed 必须是数组，已回退为空（允许全部目录模型）')
    config.models.allowed = []
  } else {
    config.models.allowed = config.models.allowed.filter((entry, index) => {
      if (!isPlainObject(entry)) {
        warnings.push(`models.allowed[${index}] 不是对象，已忽略`)
        return false
      }
      if (typeof entry.provider !== 'string' || entry.provider.trim().length === 0
        || typeof entry.model !== 'string' || entry.model.trim().length === 0) {
        warnings.push(`models.allowed[${index}] 缺少 provider/model，已忽略`)
        return false
      }
      if (entry.efforts !== undefined && !Array.isArray(entry.efforts)) {
        warnings.push(`models.allowed[${index}].efforts 必须是数组，已忽略该限制`)
        entry.efforts = undefined
      }
      return true
    })
  }
  if (typeof config.models.defaultEffort !== 'string') {
    warnings.push('models.defaultEffort 必须是字符串，已忽略')
    config.models.defaultEffort = ''
  } else {
    config.models.defaultEffort = config.models.defaultEffort.trim()
  }
  if (typeof config.models.default !== 'string') {
    warnings.push('models.default 必须是字符串，已回退为空')
    config.models.default = ''
  }
  if (typeof config.models.onlyProvider !== 'string') {
    warnings.push('models.onlyProvider 必须是字符串，已忽略')
    config.models.onlyProvider = ''
  } else {
    config.models.onlyProvider = config.models.onlyProvider.trim()
  }
  if (!Array.isArray(config.models.onlyNames)) {
    warnings.push('models.onlyNames 必须是数组，已忽略')
    config.models.onlyNames = []
  } else {
    config.models.onlyNames = config.models.onlyNames
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .map((name) => name.trim())
  }

  if (!isPlainObject(config.agreements)) {
    warnings.push('agreements 必须是对象，已回退默认值')
    config.agreements = clone(DEFAULTS.agreements)
  }
  if (typeof config.agreements.fileName !== 'string' || config.agreements.fileName.includes('/') || config.agreements.fileName.includes('\\')) {
    warnings.push('agreements.fileName 必须是单段文件名，已回退默认值')
    config.agreements.fileName = DEFAULTS.agreements.fileName
  }
  for (const key of ['maxItems', 'maxCharsPerItem', 'injectChars']) {
    const value = config.agreements[key]
    if (!Number.isFinite(value) || value < (key === 'maxItems' ? 1 : 0)) {
      warnings.push(`agreements.${key} 不是有效数字，已回退默认值`)
      config.agreements[key] = DEFAULTS.agreements[key]
    }
  }

  if (!isPlainObject(config.schedule)) {
    warnings.push('schedule 必须是对象，已回退默认值')
    config.schedule = clone(DEFAULTS.schedule)
  }
  if (!Number.isFinite(config.schedule.maxActive) || config.schedule.maxActive < 1) {
    warnings.push('schedule.maxActive 必须是正整数，已回退默认值')
    config.schedule.maxActive = DEFAULTS.schedule.maxActive
  }

  if (!isPlainObject(config.voice)) {
    warnings.push('voice 必须是对象，已回退默认值')
    config.voice = clone(DEFAULTS.voice)
  }
  if (!['brief', 'balanced', 'detailed'].includes(config.voice.style)) {
    warnings.push(`voice.style 未知：${String(config.voice.style)}（按 brief 处理）`)
    config.voice.style = 'brief'
  }
  if (!Number.isFinite(config.voice.maxWords) || config.voice.maxWords < 0) {
    warnings.push('voice.maxWords 必须是非负数，已回退默认值')
    config.voice.maxWords = DEFAULTS.voice.maxWords
  }
  config.voice.expandWhenAsked = config.voice.expandWhenAsked !== false
}

/**
 * 取某个信道的样式配置；未知信道按 router 的宽松设置。
 *
 * @param {object} config 合并后的配置。
 * @param {string} channel 信道名。
 * @returns {{ maxWords: number, guidance: string }}
 */
export function channelConfig(config, channel) {
  const entry = config?.channels?.[channel]
  const fallback = config?.channels?.router ?? DEFAULTS.channels.router
  const maxWords = typeof entry?.maxWords === 'number' && Number.isFinite(entry.maxWords)
    ? Math.max(0, entry.maxWords)
    : fallback.maxWords
  return {
    maxWords,
    guidance: typeof entry?.guidance === 'string' ? entry.guidance : fallback.guidance,
  }
}

/**
 * 取某个来源的过滤策略；未知来源用 defaultSource。
 *
 * @param {object} config 合并后的配置。
 * @param {string} source 来源名。
 * @returns {object} 策略。
 */
export function sourcePolicy(config, source) {
  const entry = config?.sources?.[source]
  const base = config?.defaultSource ?? DEFAULTS.defaultSource
  if (!isPlainObject(entry)) return { ...base }
  return { ...base, ...entry }
}
