/**
 * client.js — Super-agent 的浏览器半部。
 *
 * 左栏「Super-agent」入口 → main 面板 → 嵌入式官方会话。面板本身不是另一套聊天
 * 协议：它 retain 一条真正的 DSH 根会话（由宿主 `/api/super-agent/ui/ensure` 创建，
 * 本插件的 Router 提示词和工具装在这条会话上），再把官方 `conversation.content`
 * 工厂渲染进面板。所以消息流、停止按钮、审批、模型选择都仍是官方实现。
 *
 * 面板没有项目选择器：项目由 Router 通过 `superagent_projects` 自主发现，
 * dispatch 时用 `project` 选中。Router 的运行目录只是宿主，不是任务的目标目录。
 *
 * 约束（DSH 0.1.7）：只能 require seed 静态模块；本文件只 require `react`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-super-agent',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }

    const NS = 'super-agent'
    const PANEL_ID = 'super-agent'
    /**
     * 面板 retain 会话用的来源名。
     *
     * 两个用途必须共用这一个常量：
     *   1. `sessions.retain(sessionId, { source: PANEL_SOURCE })` —— 面板把 Router 会话
     *      挂进主区域；
     *   2. `awayNotifyPanels.register({ panelId: PANEL_ID, sources: [PANEL_SOURCE] })` ——
     *      告诉 dsh-away-notify「点来源为它的通知时，该打开这个面板」。
     *
     * 改名字只改一处，通知落点不会和实际 retain 的来源错位（见 docs/design.md 不变量 14）。
     */
    const PANEL_SOURCE = 'superAgentUi'
    /** 本插件自己的 session 作用域子槽；名字不能和官方槽冲突。 */
    const CONVERSATION_SLOT = 'super-agent.conversation'
    /** 官方会话内容工厂（由 dsh-client-ui-conversation 声明）。 */
    const CONTENT_FACTORY = 'conversation.content'
    const ROUTES = {
      ensure: '/api/super-agent/ui/ensure',
      state: '/api/super-agent/ui/state',
      reset: '/api/super-agent/ui/reset',
    }
    const POLL_MS = 4_000

    const DICT = {
      zh: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'refresh': '刷新',
        'openSession': '在会话中打开',
        'loading': '正在准备 Super-agent…',
        'retry': '重试',
        'error': 'Super-agent 暂不可用',
        'errorNoSession': '会话服务不可用（缺少 sessions）。',
        'errorNoProvider': '面板无法绑定会话（缺少 SessionProvider）。',
        'errorNoSlot': '面板无法渲染官方会话（缺少 conversation.content）。',
        'errorNoFetch': '宿主没有注册 Super-agent UI 接口。',
        'ensureFailed': '无法启动 Super-agent：{reason}',
        'noRouter': 'Router 尚未启动。',
        'idle': '空闲',
        'running': '运行中',
        'workers': '{count} 个 Worker',
        'pending': '{count} 条待处理触发',
        'tasks': '{count} 个任务',
        'statusUnknown': '状态未知',
        'activityTitle': '近期活动',
        'showMore': '显示更多',
        'hideMore': '收起',
        'reset': '重置',
        'resetConfirm': '确认重置',
        'resetting': '重置中…',
        'resetNote': '将中止当前任务并新建会话。',
        'resetFailed': '重置失败：{reason}',
        'statusQueued': '排队',
        'statusStarting': '启动中',
        'statusWorking': '执行中',
        'statusIdle': '已完成',
        'statusBlocked': '等待',
        'statusFailed': '失败',
        'statusInterrupted': '已中断',
        'statusLost': '已丢失',
        'statusClosed': '已关闭',
      },
      en: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'refresh': 'Refresh',
        'openSession': 'Open as session',
        'loading': 'Preparing Super-agent…',
        'retry': 'Retry',
        'error': 'Super-agent is unavailable',
        'errorNoSession': 'Session service unavailable (sessions).',
        'errorNoProvider': 'Panel cannot bind a session (SessionProvider).',
        'errorNoSlot': 'Panel cannot render the official conversation (conversation.content).',
        'errorNoFetch': 'The host did not register the Super-agent UI API.',
        'ensureFailed': 'Could not start Super-agent: {reason}',
        'noRouter': 'Router is not running yet.',
        'idle': 'Idle',
        'running': 'Running',
        'workers': '{count} worker(s)',
        'pending': '{count} pending trigger(s)',
        'tasks': '{count} task(s)',
        'statusUnknown': 'Unknown status',
        'activityTitle': 'Recent activity',
        'showMore': 'Show more',
        'hideMore': 'Show less',
        'reset': 'Reset',
        'resetConfirm': 'Confirm reset',
        'resetting': 'Resetting…',
        'resetNote': 'Stops current tasks and starts a new session.',
        'resetFailed': 'Reset failed: {reason}',
        'statusQueued': 'Queued',
        'statusStarting': 'Starting',
        'statusWorking': 'Working',
        'statusIdle': 'Completed',
        'statusBlocked': 'Waiting',
        'statusFailed': 'Failed',
        'statusInterrupted': 'Interrupted',
        'statusLost': 'Lost',
        'statusClosed': 'Closed',
      },
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'var(--dsw-alias-fg-primary, inherit)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 18px',
        borderBottom: '1px solid rgba(127,127,127,.18)',
        minHeight: 48,
        flex: '0 0 auto',
      },
      titleBlock: { display: 'flex', flexDirection: 'column', minWidth: 160, gap: 2 },
      title: { fontSize: 14, fontWeight: 650, letterSpacing: '.01em' },
      spacer: { flex: 1 },
      button: {
        appearance: 'none',
        border: '1px solid rgba(127,127,127,.26)',
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,.08))',
        color: 'inherit',
        borderRadius: 7,
        padding: '6px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonPrimary: {
        appearance: 'none',
        border: '1px solid rgba(127,127,127,.26)',
        background: 'var(--dsw-alias-accent, #4f7cff)',
        color: '#fff',
        borderRadius: 7,
        padding: '8px 14px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      },
      meta: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '7px 18px',
        borderBottom: '1px solid rgba(127,127,127,.12)',
        fontSize: 11,
        opacity: 0.78,
        flex: '0 0 auto',
      },
      dot: { width: 7, height: 7, borderRadius: 999, background: '#4caf72', display: 'inline-block' },
      body: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'row' },
      conversationArea: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      conversation: { flex: '1 1 auto', minHeight: 0, display: 'flex', width: '100%' },
      rail: {
        flex: '0 0 292px',
        width: 292,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid rgba(127,127,127,.18)',
        background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.035))',
      },
      railHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 14px 8px',
        flex: '0 0 auto',
      },
      railTitle: { fontSize: 12, fontWeight: 650, letterSpacing: '.01em' },
      railCount: {
        fontSize: 10,
        minWidth: 18,
        textAlign: 'center',
        padding: '1px 5px',
        borderRadius: 999,
        background: 'rgba(127,127,127,.14)',
        opacity: 0.8,
      },
      railScroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '2px 8px 16px' },
      activityRow: {
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start',
        padding: '8px 7px',
        borderRadius: 8,
        minWidth: 0,
      },
      activityMain: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 2 },
      activityTitle: {
        fontSize: 12,
        lineHeight: 1.35,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        wordBreak: 'break-word',
      },
      activityMeta: { fontSize: 10, opacity: 0.48, display: 'flex', gap: 6, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' },
      activityProject: { overflow: 'hidden', textOverflow: 'ellipsis' },
      activityDot: { flex: '0 0 auto', width: 8, height: 8, borderRadius: 999, marginTop: 4 },
      moreButton: { appearance: 'none', border: 0, background: 'none', color: 'inherit', opacity: 0.55, fontSize: 10, cursor: 'pointer', padding: '6px 8px', textAlign: 'left' },
      center: { flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 },
      card: {
        maxWidth: 540,
        width: '100%',
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: 14,
        padding: 24,
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,.06))',
        lineHeight: 1.65,
        fontSize: 13,
      },
      cardTitle: { fontSize: 16, fontWeight: 650, marginBottom: 8 },
      error: {
        margin: '10px 18px 0',
        padding: '9px 11px',
        borderRadius: 8,
        border: '1px solid rgba(220,80,80,.4)',
        background: 'rgba(220,80,80,.10)',
        color: 'var(--dsw-alias-fg-primary, inherit)',
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      },
    }

    // ── 小工具 ───────────────────────────────────────────────────────────────

    function service(ctx, name) {
      try {
        const direct = ctx[name]
        if (direct !== undefined) return direct
        return ctx.get(name)
      } catch {
        return undefined
      }
    }

    function format(t, key, values = {}) {
      let text = String(t(key))
      for (const [name, value] of Object.entries(values)) {
        text = text.split(`{${name}}`).join(String(value))
      }
      return text
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      return { response, payload }
    }

    function summarizeStatus(router) {
      if (router === null || router === undefined) return null
      const status = router.status
      if (status === undefined || status === null) return null
      const counts = status.counts ?? {}
      const taskCounts = counts.tasks
      // 只把“还需要 Router 注意”的状态计入面板计数；idle/closed 是历史，
      // 否则跑过很多任务后标题会永远显示 6 task(s)。
      const activeStates = ['queued', 'starting', 'working', 'blocked', 'interrupted', 'lost']
      const tasks = taskCounts !== null && typeof taskCounts === 'object'
        ? activeStates.reduce((sum, name) => sum + (Number(taskCounts[name] ?? 0) || 0), 0)
        : 0
      return {
        active: status.router?.status === 'running',
        workers: Number(status.router?.activeWorkers ?? 0),
        pending: Number(status.router?.pendingTriggers ?? 0),
        tasks: Number.isFinite(tasks) ? tasks : 0,
      }
    }

    // ── 图标 ─────────────────────────────────────────────────────────────────

    function SuperAgentIcon({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 5, r: 2.2 }),
        h('circle', { cx: 5, cy: 18, r: 2.2 }),
        h('circle', { cx: 19, cy: 18, r: 2.2 }),
        h('path', { d: 'M12 7.2v3.3M10.6 10.5h2.8M7 16.2l3.3-2.5M17 16.2l-3.3-2.5' }),
      )
    }

    // ── 官方会话子槽 ─────────────────────────────────────────────────────────

    /** 固定 chat 视图的官方 Conversation content。 */
    function FixedChatView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    /**
     * 子槽组件在 SessionProvider 的作用域里渲染官方会话工厂。
     *
     * 固定 active，不传 hero：官方 hero 会在空白会话里渲染 WorkspaceChip，
     * 点开就是工作区选择列表——这正是 Super-agent 入口不该出现的东西。
     * 面板自己负责空状态，项目选择由 Router 自主完成。
     */
    function SuperAgentConversation({ renderFactorySlot }) {
      if (typeof renderFactorySlot !== 'function') {
        return h('div', { style: S.center }, 'conversation.content is unavailable')
      }
      return renderFactorySlot(
        CONTENT_FACTORY,
        { variant: 'embedded', phase: 'active', hero: false },
        { slots: { views: FixedChatView } },
      )
    }

    // ── 近期活动 ─────────────────────────────────────────────────────────────

    const ACTIVITY_STATUS = {
      queued: { key: 'statusQueued', color: '#8b929b', rank: 2 },
      starting: { key: 'statusStarting', color: '#d9a441', rank: 1 },
      working: { key: 'statusWorking', color: '#d9a441', rank: 0 },
      idle: { key: 'statusIdle', color: '#4caf72', rank: 5 },
      blocked: { key: 'statusBlocked', color: '#d9a441', rank: 3 },
      failed: { key: 'statusFailed', color: '#dc5b5b', rank: 4 },
      interrupted: { key: 'statusInterrupted', color: '#d9a441', rank: 4 },
      lost: { key: 'statusLost', color: '#dc5b5b', rank: 4 },
      closed: { key: 'statusClosed', color: '#8b929b', rank: 6 },
    }

    function activityMeta(status) {
      return ACTIVITY_STATUS[status] ?? { key: 'statusUnknown', color: '#8b929b', rank: 9 }
    }

    function taskProject(task) {
      if (typeof task?.project === 'string' && task.project.length > 0) return task.project
      const cwd = typeof task?.cwd === 'string' ? task.cwd : ''
      const parts = cwd.split(/[\\/]/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    /** 一条任务活动。Worker 会话本身不出现在这里，也不出现在官方侧栏。 */
    function ActivityRow({ task, t }) {
      const meta = activityMeta(task.status)
      return h('div', { style: S.activityRow },
        h('span', {
          className: task.status === 'working' || task.status === 'starting' ? 'sa-pulse' : undefined,
          style: { ...S.activityDot, background: meta.color },
          'aria-hidden': 'true',
        }),
        h('div', { style: S.activityMain },
          h('div', { style: S.activityTitle, title: task.title }, task.title || 'Untitled task'),
          h('div', { style: S.activityMeta },
            h('span', {}, t(meta.key)),
            taskProject(task) ? h('span', { style: S.activityProject }, `· ${taskProject(task)}`) : null,
            task.age ? h('span', {}, `· ${task.age}`) : null,
          ),
        ),
      )
    }

    /**
     * 右侧活动栏：只来自 runtime 的 task 快照，不伪造消息、不展示 Worker 会话。
     * 进行中和已结束的任务放在同一条时间线里；默认截断，任务多时展开。
     */
    function ActivityRail({ tasks, t }) {
      const [showAll, setShowAll] = React.useState(false)
      const limit = 8
      const rows = tasks
        .filter((task) => task.status !== 'closed')
        .sort((a, b) => (b.createdAt ?? b.updatedAt ?? 0) - (a.createdAt ?? a.updatedAt ?? 0))
      const visible = showAll ? rows : rows.slice(0, limit)
      const total = rows.length
      return h('aside', { style: S.rail, className: 'sa-activity', 'aria-label': t('activityTitle') },
        h('div', { style: S.railHeader },
          h('div', { style: S.railTitle }, t('activityTitle')),
          total > 0 ? h('span', { style: S.railCount }, total) : null,
        ),
        h('div', { style: S.railScroll },
          visible.map((task) => h(ActivityRow, { key: task.id, task, t })),
          rows.length > limit
            ? h('button', {
                type: 'button',
                style: S.moreButton,
                onClick: () => setShowAll((value) => !value),
              }, showAll ? t('hideMore') : t('showMore'))
            : null,
        ),
      )
    }

    // ── 主面板 ───────────────────────────────────────────────────────────────

    /**
     * 主面板只做一件事：把官方会话铺满，并自动准备 Router。
     *
     * 没有 project selector：用户直接说话，Router 通过 superagent_projects /
     * dispatch(project) 自己选择项目。宿主 ensure 不要求 cwd，会自动恢复/选择
     * Router 的运行目录；这个目录不是任务的目标目录。
     *
     * @param {object} props 插槽运行时 props。
     * @param {Function} props.SessionProvider 会话作用域 Provider（由 session 子槽注入）。
     * @param {Function} props.renderSlot 子槽渲染器。
     */
    function SuperAgentPage({ SessionProvider, renderSlot, t, pluginCtx }) {
      const sessionsService = pluginCtx === undefined ? undefined : service(pluginCtx, 'sessions')
      const [sessionId, setSessionId] = React.useState('')
      const [reference, setReference] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [resetting, setResetting] = React.useState(false)
      const [resetConfirm, setResetConfirm] = React.useState(false)
      const [error, setError] = React.useState('')
      const [statusLine, setStatusLine] = React.useState('')
      const [routerInfo, setRouterInfo] = React.useState(null)
      const [workspaceSessions, setWorkspaceSessions] = React.useState([])
      const attempted = React.useRef(false)
      const mounted = React.useRef(true)

      React.useEffect(() => () => { mounted.current = false }, [])

      const fetchState = React.useCallback(async () => {
        try {
          const response = await fetch(ROUTES.state, { credentials: 'same-origin' })
          const payload = await response.json()
          if (!mounted.current) return
          if (payload?.ok && payload.router) {
            setRouterInfo(payload.router)
            setWorkspaceSessions(Array.isArray(payload.workspaceSessions) ? payload.workspaceSessions : [])
            const summary = summarizeStatus(payload.router)
            if (summary !== null) {
              const pieces = [summary.active ? t('running') : t('idle')]
              if (summary.workers > 0) pieces.push(format(t, 'workers', { count: summary.workers }))
              if (summary.pending > 0) pieces.push(format(t, 'pending', { count: summary.pending }))
              if (summary.tasks > 0) pieces.push(format(t, 'tasks', { count: summary.tasks }))
              setStatusLine(pieces.join(' · '))
            }
          } else {
            setRouterInfo(null)
            setWorkspaceSessions([])
            setStatusLine('')
          }
        } catch {
          // 轮询失败不打断对话；下一次再试。
        }
      }, [t])

      const ensure = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          // 不传 cwd：宿主自己恢复/选择 Router 运行目录。项目选择属于 Router，
          // 不属于 UI，用户不需要先选工作区。
          const { response, payload } = await postJson(ROUTES.ensure, {})
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (!mounted.current) return
          const info = payload.router ?? {
            sessionId: payload.sessionId,
            projectRoot: payload.projectRoot,
            status: payload.status,
          }
          setRouterInfo(info)
          setSessionId(payload.sessionId)
          const summary = summarizeStatus(info)
          if (summary !== null) {
            const pieces = [summary.active ? t('running') : t('idle')]
            if (summary.workers > 0) pieces.push(format(t, 'workers', { count: summary.workers }))
            if (summary.pending > 0) pieces.push(format(t, 'pending', { count: summary.pending }))
            if (summary.tasks > 0) pieces.push(format(t, 'tasks', { count: summary.tasks }))
            setStatusLine(pieces.join(' · '))
          }
        } catch (cause) {
          if (mounted.current) setError(format(t, 'ensureFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [t])

      /** 重置：第一次点击进入确认态，第二次才真正中止任务并新建 Router。 */
      const reset = React.useCallback(async () => {
        if (!resetConfirm) {
          setResetConfirm(true)
          return
        }
        setResetting(true)
        setError('')
        try {
          const { response, payload } = await postJson(ROUTES.reset, {})
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (!mounted.current) return
          const info = {
            sessionId: payload.sessionId,
            projectRoot: payload.projectRoot,
            status: payload.status,
          }
          setRouterInfo(info)
          setSessionId(payload.sessionId)
          setResetConfirm(false)
          attempted.current = true
          const summary = summarizeStatus(info)
          if (summary !== null) {
            const pieces = [summary.active ? t('running') : t('idle')]
            if (summary.workers > 0) pieces.push(format(t, 'workers', { count: summary.workers }))
            if (summary.pending > 0) pieces.push(format(t, 'pending', { count: summary.pending }))
            if (summary.tasks > 0) pieces.push(format(t, 'tasks', { count: summary.tasks }))
            setStatusLine(pieces.join(' · '))
          }
          void fetchState()
        } catch (cause) {
          if (mounted.current) setError(format(t, 'resetFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setResetting(false)
        }
      }, [fetchState, resetConfirm, t])

      // 打开面板立即准备 Router；不再等待工作区列表或用户点“开始”。
      React.useEffect(() => {
        if (attempted.current || sessionId.length > 0) return
        attempted.current = true
        void ensure()
      }, [ensure, sessionId])

      // sessionId -> SessionReference；卸载时释放。
      React.useEffect(() => {
        if (sessionId.length === 0 || sessionsService === undefined) {
          setReference(undefined)
          return undefined
        }
        setReference(undefined)
        let referenceValue
        try {
          referenceValue = sessionsService.retain(sessionId, { source: PANEL_SOURCE })
        } catch (cause) {
          setError(format(t, 'ensureFailed', { reason: String(cause?.message ?? cause) }))
          return undefined
        }
        setReference(referenceValue)
        Promise.resolve(referenceValue?.ready).catch((cause) => {
          if (mounted.current) setError(format(t, 'ensureFailed', { reason: String(cause?.message ?? cause) }))
        })
        return () => {
          try {
            referenceValue?.release?.()
          } catch {
            // 已经被框架释放时不重复报错。
          }
        }
      }, [sessionId, sessionsService, t])

      // 轻量状态轮询：让面板看得到 Worker / pending / task 的规模。
      React.useEffect(() => {
        if (sessionId.length === 0) return undefined
        void fetchState()
        const timer = setInterval(() => { void fetchState() }, POLL_MS)
        return () => clearInterval(timer)
      }, [fetchState, sessionId])

      const workspaceKey = workspaceSessions.join('\u0000')

      /**
       * Worker 是普通 Session（跨项目写需要 header.cwd = 目标目录），但用户
       * 不该在左侧“近期活动”里看到它们。优先用任务的 workerSessionId 精确
       * 隐藏；再兜底扫描 Super-agent worker 标题，覆盖重启前遗留的会话。
       * 这是展示层隐藏，不修改/删除 Session 本身。
       */
      React.useEffect(() => {
        const marker = 'data-super-agent-worker-hidden'
        const hiddenRouters = new Set(workspaceSessions.filter((id) => typeof id === 'string' && id !== sessionId))
        const hide = () => {
          // Worker 会话：普通 Session 会进入左侧“近期活动”，但 Worker 不是用户
          // 发起的对话；整个入口隐藏，活动改由右侧 task 列表展示。
          for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
            const title = row.querySelector('[class*="title"]')
            const text = typeof title?.textContent === 'string' ? title.textContent.trim() : ''
            if (!text.startsWith('Super-agent worker ·')) continue
            row.style.display = 'none'
            row.setAttribute(marker, '1')
          }
          // 旧 Router 行被隐藏后，官方侧栏仍会按总会话数显示「Show N more」；
          // 当某个分组里存在被隐藏的 Router 时，一并隐藏这个溢出按钮。
          for (const button of document.querySelectorAll('button[data-row-key^="overflow:"]')) {
            const section = button.closest('[class*="groupSection"]')
            if (section === null) continue
            const hasHiddenRouter = [...section.querySelectorAll('[data-row-key^="session:"]')]
              .some((row) => hiddenRouters.has((row.getAttribute('data-row-key') ?? '').slice('session:'.length)))
            if (!hasHiddenRouter) continue
            button.style.display = 'none'
            button.setAttribute(marker, '1')
          }
          // Router 的 trigger 批处理在协议上必须走 user turn 才能唤醒模型，但
          // 它不是用户说的话；在展示层隐藏，模型仍然照常收到。
          for (const item of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
            const text = typeof item.textContent === 'string' ? item.textContent.trim() : ''
            if (!text.startsWith('[super-agent] ')) continue
            item.style.display = 'none'
            item.setAttribute(marker, '1')
          }
        }
        hide()
        const observer = new MutationObserver(hide)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        return () => {
          observer.disconnect()
          for (const row of document.querySelectorAll(`[${marker}]`)) {
            row.style.removeProperty('display')
            row.removeAttribute(marker)
          }
        }
      }, [sessionId, workspaceKey])

      const retry = () => {
        setResetConfirm(false)
        attempted.current = true
        void ensure()
      }

      const tasks = Array.isArray(routerInfo?.status?.tasks) ? routerInfo.status.tasks : []
      const workerSessionIds = [...new Set(tasks
        .map((task) => task?.workerSessionId)
        .filter((id) => typeof id === 'string' && id.length > 0))]
      const hiddenSessionIds = [...new Set([
        ...workerSessionIds,
        ...workspaceSessions.filter((id) => typeof id === 'string' && id !== sessionId),
      ])]
      const hiddenCss = hiddenSessionIds
        .map((id) => `[data-row-key="session:${id.replace(/["\\]/g, '')}"]{display:none!important}`)
        .join('\n')

      const sessionProviderAvailable = typeof SessionProvider === 'function'
      const renderSlotAvailable = typeof renderSlot === 'function'
      const hasSession = sessionId.length > 0
      const openSessionAvailable = hasSession && service(pluginCtx, 'uiWorkspace') !== undefined

      return h('div', { style: S.root },
        h('style', {}, `
          ${hiddenCss}
          @keyframes saPulse { 0% { opacity: .45; transform: scale(.85); } 70% { opacity: 1; transform: scale(1); } 100% { opacity: .45; transform: scale(.85); } }
          .sa-pulse { animation: saPulse 1.6s ease-in-out infinite; }
          @media (max-width: 1180px) {
            .sa-title-block { min-width: 120px !important; }
            .sa-activity { display: none !important; }
          }
          @media (max-width: 860px) {
            .sa-header { gap: 8px !important; padding-left: 12px !important; padding-right: 12px !important; }
          }
        `),
        h('div', { style: S.header, className: 'sa-header' },
          h('div', { style: S.titleBlock, className: 'sa-title-block' },
            h('div', { style: S.title }, t('title')),
          ),
          h('div', { style: S.spacer }),
          h('button', {
            type: 'button',
            style: S.button,
            disabled: busy,
            onClick: retry,
          }, busy ? t('loading') : t('refresh')),
          h('button', {
            type: 'button',
            style: resetConfirm ? S.buttonPrimary : S.button,
            disabled: busy || resetting || !hasSession,
            title: t('resetNote'),
            onClick: reset,
          }, resetting ? t('resetting') : resetConfirm ? t('resetConfirm') : t('reset')),
          openSessionAvailable
            ? h('button', {
                type: 'button',
                style: S.button,
                title: t('openSession'),
                onClick: () => {
                  try {
                    pluginCtx.layout?.selectPanel?.(null)
                    pluginCtx.uiWorkspace?.openSession?.(sessionId)
                  } catch {
                    // 打开失败不影响面板内的同一会话。
                  }
                },
              }, t('openSession'))
            : null,
        ),
        h('div', { style: S.meta },
          h('span', { style: { ...S.dot, background: routerInfo ? '#4caf72' : 'rgba(127,127,127,.55)' } }),
          h('span', {}, statusLine || t('noRouter')),
        ),
        resetConfirm && hasSession
          ? h('div', { style: { ...S.meta, opacity: 0.5, borderBottom: 0, paddingTop: 0 } }, t('resetNote'))
          : null,
        error.length > 0
          ? h('div', { style: S.error }, h('strong', {}, `${t('error')}: `), error)
          : null,
        h('div', { style: S.body },
          h('div', { style: S.conversationArea },
          !hasSession
            ? h('div', { style: S.center },
                h('div', { style: S.card },
                  h('div', { style: S.cardTitle }, busy ? t('loading') : t('error')),
                  busy ? null : h('button', {
                    type: 'button',
                    style: S.buttonPrimary,
                    onClick: retry,
                  }, t('retry')),
                ),
              )
            : sessionsService === undefined
              ? h('div', { style: S.center },
                  h('div', { style: S.card },
                    h('div', { style: S.cardTitle }, t('error')),
                    h('div', {}, t('errorNoSession')),
                  ),
                )
              : !sessionProviderAvailable || !renderSlotAvailable
                ? h('div', { style: S.center },
                    h('div', { style: S.card },
                      h('div', { style: S.cardTitle }, t('error')),
                      h('div', {}, !sessionProviderAvailable ? t('errorNoProvider') : t('errorNoSlot')),
                    ),
                  )
                : reference === undefined
                    ? h('div', { style: S.center }, h('div', { style: S.card }, t('loading')))
                    : h('div', { style: S.conversation },
                      h(SessionProvider, { session: reference }, renderSlot(CONVERSATION_SLOT, {})),
                    ),
          ),
          h(ActivityRail, { tasks, t }),
        ),
      )
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────

    /**
     * 把「面板 id + retain 来源」显式注册给 dsh-away-notify（可选契约）。
     *
     * 不注册也能工作：away-notify 会在面板被选中后 15 秒内把第一个新出现的 retain
     * 来源猜成该面板的（`PANEL_LEARN_WINDOW_MS`）。显式注册替掉这个猜测——面板从没
     * 打开过、或同时有别的插件在 retain 会话时，点击也不会认错落点。
     *
     * 为什么随插件注册、而不是等面板挂载：`PANEL_ID` / `PANEL_SOURCE` 都是插件级
     * 常量，与某一次挂载无关。随插件注册既保证「面板没打开过也能点通知打开它」，
     * 又天然幂等（重复挂载不会重复注册）。注册句柄交给 `scope.effect`，插件卸载/
     * 热重载时自动注销，不残留。
     *
     * 降级：服务不存在（没装 away-notify）、没有 `register`、调用抛错——一律吞掉，
     * 面板照常打开，最坏退回 away-notify 的自动学习。
     *
     * @param {object} ctx 浏览器插件上下文。
     */
    function registerAwayNotifyPanel(ctx) {
      const connect = (scope) => {
        try {
          const panels = service(scope, 'awayNotifyPanels')
          const register = panels?.register
          if (typeof register !== 'function') return
          // 注入出来的 scope 是子 fiber：句柄挂在它上面，随插件卸载/服务换实例一起注销
          const effectOwner = typeof scope?.effect === 'function' ? scope : ctx
          effectOwner.effect(() => {
            const release = register.call(panels, { panelId: PANEL_ID, sources: [PANEL_SOURCE] })
            return () => {
              try {
                if (typeof release === 'function') release()
              } catch {
                // away-notify 已经卸载/换实例：它那边的注册表本来就没了
              }
            }
          }, 'super-agent: awayNotify panel sources')
        } catch {
          // 注册失败只会退回自动学习，不能影响面板
        }
      }
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['awayNotifyPanels'], connect)
        else connect(ctx)
      } catch {
        // 没有注入能力的老上下文：不注册
      }
    }

    /**
     * @param {import('cordis').Context} ctx 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'super-agent: dictionaries')
      const t = ctx.locale.bind(NS)

      // 可选契约：让 away-notify 的「点通知回面板」认识本面板，替掉它的自动学习兜底。
      // 放在槽注册之前也无所谓——这里只登记 id/来源，不依赖面板已挂载。
      registerAwayNotifyPanel(ctx)

      ctx.slots.inject('main', function* () {
        const handle = ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          children: {
            [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
          },
        }, (props) => h(SuperAgentPage, { ...props, t, pluginCtx: ctx }))
        yield handle
      })

      // 子槽只在 main 的 children 声明之后注册；slots.inject 会等它被声明。
      ctx.slots.inject(CONVERSATION_SLOT, () =>
        ctx.slots.register({ name: CONVERSATION_SLOT }, SuperAgentConversation),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          label: () => t('panel'),
          locale: NS,
        }, SuperAgentIcon),
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['sessions', 'slots', 'locale']
    module.exports.NS = NS
    module.exports.PANEL_ID = PANEL_ID
    return module.exports
  },
})
