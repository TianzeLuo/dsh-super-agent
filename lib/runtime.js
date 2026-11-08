/**
 * runtime.js — Router/Worker 双层架构的运行时。
 *
 * 文章 §2–§6 的控制面都在这里：
 *
 *   - **双层**：Router 是宿主里这条根会话；Worker 是 `ctx.subagents` 起的隔离
 *     子会话。Worker 不直接面对人，结束时由 runtime 生成一条 `worker-report`
 *     Trigger 回到 Router。
 *   - **批处理**（§2.1）：Trigger 先进入 pending；Router 忙时继续积压，等
 *     `agent/status = idle` 后把积压合并成一条消息注入。单次唤醒的 trigger 数
 *     与字符数都有上限，剩下的留在下一批。
 *   - **事件驱动**（§3）：Trigger 有去重键、Thread 归属、订阅直通；已订阅的
 *     Thread 后续事件由程序直接 `followup` 给 Worker，不经过 Router。
 *   - **上下文组织**（§3.3）：批次只内联 id/actor/摘要；全文留在 journal，
 *     `superagent_recall` 沿引用图逐跳展开。
 *   - **异步 ReAct**（§4.1）：dispatch / steer / close 都立即返回，Worker 的
 *     结果以后续 Trigger 的形式到达。
 *   - **持久与自愈**（§5、§6）：状态在 journal；Watchdog 定期检查丢失/卡住的
 *     Worker，自动修复可确定的状态，并只在需要 Router 决策时升级。
 *
 * 运行时故意不依赖任何 `@deepseek-ai/*` 包：本包以 link 方式装进 profile 时，
 * 裸导入解析不到 profile 的 node_modules（见 dsh-academic-search 的说明）。
 * 对宿主只要求一个很小的结构契约：
 *
 *   agent: { id, status, ctx, session.header.cwd, followup(message) }
 *   subagents: { getProvider(name), startActivation(spec) }
 *   sessionWorkers?: { create(spec) -> activation }   # 跨项目普通 Session
 *   projects?: () => Array<{ id, title, path }>        # 宿主项目清单
 *   getAgent(id): Agent | undefined
 *
 * 这些对象由 index.js 从真实 DSH 服务里取；测试用同样的形状做假宿主。
 */

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { AttachmentError, renderAttachmentNote, stageAttachments } from './attachments.js'
import {
  agreementId,
  batchId as newBatchId,
  eventId,
  objectiveId as newObjectiveId,
  reportId as newReportId,
  replyId as newReplyId,
  taskId as newTaskId,
  taskThreadId,
  threadId as deriveThreadId,
  triggerId as newTriggerId,
  workerSessionId,
} from './ids.js'
import {
  agreementStorePath,
  agreementTitle,
  agreementView,
  agreementsForProject,
  agreementsMtime,
  normalizeAgreementText,
  readAgreements,
  renderAgreements,
  writeAgreements,
} from './agreements.js'
import { approvalModeFor, describeApprovalRequest, normalizeApprovalMode, suggestApproval } from './approval.js'
import { channelConfig, sourcePolicy } from './config.js'
import { filterEvent } from './filter.js'
import {
  ObjectiveInputError,
  adoptHostGoal,
  appendMilestones,
  cadenceFromSelectors,
  completeMilestones,
  createObjectiveRecord,
  milestoneProgress,
  nextCheckAt,
  normalizeCadence,
  normalizeCheck,
  normalizeMilestones,
  objectiveSummaryLine,
  scheduleSelector,
  toObjectiveView,
} from './objectives.js'
import { findModel, modelSummary, modelViewPayload, normalizeModelConfig, resolveModelSelection } from './models.js'
import { recall } from './recall.js'
import {
  INTERRUPTED,
  RESUMABLE,
  hasWorkerSession,
  interruptedPatch,
  isRunningState,
  planRecovery,
  recoveryText,
  resumedPatch,
} from './recovery.js'
import { inlineTrigger, renderBatch, renderStatus, renderWorkerEvent, renderWorkerTask } from './render.js'
import { clip, formatAge, isRecord, oneLine, redactSecrets, summaryOf, wordCount } from './text.js'

/** 工具/调度层可安全展示给模型的输入错误。 */
export class RuntimeInputError extends Error {
  /**
   * @param {string} message 修正导向的说明。
   * @param {string} [code] 稳定错误码。
   */
  constructor(message, code = 'invalid_input') {
    super(message)
    this.name = 'RuntimeInputError'
    this.code = code
  }
}

/** 线程直通时优先选择当前活动任务，而不是同 Worker 的旧 idle 任务。 */
function taskPriority(task) {
  if (task.status === 'starting') return 0
  if (task.status === 'working' || task.status === 'blocked-approval') return 1
  if (task.status === 'idle' || task.status === 'blocked' || task.status === RESUMABLE) return 2
  return 3
}

/** 生成一条 DSH user 消息；不依赖 dsh-llm 的构造函数。 */
export function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(text) })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** 从 assistant/message 的内容块里取出文本。 */
function assistantText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** TurnEndReason → 任务状态/报告 reason。 */
function normalizeReason(kind) {
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
      return 'max-tokens'
    case 'interrupted':
      return 'interrupted'
    default:
      return typeof kind === 'string' ? kind : 'error'
  }
}

/** 读取对象上的非空字符串字段。 */
function readRecordString(object, key) {
  const value = object?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 审批摘要只需要的 tool 参数键；不缓存 write 的 content 或整段脚本。 */
const APPROVAL_ARGUMENT_KEYS = new Set([
  'command', 'cmd', 'command_line', 'commandLine', 'script', 'code',
  'path', 'file_path', 'filePath', 'notebook_path', 'target', 'destination', 'source', 'cwd', 'dir', 'directory',
])

/**
 * 把 tool/call 的参数裁成审批摘要需要的字段，内存有界。`write` 的 content、
 * 整段大脚本等不进缓存，避免长任务把 200 条调用参数留在内存里。
 *
 * @param {unknown} value 原始参数（字符串或对象）。
 * @returns {object | undefined}
 */
function pruneToolArguments(value) {
  let object = value
  if (typeof value === 'string') {
    const text = value.length > 20_000 ? value.slice(0, 20_000) : value
    try {
      object = JSON.parse(text)
    } catch {
      return undefined
    }
  }
  if (!isRecord(object)) return undefined
  const pruned = {}
  let kept = 0
  for (const [key, raw] of Object.entries(object)) {
    if (!APPROVAL_ARGUMENT_KEYS.has(key)) continue
    if (typeof raw === 'string') {
      pruned[key] = clip(redactSecrets(raw), 2_000)
      kept += 1
    } else if (Array.isArray(raw)) {
      const values = raw
        .filter((item) => typeof item === 'string' && item.length > 0)
        .slice(0, 8)
        .map((item) => clip(redactSecrets(item), 500))
      if (values.length > 0) {
        pruned[key] = values
        kept += 1
      }
    }
    if (kept >= 12) break
  }
  return kept === 0 ? undefined : pruned
}

/** 只保留 JSON 安全、体量可控的 meta。 */
function safeMeta(meta) {
  if (!isRecord(meta)) return undefined
  try {
    const text = JSON.stringify(meta)
    if (text.length > 2000) return { truncated: true, preview: text.slice(0, 1800) }
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 读文件的一部分，返回字节；文件不存在/读失败返回 undefined。 */
function readSlice(path, offset, length) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, read)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 读失败已经返回 undefined。
      }
    }
  }
}

/**
 * 单项目运行时。一个 dataDir 在一个宿主进程里只应有一个实例；claim 由 index.js 做。
 */
export class SuperAgentRuntime {
  /**
   * @param {{
   *   agent: object,
   *   store: import('./store.js').Store,
   *   config: object,
   *   projectRoot: string,
   *   dataDir: string,
   *   subagents?: object,
   *   getAgent: (id: string) => object | undefined,
   *   models?: { catalog: (force?: boolean) => Promise<object>, defaultSelection: () => object | undefined, selectSession: (sessionId: string, selection: object) => Promise<void> },
   *   schedule?: { create: Function, list: Function, cancel: Function, history?: Function },
   *   agreementsPath?: string,
   *   logger?: object,
   *   now?: () => number,
   *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
   * }} options
   */
  constructor(options) {
    this.agent = options.agent
    this.store = options.store
    this.config = options.config
    this.projectRoot = options.projectRoot
    this.dataDir = options.dataDir
    this.subagents = options.subagents
    this.models = options.models
    this.schedule = options.schedule
    this.agreementsPath = options.agreementsPath ?? agreementStorePath(this.projectRoot, this.config?.agreements?.fileName)
    /** @type {object[]} 当前载入的长期约定。 */
    this.agreementItems = []
    this.agreementMtime = 0
    this.agreementWarnings = []
    /** 同步默认视图：模型目录还没加载时也能校验配置里的 allowlist。 */
    this.modelViewCache = normalizeModelConfig(this.config, {
      catalog: { groups: [], failures: [] },
      defaultSelection: this.#defaultSelection(),
    })
    this.lastScheduleSummary = ''
    this.lastSchedules = []
    this.scheduleLoadedAt = 0
    this.lastAgreementError = undefined
    /**
     * 可选：跨项目 Worker 走普通 Session（header.cwd = 目标项目），因为 DSH
     * subagent 的 header.cwd 固定为父会话，fs sandbox 的 workspace-write 根不会
     * 跟着 request.cwd 走。接口：
     *   create({ cwd, taskId, title, signal }) -> { childId, agent, start(), dispose() }
     */
    this.sessionWorkers = options.sessionWorkers
    /**
     * 可选：宿主 workspace 清单。Router 通过 superagent_projects 自主选择目标，
     * UI 不再要求用户先手选一个“目标项目”。
     */
    this.projectsSource = typeof options.projects === 'function' ? options.projects : () => []
    this.getAgent = options.getAgent ?? (() => undefined)
    /**
     * 可选：宿主侧的会话恢复能力（DSH 的 `sessionController.resolveAgent`）。
     * 进程重启后 Worker 会话只存在于磁盘上，必须由宿主把它重新装回内存；
     * 没有这个桥就退化成「一律 interrupted」。
     *
     *   resumeWorker(sessionId) -> Promise<Agent | undefined>
     */
    this.resumeWorker = typeof options.resumeWorker === 'function' ? options.resumeWorker : undefined
    this.logger = options.logger ?? {}
    this.now = options.now ?? Date.now
    const timers = options.timers ?? {}
    this.timers = {
      setTimeout: timers.setTimeout ?? setTimeout,
      clearTimeout: timers.clearTimeout ?? clearTimeout,
      setInterval: timers.setInterval ?? setInterval,
      clearInterval: timers.clearInterval ?? clearInterval,
    }

    this.active = false
    /** 重启恢复进行中：这段时间 watchdog 不参与判定，避免把正在恢复的会话判 lost。 */
    this.restoring = false
    this.startedAt = this.now()
    /** @type {Map<string, object>} taskId → activation */
    this.activations = new Map()
    /** @type {Map<string, AbortController>} taskId → controller */
    this.controllers = new Map()
    /** @type {Map<string, { taskId: string, disposers: Function[], lastError?: string }>} childId → state */
    this.children = new Map()
    /** 最近一条 assistant 文本；root 级 session/event 观察也写这里。 */
    this.childText = new Map()
    /** tool/call 缓存：`<sessionId>\u0000<callId>` → { name, arguments, at }，供审批摘要使用。 */
    this.toolCalls = new Map()
    /** @type {Map<string, number>} issue key → last escalation time */
    this.reportedIssues = new Map()
    /**
     * taskId → 首次发现 Worker 不在的 watch time。
     * Worker 刚创建或宿主短暂换实例时 getAgent 可能瞬间查不到；一次探测就判 lost
     * 会把正在启动/短暂迁移的会话杀掉。宽限期过后仍查不到才落 lost。
     * @type {Map<string, number>}
     */
    this.missingWorkers = new Map()
    this.lastIssues = []
    this.lastCheckAt = undefined
    this.lastError = undefined
    this.flushTimer = undefined
    this.watchdogTimer = undefined
    this.inboxTimer = undefined
    this.inboxOffset = 0
    this.inboxRemainder = Buffer.alloc(0)
    this.pumping = false
    this.routerDisposers = []
    this.batchCount = 0
    this.dispatchCount = 0
    /** 兼容旧版 focus；新 dispatch 应显式给 project。 */
    this.focusProject = undefined
    this.closed = false
  }

  /** 日志。 */
  log(level, message, detail) {
    const fn = this.logger?.[level] ?? this.logger?.info
    try {
      fn?.(`[super-agent] ${message}`, detail)
    } catch {
      // 日志失败不影响调度。
    }
  }

