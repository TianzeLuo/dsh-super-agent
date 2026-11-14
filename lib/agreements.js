/**
 * agreements.js — 长期工作约定（working agreements）。
 *
 * 这是 dot「Rules / Memory」在 super-agent 里的对应物：用户说「以后都……」时，
 * Router 把这条长期约束记下来，之后：
 *
 *   - 注入 Router 的动态上下文，影响它自己的判断与措辞；
 *   - 注入每个 Worker 的首条任务消息，影响真正干活的人；
 *   - 在面板的 Rules 抽屉里可查看、编辑、停用、删除。
 *
 * 为什么不用 journal：约定是**跨 generation 的配置型状态**。面板的 Reset 会切到
 * 新的数据目录，但用户不希望在“重置活动记录”时丢掉「回复先给结论」这类长期约定。
 * 因此它们保存在项目根 `.dsh/super-agent.agreements.json`，与 `super-agent.json`
 * 同级；journal 继续只负责可重放的任务/触发器事实。
 *
 * 作用域：
 *   - 没有 `project` 的约定是全局约定；
 *   - 带 `project` 的约定只在该项目生效；
 *   - 项目约定默认追加在全局之后；某项目只要有一条 `mode: "replace"`，该项目就
 *     只用项目约定，不再注入全局约定（给「这个仓库例外」留出口）。
 *
 * 本模块不依赖 DSH 包；读写失败返回 warnings，不让插件启动失败。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** 文件格式版本。 */
export const AGREEMENTS_VERSION = 1

/** 单条约定的硬上限（正常由 config 收紧）。 */
export const HARD_MAX_ITEMS = 200
export const HARD_MAX_CHARS = 20_000
export const HARD_MAX_TITLE = 200

/** 约定文件路径；`fileName` 只允许单段文件名，防止路径越界。 */
export function agreementStorePath(projectRoot, fileName = 'super-agent.agreements.json') {
  const safe = typeof fileName === 'string' && fileName.length > 0 && !fileName.includes('/') && !fileName.includes('\\')
    ? fileName
    : 'super-agent.agreements.json'
  return join(resolve(projectRoot), '.dsh', safe)
}

/** 规范化 id 列表之外的文本：去首尾空白，保留内部换行。 */
export function normalizeAgreementText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

/** 从正文生成一个短标题。 */
export function agreementTitle(text, fallback = 'Working agreement') {
  const firstLine = normalizeAgreementText(text).split('\n').find((line) => line.trim().length > 0) ?? ''
  const single = firstLine.replace(/\s+/g, ' ').trim()
  if (single.length === 0) return fallback
  const points = Array.from(single)
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : single
}

/** 读取约定文件；不存在、损坏都返回空列表 + warning。 */
export function readAgreements(path, options = {}) {
  const warnings = []
  if (!existsSync(path)) return { exists: false, items: [], warnings }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { exists: true, items: [], warnings: [`无法解析 ${path}：${error.message}`] }
  }
  const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  const items = []
  for (const [index, raw] of rawItems.entries()) {
    const item = normalizeAgreement(raw, options)
    if (item === undefined) {
      warnings.push(`约定文件第 ${index + 1} 条无效，已忽略`)
      continue
    }
    items.push(item)
  }
  return { exists: true, items, warnings }
}

