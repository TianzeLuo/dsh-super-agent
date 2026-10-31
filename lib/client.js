/**
 * client.js — Super-agent 的浏览器半部。
 *
 * 左栏「Super-agent」入口 → main 面板 → 嵌入式官方会话。面板本身不是另一套聊天
 * 协议：它 retain 一条真正的 DSH 根会话（由宿主 `/api/super-agent/ui/ensure` 创建，
 * 本插件的 Router 提示词和工具装在这条会话上），再把官方 `conversation.content`
 * 工厂渲染进面板。所以消息流、停止按钮、审批、模型选择都仍是官方实现。
 *
 * 目标项目选择器只改变 Router 的 focus project（dispatch 的默认 cwd），不切换
 * Router 会话；一个 DSH 进程里仍只有一条常驻 Router。
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
    /** 本插件自己的 session 作用域子槽；名字不能和官方槽冲突。 */
    const CONVERSATION_SLOT = 'super-agent.conversation'
    /** 官方会话内容工厂（由 dsh-client-ui-conversation 声明）。 */
    const CONTENT_FACTORY = 'conversation.content'
    const ROUTES = {
      ensure: '/api/super-agent/ui/ensure',
      state: '/api/super-agent/ui/state',
      focus: '/api/super-agent/ui/focus',
    }
    const POLL_MS = 4_000
    const FOCUS_KEY = 'dsh-super-agent.focus'

    function rememberedFocus() {
      try {
        return window.localStorage.getItem(FOCUS_KEY) ?? ''
      } catch {
        return ''
      }
    }

    function rememberFocus(path) {
      try {
        if (typeof path === 'string' && path.length > 0) window.localStorage.setItem(FOCUS_KEY, path)
      } catch {
        // 隐私模式禁用 localStorage 时只影响记忆，不影响功能。
      }
    }

    const DICT = {
      zh: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'subtitle': '常驻 Router 负责分派、汇总和追问；Worker 在项目里执行。',
        'project': '目标项目',
        'refresh': '刷新',
        'openSession': '在会话中打开',
        'loading': '正在准备 Super-agent…',
        'noWorkspace': '还没有工作区。请先在左侧栏添加一个项目，再回来启动 Super-agent。',
        'noWorkspaceHint': '工作区就是 DSH 左侧栏里的项目；Super-agent 会在所选项目中发起 Worker 会话。',
        'start': '开始对话',
        'retry': '重试',
        'error': 'Super-agent 暂不可用',
        'errorNoSession': '会话服务不可用（缺少 sessions）。',
        'errorNoProvider': '面板无法绑定会话（缺少 SessionProvider）。',
        'errorNoSlot': '面板无法渲染官方会话（缺少 conversation.content）。',
        'errorNoFetch': '宿主没有注册 Super-agent UI 接口。',
        'ensureFailed': '无法启动 Super-agent：{reason}',
        'focusFailed': '切换目标项目失败：{reason}',
        'noRouter': 'Router 尚未启动。',
        'idle': '空闲',
        'running': '运行中',
        'workers': '{count} 个 Worker',
        'pending': '{count} 条待处理触发',
        'tasks': '{count} 个任务',
        'autoConfig': '首次使用会在项目内写入 .dsh/super-agent.json（仅开启，不覆盖已有文件）。',
        'disclaimer': 'Router 只做分派与汇总；执行类工具被守卫拦截，Worker 在项目目录中工作。',
        'statusUnknown': '状态未知',
      },
      en: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'subtitle': 'A resident Router dispatches, summarizes, and follows up; Workers execute inside projects.',
        'project': 'Target project',
        'refresh': 'Refresh',
        'openSession': 'Open as session',
        'loading': 'Preparing Super-agent…',
        'noWorkspace': 'No workspace yet. Add a project in the left sidebar, then come back.',
        'noWorkspaceHint': 'A workspace is a project in the DSH sidebar; Super-agent starts Worker sessions inside it.',
        'start': 'Start conversation',
        'retry': 'Retry',
        'error': 'Super-agent is unavailable',
        'errorNoSession': 'Session service unavailable (sessions).',
        'errorNoProvider': 'Panel cannot bind a session (SessionProvider).',
        'errorNoSlot': 'Panel cannot render the official conversation (conversation.content).',
        'errorNoFetch': 'The host did not register the Super-agent UI API.',
        'ensureFailed': 'Could not start Super-agent: {reason}',
        'focusFailed': 'Could not switch the target project: {reason}',
        'noRouter': 'Router is not running yet.',
        'idle': 'Idle',
        'running': 'Running',
        'workers': '{count} worker(s)',
        'pending': '{count} pending trigger(s)',
        'tasks': '{count} task(s)',
        'autoConfig': 'On first use a minimal .dsh/super-agent.json is written in the project (enable-only; existing files are never overwritten).',
        'disclaimer': 'The Router only dispatches and summarizes; execution tools are guarded. Workers run inside the project directory.',
        'statusUnknown': 'Unknown status',
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
      subtitle: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420 },
      spacer: { flex: 1 },
      select: {
        maxWidth: 260,
        minWidth: 140,
        padding: '6px 9px',
        borderRadius: 7,
        border: '1px solid rgba(127,127,127,.28)',
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,.08))',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
      },
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
      body: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
      conversation: { flex: '1 1 auto', minHeight: 0, display: 'flex', width: '100%' },
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
      hint: { fontSize: 12, opacity: 0.66, marginTop: 12 },
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
      emptyButtonRow: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' },
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
        focusProject: router.focusProject,
      }
    }

    /**
     * 会话摘要里的 blank：undefined 表示摘要还没到，不能贸然画 hero（否则会
     * 把已有历史盖掉）；只有明确 blank=true 才让官方会话画欢迎态。
     */
    function useSessionBlank(sessions, sessionId) {
      const subscribe = React.useCallback((listener) => {
        try {
          const dispose = sessions?.list?.subscribe?.(listener)
          return typeof dispose === 'function' ? dispose : () => undefined
        } catch {
          return () => undefined
        }
      }, [sessions])
      const snapshot = React.useCallback(() => {
        try {
          const summary = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
          if (summary === undefined) return null
          return summary.blank === true
        } catch {
          return null
        }
      }, [sessions, sessionId])
      return React.useSyncExternalStore(subscribe, snapshot, () => null)
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

    /** 子槽组件在 SessionProvider 的作用域里渲染官方会话工厂。 */
    function SuperAgentConversation({ renderFactorySlot, phase = 'active' }) {
      if (typeof renderFactorySlot !== 'function') {
        return h('div', { style: S.center }, 'conversation.content is unavailable')
      }
      return renderFactorySlot(
        CONTENT_FACTORY,
        { variant: 'embedded', phase, hero: phase === 'hero' },
        { slots: { views: FixedChatView } },
      )
    }

    // ── 主面板 ───────────────────────────────────────────────────────────────

    /**
     * @param {object} props 插槽运行时 props。
     * @param {Function} props.useWorkspaces 工作区快照选择器。
     * @param {Function} props.SessionProvider 会话作用域 Provider（由 session 子槽注入）。
     * @param {Function} props.renderSlot 子槽渲染器。
     */
    function SuperAgentPage({ useWorkspaces, SessionProvider, renderSlot, t, pluginCtx }) {
      const sessionsService = pluginCtx === undefined ? undefined : service(pluginCtx, 'sessions')
      const workspaces = useWorkspaces((state) => state?.items ?? [])
      const phase = useWorkspaces((state) => state?.phase)
      const [selectedPath, setSelectedPath] = React.useState(() => rememberedFocus())
      const [sessionId, setSessionId] = React.useState('')
      const [reference, setReference] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [statusLine, setStatusLine] = React.useState('')
      const [routerInfo, setRouterInfo] = React.useState(null)
      const blank = useSessionBlank(sessionsService, sessionId)
      const attempted = React.useRef(false)
      const mounted = React.useRef(true)

      React.useEffect(() => () => { mounted.current = false }, [])

      const projects = React.useMemo(() => {
        const seen = new Set()
        const rows = []
        for (const workspace of workspaces) {
          const path = typeof workspace?.path === 'string' ? workspace.path : ''
          if (path.length === 0 || seen.has(path)) continue
          seen.add(path)
          rows.push({ id: workspace.workspaceId ?? path, path, title: workspace.title || path })
        }
        return rows
      }, [workspaces])

      // 工作区加载完后默认选中第一个；用户之前选过且仍存在则保留。
      React.useEffect(() => {
        if (projects.length === 0) return
        if (selectedPath.length > 0 && projects.some((project) => project.path === selectedPath)) return
        const remembered = rememberedFocus()
        if (remembered.length > 0 && projects.some((project) => project.path === remembered)) {
          setSelectedPath(remembered)
          return
        }
        setSelectedPath(projects[0].path)
      }, [projects, selectedPath])

      const fetchState = React.useCallback(async () => {
        try {
          const response = await fetch(ROUTES.state, { credentials: 'same-origin' })
          const payload = await response.json()
          if (!mounted.current) return
          if (payload?.ok && payload.router) {
            setRouterInfo(payload.router)
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
            setStatusLine('')
          }
        } catch {
          // 轮询失败不打断对话；下一次再试。
        }
      }, [t])

      const focus = React.useCallback(async (path) => {
        if (typeof path !== 'string' || path.length === 0) return
        try {
          const { response, payload } = await postJson(ROUTES.focus, { cwd: path })
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (mounted.current) {
            rememberFocus(payload.focusProject ?? path)
            setError('')
            setRouterInfo((previous) => previous === null ? previous : { ...previous, focusProject: payload.focusProject ?? path })
          }
        } catch (cause) {
          if (mounted.current) setError(format(t, 'focusFailed', { reason: String(cause?.message ?? cause) }))
        }
      }, [t])

      const ensure = React.useCallback(async (path, { manual = false } = {}) => {
        if (typeof path !== 'string' || path.length === 0) return
        if (manual) attempted.current = true
        setBusy(true)
        setError('')
        try {
          const { response, payload } = await postJson(ROUTES.ensure, { cwd: path })
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (!mounted.current) return
          rememberFocus(payload.focusProject ?? path)
          setRouterInfo(payload.router ?? {
            sessionId: payload.sessionId,
            projectRoot: payload.projectRoot,
            focusProject: payload.focusProject,
            status: payload.status,
          })
          setSessionId(payload.sessionId)
          // ensure 已经在宿主端把 focus 设成这个项目，但显式再确认一次，便于 UI 立即更新。
          const summary = summarizeStatus(payload.router)
          if (summary !== null) {
            const pieces = [summary.active ? t('running') : t('idle')]
            if (summary.workers > 0) pieces.push(format(t, 'workers', { count: summary.workers }))
            if (summary.tasks > 0) pieces.push(format(t, 'tasks', { count: summary.tasks }))
            setStatusLine(pieces.join(' · '))
          }
        } catch (cause) {
          if (mounted.current) {
            setError(format(t, 'ensureFailed', { reason: String(cause?.message ?? cause) }))
            attempted.current = true
          }
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [t])

      // 第一次打开面板：自动确保一条 Router 会话，而不是只停在欢迎页。
      React.useEffect(() => {
        if (attempted.current || sessionId || busy || selectedPath.length === 0) return
        attempted.current = true
        void ensure(selectedPath, { manual: false })
      }, [busy, ensure, selectedPath, sessionId])

      // sessionId -> SessionReference；卸载或换会话时释放。
      React.useEffect(() => {
        if (sessionId.length === 0 || sessionsService === undefined) {
          setReference(undefined)
          return undefined
        }
        setReference(undefined)
        let referenceValue
        try {
          referenceValue = sessionsService.retain(sessionId, { source: 'superAgentUi' })
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

      if (phase === 'loading' && projects.length === 0) {
        return h('div', { style: S.root }, h('div', { style: S.center }, h('div', { style: S.card }, t('loading'))))
      }

      if (projects.length === 0) {
        return h('div', { style: S.root },
          h('div', { style: S.header },
            h('div', { style: S.titleBlock }, h('div', { style: S.title }, t('title'))),
            h('div', { style: S.spacer }),
          ),
          h('div', { style: S.center },
            h('div', { style: S.card },
              h('div', { style: S.cardTitle }, t('noWorkspace')),
              h('div', { style: S.hint }, t('noWorkspaceHint')),
              h('div', { style: S.emptyButtonRow },
                h('button', { type: 'button', style: S.button, onClick: () => { attempted.current = false; window.location.reload() } }, t('refresh')),
              ),
            ),
          ),
        )
      }

      const selectedProject = projects.find((project) => project.path === selectedPath)
      const sessionProviderAvailable = typeof SessionProvider === 'function'
      const renderSlotAvailable = typeof renderSlot === 'function'

      return h('div', { style: S.root },
        h('style', {}, `
          @media (max-width: 1180px) {
            .sa-subtitle { display: none !important; }
            .sa-title-block { min-width: 120px !important; }
            .sa-project-label { font-size: 0 !important; gap: 0 !important; }
          }
          @media (max-width: 860px) {
            .sa-project-label { display: none !important; }
            .sa-header { gap: 8px !important; padding-left: 12px !important; padding-right: 12px !important; }
          }
        `),
        h('div', { style: S.header, className: 'sa-header' },
          h('div', { style: S.titleBlock, className: 'sa-title-block' },
            h('div', { style: S.title }, t('title')),
            h('div', { style: S.subtitle, className: 'sa-subtitle' }, t('subtitle')),
          ),
          h('div', { style: S.spacer }),
          h('label', { style: { fontSize: 11, opacity: 0.62, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }, className: 'sa-project-label' },
            t('project'),
            h('select', {
              style: S.select,
              value: selectedPath,
              disabled: busy,
              onChange: (event) => {
                const next = event.target.value
                setSelectedPath(next)
                if (sessionId.length > 0) void focus(next)
                else {
                  attempted.current = true
                  void ensure(next, { manual: true })
                }
              },
            },
              projects.map((project) => h('option', { key: project.id, value: project.path }, project.title)),
            ),
          ),
          h('button', {
            type: 'button',
            style: S.button,
            disabled: busy,
            onClick: () => { attempted.current = true; void ensure(selectedPath, { manual: true }) },
          }, busy ? t('loading') : t('refresh')),
          sessionId.length > 0 && service(pluginCtx, 'uiWorkspace') !== undefined
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
          selectedProject !== undefined
            ? h('span', { style: { opacity: 0.55 } }, `${selectedProject.title} · ${selectedProject.path}`)
            : null,
        ),
        error.length > 0
          ? h('div', { style: S.error }, h('strong', {}, `${t('error')}: `), error)
          : null,
        h('div', { style: S.body },
          sessionId.length === 0
            ? h('div', { style: S.center },
                h('div', { style: S.card },
                  h('div', { style: S.cardTitle }, t('title')),
                  h('div', {}, t('subtitle')),
                  h('div', { style: S.hint }, t('autoConfig')),
                  h('div', { style: S.emptyButtonRow },
                    h('button', {
                      type: 'button',
                      style: S.buttonPrimary,
                      disabled: busy,
                      onClick: () => { attempted.current = true; void ensure(selectedPath, { manual: true }) },
                    }, busy ? t('loading') : t('start')),
                  ),
                  h('div', { style: { ...S.hint, opacity: 0.5 } }, t('disclaimer')),
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
                    h(SessionProvider, { session: reference }, renderSlot(CONVERSATION_SLOT, {
                      phase: blank === true ? 'hero' : 'active',
                    })),
                  ),
        ),
      )
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────

    /**
     * @param {import('cordis').Context} ctx 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'super-agent: dictionaries')
      const t = ctx.locale.bind(NS)

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
