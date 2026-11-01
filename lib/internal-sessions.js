/**
 * internal-sessions.js — 把「内部 worker 会话」登记给 dsh-away-notify。
 *
 * 为什么需要它：super-agent 派发的 worker 是**普通 Session**（跨项目写要求
 * `header.cwd` 就是目标项目，因此走 `sessionController.create()`），header 上没有
 * `origin: 'subagent'`、也没有 `delegationDepth`（实测 header：
 * `{"isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}`）。
 * dsh-away-notify 只能按标题前缀 `Super-agent worker · …` 兜底识别内部会话，用户一改名
 * 就失效；反过来由**创建方主动登记**，标题怎么改都不影响通知判定。
 *
 * 与 away-notify 的契约（`awayNotify` 服务的 v1 增量方法，见其 `lib/suppress.js`）：
 *   `markInternal(sessionId, reason) -> release()`，语义是「这条会话是内部会话，
 *   `rootsOnly` 生效时不要打扰」，与标题前缀那条路径共用同一个 `internal-session`
 *   判定与日志原因。
 *
 * 本模块的三条硬约束（不满足就会把通知链路或 worker 创建拖下水）：
 *   1. **静默降级**：away-notify 未安装、没有 `markInternal`、调用抛错——一律什么都不做，
 *      worker 照常创建/关闭，退回标题前缀兜底。
 *   2. **增量 + 幂等**：按 sessionId 登记，重复 `register()` 不会产生第二条声明；
 *      `release()` 后不会再登记。长期运行不累积规则（这里最多一个 Set + 一个 Map）。
 *   3. **服务换实例要重登记**：away-notify 重载后是一个新的注册表，旧句柄失效；
 *      `sync()` 丢掉指向旧实例的句柄，并把当前活着的会话补登记到新实例上。
 */

/** 登记时使用的 reason 标签（会进 away-notify 的日志与 `op:'state'` 诊断）。 */
export const INTERNAL_REASON = 'super-agent-worker'

/** 释放函数兜底：调用方（第三方插件）返回非函数时也要能安全 release。 */
const NOOP = () => undefined

export class InternalSessionClaims {
  /** 仍然活着的内部会话 id。 */
  #ids = new Set()

  /** sessionId -> { service, release }；句柄属于登记时的那个服务实例。 */
  #claims = new Map()

  /** 现取 awayNotify 服务（服务可能晚于本插件就绪，也可能重载换实例）。 */
  #service

  #log

  /** 「拿不到可用服务」只提示一次，避免每个 worker 刷一行日志。 */
  #degraded = false

  /**
   * @param {object} [options]
   * @param {() => object | undefined} [options.service] 现取 `awayNotify` 服务。
   * @param {(level: string, message: string) => void} [options.log] 诊断出口（默认静默）。
   */
  constructor({ service = () => undefined, log = NOOP } = {}) {
    this.#service = service
    this.#log = typeof log === 'function' ? log : NOOP
  }

  /** 仍然活着的内部会话数量。 */
  get size() {
    return this.#ids.size
  }

  /** 当前持有的登记句柄数量（正常情况下等于 `size`）。 */
  get claimed() {
    return this.#claims.size
  }

  /** 仍然活着的内部会话 id（诊断/清理用）。 */
  ids() {
    return [...this.#ids]
  }

  /**
   * 登记一条内部会话：先记进「活着的集合」，再尝试向 awayNotify 声明。
   *
   * @param {string} sessionId 会话 id。
   * @returns {boolean} 是否记入集合（与「是否成功声明」无关——服务缺失时仍返回 true，
   *   以便服务晚到后由 `sync()` 补登记）。
   */
  register(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    this.#ids.add(sessionId)
    this.#claim(sessionId)
    return true
  }

  /**
   * 撤销一条内部会话的登记（worker 关闭/归档/agent 销毁时调用）。
   *
   * @param {string} sessionId 会话 id。
   * @returns {boolean} 这次调用是否真的移除了它（重复调用返回 false）。
   */
  release(sessionId) {
    if (typeof sessionId !== 'string') return false
    const tracked = this.#ids.delete(sessionId)
    const claim = this.#claims.get(sessionId)
    // 句柄可能还在、集合里却已经没有了（clear 的中间态）：仍然要释放，否则会漏
    if (!tracked && claim === undefined) return false
    this.#claims.delete(sessionId)
    try {
      claim?.release?.()
    } catch {
      // away-notify 已经卸载/换实例时 release 可能抛错：忽略，不能影响 worker 关闭。
    }
    return true
  }

  /**
   * 服务（重新）可用时调用：丢掉指向旧实例的句柄，并给当前活着的会话补登记。
   *
   * away-notify 晚于 super-agent 加载、或热重载换了一个新的注册表时，都必须走这里，
   * 否则「已登记」只停留在我们的 Map 里，通知侧其实早就没有声明了。
   *
   * @returns {number} 当前有效句柄数量。
   */
  sync() {
    const service = this.#current()
    for (const [sessionId, claim] of this.#claims) {
      if (claim.service !== service) this.#claims.delete(sessionId)
    }
    for (const sessionId of this.#ids) this.#claim(sessionId)
    return this.#claims.size
  }

  /**
   * 撤销全部登记（插件卸载时调用）。
   *
   * @returns {number} 撤销的会话数量。
   */
  clear() {
    // 逐个走 release：它同时清集合、清句柄并调用第三方的释放函数
    const ids = new Set([...this.#ids, ...this.#claims.keys()])
    let n = 0
    for (const sessionId of ids) if (this.release(sessionId)) n += 1
    this.#claims.clear()
    return n
  }

  /** 现取服务；取不到（或抛错）返回 undefined。 */
  #current() {
    try {
      return this.#service() ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 声明单条会话。已登记到**同一个**服务实例时直接返回（幂等）；服务缺失时静默跳过。
   *
   * @param {string} sessionId 会话 id。
   * @returns {boolean} 是否持有有效句柄。
   */
  #claim(sessionId) {
    const service = this.#current()
    const mark = service?.markInternal
    if (typeof mark !== 'function') {
      this.#noteDegraded()
      return false
    }
    const existing = this.#claims.get(sessionId)
    if (existing !== undefined) {
      if (existing.service === service) return true
      // 旧实例的注册表已经没了：句柄直接丢弃，不能拿着它去 release
      this.#claims.delete(sessionId)
    }
    try {
      const release = mark.call(service, sessionId, INTERNAL_REASON)
      this.#claims.set(sessionId, {
        service,
        release: typeof release === 'function' ? release : NOOP,
      })
      return true
    } catch (error) {
      this.#log('debug', `向 awayNotify 登记内部会话失败（退回标题前缀）：${error?.message ?? error}`)
      return false
    }
  }

  /** 只在第一次「没有可用服务」时提示，避免刷日志。 */
  #noteDegraded() {
    if (this.#degraded) return
    this.#degraded = true
    this.#log('debug', 'awayNotify 不可用（未安装或缺 markInternal）：内部 worker 退回标题前缀识别')
  }
}