  /** 宿主默认模型；桥缺失或抛错时返回 undefined。 */
  #defaultSelection() {
    try {
      return this.models?.defaultSelection?.()
    } catch {
      return undefined
    }
  }

  /**
   * 刷新宿主模型目录并重建 allowlist 视图。失败只记 warn，不阻塞任务。
   *
   * @param {boolean} [force] 忽略缓存。
   * @returns {Promise<object>} 最新的模型视图。
   */
  async refreshModels(force = false) {
    if (typeof this.models?.catalog !== 'function') return this.modelViewCache
    try {
      const catalog = await this.models.catalog(force)
      this.modelViewCache = normalizeModelConfig(this.config, {
        catalog,
        defaultSelection: this.#defaultSelection(),
      })
      if (this.modelViewCache.warnings.length > 0) {
        this.log('warn', `模型 allowlist 有 ${this.modelViewCache.warnings.length} 条警告：${this.modelViewCache.warnings.join('; ')}`)
      }
    } catch (error) {
      this.log('warn', `读取宿主模型目录失败，继续使用配置里的 allowlist：${error.message}`)
    }
    return this.modelViewCache
  }

  /** 动态提示词用的紧凑模型摘要；目录未加载时至少给出配置的默认项。 */
  modelSummary() {
    try {
      return modelSummary(this.modelViewCache)
    } catch {
      return ''
    }
  }

  /** 更新 allowlist（UI 保存后调用），无需重启 Router。 */
  setModels(modelsConfig) {
    this.config.models = modelsConfig
    this.modelViewCache = normalizeModelConfig(this.config, {
      catalog: this.modelViewCache?.catalog ?? { groups: [], failures: [] },
      defaultSelection: this.#defaultSelection(),
    })
    void this.refreshModels(true)
    return this.modelViewCache
  }

  /**
   * 解析 dispatch 的 `approval` 参数；用户写错时给出可修正的输入错误。
   *
   * @param {unknown} value
   * @returns {string}
   */
  #resolveApprovalMode(value) {
    try {
      return normalizeApprovalMode(value, approvalModeFor(this.config))
    } catch (error) {
      if (error?.code === 'invalid_approval_mode') {
        throw new RuntimeInputError(error.message, 'invalid_approval_mode')
      }
      throw error
    }
  }

  /** 应用一次模型选择，返回任务字段。 */
  #resolveTaskModel(input, source) {
    const view = this.modelViewCache
    if (source !== undefined && typeof source.modelId === 'string') {
      // 复用的 Worker 已经带着自己的模型/effort 启动，不能在半途换模型。
      if (typeof input?.model === 'string' && input.model.length > 0) {
        let requested
        try {
          requested = resolveModelSelection({ model: input.model }, view)
        } catch (error) {
          throw new RuntimeInputError(error.message, error.code ?? 'model_not_allowed')
        }
        if (requested.selection.provider !== source.provider || requested.selection.model !== source.model) {
          throw new RuntimeInputError(
            `task ${source.id} reused a Worker on ${source.provider}/${source.model}; a reused Worker keeps its model. Dispatch a new worker for ${requested.selection.provider}/${requested.selection.model}.`,
            'model_conflict',
          )
        }
      }
      if (typeof input?.reasoningEffort === 'string'
        && input.reasoningEffort.length > 0
        && input.reasoningEffort !== source.reasoningEffort) {
        throw new RuntimeInputError(
          `task ${source.id} reused a Worker at effort ${source.reasoningEffort}; a reused Worker keeps its reasoning effort.`,
          'model_conflict',
        )
      }
      return {
        modelId: source.modelId,
        modelLabel: source.modelLabel,
        provider: source.provider,
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        modelSelection: source.modelSelection,
      }
    }
    if (source !== undefined && source.modelId === undefined && input?.model === undefined) {
      // 旧任务没有记录模型；续接时沿用 Worker 自身的路由，不强行改成默认模型。
      return {}
    }
    if (view.models.length === 0 && (input?.model === undefined || input.model === '')) {
      // 宿主没有模型目录、用户也没配置 allowlist：交给宿主默认模型。
      return {}
    }
    let resolved
    try {
      resolved = resolveModelSelection(input ?? {}, view)
    } catch (error) {
      throw new RuntimeInputError(error.message, error.code ?? 'model_not_allowed')
    }
    if (source !== undefined) {
      const sourceProvider = source.provider
      const sourceModel = source.model
      if (typeof sourceProvider === 'string' && typeof sourceModel === 'string'
        && (resolved.selection.provider !== sourceProvider || resolved.selection.model !== sourceModel)) {
        throw new RuntimeInputError(
          `task ${source.id} reused a Worker on ${sourceProvider}/${sourceModel}; a reused Worker keeps its model. Dispatch a new worker for ${resolved.selection.provider}/${resolved.selection.model}.`,
          'model_conflict',
        )
      }
      if (typeof source.reasoningEffort === 'string'
        && resolved.selection.reasoningEffort !== undefined
        && resolved.selection.reasoningEffort !== source.reasoningEffort) {
        throw new RuntimeInputError(
          `task ${source.id} reused a Worker at effort ${source.reasoningEffort}; a reused Worker keeps its reasoning effort.`,
          'model_conflict',
        )
      }
    }
    const entry = resolved.entry
    return {
      modelId: entry.id,
      modelLabel: entry.label,
      provider: resolved.selection.provider,
      model: resolved.selection.model,
      reasoningEffort: resolved.selection.reasoningEffort,
      modelSelection: resolved.selection,
    }
  }

  /** 读取（或按 mtime 重读）长期约定文件。 */
  #loadAgreements(force = false) {
    const path = this.agreementsPath
    const mtime = agreementsMtime(path)
    if (!force && mtime !== 0 && mtime === this.agreementMtime && this.agreementItems.length > 0) return this.agreementItems
    const loaded = readAgreements(path)
    this.agreementItems = loaded.items
    this.agreementMtime = mtime
    this.agreementWarnings = loaded.warnings
    if (loaded.warnings.length > 0) this.log('warn', `长期约定文件有警告：${loaded.warnings.join('; ')}`)
    return this.agreementItems
  }

  /** 目录编辑后需要用到：暴露当前约定列表。 */
  listAgreements(projectPath) {
    const items = this.#loadAgreements()
    const filtered = typeof projectPath === 'string' && projectPath.length > 0
      ? items.filter((item) => item.project.length === 0 || item.project === resolve(projectPath))
      : items
    return filtered.map(agreementView)
  }

  /** Router 动态上下文中的约定文本；全局 + 所有项目约定（Router 需要知道全貌）。 */
  agreementContext() {
    const items = this.#loadAgreements().filter((item) => item.enabled !== false)
    if (items.length === 0) return ''
    const limit = this.config?.agreements?.injectChars ?? 6000
    const rendered = renderAgreements(items, { maxChars: limit })
    if (!rendered.truncated) return rendered.text
    return `${rendered.text}\n…(${rendered.total - rendered.shown} more agreement(s) not shown; use superagent_agreement list)`
  }

  /** Worker 的实际生效约定：全局 + 项目；项目 replace 时覆盖全局。 */
  #workerAgreements(projectPath) {
    const items = this.#loadAgreements()
    const applicable = agreementsForProject(items, projectPath)
    if (applicable.length === 0) return ''
    const limit = this.config?.agreements?.injectChars ?? 6000
    const rendered = renderAgreements(applicable, { maxChars: limit })
    return rendered.text
  }

  /** 保存/更新一条约定。供工具和 UI 共用。 */
  saveAgreement(input) {
    const items = [...this.#loadAgreements()]
    const maxItems = this.config?.agreements?.maxItems ?? 40
    const maxChars = this.config?.agreements?.maxCharsPerItem ?? 2000
    const now = this.now()
    const existingIndex = typeof input?.id === 'string' && input.id.length > 0
      ? items.findIndex((item) => item.id === input.id)
      : -1
    if (existingIndex === -1 && items.length >= maxItems) {
      throw new RuntimeInputError(`at most ${maxItems} agreements are allowed; remove or merge one first`, 'too_many')
    }
    const text = normalizeAgreementText(input?.text)
    if (text.length === 0) throw new RuntimeInputError('agreement text is required', 'missing_field')
    if (text.length > maxChars) {
      throw new RuntimeInputError(`agreement text is longer than ${maxChars} characters`, 'too_long')
    }
    let project = ''
    let projectTitle
    const existing = existingIndex >= 0 ? items[existingIndex] : undefined
    if (existing !== undefined && input?.project === undefined) {
      // 只改文本时保留原作用域，避免 UI 编辑把项目约定悄悄变成全局约定。
      project = existing.project
      projectTitle = existing.projectTitle
    } else if (typeof input?.project === 'string' && input.project.trim().length > 0) {
      const requested = input.project.trim()
      let resolved
      try {
        resolved = this.#resolveProject(requested)
      } catch (error) {
        // 面板/工具可能直接给绝对路径；协议目录里没登记也允许，只要目录真实存在。
        if (isAbsolute(requested) && existsSync(requested)) {
          resolved = { title: basename(requested), path: resolve(requested) }
        } else {
          throw error
        }
      }
      project = resolved.path
      projectTitle = resolved.title
    }
    const title = typeof input?.title === 'string' && input.title.trim().length > 0
      ? input.title.trim().slice(0, 120)
      : agreementTitle(text)
    const mode = input?.mode === 'replace' ? 'replace' : 'append'
    const enabled = input?.enabled !== false
    const item = existingIndex >= 0
      ? {
          ...items[existingIndex],
          title,
          text,
          project,
          ...(projectTitle === undefined ? {} : { projectTitle }),
          mode,
          enabled,
          updatedAt: now,
        }
      : {
          id: agreementId(),
          title,
          text,
          project,
          ...(projectTitle === undefined ? {} : { projectTitle }),
          mode,
          enabled,
          createdAt: now,
          updatedAt: now,
        }
    if (existingIndex >= 0) items[existingIndex] = item
    else items.push(item)
    writeAgreements(this.agreementsPath, items)
    this.agreementItems = items
    this.agreementMtime = agreementsMtime(this.agreementsPath)
    this.log('info', `长期约定已保存：${item.id} ${item.title}`)
    return { ok: true, agreement: agreementView(item), count: items.length }
  }

  /** 删除一条约定（写文件，不删除历史）。 */
  removeAgreement(id) {
    if (typeof id !== 'string' || id.length === 0) throw new RuntimeInputError('agreement id is required', 'missing_field')
    const items = this.#loadAgreements()
    const index = items.findIndex((item) => item.id === id)
    if (index === -1) throw new RuntimeInputError(`agreement not found: ${id}`, 'not_found')
    const [removed] = items.splice(index, 1)
    writeAgreements(this.agreementsPath, items)
    this.agreementItems = items
    this.agreementMtime = agreementsMtime(this.agreementsPath)
    return { ok: true, removed: agreementView(removed), count: items.length }
  }

  /** 启用/停用一条约定。 */
  toggleAgreement(id, enabled) {
    const items = this.#loadAgreements()
    const item = items.find((candidate) => candidate.id === id)
    if (item === undefined) throw new RuntimeInputError(`agreement not found: ${id}`, 'not_found')
    return this.saveAgreement({ ...item, enabled: enabled !== false })
  }

  // ── 定时任务（宿主 ctx.schedule） ─────────────────────────────────────

  /** 宿主 schedule 服务是否可用。 */
  get scheduleAvailable() {
    return typeof this.schedule?.list === 'function' && typeof this.schedule?.create === 'function'
  }

  /** 把宿主记录投影成 UI/工具可用的稳定形状。 */
  #scheduleView(record) {
    const kind = typeof record?.kind === 'string' ? record.kind : 'unknown'
    let recurrence = kind
    if (kind === 'after') recurrence = `once in ${record.afterSeconds}s`
    else if (kind === 'every') recurrence = `every ${record.everySeconds}s`
    else if (kind === 'daily') recurrence = `daily ${record.time} ${record.timeZone}`
    else if (kind === 'weekly') recurrence = `weekly ${(record.weekdays ?? []).join(',')} ${record.time} ${record.timeZone}`
    else if (kind === 'cron') recurrence = `cron ${record.expression} ${record.timeZone}`
    return {
      id: String(record?.id ?? ''),
      title: String(record?.title ?? ''),
      kind,
      recurrence,
      scheduledAt: typeof record?.scheduledAt === 'string' ? record.scheduledAt : undefined,
      state: record?.state === 'overdue' ? 'overdue' : 'scheduled',
      prompt: String(record?.prompt ?? ''),
      afterSeconds: record?.afterSeconds,
      everySeconds: record?.everySeconds,
      time: record?.time,
      timeZone: record?.timeZone,
      weekdays: record?.weekdays,
      expression: record?.expression,
    }
  }

  /** 重新读取 Router 绑定的定时任务。 */
  async #refreshSchedules(force = false) {
    if (!this.scheduleAvailable) {
      this.lastSchedules = []
      this.lastScheduleSummary = ''
      return []
    }
    if (!force && this.now() - this.scheduleLoadedAt < 15_000) return this.lastSchedules
    try {
      const records = await this.schedule.list(this.agent?.id)
      const rows = Array.isArray(records) ? records.map((record) => this.#scheduleView(record)) : []
      this.lastSchedules = rows
      this.scheduleLoadedAt = this.now()
      const active = rows.length
      const next = rows
        .filter((row) => row.scheduledAt !== undefined)
        .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))[0]
      this.lastScheduleSummary = active === 0
        ? ''
        : `${active} active${next === undefined ? '' : `; next ${next.title} at ${next.scheduledAt}`}`
      return rows
    } catch (error) {
      this.log('warn', `读取定时任务失败：${error.message}`)
      this.lastSchedules = []
      this.lastScheduleSummary = ''
      return []
    }
  }

  /** 动态提示词里的定时任务摘要。 */
  scheduleSummary() {
    return this.lastScheduleSummary
  }

  /** UI/工具：列出定时任务。 */
  async scheduleView(force = false) {
    const schedules = await this.#refreshSchedules(force)
    return {
      available: this.scheduleAvailable,
      sessionId: this.agent?.id,
      maxActive: this.config?.schedule?.maxActive ?? 20,
      timeZone: this.config?.schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedules,
      note: this.scheduleAvailable
        ? 'Schedules wake this Router at the target time; the Router then decides what to dispatch.'
        : 'The host has no schedule service in this deployment.',
    }
  }

  /** 规范化用户/工具给的定时选择器。 */
  #normalizeScheduleSelector(input) {
    const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']
      .filter((key) => input?.[key] !== undefined)
    if (selectors.length !== 1) {
      throw new RuntimeInputError('supply exactly one timing selector: after_seconds, at, every_seconds, daily, weekly, or cron', 'invalid_selector')
    }
    const selector = selectors[0]
    const value = input[selector]
    const defaultZone = this.config?.schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
    if (selector === 'after_seconds') {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RuntimeInputError('after_seconds must be a positive integer')
      return { after_seconds: value }
    }
    if (selector === 'every_seconds') {
      if (!Number.isSafeInteger(value) || value < 60) throw new RuntimeInputError('every_seconds must be an integer >= 60')
      return { every_seconds: value }
    }
    if (selector === 'at') {
      if (typeof value === 'string') return { at: value }
      if (isRecord(value) && typeof value.date === 'string' && typeof value.time === 'string') {
        return { at: { date: value.date, time: value.time, time_zone: value.time_zone ?? defaultZone } }
      }
      throw new RuntimeInputError('at must be an RFC 3339 string or {date, time, time_zone}')
    }
    if (selector === 'daily') {
      if (!isRecord(value) || typeof value.time !== 'string') throw new RuntimeInputError('daily requires {time, time_zone}')
      return { daily: { time: value.time, time_zone: value.time_zone ?? defaultZone } }
    }
    if (selector === 'weekly') {
      if (!isRecord(value) || typeof value.time !== 'string' || !Array.isArray(value.weekdays)) {
        throw new RuntimeInputError('weekly requires {time, weekdays, time_zone}')
      }
      const weekdays = value.weekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      if (weekdays.length === 0) throw new RuntimeInputError('weekly requires at least one ISO weekday 1-7')
      return { weekly: { time: value.time, weekdays, time_zone: value.time_zone ?? defaultZone } }
    }
    if (!isRecord(value) || typeof value.expression !== 'string') throw new RuntimeInputError('cron requires {expression, time_zone}')
    return { cron: { expression: value.expression, time_zone: value.time_zone ?? defaultZone } }
  }

  /** 把计划包装成 Router 能直接理解的唤醒提示。 */
  #scheduledPrompt(title, prompt, context) {
    if (this.config?.schedule?.frame === false) return prompt
    const lines = [
      '[super-agent scheduled task]',
      `Schedule: "${title}"`,
      '',
      'Instruction:',
      prompt,
    ]
    if (typeof context === 'string' && context.trim().length > 0) {
      lines.push('', 'Context:', context.trim())
    }
    lines.push(
      '',
      'This is a scheduled wake-up from the user. Check the current state first, then dispatch or act as needed. Keep the reply brief; do not include this frame in your answer.',
    )
    return lines.join('\n')
  }

  /**
   * 创建定时唤醒。到点由宿主把提示投递回 Router 会话。
   *
   * @param {{ title: string, prompt: string, context?: string, after_seconds?: number, at?: string|object, every_seconds?: number, daily?: object, weekly?: object, cron?: object }} input
   * @returns {Promise<object>}
   */
  async createSchedule(input) {
    if (!this.scheduleAvailable) {
      throw new RuntimeInputError('the host has no schedule service in this deployment', 'schedule_unavailable')
    }
    const title = requireText(input?.title, 'title', 120)
    const prompt = requireText(input?.prompt, 'prompt', 8000)
    const selector = this.#normalizeScheduleSelector(input)
    const current = await this.#refreshSchedules(true)
    if (current.length >= (this.config?.schedule?.maxActive ?? 20)) {
      throw new RuntimeInputError(`at most ${this.config?.schedule?.maxActive ?? 20} active schedules are allowed; cancel one first`, 'too_many')
    }
    const framed = this.#scheduledPrompt(title, prompt, input?.context)
    let record
    try {
      record = await this.schedule.create(this.agent?.id, { title, prompt: framed, ...selector })
    } catch (error) {
      throw new RuntimeInputError(`could not create schedule: ${error.message}`, error.code ?? 'schedule_failed')
    }
    await this.#refreshSchedules(true)
    return { ok: true, schedule: this.#scheduleView(record), note: 'At the target time the host wakes this Router with the framed instruction.' }
  }

  /** 取消一条定时任务。 */
  async cancelSchedule(scheduleId) {
    if (!this.scheduleAvailable || typeof this.schedule.cancel !== 'function') {
      throw new RuntimeInputError('the host has no schedule service in this deployment', 'schedule_unavailable')
    }
    const id = requireText(scheduleId, 'schedule_id', 200)
    let result
    try {
      result = await this.schedule.cancel(this.agent?.id, id)
    } catch (error) {
      throw new RuntimeInputError(`could not cancel schedule: ${error.message}`, error.code ?? 'schedule_failed')
    }
    await this.#refreshSchedules(true)
    return { ok: true, deleted: result?.deleted !== false, scheduleId: id }
  }

  /**
   * 取消当前 Router 的全部活跃定时任务。Reset 会换掉 Router 会话；如果不取消，
   * 旧 reminder 仍会把隐藏的旧 Router 唤醒，而新 Router 又看不到它们。
   *
   * @returns {Promise<{canceled: string[], failed: Array<{id: string, error: string}>}>}
   */
  async cancelAllSchedules() {
    if (!this.scheduleAvailable || typeof this.schedule.cancel !== 'function') {
      return { canceled: [], failed: [] }
    }
    let active = []
    try {
      active = await this.#refreshSchedules(true)
    } catch (error) {
      return { canceled: [], failed: [{ id: '*', error: error.message }] }
    }
    const canceled = []
    const failed = []
    for (const schedule of active) {
      const id = typeof schedule?.id === 'string' ? schedule.id : ''
      if (id.length === 0) continue
      try {
        await this.schedule.cancel(this.agent?.id, id)
        canceled.push(id)
      } catch (error) {
        failed.push({ id, error: error.message })
      }
    }
    try {
      await this.#refreshSchedules(true)
    } catch {
      // 列表刷新失败不影响取消结果。
    }
    return { canceled, failed }
  }

  /** 立即执行一次某条定时任务的提示（用于测试/手动触发），不改变下一次时间。 */
  async runScheduleNow(scheduleId) {
    if (!this.scheduleAvailable) {
      throw new RuntimeInputError('the host has no schedule service in this deployment', 'schedule_unavailable')
    }
    const id = requireText(scheduleId, 'schedule_id', 200)
    const records = await this.#refreshSchedules(true)
    const record = records.find((item) => item.id === id)
    if (record === undefined) throw new RuntimeInputError(`schedule not found: ${id}`, 'not_found')
    const result = this.ingest({
      source: 'schedule',
      kind: 'scheduled-now',
      externalId: `${id}\u0000${this.now()}`,
      dedupeKey: `schedule-now\u0000${id}\u0000${this.now()}`,
      title: record.title,
      text: record.prompt,
      addressed: true,
      actor: 'scheduler',
    })
    return { ok: true, scheduleId: id, trigger: result?.triggerId, note: 'The Router was woken immediately; the schedule itself is unchanged.' }
  }

  // ── 原生目标（objective）────────────────────────────────────────────────
  //
  // 宿主 goal 每轮结束会自动续轮（goal-round-driver），Router 用它会空转。
  // 这里的目标是**被动**的：创建/更新从不唤醒会话；推进只来自
  //   1. 到点调度（宿主 schedule 唤醒一次，Router 显式 check）
  //   2. 挂在目标上的 Worker 报告（#objectiveReports 自动记一条 check）
  //   3. 用户指令（Router 显式 check）
  // 见 objectives.js 顶部说明。

  /** 目标输入错误 → 工具层可展示的 RuntimeInputError。 */
  #objectiveError(error) {
    if (error instanceof ObjectiveInputError) return new RuntimeInputError(error.message, error.code)
    return error
  }

  /** 按 id 取目标。 */
  #requireObjective(objectiveId) {
    const id = requireText(objectiveId, 'objective_id', 120)
    const objective = this.store.getObjective(id)
    if (objective === undefined) throw new RuntimeInputError(`objective not found: ${id}`, 'not_found')
    return objective
  }

  /** 目标视图（模型/UI 用，不暴露 store 里的可变对象）。 */
  objectiveView(objective) {
    return toObjectiveView(objective, this.now())
  }

  /** 列出目标；默认不含已关闭的。 */
  listObjectives(options = {}) {
    const includeDone = options.includeDone === true
    const rows = this.store.listObjectives({ includeDone }).map((objective) => this.objectiveView(objective))
    return { ok: true, objectives: rows, due: rows.filter((row) => row.due).map((row) => row.id) }
  }

  /** 注入提示词的目标摘要；没有活动目标时返回空串。 */
  objectiveContext(limit = 3) {
    try {
      const active = this.store.listObjectives().filter((objective) => objective.status === 'active')
      if (active.length === 0) return ''
      const lines = active.slice(0, Math.max(1, limit)).map((objective) => objectiveSummaryLine(objective, this.now()))
      if (active.length > limit) lines.push(`…and ${active.length - limit} more; use superagent_goal action list.`)
      return lines.join('\n')
    } catch {
      return ''
    }
  }

  /** 到点检查的唤醒提示：只让 Router 检查一次，明确不是自动续轮。 */
  #objectiveCheckPrompt(record) {
    const progress = milestoneProgress(record)
    return [
      '[super-agent goal check]',
      `Objective ${record.id}: ${record.objective}`,
      `Milestones: ${progress.done}/${progress.total} done. Cadence: ${record.cadence.kind}.`,
      '',
      'This wake-up is a scheduled check, not an automatic continuation. Review current state with superagent_status, then:',
      `1. call superagent_goal action "check" objective_id "${record.id}" with a one-line note;`,
      '2. dispatch or steer only if a milestone genuinely needs work;',
      '3. if the objective is finished, close it with superagent_goal action "close".',
      'Do not create another schedule for this objective; its cadence already covers that.',
    ].join('\n')
  }

  /** 为目标的 cadence 建一条宿主 schedule；失败时降级成 warning，不静默。 */
  async #createObjectiveSchedule(record) {
    const selector = scheduleSelector(record.cadence)
    if (selector === undefined) return {}
    if (!this.scheduleAvailable) {
      return { warning: 'the host has no schedule service; the objective is tracked, but its cadence cannot wake this Router' }
    }
    const title = clip(`Goal check · ${record.objective}`, 110)
    try {
      const created = await this.schedule.create(this.agent?.id, {
        title,
        prompt: this.#objectiveCheckPrompt(record),
        ...selector,
      })
      const view = this.#scheduleView(created)
      const parsed = typeof view?.scheduledAt === 'string' ? Date.parse(view.scheduledAt) : Number.NaN
      return {
        ...(typeof created?.id === 'string' ? { scheduleId: created.id } : {}),
        ...(Number.isFinite(parsed) ? { nextCheckAt: parsed } : {}),
      }
    } catch (error) {
      this.log('warn', `创建目标检查调度失败：${error.message}`)
      return { warning: `could not create the goal-check schedule: ${error.message}` }
    }
  }

  /**
   * 创建目标。**不唤醒会话**：没有 trigger、没有 followup；有 cadence 时只建一条
   * 未来的宿主 schedule。
   *
   * @param {object} [input] objective / milestones / cadence 选择器。
   * @returns {Promise<object>}
   */
  async createObjective(input = {}) {
    let record
    try {
      record = createObjectiveRecord({
        id: newObjectiveId(),
        objective: input.objective,
        milestones: input.milestones,
        cadence: cadenceFromSelectors(input),
        source: 'router',
        now: this.now(),
      })
    } catch (error) {
      throw this.#objectiveError(error)
    }
    const scheduled = await this.#createObjectiveSchedule(record)
    if (scheduled.scheduleId !== undefined) record.scheduleId = scheduled.scheduleId
    if (scheduled.nextCheckAt !== undefined) record.nextCheckAt = scheduled.nextCheckAt
    this.store.append({ t: 'objective.created', objective: record })
    return {
      ok: true,
      created: true,
      objective: this.objectiveView(record),
      note: 'Objective recorded. This did not wake the session; checks arrive from its cadence, worker reports, or the user.',
      ...(scheduled.warning === undefined ? {} : { warning: scheduled.warning }),
    }
  }

  /**
   * 更新目标的文本/里程碑/节奏/状态。改节奏会换掉旧的检查调度。
   *
   * @param {object} [input]
   * @returns {Promise<object>}
   */
  async updateObjective(input = {}) {
    const current = this.#requireObjective(input.objective_id ?? input.objectiveId)
    if (current.status === 'done') {
      throw new RuntimeInputError('objective is closed; create a new one instead', 'closed')
    }
    const now = this.now()
    const patch = {}
    try {
      if (input.objective !== undefined) patch.objective = requireText(input.objective, 'objective', 2000)
      if (input.milestones !== undefined) patch.milestones = normalizeMilestones(input.milestones)
      if (input.add_milestones !== undefined) {
        patch.milestones = appendMilestones(patch.milestones ?? current.milestones, input.add_milestones)
      }
      if (input.complete_milestones !== undefined) {
        patch.milestones = completeMilestones(patch.milestones ?? current.milestones, input.complete_milestones, now)
      }
      const cadenceRequested = input.manual === true
        || input.cadence !== undefined
        || ['every_seconds', 'at', 'daily', 'weekly', 'cron'].some((key) => input[key] !== undefined)
      if (cadenceRequested) {
        patch.cadence = input.manual === true
          ? { kind: 'manual' }
          : normalizeCadence(input.cadence !== undefined ? input.cadence : cadenceFromSelectors(input))
      }
      if (input.status !== undefined) {
        if (input.status !== 'active' && input.status !== 'paused') {
          throw new RuntimeInputError('status must be active or paused; use action close to finish an objective', 'invalid')
        }
        patch.status = input.status
      }
    } catch (error) {
      throw this.#objectiveError(error)
    }

    let scheduled
    let canceledScheduleId
    if (patch.cadence !== undefined) {
      if (current.scheduleId !== undefined && this.scheduleAvailable && typeof this.schedule.cancel === 'function') {
        try {
          await this.schedule.cancel(this.agent?.id, current.scheduleId)
          canceledScheduleId = current.scheduleId
        } catch (error) {
          this.log('warn', `取消旧的目标检查调度失败：${error.message}`)
        }
      }
      patch.scheduleId = null
      patch.nextCheckAt = null
      const draft = { ...current, cadence: patch.cadence }
      scheduled = await this.#createObjectiveSchedule(draft)
      if (scheduled.scheduleId !== undefined) patch.scheduleId = scheduled.scheduleId
      if (scheduled.nextCheckAt !== undefined) patch.nextCheckAt = scheduled.nextCheckAt
    }
    patch.updatedAt = now
    this.store.append({ t: 'objective.updated', objectiveId: current.id, patch })
    return {
      ok: true,
      objective: this.objectiveView(this.store.getObjective(current.id)),
      ...(canceledScheduleId === undefined ? {} : { canceledScheduleId }),
      ...(scheduled?.warning === undefined ? {} : { warning: scheduled.warning }),
    }
  }

  /**
   * 记一次检查（推进）。source 缺省 user；schedule/report 由调度与报告路径给出。
   *
   * @param {object} [input]
   * @returns {Promise<object>}
   */
  async checkObjective(input = {}) {
    const current = this.#requireObjective(input.objective_id ?? input.objectiveId)
    if (current.status === 'done') {
      throw new RuntimeInputError('objective is closed; nothing to check', 'closed')
    }
    const now = this.now()
    let check
    let milestones
    try {
      check = normalizeCheck({
        source: input.source ?? 'user',
        note: input.note,
        milestoneId: input.milestone_id,
        taskId: input.task_id,
        at: now,
      }, now)
      milestones = completeMilestones(current.milestones, input.complete_milestones, now)
    } catch (error) {
      throw this.#objectiveError(error)
    }

    // 下一次检查时间：优先读宿主 schedule 的真实 next；every/at 本地推算。
    let next = undefined
    if (current.scheduleId !== undefined && this.scheduleAvailable) {
      try {
        const records = await this.#refreshSchedules(true)
        const live = records.find((row) => row.id === current.scheduleId)
        const parsed = typeof live?.scheduledAt === 'string' ? Date.parse(live.scheduledAt) : Number.NaN
        if (Number.isFinite(parsed)) next = parsed
      } catch {
        // 列表刷新失败时退回本地推算。
      }
    }
    if (next === undefined) {
      if (current.cadence?.kind === 'every') next = nextCheckAt(current.cadence, now)
      else if (current.cadence?.kind === 'at') next = null
      else next = Number.isFinite(current.nextCheckAt) ? current.nextCheckAt : null
    }

    if (input.complete_milestones !== undefined) {
      this.store.append({ t: 'objective.updated', objectiveId: current.id, patch: { milestones } })
    }
    this.store.append({
      t: 'objective.checked',
      objectiveId: current.id,
      check,
      nextCheckAt: next === undefined ? null : next,
    })
    const updated = this.store.getObjective(current.id)
    const progress = milestoneProgress(updated)
    return {
      ok: true,
      objective: this.objectiveView(updated),
      progress: { done: progress.done, total: progress.total },
      note: updated.status === 'done'
        ? 'Objective is closed.'
        : 'Check recorded. No follow-up wake-up was scheduled by this check.',
    }
  }

  /** 关闭目标：取消它的检查调度并标记 done。幂等。 */
  async closeObjective(input = {}) {
    const current = this.#requireObjective(input.objective_id ?? input.objectiveId)
    if (current.status === 'done') {
      return { ok: true, alreadyClosed: true, objective: this.objectiveView(current) }
    }
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
      ? clip(input.reason.trim(), 300)
      : undefined
    let canceledScheduleId
    if (current.scheduleId !== undefined && this.scheduleAvailable && typeof this.schedule.cancel === 'function') {
      try {
        await this.schedule.cancel(this.agent?.id, current.scheduleId)
        canceledScheduleId = current.scheduleId
      } catch (error) {
        this.log('warn', `关闭目标时取消检查调度失败：${error.message}`)
      }
    }
    this.store.append({ t: 'objective.closed', objectiveId: current.id, ...(reason === undefined ? {} : { reason }) })
    return {
      ok: true,
      objective: this.objectiveView(this.store.getObjective(current.id)),
      ...(canceledScheduleId === undefined ? {} : { canceledScheduleId }),
      note: 'Closed. No further checks will wake this Router.',
    }
  }

  /**
   * 把当前 Router 会话里已暂停的宿主 goal 迁移成原生目标。
   *
   * 只读 goal 的文本和阶段；迁移后的目标是 manual 节奏，**不会**自动唤醒。
   * 宿主 goal 保持原样（暂停），并额外 disarm 掉续轮授权。
   */
  async importHostGoal() {
    const agent = this.agent
    let goals
    try {
      goals = agent?.ctx?.goals
    } catch {
      goals = undefined
    }
    if (goals === undefined || typeof goals.get !== 'function' || agent === undefined) {
      throw new RuntimeInputError('the host goal service is unavailable in this session', 'goals_unavailable')
    }
    let hostGoal
    try {
      hostGoal = goals.get(agent)
    } catch (error) {
      throw new RuntimeInputError(`could not read the host goal: ${error.message}`, 'goals_unavailable')
    }
    if (hostGoal === undefined) {
      throw new RuntimeInputError('this Router session has no host goal to migrate', 'no_host_goal')
    }
    let record
    try {
      record = adoptHostGoal(hostGoal, { id: newObjectiveId(), now: this.now() })
    } catch (error) {
      throw this.#objectiveError(error)
    }
    this.store.append({ t: 'objective.created', objective: record })
    let disarmed = false
    try {
      if (typeof goals.disarm === 'function') {
        goals.disarm(agent)
        disarmed = true
      }
    } catch (error) {
      this.log('warn', `迁移目标时解除宿主 goal 续轮失败：${error.message}`)
    }
    return {
      ok: true,
      migrated: true,
      objective: this.objectiveView(record),
      hostGoal: {
        id: hostGoal.id,
        phase: hostGoal.phase,
        roundsStarted: hostGoal.roundsStarted,
        activation: hostGoal.activation,
      },
      disarmed,
      note: 'Migrated. The host goal stays paused and disarmed; the new objective has manual cadence, so nothing auto-continues.',
    }
  }

  /**
   * 安装时的一次性迁移：会话里若已有宿主 goal（例如之前 paused 的
   * dsh-chatgpt-ui 交付目标），复制成 manual 节奏的原生目标并 disarm。
   *
   * 幂等：同一个 hostGoalId 只迁一次；complete 的 goal 不迁。迁移不唤醒会话，
   * 也不建任何调度，所以即使旧 goal 曾经 armed 过，也不会再空转。
   *
   * @returns {Promise<{ migrated: boolean, reason?: string, objectiveId?: string, disarmed?: boolean }>}
   */
  async migrateHostGoalOnce() {
    const agent = this.agent
    let goals
    try {
      goals = agent?.ctx?.goals
    } catch {
      goals = undefined
    }
    if (goals === undefined || typeof goals.get !== 'function') return { migrated: false, reason: 'goals_unavailable' }
    let hostGoal
    try {
      hostGoal = goals.get(agent)
    } catch {
      return { migrated: false, reason: 'goals_unavailable' }
    }
    if (hostGoal === undefined || hostGoal === null) return { migrated: false, reason: 'no_host_goal' }
    if (hostGoal.phase === 'complete') return { migrated: false, reason: 'goal_complete' }
    const hostGoalId = typeof hostGoal.id === 'string' ? hostGoal.id : undefined
    if (hostGoalId !== undefined) {
      const existing = this.store.listObjectives({ includeDone: true }).find((objective) => objective.hostGoalId === hostGoalId)
      if (existing !== undefined) return { migrated: false, reason: 'already_migrated', objectiveId: existing.id }
    }
    const result = await this.importHostGoal()
    return { migrated: true, objectiveId: result.objective.id, disarmed: result.disarmed }
  }

  /** Worker 报告推进：挂在该任务上的活动目标各记一条 report 检查。 */
  #objectiveReports(task, reason, text) {
    try {
      const linked = this.store.listObjectives()
        .filter((objective) => objective.status === 'active' && (objective.taskIds ?? []).includes(task.id))
      if (linked.length === 0) return
      const now = this.now()
      for (const objective of linked) {
        const check = normalizeCheck({
          source: 'report',
          taskId: task.id,
          note: `${reason}: ${summaryOf(text, 200)}`,
          at: now,
        }, now)
        this.store.append({
          t: 'objective.checked',
          objectiveId: objective.id,
          check,
          nextCheckAt: Number.isFinite(objective.nextCheckAt) ? objective.nextCheckAt : null,
        })
      }
    } catch (error) {
      this.log('warn', `目标报告推进失败：${error.message}`)
    }
  }

  /**
   * 兼容旧版 UI / 脚本的 focus project。新面板不再调用；正常 dispatch 应显式传
   * `project`。只影响未给 project/cwd 的 dispatch 的兜底 cwd，不改 Router 状态。
   *
   * @param {string | null | undefined} value 绝对目录；空值清除。
   * @returns {{ ok: boolean, focusProject?: string }}
   */
  setFocusProject(value) {
    if (value === undefined || value === null || value === '') {
      this.focusProject = undefined
      return { ok: true }
    }
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new RuntimeInputError('focus project must be an absolute path')
    }
    const resolved = resolve(value)
    let isDirectory = false
    try {
      isDirectory = statSync(resolved).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) throw new RuntimeInputError(`focus project is not a directory: ${resolved}`)
    this.focusProject = resolved
    return { ok: true, focusProject: resolved }
  }

  /** 当前 Router 状态；宿主对象没有 status 时按 idle。 */
  routerStatus() {
    return this.agent?.status === 'running' ? 'running' : 'idle'
  }

  /** 启动：恢复任务、挂监听、开 Watchdog 与 inbox watcher。 */
  start() {
    if (this.active) return this
    this.active = true
    this.startedAt = this.now()
    this.#attachRouter()
    this.#loadCursor()
    // 恢复是异步的（要把磁盘上的会话装回内存）：不阻塞 start()，也不让失败
    // 变成未处理的 rejection——救不回来的任务会各自标 interrupted。
    void this.#recover().catch((error) => this.log('warn', `恢复任务失败：${error?.message ?? error}`))
    this.#loadAgreements(true)
    void this.refreshModels().catch((error) => this.log('warn', `初始化模型目录失败：${error.message}`))
    void this.#refreshSchedules().catch(() => undefined)
    this.#pump()
    if (this.config?.watchdog?.enabled !== false) this.#startWatchdog()
    this.#startInboxWatcher()
    // 首轮 flush 延后一点，让 agent/created 的其他监听器先完成注册。
    this.scheduleFlush(50)
    return this
  }

  /** 停止：只解绑监听与定时器；不删除状态，也不主动杀 Worker。 */
  stop() {
    this.active = false
    this.closed = true
    if (this.flushTimer !== undefined) this.timers.clearTimeout(this.flushTimer)
    if (this.watchdogTimer !== undefined) this.timers.clearInterval(this.watchdogTimer)
    if (this.inboxTimer !== undefined) this.timers.clearInterval(this.inboxTimer)
    this.flushTimer = undefined
    this.watchdogTimer = undefined
    this.inboxTimer = undefined
    for (const dispose of this.routerDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 关闭阶段不放大错误。
      }
    }
    for (const [childId, state] of this.children) {
      for (const dispose of state.disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 同上。
        }
      }
      this.children.delete(childId)
    }
    this.childText.clear()
    this.toolCalls.clear()
    this.missingWorkers.clear()
  }

  /**
   * Reset 前中止所有 Worker：取消运行中的 turn、释放 activation、解绑监听。
   * 不写 task.closed，也不删除 journal——调用方会切换到一个全新的 dataDir
   * generation，旧 journal 保留为审计记录。
   *
   * @returns {Promise<string[]>} 旧任务里出现过的 Worker Session id。
   */
  async abortWorkers() {
    const workerIds = new Set()
    for (const task of this.store.listTasks()) {
      if (typeof task.workerSessionId === 'string' && task.workerSessionId.length > 0) workerIds.add(task.workerSessionId)
    }
    for (const controller of this.controllers.values()) {
      try {
        controller.abort()
      } catch {
        // abort 失败不影响后续释放。
      }
    }
    const jobs = []
    for (const [childId, activation] of this.activations) {
      workerIds.add(childId)
      try {
        jobs.push(Promise.resolve(activation.dispose?.()).catch(() => undefined))
      } catch {
        // dispose 同步失败时继续释放其它 Worker。
      }
    }
    for (const childId of [...this.children.keys()]) this.#detachWorker(childId)
    for (const childId of [...workerIds]) {
      const child = this.getAgent(childId)
      try {
        child?.cancel?.({ kind: 'parent' })
      } catch {
        // 已释放的 Worker 不需要再取消。
      }
    }
    this.activations.clear()
    this.controllers.clear()
    this.childText.clear()
    this.missingWorkers.clear()
    await Promise.allSettled(jobs)
    return [...workerIds]
  }

  /**
   * 观察任意 Session 事件；index.js 在 profile scope 上转接 `session/event`。
   *
   * 为什么不在子 Agent 的 ctx 上只听一次：真实宿主里 Session 事件是
   * `Scoped<Session>` 派发的，root 级监听最可靠；child.ctx 监听作为补充。
   * 两条路径都走这里，靠 turn 去重与 `lastReportTurn` 防重复。
   *
   * @param {object} session Session。
   * @param {object} event Session 事件。
   */
  observeSessionEvent(session, event) {
    if (!this.active || this.closed) return
    const childId = typeof session?.id === 'string' ? session.id : session?.header?.id
    if (typeof childId !== 'string') return
    // DSH 的 Session 事件是 `{ type, seq, time, data }`；测试与部分适配层
    // 可能直接展开 data。两种形状都接受。
    const data = isRecord(event?.data) ? event.data : event
    // tool/call 先缓存：审批事件只带 callId，摘要要用同一次调用的参数。
    // 这条缓存与任务状态无关，所以放在 task 查找之前。
    if (event?.type === 'tool/call') {
      this.#rememberToolCall(childId, data)
      return
    }
    const activeId = this.children.get(childId)?.taskId
    const task = activeId === undefined ? this.store.taskForWorkerSession(childId) : this.store.getTask(activeId)
    if (task === undefined) return
    if (event?.type === 'assistant/message') {
      const text = assistantText(data?.message)
      if (text.length > 0) this.childText.set(childId, text)
      return
    }
    if (event?.type === 'approval/asked') {
      this.#handleApprovalAsked(task, childId, data)
      return
    }
    if (event?.type === 'approval/decided') {
      this.#handleApprovalDecided(task, childId, data)
      return
    }
    if (event?.type === 'turn/end') {
      this.#forgetToolCalls(childId)
      this.#handleTurnEnd(task.id, childId, data)
    }
  }

  /** 记下最近一次 tool/call，供后续 approval/asked 关联参数；有界，避免长期增长。 */
  #rememberToolCall(childId, data) {
    const callId = typeof data?.callId === 'string' && data.callId.length > 0 ? data.callId : undefined
    if (callId === undefined) return
    const key = `${childId}\u0000${callId}`
    this.toolCalls.set(key, {
      name: typeof data?.name === 'string' ? data.name : undefined,
      arguments: pruneToolArguments(data?.arguments),
      at: this.now(),
    })
    while (this.toolCalls.size > 200) {
      const oldest = this.toolCalls.keys().next().value
      if (oldest === undefined) break
      this.toolCalls.delete(oldest)
    }
  }

  /** 丢弃某个 Worker 的 tool/call 缓存（turn 结束或解绑时）。 */
  #forgetToolCalls(childId) {
    const prefix = `${childId}\u0000`
    for (const key of [...this.toolCalls.keys()]) {
      if (key.startsWith(prefix)) this.toolCalls.delete(key)
    }
  }

  /**
   * 宿主审批服务刚写下 `approval/asked`：Worker 的 turn 还开着，工具调用正在
   * 等待人工决定，但 Agent 状态仍是 running，watchdog 看不到。这里立刻把任务
   * 标成 `blocked-approval`、写审计事件，并把一条 trigger 送回 Router。
   */
  #handleApprovalAsked(task, childId, data) {
    const current = this.store.getTask(task.id)
    // 审批只在打开的 turn 内发生。idle/failed/interrupted 等终态收到迟到的 ask
    // 时不复活任务，避免把已经结束的工作重新标成阻塞。
    if (current === undefined || ['closed', 'lost', 'failed', 'interrupted', 'idle', 'resumable'].includes(current.status)) return
    const approvalId = typeof data?.id === 'string' && data.id.length > 0
      ? data.id
      : `apr_${randomUUID()}`
    // 重复派发（同一 id）只记一次；不同 id 允许覆盖同一条任务的最新等待。
    if (current.pendingApproval?.id === approvalId) return
    const toolName = typeof data?.toolName === 'string' && data.toolName.length > 0 ? data.toolName : 'unknown'
    const callId = typeof data?.callId === 'string' && data.callId.length > 0 ? data.callId : undefined
    const cached = callId === undefined ? undefined : this.toolCalls.get(`${childId}\u0000${callId}`)
    const descriptor = describeApprovalRequest({
      toolName,
      ...(cached?.arguments === undefined ? {} : { arguments: cached.arguments }),
      ...(callId === undefined ? {} : { callId }),
      ...(typeof data?.reason === 'string' ? { reason: data.reason } : {}),
    })
    const policy = current.approvalMode ?? approvalModeFor(this.config)
    const suggestion = suggestApproval(policy, descriptor, { cwd: current.cwd })
    const askedAt = this.now()
    this.store.append({
      t: 'approval.asked',
      taskId: current.id,
      approval: {
        id: approvalId,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        ...(descriptor.reason === undefined ? {} : { reason: descriptor.reason }),
        summary: descriptor.summary,
        ...(descriptor.argumentsPreview === undefined ? {} : { argumentsPreview: descriptor.argumentsPreview }),
        policy,
        ...(suggestion === undefined ? {} : { suggestion }),
        askedAt,
      },
    })
    const lines = [
      `Task ${current.id} "${current.title}" is blocked waiting for approval.`,
      `Tool: ${toolName}${callId === undefined ? '' : ` (call ${callId})`}`,
      `Request: ${descriptor.summary}`,
      descriptor.reason === undefined ? '' : `Reason: ${descriptor.reason}`,
      `Approval policy: ${policy} — this build still forwards every request to the user.`,
      suggestion === undefined
        ? 'No automatic recommendation. Ask the user to allow or deny; the worker stays blocked until they decide.'
        : `Suggestion (advisory only): ${suggestion.decision} — ${suggestion.rationale}. Ask the user to confirm; do not treat this as an approval.`,
      'Use superagent_status / superagent_recall to inspect the task. Do not close or re-dispatch it just because it is blocked.',
    ]
    this.ingest({
      source: 'worker',
      threadKey: `approval:${current.id}`,
      externalId: `approval:${approvalId}`,
      kind: 'approval-request',
      actor: childId,
      title: `Approval needed: ${current.title}`,
      text: lines.filter((line) => line.length > 0).join('\n'),
      direct: true,
      internal: true,
      meta: {
        taskId: current.id,
        approvalId,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        policy,
        summary: descriptor.summary,
        ...(suggestion === undefined ? {} : { suggestion }),
      },
    })
    this.scheduleFlush(0)
  }

  /**
   * 宿主审批服务写下 `approval/decided`：清掉等待标记并恢复 working，让 watchdog
   * 与面板不再把它当作卡住。决定来自宿主 UI/策略，通常不再额外唤醒 Router；只有
   * 原审批 trigger 还留在 pending 队列时才补一条 resolved 与它合批，避免 Router
   * 醒来后对已经解决的事情再问用户。journal 保留完整审计。
   */
  #handleApprovalDecided(task, childId, data) {
    const current = this.store.getTask(task.id)
    const pending = current?.pendingApproval
    if (current === undefined || pending === undefined) return
    const approvalId = typeof data?.id === 'string' && data.id.length > 0 ? data.id : pending.id
    if (approvalId !== pending.id) return
    const outcome = typeof data?.outcome === 'string' ? data.outcome : 'unavailable'
    this.store.append({
      t: 'approval.resolved',
      taskId: current.id,
      approvalId: pending.id,
      outcome,
      decidedBy: 'host',
      resolvedAt: this.now(),
    })
    // 如果审批 trigger 还在 pending 队列里（Router 还没被唤醒/还没 flush），补一条
    // resolved trigger 与它合批，避免 Router 醒来后对着已经解决的事情再问用户。
    // 已经投递过的 trigger 不再补，恢复事件不额外唤醒 Router。
    const askedTriggerId = this.store.dedupeId(`worker\u0000approval:${pending.id}`)
    const askedTrigger = askedTriggerId === undefined ? undefined : this.store.getTrigger(askedTriggerId)
    if (askedTrigger?.state === 'pending') {
      this.ingest({
        source: 'worker',
        threadKey: `approval:${current.id}`,
        externalId: `approval-resolved:${pending.id}`,
        kind: 'approval-resolved',
        actor: childId,
        title: `Approval resolved: ${current.title}`,
        text: [
          `Task ${current.id} "${current.title}" is no longer waiting for approval.`,
          `The approval request ${pending.id} (${pending.toolName}: ${pending.summary}) resolved as ${outcome}.`,
          'Do not ask the user to approve it again. The worker continues in its current turn; a report will follow when it ends.',
        ].join('\n'),
        direct: true,
        internal: true,
        meta: { taskId: current.id, approvalId: pending.id, outcome },
      })
      this.scheduleFlush(0)
    }
  }

  // ── Router 绑定与批处理 ──────────────────────────────────────────────────

  #attachRouter() {
    const ctx = this.agent?.ctx
    if (ctx && typeof ctx.on === 'function') {
      const offStatus = ctx.on('agent/status', (payload) => {
        if (payload?.status === 'idle' && this.active) this.scheduleFlush(0)
      })
      if (typeof offStatus === 'function') this.routerDisposers.push(offStatus)
      const offDisposed = ctx.on('agent/disposed', () => {
        this.active = false
      })
      if (typeof offDisposed === 'function') this.routerDisposers.push(offDisposed)
    }
  }

  /**
   * 安排一次 flush。Router 忙时只保留 timer 语义：等 idle 事件再 flush。
   *
   * @param {number} [delayMs] 延迟。
   */
  scheduleFlush(delayMs = this.config?.router?.batchDebounceMs ?? 200) {
    if (!this.active || this.closed) return
    if (this.routerStatus() === 'running') return
    if (this.flushTimer !== undefined) this.timers.clearTimeout(this.flushTimer)
    const delay = Math.max(0, Number(delayMs) || 0)
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined
      try {
        this.flushNow()
      } catch (error) {
        this.lastError = error.message
        this.log('warn', `flush 失败：${error.message}`)
      }
    }, delay)
    this.flushTimer?.unref?.()
  }

  /**
   * 立即把 pending Trigger 合并成一批注入 Router。
   *
   * @returns {{ flushed: number, batchId?: string, deferred?: boolean, error?: string }}
   */
  flushNow() {
    if (!this.active || this.closed) return { flushed: 0 }
    if (this.routerStatus() === 'running') return { flushed: 0, deferred: true }
    const pendingBefore = this.store.pendingTriggers(1000)
    if (pendingBefore.length === 0) return { flushed: 0 }

    const batch = newBatchId()
    const rendered = renderBatch({
      triggers: pendingBefore,
      batchId: batch,
      config: this.config,
      pendingAfter: 0,
      now: this.now(),
    })
    if (rendered.triggerIds.length === 0) return { flushed: 0 }

    try {
      this.store.append({
        t: 'batch.created',
        batchId: batch,
        target: 'router',
        triggerIds: rendered.triggerIds,
        renderedChars: rendered.chars,
      })
      for (const triggerId of rendered.triggerIds) {
        this.store.append({
          t: 'trigger.delivered',
          triggerId,
          batchId: batch,
          target: 'router',
        })
      }
      this.agent.followup(userMessage(rendered.text))
      this.batchCount += 1
      return { flushed: rendered.triggerIds.length, batchId: batch }
    } catch (error) {
      this.lastError = error.message
      for (const triggerId of rendered.triggerIds) {
        this.store.append({ t: 'trigger.failed', triggerId, reason: `router delivery failed: ${error.message}` })
      }
      this.log('warn', `注入 Router 失败：${error.message}`)
      return { flushed: 0, error: error.message }
    }
  }

  // ── Trigger intake ───────────────────────────────────────────────────────

  /**
   * 接收一条环境事件。
   *
   * @param {{
   *   source?: string,
   *   threadKey?: string,
   *   externalId?: string,
   *   kind?: string,
   *   actor?: string,
   *   title?: string,
   *   text?: string,
   *   url?: string,
   *   mentions?: string[],
   *   direct?: boolean,
   *   meta?: object,
   *   receivedAt?: number,
   *   internal?: boolean,
   * }} input 事件。
   * @returns {object} `{ ok, id?, threadId?, state?, duplicate?, filtered? }`
   */
  ingest(input) {
    if (!this.active) return { ok: false, error: 'runtime is not active' }
    const source = typeof input?.source === 'string' && input.source.trim().length > 0 ? input.source.trim() : 'unknown'
    const rawText = typeof input?.text === 'string' ? input.text : ''
    const externalId = typeof input?.externalId === 'string' && input.externalId.length > 0 ? input.externalId : undefined
    const dedupeKey = externalId !== undefined ? `${source}\u0000${externalId}` : undefined
    if (dedupeKey !== undefined && this.store.hasDedupe(dedupeKey)) {
      const existing = this.store.dedupeId(dedupeKey)
      return { ok: true, duplicate: true, id: existing, threadId: this.store.getTrigger(existing)?.threadId }
    }

    const policy = sourcePolicy(this.config, source)
    const maxText = Number.isFinite(policy.maxTextChars) ? policy.maxTextChars : 8000
    const redacted = this.config?.redact !== false ? redactSecrets(rawText) : rawText
    const clipped = clip(redacted, maxText)
    const fullChars = Array.from(redacted).length
    const text = this.config?.storeFullText === false ? '' : clipped
    const summary = summaryOf(redacted, 180)
    const id = newTriggerId()
    const receivedAt = Number.isFinite(input?.receivedAt) ? input.receivedAt : this.now()
    const threadKey = typeof input?.threadKey === 'string' && input.threadKey.length > 0 ? input.threadKey : undefined
    const thread = deriveThreadId(source, threadKey, id)
    const decision = filterEvent({
      source,
      actor: input?.actor,
      text: redacted,
      direct: input?.direct === true,
      mentions: Array.isArray(input?.mentions) ? input.mentions : [],
      internal: input?.internal === true,
    }, this.config)

    const trigger = {
      id,
      source,
      threadId: thread,
      threadKey,
      externalId,
      dedupeKey,
      kind: typeof input?.kind === 'string' ? input.kind : undefined,
      actor: typeof input?.actor === 'string' ? input.actor : undefined,
      title: typeof input?.title === 'string' ? clip(oneLine(input.title), 160) : summaryOf(redacted, 120),
      summary,
      text: decision.pass ? text : '',
      url: typeof input?.url === 'string' ? input.url : undefined,
      meta: safeMeta(input?.meta),
      receivedAt,
      addressed: decision.addressed,
      priority: decision.addressed ? 'addressed' : 'ambient',
      mode: decision.mode,
      state: decision.pass ? 'pending' : 'filtered',
      fullChars,
      truncated: clipped.length < redacted.length || (this.config?.storeFullText === false && redacted.length > 0),
    }

    if (!decision.pass) {
      this.store.append({
        t: 'trigger.filtered',
        trigger: { ...trigger, text: '', state: 'filtered' },
        reason: decision.reason,
      })
      return {
        ok: true,
        id,
        threadId: thread,
        state: 'filtered',
        filtered: true,
        reason: decision.reason,
        reasonText: decision.reasonText,
      }
    }

    try {
      this.store.append({ t: 'trigger.received', trigger })
    } catch (error) {
      this.lastError = error.message
      return { ok: false, error: `journal write failed: ${error.message}` }
    }

    const routed = this.#routeToWorkers(trigger)
    if (!routed.delivered) this.scheduleFlush()
    return {
      ok: true,
      id,
      threadId: thread,
      state: routed.delivered ? 'delivered' : 'pending',
      direct: routed.delivered,
      deliveredTo: routed.tasks,
      addressed: decision.addressed,
    }
  }

  /**
   * 已订阅 Thread 的 Fast Path：直接投给所有 live Worker。
   *
   * @param {object} trigger Trigger 记录。
   * @returns {{ delivered: boolean, tasks: string[] }}
   */
  #routeToWorkers(trigger) {
    const tasks = this.store.tasksForThread(trigger.threadId)
    const deliveredTo = []
    // 同一个 Worker 可能服务多个顺序任务；每个 Worker 只投一次，优先当前活动任务。
    const byWorker = new Map()
    for (const task of tasks) {
      if (task.status === 'closed' || task.status === 'lost') continue
      // 正在等审批的 Worker 不能接收新消息：先让 Router 处理审批，事件留在
      // pending 里由下一批唤醒 Router，而不是把 blocked-approval 覆盖成 working。
      if (task.status === 'blocked-approval') continue
      if (typeof task.workerSessionId !== 'string') continue
      const previous = byWorker.get(task.workerSessionId)
      if (previous === undefined || taskPriority(task) < taskPriority(previous)
        || (taskPriority(task) === taskPriority(previous) && (task.updatedAt ?? task.createdAt ?? 0) > (previous.updatedAt ?? previous.createdAt ?? 0))) {
        byWorker.set(task.workerSessionId, task)
      }
    }
    for (const task of byWorker.values()) {
      const child = this.getAgent(task.workerSessionId)
      if (child === undefined) {
        // starting：Worker 还没 materialize，事件先留在 pending，等它启动后
        // 由 Router/下一批处理；不能在这里把正在启动的任务判 lost。
        // idle/blocked/failed：会话被宿主回收，事件回到 Router 即可。
        if (task.status === 'working') this.#markTaskLost(task, 'worker session is not live')
        continue
      }
      const activeOther = this.store.listTasks().find((candidate) => (
        candidate.id !== task.id
        && candidate.workerSessionId === task.workerSessionId
        && (candidate.status === 'starting' || candidate.status === 'working' || candidate.status === 'blocked-approval')
      ))
      if (activeOther !== undefined) continue
      try {
        this.#attachWorker(task, child)
        child.followup(userMessage(renderWorkerEvent({
          trigger,
          config: this.config,
          task,
          store: this.store,
          agreements: this.#workerAgreements(task.cwd),
        })))
        this.store.append({
          t: 'trigger.delivered',
          triggerId: trigger.id,
          target: 'worker',
          taskId: task.id,
        })
        this.#updateTask(task, { status: 'working' })
        deliveredTo.push(task.id)
      } catch (error) {
        this.log('warn', `投递 Worker ${task.id} 失败：${error.message}`)
        this.store.append({
          t: 'trigger.failed',
          triggerId: trigger.id,
          target: 'worker',
          taskId: task.id,
          reason: error.message,
        })
      }
    }
    return { delivered: deliveredTo.length > 0, tasks: deliveredTo }
  }

  // ── 项目与 Worker 生命周期 ────────────────────────────────────────────

  /**
   * 宿主注册的项目清单（去重、保留宿主顺序）。项目是 Router 自主选择的目标，
   * 不是 UI 的必填项；拿不到 workspace 服务时返回空数组。
   *
   * @returns {{id: string, title: string, path: string}[]}
   */
  listProjects() {
    let rows
    try {
      rows = this.projectsSource()
    } catch (error) {
      this.log('warn', `读取项目清单失败：${error.message}`)
      return []
    }
    const seen = new Set()
    const projects = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = typeof row?.path === 'string' ? resolve(row.path) : ''
      if (path.length === 0 || seen.has(path)) continue
      seen.add(path)
      projects.push({
        id: typeof row?.id === 'string' && row.id.length > 0 ? row.id : path,
        title: typeof row?.title === 'string' && row.title.length > 0 ? row.title : path,
        path,
      })
    }
    return projects
  }

  /** 把一个项目标题/id/路径解析成唯一项目，歧义时给出候选路径。 */
  #resolveProject(reference) {
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      throw new RuntimeInputError('project must be a non-empty project title, id, or absolute path', 'missing_field')
    }
    const query = reference.trim()
    const projects = this.listProjects()
    if (projects.length === 0) {
      throw new RuntimeInputError('no projects are registered with the host; pass an absolute cwd only if the user explicitly gave one', 'no_projects')
    }
    const exact = projects.filter((project) => project.id === query || project.title === query || project.path === query)
    const wanted = query.toLowerCase()
    const matches = exact.length > 0 ? exact : projects.filter((project) => (
      project.title.toLowerCase() === wanted
      || project.id.toLowerCase() === wanted
      || project.path.toLowerCase() === wanted
      || project.path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === wanted
    ))
    if (matches.length === 1) return matches[0]
    const known = projects.map((project) => `${project.title} (${project.path})`).join('; ')
    if (matches.length === 0) {
      throw new RuntimeInputError(`no project matched "${query}". Known projects: ${known}`, 'not_found')
    }
    throw new RuntimeInputError(
      `project "${query}" is ambiguous: ${matches.map((project) => project.path).join(', ')}. Use the absolute path.`,
      'ambiguous',
    )
  }

  /**
   * 创建一个 Worker 任务。立即返回；worker 启动、失败、报告都在后台。
   *
   * `reuseTaskId` 让新任务复用该任务的 Worker Session：共享上下文，适合同一项目
   * 的连续工作。只允许在源任务已结束且 Worker 正空闲时复用，避免覆盖正在执行的
   * turn。
   *
   * @param {{
   *   title: string,
   *   brief: string,
   *   threadIds?: string[],
   *   project?: string,
   *   cwd?: string,
   *   speculative?: boolean,
   *   reuseTaskId?: string,
   *   approval?: string,
   * }} input
   * @returns {object}
   */
  dispatch(input) {
    if (!this.active) throw new RuntimeInputError('runtime is not active')
    const title = requireText(input?.title, 'title', 160)
    const brief = requireText(input?.brief, 'brief', 20_000)
    const threadIds = normalizeThreadIds(input?.threadIds)
    const reuseTaskId = typeof input?.reuseTaskId === 'string' && input.reuseTaskId.length > 0
      ? input.reuseTaskId
      : undefined
    let source
    let project
    let cwd
    // 这条新任务是否**真的**接在旧的 Worker 会话上。重启后 `interrupted` / `lost`
    // 的源任务也接受 reuse_task_id，但起的是新 Worker（只继承项目/模型/谱系），
    // 不假装能接上已经消失的上下文。
    let continuesSession = false
    if (reuseTaskId !== undefined) {
      source = this.#requireTask(reuseTaskId)
      continuesSession = ['idle', 'blocked', RESUMABLE].includes(source.status)
      const restartFresh = source.status === INTERRUPTED || source.status === 'lost'
      if (!continuesSession && !restartFresh) {
        throw new RuntimeInputError(`task ${source.id} cannot be reused while it is ${source.status}; wait for it to finish or dispatch a new worker`, 'busy')
      }
      if (continuesSession) {
        if (typeof source.workerSessionId !== 'string' || source.workerSessionId.length === 0) {
          throw new RuntimeInputError(`task ${source.id} has no Worker session to reuse`, 'not_found')
        }
        if (this.getAgent(source.workerSessionId) === undefined) {
          throw new RuntimeInputError(`the Worker for task ${source.id} is not attached right now; check superagent_status before reusing it, or dispatch a new worker`, 'not_found')
        }
        const busy = this.store.listTasks().find((task) => (
          task.id !== source.id
          && task.workerSessionId === source.workerSessionId
          && (task.status === 'starting' || task.status === 'working' || task.status === 'blocked-approval')
        ))
        if (busy !== undefined) {
          throw new RuntimeInputError(`the Worker for task ${source.id} is busy with task ${busy.id} (${busy.title})`, 'busy')
        }
      }
      cwd = source.cwd
      project = source.project === undefined
        ? undefined
        : { title: source.project, id: source.projectId, path: source.cwd }
      if (typeof input?.project === 'string' && input.project.trim().length > 0) {
        const requested = this.#resolveProject(input.project)
        if (requested.path !== cwd) {
          throw new RuntimeInputError(`reused worker runs in ${cwd}, not ${requested.path}; use a new worker for a different project`, 'invalid')
        }
        project = requested
      }
      if (typeof input?.cwd === 'string' && input.cwd.length > 0) {
        const requestedCwd = this.#resolveCwd(input.cwd)
        if (requestedCwd !== cwd) {
          throw new RuntimeInputError(`reused worker runs in ${cwd}, not ${requestedCwd}`, 'invalid')
        }
      }
    } else {
      project = typeof input?.project === 'string' && input.project.trim().length > 0
        ? this.#resolveProject(input.project)
        : undefined
      cwd = project === undefined ? this.#resolveCwd(input?.cwd) : project.path
    }
    const model = source === undefined
      ? this.#resolveTaskModel({ model: input?.model, reasoningEffort: input?.reasoningEffort }, undefined)
      : this.#resolveTaskModel({
          model: input?.model ?? source.modelId,
          reasoningEffort: input?.reasoningEffort ?? source.reasoningEffort,
        }, source)
    // B 阶段接口预留：策略在 dispatch 时解析并落进任务/journal；本版本不会据此
    // 自动回答，所有审批仍转人工（answerer 接线见 lib/approval.js）。
    const approvalMode = input?.approval === undefined
      ? (readRecordString(source, 'approvalMode') ?? approvalModeFor(this.config))
      : this.#resolveApprovalMode(input.approval)
    // 可选：把任务挂在一条活动目标上。挂上后 Worker 的报告会自动记一条
    // objective check（见 #objectiveReports），目标因此可以“由报告推进”。
    const objectiveRef = typeof input?.objectiveId === 'string' && input.objectiveId.length > 0
      ? input.objectiveId
      // 从原 brief 重新派工时沿用源任务的目标，别把目标链悄悄断掉。
      : (source !== undefined && !continuesSession ? source.objectiveId : undefined)
    const objective = typeof objectiveRef === 'string' && objectiveRef.length > 0
      ? this.#requireObjective(objectiveRef)
      : undefined
    if (objective !== undefined && objective.status !== 'active') {
      throw new RuntimeInputError(`objective ${objective.id} is ${objective.status}; reopen or create a new one before dispatching on it`, 'invalid')
    }
    const id = newTaskId()
    const now = this.now()
    // 附件：先暂存再写 task.created。校验或复制失败就整体拒绝，不留下半个任务。
    const attachments = this.#stageAttachments(input?.attachments, cwd, id)
    const task = {
      id,
      title,
      brief,
      cwd,
      project: project?.title,
      projectId: project?.id,
      status: 'queued',
      speculative: input?.speculative === true,
      threadIds: [],
      workerSessionId: continuesSession ? source.workerSessionId : undefined,
      continuedFrom: continuesSession ? source.id : undefined,
      ...(source !== undefined && !continuesSession ? { resumedFrom: source.id } : {}),
      ...(objective === undefined ? {} : { objectiveId: objective.id }),
      ...model,
      approvalMode,
      // 附件的绝对路径由 worker 自己用 read/read_image 打开；只在有附件时落库。
      ...(attachments.length === 0 ? {} : { attachments }),
      createdAt: now,
      updatedAt: now,
      createdBy: this.agent?.id,
    }
    this.store.append({ t: 'task.created', task })
    if (objective !== undefined) {
      this.store.append({
        t: 'objective.updated',
        objectiveId: objective.id,
        patch: { taskIds: [...(objective.taskIds ?? []), id] },
      })
    }
    const subscribed = threadIds.length === 0 && source !== undefined && !continuesSession
      ? [...source.threadIds]
      : threadIds
    for (const thread of subscribed) {
      this.store.append({ t: 'task.subscribed', taskId: id, threadId: thread, source: 'unknown' })
    }
    this.dispatchCount += 1
    this.#pump()
    const current = this.store.getTask(id)
    return {
      ok: true,
      status: current?.status ?? 'queued',
      taskId: id,
      threadIds: subscribed,
      cwd,
      project: project?.title,
      workerSessionId: continuesSession ? source.workerSessionId : undefined,
      continuedFrom: continuesSession ? source.id : undefined,
      ...(source !== undefined && !continuesSession ? { resumedFrom: source.id } : {}),
      model: model.modelId,
      modelLabel: model.modelLabel,
      reasoningEffort: model.reasoningEffort,
      approval: approvalMode,
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((file) => file.path),
            attachmentNote: 'Worker reads these absolute paths with its own tools; the copies sit in the plugin data dir, not the user source tree.',
          }),
      note: continuesSession
        ? 'Continues in the same Worker session with its prior context. Its report will arrive as a new trigger; do not wait for it.'
        : source === undefined
          ? 'Worker starts in the background. Its report will arrive as a new trigger; do not wait for it.'
          : `The old Worker session is gone, so this starts a fresh Worker from the original brief and inherits task ${source.id}'s project, model and objective. Its report will arrive as a new trigger; do not wait for it.`,
    }
  }

  /**
   * 向 Worker 发一条消息。立即返回 accepted。
   *
   * 默认插队（interrupt）：消息进宿主的 `next-step` 队列，Worker 正在跑时在
   * **本轮**下一次模型步之前就能读到；宿主只在 step 边界注入，正在执行的工具调用
   * 会先安全结束，不会被打断。`interrupt: false` 保留旧的排队语义：作为独立的
   * follow-up turn，等当前 run（turn）结束后才被消费。
   *
   * @param {string} taskId 任务 id。
   * @param {string} message 消息。
   * @param {{ attachments?: string[], interrupt?: boolean }} [options]
   *   本地附件路径（规则同 dispatch）与投递模式；`interrupt` 默认 true。
   * @returns {object}
   */
  steer(taskId, message, options = {}) {
    const task = this.#requireTask(taskId)
    if (task.status === 'closed') throw new RuntimeInputError(`task ${task.id} is closed`)
    if (task.status === 'blocked-approval') {
      throw new RuntimeInputError(
        `task ${task.id} is waiting for approval (${task.pendingApproval?.toolName ?? 'tool'}); resolve the approval before steering it`,
        'blocked-approval',
      )
    }
    const text = requireText(message, 'message', 20_000)
    const child = typeof task.workerSessionId === 'string' ? this.getAgent(task.workerSessionId) : undefined
    if (child === undefined) throw new RuntimeInputError(`task ${task.id} has no live worker (status ${task.status})`)
    const busy = this.store.listTasks().find((candidate) => (
      candidate.id !== task.id
      && candidate.workerSessionId === task.workerSessionId
      && (candidate.status === 'starting' || candidate.status === 'working' || candidate.status === 'blocked-approval')
    ))
    if (busy !== undefined) throw new RuntimeInputError(`the shared Worker is busy with task ${busy.id} (${busy.title})`, 'busy')
    // steer 走纯文本路径，附件只能给绝对路径让 worker 自己读；复制目录与 dispatch 同一个。
    const attachments = this.#stageAttachments(options?.attachments, task.cwd, task.id)
    // 默认插队；只有显式 interrupt:false 才退回旧的 follow-up 排队语义。
    const wantsInterrupt = options?.interrupt !== false
    const canInterrupt = typeof child.steer === 'function'
    const mode = wantsInterrupt && canInterrupt ? 'interrupt' : 'queue'
    const fallback = wantsInterrupt && !canInterrupt
    this.#attachWorker(task, child)
    // 单一投递分支：同一调用只进一个宿主队列，不会 steer + followup 各投一次。
    const delivered = userMessage(`${text}${renderAttachmentNote(attachments)}`)
    if (mode === 'interrupt') child.steer(delivered)
    else child.followup(delivered)
    this.store.append({ t: 'task.steered', taskId: task.id, mode, interrupt: mode === 'interrupt' })
    this.log('info', `steer ${task.id}: interrupt=${mode === 'interrupt' ? 1 : 0} mode=${mode}${fallback ? ' (worker has no steer(); queued for the next turn)' : ''}`)
    this.#updateTask(task, attachments.length === 0
      ? { status: 'working' }
      : { status: 'working', attachments: [...(task.attachments ?? []), ...attachments] })
    return {
      ok: true,
      status: 'accepted',
      taskId: task.id,
      interrupt: mode === 'interrupt',
      mode,
      delivery: mode === 'interrupt' ? 'next-step' : 'next-turn',
      ...(attachments.length === 0 ? {} : { attachments: attachments.map((file) => file.path) }),
      ...(fallback
        ? { warning: 'the worker does not expose steer(); the message was queued as a follow-up turn' }
        : {}),
      note: mode === 'interrupt'
        ? 'Injected at the worker next step boundary within its current run (after the running tool call finishes); it does not wait for a new turn.'
        : 'Queued as a follow-up turn; the worker consumes it after its current run ends.',
    }
  }

  /**
   * 暂存 dispatch/steer 的附件（复制到 `<dataDir>/attachments/<taskId>/`）。
   *
   * @param {unknown} paths 调用方给的路径数组。
   * @param {string} baseDir worker 工作目录（相对路径的基准，也是项目的语义根）。
   * @param {string} taskId 任务 id（决定暂存子目录）。
   * @returns {object[]} 暂存后的附件描述；没有附件时是空数组。
   */
  #stageAttachments(paths, baseDir, taskId) {
    if (paths === undefined || paths === null) return []
    try {
      return stageAttachments({
        paths,
        baseDir,
        destDir: join(this.dataDir, 'attachments', taskId),
        limits: this.config?.worker?.attachments,
      }).files
    } catch (error) {
      if (error instanceof AttachmentError) throw new RuntimeInputError(error.message, error.code)
      throw error
    }
  }

  /**
   * 关闭任务，或只退掉一个 Thread 订阅。
   *
   * @param {{ taskId: string, threadId?: string, reason?: string }} input
   * @returns {object}
   */
  close(input) {
    const task = this.#requireTask(input?.taskId)
    if (typeof input?.threadId === 'string' && input.threadId.length > 0) {
      if (!task.threadIds.includes(input.threadId)) {
        throw new RuntimeInputError(`task ${task.id} is not subscribed to thread ${input.threadId}`)
      }
      this.store.append({ t: 'task.unsubscribed', taskId: task.id, threadId: input.threadId })
      return { ok: true, status: 'unsubscribed', taskId: task.id, threadId: input.threadId, remaining: task.threadIds }
    }
    if (task.status === 'closed') return { ok: true, status: 'closed', taskId: task.id, alreadyClosed: true }
    const reason = typeof input?.reason === 'string' ? clip(input.reason, 500) : 'closed by router'
    this.store.append({ t: 'task.closed', taskId: task.id, reason })
    const shared = typeof task.workerSessionId === 'string' && this.store.listTasks().some((candidate) => (
      candidate.id !== task.id
      && candidate.workerSessionId === task.workerSessionId
      && candidate.status !== 'closed'
    ))
    if (shared) {
      // 同一个 Worker 的历史/续接任务仍然存在；关闭其中一个不能把 Worker 掐掉。
      this.#pump()
      return { ok: true, status: 'closed', taskId: task.id, workerRetained: true, note: 'Task closed; the shared Worker remains for its other task(s).' }
    }
    this.#detachWorker(task.workerSessionId ?? task.id)
    const activationEntry = this.#activationForWorker(task.workerSessionId)
    if (activationEntry !== undefined) this.activations.delete(activationEntry.key)
    // starting 阶段还没有真实 workerSessionId（见 #spawnTask），但 controller
    // 已经按 taskId 登记；按 id 兜底，确保启动中的 create 能被 close 取消。
    const controllerEntry = this.#controllerForWorker(task.workerSessionId)
      ?? (this.controllers.has(task.id) ? { key: task.id, controller: this.controllers.get(task.id) } : undefined)
    if (controllerEntry !== undefined) this.controllers.delete(controllerEntry.key)
    controllerEntry?.controller?.abort?.()
    if (activationEntry !== undefined) {
      // 只释放运行中的 Agent，不归档 Session：活动详情里的「打开聊天」要能回看
      // 已完成任务的对话。归档只在 Reset/显式清理时发生。
      Promise.resolve()
        .then(() => activationEntry.activation.dispose())
        .catch((error) => this.log('warn', `释放 Worker ${task.id} 失败：${error.message}`))
    } else if (typeof task.workerSessionId === 'string') {
      // 重启后认领的 Worker 没有原 activation 句柄；至少中止它当前的 turn。
      const child = this.getAgent(task.workerSessionId)
      try {
        child?.cancel?.({ kind: 'parent' })
      } catch {
        // 取消失败不影响任务已关闭的事实。
      }
    }
    this.#pump()
    return { ok: true, status: 'closing', taskId: task.id, note: 'Worker is being released in the background.' }
  }

  /** 找到某个 Worker 对应的 activation；复用任务没有自己的 activation。 */
  #activationForWorker(workerSessionId) {
    if (typeof workerSessionId !== 'string') return undefined
    for (const [key, activation] of this.activations) {
      if (activation?.childId === workerSessionId) return { key, activation }
    }
    return undefined
  }

  /** 找到某个 Worker 对应的 controller；复用任务没有自己的 controller。 */
  #controllerForWorker(workerSessionId) {
    if (typeof workerSessionId !== 'string') return undefined
    for (const [key, controller] of this.controllers) {
      const owner = this.store.getTask(key)
      if (owner?.workerSessionId === workerSessionId) return { key, controller }
    }
    return undefined
  }

  /** 确保容量允许后，按创建顺序启动 queued 任务。 */
  #pump() {
    if (this.pumping || !this.active) return
    this.pumping = true
    try {
      for (;;) {
        if (this.#liveWorkerCount() >= (this.config?.worker?.maxWorkers ?? 4)) break
        const next = this.store.listTasks().find((task) => task.status === 'queued')
        if (next === undefined) break
        if (typeof next.continuedFrom === 'string') void this.#startReuseTask(next)
        else void this.#spawnTask(next)
      }
    } finally {
      this.pumping = false
    }
  }

  #liveWorkerCount() {
    let count = 0
    for (const task of this.store.listTasks()) {
      // idle 的 Worker 可能仍驻留（供 steer / Thread 直通），但不占“正在执行”
      // 的槽位；否则 Router 不 close 时，后续任务会永远排队。
      if (task.status === 'starting') count += 1
      else if (task.status === 'blocked-approval' && typeof task.workerSessionId === 'string') count += 1
      else if (task.status === 'working' && typeof task.workerSessionId === 'string') count += 1
    }
    return count
  }

  /** 目标目录是否在 Router 的 sandbox workspace 之外。 */
  #outsideProject(cwd) {
    const rel = relative(this.projectRoot, cwd)
    return rel !== '' && (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
  }

  async #spawnTask(task) {
    const provider = this.config?.worker?.spawnProvider ?? 'spawn'
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const sessionId = workerSessionId()
    // 先登记任务为 starting，但不写一个还没创建的 session id：跨项目路径里
    // 宿主会自行生成/规范化 session id，提前写进去会让 watchdog 查一个永远不存在
    // 的会话。真实 id 只在 activation 返回后登记。
    this.store.append({
      t: 'task.updated',
      taskId: task.id,
      patch: { status: 'starting', startedAt: this.now() },
    })
    try {
      const prompt = renderWorkerTask({
        task: { ...task, workerSessionId: sessionId },
        config: this.config,
        store: this.store,
        projectRoot: this.projectRoot,
        agreements: this.#workerAgreements(task.cwd),
      })
      let activation
      if (this.sessionWorkers?.create !== undefined && this.#outsideProject(task.cwd)) {
        // 跨项目：普通 Session 的 header.cwd 是目标项目，sandbox workspace-write
        // 才会真正覆盖目标目录。宿主创建完会话会给出 canonical id，runtime 先登记
        // 该 id 再发 prompt；不能复用上面本地预生成的 sessionId。
        activation = await this.sessionWorkers.create({
          cwd: task.cwd,
          taskId: task.id,
          title: task.title,
          prompt,
          signal: controller.signal,
          modelSelection: task.modelSelection,
        })
      } else {
        if (this.subagents === undefined || typeof this.subagents.startActivation !== 'function') {
          throw new Error('ctx.subagents is unavailable in this deployment')
        }
        if (typeof this.subagents.getProvider === 'function' && this.subagents.getProvider(provider) === undefined) {
          throw new Error(`subagent provider "${provider}" is not registered`)
        }
        const providerInfo = typeof this.subagents.getProvider === 'function' ? this.subagents.getProvider(provider) : undefined
        if (task.modelSelection !== undefined && providerInfo?.capabilities?.agentOptions === false) {
          throw new Error(`subagent provider "${provider}" does not support per-child model selection`)
        }
        activation = await this.subagents.startActivation({
          provider,
          label: task.title,
          childId: sessionId,
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: this.agent,
            cwd: task.cwd,
            ...(task.modelSelection === undefined ? {} : { agentOptions: task.modelSelection }),
          },
          signal: controller.signal,
          delivery: 'caller',
        })
      }
      const current = this.store.getTask(task.id)
      if (current === undefined || current.status !== 'starting') {
        // 启动期间可能被 close/watchdog 改成了 closed/lost/failed；
        // 迟到的 activation 不能再把任务复活。
        await activation.dispose().catch(() => undefined)
        return
      }
      this.activations.set(task.id, activation)
      this.store.append({
        t: 'task.updated',
        taskId: task.id,
        patch: { status: 'working', workerSessionId: activation.childId, startedAt: this.now() },
      })
      const child = this.getAgent(activation.childId) ?? activation.agent
      if (child !== undefined) this.#attachWorker(task, child)
      if (typeof activation.start === 'function') await activation.start()
      Promise.resolve(activation.result).catch((error) => {
        this.log('warn', `Worker ${task.id} activation 结束异常：${error.message}`)
        const latest = this.store.getTask(task.id)
        if (latest !== undefined && !['closed', 'failed', 'lost', 'interrupted'].includes(latest.status)) {
          this.#report(task, 'error', `worker activation failed: ${error.message}`, undefined, true)
        }
        this.#pump()
      })
    } catch (error) {
      this.lastError = error.message
      this.controllers.delete(task.id)
      this.log('warn', `启动 Worker ${task.id} 失败：${error.message}`)
      const current = this.store.getTask(task.id)
      if (current !== undefined && current.status === 'starting') {
        this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'failed' } })
        this.#report(task, 'error', `failed to start worker: ${error.message}`, undefined, false)
      }
      this.#pump()
    }
  }

  /**
   * 在已有 Worker Session 上启动一个续接任务，不创建新会话。
   * 上下文由 Session 自身保留；这里只负责 prompt、状态和报告监听。
   */
  async #startReuseTask(task) {
    this.store.append({
      t: 'task.updated',
      taskId: task.id,
      patch: { status: 'starting', startedAt: this.now() },
    })
    try {
      const child = typeof task.workerSessionId === 'string' ? this.getAgent(task.workerSessionId) : undefined
      if (child === undefined) throw new Error('the reused Worker session is no longer live')
      const busy = this.store.listTasks().find((candidate) => (
        candidate.id !== task.id
        && candidate.workerSessionId === task.workerSessionId
        && (candidate.status === 'starting' || candidate.status === 'working' || candidate.status === 'blocked-approval')
      ))
      if (busy !== undefined) throw new Error(`the Worker is already running task ${busy.id}`)
      const prompt = renderWorkerTask({
        task,
        config: this.config,
        store: this.store,
        projectRoot: this.projectRoot,
        agreements: this.#workerAgreements(task.cwd),
      })
      this.#attachWorker(task, child)
      const current = this.store.getTask(task.id)
      if (current === undefined || current.status !== 'starting') return
      child.followup(userMessage(prompt))
      this.store.append({
        t: 'task.updated',
        taskId: task.id,
        patch: { status: 'working', startedAt: this.now() },
      })
      this.#pump()
    } catch (error) {
      this.lastError = error.message
      this.log('warn', `启动续接任务 ${task.id} 失败：${error.message}`)
      const current = this.store.getTask(task.id)
      if (current !== undefined && current.status === 'starting') {
        this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'failed' } })
        this.#report(task, 'error', `failed to continue in the reused Worker: ${error.message}`, undefined, false)
      }
      this.#pump()
    }
  }

  #attachWorker(task, child) {
    const existing = this.children.get(child.id)
    if (existing !== undefined) {
      const current = this.store.getTask(existing.taskId)
      // 同一个 Worker 可能被多个顺序任务复用。不要用旧的 idle 任务覆盖
      // 正在 starting/working 的新任务；反过来则把活动任务切到新任务上。
      if (current !== undefined && ['starting', 'working', 'blocked-approval'].includes(current.status)
        && !['starting', 'working', 'blocked-approval'].includes(task.status)) return
      existing.taskId = task.id
      existing.lastError = undefined
      this.childText.delete(child.id)
      return
    }
    const state = { taskId: task.id, disposers: [], lastError: undefined }
    this.children.set(child.id, state)
    const ctx = child.ctx
    if (ctx && typeof ctx.on === 'function') {
      const offSession = ctx.on('session/event', (session, event) => {
        this.observeSessionEvent(session ?? child.session, event)
      })
      if (typeof offSession === 'function') state.disposers.push(offSession)
      const offError = ctx.on('agent/error', (payload) => {
        state.lastError = payload?.error?.message ?? String(payload?.error ?? 'unknown error')
      })
      if (typeof offError === 'function') state.disposers.push(offError)
      const offDisposed = ctx.on('agent/disposed', () => {
        this.#detachWorker(child.id)
        const current = this.store.getTask(state.taskId)
        if (current !== undefined && current.status !== 'closed' && current.status !== 'lost') {
          this.#markTaskLost(current, 'worker session was disposed')
        }
      })
      if (typeof offDisposed === 'function') state.disposers.push(offDisposed)
    }
  }

  #detachWorker(childId) {
    this.#forgetToolCalls(childId)
    const state = this.children.get(childId)
    if (state === undefined) return
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 解绑失败不影响后续状态。
      }
    }
    this.children.delete(childId)
  }

  #handleTurnEnd(taskId, childId, event) {
    const task = this.store.getTask(taskId)
    if (task === undefined || task.status === 'closed') return
    const state = this.children.get(childId)
    const turn = typeof event?.turn === 'number' ? event.turn : undefined
    if (turn !== undefined && task.lastReportTurn === turn) return
    const reason = normalizeReason(event?.reason?.kind)
    const lastText = this.childText.get(childId) ?? ''
    const text = lastText.trim().length > 0
      ? lastText
      : `(worker ended without a text report; last error: ${state?.lastError ?? 'none'})`
    this.childText.delete(childId)
    this.#report(task, reason, text, turn, false)
  }

  /**
   * 写一条任务报告，并把摘要作为新 Trigger 送回 Router。
   *
   * @param {object} task 任务。
   * @param {string} reason 结束/报告原因。
   * @param {string} text 报告正文。
   * @param {number | undefined} turn turn 号。
   * @param {boolean} synthesized 是否由 runtime/watchdog 合成。
   */
  #report(task, reason, text, turn, synthesized) {
    const current = this.store.getTask(task.id)
    if (current === undefined || current.status === 'closed') return
    const reportId = newReportId()
    const clippedText = clip(this.config?.redact !== false ? redactSecrets(text) : text, this.config?.worker?.maxReportChars ?? 4000)
    this.store.append({
      t: 'task.reported',
      taskId: task.id,
      report: {
        id: reportId,
        reason,
        text: clippedText,
        turn,
        synthesized: synthesized === true,
      },
    })
    const trigger = {
      id: newTriggerId(),
      source: 'worker',
      threadId: taskThreadId(task.id),
      threadKey: `task:${task.id}`,
      externalId: reportId,
      dedupeKey: `worker\u0000${reportId}`,
      kind: 'worker-report',
      actor: current.workerSessionId ?? 'worker',
      title: task.speculative ? `Speculative report: ${task.title}` : `Report: ${task.title}`,
      summary: summaryOf(`${task.speculative ? '[speculative] ' : ''}${reason}: ${clippedText}`, 180),
      text: [
        `Task ${task.id} "${task.title}"${task.speculative ? ' (speculative run)' : ''} reported ${reason}${turn === undefined ? '' : ` at turn ${turn}`}.`,
        '',
        clippedText,
        '',
        'Decide whether to tell a person, continue the task, or close it. Use superagent_recall for the task brief and thread links.',
        'If you tell the user, report the outcome in a few sentences; do not forward this report verbatim or narrate the worker process.',
      ].join('\n'),
      receivedAt: this.now(),
      addressed: true,
      priority: 'addressed',
      mode: 'candidate',
      fullChars: text.length,
      truncated: clippedText.length < text.length,
    }
    this.store.append({ t: 'trigger.received', trigger })
    // 目标推进：报告是三种允许的推进来源之一（调度 / 报告 / 用户）。
    this.#objectiveReports(current, reason, clippedText)
    this.scheduleFlush(0)
    // 完成后空出执行槽位，让 queued 任务继续启动；idle Worker 仍可保留
    // 供 steer / Thread 直通，但不再阻塞新任务。
    this.#pump()
  }

  /** 把任务标记为 lost，并让 Router 知道。只做一次。 */
  #markTaskLost(task, reason) {
    const current = this.store.getTask(task.id)
    if (current === undefined || current.status === 'closed' || current.status === 'lost') return
    this.missingWorkers.delete(task.id)
    this.controllers.get(task.id)?.abort?.()
    this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'lost', lostReason: reason } })
    this.#report(current, 'lost', `Worker session is gone: ${reason}. Decide whether to retry the task or close it.`, undefined, true)
    this.#pump()
  }

  #updateTask(task, patch) {
    this.store.append({ t: 'task.updated', taskId: task.id, patch })
  }

  #requireTask(taskId) {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new RuntimeInputError('task_id is required')
    const task = this.store.getTask(taskId)
    if (task === undefined) throw new RuntimeInputError(`task not found: ${taskId}`, 'not_found')
    return task
  }

  #resolveCwd(value) {
    const fallback = this.focusProject || this.config?.worker?.defaultCwd || this.projectRoot
    const candidate = typeof value === 'string' && value.length > 0 ? value : fallback
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(this.projectRoot, candidate)
    if (!existsSync(resolved)) {
      this.log('warn', `worker cwd 不存在，回退到项目根：${resolved}`)
      return this.projectRoot
    }
    return resolved
  }

  // ── 面向人的信道 ────────────────────────────────────────────────────────

  /**
   * 排队一条面向人的消息。IM 等信道有硬性字数上限。
   *
   * @param {{ channel: string, text: string, threadId?: string, taskId?: string }} input
   * @returns {object}
   */
  reply(input) {
    if (!this.active) throw new RuntimeInputError('runtime is not active')
    const channel = requireText(input?.channel, 'channel', 80)
    const text = requireText(input?.text, 'text', 20_000)
    const style = channelConfig(this.config, channel)
    const words = wordCount(text)
    if (style.maxWords > 0 && words > style.maxWords) {
      throw new RuntimeInputError(
        `reply is ${words} words; channel "${channel}" allows ${style.maxWords}. Shorten it. Guidance: ${style.guidance}`,
        'too_long',
      )
    }
    const redacted = this.config?.redact !== false ? redactSecrets(text) : text
    const reply = {
      id: newReplyId(),
      channel,
      text: redacted,
      threadId: typeof input?.threadId === 'string' ? input.threadId : undefined,
      taskId: typeof input?.taskId === 'string' ? input.taskId : undefined,
      words,
      createdAt: this.now(),
      status: 'queued',
    }
    this.store.append({ t: 'reply.queued', reply })
    let outboxError
    try {
      mkdirSync(this.dataDir, { recursive: true })
      appendFileSync(this.store.paths.outbox, `${JSON.stringify(reply)}\n`)
    } catch (error) {
      outboxError = error.message
      this.log('warn', `写 outbox 失败（journal 仍有记录）：${error.message}`)
    }
    return {
      ok: true,
      status: 'queued',
      replyId: reply.id,
      channel,
      words,
      maxWords: style.maxWords,
      outbox: this.store.paths.outbox,
      outboxError,
      note: 'A channel bridge reads outbox.jsonl; this plugin does not post to external services itself.',
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /**
   * 状态快照。
   *
   * @param {'compact'|'full'} [detail]
   * @returns {object}
   */
  status(detail = 'compact') {
    try {
      this.#loadAgreements()
    } catch {
      // 约定文件读失败不影响状态查询。
    }
    const stats = this.store.stats()
    const tasks = this.store.listTasks().map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      threadIds: [...task.threadIds],
      workerSessionId: task.workerSessionId,
      cwd: task.cwd,
      project: task.project,
      model: task.modelId,
      modelLabel: task.modelLabel,
      reasoningEffort: task.reasoningEffort,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      continuedFrom: task.continuedFrom,
      ...(task.resumedFrom === undefined ? {} : { resumedFrom: task.resumedFrom }),
      ...(task.resumedAt === undefined ? {} : { resumedAt: task.resumedAt }),
      ...(task.interruptedAt === undefined ? {} : { interruptedAt: task.interruptedAt }),
      // 重启后要能原地续做：resumable 给「怎么继续」，interrupted 给原 brief。
      ...(detail === 'full' && typeof task.brief === 'string' ? { brief: task.brief } : {}),
      // 附件暂存副本的绝对路径；worker 侧读的就是这些文件。
      ...(Array.isArray(task.attachments) && task.attachments.length > 0
        ? { attachments: task.attachments.map((file) => file.path) }
        : {}),
      speculative: task.speculative === true,
      age: formatAge(this.now() - (task.updatedAt ?? this.now())),
      reportCount: Array.isArray(task.reports) ? task.reports.length : 0,
      lastReport: task.lastReport === undefined ? undefined : { reason: task.lastReport.reason, at: task.lastReport.at },
    }))
    const threads = this.store.listThreads({ limit: detail === 'full' ? 100 : 12 }).map((thread) => ({
      id: thread.id,
      source: thread.source,
      title: thread.title,
      triggerCount: thread.triggerIds.length,
      taskIds: [...thread.taskIds],
      updatedAt: thread.updatedAt,
      age: formatAge(this.now() - (thread.updatedAt ?? this.now())),
    }))
    const pending = this.store.pendingTriggers(detail === 'full' ? 50 : 12).map((trigger) => ({
      id: trigger.id,
      source: trigger.source,
      threadId: trigger.threadId,
      priority: trigger.addressed ? 'addressed' : 'ambient',
      age: formatAge(this.now() - (trigger.receivedAt ?? this.now())),
      summary: trigger.summary,
    }))
    const snapshot = {
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      focusProject: this.focusProject,
      router: {
        sessionId: this.agent?.id,
        status: this.routerStatus(),
        pendingTriggers: stats.pending,
        batches: stats.batches,
        uptime: formatAge(this.now() - this.startedAt),
      },
      counts: stats,
      tasks,
      threads,
      pending,
      objectives: this.listObjectives({ includeDone: detail === 'full' }).objectives,
      outbox: {
        total: stats.replies,
        byChannel: stats.repliesByChannel,
        path: this.store.paths.outbox,
        latest: this.store.queuedReplies(1)[0]?.id,
      },
      watchdog: {
        lastCheckAt: this.lastCheckAt,
        issues: this.lastIssues,
        reported: this.reportedIssues.size,
        enabled: this.config?.watchdog?.enabled !== false,
      },
      health: {
        activeWorkers: this.children.size,
        maxWorkers: this.config?.worker?.maxWorkers ?? 4,
        dispatches: this.dispatchCount,
        journalBadLines: stats.journalBadLines,
        lastError: this.lastError,
      },
    }
    if (detail === 'full') snapshot.pending = pending
    snapshot.activity = this.activity(detail === 'full' ? 100 : 30)
    snapshot.models = {
      defaultId: this.modelViewCache?.defaultId,
      mode: this.modelViewCache?.mode,
      count: this.modelViewCache?.models.length ?? 0,
    }
    snapshot.agreements = { count: this.agreementItems.length, path: this.agreementsPath }
    snapshot.schedules = { count: this.lastSchedules.length, available: this.scheduleAvailable }
    return snapshot
  }

  /**
   * 近期活动：任务按最近更新时间倒序；默认包含已关闭任务，保证历史可回看。
   *
   * @param {number} [limit]
   * @param {{ includeClosed?: boolean }} [options]
   * @returns {object[]}
   */
  activity(limit = 30, options = {}) {
    const includeClosed = options.includeClosed !== false
    const rows = this.store.listTasks({ includeClosed }).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      project: task.project,
      cwd: task.cwd,
      workerSessionId: task.workerSessionId,
      continuedFrom: task.continuedFrom,
      speculative: task.speculative === true,
      model: task.modelId,
      modelLabel: task.modelLabel,
      reasoningEffort: task.reasoningEffort,
      approvalMode: task.approvalMode,
      pendingApproval: task.pendingApproval === undefined ? undefined : { ...task.pendingApproval },
      createdAt: task.createdAt,
      updatedAt: task.updatedAt ?? task.createdAt,
      reportCount: Array.isArray(task.reports) ? task.reports.length : 0,
      lastReport: task.lastReport === undefined
        ? undefined
        : { id: task.lastReport.id, reason: task.lastReport.reason, at: task.lastReport.at, preview: summaryOf(task.lastReport.text, 180) },
      steerCount: task.steerCount ?? 0,
      lastSteerAt: task.lastSteerAt,
      lastSteerMode: task.lastSteerMode,
      lastSteerInterrupt: task.lastSteerInterrupt === true,
      live: task.status !== 'closed' && typeof task.workerSessionId === 'string' && this.getAgent(task.workerSessionId) !== undefined,
    }))
    return rows
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(b.id).localeCompare(String(a.id)))
      .slice(0, Math.max(1, Math.min(500, limit)))
  }

  /**
   * 一条任务的详情，供面板的小窗口/工具使用。
   *
   * @param {string} taskId
   * @returns {object}
   */
  taskDetail(taskId) {
    const task = this.#requireTask(taskId)
    const reports = Array.isArray(task.reports) ? task.reports : []
    const threads = [...task.threadIds].map((threadId) => {
      const thread = this.store.getThread(threadId)
      if (thread === undefined) return { id: threadId, missing: true }
      const triggers = this.store.contextTriggers(threadId, undefined, 8).map((trigger) => ({
        id: trigger.id,
        source: trigger.source,
        kind: trigger.kind,
        actor: trigger.actor,
        addressed: trigger.addressed === true,
        summary: trigger.summary ?? summaryOf(trigger.text, 180),
        receivedAt: trigger.receivedAt,
        state: trigger.state,
      }))
      return {
        id: thread.id,
        source: thread.source,
        title: thread.title,
        triggerCount: thread.triggerIds.length,
        updatedAt: thread.updatedAt,
        triggers,
      }
    })
    return {
      ...this.activity(500, { includeClosed: true }).find((row) => row.id === task.id),
      brief: task.brief,
      threadIds: [...task.threadIds],
      reports: reports.map((report) => ({
        id: report.id,
        at: report.at,
        reason: report.reason,
        text: report.text,
        turn: report.turn,
        synthesized: report.synthesized === true,
        triggerId: report.triggerId,
      })),
      threads,
      steerCount: task.steerCount ?? 0,
      lastSteerAt: task.lastSteerAt,
      lastSteerMode: task.lastSteerMode,
      lastSteerInterrupt: task.lastSteerInterrupt === true,
      approvalMode: task.approvalMode,
      pendingApproval: task.pendingApproval === undefined ? undefined : { ...task.pendingApproval },
      lastApproval: task.lastApproval,
      closedReason: task.closedReason,
      lostReason: task.lostReason,
      workerLive: task.status !== 'closed' && typeof task.workerSessionId === 'string' && this.getAgent(task.workerSessionId) !== undefined,
    }
  }

  /** 模型视图（异步拉目录）+ 当前默认。 */
  async modelView(force = false) {
    const view = await this.refreshModels(force)
    return modelViewPayload(view)
  }

  /** 工具/UI 保存 allowlist 后，返回新视图。 */
  async saveModels(modelsConfig) {
    this.setModels(modelsConfig)
    return this.modelView(true)
  }

  /** 人类可读状态文本。 */
  statusText(detail = 'compact') {
    return renderStatus(this.status(detail), detail)
  }

  /** 链式召回；直接委托给 recall.js。 */
  recall(id, options = {}) {
    return recall(this.store, id, { now: this.now(), ...options })
  }

  /** 强制跑一次 Watchdog（工具/测试用）。 */
  checkNow() {
    return this.#checkWatchdog()
  }

  // ── Watchdog ─────────────────────────────────────────────────────────────

  #startWatchdog() {
    const interval = this.config?.watchdog?.intervalMs ?? 30_000
    this.watchdogTimer = this.timers.setInterval(() => {
      try {
        this.#checkWatchdog()
      } catch (error) {
        this.lastError = error.message
        this.log('warn', `watchdog 检查失败：${error.message}`)
      }
    }, interval)
    this.watchdogTimer?.unref?.()
  }

  /**
   * 外部 Control Loop。它只做两类事：
   *   1. 修复确定性的状态（丢失的 worker、卡住的 starting、可 flush 的积压）；
   *   2. 把需要模型判断的问题合成一条 watchdog Trigger，交给 Router。
   *
   * 没有问题时完全安静；同一个问题在 repeatMs 内不重复升级。
   */
  #checkWatchdog() {
    if (!this.active) return { issues: [], repairs: [] }
    // 恢复还没跑完时宿主里本来就没有 Worker，watchdog 结论一定是错的。
    if (this.restoring === true) return { issues: [], repairs: [] }
    const now = this.now()
    this.lastCheckAt = now
    const issues = []
    const repairs = []

    for (const task of this.store.listTasks()) {
      if (task.status === 'closed') {
        this.missingWorkers.delete(task.id)
        continue
      }
      const age = now - (task.startedAt ?? task.createdAt ?? now)
      if (task.status === 'starting' && age > (this.config?.watchdog?.startTimeoutMs ?? 120_000)) {
        issues.push({
          key: `task-start:${task.id}`,
          text: `task ${task.id} "${task.title}" has been ${task.status} for ${formatAge(age)}`,
          taskId: task.id,
        })
        this.controllers.get(task.id)?.abort?.()
        this.store.append({ t: 'task.updated', taskId: task.id, patch: { status: 'failed' } })
        this.#report(task, 'error', `worker did not start within ${formatAge(age)}; task marked failed. Decide whether to retry or close.`, undefined, true)
        repairs.push(`task ${task.id} marked failed`)
        continue
      }
      // starting 还没有真实 workerSessionId：session 目录/agent 注册可能还在写，
      // 启动是否成功只由上面的 startTimeoutMs 判定。这里若按“查不到会话”直接
      // 判 lost，就会在 spawn 完成前把刚创建的任务杀掉（P1-c 根因）。
      if (task.status === 'starting') {
        this.missingWorkers.delete(task.id)
        continue
      }
      if (typeof task.workerSessionId === 'string' && this.getAgent(task.workerSessionId) === undefined) {
        // 只有“本应在跑”的任务才算 lost。idle/blocked/failed 已经交过报告，
        // 会话被宿主回收不等于任务丢失；等后续 Thread 事件或 Router 决定。
        if (task.status === 'working' || task.status === 'blocked-approval') {
          // 二次探测 + 宽限窗口：第一次查不到只记录时间，下一次 watchdog 仍查不到
          // 且超过 lostGraceMs 才落 lost；避免宿主短暂换实例/事件循环抖动误杀。
          const grace = this.config?.watchdog?.lostGraceMs ?? 10_000
          const missedAt = this.missingWorkers.get(task.id)
          if (missedAt === undefined) {
            this.missingWorkers.set(task.id, now)
          } else if (now - missedAt >= grace && this.getAgent(task.workerSessionId) === undefined) {
            issues.push({
              key: `task-lost:${task.id}`,
              text: `task ${task.id} "${task.title}" has no live worker session`,
              taskId: task.id,
            })
            this.#markTaskLost(task, 'watchdog could not find the worker session')
            repairs.push(`task ${task.id} marked lost`)
          } else if (now - missedAt >= grace) {
            // 二次探测又找到了（宿主恢复/注册晚到），撤销宽限记录。
            this.missingWorkers.delete(task.id)
          }
        } else {
          this.missingWorkers.delete(task.id)
        }
        continue
      }
      this.missingWorkers.delete(task.id)
      if (task.status === 'blocked-approval' && task.pendingApproval !== undefined) {
        const pending = task.pendingApproval
        const waitingSince = pending.askedAt ?? task.updatedAt ?? now
        const waited = now - waitingSince
        if (pending.escalatedAt === undefined && waited > (this.config?.watchdog?.approvalTimeoutMs ?? 60_000)) {
          issues.push({
            key: `task-approval:${task.id}:${pending.id}`,
            text: `task ${task.id} "${task.title}" has been waiting ${formatAge(waited)} for approval of ${pending.toolName} (${pending.summary}); ask the user to allow or deny`,
            taskId: task.id,
            approvalId: pending.id,
          })
        }
        continue
      }
      const child = typeof task.workerSessionId === 'string' ? this.getAgent(task.workerSessionId) : undefined
      if (child !== undefined && task.status === 'working' && child.status === 'idle') {
        const since = now - (task.updatedAt ?? now)
        if (since > (this.config?.watchdog?.idleStaleMs ?? 300_000)) {
          issues.push({
            key: `task-idle:${task.id}`,
            text: `task ${task.id} is working but its worker has been idle for ${formatAge(since)} with no report`,
            taskId: task.id,
          })
          this.#report(task, 'completed', 'Worker is idle and no turn report was captured. It may have finished; inspect the worker session before closing.', undefined, true)
          repairs.push(`task ${task.id} synthesized a report`)
        }
      }
    }

    const pending = this.store.pendingTriggers(1000)
    if (pending.length > 0 && this.routerStatus() === 'idle') {
      const oldest = pending[0]
      const age = now - (oldest.receivedAt ?? now)
      if (age > (this.config?.watchdog?.pendingStaleMs ?? 90_000)) {
        issues.push({
          key: 'pending-backlog',
          text: `${pending.length} trigger(s) pending; oldest ${oldest.id} is ${formatAge(age)} old while the router is idle`,
        })
        this.flushNow()
        repairs.push('flushed pending triggers')
      }
    }

    if (this.store.listTasks().some((task) => task.status === 'queued')) this.#pump()

    const fresh = []
    const repeatMs = this.config?.watchdog?.repeatMs ?? 600_000
    for (const issue of issues) {
      const last = this.reportedIssues.get(issue.key)
      if (last !== undefined && now - last < repeatMs) continue
      this.reportedIssues.set(issue.key, now)
      if (typeof issue.approvalId === 'string') {
        // 审批超时只升级一次；journal 记下 escalatedAt，重启后也不会重复轰炸。
        this.store.append({
          t: 'approval.escalated',
          taskId: issue.taskId,
          approvalId: issue.approvalId,
          escalatedAt: now,
        })
      }
      fresh.push(issue)
    }
    const activeKeys = new Set(issues.map((issue) => issue.key))
    for (const key of [...this.reportedIssues.keys()]) {
      if (!activeKeys.has(key)) this.reportedIssues.delete(key)
    }
    this.lastIssues = issues

    if (fresh.length > 0) {
      this.store.append({
        t: 'watchdog.checked',
        issues: issues.map((issue) => ({ key: issue.key, text: issue.text, taskId: issue.taskId })),
        repairs,
      })
      const text = [
        'Watchdog found a problem that may need a decision:',
        ...fresh.map((issue) => `- ${issue.text}`),
        repairs.length > 0 ? `\nRepairs already applied: ${repairs.join('; ')}` : '',
        '\nUse superagent_status / superagent_recall to inspect. Close or steer affected tasks; do not re-dispatch blindly.',
      ].join('\n')
      this.ingest({
        source: 'watchdog',
        threadKey: 'watchdog',
        externalId: `watchdog:${now}`,
        kind: 'watchdog',
        actor: 'watchdog',
        title: 'Watchdog',
        text,
        direct: true,
        internal: true,
        meta: { issues: fresh.map((issue) => issue.key) },
      })
      this.scheduleFlush(0)
    }
    return { issues, repairs }
  }

  // ── 持久化恢复与 inbox watcher ─────────────────────────────────────────

  /**
   * 重启后恢复任务与 Worker 会话。
   *
   * 顺序是刻意的：先认领宿主里还活着的会话（runtime 自己重启的情况），再让宿主
   * 把磁盘上的会话救回来（进程重启的情况），最后才把救不回来的任务标成
   * `interrupted`。全程串行：一次把几十条会话同时装回内存没有意义。
   *
   * 明确不做的事：不重放被打断的那一轮 turn。会话能续，半截的 turn 不能。
   */
  async #recover() {
    const tasks = this.store.listTasks()
    if (tasks.length === 0) return
    this.restoring = true
    try {
      await this.#restoreTasks(tasks)
    } finally {
      this.restoring = false
    }
    this.#pump()
  }

  /** 逐条恢复；串行是为了不让几十条会话同时load进内存。 */
  async #restoreTasks(tasks) {
    for (const task of tasks) {
      if (!this.active) return
      const live = hasWorkerSession(task) ? this.getAgent(task.workerSessionId) : undefined
      const action = planRecovery(task, {
        live: live !== undefined,
        canResume: this.resumeWorker !== undefined,
      })
      if (action === 'skip') continue
      if (action === 'attach') {
        this.#attachWorker(task, live)
        if (task.status === 'starting') this.#updateTask(task, { status: 'working' })
        continue
      }
      const resumed = action === 'resume' ? await this.#resumeWorkerSession(task) : undefined
      if (!this.active) return
      if (resumed !== undefined) {
        this.#attachWorker(task, resumed)
        // 宿主可能把 id 规范化（见 index.js 的 createSessionWorker）：以返回的
        // agent 为准，否则后续 getAgent(workerSessionId) 会永远查不到。
        const canonical = resumed.session?.header?.id ?? resumed.id
        const patch = { ...resumedPatch(task, this.now()), ...(typeof canonical === 'string' && canonical.length > 0 && canonical !== task.workerSessionId ? { workerSessionId: canonical } : {}) }
        // 先判断再落盘：store 折叠后的 task 是同一个对象引用，更新后 task.status
        // 就已经变了。上一次重启报过「可续做」的任务，这次不再重复提醒。
        const announce = patch.status === RESUMABLE && task.status !== RESUMABLE
        this.#updateTask(task, patch)
        if (announce) this.#report(task, RESUMABLE, recoveryText('resumed', task), undefined, true)
        continue
      }
      // 救不回来：同一个任务在一次重启后只提醒一次，别每次启动都刷屏。
      if (task.status === INTERRUPTED && task.recoveryNotifiedAt !== undefined) continue
      this.#updateTask(task, interruptedPatch(this.now()))
      this.#report(task, INTERRUPTED, recoveryText('interrupted', task), undefined, true)
    }
  }

  /** 让宿主把一条 Worker 会话装回内存；失败只记 warn，返回 undefined。 */
  async #resumeWorkerSession(task) {
    try {
      const agent = await this.resumeWorker(task.workerSessionId)
      if (agent === undefined || agent === null) {
        this.log('warn', `Worker 会话 ${task.workerSessionId}（任务 ${task.id}）无法恢复`)
        return undefined
      }
      return agent
    } catch (error) {
      this.log('warn', `恢复 Worker 会话 ${task.workerSessionId} 失败：${error?.message ?? error}`)
      return undefined
    }
  }

  #loadCursor() {
    try {
      if (!existsSync(this.store.paths.cursor)) return
      const value = JSON.parse(readFileSync(this.store.paths.cursor, 'utf8'))
      if (Number.isFinite(value?.offset) && value.offset >= 0) this.inboxOffset = value.offset
    } catch {
      this.inboxOffset = 0
    }
  }

  #saveCursor(offset = this.inboxOffset) {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.store.paths.cursor, `${JSON.stringify({ offset, at: this.now() })}\n`)
    } catch (error) {
      this.log('warn', `写 cursor 失败（回退到去重键）：${error.message}`)
    }
  }

  #startInboxWatcher() {
    const interval = this.config?.inbox?.pollMs ?? 400
    this.inboxTimer = this.timers.setInterval(() => {
      try {
        this.pollInbox()
      } catch (error) {
        this.lastError = error.message
        this.log('warn', `inbox 轮询失败：${error.message}`)
      }
    }, interval)
    this.inboxTimer?.unref?.()
    // 启动时先读一次，避免最多等一个轮询周期。
    try {
      this.pollInbox()
    } catch {
      // 首次读取失败由下一轮重试。
    }
  }

  /**
   * 读取 `inbox.jsonl` 中尚未消费的行。CLI 只负责追加；这里按字节偏移消费，
   * 崩溃后从 cursor 继续。重复行由 `externalId` 去重兜底。
   *
   * @returns {number} 本次消费的事件数。
   */
  pollInbox() {
    if (!this.active) return 0
    const path = this.store.paths.inbox
    if (!existsSync(path)) return 0
    let size
    try {
      size = statSync(path).size
    } catch {
      return 0
    }
    if (size < this.inboxOffset) {
      this.inboxOffset = 0
      this.inboxRemainder = Buffer.alloc(0)
    }
    if (size === this.inboxOffset) return 0
    const chunk = readSlice(path, this.inboxOffset, size - this.inboxOffset)
    if (chunk === undefined) return 0
    // 只在完整行上推进 cursor；末尾可能是半行，也可能正好切在多字节
    // UTF-8 字符中间。保留字节 remainder，下一次拼接后再解码。
    const combined = Buffer.concat([this.inboxRemainder ?? Buffer.alloc(0), chunk])
    const lastNewline = combined.lastIndexOf(0x0a)
    const complete = lastNewline >= 0 ? combined.subarray(0, lastNewline + 1) : Buffer.alloc(0)
    this.inboxRemainder = lastNewline >= 0 ? combined.subarray(lastNewline + 1) : combined
    let consumed = 0
    for (const line of complete.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        this.log('warn', 'inbox 行不是合法 JSON，已跳过')
        continue
      }
      if (!isRecord(event)) continue
      const result = this.ingest({
        source: event.source,
        threadKey: event.threadKey,
        externalId: event.id ?? event.externalId ?? eventId(),
        kind: event.kind,
        actor: event.actor,
        title: event.title,
        text: event.text,
        url: event.url,
        mentions: event.mentions,
        direct: event.direct,
        meta: event.meta,
        receivedAt: Number.isFinite(event.receivedAt) ? event.receivedAt : undefined,
      })
      if (result?.ok) consumed += 1
    }
    this.inboxOffset += chunk.length
    // cursor 指向 remainder 的起点：若进程在半个多字节字符处退出，下次会
    // 从该字节重新读取，而不是从半个字符之后开始。
    this.#saveCursor(this.inboxOffset - this.inboxRemainder.length)
    return consumed
  }

  // ── 供工具层调用的便捷读 ───────────────────────────────────────────────

  /** pending Trigger 的 Inline 行，用于状态/调试。 */
  pendingLines(limit = 20) {
    return this.store.pendingTriggers(limit).map((trigger) => inlineTrigger(trigger, {
      inlineChars: this.config?.router?.inlineChars,
      now: this.now(),
    }))
  }

  /** 当前配置里的信道名，供工具描述使用。 */
  channelNames() {
    return Object.keys(this.config?.channels ?? {})
  }

  /** 自检信息（HTTP /status）。 */
  health() {
    return {
      ok: this.active && !this.closed,
      router: this.agent?.id,
      pending: this.store.pendingTriggers(1000).length,
      pendingLines: this.pendingLines(8),
      lastError: this.lastError,
      lastCheckAt: this.lastCheckAt,
      issues: this.lastIssues,
    }
  }
}

/** 必填字符串 + 长度上限。 */
function requireText(value, field, maxChars) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeInputError(`${field} is required and must be non-empty`, 'missing_field')
  }
  if (Array.from(value).length > maxChars) {
    throw new RuntimeInputError(`${field} is longer than ${maxChars} characters`, 'too_long')
  }
  return value
}

/** Thread id 列表：去重、最多 8 个、只接受 thr_ 前缀。 */
function normalizeThreadIds(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RuntimeInputError('thread_ids must be an array of thread ids')
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.startsWith('thr_')) {
      throw new RuntimeInputError(`thread_ids entries must start with thr_: ${String(item)}`)
    }
    if (!out.includes(item)) out.push(item)
    if (out.length > 8) throw new RuntimeInputError('at most 8 thread ids can be attached to one task')
  }
  return out
}