/** 规范化一条约定；无效返回 undefined。 */
export function normalizeAgreement(raw, options = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(1, Math.min(HARD_MAX_CHARS, options.maxChars)) : HARD_MAX_CHARS
  const normalizedText = normalizeAgreementText(raw.text)
  const text = normalizedText.length > maxChars ? Array.from(normalizedText).slice(0, maxChars).join('') : normalizedText
  if (text.length === 0) return undefined
  const id = typeof raw.id === 'string' && /^agr_[a-z0-9]+$/i.test(raw.id) ? raw.id : undefined
  const title = typeof raw.title === 'string' && raw.title.trim().length > 0
    ? raw.title.trim().slice(0, HARD_MAX_TITLE)
    : agreementTitle(text)
  const project = typeof raw.project === 'string' && raw.project.trim().length > 0
    ? resolve(raw.project.trim())
    : ''
  const projectTitle = typeof raw.projectTitle === 'string' && raw.projectTitle.trim().length > 0
    ? raw.projectTitle.trim()
    : project.length > 0 ? basename(project) : undefined
  const mode = raw.mode === 'replace' ? 'replace' : 'append'
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  return {
    ...(id === undefined ? {} : { id }),
    title,
    text,
    project,
    ...(projectTitle === undefined ? {} : { projectTitle }),
    mode,
    enabled: raw.enabled !== false,
    createdAt,
    updatedAt,
    ...(typeof raw.topicId === 'string' && /^topic-[a-z0-9-]{1,64}$/.test(raw.topicId) ? { topicId: raw.topicId } : {}),
  }
}

/** 写入约定文件。直接覆盖一个小 JSON 文件；不删除、不镜像。 */
export function writeAgreements(path, items) {
  mkdirSync(dirname(path), { recursive: true })
  const payload = {
    version: AGREEMENTS_VERSION,
    updatedAt: Date.now(),
    items: items.map((item) => ({ ...item })),
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return path
}

/** 文件修改时间；用于发现外部编辑器改动。 */
export function agreementsMtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 某项目实际生效的约定。 */
export function agreementsForProject(items, projectPath) {
  const active = items.filter((item) => item.enabled !== false)
  const global = active.filter((item) => item.project.length === 0)
  const normalizedProject = typeof projectPath === 'string' && projectPath.length > 0 ? resolve(projectPath) : ''
  if (normalizedProject.length === 0) return global
  const scoped = active.filter((item) => item.project === normalizedProject)
  if (scoped.some((item) => item.mode === 'replace')) return scoped
  return [...global, ...scoped]
}

/**
 * 渲染成有界文本块。返回 `{ text, shown, total, truncated }`。
 *
 * @param {object[]} items 已按作用域过滤的约定。
 * @param {{ maxChars?: number }} [options]
 */
export function renderAgreements(items, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, options.maxChars) : 6_000
  if (items.length === 0) return { text: '', shown: 0, total: 0, truncated: false }
  const lines = []
  let chars = 0
  let shown = 0
  for (const item of items) {
    const scope = item.project.length > 0 ? `[project ${item.projectTitle ?? item.project}]` : '[global]'
    const line = `- ${scope} ${item.text}`
    const remaining = maxChars - chars
    if (remaining <= 0) {
      return { text: lines.join('\n'), shown, total: items.length, truncated: true }
    }
    if (line.length + 1 > remaining) {
      if (shown === 0) {
        lines.push(Array.from(line).slice(0, Math.max(0, remaining - 1)).join(''))
        shown = 1
      }
      return { text: lines.join('\n'), shown, total: items.length, truncated: true }
    }
    lines.push(line)
    chars += line.length + 1
    shown += 1
  }
  return { text: lines.join('\n'), shown, total: items.length, truncated: shown < items.length }
}

/** 去掉 id/时间戳等内部字段，提供 JSON 安全的视图。 */
export function agreementView(item) {
  return {
    id: item.id,
    title: item.title,
    text: item.text,
    project: item.project,
    projectTitle: item.projectTitle,
    mode: item.mode,
    enabled: item.enabled,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.topicId ? { topicId: item.topicId } : {}),
  }
}

/** 一条约定是否适用于某个绝对路径（用于 status/工具过滤）。 */
export function agreementApplies(item, projectPath) {
  if (item.enabled === false) return false
  if (item.project.length === 0) return true
  return typeof projectPath === 'string' && resolve(projectPath) === item.project
}

/** 组合路径：项目根 + 文件名，绝对路径原样返回。 */
export function resolveAgreementStorePath(projectRoot, fileName) {
  if (typeof fileName === 'string' && isAbsolute(fileName)) return fileName
  return agreementStorePath(projectRoot, fileName)
}
