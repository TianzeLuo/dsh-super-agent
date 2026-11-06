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
 * 约束（DSH 0.1.7）：只能 require seed 静态模块（`react` 与
 * `@deepseek-ai/dsh-client-ui-primitives`）。后者是官方预览正文用的渲染组件；
 * 老宿主没有这个 seed 时 `official` 为 undefined，预览降级成一条可读提示。
 */

window.__ModuleLoader__.load({
  id: 'dsh-super-agent',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }

    /**
     * 官方 primitives（seed 静态模块）。
     *
     * 官方文件预览的正文就是这个模块：`CodeBlock`（shiki 高亮 + 行号 + 复制）、
     * `MarkdownText`（markdown 正文）、`classifyFileType`（官方后缀分类）、
     * `languageForPath`（后缀 → shiki 语言）。面板直接复用它们，不自己写渲染。
     * 老宿主没有这个 seed 时保持 undefined（预览给出可读提示，不影响其它功能）。
     */
    const official = (() => {
      try {
        const loaded = require('@deepseek-ai/dsh-client-ui-primitives')
        return loaded !== null && typeof loaded === 'object' ? loaded : undefined
      } catch {
        return undefined
      }
    })()

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
    /** 官方文件资源地址前缀；与 dsh-client-ui-chat / ui-reference 的语法一致。 */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    /** 装在 `sidebarRight.openResource` 上的标记，避免重复包装。 */
    const FILE_BRIDGE_FLAG = '__dshSuperAgentFileBridge'
    /** 一页预览最多读多少行（宿主也有自己的上限；超出部分给截断提示）。 */
    const PREVIEW_LINES = 2000
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
      instances: '/api/super-agent/ui/instances',
      instanceActive: '/api/super-agent/ui/instances/active',
      instanceRename: '/api/super-agent/ui/instances/rename',
    }
    const POLL_MS = 4_000

    const DICT = {
      zh: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'instances': '实例',
        'instanceSwitch': '切换实例',
        'instanceNew': '新建实例',
        'instanceName': '实例名称',
        'instanceNamePlaceholder': '例如：写作、研究、日常',
        'instanceCreate': '创建',
        'instanceCreating': '创建中…',
        'instanceRename': '重命名当前实例',
        'instanceSave': '保存',
        'instanceCancel': '取消',
        'instanceCreateFailed': '创建实例失败：{reason}',
        'instanceRenameFailed': '重命名失败：{reason}',
        'instanceSwitchFailed': '切换实例失败：{reason}',
        'instanceUnread': '{count} 条未读',
        'instanceEmpty': '还没有实例。新建一个开始。',
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
        'badgeRunning': '运行中 {count}',
        'badgeUnread': '{count} 条未读',
        'badgeLabel': 'Super-agent 状态',
        'badgeOpen': '打开 Super-agent 面板',
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
        'models': 'Worker 模型',
        'modelsTitle': 'Worker 模型',
        'modelsNote': 'Worker 模型只在这里设置。逐个勾选允许 Router 使用的模型（至少一个）；取消勾选即从可调用列表移除。默认模型和 reasoning effort 也在本面板统一设置。',
        'modelsDefault': '默认 Worker 模型',
        'modelsEffort': '默认思考强度',
        'modelsAll': '使用全部 DSH 模型',
        'modelsAllowlist': '可调用模型（逐个勾选）',
        'modelsSelected': '已勾选 {count} 个',
        'modelsToggleHint': '点击模型名或左侧复选框即可单独启用/停用；reasoning effort 可多选。',
        'modelsEnabled': '已启用',
        'modelsDisabled': '未启用',
        'modelsAllHint': '清空自定义勾选和来源过滤，改用 DSH 宿主目录里的全部模型。',
        'modelsFilterTitle': '当前只显示 {count} 个 / DSH 共 {total} 个',
        'modelsFilterDetail': '配置里启用了来源过滤：{detail}。被过滤掉的模型 Router 现在看不到。',
        'modelsUseHost': '使用 DSH 全部模型',
        'modelsUseHostHint': '清空 onlyProvider / onlyNames 和 allowlist，显示宿主全部模型。',
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
        'previewTitle': '文件预览',
        'previewResize': '拖动调整预览宽度（双击切换 480 / 640）',
        'previewLoading': '读取文件…',
        'previewEmpty': '文件为空。',
        'previewUnavailable': '这个宿主没有提供文件读取接口（remote.workspaceFiles）。路径：{path}',
        'previewError': '无法读取文件：{reason}',
        'previewTruncated': '只显示第 {from} 行起的 {lines} 行；完整内容请用 Read 工具或编辑器查看。',
        'previewBinary': '这个类型（PDF、Office、视频）面板没有渲染器，请在官方文件链接里预览。',
        'previewNoRenderer': '这个宿主没有提供官方预览组件（dsh-client-ui-primitives），面板无法渲染正文。',
        'previewCopy': '复制',
        'previewCopied': '已复制',
        'previewCodeLabel': '代码',
        'previewWrap': '折行',
        'previewUnwrap': '不折行',
        'previewFootnotes': '脚注',
        'renderFailed': '这段内容没能渲染出来',
        'renderFailedHint': '面板其余部分照常可用；可以关闭后重试，或把控制台里的错误一起反馈。',
        'navLocated': '已定位到实例「{instance}」产生通知的会话。',
        'navLocatedHere': '已定位到产生通知的会话（当前实例）。',
        'navSwitchFailed': '切换到实例「{instance}」失败，当前会话没有改动（错误信息见上方）。',
        'navOffer': '实例「{instance}」有通知的会话（自动跟随已关闭，可用顶部「跟随：关」打开）。',
        'navOfferHere': '有通知的会话（自动跟随已关闭，可用顶部「跟随：关」打开）。',
        'navFollowOff': '跟随：关',
        'navFollowOn': '跟随：开',
        'navFollowOffHint': '通知不再自动跳转（默认）：点通知只提示，点「定位」再跳；点这里改成自动跟随。',
        'navFollowOnHint': '通知会自动把你切到产生通知的会话；点这里关掉自动跟随。',
        'navLocate': '定位',
        'navAlways': '以后自动跟随',
        'navNever': '以后不自动跟随',
        'navUnknown': '通知里的会话 …{session} 不在本页面（可能已关闭或已归档），请从左侧会话列表打开。',
        'navBack': '返回',
        'navDismiss': '知道了',
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
        'statusResumable': '可续做',
        'statusLost': '已丢失',
        'statusClosed': '已关闭',
      },
      en: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'instances': 'Instances',
        'instanceSwitch': 'Switch instance',
        'instanceNew': 'New instance',
        'instanceName': 'Instance name',
        'instanceNamePlaceholder': 'e.g. Writing, Research, Daily',
        'instanceCreate': 'Create',
        'instanceCreating': 'Creating…',
        'instanceRename': 'Rename current instance',
        'instanceSave': 'Save',
        'instanceCancel': 'Cancel',
        'instanceCreateFailed': 'Could not create instance: {reason}',
        'instanceRenameFailed': 'Could not rename instance: {reason}',
        'instanceSwitchFailed': 'Could not switch instance: {reason}',
        'instanceUnread': '{count} unread',
        'instanceEmpty': 'No instances yet. Create one to start.',
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
        'badgeRunning': '{count} running',
        'badgeUnread': '{count} unread',
        'badgeLabel': 'Super-agent status',
        'badgeOpen': 'Open the Super-agent panel',
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
        'models': 'Worker models',
        'modelsTitle': 'Worker models',
        'modelsNote': 'Worker models are configured only here. Check each model the Router may use (keep at least one); unchecking removes it. Set the default model and reasoning effort in this panel too.',
        'modelsDefault': 'Default Worker model',
        'modelsEffort': 'Default reasoning effort',
        'modelsAll': 'Use all DSH models',
        'modelsAllowlist': 'Callable models (check each)',
        'modelsSelected': '{count} selected',
        'modelsToggleHint': 'Click a model name or its checkbox to enable/disable it individually; reasoning efforts are multi-select.',
        'modelsEnabled': 'Enabled',
        'modelsDisabled': 'Disabled',
        'modelsAllHint': 'Clear the custom list and source filter, then use every model in the DSH host catalog.',
        'modelsFilterTitle': 'Showing {count} / {total} DSH models',
        'modelsFilterDetail': 'A source filter is configured: {detail}. The Router cannot see the filtered-out models.',
        'modelsUseHost': 'Use all DSH models',
        'modelsUseHostHint': 'Clear onlyProvider / onlyNames and the allowlist, then show every host model.',
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
        'previewTitle': 'File preview',
        'previewResize': 'Drag to resize the preview (double-click toggles 480 / 640)',
        'previewLoading': 'Reading file…',
        'previewEmpty': 'The file is empty.',
        'previewUnavailable': 'This host exposes no file-reading interface (remote.workspaceFiles). Path: {path}',
        'previewError': 'Could not read the file: {reason}',
        'previewTruncated': 'Showing {lines} lines from line {from}; open the file in an editor for the rest.',
        'previewBinary': 'The panel has no renderer for this type (PDF, Office, video); open it through an official file link.',
        'previewNoRenderer': 'This host exposes no official preview components (dsh-client-ui-primitives), so the panel cannot render the body.',
        'previewCopy': 'Copy',
        'previewCopied': 'Copied',
        'previewCodeLabel': 'Code',
        'previewWrap': 'Wrap',
        'previewUnwrap': 'Unwrap',
        'previewFootnotes': 'Footnotes',
        'renderFailed': 'This content could not be rendered',
        'renderFailedHint': 'The rest of the panel still works — close and retry, or report the console error.',
        'navLocated': 'Jumped to the session that notified you in instance “{instance}”.',
        'navLocatedHere': 'Jumped to the notifying session (current instance).',
        'navSwitchFailed': 'Could not switch to instance “{instance}”; the current session was left alone (see the error above).',
        'navOffer': 'Instance “{instance}” has a notifying session (auto-follow is off; use “Follow: off” in the header to turn it on).',
        'navOfferHere': 'A session notified you (auto-follow is off; use “Follow: off” in the header to turn it on).',
        'navFollowOff': 'Follow: off',
        'navFollowOn': 'Follow: on',
        'navFollowOffHint': 'Notifications no longer jump automatically (default): the panel offers a Locate button instead. Click to always follow.',
        'navFollowOnHint': 'Notifications switch you to the notifying session. Click to stop following.',
        'navLocate': 'Locate',
        'navAlways': 'Auto-follow again',
        'navNever': 'Stop auto-following',
        'navUnknown': 'The notifying session …{session} is not in this page (closed or archived); open it from the session list.',
        'navBack': 'Back',
        'navDismiss': 'Dismiss',
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
        'statusResumable': 'Resumable',
        'statusLost': 'Lost',
        'statusClosed': 'Closed',
      },
    }

    // DSH 的公开主题 token；必须用真实 token 名，否则深色模式下 fallback 会写成白底。
    // 旧宿主缺这些变量时退回 Canvas/CanvasText，跟随浏览器 color-scheme。
    const T = {
      bg: 'var(--dsw-alias-bg-base, Canvas)',
      surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
      surface2: 'var(--dsw-alias-bg-layer-2, ButtonFace)',
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      textSecondary: 'var(--dsw-alias-label-secondary, GrayText)',
      textTertiary: 'var(--dsw-alias-label-tertiary, GrayText)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.26))',
      borderSubtle: 'var(--dsw-alias-border-l1, rgba(127,127,127,.14))',
      accent: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-onboarding-accent, #4f7cff))',
      mask: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.28))',
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
        background: T.bg,
        color: T.text,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '5px 12px',
        borderBottom: `1px solid ${T.borderSubtle}`,
        minHeight: 40,
        boxSizing: 'border-box',
        flex: '0 0 auto',
      },
      titleBlock: { display: 'flex', alignItems: 'center', minWidth: 0, gap: 0 },
      title: { fontSize: 14, fontWeight: 650, letterSpacing: '.01em' },
      titleButton: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        margin: 0,
        padding: '4px 7px',
        border: 0,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        borderRadius: 7,
      },
      headerAction: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        padding: '0 9px',
        border: 0,
        borderRadius: 7,
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      status: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
        maxWidth: 240,
        marginLeft: 3,
        color: T.textTertiary,
        fontSize: 11,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      },
      statusText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      headerSeparator: { width: 1, height: 12, flex: 'none', background: T.borderSubtle, margin: '0 2px' },
      instanceMenu: {
        position: 'absolute',
        top: 'calc(100% + 7px)',
        left: 0,
        zIndex: 60,
        width: 292,
        maxHeight: 360,
        overflowY: 'auto',
        padding: 6,
        background: T.bg,
        color: T.text,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,.18)',
      },
      instanceRow: {
        appearance: 'none',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 9px',
        border: 'none',
        borderRadius: 7,
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      instanceName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 },
      menuAction: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        height: 26,
        padding: '0 8px',
        border: 0,
        borderRadius: 6,
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        boxSizing: 'border-box',
        padding: '0 9px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,.28)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11.5,
        lineHeight: 1,
        cursor: 'pointer',
        maxWidth: 200,
        minWidth: 0,
      },
      badgeHover: {
        background: 'rgba(127,127,127,.10)',
      },
      badgeDot: {
        flex: 'none',
        width: 6,
        height: 6,
        borderRadius: 999,
        background: '#4f7cff',
      },
      badgeText: {
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      unreadBubble: {
        flex: 'none',
        minWidth: 18,
        height: 18,
        boxSizing: 'border-box',
        padding: '0 5px',
        borderRadius: 999,
        background: 'rgba(79,124,255,.72)',
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 650,
        lineHeight: 1,
      },
      instanceForm: { display: 'flex', flexDirection: 'column', gap: 7, padding: '7px 8px 4px', borderTop: `1px solid ${T.borderSubtle}`, marginTop: 5 },
      instanceInput: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 8px',
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
        font: 'inherit',
        fontSize: 12,
      },
      instanceFormRow: { display: 'flex', gap: 6, justifyContent: 'flex-end' },
      instanceHint: { fontSize: 11, color: T.textTertiary, lineHeight: 1.4 },
      spacer: { flex: 1 },
      button: {
        appearance: 'none',
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
        borderRadius: 7,
        padding: '6px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonPrimary: {
        appearance: 'none',
        border: `1px solid ${T.border}`,
        background: T.accent,
        color: '#fff',
        borderRadius: 7,
        padding: '8px 14px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      },
      dot: { width: 6, height: 6, borderRadius: 999, background: '#4caf72', display: 'inline-block', flex: 'none' },
      body: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'row' },
      conversationArea: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      conversation: { flex: '1 1 auto', minHeight: 0, display: 'flex', width: '100%' },
      rail: {
        flex: '0 0 292px',
        width: 292,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${T.borderSubtle}`,
        background: T.surface,
      },
      railHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '10px 12px 6px',
        flex: '0 0 auto',
      },
      railTitle: { fontSize: 12, fontWeight: 600, letterSpacing: '.01em' },
      railCount: {
        fontSize: 10,
        minWidth: 17,
        textAlign: 'center',
        padding: '1px 5px',
        borderRadius: 999,
        background: 'rgba(127,127,127,.12)',
        color: T.textTertiary,
        fontVariantNumeric: 'tabular-nums',
      },
      railScroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 6px 14px' },
      activityRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '7px 7px',
        borderRadius: 7,
        minWidth: 0,
      },
      activityMain: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 2 },
      activityChevron: { flex: 'none', display: 'inline-flex', color: T.textTertiary, marginTop: 1 },
      activityTitle: {
        fontSize: 12.5,
        lineHeight: 1.4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        wordBreak: 'break-word',
      },
      activityMeta: { fontSize: 10.5, color: T.textTertiary, display: 'flex', gap: 5, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' },
      activityProject: { overflow: 'hidden', textOverflow: 'ellipsis' },
      activityDot: { flex: '0 0 auto', width: 7, height: 7, borderRadius: 999, marginTop: 5 },
      moreButton: { appearance: 'none', border: 0, fontSize: 10.5, cursor: 'pointer', padding: '6px 8px', margin: '2px 0 0 1px', borderRadius: 6, textAlign: 'left' },
      center: { flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 },
      card: {
        maxWidth: 540,
        width: '100%',
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: 24,
        background: T.surface2,
        color: T.text,
        lineHeight: 1.65,
        fontSize: 13,
      },
      cardTitle: { fontSize: 16, fontWeight: 650, marginBottom: 8 },
      error: {
        margin: '8px 14px 0',
        padding: '9px 11px',
        borderRadius: 8,
        border: '1px solid rgba(220,80,80,.4)',
        background: 'rgba(220,80,80,.12)',
        color: T.text,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      },
      navNotice: {
        margin: '8px 14px 0',
        padding: '7px 10px',
        borderRadius: 8,
        border: `1px solid ${T.borderSubtle}`,
        background: T.surface2,
        color: T.text,
        fontSize: 11.5,
        lineHeight: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      navNoticeText: { flex: '1 1 auto', minWidth: 0 },
      iconButton: {
        appearance: 'none',
        border: 0,
        borderRadius: 6,
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      select: {
        appearance: 'auto',
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
        colorScheme: 'light dark',
        borderRadius: 6,
        padding: '4px 6px',
        fontSize: 11,
        maxWidth: '100%',
      },
      selectTiny: {
        appearance: 'auto',
        border: `1px solid ${T.borderSubtle}`,
        background: T.surface2,
        color: T.text,
        colorScheme: 'light dark',
        borderRadius: 5,
        padding: '3px 4px',
        fontSize: 10,
      },
      railWrap: { position: 'relative', flex: '0 0 292px', width: 292, minHeight: 0, display: 'flex' },
      detailOverlay: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        zIndex: 5,
        display: 'flex',
      },
      detailCard: {
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: 0,
        borderLeft: `1px solid ${T.borderSubtle}`,
        borderRadius: 0,
        background: T.surface,
        color: T.text,
        boxShadow: 'none',
        overflow: 'hidden',
      },
      detailHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '7px 8px',
        borderBottom: `1px solid ${T.borderSubtle}`,
        flex: '0 0 auto',
      },
      detailFooter: {
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '8px 10px',
        borderTop: `1px solid ${T.borderSubtle}`,
        background: T.surface,
        flex: '0 0 auto',
      },
      detailTitle: { fontSize: 12.5, fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 2px' },
      detailBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '10px 12px 16px' },
      detailMeta: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
      badge: {
        fontSize: 10,
        lineHeight: 1.5,
        padding: '1px 6px',
        borderRadius: 999,
        border: `1px solid ${T.borderSubtle}`,
        background: 'rgba(127,127,127,.12)',
        color: T.text,
        whiteSpace: 'nowrap',
      },
      detailSection: { marginTop: 14 },
      detailSectionTitle: { fontSize: 10, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.06em', color: T.textTertiary, opacity: 1, marginBottom: 6 },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.6, fontFamily: 'inherit' },
      reportCard: { border: '1px solid rgba(127,127,127,.16)', borderRadius: 8, padding: '8px 9px', marginBottom: 7, background: 'rgba(127,127,127,.035)' },
      reportHead: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, fontSize: 10, color: T.textTertiary, opacity: 1 },
      linkButton: { appearance: 'none', border: 0, background: 'none', color: T.accent, padding: 0, fontSize: 11, cursor: 'pointer' },
      backdrop: { position: 'absolute', inset: 0, zIndex: 20, background: T.mask, display: 'flex', justifyContent: 'flex-end' },
      drawer: {
        width: 430,
        maxWidth: '94vw',
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: T.surface,
        color: T.text,
        borderLeft: `1px solid ${T.border}`,
        boxShadow: '-16px 0 40px rgba(0,0,0,.24)',
      },
      drawerWide: { width: 520 },
      // 右侧抽屉（文件预览）：贴面板右侧、无遮罩。遮罩会盖住主界面，还会被看成
      // 「整个界面变黑、点不动」——所以抽屉不画遮罩，点抽屉外照样关闭。
      //
      // 定位用 `absolute`（父级是 `S.root` 的 `position: relative`）：它只会盖住
      // 面板区域，绝不会因为祖先缺少定位而展开成整屏——`fixed; inset: 0` 正是这次
      // P0 的形状，不再用它。
      // 预览是面板里的**一列**（不是浮在内容上的覆盖层）：它占掉右侧固定宽度，
      // 对话区跟着变窄——和宿主官方右栏同一套「三列 grid」观感。
      drawerPanel: {
        position: 'relative',
        flex: '0 0 auto',
        width: 560,
        minWidth: 360,
        maxWidth: '62%',
        alignSelf: 'stretch',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: T.surface,
        color: T.text,
        borderLeft: `1px solid ${T.border}`,
      },
      drawerPanelWide: { width: 640, maxWidth: '68%' },
      // 抽屉里的错误态（官方渲染器抛错时只坏这一块，面板其余部分照常）。
      crashBox: {
        border: `1px solid ${T.borderSubtle}`,
        borderRadius: 8,
        padding: '10px 11px',
        background: 'rgba(210,80,80,.07)',
        color: T.text,
        fontSize: 11.5,
        lineHeight: 1.6,
      },
      crashTitle: { fontSize: 12, fontWeight: 650, marginBottom: 4 },
      crashDetail: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 10.5,
        lineHeight: 1.5,
        color: T.textSecondary,
        opacity: 1,
        wordBreak: 'break-word',
        marginBottom: 8,
        maxHeight: 120,
        overflow: 'auto',
      },
      drawerHeader: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px 9px 14px', borderBottom: `1px solid ${T.borderSubtle}`, flex: '0 0 auto' },
      drawerTitle: { fontSize: 13, fontWeight: 600, flex: '1 1 auto' },
      drawerBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px 24px' },
      drawerFooter: { padding: '10px 14px', borderTop: `1px solid ${T.borderSubtle}`, display: 'flex', justifyContent: 'flex-end', gap: 8, flex: '0 0 auto' },
      // 文件预览：路径一行 + 官方渲染正文（CodeBlock / MarkdownText / img）。
      previewPath: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: 1.5,
        color: T.textSecondary,
        opacity: 1,
        wordBreak: 'break-all',
        margin: '0 0 10px',
      },
      previewNote: { fontSize: 11.5, lineHeight: 1.6, color: T.textSecondary, opacity: 1, margin: '0 0 10px' },
      previewBody: { border: `1px solid ${T.borderSubtle}`, borderRadius: 8, background: 'rgba(127,127,127,.035)', overflow: 'hidden' },
      previewImage: { display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto', background: 'transparent' },
      // 预览列头：一排可横向滚动的标签，活动标签高亮，每个标签自带关闭按钮。
      previewHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '5px 6px 5px 8px',
        borderBottom: `1px solid ${T.borderSubtle}`,
        minWidth: 0,
        flex: '0 0 auto',
      },
      previewTabScroll: {
        display: 'flex',
        alignItems: 'stretch',
        gap: 2,
        flex: '1 1 auto',
        minWidth: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'thin',
      },
      previewTab: {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flex: '0 0 auto',
        maxWidth: 200,
        minWidth: 0,
        height: 28,
        padding: '0 4px 0 8px',
        border: '1px solid transparent',
        borderRadius: 7,
        background: 'transparent',
        color: T.textSecondary,
        cursor: 'pointer',
        userSelect: 'none',
      },
      previewTabActive: {
        background: 'rgba(127,127,127,.12)',
        borderColor: T.borderSubtle,
        color: T.text,
      },
      previewTabName: {
        fontSize: 11.5,
        lineHeight: 1.4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        maxWidth: 150,
      },
      previewTabClose: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: 18,
        height: 18,
        padding: 0,
        border: 0,
        borderRadius: 5,
        background: 'transparent',
        color: 'inherit',
        opacity: .7,
        cursor: 'pointer',
      },
      // 列宽拖拽条：贴着列的左缘，命中区比 1px 边框宽，拖动时不选中文字。
      previewResizer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: -3,
        width: 7,
        zIndex: 3,
        cursor: 'col-resize',
        background: 'transparent',
        touchAction: 'none',
      },
      // 每个标签一个常驻正文面板：切换标签只是换 display，不重新读取/重置滚动。
      previewPane: {
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto',
        padding: '12px 14px 24px',
        display: 'flex',
        flexDirection: 'column',
      },
      previewRetryRow: { marginTop: 12, display: 'flex', justifyContent: 'flex-end' },
      hint: { fontSize: 10.5, lineHeight: 1.55, color: T.textSecondary, opacity: 1, margin: '0 0 12px' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
      label: { fontSize: 10.5, fontWeight: 600, color: T.textSecondary, opacity: 1 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
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
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
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
      itemMeta: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 10, color: T.textTertiary, opacity: 0.95 },
      chip: {
        appearance: 'none',
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
        borderRadius: 999,
        padding: '3px 8px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      chipActive: {
        appearance: 'none',
        border: `1px solid ${T.accent}`,
        background: `color-mix(in srgb, ${T.accent} 16%, transparent)`,
        color: T.text,
        borderRadius: 999,
        padding: '3px 8px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      checkboxRow: { display: 'flex', gap: 7, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid rgba(127,127,127,.1)' },
      empty: { padding: '24px 8px', textAlign: 'center', fontSize: 11.5, color: T.textSecondary, opacity: 1, lineHeight: 1.6 },
      smallButton: {
        appearance: 'none',
        border: `1px solid ${T.border}`,
        background: T.surface2,
        color: T.text,
        borderRadius: 6,
        padding: '3px 7px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
      dangerButton: {
        appearance: 'none',
        border: '1px solid rgba(220,80,80,.4)',
        background: 'rgba(220,80,80,.12)',
        color: T.text,
        borderRadius: 6,
        padding: '3px 7px',
        fontSize: 10.5,
        cursor: 'pointer',
      },
    }

    // ── 图标 ─────────────────────────────────────────────────────────────────
    // DSH 前端 primitives 的 16×16 regular 线性图标；与系统内菜单、抽屉、
    // 详情页使用同一套几何，不另画一套箭头/叉号。
    const GLYPHS = {
      chevronDown: ['M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6'],
      chevronLeft: ['M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12'],
      chevronRight: ['M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4'],
      close: ['M3.5 3.5L12.5 12.5', 'M12.5 3.5L3.5 12.5'],
      plus: ['M8 2V14', 'M2 8H14'],
      // 预览标签的文件图标：外框 + 折角，再按类型加一笔（代码 / 图片 / Markdown）。
      file: ['M4 1.5h5.1L13 5.4v9.1H4z', 'M9.1 1.5v3.9H13'],
      fileCode: ['M4 1.5h5.1L13 5.4v9.1H4z', 'M9.1 1.5v3.9H13', 'M7.4 7.4L5.8 9l1.6 1.6', 'M10.2 7.4L11.8 9l-1.6 1.6'],
      fileImage: ['M4 1.5h5.1L13 5.4v9.1H4z', 'M9.1 1.5v3.9H13', 'M6 12.2l2.1-2.1 1.3 1.3 1.5-1.5 1.7 1.7'],
      fileMarkdown: ['M4 1.5h5.1L13 5.4v9.1H4z', 'M9.1 1.5v3.9H13', 'M5.8 10.9V7.5l1.6 2 1.6-2v3.4'],
      check: ['M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4'],
    }

    function Glyph({ name, size = 14, strokeWidth = 1.2, className, style }) {
      const paths = GLYPHS[name] ?? []
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          strokeWidth,
          className,
          style,
        },
        paths.map((d, index) => h('path', { key: index, d, stroke: 'currentColor' })),
      )
    }

    // ── 小工具 ───────────────────────────────────────────────────────────────

    function service(ctx, name) {
      if (ctx === undefined || ctx === null) return undefined
      // 直接属性只在插件 inject 声明过该服务时解析得到（否则 cordis 抛
      // `cannot get property "…" without inject`）；抛了就退到全局 get，
      // 不能用一次 throw 把「服务存在但没声明」误判成「服务不存在」。
      try {
        const direct = ctx[name]
        if (direct !== undefined) return direct
      } catch {
        // 未声明：继续走 ctx.get。
      }
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    // ── 文件链接（没有右侧栏会话表面时）────────────────────────────────────
    //
    // super-agent 面板是全局 main 面板：`layout.panelInfo.activePanelId` 非空，
    // 而 dsh-client-ui-sidebar-right 只在“主区域是会话”时命名屏上会话
    // （client.js:4828 `activePanelId === null ? selected?.sessionId : undefined`）。
    // 因此面板里点文件时 `sidebarRight.openResource` 走到 `require()` 就抛
    // `sidebarRight: no session surface is mounted`（client.js:2476-2486）。
    //
    // 三条“用官方右侧栏”的路都验证过，都不通：
    //   a) 替 Router 挂一个隐藏 session surface —— 座位整体 `hidden: !active`
    //      （client.js:1609-1612），`active` 也来自 `activePanelId`，隐藏面不显示；
    //   b) `openResourceIn(sessionId, address)`（client.js:2140）绕开 require()，
    //      但只往该会话的 store 里放 tab，正文仍在隐藏的座位里渲染，看不见；
    //   c) 直接渲染官方 tab 正文 —— 正文是 keyed 槽 `sidebar.right.tab.document`
    //      的条目，没有对外渲染入口（`ctx.slots.renderSlot` 只渲染 'root'，
    //      renderer client.js:1531），组件也没有导出。
    //
    // 所以面板自己出抽屉，但正文复用官方组件 `CodeBlock` / `MarkdownText`
    // （官方 CodeBody 用的就是它们），读取走官方公开面 `remote.workspaceFiles`。
    // 只在“没有屏上会话”时接管，其余情况原样调用官方实现。

    function isDriveSegment(segment) {
      return /^[A-Za-z]:$/.test(segment)
    }

    /** 解码一个路径段；坏转义返回 undefined（调用方据此判定地址无效）。 */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch {
        return undefined
      }
    }

    /**
     * 解析 `dsh-resource://file/…` 地址（纯函数，与官方 grammar 对齐）。
     *
     * @param {string} address 资源地址。
     * @returns {{ scope: 'session'|'absolute', sessionId?: string, path: string }|undefined}
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
      const end = address.search(/[?#]/)
      const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
      const raw = body.split('/')
      const scope = raw.shift()
      if (scope !== 'session' && scope !== 'absolute') return undefined
      const segments = raw.map(decodeSegment)
      if (segments.some((segment) => segment === undefined)) return undefined
      if (scope === 'session') {
        const [sessionId, ...rest] = segments
        if (typeof sessionId !== 'string' || sessionId.length === 0 || rest.length === 0) return undefined
        return { scope, sessionId, path: rest.join('/') }
      }
      // absolute：UNC 用前导空段表示（`absolute//server/share/a`）。
      const unc = segments[0] === '' && segments.length > 1
      const parts = unc ? segments.slice(1) : segments
      if (parts.length === 0 || parts[0] === '') return undefined
      if (unc) return { scope, path: `//${parts.join('/')}` }
      return { scope, path: isDriveSegment(parts[0]) ? parts.join('/') : `/${parts.join('/')}` }
    }

    /**
     * 文件地址 → 预览计划；`line` 来自官方 `openResource(address, { params: { line } })`。
     *
     * @param {string} address 资源地址。
     * @param {{ params?: { line?: number } }} [options] 官方 openResource 选项。
     * @returns {{ scope: string, sessionId?: string, path: string, line?: number }|undefined}
     */
    function filePreviewPlan(address, options) {
      const parsed = parseFileAddress(address)
      if (parsed === undefined) return undefined
      const rawLine = options?.params?.line
      const line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : undefined
      return parsed.scope === 'session'
        ? { scope: parsed.scope, sessionId: parsed.sessionId, path: parsed.path, line }
        : { scope: parsed.scope, path: parsed.path, line }
    }

    /**
     * 是否由插件接管这次打开：文件地址 + 右侧栏没有屏上会话。
     *
     * @param {string} address 资源地址。
     * @param {string|undefined} mountedSession `sidebarRight.mounted` 的快照。
     * @returns {boolean}
     */
    function shouldBridgeFileOpen(address, mountedSession) {
      if (mountedSession !== undefined) return false
      return parseFileAddress(address) !== undefined
    }

    /**
     * 读一页文件的行窗口：给了行号就从该行附近开始，否则从第一行开始。
     *
     * @param {{ sessionId?: string, path: string, line?: number }} plan 预览计划。
     * @param {string} fallbackSession 计划里没有会话时用的 Router 会话 id。
     * @returns {{ sessionId: string, path: string, range: { offset: number, limit: number }, targetLine?: number }|undefined}
     */
    function fileReadRequest(plan, fallbackSession) {
      if (plan === undefined || plan === null) return undefined
      if (typeof plan.path !== 'string' || plan.path.length === 0) return undefined
      const sessionId = typeof plan.sessionId === 'string' && plan.sessionId.length > 0 ? plan.sessionId : fallbackSession
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const targetLine = Number.isInteger(plan.line) && plan.line > 0 ? plan.line : undefined
      const offset = targetLine === undefined ? 1 : Math.max(1, targetLine - 8)
      return { sessionId, path: plan.path, range: { offset, limit: PREVIEW_LINES }, targetLine }
    }

    /**
     * 把 `sidebarRight.openResource` 包一层：没有屏上会话时把文件地址交给 `open`，
     * 其它情况（以及所有非文件地址）原样调用官方实现，不改变普通会话的行为。
     *
     * @param {object|undefined} sidebar 官方 sidebarRight 服务。
     * @param {(plan: object) => void} open 插件自己的预览入口。
     * @returns {(() => void)|undefined} 还原函数；服务不可用/已装过时为 undefined。
     */
    function bridgeFileOpens(sidebar, open) {
      if (sidebar === undefined || sidebar === null || typeof sidebar.openResource !== 'function') return undefined
      const original = sidebar.openResource
      if (original[FILE_BRIDGE_FLAG] === true) return undefined
      const patched = function openResource(address, options) {
        let mountedSession
        try {
          mountedSession = typeof sidebar.mounted?.getSnapshot === 'function' ? sidebar.mounted.getSnapshot() : undefined
        } catch {
          mountedSession = undefined
        }
        if (shouldBridgeFileOpen(address, mountedSession)) {
          const plan = filePreviewPlan(address, options)
          if (plan !== undefined) {
            try {
              // open 返回 false 表示“没人接这次预览”（面板已卸载），退回官方实现。
              if (open(plan) !== false) return
            } catch {
              // 预览入口自己坏了就退回官方实现，让错误照旧暴露。
            }
          }
        }
        return original.call(this, address, options)
      }
      patched[FILE_BRIDGE_FLAG] = true
      // 用 defineProperty 在实例上遮蔽原型方法：服务对象的 openResource 常常是
      // 原型上的不可写方法，直接赋值会抛错或静默失败。失败就不接管。
      const own = Object.prototype.hasOwnProperty.call(sidebar, 'openResource')
      try {
        Object.defineProperty(sidebar, 'openResource', { configurable: true, writable: true, value: patched })
      } catch {
        return undefined
      }
      return () => {
        if (sidebar.openResource !== patched) return
        try {
          if (own) Object.defineProperty(sidebar, 'openResource', { configurable: true, writable: true, value: original })
          else delete sidebar.openResource
        } catch {
          // 还原失败只影响卸载后的一次点击。
        }
      }
    }

    /**
     * 面板挂载期间登记的文件预览接收器。
     *
     * 桥只存在一份（apply 里装），面板卸载时清掉接收器，避免桥把点击投给已卸载组件。
     */
    let filePreviewSink

    /** uiWorkspace 晚于本插件就绪；由 apply 里的可选 inject 捕获，点击时再解析。 */
    let workspaceService
    let layoutService

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

    /**
     * 事件是否落在抽屉里（决定「点外面关闭」要不要触发）。
     *
     * 抽屉自己弹出的下拉菜单是 `position: fixed`、脱离了抽屉盒子，但也算「里面」——
     * 否则点一下选项就会把抽屉关掉。
     *
     * @param {object} node 抽屉盒子（可能还没挂上）。
     * @param {object} target 事件目标。
     * @returns {boolean} 是否算「里面」。
     */
    function isInsideDrawer(node, target) {
      if (target === null || target === undefined || typeof target !== 'object') return false
      if (typeof target.closest === 'function' && target.closest('[data-super-agent-popup]') !== null) return true
      if (node === null || node === undefined || typeof node.contains !== 'function') return false
      return node.contains(target) === true
    }

    /**
     * 抽屉的关闭手势：`Esc` + 点抽屉外（只在打开期间绑定，解开时移除）。
     *
     * 抽成纯函数是为了能测：`Drawer` 里的 effect 只负责接上/解开。
     *
     * @param {object} target 有 `addEventListener` 的对象（`document`）。
     * @param {{
     *   isInside: (event: object) => boolean,
     *   onClose: () => void,
     *   onEscape?: () => void,
     *   dismissOnOutside?: boolean,
     * }} options `isInside` 判断事件是否落在抽屉里；落在里面不关闭。`onEscape` 覆盖
     *   Esc 的行为（预览列用它关当前标签）；`dismissOnOutside: false` 表示点外面不关闭
     *   （预览列：点会话里的另一个文件链接要能新增标签，而不是先被关掉）。
     * @returns {() => void} 解绑函数。
     */
    function bindDrawerDismiss(target, options) {
      if (target === null || target === undefined || typeof target.addEventListener !== 'function') {
        return () => {}
      }
      const onKeyDown = (event) => {
        if (event?.key !== 'Escape') return
        // 正在输入框里按 Esc 是想取消输入，不是想关掉抽屉（模型/规则抽屉里有输入框）。
        const target = event.target
        const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : ''
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true) return
        if (typeof options.onEscape === 'function') options.onEscape()
        else options.onClose()
      }
      const onMouseDown = (event) => {
        if (options.dismissOnOutside === false) return
        if (options.isInside(event) !== true) options.onClose()
      }
      target.addEventListener('keydown', onKeyDown, true)
      target.addEventListener('mousedown', onMouseDown, true)
      return () => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener('keydown', onKeyDown, true)
          target.removeEventListener('mousedown', onMouseDown, true)
        }
      }
    }

    /**
     * 渲染错误边界。
     *
     * 官方渲染器（CodeBlock / MarkdownText）或我们自己的一处渲染抛错时，React 会
     * **卸载整棵树**——宿主主区域只剩一片黑，只能刷新。这里把错误接在本地：显示成
     * 抽屉/面板里的错误态，其余界面照常可用。宿主的 React 没有 `Component`（精简
     * 宿主或测试桩）时退化成直通组件。
     *
     * @type {Function}
     */
    const RenderBoundary = typeof React.Component === 'function'
      ? class RenderBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: undefined }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error) {
          // console 留一份：错误态里只显示摘要，完整栈在 devtools。
          try {
            console.error('[super-agent] render failed', error)
          } catch {
            // 某些宿主屏蔽 console。
          }
        }

        render() {
          if (this.state.error !== undefined) {
            const fallback = this.props.fallback
            const reset = () => this.setState({ error: undefined })
            if (typeof fallback === 'function') return fallback(this.state.error, reset)
            return null
          }
          return this.props.children
        }
      }
      : function RenderBoundary({ children }) {
        return children
      }

    /** 错误摘要：只留消息，避免把整段栈塞进界面。 */
    function errorSummaryOf(error) {
      if (error === undefined || error === null) return 'unknown'
      const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error)
      return message.length > 240 ? `${message.slice(0, 240)}…` : message
    }

    /**
     * 抽屉内的错误态：官方渲染器把某段内容渲染崩了，只坏这一块。
     *
     * @param {object} props
     * @param {object} props.t 翻译函数。
     * @param {unknown} props.error 捕获到的错误。
     * @param {() => void} [props.onRetry] 重试。
     * @returns {object} React 元素。
     */
    function CrashNote({ t, error, onRetry }) {
      return h('div', { style: S.crashBox, role: 'alert' },
        h('div', { style: S.crashTitle }, t('renderFailed')),
        h('div', { style: S.crashDetail }, errorSummaryOf(error)),
        typeof onRetry === 'function'
          ? h('button', { type: 'button', style: S.smallButton, onClick: onRetry }, t('retry'))
          : null,
      )
    }

    /**
     * 面板级错误态：整页渲染崩了也不能把宿主变成黑屏。
     *
     * @param {object} props
     * @param {object} props.t 翻译函数。
     * @param {unknown} props.error 捕获到的错误。
     * @param {() => void} props.onReset 重建面板。
     * @returns {object} React 元素。
     */
    function PanelCrash({ t, error, onReset }) {
      return h('div', { style: { ...S.root, padding: 24, gap: 10, justifyContent: 'center' } },
        h(CrashNote, { t, error, onRetry: onReset }),
        h('div', { style: S.instanceHint }, t('renderFailedHint')),
      )
    }

    /**
     * 抽屉外壳。两种形态共用一套结构，避免「预览」和「设置」两套实现：
     *
     * - `variant: 'drawer'`（文件预览）：**真正的右侧抽屉**——贴面板右侧、宽
     *   520/640、高 100%、**不画遮罩**（遮罩会盖住主界面，还会被当成「整个界面
     *   变黑、点不动」），`Esc` 关闭，正文自己滚动。预览列传
     *   `dismissOnOutside: false`：点会话里的文件链接是「再开一个标签」，不能先把
     *   整列关掉。
     * - `variant: 'modal'`（模型/规则/定时/全部活动）：保持原来的居中弹层，遮罩用
     *   `absolute` 只盖住面板区域，不盖宿主左栏。
     *
     * @param {object} props
     * @param {string} props.title 标题。
     * @param {object} props.t 翻译函数。
     * @param {() => void} props.onClose 关闭。
     * @param {object[]} props.children 正文。
     * @param {object} [props.footer] 底部操作区。
     * @param {object} [props.header] 自定义头部（预览列用它放标签栏）；给了就不再画标题行。
     * @param {boolean} [props.dismissOnOutside] 点外面是否关闭（默认 true）。
     * @param {() => void} [props.onEscape] Esc 的自定义行为（默认 `onClose`）。
     * @param {object} [props.resizer] 头部之前的附加节点（预览列的拖拽条）。
     * @param {object} [props.bodyStyle] 正文容器的额外样式。
     * @param {number} [props.width] 抽屉宽度覆盖（预览列按面板宽度/拖拽值算）。
     * @param {boolean} [props.wide] 更宽（抽屉 640 / 弹层 520）。
     * @param {'modal'|'drawer'} [props.variant] 外壳形态，默认 `modal`。
     * @returns {object} React 元素。
     */
    function Drawer({ title, t, onClose, children, footer, header, resizer, bodyStyle, width, wide = false, variant = 'modal', dismissOnOutside = true, onEscape }) {
      const panelRef = React.useRef(null)
      const isDrawer = variant === 'drawer'
      React.useEffect(() => bindDrawerDismiss(typeof document === 'undefined' ? undefined : document, {
        isInside: (event) => isInsideDrawer(panelRef.current, event?.target),
        onClose,
        onEscape,
        dismissOnOutside,
      }), [onClose, onEscape, dismissOnOutside])
      const basePanel = isDrawer
        ? (wide ? { ...S.drawerPanel, ...S.drawerPanelWide } : S.drawerPanel)
        : (wide ? { ...S.drawer, ...S.drawerWide } : S.drawer)
      const panelStyle = width === undefined || !isDrawer
        ? basePanel
        : { ...basePanel, width, maxWidth: '100%' }
      const panel = h('div', {
        ref: panelRef,
        style: panelStyle,
        role: 'dialog',
        'aria-label': title,
        'aria-modal': isDrawer ? 'false' : 'true',
        'data-super-agent-drawer': isDrawer ? 'side' : 'modal',
      },
        resizer === undefined ? null : resizer,
        header === undefined
          ? h('div', { style: S.drawerHeader },
              h('div', { style: S.drawerTitle }, title),
              h('button', {
                type: 'button',
                className: 'sa-icon-button',
                style: S.iconButton,
                onClick: onClose,
                title: t('close'),
                'aria-label': t('close'),
              }, h(Glyph, { name: 'close', size: 16, strokeWidth: 1.1 })),
            )
          : header,
        h('div', { style: bodyStyle === undefined ? S.drawerBody : { ...S.drawerBody, ...bodyStyle } }, children),
        footer === undefined ? null : h('div', { style: S.drawerFooter }, footer),
      )
      if (isDrawer) {
        // 抽屉不进遮罩层：主界面始终可见、可点，也不会因为父级没定位而铺满整屏。
        return panel
      }
      return h('div', {
        style: S.backdrop,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      }, panel)
    }

    /**
     * 宿主文件读取接口在浏览器里的服务名。
     *
     * `workspaceFiles` 是宿主 Typert Remote 命名空间（@deepseek-ai/dsh-api-workspace-files
     * 的 `WorkspaceFiles extends TypertRemoteService`），由 dsh-api-remotes 的 Client
     * 装配 `$mount` 进 api-gateway，落地成一个独立的 Cordis 服务：名字就是
     * `remote.workspaceFiles`（dsh-api-gateway/lib/client.browser.js 的 remoteServiceKey）。
     */
    const WORKSPACE_FILES_SERVICE = 'remote.workspaceFiles'

    /** 就绪后常驻的接口对象；由 `bindWorkspaceFiles` 填，插件卸载时清空。 */
    let workspaceFilesFace

    /**
     * 取 `remote.workspaceFiles`：先看缓存，再按「直接属性 → ctx.get」两级解析。
     *
     * 不能写 `ctx.remote.workspaceFiles`：cordis 的嵌套服务转发按**调用方 fiber 的
     * inject** 过滤（cordis/lib/index.js 的 `tracker.associate` 分支），没在 inject
     * 里声明 `remote` / `remote.workspaceFiles` 时直接抛 `cannot get property …
     * without inject`，面板就只剩下降级提示。
     *
     * @param {object|undefined} ctx 插件上下文（或 inject 作用域）。
     * @returns {object|undefined} 命名空间服务；缺席时为 undefined。
     */
    function resolveWorkspaceFiles(ctx) {
      if (workspaceFilesFace !== undefined) return workspaceFilesFace
      return service(ctx, WORKSPACE_FILES_SERVICE)
    }

    /**
     * 等 `remote.workspaceFiles` 就绪并缓存下来（官方写法，见
     * dsh-client-ui-sidebar-documentpreview 的 `ctx.inject(['remote.workspaceFiles'], …)`）。
     *
     * 它可能晚于本插件出现（api-remotes 的装配是异步的），所以不写进插件级 inject：
     * 那样服务永久缺席时整个插件都不会加载，降级提示也就没了。这里用嵌套 inject，
     * 服务不在时回调根本不跑，面板照常工作。
     *
     * @param {object|undefined} ctx 插件上下文。
     */
    function bindWorkspaceFiles(ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return
      try {
        ctx.inject([WORKSPACE_FILES_SERVICE], (scope) => {
          // 这里按作用域解析，而不是读缓存：缓存可能是热重载前的旧实例。
          const files = service(scope, WORKSPACE_FILES_SERVICE)
          if (files === undefined) return
          workspaceFilesFace = files
          try {
            scope.effect(() => () => {
              if (workspaceFilesFace === files) workspaceFilesFace = undefined
            }, 'super-agent: workspace files face')
          } catch {
            // 没有 effect 的精简宿主：缓存保留到插件卸载。
          }
        })
      } catch {
        // 宿主没有 inject：预览退回「接口缺失」提示。
      }
    }

    /**
     * 读一页预览文本（代码 / markdown 正文）。任何失败都折成状态，不向 React 抛。
     *
     * 宿主契约（0.2.1-rc.1，`WorkspaceFiles.read`）：
     *   `read(workspaceFileScope, path, range, signal)`，线上首参是
     *   `workspaceFileScopeId`（typert 的 `workspaceFileScope` lookup 用 **SessionId**
     *   解析成该会话的 workspaceRoot），因此第一个实参是会话 id；`path` 为绝对路径
     *   或相对 workspaceRoot 的路径；`range = { offset(1 起), limit }`；
     *   返回 `RemoteResult<WorkspaceFileText>`（生成客户端包成 `{ ok, value }` /
     *   `{ ok:false, error }`，不抛）。文本一律按 UTF-8 解码，没有编码参数；
     *   非 UTF-8 会得到 `workspace-file/not-text` 错误。
     *
     * @param {() => object|undefined} resolveFace 取命名空间服务（可能晚就绪）。
     * @param {{ sessionId?: string, path: string, line?: number }|undefined} plan 预览计划。
     * @param {string} fallbackSession 计划里没有会话时用的 Router 会话 id。
     * @param {AbortSignal} [signal] 取消这次读取。
     * @returns {Promise<object>} `{ status: 'ready'|'error'|'unavailable'|'cancelled', … }`。
     */
    async function readFilePreview(resolveFace, plan, fallbackSession, signal) {
      const request = fileReadRequest(plan, fallbackSession)
      if (request === undefined) {
        return { status: 'unavailable', path: typeof plan?.path === 'string' ? plan.path : '' }
      }
      let files
      try {
        files = typeof resolveFace === 'function' ? resolveFace() : undefined
      } catch {
        files = undefined
      }
      let read
      try {
        read = files === undefined ? undefined : files.read
      } catch {
        read = undefined
      }
      if (typeof read !== 'function') return { status: 'unavailable', path: request.path }

      let result
      try {
        result = await read.call(files, request.sessionId, request.path, request.range, signal)
      } catch (error) {
        return {
          status: 'error',
          path: request.path,
          error: error?.message ?? String(error),
        }
      }
      if (signal?.aborted === true) return { status: 'cancelled', path: request.path }

      // 生成客户端返回 RemoteResult；对直接给页面的实现保持宽容。
      let page = result
      if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') {
        if (result.ok === false) {
          // 宿主 RemoteResult 的 error 可能是 `{ code, message }` 也可能是字符串；
          // 把 code 带上，错误态才说得清「为什么失败」（not-found / 沙箱 / 网关）。
          const detail = result.error
          const reason = typeof detail === 'string'
            ? detail
            : (detail?.message ?? detail?.code ?? 'workspaceFiles.read failed')
          const code = typeof detail === 'object' && detail !== null && typeof detail.code === 'string' ? detail.code : undefined
          return {
            status: 'error',
            path: request.path,
            error: reason,
            code,
          }
        }
        page = result.value
      }
      if (page === null || typeof page !== 'object') {
        return { status: 'error', path: request.path, error: 'empty workspaceFiles.read response' }
      }
      return {
        status: 'ready',
        path: request.path,
        text: typeof page.text === 'string' ? page.text : '',
        offset: Number.isInteger(page.offset) && page.offset > 0 ? page.offset : request.range.offset,
        lines: Number.isInteger(page.lines) ? page.lines : 0,
        eof: page.eof !== false,
        version: typeof page.version === 'string' ? page.version : undefined,
      }
    }

    /**
     * 预览非正文态（接口缺失 / 读取失败 / 不能渲染）的文案；正文态返回 undefined。
     *
     * @param {(key: string) => string} t 当前语言的翻译函数。
     * @param {object} state 预览状态。
     * @returns {string|undefined}
     */
    function previewMessage(t, state) {
      if (state === undefined || state === null) return undefined
      if (state.status === 'unavailable') return format(t, 'previewUnavailable', { path: state.path ?? '' })
      if (state.status === 'error') {
        const reason = state.code === undefined ? (state.error ?? '') : `${state.code}: ${state.error ?? ''}`
        return format(t, 'previewError', { reason })
      }
      if (state.status === 'binary') return t('previewBinary')
      if (state.status === 'noRenderer') return t('previewNoRenderer')
      return undefined
    }

    /** 官方图片预览给 Blob 用的媒体类型；和后缀一一对应，未登记的后缀不按图片预览。 */
    const IMAGE_MEDIA_TYPES = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      svg: 'image/svg+xml',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      heic: 'image/heic',
      heif: 'image/heif',
    }

    /**
     * 路径 → 小写后缀（不含点）；没有后缀返回空串。
     *
     * @param {string} path 解码后的文件路径。
     * @returns {string}
     */
    function fileExtensionOf(path) {
      if (typeof path !== 'string') return ''
      const name = path.replaceAll('\\', '/')
      const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
      const dot = base.lastIndexOf('.')
      return dot <= 0 ? '' : base.slice(dot + 1)
    }

    /**
     * 路径 → 图片媒体类型（纯函数）。
     *
     * @param {string} path 解码后的文件路径。
     * @returns {string|undefined} 未登记后缀返回 undefined。
     */
    function imageMediaTypeOf(path) {
      const suffix = fileExtensionOf(path)
      return Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, suffix)
        ? IMAGE_MEDIA_TYPES[suffix]
        : undefined
    }

    /**
     * 预览正文类别：官方 `classifyFileType` 的 kind → 面板能渲染的正文（或 binary）。
     *
     * 官方 body 注册表按后缀挑渲染器（code / markdown / image / pdf / office…），
     * 面板没有 PDF/Office 渲染器，这几类明确说“只能在官方预览里看”，而不是
     * 把二进制当文本读出一屏乱码。CSV/TSV 被官方归到表格类，但字节就是文本，
     * 面板按代码正文显示（表格渲染器是面板故意不带的重量级依赖）。
     *
     * @param {((path: string) => string)|undefined} classify 官方 `classifyFileType`。
     * @param {string} path 解码后的文件路径。
     * @returns {'code'|'markdown'|'image'|'binary'} 正文类别。
     */
    function previewKindOf(classify, path) {
      let kind
      try {
        kind = typeof classify === 'function' ? classify(path) : undefined
      } catch {
        kind = undefined
      }
      if (kind === 'markdown') return 'markdown'
      if (kind === 'image' && imageMediaTypeOf(path) !== undefined) return 'image'
      if (kind === 'excel' && (fileExtensionOf(path) === 'csv' || fileExtensionOf(path) === 'tsv')) return 'code'
      if (kind === 'pdf' || kind === 'word' || kind === 'excel' || kind === 'ppt' || kind === 'video') return 'binary'
      return 'code'
    }

    /**
     * 读整个（或指定窗口的）文件字节：图片预览用。
     *
     * 与 `readFilePreview` 同一条公开面（`remote.workspaceFiles`），只是走
     * `readBytes`：返回 `RemoteResult<WorkspaceFileBytes>`，`value.data` 是
     * `Uint8Array`，可以直接喂 `Blob`。
     *
     * @param {() => object|undefined} resolveFace 取命名空间服务（可能晚就绪）。
     * @param {{ sessionId?: string, path: string }} plan 预览计划。
     * @param {string} fallbackSession 计划里没有会话时用的 Router 会话 id。
     * @param {AbortSignal} [signal] 取消这次读取。
     * @returns {Promise<object>} `{ status: 'ready'|'error'|'unavailable', … }`。
     */
    async function readFileBytes(resolveFace, plan, fallbackSession, signal) {
      const request = fileReadRequest(plan, fallbackSession)
      if (request === undefined) {
        return { status: 'unavailable', path: typeof plan?.path === 'string' ? plan.path : '' }
      }
      const mediaType = imageMediaTypeOf(request.path)
      if (mediaType === undefined) {
        return { status: 'error', path: request.path, error: `unsupported image suffix: ${request.path}` }
      }
      let files
      try {
        files = typeof resolveFace === 'function' ? resolveFace() : undefined
      } catch {
        files = undefined
      }
      let readBytes
      try {
        readBytes = files === undefined ? undefined : files.readBytes
      } catch {
        readBytes = undefined
      }
      if (typeof readBytes !== 'function') return { status: 'unavailable', path: request.path }

      let result
      try {
        result = await readBytes.call(files, request.sessionId, request.path, {}, signal)
      } catch (error) {
        if (signal?.aborted === true) return { status: 'cancelled', path: request.path }
        return { status: 'error', path: request.path, error: error?.message ?? String(error) }
      }
      if (signal?.aborted === true) return { status: 'cancelled', path: request.path }

      let page = result
      if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') {
        if (result.ok === false) {
          return { status: 'error', path: request.path, error: result.error?.message ?? 'workspaceFiles.readBytes failed' }
        }
        page = result.value
      }
      if (page === null || typeof page !== 'object' || page.data === undefined || page.data === null) {
        return { status: 'error', path: request.path, error: 'empty workspaceFiles.readBytes response' }
      }
      return {
        status: 'ready',
        path: request.path,
        mediaType,
        data: page.data,
        eof: page.eof !== false,
        version: typeof page.version === 'string' ? page.version : undefined,
      }
    }

    /**
     * 预览正文元素（纯函数，不碰 hooks）：官方 `CodeBlock` / `MarkdownText` / `<img>`，
     * 非正文态给一条可读提示。单独拆出来是为了让节点测试直接断言组件的 props。
     *
     * @param {object|undefined} primitives 官方 primitives 导出。
     * @param {(key: string) => string} t 当前语言的翻译函数。
     * @param {{ kind: string, state: object, imageUrl: string|undefined, path: string }} view 视图输入。
     * @returns {object} React 元素。
     */
    /**
     * 代码块横幅文案（对应宿主 `CodeBlock` 的 `toolbarLabels`）。
     *
     * @param {Function} t 文案函数。
     * @returns {{ codeLabel: string, wrapLabel: string, unwrapLabel: string }} 横幅文案。
     */
    function codeToolbarLabelsOf(t) {
      return {
        codeLabel: t('previewCodeLabel'),
        wrapLabel: t('previewWrap'),
        unwrapLabel: t('previewUnwrap'),
      }
    }

    /**
     * Markdown 渲染器要的 `labels`（对应宿主 `MarkdownText` 的 `labels`）。
     *
     * @param {object} primitives 官方 primitives 模块（保留形参以便将来按需取用）。
     * @param {Function} t 文案函数。
     * @returns {object} `labels` 结构。
     */
    function markdownLabelsOf(primitives, t) {
      return {
        code: {
          copyLabel: t('previewCopy'),
          copiedLabel: t('previewCopied'),
          toolbarLabels: codeToolbarLabelsOf(t),
        },
        footnotes: t('previewFootnotes'),
      }
    }

    function previewBodyOf(primitives, t, view) {
      const { kind, state, imageUrl, path } = view
      if (primitives === undefined) return h('div', { style: S.previewNote }, t('previewNoRenderer'))
      if (state.status === 'loading') return h('div', { style: S.previewNote }, t('previewLoading'))
      if (state.status !== 'ready') return h('div', { style: S.previewNote }, previewMessage(t, { ...state, path }))
      if (kind === 'image') {
        return imageUrl === undefined
          ? h('div', { style: S.previewNote }, t('previewLoading'))
          : h('div', { style: S.previewBody }, h('img', { src: imageUrl, alt: path, style: S.previewImage }))
      }
      // 接口「没 ok 却按成功结构取正文」是历史坑：text 不是字符串就直接出错误态，
      // 不能把 undefined 喂给 CodeBlock/MarkdownText（那才是 TypeError 的来源）。
      if (typeof state.text !== 'string') return h('div', { style: S.previewNote }, previewMessage(t, { ...state, path }))
      if (state.text.length === 0) return h('div', { style: S.previewNote }, t('previewEmpty'))
      if (kind === 'markdown') {
        // `labels` 不是可选的：MarkdownText 渲染代码围栏时会读
        // `labels.code.toolbarLabels`（宿主档 index-CN7NIWNw.js 里的
        // `copyLabel: r.labels.code.copyLabel, toolbarLabels: r.labels.code.toolbarLabels`），
        // 少传就抛 `Cannot read properties of undefined (reading 'code')`。
        return h('div', { style: S.previewBody }, h(primitives.MarkdownText, {
          text: state.text,
          labels: markdownLabelsOf(primitives, t),
        }))
      }
      // 行号从 1 起是 CodeBlock 的固定行为；从第 offset 行开始读时补空行，
      // 编号才能对上文件真实行号（行号列由 CodeBlock 自己画）。
      const padding = state.offset > 1 ? '\n'.repeat(state.offset - 1) : ''
      return h('div', { style: S.previewBody }, h(primitives.CodeBlock, {
        code: padding + state.text,
        lang: typeof primitives.languageForPath === 'function' ? primitives.languageForPath(state.path) : undefined,
        lineNumbers: true,
        wrap: true,
        copyLabel: t('previewCopy'),
        copiedLabel: t('previewCopied'),
        // 与官方 CodeBody 同一份形状（dsh-client-ui-sidebar-documentpreview 的
        // CodeBody → CodeBlock），缺了它横幅会读 `labels.codeLabel` 抛错。
        toolbarLabels: codeToolbarLabelsOf(t),
      }))
    }

    // ── 预览列：一个文件一个标签，行为对齐宿主右侧栏 ─────────────────────────

    /** 标签 id = 文件路径：同一个文件只保留一个标签。 */
    function previewTabId(plan) {
      return typeof plan?.path === 'string' ? plan.path : ''
    }

    /** 标签显示名：路径最后一段（Windows/POSIX 分隔符都认）。 */
    function previewFileName(path) {
      const text = typeof path === 'string' ? path.replace(/[\\/]+$/, '') : ''
      const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return index === -1 ? text : text.slice(index + 1)
    }

    /** 标签图标：按扩展名给文件 / 代码 / 图片 / Markdown 四种。 */
    function previewIconFor(path) {
      const suffix = String(path).slice(String(path).lastIndexOf('.') + 1).toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(suffix)) return 'fileImage'
      if (['md', 'markdown', 'mdx'].includes(suffix)) return 'fileMarkdown'
      if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'sh', 'bash', 'yml', 'yaml', 'toml', 'tex', 'csv', 'tsv', 'sql'].includes(suffix)) return 'fileCode'
      return 'file'
    }

    /**
     * 打开一个文件：同路径已开就只激活，不重复加标签；新路径追加到末尾并激活。
     *
     * @param {object[]} tabs 现有标签。
     * @param {{ path?: string }} plan 文件预览计划。
     * @returns {{ tabs: object[], activeId: string }}
     */
    function previewTabsAdd(tabs, plan) {
      const list = Array.isArray(tabs) ? tabs : []
      const id = previewTabId(plan)
      if (id === '') return { tabs: list, activeId: list.length > 0 ? list[list.length - 1].id : '' }
      if (list.some((tab) => tab.id === id)) return { tabs: list, activeId: id }
      return { tabs: [...list, { id, plan }], activeId: id }
    }

    /**
     * 关闭一个标签：关的是活动标签时激活它的右邻（没有右邻就左邻）；
     * 关到最后一个返回空列表，调用方据此收起整列。
     *
     * @param {object[]} tabs 现有标签。
     * @param {string} activeId 当前活动标签。
     * @param {string} id 要关的标签。
     * @returns {{ tabs: object[], activeId: string }}
     */
    function previewTabsClose(tabs, activeId, id) {
      const list = Array.isArray(tabs) ? tabs : []
      const index = list.findIndex((tab) => tab.id === id)
      if (index === -1) return { tabs: list, activeId }
      const next = list.filter((tab) => tab.id !== id)
      if (next.length === 0) return { tabs: [], activeId: '' }
      if (id !== activeId) return { tabs: next, activeId }
      const neighbor = next[Math.min(index, next.length - 1)]
      return { tabs: next, activeId: neighbor.id }
    }

    /**
     * 预览列宽：宽屏默认 640、面板 < 1000 时降到 480；任何情况下都给对话区
     * 留至少 320px，拖拽值也走同一套上下限。面板宽度未知时按宽屏算。
     *
     * @param {number} panelWidth 面板可用宽度。
     * @param {number|undefined} preferred 用户拖出来的宽度。
     * @returns {number}
     */
    function previewWidthFor(panelWidth, preferred) {
      const room = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 1200
      const base = Number.isFinite(preferred) && preferred > 0 ? preferred : (room < 1000 ? 480 : 640)
      const max = Math.max(360, Math.min(720, room - 320))
      return Math.max(360, Math.min(base, max))
    }

    /**
     * 单个标签的正文：读取走官方公开 remote 面，正文用官方渲染组件。
     *
     * 官方右侧栏预览在插件面板里打不开：面板占着 `main` 槽，`activePanelId` 非空，
     * 而 ui-sidebar-right 只在主区域是会话时才给 `mounted` 绑屏上会话
     *（client.js:4828-4840），座位本身也 `hidden: !active`（client.js:1609-1612）。
     * 所以正文直接复用官方预览正文用的同一批组件（`CodeBlock` / `MarkdownText`，
     * 见官方 CodeBody 的 props），不再自己实现渲染。
     *
     * 读取仍然必须走 `remote.workspaceFiles`：官方预览装配自己的 tab 面、store 与
     * paged read（`textFace(read, readAll, resources)`），这些只存在于右侧栏座位里，
     * 面板拿不到，所以公开 remote 面是唯一可用的数据入口。缺接口时明确提示。
     *
     * 每个标签各挂一份（非活动标签只是 `display: none`），切换标签不重新读取、
     * 也不丢各自的滚动位置。
     *
     * @param {object} props
     * @param {object} props.t 翻译函数。
     * @param {{ path?: string, line?: number }} props.plan 文件预览计划。
     * @param {string} props.sessionId 回退会话。
     * @param {object} props.pluginCtx 插件上下文（解析 workspaceFiles）。
     * @param {boolean} [props.hidden] 非活动标签。
     * @returns {object} React 元素。
     */
    function PreviewTabBody({ t, plan, sessionId, pluginCtx, hidden = false }) {
      const [attempt, setAttempt] = React.useState(0)
      const [state, setState] = React.useState({ status: 'loading' })
      const [imageUrl, setImageUrl] = React.useState(undefined)
      const path = typeof plan?.path === 'string' ? plan.path : ''
      const kind = previewKindOf(official?.classifyFileType, path)

      React.useEffect(() => {
        let cancelled = false
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        setState({ status: 'loading', path })
        if (official === undefined) {
          setState({ status: 'noRenderer', path })
          return undefined
        }
        if (kind === 'binary') {
          setState({ status: 'binary', path })
          return undefined
        }
        const resolveFace = () => resolveWorkspaceFiles(pluginCtx)
        const load = kind === 'image'
          ? readFileBytes(resolveFace, plan, sessionId, controller?.signal)
          : readFilePreview(resolveFace, plan, sessionId, controller?.signal)
        void load.then((next) => {
          if (cancelled || next.status === 'cancelled') return
          setState(next)
        })
        return () => {
          cancelled = true
          try {
            controller?.abort()
          } catch {
            // 中止失败不影响下一次读取。
          }
        }
      }, [plan, sessionId, pluginCtx, kind, path, attempt])

      // 图片字节 → object URL（官方 ImageBody 的做法），换文件或卸载时释放。
      React.useEffect(() => {
        if (state.status !== 'ready' || state.data === undefined) {
          setImageUrl(undefined)
          return undefined
        }
        const canCreate = typeof URL === 'function' && typeof URL.createObjectURL === 'function'
        if (!canCreate) {
          setImageUrl(undefined)
          return undefined
        }
        let url
        try {
          url = URL.createObjectURL(new Blob([state.data], { type: state.mediaType }))
        } catch {
          setImageUrl(undefined)
          return undefined
        }
        setImageUrl(url)
        return () => {
          try {
            URL.revokeObjectURL(url)
          } catch {
            // 释放失败只影响一次内存回收。
          }
        }
      }, [state])

      const shownPath = typeof state.path === 'string' && state.path.length > 0 ? state.path : path
      const body = previewBodyOf(official, t, { kind, state, imageUrl, path: shownPath })

      const footerNote = state.status === 'ready' && state.eof === false
        ? h('div', { style: S.previewNote }, format(t, 'previewTruncated', { lines: state.lines ?? 0, from: state.offset ?? 1 }))
        : null
      const retriable = state.status === 'error' || state.status === 'unavailable'

      return h('div', {
        style: hidden ? { ...S.previewPane, display: 'none' } : S.previewPane,
        'data-super-agent-preview-pane': path,
      },
        h('div', { style: S.previewPath, title: shownPath }, shownPath),
        // 官方渲染器抛错时只坏正文这一块：标签页和面板都不受影响。
        h(RenderBoundary, {
          fallback: (error, reset) => h(CrashNote, {
            t,
            error,
            onRetry: () => {
              reset()
              setAttempt(attempt + 1)
            },
          }),
        }, body),
        footerNote,
        retriable
          ? h('div', { style: S.previewRetryRow },
              h('button', { type: 'button', style: S.smallButton, onClick: () => setAttempt(attempt + 1) }, t('retry')),
            )
          : null,
      )
    }

    /**
     * 右侧预览列：标签栏（可横向滚动）+ 常驻正文 + 左缘拖拽条。
     *
     * 外壳仍复用 `Drawer` 的 drawer 变体（无遮罩、Esc/点外部关闭、错误边界），
     * 只把标题行换成标签栏，宽度由面板宽度/拖拽值决定。
     *
     * @param {object} props
     * @param {object} props.t 翻译函数。
     * @param {object[]} props.tabs `[{ id, plan }]`。
     * @param {string} props.activeId 活动标签 id。
     * @param {number} props.width 当前列宽。
     * @param {string} props.sessionId 回退会话。
     * @param {object} props.pluginCtx 插件上下文。
     * @param {(id: string) => void} props.onActivate 激活标签。
     * @param {(id: string) => void} props.onCloseTab 关闭单个标签。
     * @param {() => void} props.onClose 关闭整列。
     * @param {(width: number) => void} props.onResize 拖拽/双击后的列宽。
     * @returns {object} React 元素。
     */
    function PreviewColumn({ t, tabs, activeId, width, sessionId, pluginCtx, onActivate, onCloseTab, onClose, onResize }) {
      const list = Array.isArray(tabs) ? tabs : []
      const activeTab = list.find((tab) => tab.id === activeId) ?? list[list.length - 1]
      const drag = React.useRef(undefined)

      /** 从列的左缘开始拖：向左 = 变宽，向右 = 变窄。 */
      const startDrag = (event) => {
        if (event === undefined || event === null) return
        if (typeof event.button === 'number' && event.button !== 0) return
        try {
          event.preventDefault()
        } catch {
          // 精简宿主没有 preventDefault：继续拖。
        }
        drag.current = { x: event.clientX, width }
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        const move = (next) => {
          if (drag.current === undefined) return
          onResize(drag.current.width + (drag.current.x - next.clientX))
        }
        const stop = () => {
          drag.current = undefined
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
      }

      const header = h('div', { style: S.previewHeader },
        h('div', {
          style: S.previewTabScroll,
          className: 'sa-preview-tabs',
          role: 'tablist',
          'aria-label': t('previewTitle'),
        },
          list.map((tab) => {
            const selected = tab.id === activeTab?.id
            return h('div', {
              key: tab.id,
              role: 'tab',
              'aria-selected': selected,
              'data-super-agent-preview-tab': tab.id,
              className: 'sa-preview-tab',
              style: selected ? { ...S.previewTab, ...S.previewTabActive } : S.previewTab,
              title: tab.id,
              onClick: () => onActivate(tab.id),
            },
              h(Glyph, { name: previewIconFor(tab.id), size: 13, style: { flex: 'none', opacity: .85 } }),
              h('span', { style: S.previewTabName }, previewFileName(tab.id)),
              h('button', {
                type: 'button',
                className: 'sa-icon-button sa-preview-tab-close',
                style: S.previewTabClose,
                title: `${t('close')} ${previewFileName(tab.id)}`,
                'aria-label': `${t('close')} ${previewFileName(tab.id)}`,
                onClick: (event) => {
                  if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onCloseTab(tab.id)
                },
              }, h(Glyph, { name: 'close', size: 11, strokeWidth: 1.3 })),
            )
          }),
        ),
      )

      return h(Drawer, {
        title: t('previewTitle'),
        t,
        onClose,
        variant: 'drawer',
        width,
        header,
        // 点会话里的文件链接 = 再开一个标签，不能先关整列；Esc 逐级关当前标签。
        dismissOnOutside: false,
        onEscape: () => {
          if (activeTab !== undefined) onCloseTab(activeTab.id)
        },
        // 正文区不再统一滚动：每个标签自己滚，切换标签不重置。
        bodyStyle: { padding: 0, overflow: 'hidden', display: 'flex' },
        resizer: h('div', {
          style: S.previewResizer,
          className: 'sa-preview-resizer',
          'data-super-agent-preview-resizer': '',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': t('previewResize'),
          tabIndex: 0,
          onPointerDown: startDrag,
          // 双击在 480/640 两档之间切换（拖拽之外的快捷方式）。
          onDoubleClick: () => onResize(width >= 640 ? 480 : 640),
          onKeyDown: (event) => {
            if (event?.key === 'ArrowLeft') onResize(width + 24)
            else if (event?.key === 'ArrowRight') onResize(width - 24)
          },
        }),
      }, list.map((tab) => h(PreviewTabBody, {
        key: tab.id,
        t,
        plan: tab.plan,
        sessionId,
        pluginCtx,
        hidden: tab.id !== activeTab?.id,
      })))
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
      const activeStates = ['queued', 'starting', 'working', 'blocked', 'resumable', 'interrupted', 'lost']
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

    // ── 会话输入区的状态徽标 ─────────────────────────────────────────────────
    // 侧栏入口只在面板关着时有用；会话打开后那个按钮就不在视野里了，所以把
    // 「运行中 N / 未读 M」同时放进 composer 工具行左端（conversation.input.left）。
    // 这条路径只读现有 /ui/state，不新增协议；没有任务也没有未读时整块隐藏。
    let badgeState = { running: 0, unread: 0 }
    const badgeListeners = new Set()

    function badgeCount(value) {
      const number = Number(value)
      return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
    }

    /** 计数派生（纯函数）：两个计数都是 0 时不占位。 */
    function badgeSummary(state) {
      const running = badgeCount(state?.running)
      const unread = badgeCount(state?.unread)
      return running === 0 && unread === 0 ? null : { running, unread }
    }

    /** 「运行中 N / 未读 M」的文案分段；空数组表示隐藏。 */
    function badgeParts(t, summary) {
      if (summary === null || summary === undefined) return []
      const parts = []
      if (summary.running > 0) parts.push(format(t, 'badgeRunning', { count: summary.running }))
      if (summary.unread > 0) parts.push(format(t, 'badgeUnread', { count: summary.unread }))
      return parts
    }

    function publishBadge(patch) {
      const next = {
        running: badgeCount(patch?.running === undefined ? badgeState.running : patch.running),
        unread: badgeCount(patch?.unread === undefined ? badgeState.unread : patch.unread),
      }
      if (next.running === badgeState.running && next.unread === badgeState.unread) return
      badgeState = next
      for (const listener of badgeListeners) {
        try {
          listener(next)
        } catch {
          // 单个订阅者失败不影响其它订阅者。
        }
      }
      // 侧栏气泡还读 unreadTotalCache，这里一并推进，避免两套计数漂移。
      if (next.unread !== unreadTotalCache) {
        unreadTotalCache = next.unread
        for (const listener of unreadListeners) {
          try {
            listener(next.unread)
          } catch {
            // 同上。
          }
        }
      }
      syncNavUnreadBadge(next.unread)
    }

    function useBadgeState() {
      const [value, setValue] = React.useState(badgeState)
      React.useEffect(() => {
        badgeListeners.add(setValue)
        setValue(badgeState)
        return () => badgeListeners.delete(setValue)
      }, [])
      return value
    }

    /** 侧栏图标和 composer 徽标共用一条轮询：同时挂载也只发一份请求。 */
    let badgePollUsers = 0
    let badgePollTimer = null

    async function loadBadgeState() {
      try {
        const response = await fetch(ROUTES.state, { credentials: 'same-origin' })
        if (!response.ok) return
        const payload = await response.json()
        const summary = summarizeStatus(payload?.router)
        publishBadge({
          running: summary === null ? 0 : summary.workers,
          unread: Number(payload?.unreadTotal ?? 0),
        })
      } catch {
        // 宿主没就绪时静默；下一个周期再试。
      }
    }

    function useBadgePolling() {
      const state = useBadgeState()
      React.useEffect(() => {
        badgePollUsers += 1
        if (badgePollUsers === 1) {
          void loadBadgeState()
          badgePollTimer = setInterval(() => { void loadBadgeState() }, 4_000)
        }
        return () => {
          badgePollUsers -= 1
          if (badgePollUsers === 0 && badgePollTimer !== null) {
            clearInterval(badgePollTimer)
            badgePollTimer = null
          }
        }
      }, [])
      return state
    }

    /**
     * 面板可见性（纯函数）：页面没被隐藏，并且当前主面板就是本面板。
     *
     * `layout.panelInfo.getSnapshot().activePanelId` 是布局服务的共享选择源：
     * 字符串表示某个插件面板占着主区域，`null` 表示主视图是会话。读不到选择源
     * （老宿主 / 服务缺席）时退回「组件还挂着」——面板组件只在被选中时挂载。
     *
     * 不再单独判断「消息区是否在视口里」：消息区就是主面板本身，面板在屏上时它
     * 必然在视口内；再叠一层 IntersectionObserver 只会在滚动/骨架期误判成不可见，
     * 反而把正在看的回复记成未读。
     *
     * @param {{ hidden: boolean, activePanelId?: string|null, panelId: string }} input 输入。
     * @returns {boolean}
     */
    function panelVisible(input) {
      if (input === undefined || input === null) return false
      if (input.hidden === true) return false
      if (typeof input.activePanelId === 'string') return input.activePanelId === input.panelId
      if (input.activePanelId === null) return false
      return true
    }

    /**
     * 读布局服务当前的 `activePanelId`。
     *
     * 布局把面板选择放在一个 store 上（`panelInfo.getSnapshot()`）；也容忍直接
     * 暴露 `{ activePanelId }` 的旧形态。读不到返回 undefined（= 未知）。
     *
     * @returns {string|null|undefined} 面板 id、null（主视图是会话）或 undefined。
     */
    function activePanelIdNow() {
      return panelIdFromLayout(layoutService?.panelInfo)
    }

    /**
     * 从布局的面板选择源取 `activePanelId`（纯函数）。
     *
     * @param {object|undefined} info `layout.panelInfo`：store（`getSnapshot()`）或裸对象。
     * @returns {string|null|undefined} 面板 id、null（主视图是会话）或 undefined（未知）。
     */
    function panelIdFromLayout(info) {
      if (info === undefined || info === null) return undefined
      try {
        const snapshot = typeof info.getSnapshot === 'function' ? info.getSnapshot() : info
        const id = snapshot?.activePanelId
        if (typeof id === 'string') return id
        return id === null ? null : undefined
      } catch {
        return undefined
      }
    }

    /** 面板此刻是否真的被用户看着（读宿主实时状态，未读清零与计数共用这一判定）。 */
    function panelVisibleNow() {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      return panelVisible({ hidden, activePanelId: activePanelIdNow(), panelId: PANEL_ID })
    }

    /**
     * 面板当前会话的唯一写入口。
     *
     * 只有两类事件能改它：**用户动作**（切实例 / Reset / 点重试）与**挂载时的宿主
     * 快照**（bootstrap 沿用它已有的 Router）。轮询、未读、徽标、worker 报告这类
     * 事件回调一律不触碰当前选择——「打字打到一半被切走」就是事件回调顺手改选择
     * 造成的。
     *
     * @param {string} current 当前会话 id。
     * @param {{ kind?: string, sessionId?: string }|undefined} event 变更意图。
     * @returns {string} 变更后的会话 id。
     */
    function sessionTransition(current, event) {
      if (event === undefined || event === null) return current
      if (event.kind !== 'user' && event.kind !== 'bootstrap') return current
      return typeof event.sessionId === 'string' ? event.sessionId : current
    }

    /**
     * 面板上次显示的 Router 会话（instanceId → sessionId）。
     *
     * 组件一重挂（切面板 / HMR / 布局重排）`sessionId` 就没了，于是先闪回「新会话」
     * 落地页、再等 ensure 回来。这里只做内存级续接，不写盘、不持久化；刷新页面后
     * 由宿主快照重新确认。
     */
    const panelSessions = new Map()

    function rememberPanelSession(instanceId, sessionId) {
      if (typeof instanceId !== 'string' || instanceId.length === 0) return
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      panelSessions.set(instanceId, sessionId)
    }

    function cachedPanelSession(instanceId) {
      if (typeof instanceId !== 'string' || instanceId.length === 0) return ''
      return panelSessions.get(instanceId) ?? ''
    }

    /** 点徽标回面板：layout 服务缺席（精简宿主/测试桩）时静默失败。 */
    function openSuperAgentPanel(ctx) {
      const layout = layoutService ?? (ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('layout') : undefined)
      if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') return false
      try {
        layout.selectPanel(PANEL_ID)
        return true
      } catch {
        // 面板键没注册（插件被停用）时不抛给 React。
        return false
      }
    }

    // ── 图标 ─────────────────────────────────────────────────────────────────

    // ── 左栏未读气泡 ─────────────────────────────────────────────────────────
    // 左侧入口的 button 由 ui-sidebar 持有，槽位只拿到 icon；把数字挂到按钮的
    // 第三个 flex 子节点上，宽栏才会自然靠右。槽位重渲染后 observer 会补回。
    let unreadTotalCache = 0
    const unreadListeners = new Set()

    function publishUnread(value) {
      publishBadge({ unread: value })
    }

    function syncNavUnreadBadge(value) {
      if (typeof document === 'undefined') return
      const icons = document.querySelectorAll('[data-super-agent-nav-icon]')
      for (const icon of icons) {
        const button = icon.closest?.('button')
        if (button === undefined || button === null) continue
        let badge = button.querySelector('[data-super-agent-nav-badge]')
        if (value <= 0) {
          if (badge !== null) badge.remove()
          continue
        }
        if (badge === null) {
          badge = document.createElement('span')
          badge.setAttribute('data-super-agent-nav-badge', '')
          badge.setAttribute('aria-hidden', 'true')
          button.appendChild(badge)
        }
        const text = value > 99 ? '99+' : String(value)
        const narrow = button.getBoundingClientRect().width < 64
        const signature = `${text}:${narrow ? 'rail' : 'wide'}`
        if (badge.getAttribute('data-signature') === signature) continue
        badge.setAttribute('data-signature', signature)
        badge.textContent = text
        badge.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'justify-content:center',
          'box-sizing:border-box',
          `min-width:${narrow ? 16 : 18}px`,
          `height:${narrow ? 16 : 18}px`,
          'padding:0 5px',
          'border-radius:999px',
          'background:rgba(79,124,255,.72)',
          'color:#fff',
          'font-size:10px',
          'font-weight:650',
          'line-height:1',
          'pointer-events:none',
          narrow ? 'position:absolute' : 'margin-left:auto',
          narrow ? 'right:-4px' : 'flex:none',
          narrow ? 'top:-4px' : '',
        ].filter(Boolean).join(';')
        if (narrow) button.style.position = 'relative'
      }
    }

    function useUnreadTotal() {
      const [value, setValue] = React.useState(unreadTotalCache)
      React.useEffect(() => {
        unreadListeners.add(setValue)
        setValue(unreadTotalCache)
        return () => unreadListeners.delete(setValue)
      }, [])
      return value
    }

    /** 未读是面板仍然关闭时的唯一实时信号，所以入口自己轻量轮询，不依赖面板挂载。 */
    function useNavUnreadPolling() {
      const total = useUnreadTotal()
      useBadgePolling()
      React.useEffect(() => {
        syncNavUnreadBadge(total)
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
        const observer = new MutationObserver(() => syncNavUnreadBadge(total))
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [total])
      return total
    }

    /** composer 工具行左端的运行状态徽标：运行中/未读都为 0 时不占位。 */
    function SuperAgentBadge({ t, pluginCtx }) {
      const state = useBadgePolling()
      const [hover, setHover] = React.useState(false)
      const summary = badgeSummary(state)
      if (summary === null) return null
      const parts = badgeParts(t, summary)
      const label = `${t('badgeLabel')}: ${parts.join(' · ')}`
      return h(
        'button',
        {
          type: 'button',
          'data-super-agent-badge': '',
          'data-super-agent-badge-running': summary.running > 0 ? '' : undefined,
          title: t('badgeOpen'),
          'aria-label': label,
          onClick: () => { openSuperAgentPanel(pluginCtx) },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: hover ? { ...S.badge, ...S.badgeHover } : S.badge,
        },
        h('span', { 'data-super-agent-badge-dot': '', style: S.badgeDot }),
        h('span', { 'data-super-agent-badge-text': '', style: S.badgeText }, parts.join(' · ')),
      )
    }

    function SuperAgentIcon({ size = 18 }) {
      useNavUnreadPolling()
      return h(
        'span',
        { 'data-super-agent-nav-icon': '', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          h('circle', { cx: 12, cy: 5, r: 2.2 }),
          h('circle', { cx: 5, cy: 18, r: 2.2 }),
          h('circle', { cx: 19, cy: 18, r: 2.2 }),
          h('path', { d: 'M12 7.2v3.3M10.6 10.5h2.8M7 16.2l3.3-2.5M17 16.2l-3.3-2.5' }),
        ),
      )
    }

    /**
     * 顶部实例切换器：按钮显示当前实例 + 总未读；展开后每行是名称/未读，
     * 底部可以新建或重命名。表单保持在下拉内部，避免再叠一层模态。
     */
    function InstanceSwitcher({ t, instances, activeId, open, busy, onToggle, onSelect, onCreate, onRename }) {
      const buttonRef = React.useRef(null)
      const [mode, setMode] = React.useState('')
      const [name, setName] = React.useState('')
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const total = instances.reduce((sum, row) => sum + (Number(row.unread) || 0), 0)
      const active = instances.find((row) => row.id === activeId)
      const currentName = active?.name ?? t('title')

      React.useEffect(() => {
        if (!open) {
          setMode('')
          setName('')
          setError('')
          setSaving(false)
        }
      }, [open])

      const begin = (nextMode) => {
        setMode(nextMode)
        setName(nextMode === 'rename' ? currentName : '')
        setError('')
      }

      const submit = async (event) => {
        event?.preventDefault?.()
        if (saving) return
        const value = name.trim()
        if (value.length === 0) return
        setSaving(true)
        setError('')
        try {
          if (mode === 'create') await onCreate(value)
          else await onRename(value)
          setMode('')
          setName('')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { style: { position: 'relative', minWidth: 0 }, 'data-super-agent-instance-switcher': '' },
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'sa-instance-switcher',
            style: S.titleButton,
            onClick: onToggle,
            disabled: busy,
            title: t('instanceSwitch'),
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
          },
          h('span', { style: { fontSize: 14, fontWeight: 650, maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, currentName),
          h('span', {
            style: {
              display: 'inline-flex',
              color: T.textTertiary,
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform .15s ease',
            },
            'aria-hidden': 'true',
          }, h(Glyph, { name: 'chevronDown', size: 14, strokeWidth: 1.2 })),
          total > 0 ? h('span', { style: S.unreadBubble, title: t('instanceUnread', { count: total }) }, total > 99 ? '99+' : String(total)) : null,
        ),
        open
          ? h(
            'div',
            {
              style: S.instanceMenu,
              role: 'menu',
              'aria-label': t('instances'),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  onToggle()
                  buttonRef.current?.focus?.()
                }
              },
            },
            instances.length === 0
              ? h('div', { style: { ...S.instanceHint, padding: '8px 9px' } }, t('instanceEmpty'))
              : instances.map((row) => h(
                'button',
                {
                  key: row.id,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': row.id === activeId ? 'true' : 'false',
                  className: 'sa-instance-row',
                  'data-active': row.id === activeId ? 'true' : undefined,
                  style: S.instanceRow,
                  onClick: () => onSelect(row.id),
                  title: row.name,
                },
                h('span', { style: { width: 16, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: T.accent } },
                  row.id === activeId ? h(Glyph, { name: 'check', size: 14, strokeWidth: 1.4 }) : null),
                h('span', { style: S.instanceName }, row.name),
                Number(row.unread) > 0
                  ? h('span', { style: S.unreadBubble, title: t('instanceUnread', { count: row.unread }) }, row.unread > 99 ? '99+' : String(row.unread))
                  : null,
              )),
            mode === ''
              ? h(
                'div',
                { style: { ...S.instanceForm, flexDirection: 'row', justifyContent: 'space-between' } },
                h('button', { type: 'button', className: 'sa-menu-action', style: S.menuAction, onClick: () => begin('create') },
                  h(Glyph, { name: 'plus', size: 13, strokeWidth: 1.3 }),
                  t('instanceNew')),
                h('button', { type: 'button', className: 'sa-menu-action', style: S.menuAction, onClick: () => begin('rename'), disabled: active === undefined }, t('instanceRename')),
              )
              : h(
                'form',
                { style: S.instanceForm, onSubmit: submit },
                h('div', { style: { ...S.instanceHint, padding: '0 1px' } }, mode === 'create' ? t('instanceNew') : t('instanceRename')),
                h('input', {
                  autoFocus: true,
                  value: name,
                  maxLength: 40,
                  placeholder: t('instanceNamePlaceholder'),
                  'aria-label': t('instanceName'),
                  style: S.instanceInput,
                  onChange: (event) => setName(event.target.value),
                }),
                error.length > 0 ? h('div', { style: { ...S.instanceHint, color: '#dc5b5b' } }, error) : null,
                h(
                  'div',
                  { style: S.instanceFormRow },
                  h('button', { type: 'button', style: { ...S.button, padding: '5px 9px', fontSize: 11 }, onClick: () => setMode('') }, t('instanceCancel')),
                  h('button', { type: 'submit', style: { ...S.buttonPrimary, padding: '5px 10px', fontSize: 11 }, disabled: saving || name.trim().length === 0 }, saving ? t('instanceCreating') : (mode === 'create' ? t('instanceCreate') : t('instanceSave'))),
                ),
              ),
          )
          : null,
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
      resumable: { key: 'statusResumable', color: '#4caf72', rank: 4 },
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
        'data-active': selected ? 'true' : undefined,
        'aria-current': selected ? 'true' : undefined,
        style: {
          ...S.activityRow,
          width: '100%',
          border: 0,
          textAlign: 'left',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
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
        h('span', { className: 'sa-activity-chevron', style: S.activityChevron }, h(Glyph, { name: 'chevronRight', size: 14, strokeWidth: 1.2 })),
      )
    }

    const REPORT_LABEL = {
      completed: 'statusIdle',
      blocked: 'statusBlocked',
      failed: 'statusFailed',
      resumable: 'statusResumable',
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
            h('button', {
              type: 'button',
              className: 'sa-icon-button',
              style: S.iconButton,
              onClick: onBack,
              title: t('activityBack'),
              'aria-label': t('activityBack'),
            }, h(Glyph, { name: 'chevronLeft', size: 16, strokeWidth: 1.2 })),
            h('div', { style: S.detailTitle }, t('taskDetail')),
          ),
          h('div', { style: S.empty }, error || t('detailFailed', { reason: 'unknown' })),
        )
      }
      const meta = activityMeta(task.status)
      const reports = Array.isArray(task.reports) ? task.reports : []
      return h('div', { style: S.detailCard },
        h('div', { style: S.detailHeader },
          h('button', {
            type: 'button',
            className: 'sa-icon-button',
            style: S.iconButton,
            onClick: onBack,
            title: t('activityBack'),
            'aria-label': t('activityBack'),
          }, h(Glyph, { name: 'chevronLeft', size: 16, strokeWidth: 1.2 })),
          h('div', { style: S.detailTitle, title: task.title }, task.title),
          h('button', {
            type: 'button',
            className: 'sa-icon-button',
            style: S.iconButton,
            onClick: onBack,
            title: t('close'),
            'aria-label': t('close'),
          }, h(Glyph, { name: 'close', size: 16, strokeWidth: 1.1 })),
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
        h('div', { style: S.detailFooter, className: 'sa-detail-footer' },
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
                  className: 'sa-more-button',
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

    /**
     * 自绘下拉：原生下拉控件的弹出菜单在深色模式下仍可能是白底，
     * 且无法跟随 DSH token。这里只用一个按钮 + 固定定位菜单，颜色全部走 T。
     */
    function SelectMenu({ value, options, onChange, style, title, disabled = false, ariaLabel }) {
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(undefined)
      const rootRef = React.useRef(null)
      const buttonRef = React.useRef(null)
      const close = React.useCallback(() => setOpen(false), [])
      const show = React.useCallback(() => {
        if (disabled || typeof window === 'undefined') return
        const button = buttonRef.current
        if (!button) return
        const rect = button.getBoundingClientRect()
        const width = Math.max(rect.width, 180)
        const height = Math.min(280, options.length * 32 + 10)
        const below = rect.bottom + 4
        const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
        setPosition({ left, top, width })
        setOpen(true)
      }, [disabled, options.length])
      React.useEffect(() => {
        if (!open) return undefined
        const outside = (event) => {
          if (rootRef.current && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            buttonRef.current?.focus?.()
          }
        }
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', close)
        window.addEventListener('scroll', close, true)
        return () => {
          document.removeEventListener('pointerdown', outside)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', close)
          window.removeEventListener('scroll', close, true)
        }
      }, [open, close])
      const selected = options.find((option) => option.value === value)
      return h('div', { ref: rootRef, style: { position: 'relative', minWidth: 0, maxWidth: '100%' } },
        h('button', {
          ref: buttonRef,
          type: 'button',
          disabled,
          title,
          'aria-label': ariaLabel,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => { if (open) close(); else show() },
          style: {
            ...S.select,
            ...style,
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            textAlign: 'left',
            cursor: disabled ? 'default' : 'pointer',
          },
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected?.label ?? '—'),
          h('span', { style: { color: T.textTertiary, display: 'inline-flex', flex: '0 0 auto' } }, h(Glyph, { name: 'chevronDown', size: 14, strokeWidth: 1.2 })),
        ),
        open && position !== undefined
          ? h('div', {
              role: 'listbox',
              'data-super-agent-popup': 'true',
              style: {
                position: 'fixed',
                left: position.left,
                top: position.top,
                minWidth: position.width,
                maxWidth: `min(340px, calc(100vw - 16px))`,
                maxHeight: 280,
                overflowY: 'auto',
                zIndex: 1000,
                background: T.surface,
                color: T.text,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
                boxShadow: '0 12px 30px rgba(0,0,0,.28)',
                padding: 4,
              },
            },
            options.map((option) => h('button', {
              key: option.value,
              type: 'button',
              role: 'option',
              'aria-selected': option.value === value,
              disabled: option.disabled,
              onClick: () => {
                if (option.disabled) return
                onChange(option.value)
                close()
              },
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 8px',
                border: 0,
                borderRadius: 6,
                background: option.value === value ? `color-mix(in srgb, ${T.accent} 18%, transparent)` : 'transparent',
                color: option.disabled ? T.textTertiary : T.text,
                fontSize: 11.5,
                lineHeight: 1.35,
                cursor: option.disabled ? 'default' : 'pointer',
                whiteSpace: 'normal',
              },
            }, option.label)),
          )
          : null,
      )
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
      const filter = data?.filter ?? {}
      const filterDetail = [
        filter.provider ? `onlyProvider=${filter.provider}` : '',
        Array.isArray(filter.names) && filter.names.length > 0 ? `onlyNames=${filter.names.join(', ')}` : '',
      ].filter(Boolean).join(' · ')
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
        h('button', { type: 'button', style: S.button, disabled: saving || loading, title: t('modelsAllHint'), onClick: () => onSaveAll(draft.defaultId, draft.checked[draft.defaultId]?.defaultEffort) }, t('modelsAll')),
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
          data.filtered === true
            ? h('div', { style: { ...S.itemCard, display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' } },
                h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
                  h('div', { style: { fontSize: 11.5, fontWeight: 650 } }, format(t, 'modelsFilterTitle', { count: entries.length, total: data.catalogTotal ?? '?' })),
                  h('div', { style: { ...S.hint, margin: '4px 0 0' } }, format(t, 'modelsFilterDetail', { detail: filterDetail || '—' })),
                ),
                h('button', {
                  type: 'button',
                  style: S.button,
                  disabled: saving || loading,
                  title: t('modelsUseHostHint'),
                  onClick: () => onSaveAll(draft.defaultId, draft.checked[draft.defaultId]?.defaultEffort),
                }, t('modelsUseHost')),
              )
            : null,
          h('div', { style: { ...S.detailSection, marginTop: 12 } },
            h('div', { style: S.detailSectionTitle }, t('modelsDefault')),
            h('div', { style: S.row },
              h(SelectMenu, {
                style: { minWidth: 190, maxWidth: 280 },
                value: draft.defaultId,
                options: entries.filter((entry) => draft.checked[entry.key]?.on).map((entry) => ({ value: entry.key, label: `${entry.name} · ${entry.providerName}` })),
                onChange: (next) => setDraft((current) => ({ ...current, defaultId: next })),
                ariaLabel: t('modelsDefault'),
              }),
              defaultEfforts.length > 0
                ? h(SelectMenu, {
                    value: draft.checked[draft.defaultId]?.defaultEffort ?? '',
                    options: defaultEfforts.map((effort) => ({ value: effort.id, label: effort.name })),
                    onChange: (next) => update(draft.defaultId, { defaultEffort: next }),
                    title: t('modelsEffort'),
                    ariaLabel: t('modelsEffort'),
                  })
                : null,
            ),
          ),
          h('div', { style: S.detailSection },
            h('div', { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 } },
              h('div', { style: { ...S.detailSectionTitle, marginBottom: 0 } }, t('modelsAllowlist')),
              h('span', { style: { ...S.badge, opacity: 0.9 } }, format(t, 'modelsSelected', { count: selectedKeys.length })),
            ),
            h('div', { style: { ...S.hint, margin: '0 0 8px' } }, t('modelsToggleHint')),
            entries.length === 0 ? h('div', { style: S.empty }, t('modelsEmpty')) : null,
            entries.map((entry) => {
              const choice = draft.checked[entry.key] ?? { on: false, efforts: [] }
              return h('div', { key: entry.key, style: { ...S.checkboxRow, alignItems: 'flex-start' } },
                h('button', {
                  type: 'button',
                  role: 'checkbox',
                  'aria-checked': choice.on === true,
                  'aria-label': entry.name,
                  onClick: () => toggleModel(entry),
                  style: {
                    flex: '0 0 auto',
                    marginTop: 2,
                    width: 16,
                    height: 16,
                    padding: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 4,
                    border: `1px solid ${choice.on ? T.accent : T.border}`,
                    background: choice.on ? T.accent : 'transparent',
                    color: '#fff',
                    fontSize: 10,
                    lineHeight: 1,
                    cursor: 'pointer',
                  },
                }, choice.on ? h(Glyph, { name: 'check', size: 12, strokeWidth: 1.6 }) : null),
                h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                  // 第一行只放模型名和启用状态；来源单独一行、字号更小，
                  // 避免 provider/model 把长模型名挤成多行。
                  h('div', {
                    onClick: () => toggleModel(entry),
                    style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: 'pointer' },
                  },
                    h('span', {
                      title: entry.name,
                      style: { fontSize: 11.5, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    }, `${entry.name}`),
                    h('span', { style: { ...S.badge, flex: '0 0 auto', marginLeft: 'auto', color: choice.on ? T.accent : T.textTertiary } }, choice.on ? t('modelsEnabled') : t('modelsDisabled')),
                  ),
                  h('div', {
                    title: `${entry.providerName}/${entry.model}`,
                    style: { fontSize: 10, lineHeight: 1.35, color: T.textTertiary, marginTop: 2, overflowWrap: 'anywhere' },
                  }, `${entry.providerName}/${entry.model}`),
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
              h(SelectMenu, {
                style: { minWidth: 150 },
                value: draft.project ?? '',
                options: [{ value: '', label: t('rulesGlobal') }, ...projects.map((project) => ({ value: project.path ?? '', label: project.title ?? project.path }))],
                onChange: (next) => setDraft({ ...draft, project: next }),
                ariaLabel: t('rulesProjectField'),
              }),
            ),
            h(Field, { label: t('rulesModeField') },
              h(SelectMenu, {
                value: draft.mode ?? 'append',
                options: [{ value: 'append', label: t('rulesModeAppend') }, { value: 'replace', label: t('rulesModeReplace') }],
                onChange: (next) => setDraft({ ...draft, mode: next }),
                ariaLabel: t('rulesModeField'),
              }),
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
                h(SelectMenu, {
                  value: draft.kind,
                  options: [
                    { value: 'after', label: t('schedulesAfter') },
                    { value: 'daily', label: t('schedulesDaily') },
                    { value: 'weekly', label: t('schedulesWeekly') },
                    { value: 'cron', label: t('schedulesCron') },
                    { value: 'at', label: t('schedulesAt') },
                  ],
                  onChange: (next) => set({ kind: next }),
                  ariaLabel: t('schedulesWhen'),
                }),
              ),
              draft.kind === 'after'
                ? h(Field, { label: t('schedulesAfter') }, h('input', { type: 'number', min: 1, style: { ...S.input, width: 90 }, value: draft.minutes, onChange: (event) => set({ minutes: event.target.value }) }))
                : null,
              draft.kind === 'daily' || draft.kind === 'weekly'
                ? h(Field, { label: t('schedulesTime') }, h('input', { type: 'time', style: { ...S.input, width: 110 }, value: draft.time, onChange: (event) => set({ time: event.target.value }) }))
                : null,
              draft.kind === 'weekly'
                ? h(Field, { label: t('schedulesWeekday') },
                    h(SelectMenu, {
                      value: draft.weekday,
                      options: WEEKDAYS.map((day) => ({ value: String(day), label: t(`weekday${day}`) })),
                      onChange: (next) => set({ weekday: next }),
                      ariaLabel: t('schedulesWeekday'),
                    }),
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
      const [instanceId, setInstanceId] = React.useState(() => {
        try {
          const saved = window.localStorage.getItem('dsh.super-agent.instance')
          return typeof saved === 'string' ? saved : ''
        } catch {
          return ''
        }
      })
      // 重挂时先按内存里的续接值渲染同一条 Router，再等宿主快照确认；
      // 这样不会先闪一帧「新会话」落地页。
      const [sessionId, setSessionId] = React.useState(() => cachedPanelSession(instanceId))
      const [instances, setInstances] = React.useState([])
      const [instanceOpen, setInstanceOpen] = React.useState(false)
      const [instanceBusy, setInstanceBusy] = React.useState(false)
      const [routerSessionIds, setRouterSessionIds] = React.useState([])
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
      // 预览标签：{ tabs: [{ id, plan }], activeId }。一个文件一个标签，空数组 = 列收起。
      const [preview, setPreview] = React.useState({ tabs: [], activeId: '' })
      /** 用户拖出来的预览列宽；undefined = 按面板宽度自适应（640 / 480）。 */
      const [previewWidth, setPreviewWidth] = React.useState(undefined)
      const [panelWidth, setPanelWidth] = React.useState(0)
      const rootRef = React.useRef(null)
      const [revealRequest, setRevealRequest] = React.useState(undefined)
      const [navNotice, setNavNotice] = React.useState(undefined)
      // 自动跟随通知的当前状态（默认关）；顶部那枚「跟随：关/开」按钮就是它的开关。
      const [navFollowOn, setNavFollowOn] = React.useState(() => navFollowEnabled())
      /** 切换自动跟随：写 localStorage，并让顶部按钮和提示条立刻反映。 */
      const applyNavFollow = (enabled) => {
        setNavFollowOn(setNavFollow(enabled))
      }
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
      /** 最近一次「用户点了通知」的时刻：挂载快照不能覆盖用户的明确选择（见下）。 */
      const lastRevealAt = React.useRef(0)
      const mounted = React.useRef(true)
      const instanceRef = React.useRef(instanceId)
      const detailRequest = React.useRef('')
      const modelsAttempted = React.useRef(false)

      React.useEffect(() => { instanceRef.current = instanceId }, [instanceId])
      React.useEffect(() => () => { mounted.current = false }, [])

      /** 所有会话切换的唯一入口（见 sessionTransition）：事件回调不走这里。 */
      const adoptSession = React.useCallback((event) => {
        setSessionId((current) => sessionTransition(current, event))
      }, [])

      // 记住这条会话，供下一次重挂续接（内存级，不持久化）。
      React.useEffect(() => {
        rememberPanelSession(instanceRef.current.length > 0 ? instanceRef.current : instanceId, sessionId)
      }, [sessionId, instanceId])

      // 面板挂载期间接管「右侧栏没有会话表面」时的文件链接；卸载即摘掉接收器，
      // 桥随后退回官方实现（见 bridgeFileOpens）。
      // 同一个文件再次点开只激活已有标签（previewTabsAdd 负责去重）。
      React.useEffect(() => {
        const sink = (plan) => setPreview((state) => previewTabsAdd(state.tabs, plan))
        filePreviewSink = sink
        return () => {
          if (filePreviewSink === sink) filePreviewSink = undefined
        }
      }, [])

      // 预览列宽按面板宽度自适应：< 1000px 时 640 → 480，并给对话区留最小宽度。
      React.useEffect(() => {
        const element = rootRef.current
        if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return undefined
        const measure = () => {
          const width = element.getBoundingClientRect().width
          if (Number.isFinite(width) && width > 0) setPanelWidth(width)
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      // 通知点击：away-notify 的 showSession 在 selectPanel 之后同步调用，请求可能
      // 早于本组件挂载，所以先取一次队列（见 requestPanelReveal）。
      React.useEffect(() => {
        const sink = (request) => setRevealRequest(request)
        panelRevealSink = sink
        const queued = takePanelReveal()
        if (queued !== undefined) setRevealRequest(queued)
        return () => {
          if (panelRevealSink === sink) panelRevealSink = undefined
        }
      }, [])

      // 导航诊断：会话/实例变化连同调用栈记一笔（navdebug 关闭时是空操作）。
      React.useEffect(() => {
        navLog('session', {
          sessionId: sessionId.length > 0 ? sessionId : null,
          instanceId: instanceId.length > 0 ? instanceId : null,
          routerSessionId: typeof routerInfo?.sessionId === 'string' ? routerInfo.sessionId : null,
        })
      }, [sessionId, instanceId, routerInfo?.sessionId])

      // 页面可见性/面板卸载决定新回复算不算未读；read=true 表示用户此刻看得到。
      // `visible` 与 `read` 都来自同一个 `panelVisibleNow()`：宿主那边也是同一个
      // 判定（attendance.js 的 replyEffect），不存在“两套可见性”漂移。
      React.useEffect(() => {
        if (instanceId.length === 0) return undefined
        const report = (options = {}) => {
          if (instanceRef.current !== instanceId) return
          const visible = panelVisibleNow()
          void fetch(ROUTES.instanceActive, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              instance_id: instanceId,
              panel: true,
              visible,
              read: typeof options.read === 'boolean' ? options.read : visible,
            }),
          }).then(async (response) => {
            if (!response.ok) return
            const payload = await response.json().catch(() => undefined)
            if (payload?.ok && typeof payload.unreadTotal === 'number') publishUnread(payload.unreadTotal)
          }).catch(() => undefined)
        }
        report()
        const onVisibility = () => report()
        // 窗口失焦（另一个窗口在前台）后回来：补一次上报，顺带清掉这期间可能
        // 落下的计数——“在面板里但失去焦点又回来”不该留下未读。
        const onFocus = () => report({ read: panelVisibleNow() })
        const leaveBody = JSON.stringify({ instance_id: instanceId, panel: false, visible: false })
        const onPageHide = () => {
          if (instanceRef.current !== instanceId) return
          try {
            if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
              navigator.sendBeacon(ROUTES.instanceActive, new Blob([leaveBody], { type: 'application/json' }))
              return
            }
          } catch {
            // 回退到 keepalive fetch。
          }
          void fetch(ROUTES.instanceActive, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: leaveBody,
            keepalive: true,
          }).catch(() => undefined)
        }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', onFocus)
        window.addEventListener('pageshow', onFocus)
        window.addEventListener('pagehide', onPageHide)
        // 面板心跳让宿主区分“浏览器崩了/标签页直接关闭”和“用户还看着”；
        // 可见时同时发 read=true，让任何瞬时误计数在 15 秒内自愈。
        const heartbeat = setInterval(() => report(), 15_000)
        return () => {
          clearInterval(heartbeat)
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('pageshow', onFocus)
          window.removeEventListener('pagehide', onPageHide)
          if (instanceRef.current !== instanceId) return
          void fetch(ROUTES.instanceActive, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: leaveBody,
            keepalive: true,
          }).catch(() => undefined)
        }
      }, [instanceId])

      React.useEffect(() => {
        if (!instanceOpen || typeof document === 'undefined') return undefined
        const close = (event) => {
          if (event.target?.closest?.('[data-super-agent-instance-switcher]')) return
          setInstanceOpen(false)
        }
        document.addEventListener('mousedown', close, true)
        return () => document.removeEventListener('mousedown', close, true)
      }, [instanceOpen])

      /**
       * 读一次宿主状态。
       *
       * `adopt: true` 只在面板挂载时用：宿主要是有活着的 Router，就沿用它，而不是
       * 为了“打开面板”再 ensure 一条新会话。轮询永不 adopt——当前会话只由用户动作
       * 或这一次挂载快照改变。
       */
      const fetchState = React.useCallback(async (options = {}) => {
        try {
          const response = await fetch(ROUTES.state, { credentials: 'same-origin' })
          const payload = await response.json()
          if (!mounted.current) return undefined
          if (typeof payload?.activeInstanceId === 'string' && instanceRef.current.length > 0 && payload.activeInstanceId !== instanceRef.current) return undefined
          if (Array.isArray(payload?.instances)) setInstances(payload.instances)
          if (Array.isArray(payload?.routerSessionIds)) setRouterSessionIds(payload.routerSessionIds)
          if (typeof payload?.unreadTotal === 'number') publishUnread(payload.unreadTotal)
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
          if (options.adopt === true) {
            const live = payload?.ok && payload.router !== null && typeof payload.router === 'object' ? payload.router : undefined
            if (typeof live?.sessionId === 'string' && live.sessionId.length > 0) {
              if (instanceRef.current.length === 0 && typeof payload?.activeInstanceId === 'string' && payload.activeInstanceId.length > 0) {
                instanceRef.current = payload.activeInstanceId
                setInstanceId(payload.activeInstanceId)
                try { window.localStorage.setItem('dsh.super-agent.instance', payload.activeInstanceId) } catch { /* 隐私模式 */ }
              }
              return live.sessionId
            }
          }
        } catch {
          // 轮询失败不打断对话；下一次再试。
        }
        return undefined
      }, [t])

      const ensure = React.useCallback(async (requestedId) => {
        setBusy(true)
        setError('')
        try {
          // 不传 cwd：宿主按实例 home 恢复 Router。项目选择属于 Router，不属于 UI。
          const targetId = typeof requestedId === 'string' ? requestedId : instanceRef.current
          const { response, payload } = await postJson(ROUTES.ensure, targetId.length > 0 ? { instance_id: targetId } : {})
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (!mounted.current) return
          const info = payload.router ?? {
            sessionId: payload.sessionId,
            instanceId: payload.instanceId,
            projectRoot: payload.projectRoot,
            status: payload.status,
          }
          if (typeof payload.instanceId === 'string' && payload.instanceId.length > 0) {
            setInstanceId(payload.instanceId)
            instanceRef.current = payload.instanceId
            try { window.localStorage.setItem('dsh.super-agent.instance', payload.instanceId) } catch { /* 隐私模式 */ }
          }
          if (Array.isArray(payload.instances)) setInstances(payload.instances)
          if (Array.isArray(payload.routerSessionIds)) setRouterSessionIds(payload.routerSessionIds)
          if (typeof payload.unreadTotal === 'number') publishUnread(payload.unreadTotal)
          setRouterInfo(info)
          adoptSession({ kind: 'user', sessionId: payload.sessionId })
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

      /** 切换实例：先告诉宿主活跃/可见（并清空该实例未读），再确保它的 Router。 */
      const switchInstance = React.useCallback(async (nextId) => {
        if (typeof nextId !== 'string' || nextId.length === 0) return
        setInstanceOpen(false)
        setInstanceBusy(true)
        setError('')
        try {
          const active = await postJson(ROUTES.instanceActive, {
            instance_id: nextId,
            panel: true,
            visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
            read: true,
          })
          if (active.response.ok && active.payload?.ok === true) {
            if (Array.isArray(active.payload.instances)) setInstances(active.payload.instances)
            if (typeof active.payload.unreadTotal === 'number') publishUnread(active.payload.unreadTotal)
          }
          instanceRef.current = nextId
          setInstanceId(nextId)
          try { window.localStorage.setItem('dsh.super-agent.instance', nextId) } catch { /* 隐私模式 */ }
          attempted.current = true
          adoptSession({ kind: 'user', sessionId: '' })
          setRouterInfo(null)
          setWorkspaceSessions([])
          setRouterSessionIds([])
          setStatusLine('')
          setActivityFull(undefined)
          attempted.current = true
          await ensure(nextId)
        } catch (cause) {
          if (mounted.current) setError(format(t, 'instanceSwitchFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setInstanceBusy(false)
        }
      }, [ensure, t])

      const createInstance = React.useCallback(async (name) => {
        setInstanceBusy(true)
        try {
          const { response, payload } = await postJson(ROUTES.instances, { name })
          if (!response.ok || payload?.ok !== true) {
            throw new Error(format(t, 'instanceCreateFailed', { reason: payload?.error ?? `HTTP ${response.status}` }))
          }
          if (Array.isArray(payload.instances)) setInstances(payload.instances)
          if (payload.instance?.id !== undefined) await switchInstance(payload.instance.id)
        } finally {
          if (mounted.current) setInstanceBusy(false)
        }
      }, [switchInstance, t])

      const renameInstance = React.useCallback(async (name) => {
        const target = instanceRef.current
        if (target.length === 0) return
        setInstanceBusy(true)
        try {
          const { response, payload } = await postJson(ROUTES.instanceRename, { instance_id: target, name })
          if (!response.ok || payload?.ok !== true) {
            throw new Error(format(t, 'instanceRenameFailed', { reason: payload?.error ?? `HTTP ${response.status}` }))
          }
          if (Array.isArray(payload.instances)) setInstances(payload.instances)
        } finally {
          if (mounted.current) setInstanceBusy(false)
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
          adoptSession({ kind: 'user', sessionId: payload.sessionId })
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

      /**
       * 执行一次定位：切实例 + adopt 会话（通知点击与提示里的「定位」按钮共用）。
       *
       * 认不出的会话不 adopt——那会把面板落到一条空会话上；改为给一条可见提示，
       * 会话若还在左侧列表里，用户仍能点开。
       */
      const applyReveal = React.useCallback(async (request) => {
        if (request === undefined) return
        const previous = { instanceId: instanceRef.current, sessionId }
        const target = typeof request.instanceId === 'string' && request.instanceId.length > 0
          ? request.instanceId
          : undefined
        if (target !== undefined && target !== instanceRef.current) {
          lastRevealAt.current = Date.now()
          navLog('reveal.apply', { sessionId: request.sessionId, instanceId: target, switched: true })
          await switchInstance(target)
          if (!mounted.current) return
          // 切换失败（宿主拒绝/HTTP 错）时 `switchInstance` 只设置 error、不抛：
          // 这时绝不能把另一个实例的会话 adopt 进来，明确提示用户。
          if (instanceRef.current !== target) {
            navLog('reveal.switch.failed', { sessionId: request.sessionId, instanceId: target })
            setNavNotice({ kind: 'failed', sessionId: request.sessionId, instanceId: target, previous })
            return
          }
        }
        lastRevealAt.current = Date.now()
        if (target !== undefined || routerSessionIds.includes(request.sessionId)) {
          adoptSession({ kind: 'user', sessionId: request.sessionId })
          navLog('reveal.adopt', { sessionId: request.sessionId, instanceId: target ?? instanceRef.current })
          setNavNotice({ kind: 'located', sessionId: request.sessionId, instanceId: target, previous })
          return
        }
        navLog('reveal.unknown', { sessionId: request.sessionId })
        setNavNotice({ kind: 'unknown', sessionId: request.sessionId, instanceId: undefined, previous })
      }, [adoptSession, switchInstance, routerSessionIds, sessionId])

      // 通知点击的落点。`showSession` 的语义是「定位」，所以即使已经在目标实例/会话
      // 也照常执行；关了自动跟随（见 navFollowEnabled）就只提示、由用户点「定位」。
      React.useEffect(() => {
        if (revealRequest === undefined) return
        const request = revealRequest
        setRevealRequest(undefined)
        if (!navFollowEnabled()) {
          navLog('reveal.offer', { sessionId: request.sessionId, instanceId: request.instanceId ?? null })
          setNavNotice({
            kind: 'offer',
            sessionId: request.sessionId,
            instanceId: request.instanceId,
            previous: { instanceId: instanceRef.current, sessionId },
          })
          return
        }
        void applyReveal(request)
      }, [revealRequest, applyReveal])

      // 通知提示 15 秒后自动收起，避免长期占着面板顶部。
      React.useEffect(() => {
        if (navNotice === undefined) return undefined
        const timer = setTimeout(() => setNavNotice(undefined), 15000)
        return () => clearTimeout(timer)
      }, [navNotice])

      // 抽屉按需加载，避免面板一打开就打一堆接口。
      React.useEffect(() => {
        if (drawer === 'models' && modelsData === undefined) void loadModels(true)
        if (drawer === 'rules' && rulesData === undefined) void loadRules()
        if (drawer === 'schedules' && schedulesData === undefined) void loadSchedules()
        if (drawer === 'activity' && activityFull === undefined) void loadActivityFull()
      }, [drawer, modelsData, rulesData, schedulesData, activityFull, loadModels, loadRules, loadSchedules, loadActivityFull])

      // 打开面板只做一次“接管”：宿主已有活着的 Router 就沿用（bootstrap），
      // 没有才 ensure。重挂（切面板 / HMR / 布局重排）不会新建会话，也不会
      // 先落到「新会话」落地页。
      React.useEffect(() => {
        if (attempted.current) return undefined
        attempted.current = true
        void (async () => {
          const live = await fetchState({ adopt: true })
          if (!mounted.current) return
          if (typeof live === 'string' && live.length > 0) {
            // 刚点过通知就不要再被挂载快照盖回去（两者都是异步的，谁后到谁生效）。
            if (Date.now() - lastRevealAt.current < 5000) return
            adoptSession({ kind: 'bootstrap', sessionId: live })
            return
          }
          await ensure()
        })()
        return undefined
      }, [adoptSession, ensure, fetchState])

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
      const workerSessionId = typeof detail?.workerSessionId === 'string' ? detail.workerSessionId : ''
      const workerChatAvailable = workerSessionId.length > 0
      const workerSessionIds = [...new Set(tasks
        .map((task) => task?.workerSessionId)
        .filter((id) => typeof id === 'string' && id.length > 0))]
      const hiddenSessionIds = [...new Set([
        ...workerSessionIds,
        ...routerSessionIds.filter((id) => typeof id === 'string' && id !== sessionId),
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
          // 前面可能 await 过 unarchive：手势窗口不一定还在，显式授权这次导航。
          authorizeNavigation()
          workspace.openSession(workerSessionId)
          setDetailId('')
          setDetail(undefined)
        } catch {
          setStatusLine(t('openChatFailed'))
        }
      }

      /** 实例 id → 展示名（通知提示用；未知名直接显示 id）。 */
      const navInstanceName = (id) => {
        const row = instances.find((candidate) => candidate?.id === id)
        return typeof row?.name === 'string' && row.name.length > 0 ? row.name : id
      }
      const navNoticeText = navNotice === undefined
        ? ''
        : navNotice.kind === 'unknown'
          ? format(t, 'navUnknown', { session: String(navNotice.sessionId).slice(-12) })
          : navNotice.kind === 'failed'
            ? format(t, 'navSwitchFailed', { instance: navInstanceName(navNotice.instanceId) })
            : navNotice.kind === 'offer'
              ? navNotice.instanceId !== undefined
                ? format(t, 'navOffer', { instance: navInstanceName(navNotice.instanceId) })
                : t('navOfferHere')
              : navNotice.instanceId !== undefined
                ? format(t, 'navLocated', { instance: navInstanceName(navNotice.instanceId) })
                : t('navLocatedHere')
      /** 「返回」：撤回这次通知导航（只改选择，不动任何会话内容）。 */
      const undoNav = () => {
        const notice = navNotice
        setNavNotice(undefined)
        if (notice === undefined || notice.previous === undefined) return
        const previous = notice.previous
        void (async () => {
          if (previous.instanceId.length > 0 && previous.instanceId !== instanceRef.current) {
            await switchInstance(previous.instanceId)
            if (!mounted.current) return
          }
          if (previous.sessionId.length > 0) adoptSession({ kind: 'user', sessionId: previous.sessionId })
        })()
      }

      const headerStatus = resetConfirm && hasSession ? t('resetNote') : (statusLine || t('noRouter'))
      const previewOpen = preview.tabs.length > 0
      const previewColumns = previewWidthFor(panelWidth, previewWidth)
      return h('div', {
        ref: rootRef,
        style: S.root,
        className: 'sa-root',
        'data-super-agent-panel': '',
        'data-preview': previewOpen ? 'true' : undefined,
      },
        h('style', {}, `
          ${hiddenCss}
          @keyframes saPulse { 0% { opacity: .45; transform: scale(.85); } 70% { opacity: 1; transform: scale(1); } 100% { opacity: .45; transform: scale(.85); } }
          .sa-pulse { animation: saPulse 1.6s ease-in-out infinite; }
          /* 所有可点控件的 hover / active / focus 都使用 DSH 的 alias token，
             与系统自带的菜单、图标按钮、ghost button 保持同一套反馈。 */
          .sa-instance-switcher, .sa-header-action, .sa-icon-button, .sa-instance-row,
          .sa-menu-action, .sa-activity-row, .sa-more-button {
            background: transparent;
            border: 0;
          }
          .sa-instance-switcher {
            color: var(--dsw-alias-label-primary);
            transition: background-color .1s ease, color .1s ease;
          }
          .sa-instance-switcher:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
          .sa-instance-switcher:active:not(:disabled),
          .sa-instance-switcher[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
          .sa-header-action {
            color: var(--dsw-alias-label-secondary);
            transition: background-color .1s ease, color .1s ease;
          }
          .sa-header-action:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
            color: var(--dsw-alias-label-primary);
          }
          .sa-header-action:active:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16));
          }
          .sa-header-action[data-danger="true"] { color: var(--dsw-alias-state-error-primary, #d95c5c); }
          .sa-header-action[data-danger="true"]:hover:not(:disabled) {
            background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d95c5c) 10%, transparent);
            color: var(--dsw-alias-state-error-primary, #d95c5c);
          }
          .sa-header-action:disabled, .sa-instance-switcher:disabled { opacity: .42; cursor: default; }
          .sa-instance-switcher:focus-visible, .sa-header-action:focus-visible,
          .sa-icon-button:focus-visible, .sa-instance-row:focus-visible,
          .sa-activity-row:focus-visible, .sa-menu-action:focus-visible, .sa-more-button:focus-visible {
            outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4f7cff);
            outline-offset: 1px;
          }
          .sa-status[data-danger="true"] { color: var(--dsw-alias-state-error-primary, #d95c5c); }
          .sa-icon-button {
            color: var(--dsw-alias-label-secondary);
            transition: background-color .1s ease, color .1s ease;
          }
          .sa-icon-button:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
            color: var(--dsw-alias-label-primary);
          }
          .sa-icon-button:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
          .sa-instance-row {
            transition: background-color .1s ease;
          }
          .sa-instance-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
          .sa-instance-row[data-active="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
          .sa-menu-action {
            color: var(--dsw-alias-label-secondary);
            transition: background-color .1s ease, color .1s ease;
          }
          .sa-menu-action:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
            color: var(--dsw-alias-label-primary);
          }
          .sa-menu-action:disabled { opacity: .42; cursor: default; }
          .sa-activity-row {
            transition: background-color .1s ease;
          }
          .sa-activity-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
          .sa-activity-row[data-active="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
          .sa-activity-chevron { opacity: 0; transition: opacity .1s ease; }
          .sa-activity-row:hover .sa-activity-chevron,
          .sa-activity-row[data-active="true"] .sa-activity-chevron { opacity: .72; }
          .sa-more-button {
            color: var(--dsw-alias-label-tertiary);
            transition: background-color .1s ease, color .1s ease;
          }
          .sa-more-button:hover {
            background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
            color: var(--dsw-alias-label-secondary);
          }
          .sa-detail-footer button { transition: filter .1s ease; }
          .sa-detail-footer button:hover:not(:disabled) { filter: brightness(1.08); }
          /* 空白会话没有官方 viewArea，composer 会粘在顶部；空 slot 时用
             auto margin 把它放回底部，和已有消息的会话保持一致。 */
          .sa-conversation [data-conversation-scroll] > [data-slot="conversation.session"]:empty + [data-composer-seat] {
            margin-top: auto;
          }
          .sa-activity-toggle { display: none !important; }
          /* 预览列打开时活动栏已经不再渲染（少一层 292px），这里再兜一层：
             任何残留的 rail 都不许和预览列抢宽度。 */
          .sa-root[data-preview="true"] .sa-rail-wrap { display: none !important; }
          /* 预览标签栏：横向滚动、悬停反馈、活动标签高亮。 */
          .sa-preview-tabs::-webkit-scrollbar { height: 6px; }
          .sa-preview-tabs::-webkit-scrollbar-thumb {
            background: var(--dsw-alias-border-l3, rgba(127,127,127,.32));
            border-radius: 999px;
          }
          .sa-preview-tabs::-webkit-scrollbar-track { background: transparent; }
          .sa-preview-tab { transition: background-color .12s ease, color .12s ease; }
          .sa-preview-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
          .sa-preview-tab[aria-selected="true"]:hover { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
          .sa-preview-tab-close:hover { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.18)); }
          .sa-preview-resizer:hover,
          .sa-preview-resizer:focus-visible {
            background: var(--dsw-alias-border-l3, rgba(127,127,127,.36));
          }
          @media (max-width: 1180px) {
            .sa-status, .sa-header-sep { display: none !important; }
          }
          @media (max-width: 1000px) {
            .sa-rail-wrap { display: none !important; }
            .sa-activity-toggle { display: inline-flex !important; }
          }
          @media (max-width: 860px) {
            .sa-header { gap: 2px !important; padding-left: 10px !important; padding-right: 10px !important; }
            .sa-header-action { padding-left: 6px !important; padding-right: 6px !important; }
          }
          @media (prefers-reduced-motion: reduce) {
            .sa-instance-switcher, .sa-header-action, .sa-icon-button, .sa-instance-row,
            .sa-menu-action, .sa-activity-row, .sa-activity-chevron, .sa-more-button { transition: none !important; }
          }
        `),
        h('div', { style: S.header, className: 'sa-header' },
          h('div', { style: S.titleBlock, className: 'sa-title-block' },
            h(InstanceSwitcher, {
              t,
              instances,
              activeId: instanceId,
              open: instanceOpen,
              busy: busy || instanceBusy,
              onToggle: () => setInstanceOpen((value) => !value),
              onSelect: (id) => { void switchInstance(id) },
              onCreate: createInstance,
              onRename: renameInstance,
            }),
          ),
          h('span', {
            style: S.status,
            className: 'sa-status',
            title: headerStatus,
            'data-danger': resetConfirm && hasSession ? 'true' : undefined,
          },
            h('span', { style: { ...S.dot, background: routerInfo ? '#4caf72' : 'rgba(127,127,127,.55)' }, 'aria-hidden': 'true' }),
            h('span', { style: S.statusText }, headerStatus),
          ),
          h('span', { className: 'sa-header-sep', style: S.headerSeparator, 'aria-hidden': 'true' }),
          h('button', {
            type: 'button',
            className: 'sa-header-action sa-nav-follow',
            style: S.headerAction,
            'data-on': navFollowOn ? 'true' : undefined,
            'aria-pressed': navFollowOn ? 'true' : 'false',
            title: navFollowOn ? t('navFollowOnHint') : t('navFollowOffHint'),
            onClick: () => applyNavFollow(!navFollowOn),
          }, navFollowOn ? t('navFollowOn') : t('navFollowOff')),
          h('button', { type: 'button', className: 'sa-header-action sa-header-settings', style: S.headerAction, onClick: () => setDrawer('models'), title: t('modelsTitle') }, t('models')),
          h('button', { type: 'button', className: 'sa-header-action sa-header-settings', style: S.headerAction, onClick: () => setDrawer('rules') }, t('rules')),
          h('button', { type: 'button', className: 'sa-header-action sa-header-settings', style: S.headerAction, onClick: () => setDrawer('schedules') }, t('schedules')),
          h('button', {
            type: 'button',
            className: 'sa-header-action sa-activity-toggle',
            style: { ...S.headerAction, display: 'none' },
            onClick: () => setDrawer('activity'),
            title: t('activityTitle'),
          }, t('drawerActivity')),
          h('div', { style: S.spacer }),
          h('button', {
            type: 'button',
            className: 'sa-header-action',
            style: S.headerAction,
            disabled: busy,
            onClick: retry,
          }, busy ? t('loading') : t('refresh')),
          h('button', {
            type: 'button',
            className: 'sa-header-action',
            style: S.headerAction,
            'data-danger': resetConfirm && hasSession ? 'true' : undefined,
            disabled: busy || resetting || !hasSession,
            title: t('resetNote'),
            onClick: reset,
          }, resetting ? t('resetting') : resetConfirm ? t('resetConfirm') : t('reset')),
          openSessionAvailable
            ? h('button', {
                type: 'button',
                className: 'sa-header-action',
                style: S.headerAction,
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
        error.length > 0
          ? h('div', { style: S.error }, h('strong', {}, `${t('error')}: `), error)
          : null,
        navNotice === undefined
          ? null
          : h('div', { style: S.navNotice },
              h('span', { style: S.navNoticeText }, navNoticeText),
              navNotice.kind === 'offer'
                ? h('button', {
                    type: 'button',
                    style: S.smallButton,
                    onClick: () => {
                      const notice = navNotice
                      setNavNotice(undefined)
                      void applyReveal({ sessionId: notice.sessionId, instanceId: notice.instanceId })
                    },
                  }, t('navLocate'))
                : null,
              navNotice.kind === 'located' && navNotice.previous !== undefined
                ? h('button', { type: 'button', style: S.smallButton, onClick: undoNav }, t('navBack'))
                : null,
              navNotice.kind === 'offer'
                ? h('button', { type: 'button', style: S.smallButton, onClick: () => { applyNavFollow(true); setNavNotice(undefined) } }, t('navAlways'))
                : navNotice.kind === 'located'
                  ? h('button', { type: 'button', style: S.smallButton, onClick: () => { applyNavFollow(false); setNavNotice(undefined) } }, t('navNever'))
                  : null,
              h('button', { type: 'button', style: S.smallButton, onClick: () => setNavNotice(undefined) }, t('navDismiss')),
            ),
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
                    : h('div', { style: S.conversation, className: 'sa-conversation' },
                      h(SessionProvider, { session: reference }, renderSlot(CONVERSATION_SLOT, {})),
                    ),
          ),
          // 预览打开时让出活动栏：面板宽 1176 时「对话 + 292 活动栏 + 640 预览」
          // 会把对话区挤到 244px。预览优先，活动栏在预览关闭后回来。
          previewOpen
            ? null
            : h(ActivityRail, {
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
          // 预览列：一个文件一个标签，点新文件只追加+激活，不关已有标签；
          // 宽度按面板宽度自适应（<1000 → 480），左缘可拖拽。
          previewOpen
            ? h(PreviewColumn, {
                t,
                tabs: preview.tabs,
                activeId: preview.activeId,
                width: previewColumns,
                sessionId,
                pluginCtx,
                onActivate: (id) => setPreview((state) => (
                  state.tabs.some((tab) => tab.id === id) ? { tabs: state.tabs, activeId: id } : state
                )),
                onCloseTab: (id) => setPreview((state) => previewTabsClose(state.tabs, state.activeId, id)),
                onClose: () => setPreview({ tabs: [], activeId: '' }),
                onResize: (next) => setPreviewWidth(previewWidthFor(panelWidth, next)),
              })
            : null,
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
              onSaveAll: (defaultId, defaultEffort) => { void saveModels({ allowed: [], default: defaultId, ...(defaultEffort ? { defaultEffort } : {}), onlyProvider: '', onlyNames: [] }) },
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

    // ── 导航：通知点击落点与诊断 ─────────────────────────────────────────────

    /**
     * `?navdebug=1` 打开导航诊断。
     *
     * 打开后：每次 `activePanelId` 变化、实例切换、会话切换都连同**调用栈**写进
     * console（前缀 `[super-agent][nav]`），并累积到 `window.__SA_NAV_LOG__`（最多
     * 500 条，整段复制即可）。目的是让「偶发被切走」复现一次就能看到调用点。
     *
     * 关闭时这里只有一次字符串判断：不订阅服务、不注册监听、不在 window 上留任何
     * 东西——排障开关不能给正常路径加副作用。
     */
    const navDebugOn = (() => {
      try {
        if (typeof location === 'undefined' || location === null) return false
        const search = typeof location.search === 'string' ? location.search : ''
        return /(?:^|[?&])navdebug=1(?:&|$)/.test(search)
      } catch {
        return false
      }
    })()
    const NAV_LOG_LIMIT = 500
    let navLogEntries
    /** 最近一次页面可见性/焦点变化的时刻（仅 navdebug 用，用于判断「刚回到前台」）。 */
    let navLastVisibilityAt = 0
    let navLastFocusAt = 0
    let navPrevPanelId

    /**
     * 单实例标记：同一页面**只允许一份** super-agent 客户端在跑。
     *
     * 宿主把同一个包的 client 求值两次是可能的：启动时进聚合 boot combo，之后
     * `dsh-client-hmr` 每 500ms stat 轮询一遍 `lib/client.js`，只要
     * mtimeMs/ctimeMs/size 变了就 `clientModules.rebuilt(id)`，浏览器改为加载这条
     * 行的 one-resource combo（`plugins/??dsh-super-agent/client.js&rev=…`）并重新
     * 求值。正常路径下宿主会先拆掉旧 entry 的 fiber（我们的 ctx.effect 清理随它跑），
     * 旧实例消失；但「旧 entry 没被拆掉」时两份闭包会同时活着——两次求值各有一份
     * 模块闭包，模块级 WeakMap/变量互不可见，守卫会叠两层、navdebug 订阅两份、
     * away-notify 拿到两个 showSession。所以约束必须落在 `window` 的全局槽上。
     *
     * 语义：**先到者持有，后到者直接退出**（打一条 console.warn）。不做「后到者
     * 销毁前一份再接管」——旧实例的槽注册/React 树不在我们的清理范围内，抢占会
     * 留下两份 `main` 槽条目；退出则保证任何时刻页面上只有一份在注册。
     */
    const INSTANCE_KEY = '__dshSuperAgentInstance'
    const NAV_GUARD_REGISTRY_KEY = '__dshSuperAgentNavGuard'
    const NAV_DEBUG_REGISTRY_KEY = '__dshSuperAgentNavDebug'

    /**
     * 取本页面的客户端单实例。
     *
     * `window` 不可用（精简宿主/测试）时视为独占；已被占用时返回 undefined，
     * 调用方必须**立刻退出**，不注册任何东西。
     *
     * @returns {{ at: number, release: () => void }|undefined} 实例令牌。
     */
    function claimInstance() {
      const scope = typeof window === 'undefined' ? undefined : window
      if (scope === undefined) return { at: Date.now(), release: () => {} }
      const existing = scope[INSTANCE_KEY]
      if (existing !== undefined && existing !== null) return undefined
      const token = { at: Date.now() }
      token.release = () => {
        if (scope[INSTANCE_KEY] === token) delete scope[INSTANCE_KEY]
      }
      scope[INSTANCE_KEY] = token
      return token
    }

    /**
     * 我们自己发起、且确属用户意图的导航（例如「在会话中打开 Worker」——点击后
     * 先 await 一次 unarchive，手势窗口可能已经过期）在这里提前授权。
     */
    let authorizedNavUntil = 0

    /**
     * 授权接下来的一小段时间内由我们主动发起的会话切换。
     *
     * @param {number} [ms] 有效时长（毫秒）。
     * @returns {void}
     */
    function authorizeNavigation(ms = 5000) {
      authorizedNavUntil = Date.now() + ms
    }

    /**
     * 记一条导航事件（navdebug 关闭时立即返回）。
     *
     * @param {string} kind 事件类型（panel / session / instance / reveal / visibility…）。
     * @param {object} [detail] 结构化细节；调用栈单独成字段，方便日志整段复制。
     * @param {string} [source] 「谁改的」标签。
     * @returns {void}
     */
    function navLog(kind, detail, source) {
      if (!navDebugOn) return
      try {
        if (navLogEntries === undefined) {
          navLogEntries = []
          window.__SA_NAV_LOG__ = navLogEntries
        }
        // `source` 是「谁改的」标签：layout.panelInfo（宿主直接写 store）/
        // layout.selectPanel（宿主或别的插件调用服务）/ away-notify.showSession
        // （点通知或焦点恢复回跳）/ super-agent.*（我们自己）。
        const entry = { at: Date.now(), kind, source: source ?? null, detail: detail ?? null, stack: new Error('navdebug').stack }
        navLogEntries.push(entry)
        if (navLogEntries.length > NAV_LOG_LIMIT) navLogEntries.shift()
        // 结构化一行：`type`/`target`/`source` 一眼能读，栈只留两帧调用点，
        // 不再把整个 Error 对象塞进 console（那会打成 `Object Error: navdebug`）。
        const target = entry.detail?.to ?? entry.detail?.sessionId ?? entry.detail?.panelId ?? null
        const line = JSON.stringify({ type: kind, source: entry.source, target, at: entry.at, detail: entry.detail })
        const frames = String(entry.stack ?? '').split('\n').slice(1, 3).map((frame) => frame.trim()).join(' | ')
        console.info('[super-agent][nav]', line, frames)
      } catch {
        // 诊断绝不能影响导航本身。
      }
    }

    /** 当前页面状态快照，写进 navdebug 日志。 */
    function navEnv() {
      try {
        return {
          visibility: typeof document === 'undefined' ? 'no-document' : (document.visibilityState ?? 'unknown'),
          focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : false,
          sinceVisibility: navLastVisibilityAt === 0 ? null : Date.now() - navLastVisibilityAt,
          sinceFocus: navLastFocusAt === 0 ? null : Date.now() - navLastFocusAt,
        }
      } catch {
        return {}
      }
    }

    /**
     * 装上 navdebug 的监听（只在开关打开时调用一次）。
     *
     * `activePanelId` 的订阅挂在这里而不是常规 `apply` 路径：正常运行时不应该多一个
     * 订阅，否则「谁改了面板选择」这件事本身就会被改变。
     *
     * @param {object} ctx 浏览器插件上下文。
     */
    /** 已经装过守卫的 layout（WeakMap，避免重复包装）。 */
    const navGuardInstalled = new WeakMap()

    /** 「只在用户显式操作时允许切走面板」的手势时间窗（毫秒）。 */
    const NAV_GESTURE_WINDOW_MS = 1500
    /** 面板守卫的开关（localStorage；默认开，写 `off` 关掉）。 */
    const NAV_GUARD_KEY = 'dsh.super-agent.navGuard'

    /**
     * 面板守卫是否开启（默认开）。
     *
     * @param {{ getItem?: Function }} [storage] 测试注入的存储。
     * @returns {boolean} 是否开启。
     */
    function navGuardEnabled(storage) {
      try {
        const store = storage ?? window.localStorage
        return store?.getItem?.(NAV_GUARD_KEY) !== 'off'
      } catch {
        return true
      }
    }

    /**
     * 面板守卫：本面板处于激活状态时，只允许「用户显式操作」把它切走。
     *
     * 为什么需要它：宿主有三条**自动**关闭面板的路径，都不经过用户点击——
     *   1. `ui-workspace` 的 `clearMain()` → `layout.selectPanel(null)`（client.js:1649）；
     *   2. `ui-workspace` 的 `replaceMain(..., 'reveal')` → `selectPanel(null)`（:1673），
     *      任何 `uiWorkspace.openSession(...)`（含 away-notify 的通知落点回退）都会走；
     *   3. `ui-layout` 的 `retainMainPanels`（:410）在**每一次 main 槽注册表变动**时
     *      跑（:689 订阅、:614 取 `slots.entries('main')`）：只要那一刻我们的 key 不在
     *      列表里（插件热重载、条目重新注册的瞬时窗口），`activePanelId` 就被置 null——
     *      表现就是「刚打开面板就被切走」。
     *
     * 判定规则只有一条：**切换必须伴随最近 1.5 秒内的真实手势**
     * （pointerdown / mousedown / keydown / popstate / hashchange）。用户点是手势，
     * 定时器、注册表变动、通知回跳都不是。打开本面板（to === PANEL_ID）永远放行。
     *
     * 为什么不会挡住合法导航：
     *   - 点左栏会话、点「Conversation」、按快捷键、浏览器前进/后退 —— 都有手势；
     *   - 面板里的「在会话中打开」「打开聊天」—— 有手势；
     *   - 通知点开面板 —— `selectPanel(PANEL_ID)`，不看手势；
     *   - 插件卸载、面板条目真的消失时，`isRegistered()` 为假，直接放行（不硬撑）。
     *
     * @param {object} ctx 客户端 ctx（取 `layout`、`slots`）。
     * @param {object} [options] 测试注入。
     * @param {object} [options.layout] layout 服务（默认 `layoutService` 或 `ctx.get('layout')`）。
     * @param {object} [options.document] document 桩。
     * @param {Function} [options.now] 时钟。
     * @param {object} [options.storage] localStorage 桩。
     * @param {Function} [options.isRegistered] 我们的 main 条目是否仍在注册表里。
     * @returns {() => void} 解绑（恢复原方法、移除监听）。
     */
    function installNavGuard(ctx, options = {}) {
      const layout = options.layout ?? layoutService ?? (typeof ctx?.get === 'function' ? ctx.get('layout') : undefined)
      if (layout === null || layout === undefined || typeof layout.selectPanel !== 'function') return () => {}
      // 同一个 layout 只包一层：`ctx.inject` 的回调可能重复跑（服务重启/补丁重载），
      // 叠两层包装会让「解绑」只还原到上一层。
      if (navGuardInstalled.has(layout)) return () => {}
      // 跨闭包的幂等：同一个 layout 对象在整页只包一层。模块级 WeakMap 挡不住
      // 两份闭包，所以注册表放在 window 上；上一份实例的包装如果还活着（卸载清理
      // 没跑），先拆掉它再装，绝不叠加。
      const registry = typeof window === 'undefined' ? undefined : window[NAV_GUARD_REGISTRY_KEY]
      if (registry !== undefined && registry !== null && registry.layout === layout && typeof registry.restore === 'function') {
        return registry.restore
      }
      if (registry !== undefined && registry !== null && typeof registry.restore === 'function') {
        try {
          registry.restore()
        } catch {
          // 前一份实例的 layout 已经不存在：忽略。
        }
      }
      const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
      const now = options.now ?? (() => Date.now())
      const storage = options.storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
      if (!navGuardEnabled(storage)) {
        navLog('guard.off', {})
        return () => {}
      }
      const isRegistered = options.isRegistered ?? (() => {
        try {
          const entries = typeof ctx?.slots?.entries === 'function' ? ctx.slots.entries('main') : []
          return (entries ?? []).some((entry) => entry?.options?.key === PANEL_ID)
        } catch {
          // 拿不到注册表时保守放行：宁可让它切，也不要挡住真实导航。
          return false
        }
      })
      const activePanelId = () => {
        try {
          const snapshot = layout.panelInfo?.getSnapshot?.()
          return snapshot === undefined ? undefined : snapshot?.activePanelId ?? null
        } catch {
          return undefined
        }
      }

      let lastGestureAt = Number.NEGATIVE_INFINITY
      let lastArmAt = Number.NEGATIVE_INFINITY
      /**
       * 记一次手势。同一次物理点击会依次触发 `pointerdown` / `mousedown`，
       * 若都上膛，第一次导航把手势消费掉之后，第二个事件又会立刻重新上膛，
       * 把 1.5 秒窗口白白送给随后的自动关闭。所以 350ms 内的连续事件只算一次。
       */
      const markGesture = () => {
        const at = now()
        if (at - lastArmAt < 350) return
        lastArmAt = at
        lastGestureAt = at
      }
      const gestureEvents = ['pointerdown', 'mousedown', 'keydown', 'popstate', 'hashchange']
      const bound = []
      if (doc !== undefined && doc !== null && typeof doc.addEventListener === 'function') {
        for (const type of gestureEvents) {
          doc.addEventListener(type, markGesture, true)
          bound.push(type)
        }
      }
      const gestureRecent = () => now() - lastGestureAt <= NAV_GESTURE_WINDOW_MS
      /**
       * 手势是**一次性令牌**：点一下只授权它引发的那次导航，不授权紧接着
       * 1.5 秒里的一切——否则「点开面板」这一下会替随后的自动关闭背书，
       * 正好是「刚打开就被切走」的形态。
       */
      const consumeGesture = () => {
        const fresh = gestureRecent()
        if (fresh) lastGestureAt = Number.NEGATIVE_INFINITY
        return fresh
      }
      /** 由「用户授权的关闭」在 store 写入期间置位，订阅层据此不恢复。 */
      let authorizedClose = false

      const original = layout.selectPanel
      const guarded = function guardedSelectPanel(panelId) {
        const from = activePanelId()
        const leaving = from === PANEL_ID && panelId !== PANEL_ID
        if (leaving && !gestureRecent() && isRegistered()) {
          navLog('nav.blocked', {
            from,
            to: panelId ?? null,
            gesture: false,
            reason: 'automatic',
            hint: '没有用户手势就想切走面板：这是宿主/其它插件的自动导航（见 stack）',
          }, 'layout.selectPanel')
          return false
        }
        const gesture = consumeGesture()
        navLog('nav.select', { from, to: panelId ?? null, gesture, allowed: true }, 'layout.selectPanel')
        authorizedClose = true
        try {
          return original.call(layout, panelId)
        } finally {
          authorizedClose = false
        }
      }
      try {
        layout.selectPanel = guarded
      } catch {
        // 服务对象只读（冻结）：只记日志，不改变行为。
        navLog('guard.failed', { reason: 'selectPanel is not writable' })
        return () => {}
      }
      navGuardInstalled.set(layout, true)
      navLog('guard.on', { windowMs: NAV_GESTURE_WINDOW_MS })

      // 第二层：宿主有些地方**直接写 store**，绕过 `selectPanel`——最典型的就是
      // `ui-layout` 的 `retainMainPanels`（注册表短暂缺条目时把 activePanelId 置
      // null）。所以再订阅一次 panelInfo：没有手势的「关掉我们」先等一下，
      // 条目还在就恢复；条目真没了（插件卸载）就不硬撑。
      const timers = new Set()
      let unsubscribe
      let previous = activePanelId()
      const restoreLater = (closeStack) => {
        const attempt = () => {
          if (activePanelId() === PANEL_ID) return
          if (authorizedClose) return
          if (!isRegistered()) {
            navLog('nav.release', { reason: 'our main entry is gone' })
            return
          }
          if (gestureRecent()) return
          navLog('nav.restored', { from: PANEL_ID, to: null, closeStack }, 'super-agent.navGuard')
          try {
            original.call(layout, PANEL_ID)
          } catch (error) {
            navLog('nav.restore.failed', { error: String(error?.message ?? error) })
          }
        }
        if (typeof setTimeout !== 'function') {
          attempt()
          return
        }
        const timer = setTimeout(() => {
          timers.delete(timer)
          attempt()
        }, 0)
        timers.add(timer)
      }
      try {
        if (layout.panelInfo !== null && layout.panelInfo !== undefined && typeof layout.panelInfo.subscribe === 'function') {
          unsubscribe = layout.panelInfo.subscribe(() => {
            const next = activePanelId()
            const closing = previous === PANEL_ID && next !== PANEL_ID
            if (closing && !authorizedClose && !gestureRecent()) {
              const closeStack = typeof Error === 'function' ? new Error('panel closed').stack : undefined
              navLog('nav.close', { from: PANEL_ID, to: next ?? null, gesture: false }, 'layout.panelInfo')
              restoreLater(closeStack)
            }
            previous = next
          })
        }
      } catch (error) {
        navLog('guard.subscribe.failed', { error: String(error?.message ?? error) })
      }

      // ── 会话切换守卫 ────────────────────────────────────────────────────────
      //
      // away-notify 的「切回通知会话」根本不经过 `selectPanel`：
      //
      //   dsh-away-notify/lib/client.js:1141  visibility/focus 恢复 →
      //   :959 consumePendingFocus（POST presence `pending-focus`，宿主在发通知时
      //        写下 sessionId，TTL 90s）
      //   :1003 switchTo(sessionCtx, target)
      //   :922 switchTo → resolveSessionOpener → `uiWorkspace.openSession(target)`
      //   dsh-client-ui-workspace/lib/client.js:1470 openSession →
      //   :1651 replaceMain(target, signal, 'reveal')
      //        → sessions.retain(target, {source:'mainView'}) + selection.set(...)
      //        → 最后才 selectPanel(null)
      //
      // 也就是说会话在 `replaceMain` 里就换掉了，我们的 selectPanel 守卫看到时已经晚了。
      // 所以在**会话打开器**上再包一层：没有用户手势（一次性令牌）的跨会话跳转直接拦下，
      // 只留一条「面板内定位提示」。
      const sessionsService = options.sessions ?? service(ctx, 'sessions')

      /** 当前主视图正在看的会话（与 away-notify 的判定同源：mainView retain）。 */
      const currentMainSession = () => {
        try {
          const snapshot = sessionsService?.list?.getSnapshot?.()
          const byId = snapshot?.byId ?? {}
          for (const [id, row] of Object.entries(byId)) {
            if ((row?.retainedBy?.mainView ?? 0) > 0) return id
          }
          if (typeof snapshot?.current === 'string' && snapshot.current.length > 0) return snapshot.current
        } catch {
          // 拿不到快照：当作「不知道当前会话」，下面按放行处理。
        }
        return undefined
      }

      const openerRestores = []
      const wrapSessionOpener = (holder, key, source) => {
        if (holder === undefined || holder === null) return
        let original
        try {
          original = holder[key]
        } catch {
          return
        }
        if (typeof original !== 'function') return
        if (openerRestores.some((entry) => entry.original === original)) return
        const guardedOpener = function guardedSessionOpener(target, ...rest) {
          let targetId
          try {
            targetId = typeof target === 'string' ? target : target?.sessionId
          } catch {
            targetId = undefined
          }
          const allow = () => original.apply(this, [target, ...rest])
          if (typeof targetId !== 'string' || targetId.length === 0) return allow()
          const current = currentMainSession()
          // 已经在目标会话上、或者还没有任何会话（启动/launch URL/协议链接）→ 放行。
          if (current === undefined || targetId === current) return allow()
          // 我们自己的用户意图导航（点击后 await 过，手势窗口可能已过期）。
          if (Date.now() <= authorizedNavUntil) return allow()
          // 手势判定与 selectPanel 守卫同源（同一个点击里既换会话又要关面板，
          // 用一次性令牌会把后半段判成「自动」）。窗口外的自动跳转一律拦。
          if (gestureRecent()) return allow()
          if (!isRegistered()) return allow()
          navLog('nav.blocked', {
            kind: 'session',
            from: current,
            to: targetId,
            gesture: false,
            reason: 'automatic',
            hint: '没有用户手势的跨会话跳转（away-notify 的 pendingFocus 走 openSession，绕过 selectPanel）',
          }, source)
          // 降级：面板内「定位」提示条，用户点一下才真正切过去。
          try {
            requestPanelReveal({ sessionId: targetId, reason: 'blocked-switch' })
          } catch {
            // 队列满/无面板：只记录日志。
          }
          return undefined
        }
        try {
          holder[key] = guardedOpener
        } catch {
          return
        }
        openerRestores.push({ holder, key, original, guarded: guardedOpener })
      }
      // uiWorkspace 不是 inject 声明的服务：当场拿可能拿不到（cordis 会抛
      // `cannot get property without inject`），拿不到就等 inject 回调再包。
      const wrapWorkspace = (workspace) => {
        const before = openerRestores.length
        wrapSessionOpener(workspace, 'openSession', 'uiWorkspace.openSession')
        navLog('guard.openers', {
          workspace: openerRestores.length > before,
          sessions: typeof sessionsService?.open === 'function',
        }, 'super-agent.navGuard')
      }
      wrapSessionOpener(sessionsService, 'open', 'sessions.open')
      const workspaceNow = options.workspace ?? workspaceService ?? service(ctx, 'uiWorkspace')
      if (workspaceNow !== undefined && workspaceNow !== null) {
        wrapWorkspace(workspaceNow)
      } else if (typeof ctx?.inject === 'function') {
        try {
          ctx.inject(['uiWorkspace'], (services) => wrapWorkspace(services?.uiWorkspace ?? services))
        } catch {
          // 老宿主没有 inject：只包 sessions.open。
        }
      }

      const restore = () => {
        navGuardInstalled.delete(layout)
        if (typeof window !== 'undefined' && window[NAV_GUARD_REGISTRY_KEY]?.restore === restore) delete window[NAV_GUARD_REGISTRY_KEY]
        if (layout.selectPanel === guarded) layout.selectPanel = original
        for (const timer of timers) {
          if (typeof clearTimeout === 'function') clearTimeout(timer)
        }
        timers.clear()
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe()
          } catch {
            // 宿主已卸载 store：忽略。
          }
        }
        if (doc !== undefined && doc !== null && typeof doc.removeEventListener === 'function') {
          for (const type of bound) doc.removeEventListener(type, markGesture, true)
        }
        for (const entry of openerRestores.splice(0)) {
          try {
            if (entry.holder[entry.key] === entry.guarded) entry.holder[entry.key] = entry.original
          } catch {
            // 宿主已换实例/属性只读：忽略。
          }
        }
      }
      if (typeof window !== 'undefined') window[NAV_GUARD_REGISTRY_KEY] = { layout, restore }
      return restore
    }

    function installNavDebug(ctx) {
      if (!navDebugOn) return () => {}
      const scope = typeof window === 'undefined' ? undefined : window
      // 跨闭包幂等：上一份诊断如果还在（卸载清理没跑），先拆掉，否则每次面板
      // 变化/回到前台都会记两遍。
      const previous = scope?.[NAV_DEBUG_REGISTRY_KEY]
      if (previous !== undefined && previous !== null && typeof previous.dispose === 'function') {
        try {
          previous.dispose()
        } catch {
          // 前一份实例已卸载：忽略。
        }
      }
      /** @type {Array<() => void>} */
      const cleanups = []
      navLog('navdebug.on', { search: typeof location === 'undefined' ? '' : String(location.search ?? ''), ...navEnv() })
      try {
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          const onVisibility = () => {
            navLastVisibilityAt = Date.now()
            navLog('visibility', navEnv())
          }
          document.addEventListener('visibilitychange', onVisibility)
          cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
        }
        if (scope !== undefined && typeof scope.addEventListener === 'function') {
          const onFocus = () => {
            navLastFocusAt = Date.now()
            navLog('focus', navEnv())
          }
          const onBlur = () => navLog('blur', navEnv())
          scope.addEventListener('focus', onFocus)
          scope.addEventListener('blur', onBlur)
          cleanups.push(() => {
            scope.removeEventListener('focus', onFocus)
            scope.removeEventListener('blur', onBlur)
          })
        }
      } catch {
        // 精简宿主没有这些事件：只记面板/会话切换。
      }
      /** 订阅一次面板选择；layout 晚到（注入是异步的）时由下面的 inject 补订。 */
      const attachPanel = (layout) => {
        try {
          const panelInfo = layout?.panelInfo
          if (panelInfo === undefined || panelInfo === null || typeof panelInfo.subscribe !== 'function') return false
          // 先记下现状：第一次变化才能显示真实的 from，而不是 null。
          try {
            const snapshot = typeof panelInfo.getSnapshot === 'function' ? panelInfo.getSnapshot() : panelInfo
            navPrevPanelId = snapshot?.activePanelId
          } catch {
            navPrevPanelId = undefined
          }
          const off = panelInfo.subscribe(() => {
            let next
            try {
              const snapshot = typeof panelInfo.getSnapshot === 'function' ? panelInfo.getSnapshot() : panelInfo
              next = snapshot?.activePanelId
            } catch {
              next = undefined
            }
            navLog('panel', { from: navPrevPanelId ?? null, to: next ?? null, ...navEnv() }, 'layout.panelInfo')
            navPrevPanelId = next
          })
          if (typeof off === 'function') cleanups.push(() => off())
          return true
        } catch (error) {
          navLog('panel.subscribe.failed', { error: String(error?.message ?? error) })
          return false
        }
      }
      const dispose = () => {
        if (scope !== undefined && scope[NAV_DEBUG_REGISTRY_KEY]?.dispose === dispose) delete scope[NAV_DEBUG_REGISTRY_KEY]
        for (const cleanup of cleanups.splice(0)) {
          try {
            cleanup()
          } catch {
            // 宿主已卸载：忽略。
          }
        }
      }
      if (scope !== undefined) scope[NAV_DEBUG_REGISTRY_KEY] = { dispose }
      const immediate = layoutService ?? (typeof ctx?.get === 'function' ? ctx.get('layout') : undefined)
      if (attachPanel(immediate)) return dispose
      try {
        if (typeof ctx?.inject === 'function') ctx.inject(['layout'], (services) => { attachPanel(services?.layout ?? services) })
      } catch {
        // 没有注入能力：只记会话/实例变化，面板变化缺一条不影响排障。
      }
      return dispose
    }

    // ── 通知点击：把面板定位到产生通知的会话 ─────────────────────────────────

    /** 面板挂载后消费的「切到某条会话」请求（与 filePreviewSink 同一模式的单向通道）。 */
    let panelRevealSink
    let pendingPanelReveal
    /** 请求有效期：away-notify 的待跳转会话是 90 秒，留一点余量。 */
    const PANEL_REVEAL_TTL_MS = 120000
    /** 「点通知自动跟随」的开关（localStorage；**默认关**）。 */
    const NAV_FOLLOW_KEY = 'dsh.super-agent.navFollow'

    /**
     * 自动跟随通知是否开启（**默认关**，只有显式写过 `on` 才开）。
     *
     * 这是面板侧对 away-notify「回到前台就跳会话」的抑制开关：away-notify 的
     * 待跳转会话是在**发通知时**写下的（host.js:463-464），客户端在任意一次
     * 焦点/可见性恢复时消费（client.js:1139-1141），因此「只是切回来、没点通知」
     * 也会跳到最后那条通知的会话。默认关：点击通知只把面板切到前台并在顶部给一条
     * 「定位」提示，由用户点一下再跳——不会被自动切走；显式打开（`on`）恢复旧行为。
     *
     * 为什么不能「点通知就跳、焦点恢复不跳」：away-notify 只有一条通路
     * （`consumePendingFocus` → `focusPanel` → `showSession(sessionId)`，client.js:520），
     * `showSession` 不带来源标记，页面内无法区分「点通知」和「Alt-Tab 切回来」——
     * 点击 Toast 也是先让窗口获得焦点/重新加载，再走同一段消费逻辑。
     *
     * @param {{ getItem?: Function }} [storage] 测试注入的存储。
     * @returns {boolean} 是否自动跟随。
     */
    function navFollowEnabled(storage) {
      try {
        const store = storage ?? window.localStorage
        return store?.getItem?.(NAV_FOLLOW_KEY) === 'on'
      } catch {
        return false
      }
    }

    /**
     * 记住「自动跟随」开关。
     *
     * @param {boolean} enabled 是否自动跟随。
     * @param {{ setItem?: Function }} [storage] 测试注入的存储。
     * @returns {boolean} 写入后的状态。
     */
    function setNavFollow(enabled, storage) {
      try {
        const store = storage ?? window.localStorage
        store?.setItem?.(NAV_FOLLOW_KEY, enabled === true ? 'on' : 'off')
      } catch {
        // 隐私模式写不进去：本次会话内仍按传入值返回。
      }
      return enabled === true
    }

    /**
     * 排队一次「面板定位到这条会话」。
     *
     * away-notify 的 `showSession` 是在 `selectPanel` 之后**同步**调用的，此刻面板
     * 可能还没挂载（React 下一帧才渲染），所以请求先排队、由面板挂载时消费；面板
     * 已经在场时直接推给它。
     *
     * @param {{ sessionId: string, instanceId?: string, unresolved?: boolean, reason?: string }} request 定位请求。
     * @returns {boolean} 是否接受（会话 id 为空时不接受）。
     */
    function requestPanelReveal(request) {
      if (request === undefined || request === null) return false
      if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) return false
      const queued = { ...request, at: Date.now() }
      pendingPanelReveal = queued
      navLog('reveal.queue', {
        sessionId: queued.sessionId,
        instanceId: queued.instanceId ?? null,
        unresolved: queued.unresolved === true,
        reason: queued.reason ?? null,
      })
      const sink = panelRevealSink
      if (sink === undefined) return true
      pendingPanelReveal = undefined
      try {
        sink(queued)
      } catch {
        // 面板消费失败：留在队列里，下次挂载还能取到。
        pendingPanelReveal = queued
      }
      return true
    }

    /**
     * 取一次排队的定位请求（过期或空返回 undefined）。
     *
     * @returns {{ sessionId: string, instanceId?: string, unresolved?: boolean }|undefined}
     */
    function takePanelReveal() {
      const queued = pendingPanelReveal
      pendingPanelReveal = undefined
      if (queued === undefined) return undefined
      if (Date.now() - queued.at > PANEL_REVEAL_TTL_MS) return undefined
      return queued
    }

    /** 读一次 `/ui/state`；失败返回 undefined，绝不抛。 */
    async function readUiState() {
      try {
        const response = await fetch(ROUTES.state, { credentials: 'same-origin' })
        if (response === undefined || response === null || response.ok !== true) return undefined
        const payload = await response.json()
        return payload !== null && typeof payload === 'object' && payload.ok === true ? payload : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 会话 → 所在实例（纯函数）。
     *
     * `/ui/state` 的 `routers` 是唯一可信映射：每个 live 实例的 Router 会话 id 随
     * 实例一起下发。找不到时不猜实例——返回只有 `sessionId` 的目标，由面板在当前
     * 实例里定位（宁可留在原实例，也不跳到错的实例）。
     *
     * @param {object|undefined} state `/ui/state` 的应答。
     * @param {string} sessionId 产生通知的会话。
     * @returns {{ sessionId: string, instanceId?: string }|undefined}
     */
    function revealTargetOf(state, sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const routers = Array.isArray(state?.routers) ? state.routers : []
      const owner = routers.find((row) => row !== null && typeof row === 'object' && row.sessionId === sessionId)
      const instanceId = typeof owner?.instanceId === 'string' && owner.instanceId.length > 0 ? owner.instanceId : undefined
      return instanceId === undefined ? { sessionId } : { sessionId, instanceId }
    }

    /**
     * 通知点击的落点（注册给 away-notify 的 `showSession`）。
     *
     * 三步固定执行，任何一步失败都继续下一步，且**没有「已经在了就什么都不做」的
     * 早退**——`showSession` 的语义是「定位」，不是「状态有变化才做事」：
     *  1. `layout.selectPanel(PANEL_ID)`：面板没开就先开；
     *  2. 用 `/ui/state` 的 `routers` 把会话映射到实例（多实例下这一步之前完全缺失，
     *     所以点击只能选中面板，面板仍停在上一个实例——「点了没反应」）；
     *  3. 把「实例 + 会话」交给面板：面板切实例（`/ui/instances/active` + ensure）
     *     再 adopt 这条会话；面板没挂载时请求排队，挂载后消费。
     *
     * @param {string} sessionId 产生通知的会话。
     * @param {{ openPanel?: () => boolean, readState?: () => Promise<object|undefined>, enqueue?: (request: object) => boolean }} [deps] 测试注入口。
     * @returns {Promise<boolean>} 是否已经把定位请求交出去。
     */
    async function revealNotificationSession(sessionId, deps = {}) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      const openPanel = typeof deps.openPanel === 'function' ? deps.openPanel : () => false
      const readState = typeof deps.readState === 'function' ? deps.readState : readUiState
      const enqueue = typeof deps.enqueue === 'function' ? deps.enqueue : requestPanelReveal

      let opened = false
      try {
        opened = openPanel() === true
      } catch {
        opened = false
      }
      let state
      try {
        state = await readState()
      } catch {
        state = undefined
      }
      const target = revealTargetOf(state, sessionId) ?? { sessionId }
      let queued = false
      try {
        queued = enqueue({
          sessionId,
          instanceId: target.instanceId,
          unresolved: target.instanceId === undefined,
          reason: 'notification',
        }) === true
      } catch {
        queued = false
      }
      const env = navEnv()
      navLog('reveal.notification', {
        sessionId,
        instanceId: target.instanceId ?? null,
        panelOpened: opened,
        queued,
        state: state === undefined ? 'unavailable' : 'ok',
        // 粗判：页面可见且有焦点时，多半是「点了通知」；否则是焦点/可见性恢复
        // 把宿主写下的待跳转会话消费掉了（away-notify 只有一条通路，见 README）。
        trigger: env.visibility === 'visible' && env.focused === true ? 'foreground' : 'regain',
        env,
      }, 'away-notify.showSession')
      return queued
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
            // 页面级单实例已经保证只有一份 apply 走到这里，不会给 away-notify 两个
            // showSession；注销仍做成幂等，避免宿主重复回调时二次 release。
            const release = register.call(panels, {
              panelId: PANEL_ID,
              sources: [PANEL_SOURCE],
              /**
               * 点击通知后把面板定位到产生通知的会话。
               *
               * 不传这个回调也能选中面板，但面板只会停在它当时显示的实例上——
               * 多实例下就是「点了通知没反应」。注册契约见 away-notify 的
               * `docs/plugin-api.md`「面板点击落点」。
               */
              showSession: (sessionId) => {
                void revealNotificationSession(sessionId, { openPanel: () => openSuperAgentPanel(ctx) })
              },
            })
            // 注销做成幂等：宿主可能重复回调 dispose，不能把同一个注册注销两遍。
            let released = false
            const disposeRegistration = () => {
              if (released) return
              released = true
              try {
                if (typeof release === 'function') release()
              } catch {
                // away-notify 已经卸载/换实例：它那边的注册表本来就没了
              }
            }
            return disposeRegistration
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
      // 页面级单实例：同一页面被求值两次时，第二份直接退出（不注册任何东西），
      // 只打一条 warn。为什么不是「接管」：旧实例的槽注册、面板 React 树不归我们
      // 清理，抢占会留下两份 main 条目；退出才能保证「只注册一次」。
      const instance = claimInstance()
      if (instance === undefined) {
        try {
          console.warn('[super-agent] 本页已有一份客户端实例在跑：这次重复加载直接退出，不重复注册。硬刷新页面可换成新代码。')
        } catch {
          // 没有 console 的精简环境：忽略。
        }
        return
      }
      ctx.effect(() => () => instance.release(), 'super-agent: single instance')
      ctx.effect(() => ctx.locale.register(NS, DICT), 'super-agent: dictionaries')
      const t = ctx.locale.bind(NS)

      // 文件预览读取端：等宿主的 `remote.workspaceFiles` 命名空间就绪再缓存。
      // 它缺席时面板照常工作，预览显示「接口缺失」。
      bindWorkspaceFiles(ctx)

      // uiWorkspace 是宿主 0.1.7 的视图切换服务；可选注入，缺失时面板照常工作。
      try {
        ctx.inject(['uiWorkspace'], (services) => {
          workspaceService = services?.uiWorkspace ?? services
        })
      } catch {
        // 旧宿主没有该服务：点击打开聊天时再尝试 ctx.get。
      }

      // layout 用来从 composer 徽标跳回面板；同样是可选注入。
      try {
        ctx.inject(['layout'], (services) => {
          layoutService = services?.layout ?? (typeof services?.selectPanel === 'function' ? services : undefined)
        })
      } catch {
        // 没有 layout：徽标仍在，点击退化为无操作（或走 ctx.get）。
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
                if (text.startsWith('Super-agent worker ·') || text.startsWith('Super-agent ·')) row.setAttribute('data-super-agent-worker', '')
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

      // `?navdebug=1` 时才装导航诊断（默认关闭，不在 window 上留任何东西）。
      // 挂到 ctx.effect：插件卸载/热重载时把 document/window 监听一起摘掉。
      try {
        ctx.effect(() => installNavDebug(ctx), 'super-agent: nav debug')
      } catch {
        installNavDebug(ctx)
      }

      // 面板守卫：宿主有三条**不经过用户点击**就能关掉面板的路径（见 installNavGuard），
      // 表现就是「刚打开面板就被切走」。装上后只放行带手势的切换。
      try {
        ctx.inject(['layout'], (services) => {
          const layout = services?.layout ?? (typeof services?.selectPanel === 'function' ? services : undefined)
          if (layout === undefined) return
          const install = () => installNavGuard(ctx, { layout })
          try {
            ctx.effect(install, 'super-agent: nav guard')
          } catch {
            install()
          }
        })
      } catch {
        // 精简宿主没有 inject：不装守卫，面板行为保持原样。
      }

      // 右侧栏服务可能晚于本插件就绪，这里等它就绪再装文件链接桥；服务永久缺席时
      // 桥不存在，普通会话（主区域是会话）里的文件链接仍走官方路径。
      try {
        ctx.inject(['sidebarRight'], (services) => {
          const sidebar = services?.sidebarRight ?? service(services, 'sidebarRight')
          const dispose = bridgeFileOpens(sidebar, (plan) => {
            if (filePreviewSink === undefined) return false
            filePreviewSink(plan)
            return true
          })
          if (typeof dispose !== 'function') return
          try {
            services.effect(() => dispose, 'super-agent: file link bridge')
          } catch {
            // 没有 effect 的精简宿主：桥保留到插件卸载，不影响普通会话。
          }
        })
      } catch {
        // 宿主没有 inject：面板里的文件链接保持官方行为（会抛 no session surface）。
      }

      ctx.slots.inject('main', function* () {
        const handle = ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          children: {
            [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
          },
        }, (props) => h(RenderBoundary, {
          // 整页崩了也不能把宿主变成黑屏：面板位置显示错误态。
          fallback: (error, reset) => h(PanelCrash, { t, error, onReset: reset }),
        }, h(SuperAgentPage, { ...props, t, pluginCtx: ctx })))
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

      // composer 工具行左端的运行状态徽标。宿主没有这个槽位（旧版本/精简宿主）
      // 时整段跳过：徽标只是提示，缺席不能影响面板本身。
      try {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({
            name: 'conversation.input.left',
            id: 'super-agent-status',
            order: 30,
            locale: NS,
          }, (props) => h(SuperAgentBadge, { ...props, t, pluginCtx: ctx })))
      } catch {
        // 槽位未声明：徽标缺席，其余功能照常。
      }
    }

    module.exports.apply = apply
    module.exports.inject = ['sessions', 'slots', 'locale']
    module.exports.NS = NS
    module.exports.PANEL_ID = PANEL_ID
    // 纯函数与桥给单元测试用：不依赖 DOM/React，节点测试里可直接断言调用链。
    module.exports.__internals = {
      badgeSummary,
      badgeParts,
      badgeCount,
      publishBadge,
      openSuperAgentPanel,
      FILE_ADDRESS_PREFIX,
      parseFileAddress,
      filePreviewPlan,
      shouldBridgeFileOpen,
      fileReadRequest,
      bridgeFileOpens,
      WORKSPACE_FILES_SERVICE,
      resolveWorkspaceFiles,
      bindWorkspaceFiles,
      readFilePreview,
      readFileBytes,
      previewMessage,
      previewKindOf,
      previewBodyOf,
      imageMediaTypeOf,
      fileExtensionOf,
      claimInstance,
      authorizeNavigation,
      INSTANCE_KEY,
      NAV_GUARD_REGISTRY_KEY,
      NAV_DEBUG_REGISTRY_KEY,
      navDebugOn,
      navLog,
      installNavDebug,
      requestPanelReveal,
      takePanelReveal,
      revealTargetOf,
      revealNotificationSession,
      navFollowEnabled,
      setNavFollow,
      navGuardEnabled,
      installNavGuard,
      NAV_GESTURE_WINDOW_MS,
      RenderBoundary,
      bindDrawerDismiss,
      isInsideDrawer,
      errorSummaryOf,
      CrashNote,
      PanelCrash,
      PreviewColumn,
      PreviewTabBody,
      previewTabId,
      previewFileName,
      previewIconFor,
      previewTabsAdd,
      previewTabsClose,
      previewWidthFor,
      Drawer,
      styles: S,
      readUiState,
      primitives: official,
      panelVisible,
      panelVisibleNow,
      panelIdFromLayout,
      sessionTransition,
      rememberPanelSession,
      cachedPanelSession,
      SUPER_AGENT_PANEL_ID: PANEL_ID,
      format,
      DICT,
    }
    return module.exports
  },
})
