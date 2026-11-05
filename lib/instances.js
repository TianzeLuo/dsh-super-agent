/**
 * instances.js — Super-agent 多实例注册表。
 *
 * 实例是 UI/运行时的隔离单位：
 * - 名称只用于展示；id 稳定，目录不随重命名移动。
 * - `home` 相对锚点 workspace 根保存（默认实例是 `.`，保证旧数据原地升级）。
 * - `unread` 与注册表一起持久化，刷新/重启后未读数不会凭空消失。
 *
 * 这里不创建目录、不登记 DSH workspace，也不做任何清理；那些属于宿主侧的
 * `ensureInstanceHome`。纯注册表便于单元测试，同时避免把文件系统副作用塞进
 * 读取路径。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_INSTANCE_ID = 'default'
export const DEFAULT_INSTANCE_NAME = 'Super-agent'
export const INSTANCE_HOME_DIR = 'instances'
export const INSTANCE_REGISTRY_RELATIVE = join('.dsh', 'instances.json')
export const MAX_INSTANCE_NAME_LENGTH = 40

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 注册表文件绝对路径。 */
export function instanceRegistryPath(root) {
  return join(root, INSTANCE_REGISTRY_RELATIVE)
}

/** 实例 home 的绝对路径；默认实例就是锚点根目录。 */
export function instanceHome(root, record) {
  if (record?.home === undefined || record.home === '.' || record.home === '') return resolve(root)
  return resolve(root, record.home)
}

/** 展示名规范化；调用方在失败时直接显示错误。 */
export function normalizeInstanceName(input) {
  if (typeof input !== 'string') return undefined
  const name = input.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > MAX_INSTANCE_NAME_LENGTH) return undefined
  // 换行/控制字符会让下拉项和日志不可读。
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined
  return name
}

/** 注册表行校验；坏行忽略，不让一个手改坏的名字拖垮整个面板。 */
function normalizeRecord(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const id = typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : undefined
  const name = normalizeInstanceName(input.name)
  if (id === undefined || name === undefined) return undefined
  const home = typeof input.home === 'string' && input.home.length > 0
    ? (input.home === '.' ? '.' : input.home.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    : (id === DEFAULT_INSTANCE_ID ? '.' : `${INSTANCE_HOME_DIR}/${id}`)
  // 只接受注册表自己产生的相对目录；绝对路径/`..` 一律不认。
  if (home !== '.' && (!home.startsWith(`${INSTANCE_HOME_DIR}/`) || home.split('/').includes('..'))) return undefined
  const createdAt = typeof input.createdAt === 'string' && input.createdAt.length > 0
    ? input.createdAt
    : new Date(0).toISOString()
  const unreadRaw = Number(input.unread)
  const unread = Number.isFinite(unreadRaw) && unreadRaw > 0 ? Math.floor(unreadRaw) : 0
  return { id, name, home, createdAt, unread }
}

function defaultRecord() {
  return {
    id: DEFAULT_INSTANCE_ID,
    name: DEFAULT_INSTANCE_NAME,
    home: '.',
    createdAt: new Date().toISOString(),
    unread: 0,
  }
}

function sameName(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
}

/**
 * 实例注册表。构造时读取/迁移；写操作同步落盘，避免未读数在进程退出时丢。
 */
export class InstanceRegistry {
  /**
   * @param {string} root 锚点 workspace 根（也是默认实例 home）。
   * @param {{ log?: (level: string, message: string) => void }} [options]
   */
  constructor(root, options = {}) {
    this.root = resolve(root)
    this.log = typeof options.log === 'function' ? options.log : () => undefined
    this.file = instanceRegistryPath(this.root)
    this.records = []
    this.load()
  }

  load() {
    let raw
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log('warn', `实例注册表无法读取，改用默认实例：${error.message}`)
      }
      this.records = [defaultRecord()]
      this.persist()
      return
    }
    const rows = Array.isArray(raw?.instances) ? raw.instances : []
    const seen = new Set()
    for (const row of rows) {
      const record = normalizeRecord(row)
      if (record === undefined || seen.has(record.id)) {
        this.log('warn', '实例注册表包含无效/重复条目，已忽略')
        continue
      }
      seen.add(record.id)
      this.records.push(record)
    }
    if (!seen.has(DEFAULT_INSTANCE_ID)) this.records.unshift(defaultRecord())
    // 名称重复时保留先出现的；后续重命名会被拒绝。
    this.persist()
  }

  persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload = {
        version: 1,
        instances: this.records.map((record) => ({
          id: record.id,
          name: record.name,
          home: record.home,
          createdAt: record.createdAt,
          unread: record.unread,
        })),
      }
      writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`)
    } catch (error) {
      this.log('warn', `实例注册表写入失败：${error.message}`)
    }
  }

  /** 对外视图：附带绝对 home，调用方不需要再拼路径。 */
  view(record) {
    return { ...record, home: instanceHome(this.root, record) }
  }

  list() {
    return this.records.map((record) => this.view(record))
  }

  get(id) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    const record = this.records.find((candidate) => candidate.id === id)
    return record === undefined ? undefined : this.view(record)
  }

  getDefault() {
    const record = this.records.find((candidate) => candidate.id === DEFAULT_INSTANCE_ID) ?? this.records[0]
    return record === undefined ? undefined : this.view(record)
  }

  findByHome(path) {
    if (typeof path !== 'string' || path.length === 0) return undefined
    const target = resolve(path)
    const record = this.records.find((candidate) => instanceHome(this.root, candidate) === target)
    return record === undefined ? undefined : this.view(record)
  }

  unreadTotal() {
    return this.records.reduce((sum, record) => sum + record.unread, 0)
  }

  assertName(name, exceptId) {
    const normalized = normalizeInstanceName(name)
    if (normalized === undefined) {
      throw new Error(`实例名称需为 1–${MAX_INSTANCE_NAME_LENGTH} 个可见字符`)
    }
    const duplicate = this.records.some((record) => record.id !== exceptId && sameName(record.name, normalized))
    if (duplicate) throw new Error(`实例名称已存在：${normalized}`)
    return normalized
  }

  /** 创建实例记录；目录由宿主 ensureInstanceHome 负责。 */
  create(name) {
    const normalized = this.assertName(name)
    const id = `inst-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const record = {
      id,
      name: normalized,
      home: `${INSTANCE_HOME_DIR}/${id}`,
      createdAt: new Date().toISOString(),
      unread: 0,
    }
    this.records.push(record)
    this.persist()
    return this.view(record)
  }

  rename(id, name) {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) throw new Error(`未知实例：${id}`)
    record.name = this.assertName(name, id)
    this.persist()
    return this.view(record)
  }

  setUnread(id, value) {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) return undefined
    const next = Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0
    if (record.unread !== next) {
      record.unread = next
      this.persist()
    }
    return this.view(record)
  }

  clearUnread(id) {
    return this.setUnread(id, 0)
  }

  addUnread(id) {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) return undefined
    record.unread += 1
    this.persist()
    return this.view(record)
  }

  /** 启动/迁移时只创建默认实例需要的最小目录，不触碰任何已有文件。 */
  ensureDefaultHome() {
    const home = instanceHome(this.root, this.records.find((record) => record.id === DEFAULT_INSTANCE_ID) ?? this.records[0])
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
    return home
  }
}
