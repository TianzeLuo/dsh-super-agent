/**
 * schedule-bridge.js — 宿主 `ctx.schedule` 的薄适配。
 *
 * 两代宿主契约：
 *
 *   0.2.1 及更早（按会话）
 *     create(sessionId, request)          request 里带扁平选择器
 *     list({ sessionId })                 → 记录数组
 *     delete({ sessionId, id })           → { id, deleted }
 *
 *   0.2.2 起（宿主级，DSH upgrade-guide `schedule-remote-host-tasks`）
 *     create({ title, prompt, timing, target }, actorSessionId?) → ScheduleCatalogEntry
 *     list({ active?, limit?, offset? })  → { items, shown, total, limit, offset }
 *     catalog()                           → 全部任务
 *     edit({ id, action: 'delete' }, actorSessionId?) → { id, deleted }
 *     删除按会话的 delete/update
 *
 * 用 `edit` 是否存在区分两代（旧服务只有 delete/update）。runtime 只认一种扁平视图，
 * 这里把两代都整理成同一个形状，插件本身不需要知道宿主版本。
 */

/**
 * 0.2.2 的宿主级记录属于哪条会话。
 *
 * 目的会话是本会话，或本会话创建/被通知（`involvedSessionIds`）的任务都算；
 * `new` 目标每次新建会话，创建者仍记在 involved 里，所以也能列出来。
 *
 * @param {object} entry 宿主 ScheduleCatalogEntry。
 * @param {string} sessionId 当前 Router 会话 id。
 * @returns {boolean}
 */
export function scheduleBelongsTo(entry, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  const target = entry?.target
  if (target?.kind === 'session' && target.sessionId === sessionId) return true
  if (target?.sessionId === sessionId) return true
  return Array.isArray(entry?.involvedSessionIds) && entry.involvedSessionIds.includes(sessionId)
}

/**
 * 插件内部的扁平选择器 → 0.2.2 宿主要求的 typed `timing`。
 *
 * runtime 的 `#normalizeScheduleSelector` 与 objectives 的 `scheduleSelector`
 * 已经补好墙钟时区，这里只做形状转换。
 *
 * @param {object} request `{ after_seconds?, at?, every_seconds?, daily?, weekly?, cron? }`
 * @returns {object} `{ kind, ... }`
 */
export function scheduleTiming(request) {
  if (request.after_seconds !== undefined) return { kind: 'after', after_seconds: request.after_seconds }
  if (request.at !== undefined) return { kind: 'at', at: request.at }
  if (request.every_seconds !== undefined) return { kind: 'every', every_seconds: request.every_seconds }
  if (request.daily !== undefined) return { kind: 'daily', daily: request.daily }
  if (request.weekly !== undefined) return { kind: 'weekly', weekly: request.weekly }
  if (request.cron !== undefined) return { kind: 'cron', cron: request.cron }
  throw new Error('a schedule needs one timing selector')
}

/**
 * 造一个 runtime 可用的 schedule 适配器。
 *
 * @param {() => object|undefined} getService 每次调用时读取宿主 schedule 服务。
 * @returns {{ list: Function, create: Function, cancel: Function }}
 */
export function createScheduleBridge(getService) {
  const hostWide = (service) => typeof service?.edit === 'function'
  return {
    /** 宿主是否真的挂了 schedule 服务（未挂时 runtime 显示 unavailable，而不是空列表）。 */
    get available() {
      const service = getService()
      return typeof service?.list === 'function' && typeof service?.create === 'function'
    },
    async list(sessionId) {
      const service = getService()
      if (typeof service?.list !== 'function') return []
      if (hostWide(service)) {
        // catalog() 不分页；老一点的 0.2.2 若没有它，退回一页足够大的 list。
        const entries = typeof service.catalog === 'function'
          ? await service.catalog()
          : (await service.list({ limit: 500 }))?.items
        const rows = Array.isArray(entries) ? entries : []
        // 只把 active 的算进“进行中”，paused/ended 不进列表也不占 maxActive。
        return rows.filter((entry) => (entry?.status ?? 'active') === 'active' && scheduleBelongsTo(entry, sessionId))
      }
      const value = await service.list({ sessionId })
      if (Array.isArray(value)) return value
      throw Object.assign(new Error(value?.message ?? value?.code ?? 'schedule list failed'), { code: value?.code })
    },
    async create(sessionId, request) {
      const service = getService()
      if (typeof service?.create !== 'function') throw new Error('schedule service is unavailable')
      const value = hostWide(service)
        ? await service.create({
          title: request.title,
          prompt: request.prompt,
          timing: scheduleTiming(request),
          target: { kind: 'session', sessionId },
        }, sessionId)
        : await service.create(sessionId, request)
      if (value !== undefined && value !== null && value.id !== undefined) return value
      throw Object.assign(new Error(value?.message ?? 'schedule create failed'), { code: value?.code })
    },
    async cancel(sessionId, id) {
      const service = getService()
      if (hostWide(service)) {
        const value = await service.edit({ id, action: 'delete' }, sessionId)
        if (value?.deleted === true) return { id, deleted: true }
        if (value?.code !== undefined) throw Object.assign(new Error(value.message ?? value.code), { code: value.code })
        return value ?? { id, deleted: true }
      }
      if (typeof service?.delete !== 'function') throw new Error('schedule service is unavailable')
      const value = await service.delete({ sessionId, id })
      if (value?.code !== undefined && value.deleted !== true) {
        throw Object.assign(new Error(value.message ?? value.code), { code: value.code })
      }
      return value ?? { id, deleted: true }
    },
  }
}
