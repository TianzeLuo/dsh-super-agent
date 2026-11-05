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
      task: '/api/super-agent/ui/task',
      taskSteer: '/api/super-agent/ui/task/steer',
      activity: '/api/super-agent/ui/activity',
      models: '/api/super-agent/ui/models',
      agreements: '/api/super-agent/ui/agreements',
      schedules: '/api/super-agent/ui/schedules',
      schedulesCancel: '/api/super-agent/ui/schedules/cancel',
      schedulesRun: '/api/super-agent/ui/schedules/run',
    }
    const POLL_MS = 4_000

    const DICT = {
      zh: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'refresh': '刷新',
        'openSession': '在会话中打开',
        'openSessionFailed': '暂时无法打开会话，请重试。',
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
        'schedulesCanceled': '已取消 {count} 条定时任务',
        'activityEmpty': '还没有活动。派一个任务后会出现在这里。',
        'activityAll': '全部活动',
        'activityBack': '返回活动',
        'taskDetail': '任务详情',
        'taskBrief': '任务说明',
        'taskReports': '报告',
        'taskNoReports': '还没有报告。',
        'taskThreads': '关联线程',
        'taskNoThreads': '没有订阅线程。',
        'taskModel': '模型',
        'taskEffort': '思考强度',
        'taskCreated': '创建',
        'taskUpdated': '更新',
        'taskWorkerLive': 'Worker 在线',
        'taskWorkerGone': 'Worker 已释放',
        'taskWorkerNotStarted': 'Worker 尚未启动',
        'taskSteer': '给 Worker 发指令',
        'taskSteerPlaceholder': '补充约束、纠正方向，或让 Worker 先停下来说明情况…',
        'taskSteerSend': '发送指令',
        'taskSteering': '发送中…',
        'taskSteerFailed': '发送失败：{reason}',
        'openChat': '打开聊天',
        'openChatUnavailable': '这条任务没有可打开的 Worker 会话。',
        'openChatFailed': '暂时无法打开 Worker 聊天，请关闭详情后重试。',
        'detailLoading': '正在读取任务…',
        'detailFailed': '读取任务失败：{reason}',
        'models': '模型',
        'modelsTitle': 'Worker 模型',
        'modelsNote': 'Router 只能从这里选择 Worker 模型。取消勾选即从可调用列表中移除；「使用全部模型」恢复为跟随宿主目录。',
        'modelsDefault': '默认 Worker 模型',
        'modelsEffort': '默认思考强度',
        'modelsAll': '使用全部模型',
        'modelsAllowlist': '可调用模型',
        'modelsSave': '保存',
        'modelsSaving': '保存中…',
        'modelsSaved': '已保存',
        'modelsFailed': '保存模型设置失败：{reason}',
        'modelsEmpty': '宿主没有返回模型目录。',
        'modelsUnavailable': '不在宿主目录中',
        'modelsEfforts': '允许的思考强度',
        'modelsNoEfforts': '该模型没有可调的思考强度。',
        'modelsConfigured': '已配置 {count} 个',
        'modelsFiltered': '来源内 {count} 个',
        'modelsAllMode': '当前跟随宿主全部模型',
        'modelsAllowMode': '当前使用自定义列表',
        'close': '关闭',
        'rules': '规则',
        'rulesTitle': '长期工作约定',
        'rulesNote': '用户说「以后都……」时，Router 会把这些约定注入自己和每个 Worker。全局约定处处生效；项目约定只在该项目生效，replace 会覆盖该项目的全局约定。',
        'rulesAdd': '新增约定',
        'rulesEdit': '编辑',
        'rulesDelete': '删除',
        'rulesConfirmDelete': '确认删除',
        'rulesSave': '保存约定',
        'rulesSaving': '保存中…',
        'rulesCancel': '取消',
        'rulesEmpty': '还没有约定。',
        'rulesGlobal': '全局',
        'rulesProject': '项目',
        'rulesModeAppend': '追加',
        'rulesModeReplace': '覆盖全局',
        'rulesEnabled': '启用',
        'rulesDisabled': '已停用',
        'rulesDisableAction': '停用',
        'rulesEnableAction': '启用',
        'rulesTitleField': '标题（可选）',
        'rulesTextField': '约定内容',
        'rulesTextPlaceholder': '例如：回复先给结论，控制在三句话内；不要罗列文件清单。',
        'rulesProjectField': '作用域',
        'rulesModeField': '模式',
        'rulesFailed': '保存约定失败：{reason}',
        'rulesLoaded': '共 {count} 条约定',
        'schedules': '计划',
        'schedulesTitle': '定时任务',
        'schedulesNote': '到点后宿主会唤醒 Router，由 Router 检查现状再决定是否派发。时间使用浏览器时区，除非另填 IANA 时区。',
        'schedulesEmpty': '还没有定时任务。',
        'schedulesCreate': '新建定时任务',
        'schedulesRunNow': '立即运行',
        'schedulesCancel': '取消',
        'schedulesConfirmCancel': '确认取消',
        'schedulesNext': '下次',
        'schedulesState': '状态',
        'schedulesUnavailable': '这个部署没有 schedule 服务。',
        'schedulesFailed': '操作失败：{reason}',
        'schedulesTitleField': '名称',
        'schedulesPromptField': '到点要做什么',
        'schedulesPromptPlaceholder': '写清楚目标、项目、约束和期望结果；Router 到点只看这条提示。',
        'schedulesWhen': '时间',
        'schedulesAfter': '多少分钟后',
        'schedulesDaily': '每天',
        'schedulesWeekly': '每周',
        'schedulesCron': 'Cron',
        'schedulesAt': '指定时刻',
        'schedulesTime': '时间',
        'schedulesWeekday': '星期',
        'schedulesExpression': 'Cron 表达式',
        'schedulesZone': 'IANA 时区（可选）',
        'schedulesSave': '创建',
        'schedulesSaving': '创建中…',
        'schedulesMax': '最多 {count} 条',
        'weekday1': '周一',
        'weekday2': '周二',
        'weekday3': '周三',
        'weekday4': '周四',
        'weekday5': '周五',
        'weekday6': '周六',
        'weekday7': '周日',
        'drawerActivity': '活动',
        'detailReportsCount': '{count} 份报告',
        'cancel': '取消',
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
        'openSessionFailed': 'Could not open the session. Try again.',
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
        'schedulesCanceled': 'Canceled {count} scheduled task(s)',
        'activityEmpty': 'No activity yet. Dispatch a task and it will show up here.',
        'activityAll': 'All activity',
        'activityBack': 'Back to activity',
        'taskDetail': 'Task detail',
        'taskBrief': 'Brief',
        'taskReports': 'Reports',
        'taskNoReports': 'No report yet.',
        'taskThreads': 'Threads',
        'taskNoThreads': 'No subscribed threads.',
        'taskModel': 'Model',
        'taskEffort': 'Reasoning',
        'taskCreated': 'Created',
        'taskUpdated': 'Updated',
        'taskWorkerLive': 'Worker live',
        'taskWorkerGone': 'Worker released',
        'taskWorkerNotStarted': 'Worker not started',
        'taskSteer': 'Message the worker',
        'taskSteerPlaceholder': 'Add a constraint, correct direction, or ask the worker to stop and explain…',
        'taskSteerSend': 'Send',
        'taskSteering': 'Sending…',
        'taskSteerFailed': 'Could not send: {reason}',
        'openChat': 'Open chat',
        'openChatUnavailable': 'This task has no Worker session to open.',
        'openChatFailed': 'Could not open the Worker chat. Close the detail and try again.',
        'detailLoading': 'Loading task…',
        'detailFailed': 'Could not load task: {reason}',
        'models': 'Models',
        'modelsTitle': 'Worker models',
        'modelsNote': 'The Router can only choose Worker models from this list. Unchecking removes a model; "Use all models" follows the host catalog.',
        'modelsDefault': 'Default Worker model',
        'modelsEffort': 'Default reasoning effort',
        'modelsAll': 'Use all models',
        'modelsAllowlist': 'Callable models',
        'modelsSave': 'Save',
        'modelsSaving': 'Saving…',
        'modelsSaved': 'Saved',
        'modelsFailed': 'Could not save model settings: {reason}',
        'modelsEmpty': 'The host returned no model catalog.',
        'modelsUnavailable': 'Not in the host catalog',
        'modelsEfforts': 'Allowed reasoning efforts',
        'modelsNoEfforts': 'This model has no adjustable reasoning effort.',
        'modelsConfigured': '{count} configured',
        'modelsFiltered': '{count} in this source',
        'modelsAllMode': 'Following the full host catalog',
        'modelsAllowMode': 'Using a custom list',
        'close': 'Close',
        'rules': 'Rules',
        'rulesTitle': 'Working agreements',
        'rulesNote': 'When the user says "from now on…", the Router stores a durable rule and injects it into itself and every Worker. Global rules apply everywhere; project rules apply only there, and "replace" overrides globals for that project.',
        'rulesAdd': 'Add agreement',
        'rulesEdit': 'Edit',
        'rulesDelete': 'Delete',
        'rulesConfirmDelete': 'Confirm delete',
        'rulesSave': 'Save agreement',
        'rulesSaving': 'Saving…',
        'rulesCancel': 'Cancel',
        'rulesEmpty': 'No agreements yet.',
        'rulesGlobal': 'Global',
        'rulesProject': 'Project',
        'rulesModeAppend': 'Append',
        'rulesModeReplace': 'Replace globals',
        'rulesEnabled': 'Enabled',
        'rulesDisabled': 'Disabled',
        'rulesDisableAction': 'Disable',
        'rulesEnableAction': 'Enable',
        'rulesTitleField': 'Title (optional)',
        'rulesTextField': 'Agreement',
        'rulesTextPlaceholder': 'e.g. Lead with the outcome, stay under three sentences, never list files one by one.',
        'rulesProjectField': 'Scope',
        'rulesModeField': 'Mode',
        'rulesFailed': 'Could not save agreement: {reason}',
        'rulesLoaded': '{count} agreement(s)',
        'schedules': 'Schedules',
        'schedulesTitle': 'Scheduled tasks',
        'schedulesNote': 'At the target time the host wakes the Router; the Router checks state and decides what to dispatch. Times use the browser zone unless you give an IANA zone.',
        'schedulesEmpty': 'No scheduled tasks yet.',
        'schedulesCreate': 'New scheduled task',
        'schedulesRunNow': 'Run now',
        'schedulesCancel': 'Cancel',
        'schedulesConfirmCancel': 'Confirm cancel',
        'schedulesNext': 'Next',
        'schedulesState': 'State',
        'schedulesUnavailable': 'This deployment has no schedule service.',
        'schedulesFailed': 'Action failed: {reason}',
        'schedulesTitleField': 'Name',
        'schedulesPromptField': 'What to do when woken',
        'schedulesPromptPlaceholder': 'State the goal, project, constraints and expected result; this is all the Router sees when woken.',
        'schedulesWhen': 'When',
        'schedulesAfter': 'Minutes from now',
        'schedulesDaily': 'Daily',
        'schedulesWeekly': 'Weekly',
        'schedulesCron': 'Cron',
        'schedulesAt': 'At',
        'schedulesTime': 'Time',
        'schedulesWeekday': 'Weekday',
        'schedulesExpression': 'Cron expression',
        'schedulesZone': 'IANA zone (optional)',
        'schedulesSave': 'Create',
        'schedulesSaving': 'Creating…',
        'schedulesMax': 'up to {count}',
        'weekday1': 'Mon',
        'weekday2': 'Tue',
        'weekday3': 'Wed',
        'weekday4': 'Thu',
        'weekday5': 'Fri',
        'weekday6': 'Sat',
        'weekday7': 'Sun',
        'drawerActivity': 'Activity',
        'detailReportsCount': '{count} report(s)',
        'cancel': 'Cancel',
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
        position: 'relative',
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
      iconButton: {
        appearance: 'none',
        border: '1px solid rgba(127,127,127,.22)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 7,
        width: 30,
        height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      headerModel: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 7px',
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,.06))',
        maxWidth: 260,
        minWidth: 0,
      },
      select: {
        appearance: 'auto',
        border: '1px solid rgba(127,127,127,.22)',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'inherit',
        borderRadius: 6,
        padding: '4px 6px',
        fontSize: 11,
        maxWidth: '100%',
      },
      selectTiny: {
        appearance: 'auto',
        border: '1px solid rgba(127,127,127,.18)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 5,
        padding: '3px 4px',
        fontSize: 10,
      },
      railWrap: { position: 'relative', flex: '0 0 292px', width: 292, minHeight: 0, display: 'flex' },
      detailOverlay: {
        position: 'absolute',
        top: 8,
        right: 8,
        bottom: 8,
        width: 'min(420px, calc(100vw - 24px))',
        zIndex: 5,
        display: 'flex',
      },
      detailCard: {
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid rgba(127,127,127,.24)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-primary, #fff)',
        boxShadow: '0 10px 30px rgba(0,0,0,.16)',
        overflow: 'hidden',
      },
      detailHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 10px 8px',
        borderBottom: '1px solid rgba(127,127,127,.14)',
        flex: '0 0 auto',
      },
      detailFooter: {
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '8px 10px',
        borderTop: '1px solid rgba(127,127,127,.14)',
        background: 'var(--dsw-alias-bg-primary, #fff)',
        flex: '0 0 auto',
      },
      detailTitle: { fontSize: 12, fontWeight: 650, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      detailBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '10px 12px 16px' },
      detailMeta: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
      badge: {
        fontSize: 10,
        lineHeight: 1.5,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,.22)',
        background: 'rgba(127,127,127,.08)',
        whiteSpace: 'nowrap',
      },
      detailSection: { marginTop: 14 },
      detailSectionTitle: { fontSize: 10, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.5, marginBottom: 6 },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.6, fontFamily: 'inherit' },
      reportCard: { border: '1px solid rgba(127,127,127,.16)', borderRadius: 8, padding: '8px 9px', marginBottom: 7, background: 'rgba(127,127,127,.035)' },
      reportHead: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, fontSize: 10, opacity: 0.55 },
      linkButton: { appearance: 'none', border: 0, background: 'none', color: 'var(--dsw-alias-accent, #4f7cff)', padding: 0, fontSize: 11, cursor: 'pointer' },
      backdrop: { position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,.28)', display: 'flex', justifyContent: 'flex-end' },
      drawer: {
        width: 430,
        maxWidth: '94vw',
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-primary, #fff)',
        borderLeft: '1px solid rgba(127,127,127,.24)',
        boxShadow: '-16px 0 40px rgba(0,0,0,.16)',
      },
      drawerWide: { width: 520 },
      drawerHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(127,127,127,.14)', flex: '0 0 auto' },
      drawerTitle: { fontSize: 13, fontWeight: 650, flex: '1 1 auto' },
      drawerBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px 24px' },
      drawerFooter: { padding: '10px 14px', borderTop: '1px solid rgba(127,127,127,.14)', display: 'flex', justifyContent: 'flex-end', gap: 8, flex: '0 0 auto' },
      hint: { fontSize: 10.5, lineHeight: 1.55, opacity: 0.58, margin: '0 0 12px' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
      label: { fontSize: 10.5, fontWeight: 600, opacity: 0.66 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,.26)',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'inherit',
        borderRadius: 7,
        padding: '7px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 84,
        resize: 'vertical',
        border: '1px solid rgba(127,127,127,.26)',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'inherit',
        borderRadius: 7,
        padding: '7px 8px',
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: 'inherit',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      itemCard: { border: '1px solid rgba(127,127,127,.18)', borderRadius: 9, padding: '9px 10px', marginBottom: 8, background: 'rgba(127,127,127,.025)' },
      itemTitle: { fontSize: 12, fontWeight: 650, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      itemText: { fontSize: 11.5, lineHeight: 1.55, marginTop: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      itemMeta: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 10, opacity: 0.6 },
      chip: {
        appearance: 'none',
        border: '1px solid rgba(127,127,127,.24)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 999,
        padding: '3px 8px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      chipActive: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-accent, #4f7cff)',
        background: 'color-mix(in srgb, var(--dsw-alias-accent, #4f7cff) 14%, transparent)',
        color: 'inherit',
        borderRadius: 999,
        padding: '3px 8px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      checkboxRow: { display: 'flex', gap: 7, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid rgba(127,127,127,.1)' },
      empty: { padding: '24px 8px', textAlign: 'center', fontSize: 11.5, opacity: 0.5, lineHeight: 1.6 },
      smallButton: {
        appearance: 'none',
        border: '1px solid rgba(127,127,127,.24)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '3px 7px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      dangerButton: {
        appearance: 'none',
        border: '1px solid rgba(220,80,80,.4)',
        background: 'rgba(220,80,80,.08)',
        color: 'inherit',
        borderRadius: 6,
        padding: '3px 7px',
        fontSize: 10.5,
        cursor: 'pointer',
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

    /** uiWorkspace 晚于本插件就绪；由 apply 里的可选 inject 捕获，点击时再解析。 */
    let workspaceService

    function resolveWorkspaceService(ctx) {
      try {
        if (workspaceService !== undefined && typeof workspaceService.openSession === 'function') return workspaceService
      } catch {
        /* ignore */
      }
      try {
        const direct = ctx?.uiWorkspace
        if (direct !== undefined && typeof direct.openSession === 'function') return direct
      } catch {
        /* ignore */
      }
      try {
        const viaGet = ctx?.get?.('uiWorkspace')
        if (viaGet !== undefined && typeof viaGet.openSession === 'function') return viaGet
      } catch {
        /* ignore */
      }
      return undefined
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

    async function getJson(url) {
      const response = await fetch(url, { credentials: 'same-origin' })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    function formatWhen(value) {
      if (value === undefined || value === null || value === '') return ''
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        const now = new Date()
        const sameDay = date.getFullYear() === now.getFullYear()
          && date.getMonth() === now.getMonth()
          && date.getDate() === now.getDate()
        if (sameDay) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        if (date.getFullYear() === now.getFullYear()) {
          return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        }
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      } catch {
        return date.toISOString()
      }
    }

    function statusColor(status) {
      return activityMeta(status).color
    }

    function Drawer({ title, t, onClose, children, footer, wide = false }) {
      return h('div', {
        style: S.backdrop,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
        h('div', { style: wide ? { ...S.drawer, ...S.drawerWide } : S.drawer, role: 'dialog', 'aria-label': title },
          h('div', { style: S.drawerHeader },
            h('div', { style: S.drawerTitle }, title),
            h('button', { type: 'button', style: S.iconButton, onClick: onClose, title: t('close'), 'aria-label': t('close') }, '✕'),
          ),
          h('div', { style: S.drawerBody }, children),
          footer === undefined ? null : h('div', { style: S.drawerFooter }, footer),
        ),
      )
    }

    function Field({ label, children }) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, label),
        children,
      )
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
    function ActivityRow({ task, t, onSelect, selected }) {
      const meta = activityMeta(task.status)
      return h('button', {
        type: 'button',
        className: 'sa-activity-row',
        style: {
          ...S.activityRow,
          width: '100%',
          border: 0,
          textAlign: 'left',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          background: selected ? 'rgba(127,127,127,.10)' : 'transparent',
        },
        onClick: () => onSelect(task),
        title: task.title,
      },
        h('span', {
          className: task.status === 'working' || task.status === 'starting' ? 'sa-pulse' : undefined,
          style: { ...S.activityDot, background: meta.color },
          'aria-hidden': 'true',
        }),
        h('div', { style: S.activityMain },
          h('div', { style: S.activityTitle }, task.title || 'Untitled task'),
          h('div', { style: S.activityMeta },
            h('span', {}, t(meta.key)),
            taskProject(task) ? h('span', { style: S.activityProject }, `· ${taskProject(task)}`) : null,
            task.lastReport?.at ? h('span', {}, `· ${formatWhen(task.lastReport.at)}`) : null,
          ),
        ),
      )
    }

    const REPORT_LABEL = {
      completed: 'statusIdle',
      blocked: 'statusBlocked',
      failed: 'statusFailed',
      interrupted: 'statusInterrupted',
      lost: 'statusLost',
      aborted: 'statusInterrupted',
    }

    /** dot 风格的小任务窗口：覆盖在活动栏上，不离开当前对话。 */
    function ActivityDetail({ task, loading, error, t, onBack, onOpenChat, canOpenChat, onSteer, steerBusy, steerError }) {
      const [steerText, setSteerText] = React.useState('')
      React.useEffect(() => { setSteerText('') }, [task?.id])
      if (loading) {
        return h('div', { style: S.detailCard }, h('div', { style: S.empty }, t('detailLoading')))
      }
      if (task === undefined) {
        return h('div', { style: S.detailCard },
          h('div', { style: S.detailHeader },
            h('button', { type: 'button', style: S.iconButton, onClick: onBack, title: t('activityBack'), 'aria-label': t('activityBack') }, '‹'),
            h('div', { style: S.detailTitle }, t('taskDetail')),
          ),
          h('div', { style: S.empty }, error || t('detailFailed', { reason: 'unknown' })),
        )
      }
      const meta = activityMeta(task.status)
      const reports = Array.isArray(task.reports) ? task.reports : []
      return h('div', { style: S.detailCard },
        h('div', { style: S.detailHeader },
          h('button', { type: 'button', style: S.iconButton, onClick: onBack, title: t('activityBack'), 'aria-label': t('activityBack') }, '‹'),
          h('div', { style: S.detailTitle, title: task.title }, task.title),
          h('button', { type: 'button', style: S.iconButton, onClick: onBack, title: t('close'), 'aria-label': t('close') }, '✕'),
        ),
        h('div', { style: S.detailBody },
          h('div', { style: S.detailMeta },
            h('span', { style: { ...S.badge, color: meta.color, borderColor: `${meta.color}66` } }, t(meta.key)),
            taskProject(task) ? h('span', { style: S.badge }, taskProject(task)) : null,
            task.modelLabel ? h('span', { style: S.badge }, `${t('taskModel')}: ${task.modelLabel}${task.reasoningEffort ? ` · ${task.reasoningEffort}` : ''}`) : null,
            h('span', { style: S.badge }, task.status === 'closed'
              ? t('taskWorkerGone')
              : (task.workerLive ? t('taskWorkerLive') : (task.workerSessionId ? t('taskWorkerGone') : t('taskWorkerNotStarted')))),
          ),
          h('div', { style: S.detailMeta },
            task.createdAt ? h('span', { style: S.badge }, `${t('taskCreated')} ${formatWhen(task.createdAt)}`) : null,
            task.updatedAt ? h('span', { style: S.badge }, `${t('taskUpdated')} ${formatWhen(task.updatedAt)}`) : null,
          ),
          h('div', { style: S.detailSection },
            h('div', { style: S.detailSectionTitle }, t('taskBrief')),
            h('div', { style: S.pre }, task.brief || '—'),
          ),
          h('div', { style: S.detailSection },
            h('div', { style: S.detailSectionTitle }, `${t('taskReports')} · ${reports.length}`),
            reports.length === 0
              ? h('div', { style: { ...S.pre, opacity: 0.5 } }, t('taskNoReports'))
              : reports.slice().reverse().map((report) => h('div', { key: report.id ?? `${report.at}-${report.reason}`, style: S.reportCard },
                  h('div', { style: S.reportHead },
                    h('span', { style: { width: 6, height: 6, borderRadius: 999, background: statusColor(report.reason === 'completed' ? 'idle' : report.reason) } }),
                    h('span', {}, t(REPORT_LABEL[report.reason] ?? 'statusUnknown')),
                    report.at ? h('span', {}, `· ${formatWhen(report.at)}`) : null,
                  ),
                  h('div', { style: S.pre }, report.text || '—'),
                )),
          ),
          Array.isArray(task.threads) && task.threads.length > 0
            ? h('div', { style: S.detailSection },
                h('div', { style: S.detailSectionTitle }, t('taskThreads')),
                task.threads.map((thread) => h('div', { key: thread.id, style: S.reportCard },
                  h('div', { style: S.itemTitle }, thread.title || thread.id),
                  h('div', { style: S.itemMeta }, `${thread.source} · ${thread.triggerCount ?? 0} trigger(s)`),
                )),
              )
            : null,
          task.workerLive && task.status !== 'closed'
            ? h('div', { style: S.detailSection },
                h('div', { style: S.detailSectionTitle }, t('taskSteer')),
                h('textarea', {
                  style: { ...S.textarea, minHeight: 64 },
                  value: steerText,
                  placeholder: t('taskSteerPlaceholder'),
                  onChange: (event) => setSteerText(event.target.value),
                }),
                steerError ? h('div', { style: S.error }, steerError) : null,
                h('div', { style: { ...S.row, marginTop: 6, justifyContent: 'flex-end' } },
                  h('button', {
                    type: 'button',
                    style: { ...S.buttonPrimary, opacity: steerBusy || steerText.trim().length === 0 ? 0.55 : 1 },
                    disabled: steerBusy || steerText.trim().length === 0,
                    onClick: async () => {
                      const sent = await onSteer?.(steerText)
                      if (sent === true) setSteerText('')
                    },
                  }, steerBusy ? t('taskSteering') : t('taskSteerSend')),
                ),
              )
            : null,
        ),
        h('div', { style: S.detailFooter },
          h('button', {
            type: 'button',
            style: canOpenChat ? S.buttonPrimary : S.button,
            disabled: !canOpenChat,
            title: canOpenChat ? t('openChat') : t('openChatUnavailable'),
            onClick: onOpenChat,
          }, t('openChat')),
        ),
      )
    }

    /**
     * 右侧活动栏：只来自 runtime 的 task 快照，不伪造消息、不展示 Worker 会话。
     * 进行中和已结束的任务放在同一条时间线里；默认截断，任务多时展开。
     */
    function ActivityRail({ tasks, t, detail, detailLoading, detailError, onSelect, selectedId, onBackDetail, onOpenChat, canOpenChat, onSteer, steerBusy, steerError, embedded = false, onLoadMore }) {
      const [showAll, setShowAll] = React.useState(false)
      const limit = 6
      const rows = Array.isArray(tasks)
        ? tasks.slice().sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
        : []
      const visible = showAll ? rows : rows.slice(0, limit)
      const total = rows.length
      const railStyle = embedded
        ? { ...S.rail, flex: '1 1 auto', width: '100%', borderLeft: 0, height: '100%' }
        : S.rail
      const detailNode = detail !== undefined || detailLoading
        ? h('div', { style: embedded ? { flex: '1 1 auto', minHeight: 0, display: 'flex' } : S.detailOverlay },
            h(ActivityDetail, { task: detail, loading: detailLoading, error: detailError, t, onBack: onBackDetail, onOpenChat, canOpenChat, onSteer, steerBusy, steerError }),
          )
        : null
      return h('div', {
        style: embedded
          ? { display: 'flex', width: '100%', height: '100%', minHeight: 0 }
          : S.railWrap,
        className: embedded ? undefined : 'sa-rail-wrap',
      },
        h('aside', { style: railStyle, className: embedded ? undefined : 'sa-activity', 'aria-label': t('activityTitle') },
          h('div', { style: S.railHeader },
            h('div', { style: S.railTitle }, t('activityTitle')),
            total > 0 ? h('span', { style: S.railCount }, total) : null,
          ),
          h('div', { style: S.railScroll },
            visible.length === 0
              ? h('div', { style: S.empty }, t('activityEmpty'))
              : visible.map((task) => h(ActivityRow, {
                  key: task.id,
                  task,
                  t,
                  onSelect,
                  selected: selectedId === task.id,
                })),
            rows.length > limit
              ? h('button', {
                  type: 'button',
                  style: S.moreButton,
                  onClick: () => {
                    if (!showAll && typeof onLoadMore === 'function') onLoadMore()
                    setShowAll((value) => !value)
                  },
                }, showAll ? t('hideMore') : t('showMore'))
              : null,
          ),
        ),
        detailNode,
      )
    }

    // ── 模型 / 规则 / 计划抽屉 ────────────────────────────────────────────────

    function catalogEntries(data) {
      const groups = Array.isArray(data?.catalog?.groups) ? data.catalog.groups : []
      const out = []
      for (const group of groups) {
        for (const model of Array.isArray(group?.models) ? group.models : []) {
          out.push({
            key: `${group.id}/${model.id}`,
            provider: group.id,
            providerName: group.name ?? group.id,
            model: model.id,
            name: model.name ?? model.id,
            description: model.description,
            efforts: Array.isArray(model.reasoning?.efforts)
              ? model.reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name ?? effort.id }))
              : [],
            defaultEffort: model.reasoning?.defaultEffort,
          })
        }
      }
      return out
    }

    function initialModelDraft(data) {
      const entries = catalogEntries(data)
      const configured = new Map((data?.models ?? []).map((entry) => [`${entry.provider}/${entry.model}`, entry]))
      const checked = {}
      for (const entry of entries) {
        const existing = configured.get(entry.key)
        checked[entry.key] = {
          on: data?.mode === 'all' || data?.mode === 'filtered' ? true : existing !== undefined,
          efforts: existing?.efforts?.map((effort) => effort.id) ?? entry.efforts.map((effort) => effort.id),
          defaultEffort: existing?.defaultEffort ?? entry.defaultEffort,
        }
      }
      return { checked, defaultId: data?.defaultId ?? entries[0]?.key ?? '' }
    }

    function ModelsPanel({ t, data, loading, saving, error, onClose, onSave, onSaveAll }) {
      const [draft, setDraft] = React.useState(() => initialModelDraft(data))
      const [localError, setLocalError] = React.useState('')
      React.useEffect(() => {
        if (data !== undefined) setDraft(initialModelDraft(data))
      }, [data])
      const entries = catalogEntries(data)
      const selectedKeys = entries.filter((entry) => draft.checked[entry.key]?.on).map((entry) => entry.key)
      const defaultEntry = entries.find((entry) => entry.key === draft.defaultId)
      const defaultEfforts = defaultEntry?.efforts ?? []
      const update = (key, patch) => {
        setDraft((current) => ({
          ...current,
          checked: {
            ...current.checked,
            [key]: { ...current.checked[key], ...patch },
          },
        }))
      }
      const toggleModel = (entry) => {
        const nextOn = !draft.checked[entry.key]?.on
        update(entry.key, { on: nextOn })
        if (nextOn && draft.defaultId.length === 0) setDraft((current) => ({ ...current, defaultId: entry.key }))
        if (!nextOn && draft.defaultId === entry.key) {
          const fallback = entries.find((candidate) => candidate.key !== entry.key && draft.checked[candidate.key]?.on)
          setDraft((current) => ({ ...current, defaultId: fallback?.key ?? '' }))
        }
      }
      const toggleEffort = (entry, effortId) => {
        const current = draft.checked[entry.key]?.efforts ?? []
        const has = current.includes(effortId)
        const next = has ? current.filter((id) => id !== effortId) : [...current, effortId]
        update(entry.key, {
          efforts: next,
          defaultEffort: next.includes(draft.checked[entry.key]?.defaultEffort) ? draft.checked[entry.key]?.defaultEffort : next[0],
        })
      }
      const save = () => {
        if (selectedKeys.length === 0) {
          setLocalError(t('modelsEmpty'))
          return
        }
        setLocalError('')
        const allowed = entries.filter((entry) => draft.checked[entry.key]?.on).map((entry) => {
          const choice = draft.checked[entry.key]
          const allEfforts = entry.efforts.map((effort) => effort.id)
          const efforts = choice.efforts.filter((id) => allEfforts.includes(id))
          return {
            id: entry.key,
            provider: entry.provider,
            model: entry.model,
            label: entry.name,
            ...(efforts.length > 0 && efforts.length < allEfforts.length ? { efforts } : {}),
            ...(choice.defaultEffort ? { defaultEffort: choice.defaultEffort } : {}),
            ...(entry.description ? { note: entry.description } : {}),
          }
        })
        onSave({ allowed, default: draft.defaultId, defaultEffort: draft.checked[draft.defaultId]?.defaultEffort })
      }
      const footer = h(React.Fragment, null,
        h('button', { type: 'button', style: S.button, disabled: saving || loading, onClick: () => onSaveAll(draft.defaultId, draft.checked[draft.defaultId]?.defaultEffort) }, t('modelsAll')),
        h('button', { type: 'button', style: S.buttonPrimary, disabled: saving || loading || selectedKeys.length === 0, onClick: save }, saving ? t('modelsSaving') : t('modelsSave')),
      )
      return h(Drawer, { title: t('modelsTitle'), t, onClose, footer, wide: true },
        h('p', { style: S.hint }, t('modelsNote')),
        error || localError ? h('div', { style: S.error }, error || localError) : null,
        loading ? h('div', { style: S.empty }, t('loading')) : null,
        data === undefined ? null : h(React.Fragment, null,
          h('div', { style: S.row },
            h('span', { style: { ...S.badge, opacity: 0.7 } }, data.mode === 'all' ? t('modelsAllMode') : (data.mode === 'filtered' ? format(t, 'modelsFiltered', { count: data.configuredCount ?? data.models?.length ?? 0 }) : format(t, 'modelsConfigured', { count: data.configuredCount ?? data.models?.length ?? 0 }))),
            data.warnings?.length > 0 ? h('span', { style: { ...S.badge, opacity: 0.7 } }, data.warnings[0]) : null,
          ),
          h('div', { style: { ...S.detailSection, marginTop: 12 } },
            h('div', { style: S.detailSectionTitle }, t('modelsDefault')),
            h('div', { style: S.row },
              h('select', {
                style: { ...S.select, minWidth: 190, maxWidth: 280 },
                value: draft.defaultId,
                onChange: (event) => setDraft((current) => ({ ...current, defaultId: event.target.value })),
              }, entries.filter((entry) => draft.checked[entry.key]?.on).map((entry) => h('option', { key: entry.key, value: entry.key }, `${entry.name} · ${entry.providerName}`))),
              defaultEfforts.length > 0
                ? h('select', {
                    style: S.select,
                    value: draft.checked[draft.defaultId]?.defaultEffort ?? '',
                    onChange: (event) => update(draft.defaultId, { defaultEffort: event.target.value }),
                    title: t('modelsEffort'),
                  }, defaultEfforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)))
                : null,
            ),
          ),
          h('div', { style: S.detailSection },
            h('div', { style: S.detailSectionTitle }, t('modelsAllowlist')),
            entries.length === 0 ? h('div', { style: S.empty }, t('modelsEmpty')) : null,
            entries.map((entry) => {
              const choice = draft.checked[entry.key] ?? { on: false, efforts: [] }
              return h('div', { key: entry.key, style: S.checkboxRow },
                h('input', { type: 'checkbox', checked: choice.on === true, onChange: () => toggleModel(entry), style: { marginTop: 2 } }),
                h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                  h('div', { style: { fontSize: 11.5, fontWeight: 600 } }, `${entry.name}`, h('span', { style: { fontWeight: 400, opacity: 0.5 } }, `  ${entry.providerName}/${entry.model}`)),
                  entry.description ? h('div', { style: { fontSize: 10.5, opacity: 0.55, lineHeight: 1.4 } }, entry.description) : null,
                  choice.on && entry.efforts.length > 0
                    ? h('div', { style: { ...S.row, gap: 4, marginTop: 4 } },
                        h('span', { style: { fontSize: 10, opacity: 0.5 } }, t('modelsEfforts')),
                        entry.efforts.map((effort) => h('button', {
                          key: effort.id,
                          type: 'button',
                          style: choice.efforts.includes(effort.id) ? S.chipActive : S.chip,
                          onClick: () => toggleEffort(entry, effort.id),
                        }, effort.name)),
                      )
                    : null,
                  choice.on && entry.efforts.length === 0 ? h('div', { style: { fontSize: 10, opacity: 0.42, marginTop: 3 } }, t('modelsNoEfforts')) : null,
                ),
              )
            }),
          ),
        ),
      )
    }

    function AgreementsPanel({ t, data, loading, saving, error, onClose, onSave, onToggle, onRemove }) {
      const [draft, setDraft] = React.useState(undefined)
      const [confirmId, setConfirmId] = React.useState('')
      const [localError, setLocalError] = React.useState('')
      const projects = Array.isArray(data?.projects) ? data.projects : []
      const startNew = () => setDraft({ id: undefined, title: '', text: '', project: '', mode: 'append', enabled: true })
      const startEdit = (item) => setDraft({ id: item.id, title: item.title, text: item.text, project: item.project ?? '', mode: item.mode ?? 'append', enabled: item.enabled !== false })
      const submit = async () => {
        if (draft === undefined) return
        if (String(draft.text ?? '').trim().length === 0) {
          setLocalError(t('rulesTextField'))
          return
        }
        setLocalError('')
        const result = await onSave(draft)
        // 保存成功才收起编辑卡；失败时保留用户输入，避免白写一遍。
        if (result !== undefined) setDraft(undefined)
      }
      const footer = draft === undefined
        ? h('button', { type: 'button', style: S.buttonPrimary, onClick: startNew }, t('rulesAdd'))
        : h(React.Fragment, null,
            h('button', { type: 'button', style: S.button, onClick: () => setDraft(undefined), disabled: saving }, t('rulesCancel')),
            h('button', { type: 'button', style: S.buttonPrimary, onClick: () => { void submit() }, disabled: saving }, saving ? t('rulesSaving') : t('rulesSave')),
          )
      return h(Drawer, { title: t('rulesTitle'), t, onClose, footer },
        h('p', { style: S.hint }, t('rulesNote')),
        error || localError ? h('div', { style: S.error }, error || localError) : null,
        loading ? h('div', { style: S.empty }, t('loading')) : null,
        draft !== undefined ? h('div', { style: { ...S.itemCard, marginBottom: 14 } },
          h(Field, { label: t('rulesTitleField') },
            h('input', { style: S.input, value: draft.title, onChange: (event) => setDraft({ ...draft, title: event.target.value }) }),
          ),
          h(Field, { label: t('rulesTextField') },
            h('textarea', { style: S.textarea, value: draft.text, placeholder: t('rulesTextPlaceholder'), onChange: (event) => setDraft({ ...draft, text: event.target.value }) }),
          ),
          h('div', { style: S.row },
            h(Field, { label: t('rulesProjectField') },
              h('select', {
                style: { ...S.select, minWidth: 150 },
                value: draft.project ?? '',
                onChange: (event) => setDraft({ ...draft, project: event.target.value }),
              },
                h('option', { value: '' }, t('rulesGlobal')),
                projects.map((project) => h('option', { key: project.path ?? project.title, value: project.path ?? '' }, project.title ?? project.path)),
              ),
            ),
            h(Field, { label: t('rulesModeField') },
              h('select', {
                style: S.select,
                value: draft.mode ?? 'append',
                onChange: (event) => setDraft({ ...draft, mode: event.target.value }),
              },
                h('option', { value: 'append' }, t('rulesModeAppend')),
                h('option', { value: 'replace' }, t('rulesModeReplace')),
              ),
            ),
          ),
        ) : null,
        data === undefined || loading ? null : (data.agreements?.length === 0
          ? h('div', { style: S.empty }, t('rulesEmpty'))
          : h(React.Fragment, null,
              h('div', { style: { ...S.label, marginBottom: 6 } }, format(t, 'rulesLoaded', { count: data.agreements.length })),
              data.agreements.map((item) => h('div', { key: item.id, style: S.itemCard },
                h('div', { style: S.itemTitle },
                  h('span', {}, item.title),
                  h('span', { style: { ...S.badge, opacity: 0.7 } }, item.project ? `${t('rulesProject')}: ${item.projectTitle ?? item.project}` : t('rulesGlobal')),
                  item.mode === 'replace' ? h('span', { style: { ...S.badge, opacity: 0.7 } }, t('rulesModeReplace')) : null,
                  item.enabled === false ? h('span', { style: { ...S.badge, opacity: 0.55 } }, t('rulesDisabled')) : null,
                ),
                h('div', { style: S.itemText }, item.text),
                h('div', { style: S.itemMeta },
                  h('button', { type: 'button', style: S.smallButton, onClick: () => onToggle(item, item.enabled === false) }, item.enabled === false ? t('rulesEnableAction') : t('rulesDisableAction')),
                  h('button', { type: 'button', style: S.smallButton, onClick: () => startEdit(item), disabled: saving }, t('rulesEdit')),
                  confirmId === item.id
                    ? h('button', { type: 'button', style: S.dangerButton, onClick: () => { setConfirmId(''); onRemove(item) }, disabled: saving }, t('rulesConfirmDelete'))
                    : h('button', { type: 'button', style: S.dangerButton, onClick: () => setConfirmId(item.id), disabled: saving }, t('rulesDelete')),
                ),
              )),
            )),
      )
    }

    const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

    function scheduleRecurrence(schedule, t) {
      if (typeof schedule?.recurrence === 'string' && schedule.recurrence.length > 0) return schedule.recurrence
      return schedule?.kind ?? ''
    }

    function SchedulesPanel({ t, data, loading, error, busy, onClose, onRefresh, onCreate, onCancel, onRun }) {
      const [draft, setDraft] = React.useState({ kind: 'after', title: '', prompt: '', minutes: '60', time: '09:00', weekday: '1', expression: '0 9 * * 1-5', zone: '', at: '' })
      const [localError, setLocalError] = React.useState('')
      const [confirmId, setConfirmId] = React.useState('')
      const schedules = Array.isArray(data?.schedules) ? data.schedules : []
      const set = (patch) => setDraft((current) => ({ ...current, ...patch }))
      const submit = async () => {
        if (draft.title.trim().length === 0 || draft.prompt.trim().length === 0) {
          setLocalError(t('schedulesPromptField'))
          return
        }
        setLocalError('')
        const payload = { title: draft.title.trim(), prompt: draft.prompt }
        if (draft.kind === 'after') payload.after_seconds = Math.max(1, Math.round(Number(draft.minutes) * 60))
        else if (draft.kind === 'daily') payload.daily = { time: draft.time.length === 5 ? `${draft.time}:00` : draft.time, ...(draft.zone ? { time_zone: draft.zone } : {}) }
        else if (draft.kind === 'weekly') payload.weekly = { time: draft.time.length === 5 ? `${draft.time}:00` : draft.time, weekdays: [Number(draft.weekday)], ...(draft.zone ? { time_zone: draft.zone } : {}) }
        else if (draft.kind === 'cron') payload.cron = { expression: draft.expression, ...(draft.zone ? { time_zone: draft.zone } : {}) }
        else {
          const at = new Date(draft.at)
          if (Number.isNaN(at.getTime())) {
            setLocalError(t('schedulesAt'))
            return
          }
          payload.at = at.toISOString()
        }
        const result = await onCreate(payload)
        if (result !== undefined) {
          setDraft((current) => ({ ...current, title: '', prompt: '' }))
        }
      }
      const footer = h(React.Fragment, null,
        h('button', { type: 'button', style: S.button, onClick: onRefresh, disabled: busy }, t('refresh')),
        h('button', { type: 'button', style: S.buttonPrimary, onClick: () => { void submit() }, disabled: busy || data?.available === false }, busy ? t('schedulesSaving') : t('schedulesSave')),
      )
      return h(Drawer, { title: t('schedulesTitle'), t, onClose, footer, wide: true },
        h('p', { style: S.hint }, t('schedulesNote')),
        error || localError ? h('div', { style: S.error }, error || localError) : null,
        data?.available === false ? h('div', { style: S.empty }, t('schedulesUnavailable')) : null,
        loading ? h('div', { style: S.empty }, t('loading')) : null,
        data === undefined || loading ? null : h(React.Fragment, null,
          h('div', { style: S.row },
            h('span', { style: { ...S.badge, opacity: 0.7 } }, `${schedules.length}/${data.maxActive ?? '?'}`),
            h('span', { style: { ...S.badge, opacity: 0.7 } }, data.timeZone ?? ''),
            h('span', { style: { fontSize: 10, opacity: 0.45 } }, format(t, 'schedulesMax', { count: data.maxActive ?? '?' })),
          ),
          schedules.length === 0
            ? h('div', { style: S.empty }, t('schedulesEmpty'))
            : h('div', { style: { marginTop: 10 } }, schedules.map((schedule) => h('div', { key: schedule.id, style: S.itemCard },
                h('div', { style: S.itemTitle }, schedule.title, h('span', { style: { ...S.badge, opacity: 0.65 } }, schedule.state ?? 'scheduled')),
                h('div', { style: S.itemMeta },
                  h('span', {}, scheduleRecurrence(schedule, t)),
                  schedule.scheduledAt ? h('span', {}, `${t('schedulesNext')} ${formatWhen(schedule.scheduledAt)}`) : null,
                ),
                h('div', { style: { ...S.row, marginTop: 6 } },
                  h('button', { type: 'button', style: S.smallButton, disabled: busy, onClick: () => onRun(schedule) }, t('schedulesRunNow')),
                  confirmId === schedule.id
                    ? h('button', { type: 'button', style: S.dangerButton, disabled: busy, onClick: () => { setConfirmId(''); onCancel(schedule) } }, t('schedulesConfirmCancel'))
                    : h('button', { type: 'button', style: S.dangerButton, disabled: busy, onClick: () => setConfirmId(schedule.id) }, t('schedulesCancel')),
                ),
              ))),
          h('div', { style: { ...S.detailSection, borderTop: '1px solid rgba(127,127,127,.14)', paddingTop: 12 } },
            h('div', { style: S.detailSectionTitle }, t('schedulesCreate')),
            h(Field, { label: t('schedulesTitleField') },
              h('input', { style: S.input, value: draft.title, onChange: (event) => set({ title: event.target.value }) }),
            ),
            h(Field, { label: t('schedulesPromptField') },
              h('textarea', { style: { ...S.textarea, minHeight: 72 }, value: draft.prompt, placeholder: t('schedulesPromptPlaceholder'), onChange: (event) => set({ prompt: event.target.value }) }),
            ),
            h('div', { style: S.row },
              h(Field, { label: t('schedulesWhen') },
                h('select', { style: S.select, value: draft.kind, onChange: (event) => set({ kind: event.target.value }) },
                  h('option', { value: 'after' }, t('schedulesAfter')),
                  h('option', { value: 'daily' }, t('schedulesDaily')),
                  h('option', { value: 'weekly' }, t('schedulesWeekly')),
                  h('option', { value: 'cron' }, t('schedulesCron')),
                  h('option', { value: 'at' }, t('schedulesAt')),
                ),
              ),
              draft.kind === 'after'
                ? h(Field, { label: t('schedulesAfter') }, h('input', { type: 'number', min: 1, style: { ...S.input, width: 90 }, value: draft.minutes, onChange: (event) => set({ minutes: event.target.value }) }))
                : null,
              draft.kind === 'daily' || draft.kind === 'weekly'
                ? h(Field, { label: t('schedulesTime') }, h('input', { type: 'time', style: { ...S.input, width: 110 }, value: draft.time, onChange: (event) => set({ time: event.target.value }) }))
                : null,
              draft.kind === 'weekly'
                ? h(Field, { label: t('schedulesWeekday') },
                    h('select', { style: S.select, value: draft.weekday, onChange: (event) => set({ weekday: event.target.value }) },
                      WEEKDAYS.map((day) => h('option', { key: day, value: String(day) }, t(`weekday${day}`))),
                    ),
                  )
                : null,
              draft.kind === 'cron'
                ? h(Field, { label: t('schedulesExpression') }, h('input', { style: { ...S.input, width: 170 }, value: draft.expression, onChange: (event) => set({ expression: event.target.value }) }))
                : null,
              draft.kind === 'at'
                ? h(Field, { label: t('schedulesAt') }, h('input', { type: 'datetime-local', style: { ...S.input, width: 190 }, value: draft.at, onChange: (event) => set({ at: event.target.value }) }))
                : null,
              draft.kind === 'daily' || draft.kind === 'weekly' || draft.kind === 'cron'
                ? h(Field, { label: t('schedulesZone') }, h('input', { style: { ...S.input, width: 180 }, placeholder: 'America/Los_Angeles', value: draft.zone, onChange: (event) => set({ zone: event.target.value }) }))
                : null,
            ),
          ),
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
      const [activityFull, setActivityFull] = React.useState(undefined)
      const [detailId, setDetailId] = React.useState('')
      const [detail, setDetail] = React.useState(undefined)
      const [detailLoading, setDetailLoading] = React.useState(false)
      const [detailError, setDetailError] = React.useState('')
      const [steerBusy, setSteerBusy] = React.useState(false)
      const [steerError, setSteerError] = React.useState('')
      const [drawer, setDrawer] = React.useState('')
      const [modelsData, setModelsData] = React.useState(undefined)
      const [modelsLoading, setModelsLoading] = React.useState(false)
      const [modelsSaving, setModelsSaving] = React.useState(false)
      const [modelsError, setModelsError] = React.useState('')
      const [rulesData, setRulesData] = React.useState(undefined)
      const [rulesLoading, setRulesLoading] = React.useState(false)
      const [rulesSaving, setRulesSaving] = React.useState(false)
      const [rulesError, setRulesError] = React.useState('')
      const [schedulesData, setSchedulesData] = React.useState(undefined)
      const [schedulesLoading, setSchedulesLoading] = React.useState(false)
      const [schedulesBusy, setSchedulesBusy] = React.useState(false)
      const [schedulesError, setSchedulesError] = React.useState('')
      const attempted = React.useRef(false)
      const mounted = React.useRef(true)
      const detailRequest = React.useRef('')
      const modelsAttempted = React.useRef(false)

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
          setActivityFull(undefined)
          setDetailId('')
          setDetail(undefined)
          setDetailLoading(false)
          setDrawer('')
          setModelsData(undefined)
          modelsAttempted.current = false
          setRulesData(undefined)
          setSchedulesData(undefined)
          const summary = summarizeStatus(info)
          if (summary !== null) {
            const pieces = [summary.active ? t('running') : t('idle')]
            if (summary.workers > 0) pieces.push(format(t, 'workers', { count: summary.workers }))
            if (summary.pending > 0) pieces.push(format(t, 'pending', { count: summary.pending }))
            if (summary.tasks > 0) pieces.push(format(t, 'tasks', { count: summary.tasks }))
            if (Number(payload.schedulesCanceled ?? 0) > 0) {
              pieces.push(format(t, 'schedulesCanceled', { count: payload.schedulesCanceled }))
            }
            setStatusLine(pieces.join(' · '))
          }
          void fetchState()
        } catch (cause) {
          if (mounted.current) setError(format(t, 'resetFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setResetting(false)
        }
      }, [fetchState, resetConfirm, t])

      // ── 抽屉数据与动作 ───────────────────────────────────────────────────

      const loadModels = React.useCallback(async (force = true) => {
        setModelsLoading(true)
        setModelsError('')
        try {
          const payload = await getJson(`${ROUTES.models}${force ? '?refresh=1' : ''}`)
          if (mounted.current) setModelsData(payload)
        } catch (cause) {
          if (mounted.current) setModelsError(format(t, 'modelsFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setModelsLoading(false)
        }
      }, [t])

      const saveModels = React.useCallback(async (body) => {
        setModelsSaving(true)
        setModelsError('')
        try {
          const { response, payload } = await postJson(ROUTES.models, body)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (mounted.current) setModelsData(payload)
          return payload
        } catch (cause) {
          if (mounted.current) setModelsError(format(t, 'modelsFailed', { reason: String(cause?.message ?? cause) }))
          return undefined
        } finally {
          if (mounted.current) setModelsSaving(false)
        }
      }, [t])

      const allowedFromView = (data, effortOverride) => {
        if (data === undefined || data.mode === 'all') return []
        return (data.models ?? []).map((entry) => ({
          id: entry.id,
          provider: entry.provider,
          model: entry.model,
          label: entry.label,
          ...(entry.efforts?.length > 0 ? { efforts: entry.efforts.map((effort) => effort.id) } : {}),
          ...(entry.defaultEffort ? { defaultEffort: entry.id === effortOverride?.modelId ? effortOverride.effort : entry.defaultEffort } : {}),
          ...(entry.description ? { note: entry.description } : {}),
        }))
      }

      const quickSaveModel = React.useCallback(async (modelId, effort) => {
        const data = modelsData
        if (data === undefined) return
        const allowed = allowedFromView(data, effort === undefined ? undefined : { modelId, effort })
        await saveModels({ allowed, default: modelId, ...(effort ? { defaultEffort: effort } : {}) })
      }, [modelsData, saveModels])

      const loadRules = React.useCallback(async () => {
        setRulesLoading(true)
        setRulesError('')
        try {
          const payload = await getJson(ROUTES.agreements)
          if (mounted.current) setRulesData(payload)
        } catch (cause) {
          if (mounted.current) setRulesError(format(t, 'rulesFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setRulesLoading(false)
        }
      }, [t])

      const rulesAction = React.useCallback(async (body) => {
        setRulesSaving(true)
        setRulesError('')
        try {
          const { response, payload } = await postJson(ROUTES.agreements, body)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (mounted.current) {
            setRulesData((current) => ({
              ...(current ?? { projects: [] }),
              ...payload,
            }))
          }
          return payload
        } catch (cause) {
          if (mounted.current) setRulesError(format(t, 'rulesFailed', { reason: String(cause?.message ?? cause) }))
          return undefined
        } finally {
          if (mounted.current) setRulesSaving(false)
        }
      }, [t])

      const loadSchedules = React.useCallback(async () => {
        setSchedulesLoading(true)
        setSchedulesError('')
        try {
          const payload = await getJson(ROUTES.schedules)
          if (mounted.current) setSchedulesData(payload)
        } catch (cause) {
          if (mounted.current) setSchedulesError(format(t, 'schedulesFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setSchedulesLoading(false)
        }
      }, [t])

      const scheduleAction = React.useCallback(async (url, body) => {
        setSchedulesBusy(true)
        setSchedulesError('')
        try {
          const { response, payload } = await postJson(url, body)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (mounted.current && Array.isArray(payload.schedules)) setSchedulesData(payload)
          return payload
        } catch (cause) {
          if (mounted.current) setSchedulesError(format(t, 'schedulesFailed', { reason: String(cause?.message ?? cause) }))
          return undefined
        } finally {
          if (mounted.current) setSchedulesBusy(false)
        }
      }, [t])

      const loadActivityFull = React.useCallback(async () => {
        try {
          const payload = await getJson(`${ROUTES.activity}?limit=200`)
          if (mounted.current && Array.isArray(payload.activity)) setActivityFull(payload.activity)
        } catch {
          // 状态轮询里已有最近活动，扩展失败不阻断面板。
        }
      }, [])

      const openTask = React.useCallback(async (task) => {
        if (task?.id === undefined) return
        detailRequest.current = task.id
        setDetailId(task.id)
        setDetail(undefined)
        setDetailError('')
        setDetailLoading(true)
        try {
          const payload = await getJson(`${ROUTES.task}?task_id=${encodeURIComponent(task.id)}`)
          if (mounted.current && detailRequest.current === task.id) setDetail(payload.task)
        } catch (cause) {
          if (mounted.current && detailRequest.current === task.id) {
            setDetailError(format(t, 'detailFailed', { reason: String(cause?.message ?? cause) }))
          }
        } finally {
          if (mounted.current && detailRequest.current === task.id) setDetailLoading(false)
        }
      }, [t])

      const closeTask = React.useCallback(() => {
        detailRequest.current = ''
        setDetailId('')
        setDetail(undefined)
        setDetailError('')
        setSteerError('')
        setSteerBusy(false)
        setDetailLoading(false)
      }, [])

      const steerTask = React.useCallback(async (text) => {
        const taskId = detailId
        if (taskId.length === 0 || String(text ?? '').trim().length === 0) return false
        setSteerBusy(true)
        setSteerError('')
        try {
          const { response, payload } = await postJson(ROUTES.taskSteer, { task_id: taskId, text })
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (mounted.current) {
            if (payload.task !== undefined) setDetail(payload.task)
            setSteerBusy(false)
          }
          return true
        } catch (cause) {
          if (mounted.current) {
            setSteerError(format(t, 'taskSteerFailed', { reason: String(cause?.message ?? cause) }))
            setSteerBusy(false)
          }
          return false
        }
      }, [detailId, t])

      // 抽屉按需加载，避免面板一打开就打一堆接口。
      React.useEffect(() => {
        if (drawer === 'models' && modelsData === undefined) void loadModels(true)
        if (drawer === 'rules' && rulesData === undefined) void loadRules()
        if (drawer === 'schedules' && schedulesData === undefined) void loadSchedules()
        if (drawer === 'activity' && activityFull === undefined) void loadActivityFull()
      }, [drawer, modelsData, rulesData, schedulesData, activityFull, loadModels, loadRules, loadSchedules, loadActivityFull])

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

      // 头部快速选择器需要模型视图；与抽屉的按需加载分开，失败不阻断对话。
      React.useEffect(() => {
        if (sessionId.length === 0 || modelsAttempted.current) return
        modelsAttempted.current = true
        void loadModels(false)
      }, [sessionId, loadModels])

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
      const activityRows = Array.isArray(activityFull)
        ? activityFull
        : Array.isArray(routerInfo?.status?.activity)
          ? routerInfo.status.activity
          : tasks
      const defaultModel = Array.isArray(modelsData?.models)
        ? modelsData.models.find((entry) => entry.id === modelsData.defaultId)
        : undefined
      const workerSessionId = typeof detail?.workerSessionId === 'string' ? detail.workerSessionId : ''
      const workerChatAvailable = workerSessionId.length > 0
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

      // 面板切到 Worker 会话时会卸载；隐藏规则必须留在 document 上，否则侧栏
      // 会突然冒出所有内部 Worker 行。只更新，不随组件卸载删除。
      React.useEffect(() => {
        if (typeof document === 'undefined') return
        let style = document.querySelector('style[data-super-agent-hidden]')
        if (style === null) {
          style = document.createElement('style')
          style.setAttribute('data-super-agent-hidden', '')
          document.head.appendChild(style)
        }
        style.textContent = `[data-super-agent-worker]{display:none!important}\n${hiddenCss}`
      }, [hiddenCss])

      const sessionProviderAvailable = typeof SessionProvider === 'function'
      const renderSlotAvailable = typeof renderSlot === 'function'
      const hasSession = sessionId.length > 0
      const openSessionAvailable = hasSession
      const openWorkerChat = async () => {
        if (!workerChatAvailable) return
        try {
          const workspace = resolveWorkspaceService(pluginCtx)
          if (workspace === undefined) {
            setStatusLine(t('openChatFailed'))
            return
          }
          // 旧任务的 Worker 可能已被 Reset 归档；先恢复再打开，普通会话上失败可忽略。
          if (typeof workspace.unarchiveSession === 'function') {
            try {
              await workspace.unarchiveSession(workerSessionId)
            } catch {
              // 未归档或宿主不支持时直接打开。
            }
          }
          // openSession 内部已切主视图；不要再碰 layout，未 inject 的服务会抛错。
          workspace.openSession(workerSessionId)
          setDetailId('')
          setDetail(undefined)
        } catch {
          setStatusLine(t('openChatFailed'))
        }
      }

      return h('div', { style: S.root },
        h('style', {}, `
          ${hiddenCss}
          @keyframes saPulse { 0% { opacity: .45; transform: scale(.85); } 70% { opacity: 1; transform: scale(1); } 100% { opacity: .45; transform: scale(.85); } }
          .sa-pulse { animation: saPulse 1.6s ease-in-out infinite; }
          .sa-activity-toggle, .sa-model-toggle { display: none !important; }
          @media (max-width: 1180px) {
            .sa-title-block { display: none !important; }
            .sa-model-chip { max-width: 200px !important; }
          }
          @media (max-width: 1000px) {
            .sa-rail-wrap { display: none !important; }
            .sa-activity-toggle { display: inline-flex !important; }
            .sa-model-chip { display: none !important; }
          }
          @media (max-width: 860px) {
            .sa-header { gap: 6px !important; padding-left: 12px !important; padding-right: 12px !important; }
            .sa-model-chip { display: none !important; }
            .sa-model-toggle { display: inline-flex !important; }
          }
        `),
        h('div', { style: S.header, className: 'sa-header' },
          h('div', { style: S.titleBlock, className: 'sa-title-block' },
            h('div', { style: S.title }, t('title')),
          ),
          modelsData?.models?.length > 0
            ? h('div', { style: S.headerModel, className: 'sa-model-chip', title: t('modelsTitle') },
                h('select', {
                  style: { ...S.select, border: 0, background: 'transparent', padding: 0, maxWidth: 156, fontSize: 11 },
                  value: modelsData.defaultId ?? '',
                  disabled: modelsSaving,
                  onChange: (event) => { void quickSaveModel(event.target.value, undefined) },
                }, modelsData.models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.modelName ?? entry.label ?? entry.model))),
                defaultModel?.efforts?.length > 0
                  ? h('select', {
                      style: S.selectTiny,
                      value: defaultModel.defaultEffort ?? '',
                      disabled: modelsSaving,
                      title: t('modelsEffort'),
                      onChange: (event) => { void quickSaveModel(defaultModel.id, event.target.value) },
                    }, defaultModel.efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id)))
                  : null,
              )
            : h('button', { type: 'button', style: S.button, onClick: () => setDrawer('models') }, t('models')),
          modelsData?.models?.length > 0
            ? h('button', { type: 'button', style: S.iconButton, onClick: () => setDrawer('models'), title: t('modelsTitle'), 'aria-label': t('modelsTitle') }, '⚙')
            : null,
          h('button', { type: 'button', style: { ...S.button, display: 'none' }, className: 'sa-model-toggle', onClick: () => setDrawer('models') }, t('models')),
          h('button', { type: 'button', style: S.button, onClick: () => setDrawer('rules') }, t('rules')),
          h('button', { type: 'button', style: S.button, onClick: () => setDrawer('schedules') }, t('schedules')),
          h('button', { type: 'button', style: { ...S.button, display: 'none' }, className: 'sa-activity-toggle', onClick: () => setDrawer('activity'), title: t('activityTitle') }, t('drawerActivity')),
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
                  const workspace = resolveWorkspaceService(pluginCtx)
                  if (workspace === undefined) {
                    setStatusLine(t('openSessionFailed'))
                    return
                  }
                  try {
                    workspace.openSession(sessionId)
                  } catch {
                    setStatusLine(t('openSessionFailed'))
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
          h(ActivityRail, {
            tasks: activityRows,
            t,
            detail: detailId.length > 0 ? detail : undefined,
            detailLoading,
            detailError,
            onSelect: openTask,
            selectedId: detailId,
            onBackDetail: closeTask,
            onOpenChat: openWorkerChat,
            canOpenChat: workerChatAvailable,
            onSteer: steerTask,
            steerBusy,
            steerError,
            onLoadMore: loadActivityFull,
          }),
        ),
        drawer === 'models'
          ? h(ModelsPanel, {
              t,
              data: modelsData,
              loading: modelsLoading,
              saving: modelsSaving,
              error: modelsError,
              onClose: () => setDrawer(''),
              onSave: (body) => { void saveModels(body) },
              onSaveAll: (defaultId, defaultEffort) => { void saveModels({ allowed: [], default: defaultId, ...(defaultEffort ? { defaultEffort } : {}) }) },
            })
          : null,
        drawer === 'rules'
          ? h(AgreementsPanel, {
              t,
              data: rulesData,
              loading: rulesLoading,
              saving: rulesSaving,
              error: rulesError,
              onClose: () => setDrawer(''),
              onSave: (draft) => rulesAction({
                action: 'save',
                agreement_id: draft.id,
                title: draft.title,
                text: draft.text,
                project: draft.project,
                mode: draft.mode,
                enabled: draft.enabled,
              }),
              onToggle: (item, enabled) => { void rulesAction({ action: 'toggle', agreement_id: item.id, enabled }) },
              onRemove: (item) => { void rulesAction({ action: 'remove', agreement_id: item.id }) },
            })
          : null,
        drawer === 'schedules'
          ? h(SchedulesPanel, {
              t,
              data: schedulesData,
              loading: schedulesLoading,
              busy: schedulesBusy,
              error: schedulesError,
              onClose: () => setDrawer(''),
              onRefresh: () => { void loadSchedules() },
              onCreate: (payload) => scheduleAction(ROUTES.schedules, payload),
              onCancel: (schedule) => { void scheduleAction(ROUTES.schedulesCancel, { schedule_id: schedule.id }) },
              onRun: (schedule) => { void scheduleAction(ROUTES.schedulesRun, { schedule_id: schedule.id }) },
            })
          : null,
        drawer === 'activity'
          ? h(Drawer, { title: t('activityAll'), t, onClose: () => setDrawer(''), wide: true },
              h('div', { style: { height: '100%', minHeight: 320, display: 'flex' } },
                h(ActivityRail, {
                  tasks: activityRows,
                  t,
                  embedded: true,
                  detail: detailId.length > 0 ? detail : undefined,
                  detailLoading,
                  detailError,
                  onSelect: openTask,
                  selectedId: detailId,
                  onBackDetail: closeTask,
                  onOpenChat: openWorkerChat,
                  canOpenChat: workerChatAvailable,
                  onSteer: steerTask,
                  steerBusy,
                  steerError,
                  onLoadMore: loadActivityFull,
                }),
              ),
            )
          : null,
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

      // uiWorkspace 是宿主 0.1.7 的视图切换服务；可选注入，缺失时面板照常工作。
      try {
        ctx.inject(['uiWorkspace'], (services) => {
          workspaceService = services?.uiWorkspace ?? services
        })
      } catch {
        // 旧宿主没有该服务：点击打开聊天时再尝试 ctx.get。
      }

      // 旧任务/旧 generation 的 Worker 不一定在当前活动快照里；按标题前缀兜底隐藏，
      // 且观察器不随面板卸载，打开 Worker 聊天时侧栏也不会突然冒出内部会话。
      if (typeof document !== 'undefined'
        && typeof document.querySelector === 'function'
        && typeof document.createElement === 'function'
        && typeof MutationObserver === 'function') {
        try {
          let baseStyle = document.querySelector('style[data-super-agent-hidden]')
          if (baseStyle === null) {
            baseStyle = document.createElement('style')
            baseStyle.setAttribute('data-super-agent-hidden', '')
            document.head.appendChild(baseStyle)
            baseStyle.textContent = '[data-super-agent-worker]{display:none!important}'
          }
          ctx.effect(() => {
            const mark = () => {
              for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
                const text = (row.textContent || '').trim()
                if (text.startsWith('Super-agent worker ·')) row.setAttribute('data-super-agent-worker', '')
              }
            }
            const observer = new MutationObserver(mark)
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
            mark()
            return () => observer.disconnect()
          }, 'super-agent: hide internal worker rows')
        } catch {
          // 测试/精简宿主可能只提供部分 DOM；隐藏失败不影响面板。
        }
      }

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
