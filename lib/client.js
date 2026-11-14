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
      modelDefaults: '/api/super-agent/ui/models/default',
      agreements: '/api/super-agent/ui/agreements',
      schedules: '/api/super-agent/ui/schedules',
      schedulesCancel: '/api/super-agent/ui/schedules/cancel',
      schedulesRun: '/api/super-agent/ui/schedules/run',
      instances: '/api/super-agent/ui/instances',
      instanceActive: '/api/super-agent/ui/instances/active',
      instanceRename: '/api/super-agent/ui/instances/rename',
      topics: '/api/super-agent/ui/topics',
      topicEnsure: '/api/super-agent/ui/topics/ensure',
    }
    const POLL_MS = 4_000

    const DICT = {
      zh: {
        'panel': 'Super-agent',
        'title': 'Super-agent',
        'instances': '实例',
        'topicTitle': '分身与记忆',
        'topicNavigation': '对话分身',
        'topicManage': '管理与记忆',
        'topicToggle': '展开或收起分身栏',
        'topicHelp': '什么是对话分身？',
        'topicHelpBody': '可以把分身当作当前 Super Agent 的子会话。每个分身保留独立聊天、专属记忆和自己的约定，共用任务资源；实例级约定与共享记忆通用，任务报告和定时唤醒会回到发起它的分身。',
        'topicHelpExample': '例如：在“研究”中讨论论文，在“日常”中安排出行；需要通用的偏好可保存为实例共享记忆。',
        'topicCurrent': '当前分身',
        'topicOverview': '总览',
        'topicNew': '新建分身',
        'topicCreate': '创建并切换',
        'topicCreateHelp': '给一类工作一个独立对话空间。任务资源仍与当前 Super Agent 共用。',
        'topicSettingsSave': '保存设置',
        'topicSettingsPending': '修改尚未保存',
        'topicDuplicate': '已有同名分身，请换一个名称。',
        'topicName': '分身名称',
        'topicNamePlaceholder': '例如：研究、写作、日常',
        'topicSharing': '与其他分身共享',
        'topicPrivate': '仅自己可见',
        'topicPrivateDescription': '其他分身看不到这个分身的名称、摘要、任务或聊天。',
        'topicSummary': '分享协作摘要',
        'topicSummaryDescription': '分享名称、协作摘要和任务状态，聊天原文与专属记忆保持独立。',
        'topicHistory': '允许查阅聊天',
        'topicHistoryDescription': '在摘要之外，允许其他分身按需读取聊天文字和相关任务详情。',
        'topicNotes': '本主题记录',
        'topicSharedNotes': '实例共享记录',
        'topicSave': '保存',
        'topicHide': '隐藏分身',
        'topicHideHelp': '隐藏仅收起入口，正在进行的任务与定时任务会继续。',
        'topicRuleScope': '约定范围',
        'topicRuleLocal': '当前分身',
        'topicRuleShared': '本实例全部分身',
        'topicRestore': '恢复',
        'topicHidden': '已隐藏的分身',
        'topicAdvanced': '隐藏与恢复',
        'topicSharingHelp': '实例共享记忆在“记忆”页单独管理。收紧共享范围不会收回其他分身已经读到的内容；分身之间沿用同一宿主账户的文件权限。',
        'topicSharingBoundary': '分身共用宿主的文件权限。其他分身已经读到的内容不能撤回。',
        'topicNotesHelp': '保存简短事实、决定和资料线索。共享记录对本实例全部主题可见；请勿存放凭据。',
        'memoryTabTopic': '分身设置',
        'memoryTabFacts': '记忆',
        'memoryTabContext': 'AI 参考',
        'memorySubtitle': '独立聊天与记忆，共用同一个 Super Agent',
        'memoryLocal': '分身专属',
        'memoryScope': '记忆范围',
        'memoryShared': '本实例共享',
        'memoryLocalHelp': '只供当前分身及它派出的 Worker 使用，适合这个对话专用的事实和决定。',
        'memorySharedHelp': '本实例的所有分身都可用，适合通用偏好与共同事实；改变分身的共享方式不会撤回这里的记忆。',
        'memoryHelp': '怎么使用记忆？',
        'memoryHelpBody': '可以直接在聊天中说“请记住项目截止日期是周五”；想让所有分身可用，就说“请为本实例共享记住……”。也可在这里添加或纠正。',
        'memoryHelpDetails': '同一事实变化时编辑原条目，过时后归档；重点记忆会优先提供给 AI。同名专属记忆只在当前分身覆盖共享值。',
        'memoryAdd': '添加记忆',
        'memoryEdit': '编辑',
        'memoryKey': '事实名称',
        'memoryKeyHint': '例如：项目发布日期。事实变化时更新这一条。',
        'memoryLegacy': '旧记录已完整保留。请整理为完整、简短的事实再保存，勿遗漏末尾的限定条件。',
        'memoryText': '当前有效内容',
        'memoryImportant': '重点记忆 · 优先保留',
        'memoryArchive': '归档',
        'memoryArchived': '查看已归档',
        'memoryArchivedStatus': '已归档 · 不自动使用',
        'memoryArchiveHelp': '已归档内容不会自动注入；恢复后重新生效。',
        'memoryHistory': '变更记录',
        'memoryEmpty': '当前列表暂无记忆。可以添加新事实，或查看已归档内容。',
        'memorySearch': '查找记忆',
        'memoryReload': '载入最新版本',
        'memoryConflict': '内容已在其他会话更新。草稿仍保留，请载入最新版本后再编辑。',
        'memoryRevision': '版本',
        'memoryState': '协作摘要',
        'memoryStateHelp': '让其他分身知道这里在做什么、卡在哪里。AI 在对话有实质进展时更新；你也可以纠正。',
        'memoryStateDetails': '摘要是一张简短的交接卡，不是完整聊天或验收证明。是否分享由上方选项控制；没有摘要也可以正常聊天，无需预先填写。',
        'memoryStateEmpty': '还没有协作摘要。先开始对话，有实质进展时 AI 会维护这里的内容。',
        'memoryStateEdit': '编辑协作摘要',
        'memoryStateMore': '摘要如何共享？',
        'memoryGoal': '正在做什么',
        'memoryResult': '做到哪一步',
        'memoryBlocker': '还卡在哪里',
        'memoryNext': '下一步做什么',
        'memoryContextHelp': '这里预览 AI 回答时可参考的约定、记忆与协作摘要。每次发送都会按问题重新选择，未选中的内容仍可按需查询。',
        'memoryContextDetails': '预算只计算这些参考信息，不包含聊天和工具输出。优先提供约定与重点记忆，再考虑相关性和更新时间；内容按完整条目选择。',
        'memoryContextMore': '参考信息怎么选？',
        'memoryBudget': '已使用 / 字符预算',
        'memorySelected': '已纳入参考',
        'memoryOmitted': '按需读取',
        'memoryOverflow': '有重点记忆或约定未纳入。请先读取详情，或减少重点内容、调整预算。',
        'memoryReasonImportant': '优先保留',
        'memoryReasonRelevant': '与当前分身或问题相关',
        'memoryReasonRecent': '近期更新',
        'memoryReasonBudget': '预算不足，保留全文供查询',
        'memoryReasonLimit': '其他分身数量上限',
        'memoryAgreement': '约定',
        'memoryOtherState': '其他分身的摘要',
        'memoryNoContext': '暂无需要注入的条目。',
        'topicThisActivity': '本分身任务',
        'topicAllActivity': '全部任务',
        'topicActivityScope': '任务范围',
        'activityScopeLoading': '正在加载任务…',
        'topicActivityLocalHelp': '只看由当前分身发起的任务。',
        'topicActivityAllHelp': '查看当前实例中所有分身的任务。',
        'taskFromChat': '来自 {name}',
        'toolbarMore': '更多',
        'toolbarMoreLabel': '更多操作',
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
        'activityCollapse': '收起近期活动',
        'activityExpand': '展开近期活动',
        'activityMoreLoading': '加载中…',
        'activityAllLoaded': '已全部加载',
        'activityShown': '已显示 {shown} / {total}',
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
        'modelsDefaultsMode': '当前使用默认集合',
        'modelsSetDefault': '设为默认',
        'modelsSetDefaultHint': '把当前勾选保存为新建实例和新会话的默认模型集合。',
        'modelsDefaultSaved': '已设为默认',
        'modelsDefaultFailed': '保存默认集合失败：{reason}',
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
        'navSwitchFailed': '切换到实例「{instance}」失败，当前会话没有改动（错误信息见上方）。',
        'navUnknown': '通知里的会话 …{session} 不在本页面（可能已关闭或已归档），请从左侧会话列表打开。',
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
        'taskApproval': '等待审批',
        'taskApprovalPolicy': '策略',
        'taskApprovalReason': '原因',
        'taskApprovalHint': 'Worker 正阻塞在权限申请上；允许或拒绝后才会继续。',
        'cancel': '取消',
        'statusQueued': '排队',
        'statusStarting': '启动中',
        'statusWorking': '执行中',
        'statusIdle': '已完成',
        'statusBlocked': '等待',
        'statusBlockedApproval': '等待审批',
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
        'topicTitle': 'Chats and memory',
        'topicNavigation': 'Agent chats',
        'topicManage': 'Manage & memory',
        'topicToggle': 'Show or hide agent chats',
        'topicHelp': 'What are agent chats?',
        'topicHelpBody': 'Think of a chat as a conversation within this Super Agent. Each has its own history, private memory and local agreements. Task resources, instance agreements and shared memories are common; reports and scheduled wake-ups return to their originating chat.',
        'topicHelpExample': 'For example, discuss papers in Research and travel in Everyday. Save common preferences as instance-shared memories.',
        'topicCurrent': 'Current chat',
        'topicOverview': 'Overview',
        'topicNew': 'New chat',
        'topicCreate': 'Create & switch',
        'topicCreateHelp': 'Give one area of work its own conversation. Task resources remain shared with this Super Agent.',
        'topicSettingsSave': 'Save settings',
        'topicSettingsPending': 'Unsaved changes',
        'topicDuplicate': 'A chat already uses this name. Choose another name.',
        'topicName': 'Chat name',
        'topicNamePlaceholder': 'For example: Research, Writing, Everyday',
        'topicSharing': 'Share with other chats',
        'topicPrivate': 'Only this chat',
        'topicPrivateDescription': 'Other chats cannot see this chat\'s name, handoff summary, tasks or conversation.',
        'topicSummary': 'Share handoff summary',
        'topicSummaryDescription': 'Share the name, handoff summary and task status. Conversation text and private memories stay separate.',
        'topicHistory': 'Allow conversation recall',
        'topicHistoryDescription': 'Also allow other chats to read conversation text and related task details on demand.',
        'topicNotes': 'Topic notes',
        'topicSharedNotes': 'Instance shared notes',
        'topicSave': 'Save',
        'topicHide': 'Hide chat',
        'topicHideHelp': 'Hiding removes the tab. Existing tasks and schedules continue.',
        'topicRuleScope': 'Rule scope',
        'topicRuleLocal': 'This chat',
        'topicRuleShared': 'All chats in this instance',
        'topicRestore': 'Restore',
        'topicHidden': 'Hidden chats',
        'topicAdvanced': 'Hide & restore',
        'topicSharingHelp': 'Instance-shared memories are managed on the Memory tab. Restricting sharing cannot retract content already read. Chats use the same host account and file permissions.',
        'topicSharingBoundary': 'Chats share the host\'s file permissions. Content already read by another chat cannot be retracted.',
        'topicNotesHelp': 'Keep short facts, decisions and source references. Shared notes are visible to every topic in this instance. Never store credentials.',
        'memoryTabTopic': 'Chat settings',
        'memoryTabFacts': 'Memory',
        'memoryTabContext': 'AI reference',
        'memorySubtitle': 'Separate history and memory, one Super Agent',
        'memoryLocal': 'Chat-private',
        'memoryScope': 'Memory scope',
        'memoryShared': 'Shared in this instance',
        'memoryLocalHelp': 'Used only by this chat and its workers, for facts and decisions specific to this conversation.',
        'memorySharedHelp': 'Available to all chats in this instance, for common preferences and facts. Chat sharing settings do not withdraw these memories.',
        'memoryHelp': 'How does memory work?',
        'memoryHelpBody': 'You can say “Remember that the deadline is Friday” in chat. To share it, ask “Remember this across this instance…”. You can also add or correct facts here.',
        'memoryHelpDetails': 'Edit the same entry when a fact changes; archive obsolete facts. Important entries receive priority. A same-key private fact overrides its shared value only in this chat.',
        'memoryAdd': 'Add memory',
        'memoryEdit': 'Edit',
        'memoryKey': 'Fact name',
        'memoryKeyHint': 'For example: release date. Update this entry when the fact changes.',
        'memoryLegacy': 'This legacy note was preserved in full. Rewrite it as a concise complete fact before saving; retain trailing qualifications.',
        'memoryText': 'Current fact',
        'memoryImportant': 'Important · retain first',
        'memoryArchive': 'Archive',
        'memoryArchived': 'Show archived',
        'memoryArchivedStatus': 'Archived · not active',
        'memoryArchiveHelp': 'Archived facts are not injected. Restore one to make it active again.',
        'memoryHistory': 'Version history',
        'memoryEmpty': 'No memories in this view. Add a fact or check archived entries.',
        'memorySearch': 'Find memories',
        'memoryReload': 'Load latest version',
        'memoryConflict': 'Another conversation updated this content. Your draft is preserved. Load the latest version before editing again.',
        'memoryRevision': 'Revision',
        'memoryState': 'Handoff summary',
        'memoryStateHelp': 'Tell other chats what is happening here and what is blocked. AI updates it after substantive progress; you can correct it.',
        'memoryStateDetails': 'A brief handoff, not a full transcript or proof of completion. Visibility follows the sharing setting above. You can start chatting without filling this in.',
        'memoryStateEmpty': 'No handoff summary yet. Start chatting; AI maintains it when there is substantive progress.',
        'memoryStateEdit': 'Edit handoff summary',
        'memoryStateMore': 'How is this summary shared?',
        'memoryGoal': 'What is being worked on',
        'memoryResult': 'Current progress',
        'memoryBlocker': 'What is blocked',
        'memoryNext': 'What happens next',
        'memoryContextHelp': 'Preview the agreements, memories and handoff summaries AI can refer to. Each new question selects complete items again; omitted content remains available on demand.',
        'memoryContextDetails': 'This budget excludes chat and tool output. Agreements and important memories come first, followed by relevance and recency. Entries are selected whole.',
        'memoryContextMore': 'How are references selected?',
        'memoryBudget': 'Used / character budget',
        'memorySelected': 'Included for AI',
        'memoryOmitted': 'Read on demand',
        'memoryOverflow': 'Required facts or agreements were omitted. Read them first, reduce important content, or adjust the budget.',
        'memoryReasonImportant': 'Prioritized',
        'memoryReasonRelevant': 'Relevant to this chat or question',
        'memoryReasonRecent': 'Recently updated',
        'memoryReasonBudget': 'Over budget; full text remains available',
        'memoryReasonLimit': 'Other-chat limit',
        'memoryAgreement': 'Agreement',
        'memoryOtherState': 'Other chat summaries',
        'memoryNoContext': 'No items to inject yet.',
        'topicThisActivity': 'This chat\'s tasks',
        'topicAllActivity': 'All tasks',
        'topicActivityScope': 'Task scope',
        'activityScopeLoading': 'Loading tasks…',
        'topicActivityLocalHelp': 'Tasks started by this chat only.',
        'topicActivityAllHelp': 'Tasks from all chats in this instance.',
        'taskFromChat': 'From {name}',
        'toolbarMore': 'More',
        'toolbarMoreLabel': 'More actions',
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
        'activityCollapse': 'Collapse recent activity',
        'activityExpand': 'Expand recent activity',
        'activityMoreLoading': 'Loading…',
        'activityAllLoaded': 'All loaded',
        'activityShown': 'Showing {shown} / {total}',
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
        'modelsDefaultsMode': 'Using the saved default set',
        'modelsSetDefault': 'Set as default',
        'modelsSetDefaultHint': 'Save the current checks as the default model set for new instances and sessions.',
        'modelsDefaultSaved': 'Default saved',
        'modelsDefaultFailed': 'Could not save the default set: {reason}',
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
        'navSwitchFailed': 'Could not switch to instance “{instance}”; the current session was left alone (see the error above).',
        'navUnknown': 'The notifying session …{session} is not in this page (closed or archived); open it from the session list.',
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
        'taskApproval': 'Awaiting approval',
        'taskApprovalPolicy': 'Policy',
        'taskApprovalReason': 'Reason',
        'taskApprovalHint': 'The worker is blocked on a permission request; it continues only after you allow or deny it.',
        'cancel': 'Cancel',
        'statusQueued': 'Queued',
        'statusStarting': 'Starting',
        'statusWorking': 'Working',
        'statusIdle': 'Completed',
        'statusBlocked': 'Waiting',
        'statusBlockedApproval': 'Awaiting approval',
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
        flexWrap: 'wrap',
      },
      titleBlock: { display: 'flex', alignItems: 'center', minWidth: 0, gap: 0 },
      title: { fontSize: 14, fontWeight: 650, letterSpacing: '.01em' },
      titleButton: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 28,
        boxSizing: 'border-box',
        minWidth: 0,
        maxWidth: 260,
        margin: 0,
        padding: '0 8px',
        border: 0,
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        borderRadius: 7,
      },
      nameText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      nameChevron: { display: 'inline-flex', flex: 'none', color: T.textTertiary, transition: 'transform .15s ease' },
      headerAction: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        padding: '0 9px',
        border: 0,
        borderRadius: 7,
        fontFamily: 'inherit',
        fontWeight: 'inherit',
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
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
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
      railTitle: { fontSize: 12, fontWeight: 600, letterSpacing: '.01em', flex: '0 0 auto' },
      railHeaderSpacer: { flex: '1 1 auto' },
      railCollapse: {
        appearance: 'none',
        border: 0,
        background: 'transparent',
        color: T.textTertiary,
        width: 24,
        height: 24,
        padding: 0,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      railShown: { fontSize: 9.5, color: T.textTertiary, opacity: 0.85, padding: '0 8px 4px', flex: '0 0 auto' },
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
      // `flex: 0 0 auto`：正文不能被 flex 容器压缩——否则长 Markdown/代码会被
      // `overflow: hidden` 直接裁掉（旧版单文件预览也有这个问题，只是长的少）。
      // 保持内容高度，让外层 `previewPane` 自己滚。
      previewBody: { flex: '0 0 auto', border: `1px solid ${T.borderSubtle}`, borderRadius: 8, background: 'rgba(127,127,127,.035)', overflow: 'hidden' },
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
      info: ['M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13Z', 'M8 7v4.5', 'M8 4.5v.5'],
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

    const sendJson = postJson
    const readJson = getJson

    /** Selection belongs to this browser surface, never the host's last active tab. */
    function topicRequestUrl(path, { instanceId, topicId = 'main', clientId, activityScope, visible } = {}) {
      const values = { instance_id: instanceId, topic_id: topicId, client_id: clientId, activity_scope: activityScope, visible: visible === undefined ? undefined : visible ? '1' : '0' }
      let result = path
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined || value === '') continue
        const entry = `${key}=${encodeURIComponent(value)}`
        const pattern = new RegExp(`([?&])${key}=[^&]*`)
        result = pattern.test(result) ? result.replace(pattern, (_, separator) => `${separator}${entry}`) : `${result}${result.includes('?') ? '&' : '?'}${entry}`
      }
      return result
    }

    function savedTopic(instanceId) {
      try { return window.sessionStorage?.getItem(`dsh.super-agent.topic.${instanceId}`) || 'main' } catch { return 'main' }
    }

    function rememberTopic(instanceId, topicId) {
      try { window.sessionStorage?.setItem(`dsh.super-agent.topic.${instanceId}`, topicId) } catch { /* In-memory selection still works. */ }
    }

    function topicBarPreference(storage, expanded) {
      try {
        storage ??= window.sessionStorage
        if (expanded !== undefined) storage?.setItem('dsh.super-agent.topicBar', expanded ? '1' : '0')
        return storage?.getItem('dsh.super-agent.topicBar') === '1'
      } catch { return expanded === true }
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
        // This listener runs in capture phase, before a select can consume Esc.
        // Let the inner popup close first and retain the surrounding editor.
        if (event.target?.closest?.('[data-super-agent-popup], [data-super-agent-select][data-open="true"]')) return
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
     * 活动栏只在预览列收起时渲染：预览一开，对话区要同时容纳「正文 + 640 预览」，
     * 再挤一条 292px 的活动栏会把对话压到 244px。所以是**不渲染**（不是盖住），
     * 预览关到最后一个标签后自然回来。
     *
     * @param {{ tabs?: object[] }|undefined} preview 预览状态。
     * @returns {boolean} 是否显示活动栏。
     */
    function activityRailVisible(preview) {
      return !(Array.isArray(preview?.tabs) && preview.tabs.length > 0)
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
      const strip = React.useRef(undefined)

      // 标签多了会横向溢出：新增/激活/关闭标签后把当前标签滚进可视区（只动
      // 标签栏自己的 scrollLeft，不碰会话的滚动）。
      React.useEffect(() => {
        const node = strip.current
        if (node === undefined || node === null || activeTab === undefined) return
        if (typeof node.getBoundingClientRect !== 'function') return
        const children = Array.from(node.children ?? [])
        const current = children.find((child) => child?.getAttribute?.('data-super-agent-preview-tab') === activeTab.id)
        if (current === undefined || typeof current.getBoundingClientRect !== 'function') return
        const tabRect = current.getBoundingClientRect()
        const stripRect = node.getBoundingClientRect()
        if (tabRect.left < stripRect.left) node.scrollLeft -= stripRect.left - tabRect.left
        else if (tabRect.right > stripRect.right) node.scrollLeft += tabRect.right - stripRect.right
      }, [activeTab?.id, list.length, width])

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
          ref: strip,
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
      // 计数口径只在服务端派生一次（lib/task-counts.js）：`active` 已剔除
      // lost/interrupted，`lost` 单独给出（面板徽标只显示 active）。这里不再
      // 自己维护状态表；没有 active 的旧 payload 按 0 处理。
      const tasks = taskCounts !== null && typeof taskCounts === 'object'
        ? Number(taskCounts.active ?? 0)
        : 0
      return {
        active: status.router?.status === 'running',
        workers: Number(status.router?.activeWorkers ?? 0),
        pending: Number(status.router?.pendingTriggers ?? 0),
        tasks: Number.isFinite(tasks) ? tasks : 0,
        lost: Number(taskCounts?.lost ?? 0) || 0,
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
            className: 'sa-name-control sa-instance-switcher',
            style: S.titleButton,
            onClick: onToggle,
            disabled: busy,
            title: t('instanceSwitch'),
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
          },
          h('span', { style: S.nameText }, currentName),
          h('span', {
            style: {
              ...S.nameChevron,
              transform: open ? 'rotate(180deg)' : 'none',
            },
            'aria-hidden': 'true',
          }, h(Glyph, { name: 'chevronDown', size: 12, strokeWidth: 1.2 })),
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
      'blocked-approval': { key: 'statusBlockedApproval', color: '#d9a441', rank: 1 },
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
    function ActivityRow({ task, t, onSelect, selected, showTopic = false }) {
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
          className: task.status === 'working' || task.status === 'starting' || task.status === 'blocked-approval' ? 'sa-pulse' : undefined,
          style: { ...S.activityDot, background: meta.color },
          'aria-hidden': 'true',
        }),
        h('div', { style: S.activityMain },
          h('div', { style: S.activityTitle }, task.title || 'Untitled task'),
          h('div', { style: S.activityMeta },
            h('span', {}, t(meta.key)),
            showTopic && task.topicName ? h('span', { title: format(t, 'taskFromChat', { name: task.topicName }), style: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } }, `· ${format(t, 'taskFromChat', { name: task.topicName })}`) : null,
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
          task.pendingApproval
            ? h('div', { style: S.detailSection },
                h('div', { style: S.detailSectionTitle }, t('taskApproval')),
                h('div', { style: S.reportCard },
                  h('div', { style: S.reportHead },
                    h('span', { style: { width: 6, height: 6, borderRadius: 999, background: '#d9a441' } }),
                    h('span', {}, task.pendingApproval.toolName || 'tool'),
                    task.pendingApproval.askedAt ? h('span', {}, `· ${formatWhen(task.pendingApproval.askedAt)}`) : null,
                  ),
                  h('div', { style: S.pre }, task.pendingApproval.summary || '—'),
                  h('div', { style: S.itemMeta },
                    `${t('taskApprovalPolicy')}: ${task.pendingApproval.policy ?? task.approvalMode ?? 'ask'}`,
                    task.pendingApproval.reason ? ` · ${t('taskApprovalReason')}: ${task.pendingApproval.reason}` : '',
                  ),
                  h('div', { style: { ...S.itemMeta, opacity: 0.75 } }, t('taskApprovalHint')),
                ),
              )
            : null,
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

    // ── 近期活动列表状态机 ───────────────────────────────────────────────────

    /** 默认展示多少条；与「显示更多」每次追加的条数保持一致。 */
    const ACTIVITY_PAGE_SIZE = 6
    const ACTIVITY_DEFAULT_VISIBLE = ACTIVITY_PAGE_SIZE

    function initialActivityList({ loaded = 0, total = 0 } = {}) {
      const safeLoaded = Number.isFinite(loaded) ? Math.max(0, Math.floor(loaded)) : 0
      const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
      return {
        collapsed: false,
        visible: ACTIVITY_DEFAULT_VISIBLE,
        loading: false,
        loaded: safeLoaded,
        total: safeTotal,
        exhausted: false,
      }
    }

    /**
     * 活动列表状态迁移（纯函数，便于 node 测试）。
     *
     * 关键语义：
     *   - `visible` 只由「显示更多」累加；收起/展开不改变已加载行数。
     *   - 展开时恢复到默认数量，而不是全部。
     *   - `total` 与 `visible` 分离，计数永远显示总数。
     */
    function activityListNext(state, action) {
      const current = state ?? initialActivityList()
      switch (action?.type) {
        case 'sync': {
          const loaded = Number.isFinite(action.loaded) ? Math.max(0, Math.floor(action.loaded)) : current.loaded
          const total = Number.isFinite(action.total) ? Math.max(0, Math.floor(action.total)) : current.total
          return { ...current, loaded, total }
        }
        case 'more-start':
          return { ...current, loading: true }
        case 'more-done': {
          const added = Number.isFinite(action.added) ? Math.max(0, Math.floor(action.added)) : 0
          const loaded = Number.isFinite(action.loaded) ? Math.max(0, Math.floor(action.loaded)) : current.loaded + added
          const total = Number.isFinite(action.total) ? Math.max(0, Math.floor(action.total)) : current.total
          return {
            ...current,
            loading: false,
            loaded,
            total,
            visible: Math.min(total, current.visible + added),
            exhausted: action.hasMore === false || added === 0,
          }
        }
        case 'more-fail':
          return { ...current, loading: false }
        case 'reveal-more':
          return { ...current, visible: Math.min(current.loaded, current.total, current.visible + ACTIVITY_PAGE_SIZE) }
        case 'collapse':
          return { ...current, collapsed: true }
        case 'expand':
          return {
            ...current,
            collapsed: false,
            visible: Math.min(ACTIVITY_DEFAULT_VISIBLE, Math.max(current.loaded, 0), Math.max(current.total, 0)),
          }
        default:
          return current
      }
    }

    /** 标题计数、已显示数量与按钮状态都从这里取，避免三处各算一套。 */
    function activityListSummary(state) {
      const current = state ?? initialActivityList()
      const total = Math.max(0, current.total)
      const shown = Math.min(current.visible, current.loaded, total)
      const allLoaded = total === 0 || shown >= total || (current.exhausted === true && shown >= current.loaded)
      return {
        total,
        shown,
        loading: current.loading === true,
        collapsed: current.collapsed === true,
        allLoaded,
        canLoadMore: current.collapsed !== true && current.loading !== true && !allLoaded,
      }
    }

    /**
     * 右侧活动栏：只来自 runtime 的 task 快照，不伪造消息、不展示 Worker 会话。
     * 排序由数据层决定（进行中优先），这里不再 sort，避免分页时两批顺序不一致。
     */
    function ActivityRail({ tasks, total: totalProp, t, detail, detailLoading, detailError, onSelect, selectedId, onBackDetail, onOpenChat, canOpenChat, onSteer, steerBusy, steerError, embedded = false, onLoadMore, scope, onScopeChange, loading = false }) {
      const rows = Array.isArray(tasks) ? tasks : []
      const total = Number.isFinite(totalProp) ? Math.max(0, Math.floor(totalProp)) : rows.length
      const [list, setList] = React.useState(() => initialActivityList({ loaded: rows.length, total }))
      React.useEffect(() => {
        setList((current) => activityListNext(current, { type: 'sync', loaded: rows.length, total }))
      }, [rows.length, total])
      React.useEffect(() => { setList(initialActivityList({ loaded: rows.length, total })) }, [scope])
      const summary = activityListSummary(list)
      const visible = summary.collapsed ? [] : rows.slice(0, list.visible)
      const railStyle = embedded
        ? { ...S.rail, flex: '1 1 auto', width: '100%', borderLeft: 0, height: '100%' }
        : S.rail
      const loadMore = async () => {
        if (!summary.canLoadMore) return
        // 收起后重新展开时先展示已经加载的行，不重复请求或提前显示“已全部加载”。
        if (summary.shown < rows.length) {
          setList((current) => activityListNext(current, { type: 'reveal-more' }))
          return
        }
        if (typeof onLoadMore !== 'function') return
        setList((current) => activityListNext(current, { type: 'more-start' }))
        const cursor = rows.length > 0 ? rows[rows.length - 1]?.cursor : undefined
        try {
          const result = await onLoadMore(cursor)
          if (result === undefined) {
            setList((current) => activityListNext(current, { type: 'more-fail' }))
            return
          }
          setList((current) => activityListNext(current, {
            type: 'more-done',
            added: result.added,
            total: result.total ?? total,
            hasMore: result.hasMore,
          }))
        } catch {
          setList((current) => activityListNext(current, { type: 'more-fail' }))
        }
      }
      const detailNode = !summary.collapsed && (detail !== undefined || detailLoading)
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
            !embedded ? h('div', { style: S.railTitle }, t('activityTitle')) : null,
            summary.total > 0 ? h('span', { style: S.railCount }, summary.total) : null,
            h('button', {
              type: 'button',
              className: 'sa-activity-collapse',
              style: S.railCollapse,
              title: summary.collapsed ? t('activityExpand') : t('activityCollapse'),
              'aria-label': summary.collapsed ? t('activityExpand') : t('activityCollapse'),
              'aria-expanded': summary.collapsed ? 'false' : 'true',
              onClick: () => setList((current) => activityListNext(current, { type: current.collapsed ? 'expand' : 'collapse' })),
            }, h(Glyph, { name: summary.collapsed ? 'chevronRight' : 'chevronDown', size: 12, strokeWidth: 1.2 })),
            h('span', { style: S.railHeaderSpacer }),
            typeof onScopeChange === 'function' ? h(SelectMenu, {
              value: scope, onChange: onScopeChange, ariaLabel: t('topicActivityScope'),
              style: { ...S.headerAction, width: 'auto', padding: '0 5px', height: 24, background: 'transparent' },
              options: [
                { value: 'topic', label: t('topicThisActivity'), description: t('topicActivityLocalHelp') },
                { value: 'instance', label: t('topicAllActivity'), description: t('topicActivityAllHelp') },
              ],
            }) : null,
          ),
          !summary.collapsed && summary.total > 0
            ? h('div', { style: S.railShown }, format(t, 'activityShown', { shown: summary.shown, total: summary.total }))
            : null,
          summary.collapsed
            ? null
            : h('div', { className: 'sa-activity-scroll', style: S.railScroll },
              visible.length === 0
                ? h('div', { style: S.empty }, t(loading ? 'activityScopeLoading' : 'activityEmpty'))
                : visible.map((task) => h(ActivityRow, {
                    key: task.id,
                    task,
                    t,
                    onSelect,
                    selected: selectedId === task.id,
                    showTopic: scope === 'instance',
                  })),
              summary.total > ACTIVITY_DEFAULT_VISIBLE || summary.shown > ACTIVITY_DEFAULT_VISIBLE
                ? h('button', {
                    type: 'button',
                    className: 'sa-more-button',
                    style: S.moreButton,
                    disabled: summary.loading || summary.allLoaded,
                    'aria-busy': summary.loading ? 'true' : undefined,
                    onClick: () => { if (summary.canLoadMore) void loadMore() },
                  }, summary.loading ? t('activityMoreLoading') : summary.allLoaded ? t('activityAllLoaded') : t('showMore'))
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
      // 宿主目录不可用（catalogTotal=0）时仍展示已保存的模型，否则面板会一片空白，
      // 用户既看不到默认集合也无法取消勾选。目录可用时仍以目录为准，避免把已经
      // 下架的模型重新塞回可调用列表。
      if ((data?.catalogTotal ?? 0) === 0) {
        const seen = new Set(out.map((entry) => entry.key))
        for (const model of Array.isArray(data?.models) ? data.models : []) {
          const key = `${model.provider}/${model.model}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({
            key,
            name: model.label || model.modelName || model.model,
            provider: model.provider,
            providerName: model.providerName ?? model.provider,
            model: model.model,
            description: model.description,
            efforts: Array.isArray(model.efforts) ? model.efforts : [],
            defaultEffort: model.defaultEffort,
            available: model.available,
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
          on: data?.mode === 'all' || data?.mode === 'filtered' || data?.mode === 'defaults' ? true : existing !== undefined,
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
        const width = Math.min(Math.max(rect.width, options.some((option) => option.description) ? 280 : 180), 420, window.innerWidth - 16)
        const height = Math.min(320, options.reduce((sum, option) => sum + (option.description ? 78 : 32), 8))
        const below = window.innerHeight - rect.bottom - 12
        const above = rect.top - 12
        const down = below >= Math.min(height, above)
        const maxHeight = Math.min(320, Math.max(80, down ? below : above))
        const top = down ? rect.bottom + 4 : Math.max(8, rect.top - Math.min(height, maxHeight) - 4)
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
        setPosition({ left, top, width, maxHeight })
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
      React.useEffect(() => {
        if (!open) return
        const choices = rootRef.current?.querySelectorAll('[role="option"]:not(:disabled)')
        const active = Array.from(choices ?? []).find((node) => node.getAttribute('aria-selected') === 'true')
        const target = active ?? choices?.[0]
        target?.focus?.()
      }, [open])
      const selected = options.find((option) => option.value === value)
      return h('div', { ref: rootRef, 'data-super-agent-select': '', 'data-open': open ? 'true' : undefined, style: { position: 'relative', minWidth: 0, maxWidth: '100%' }, onKeyDown: (event) => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); buttonRef.current?.focus?.(); return }
        if (event.key === 'Tab') { close(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        if (!open) { show(); return }
        const choices = Array.from(rootRef.current?.querySelectorAll('[role="option"]:not(:disabled)') ?? [])
        const index = choices.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length
        choices[next]?.focus?.()
      } },
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
          h('span', { style: { color: T.textTertiary, display: 'inline-flex', flex: '0 0 auto' } }, h(Glyph, { name: 'chevronDown', size: 12, strokeWidth: 1.2 })),
        ),
        open && position !== undefined
          ? h('div', {
              role: 'listbox',
              'aria-label': ariaLabel,
              'data-super-agent-popup': 'true',
              style: {
                position: 'fixed',
                left: position.left,
                top: position.top,
                width: position.width,
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: position.maxHeight,
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
                buttonRef.current?.focus?.()
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
            }, h('span', { style: { display: 'block', fontWeight: 550 } }, option.label), option.description ? h('span', { style: { display: 'block', marginTop: 4, color: T.textSecondary, fontSize: 11.5, lineHeight: 1.5 } }, option.description) : null)),
          )
          : null,
      )
    }

    function ModelsPanel({ t, data, loading, saving, error, onClose, onSave, onSaveAll, onSaveDefault }) {
      const [draft, setDraft] = React.useState(() => initialModelDraft(data))
      const [localError, setLocalError] = React.useState('')
      const [defaultBusy, setDefaultBusy] = React.useState(false)
      const [defaultNotice, setDefaultNotice] = React.useState('')
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
      /** 当前勾选要落盘的条目；保存 allowlist 与「设为默认」共用同一份映射。 */
      const selectedEntries = () => entries.filter((entry) => draft.checked[entry.key]?.on).map((entry) => {
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
      const save = () => {
        if (selectedKeys.length === 0) {
          setLocalError(t('modelsEmpty'))
          return
        }
        setLocalError('')
        onSave({ allowed: selectedEntries(), default: draft.defaultId, defaultEffort: draft.checked[draft.defaultId]?.defaultEffort })
      }
      const saveAsDefault = async () => {
        if (selectedKeys.length === 0) {
          setLocalError(t('modelsEmpty'))
          return
        }
        if (typeof onSaveDefault !== 'function') return
        setLocalError('')
        setDefaultNotice('')
        setDefaultBusy(true)
        try {
          const saved = await onSaveDefault(selectedEntries())
          if (saved !== undefined && saved !== null) setDefaultNotice(t('modelsDefaultSaved'))
        } finally {
          setDefaultBusy(false)
        }
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
            h('span', { style: { ...S.badge, opacity: 0.7 } }, data.mode === 'all' ? t('modelsAllMode') : (data.mode === 'defaults' ? t('modelsDefaultsMode') : (data.mode === 'filtered' ? format(t, 'modelsFiltered', { count: data.configuredCount ?? data.models?.length ?? 0 }) : format(t, 'modelsConfigured', { count: data.configuredCount ?? data.models?.length ?? 0 })))),
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
            h('div', { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center', marginBottom: 2, flexWrap: 'wrap', gap: 6 } },
              h('div', { style: { ...S.detailSectionTitle, marginBottom: 0 } }, t('modelsAllowlist')),
              h('div', { style: { ...S.row, gap: 6, alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  style: S.button,
                  disabled: saving || loading || defaultBusy || selectedKeys.length === 0,
                  title: t('modelsSetDefaultHint'),
                  onClick: () => { void saveAsDefault() },
                }, defaultBusy ? t('modelsSaving') : t('modelsSetDefault')),
                h('span', { style: { ...S.badge, opacity: 0.9 } }, format(t, 'modelsSelected', { count: selectedKeys.length })),
              ),
            ),
            h('div', { style: { ...S.hint, margin: '0 0 8px' } }, t('modelsToggleHint')),
            defaultNotice ? h('div', { style: { ...S.hint, color: T.accent, margin: '0 0 6px' } }, defaultNotice) : null,
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
      const startNew = () => setDraft({ id: undefined, title: '', text: '', project: '', mode: 'append', enabled: true, scope: data?.topicId && data.topicId !== 'main' ? 'topic' : 'instance' })
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
          draft.id === undefined && data?.topicId && data.topicId !== 'main' ? h(Field, { label: t('topicRuleScope') },
            h(SelectMenu, { value: draft.scope, options: [{ value: 'topic', label: t('topicRuleLocal') }, { value: 'instance', label: t('topicRuleShared') }], onChange: (scope) => setDraft({ ...draft, scope }), ariaLabel: t('topicRuleScope') }),
          ) : null,
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
                  h('span', { style: { ...S.badge, opacity: 0.7 } }, item.topicId ? data.topics?.find((row) => row.id === item.topicId)?.name ?? item.topicId : t('topicRuleShared')),
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
                h('div', { style: S.itemTitle }, schedule.title, schedule.topicName ? h('span', { style: S.badge }, schedule.topicName) : null, h('span', { style: { ...S.badge, opacity: 0.65 } }, schedule.state ?? 'scheduled')),
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

    const MEMORY_CARD = { border: `1px solid ${T.borderSubtle}`, borderRadius: 10, padding: 14, background: T.surface, display: 'flex', flexDirection: 'column', gap: 10 }
    const MEMORY_ROW = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
    const MEMORY_HINT = { margin: 0, color: T.textSecondary, fontSize: 12, lineHeight: 1.6 }
    const MEMORY_TEXT = { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65, fontSize: 13 }

    function sharingOptions(t) {
      return [['private', 'topicPrivate'], ['summary', 'topicSummary'], ['history', 'topicHistory']]
        .map(([value, label]) => ({ value, label: t(label), description: t(`${label}Description`) }))
    }

    function HelpDisclosure({ label, paragraphs }) {
      return h('details', { className: 'sa-help' },
        h('summary', { style: { ...S.headerAction, height: 'auto', minHeight: 24, padding: '2px 0', gap: 5, color: T.textSecondary, listStyle: 'none' } }, h(Glyph, { name: 'info', size: 14 }), label),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7, margin: '7px 0 2px', padding: '0 0 0 12px', borderLeft: `2px solid ${T.border}` } }, ...paragraphs.map((paragraph, index) => h('p', { key: index, style: MEMORY_HINT }, paragraph))))
    }

    function ToolbarMore({ t, actions }) {
      const root = React.useRef(null)
      React.useEffect(() => {
        const outside = (event) => { if (root.current && !root.current.contains(event.target)) root.current.open = false }
        document.addEventListener('pointerdown', outside)
        return () => document.removeEventListener('pointerdown', outside)
      }, [])
      return h('details', { ref: root, className: 'sa-toolbar-more', style: { position: 'relative', flex: 'none' }, onKeyDown: (event) => {
        if (event.key !== 'Escape' || !root.current?.open) return
        event.preventDefault(); event.stopPropagation()
        root.current.open = false
        root.current.querySelector('summary')?.focus?.()
      } },
        h('summary', { className: 'sa-header-action', style: { ...S.headerAction, gap: 4, listStyle: 'none' }, 'aria-label': t('toolbarMoreLabel') }, t('toolbarMore'), h(Glyph, { name: 'chevronDown', size: 12 })),
        h('div', { role: 'group', 'aria-label': t('toolbarMoreLabel'), style: { ...S.instanceMenu, left: 'auto', right: 0, width: 180, maxWidth: 'calc(100vw - 20px)' } }, ...actions.filter(Boolean).map((action) => h('button', {
          key: action.key, type: 'button', className: 'sa-menu-action', style: { ...S.instanceRow, color: action.danger ? 'var(--dsw-alias-state-error-primary, #d95c5c)' : T.text },
          disabled: action.disabled, title: action.title,
          onClick: () => { if (!action.keepOpen && root.current) root.current.open = false; action.run() },
        }, action.label))))
    }

    function TopicStrip({ id, expanded, t, topics, topicId, busy, onSelect, onCreate, onManage }) {
      return h('nav', { id, hidden: !expanded, 'aria-label': t('topicNavigation'), 'data-super-agent-topic-bar': '', style: { display: expanded ? 'flex' : 'none', alignItems: 'center', gap: 4, height: 32, padding: '0 12px', boxSizing: 'border-box', borderBottom: `1px solid ${T.borderSubtle}`, flex: '0 0 auto' } },
        h('div', { role: 'tablist', 'aria-label': t('topicNavigation'), style: { display: 'flex', gap: 2, overflowX: 'auto', flex: 1, minWidth: 0 } },
          ...topics.filter((row) => !row.archived).map((row) => h('button', {
            key: row.id, type: 'button', role: 'tab', 'aria-selected': row.id === topicId, 'data-topic-id': row.id, 'data-active': row.id === topicId ? 'true' : undefined,
            className: 'sa-header-action', style: { ...S.headerAction, height: 24, padding: '0 8px', maxWidth: 180 }, disabled: busy,
            title: row.name, onClick: () => onSelect(row.id),
          }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, row.id === 'main' ? t('topicOverview') : row.name), row.unread > 0 ? h('span', { style: { marginLeft: 5, color: T.textTertiary, fontSize: 10 } }, row.unread) : null))),
        h('button', { type: 'button', className: 'sa-header-action', style: { ...S.headerAction, height: 24, gap: 3, padding: '0 7px' }, disabled: busy, onClick: onCreate }, h(Glyph, { name: 'plus', size: 12 }), t('topicNew')),
        h('button', { type: 'button', className: 'sa-header-action', style: { ...S.headerAction, height: 24, padding: '0 7px' }, disabled: busy, onClick: onManage }, t('topicManage')))
    }

    function TopicCreateForm({ t, busy, onCreate, onCancel }) {
      const [name, setName] = React.useState('')
      const [sharing, setSharing] = React.useState('summary')
      const nameField = React.useRef(null)
      const options = sharingOptions(t)
      return h('form', { style: MEMORY_CARD, onSubmit: async (event) => {
        event.preventDefault()
        if (busy || !name.trim()) return
        if (await onCreate(name.trim(), sharing) === true) onCancel()
        else nameField.current?.focus?.()
      } },
        h(Field, { label: t('topicName') }, h('input', { ref: nameField, style: { ...S.input, width: '100%' }, value: name, maxLength: 60, required: true, autoFocus: true, placeholder: t('topicNamePlaceholder'), 'aria-label': t('topicName'), onChange: (event) => setName(event.target.value) })),
        h(Field, { label: t('topicSharing') }, h(SelectMenu, { value: sharing, options, disabled: busy, ariaLabel: t('topicSharing'), onChange: setSharing })),
        h('p', { style: MEMORY_HINT }, options.find((option) => option.value === sharing)?.description),
        h('p', { style: MEMORY_HINT }, t('topicSharingBoundary')),
        h('div', { style: MEMORY_ROW }, h('button', { type: 'submit', style: S.buttonPrimary, disabled: busy || !name.trim() }, t('topicCreate')), h('button', { type: 'button', style: S.button, disabled: busy, onClick: onCancel }, t('cancel'))))
    }

    function StatePreview({ t, topic }) {
      const fields = [['goal', 'memoryGoal'], ['result', 'memoryResult'], ['blocker', 'memoryBlocker'], ['next_step', 'memoryNext']].filter(([key]) => topic.state?.[key])
      return fields.length ? h('dl', { style: { display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: '8px 12px', margin: 0, fontSize: 12.5, lineHeight: 1.6 } },
        ...fields.map(([key, label]) => h(React.Fragment, { key }, h('dt', { style: { color: T.textSecondary } }, t(label)), h('dd', { style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, topic.state[key]))))
        : h('p', { style: MEMORY_HINT }, t('memoryStateEmpty'))
    }

    function MemoryCheck({ checked, label, onChange }) {
      return h('button', { type: 'button', role: 'checkbox', 'aria-checked': checked, onClick: () => onChange(!checked), style: { ...MEMORY_ROW, padding: 0, border: 0, background: 'transparent', color: T.textSecondary, cursor: 'pointer', font: 'inherit', fontSize: 12, textAlign: 'start' } },
        h('span', { 'aria-hidden': true, style: { width: 15, height: 15, borderRadius: 4, border: `1px solid ${checked ? T.accent : T.border}`, background: checked ? T.accent : T.surface, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 } }, checked ? h(Glyph, { name: 'check', size: 12, strokeWidth: 1.6 }) : null), label)
    }

    function MemoryEditor({ t, entry, busy, onSave, onCancel }) {
      const [draft, setDraft] = React.useState(() => ({ key: entry?.key ?? '', text: entry?.text ?? '', priority: entry?.priority ?? 'normal', revision: entry?.revision }))
      const stale = entry && draft.revision !== entry.revision
      const set = (patch) => setDraft((value) => ({ ...value, ...patch }))
      return h('form', { style: { ...MEMORY_CARD, borderColor: T.accent }, onSubmit: async (event) => {
        event.preventDefault()
        if (stale || busy) return
        if (await onSave({ memory_action: 'save', key: draft.key.trim(), text: draft.text.trim(), priority: draft.priority, ...(entry ? { id: entry.id, expected_revision: draft.revision } : {}) }) === true) onCancel()
      } },
        h('strong', {}, t(entry ? 'memoryEdit' : 'memoryAdd')),
        entry?.legacy ? h('p', { style: MEMORY_HINT }, t('memoryLegacy')) : null,
        stale ? h('div', { role: 'alert', style: MEMORY_HINT }, t('memoryConflict'), ' ', h('button', { type: 'button', style: S.smallButton, onClick: () => setDraft({ key: entry.key, text: entry.text, priority: entry.priority, revision: entry.revision }) }, t('memoryReload'))) : null,
        h(Field, { label: t('memoryKey') }, h('input', { style: { ...S.input, width: '100%' }, value: draft.key, maxLength: 64, required: true, autoFocus: true, placeholder: t('memoryKeyHint'), 'aria-label': t('memoryKey'), onChange: (event) => set({ key: event.target.value }) })),
        h(Field, { label: t('memoryText') }, h('textarea', { style: { ...S.input, width: '100%', minHeight: 115, resize: 'vertical', lineHeight: 1.6 }, value: draft.text, maxLength: 1200, required: true, 'aria-label': t('memoryText'), onChange: (event) => set({ text: event.target.value }) })),
        h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between' } },
          h(MemoryCheck, { checked: draft.priority === 'important', label: t('memoryImportant'), onChange: (checked) => set({ priority: checked ? 'important' : 'normal' }) }),
          h('span', { style: MEMORY_HINT }, `${Array.from(draft.text).length} / 1200`)),
        h('div', { style: MEMORY_ROW }, h('button', { type: 'submit', style: S.buttonPrimary, disabled: busy || stale || !draft.key.trim() || !draft.text.trim() || Array.from(draft.text).length > 1200 }, t('topicSave')), h('button', { type: 'button', style: S.button, onClick: onCancel }, t('cancel'))),
      )
    }

    function TopicStateEditor({ t, topic, busy, onSave }) {
      const [draft, setDraft] = React.useState(() => ({ ...topic.state }))
      const [revision, setRevision] = React.useState(topic.stateRevision ?? 0)
      const stale = revision !== (topic.stateRevision ?? 0)
      return h('form', { style: MEMORY_CARD, onSubmit: async (event) => {
        event.preventDefault()
        if (stale || busy) return
        const result = await onSave({ action: 'state', state: draft, expected_revision: revision })
        if (result === true) setRevision(revision + 1)
      } },
        h('p', { style: MEMORY_HINT }, t('memoryStateDetails')),
        stale ? h('div', { role: 'alert', style: MEMORY_HINT }, t('memoryConflict'), ' ', h('button', { type: 'button', style: S.smallButton, onClick: () => { setDraft({ ...topic.state }); setRevision(topic.stateRevision ?? 0) } }, t('memoryReload'))) : null,
        ...[['goal', 'memoryGoal'], ['result', 'memoryResult'], ['blocker', 'memoryBlocker'], ['next_step', 'memoryNext']].map(([key, label]) => h(Field, { key, label: t(label) }, h('textarea', { style: { ...S.input, width: '100%', minHeight: 58, resize: 'vertical' }, value: draft[key] ?? '', maxLength: 240, 'aria-label': t(label), onChange: (event) => setDraft((value) => ({ ...value, [key]: event.target.value })) }))),
        h('div', { style: MEMORY_ROW }, h('button', { type: 'submit', style: S.buttonPrimary, disabled: busy || stale }, t('topicSave')), h('span', { style: MEMORY_HINT }, `${t('memoryRevision')} ${revision}`)),
      )
    }

    function TopicsPanel({ t, topics, topicId, memory, contextPlan, busy, error, onClose, onCreate, onUpdate, onAction, initialCreate = false }) {
      const current = topics.find((row) => row.id === topicId) ?? { id: 'main', name: t('topicOverview'), sharing: 'summary', state: {} }
      const [tab, setTab] = React.useState('topic')
      const [scope, setScope] = React.useState('topic')
      const [name, setName] = React.useState(current.name)
      const [sharing, setSharing] = React.useState(current.sharing)
      const [creating, setCreating] = React.useState(initialCreate)
      const [editing, setEditing] = React.useState('')
      const [archived, setArchived] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const all = memory?.[scope] ?? []
      const entries = all.filter((row) => (archived ? row.status === 'archived' : row.status === 'active') && (!query || `${row.key} ${row.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
      const selected = new Set((contextPlan?.selected ?? []).map((row) => row.id))
      const entry = all.find((row) => row.id === editing)
      const memoryAction = (body) => onAction({ action: 'memory', scope, ...body })
      const tabs = [['topic', 'memoryTabTopic'], ['facts', 'memoryTabFacts'], ['context', 'memoryTabContext']]
      const segmented = (active) => ({ ...S.headerAction, flex: 1, background: active ? T.surface : 'transparent', color: active ? T.text : T.textSecondary, fontWeight: active ? 600 : 400 })
      const labelFor = (row) => t(row.kind === 'agreement' ? 'memoryAgreement' : row.kind === 'state' ? row.scope === 'other' ? 'memoryOtherState' : 'memoryState' : row.scope === 'instance' ? 'memoryShared' : 'memoryLocal')
      const reasonFor = (reason) => t(reason === 'important' ? 'memoryReasonImportant' : reason === 'relevant' ? 'memoryReasonRelevant' : reason === 'budget' ? 'memoryReasonBudget' : reason === 'topic_limit' ? 'memoryReasonLimit' : 'memoryReasonRecent')
      const contextItems = (items) => items.length ? items.map((row) => h('div', { key: row.id, style: MEMORY_CARD },
        h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between' } }, h('strong', { style: { fontSize: 13, overflowWrap: 'anywhere' } }, row.key), h('span', { style: MEMORY_HINT }, labelFor(row))),
        h('p', { style: MEMORY_TEXT }, row.kind === 'state' ? row.text.replace(/^(goal|result|blocker|next_step):/gm, (match, key) => `${t({ goal: 'memoryGoal', result: 'memoryResult', blocker: 'memoryBlocker', next_step: 'memoryNext' }[key])}:`) : row.text), h('span', { style: MEMORY_HINT }, reasonFor(row.reason)))) : [h('p', { key: 'empty', style: S.empty }, t('memoryNoContext'))]
      return h(Drawer, { title: t('topicTitle'), t, onClose, wide: true, bodyStyle: { padding: '16px 20px 24px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13 }, 'data-super-agent-topics-panel': '' },
          h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between', alignItems: 'flex-start' } },
            h('div', { style: { flex: 1, minWidth: 0 } }, h('span', { style: MEMORY_HINT }, t(creating ? 'topicNavigation' : 'topicCurrent')), h('div', { style: { fontSize: 17, fontWeight: 600, margin: '3px 0 4px', overflowWrap: 'anywhere' } }, creating ? t('topicNew') : current.name), h('p', { style: MEMORY_HINT }, t(creating ? 'topicCreateHelp' : 'memorySubtitle'))),
            !creating ? h('button', { type: 'button', className: 'sa-header-action', style: { ...S.headerAction, gap: 4, background: T.surface2 }, disabled: busy, onClick: () => setCreating(true) }, h(Glyph, { name: 'plus', size: 12 }), t('topicNew')) : null),
          h(HelpDisclosure, { label: t('topicHelp'), paragraphs: [t('topicHelpBody'), t('topicHelpExample')] }),
          !creating ? h('div', { role: 'tablist', 'aria-label': t('topicTitle'), style: { display: 'flex', gap: 4, borderBottom: `1px solid ${T.borderSubtle}` } }, ...tabs.map(([value, label]) => h('button', { key: value, type: 'button', role: 'tab', 'aria-selected': tab === value, className: 'sa-header-action', style: { ...segmented(false), height: 34, borderRadius: 0, borderBottom: `2px solid ${tab === value ? T.accent : 'transparent'}`, marginBottom: -1, color: tab === value ? T.text : T.textSecondary }, onClick: () => setTab(value) }, t(label)))) : null,
          error ? h('div', { role: 'alert', style: S.error }, error) : null,
          creating ? h(TopicCreateForm, { t, busy, onCreate, onCancel: () => setCreating(false) }) : null,
          !creating && tab === 'topic' ? h(React.Fragment, {},
            h('div', { style: MEMORY_CARD },
              h(Field, { label: t('topicName') }, h('input', { style: { ...S.input, width: '100%' }, value: name, maxLength: 60, 'aria-label': t('topicName'), onChange: (event) => setName(event.target.value) })),
              h(Field, { label: t('topicSharing') }, h(SelectMenu, { value: sharing, options: sharingOptions(t), disabled: busy, ariaLabel: t('topicSharing'), onChange: setSharing })),
              h('p', { style: MEMORY_HINT }, sharingOptions(t).find((option) => option.value === sharing)?.description),
              h('p', { style: MEMORY_HINT }, t('topicSharingHelp')),
              h('div', { style: MEMORY_ROW }, h('button', { type: 'button', style: S.buttonPrimary, disabled: busy || !name.trim(), onClick: () => onUpdate({ topic_id: current.id, name, sharing }) }, t('topicSettingsSave')), name !== current.name || sharing !== current.sharing ? h('span', { style: MEMORY_HINT }, t('topicSettingsPending')) : null)),
            h('section', { style: MEMORY_CARD },
              h('strong', {}, t('memoryState')), h('p', { style: MEMORY_HINT }, t('memoryStateHelp')),
              h(HelpDisclosure, { label: t('memoryStateMore'), paragraphs: [t('memoryStateDetails')] }),
              h(StatePreview, { t, topic: current }),
              h('details', {}, h('summary', { style: { ...MEMORY_HINT, cursor: 'pointer', paddingTop: 6 } }, t('memoryStateEdit')), h('div', { style: { marginTop: 10 } }, h(TopicStateEditor, { key: current.id, t, topic: current, busy, onSave: onAction })))),
            current.id !== 'main' || topics.some((row) => row.archived) ? h('details', { style: { ...MEMORY_HINT, padding: '0 2px' } }, h('summary', { style: { cursor: 'pointer' } }, t('topicAdvanced')),
              current.id !== 'main' ? h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between', marginTop: 10 } }, h('p', { style: { ...MEMORY_HINT, flex: 1 } }, t('topicHideHelp')), h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => onUpdate({ topic_id: current.id, archived: true }) }, t('topicHide'))) : null,
              ...topics.filter((row) => row.archived).map((row) => h('div', { key: row.id, style: { ...MEMORY_ROW, justifyContent: 'space-between', marginTop: 10 } }, h('span', {}, row.name), h('button', { type: 'button', style: S.smallButton, disabled: busy, onClick: () => onUpdate({ topic_id: row.id, archived: false }) }, t('topicRestore'))))) : null,
          ) : null,
          !creating && tab === 'facts' ? h(React.Fragment, {},
            h('div', { role: 'group', 'aria-label': t('memoryScope'), style: { ...MEMORY_ROW, gap: 3, padding: 4, background: T.surface2, borderRadius: 11 } }, ...['topic', 'instance'].map((value) => h('button', { key: value, type: 'button', 'aria-pressed': scope === value, style: segmented(scope === value), onClick: () => { setScope(value); setEditing(''); setQuery(''); setArchived(false) } }, t(value === 'topic' ? 'memoryLocal' : 'memoryShared')))),
            h('p', { style: MEMORY_HINT }, t(scope === 'topic' ? 'memoryLocalHelp' : 'memorySharedHelp')),
            h(HelpDisclosure, { label: t('memoryHelp'), paragraphs: [t('memoryHelpBody'), t('memoryHelpDetails')] }),
            h('div', { style: MEMORY_ROW }, h('input', { type: 'search', style: { ...S.input, flex: 1, minWidth: 0 }, placeholder: t('memorySearch'), 'aria-label': t('memorySearch'), value: query, onChange: (event) => setQuery(event.target.value) }), h('button', { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: () => { setArchived(false); setEditing('new') } }, t('memoryAdd'))),
            h(MemoryCheck, { checked: archived, label: t('memoryArchived'), onChange: (checked) => { setArchived(checked); setEditing('') } }),
            archived ? h('p', { style: MEMORY_HINT }, t('memoryArchiveHelp')) : null,
            editing === 'new' || entry ? h(MemoryEditor, { key: `${scope}/${editing}`, t, entry, busy, onSave: memoryAction, onCancel: () => setEditing('') }) : null,
            ...entries.map((row) => h('article', { key: row.id, style: MEMORY_CARD },
              h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between' } }, h('strong', { style: { overflowWrap: 'anywhere' } }, `${row.priority === 'important' ? '★ ' : ''}${row.key}`), h('span', { style: { ...MEMORY_HINT, fontSize: 11 } }, row.status === 'archived' ? t('memoryArchivedStatus') : selected.has(row.id) ? t('memorySelected') : t('memoryOmitted'))),
              h('p', { style: MEMORY_TEXT }, row.text),
              h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between' } }, h('span', { style: { ...MEMORY_HINT, fontSize: 11 } }, `${t('memoryRevision')} ${row.revision} · ${new Date(row.updatedAt).toLocaleDateString()}`),
                h('div', { style: MEMORY_ROW }, row.status === 'active' ? h('button', { type: 'button', style: S.smallButton, disabled: busy, onClick: () => setEditing(row.id) }, t('memoryEdit')) : null, h('button', { type: 'button', style: S.smallButton, disabled: busy, onClick: async () => { if (await memoryAction({ memory_action: row.status === 'active' ? 'archive' : 'restore', id: row.id, expected_revision: row.revision }) === true && editing === row.id) setEditing('') } }, t(row.status === 'active' ? 'memoryArchive' : 'topicRestore')))),
              row.history?.length ? h('details', {}, h('summary', { style: { ...MEMORY_HINT, cursor: 'pointer' } }, `${t('memoryHistory')} (${row.history.length})`), ...row.history.map((old) => h('div', { key: old.revision, style: { borderTop: `1px solid ${T.borderSubtle}`, paddingTop: 10, marginTop: 10 } }, h('span', { style: MEMORY_HINT }, `${t('memoryRevision')} ${old.revision} · ${t('memoryHistory')}`), h('p', { style: MEMORY_TEXT }, old.text)))) : null,
            )),
            !entries.length && editing !== 'new' ? h('p', { style: S.empty }, t('memoryEmpty')) : null,
          ) : null,
          !creating && tab === 'context' ? h(React.Fragment, {},
            h(HelpDisclosure, { label: t('memoryContextMore'), paragraphs: [t('memoryContextDetails')] }),
            h('div', { style: MEMORY_CARD }, h('p', { style: MEMORY_HINT }, t('memoryContextHelp')), h('div', { style: { ...MEMORY_ROW, justifyContent: 'space-between' } }, h('strong', {}, `${contextPlan?.usedChars ?? 0} / ${contextPlan?.maxChars ?? 12000}`), h('span', { style: MEMORY_HINT }, t('memoryBudget'))), h('progress', { value: contextPlan?.usedChars ?? 0, max: contextPlan?.maxChars ?? 12000, 'aria-label': t('memoryBudget'), style: { width: '100%', height: 8, accentColor: T.accent } })),
            contextPlan?.importantOmitted > 0 ? h('div', { role: 'alert', style: { ...MEMORY_CARD, borderColor: '#b88427', background: 'rgba(180,130,40,.08)' } }, t('memoryOverflow')) : null,
            h('strong', {}, `${t('memorySelected')} · ${contextPlan?.selected?.length ?? 0}`), ...contextItems(contextPlan?.selected ?? []),
            h('details', {}, h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginBottom: 12 } }, `${t('memoryOmitted')} · ${contextPlan?.omitted?.length ?? 0}`), h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, ...contextItems(contextPlan?.omitted ?? []))),
          ) : null,
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
          const saved = window.sessionStorage?.getItem('dsh.super-agent.instance') ?? window.localStorage.getItem('dsh.super-agent.instance')
          return typeof saved === 'string' ? saved : ''
        } catch {
          return ''
        }
      })
      // 重挂时先按内存里的续接值渲染同一条 Router，再等宿主快照确认；
      // 这样不会先闪一帧「新会话」落地页。
      const [topicId, setTopicId] = React.useState(() => savedTopic(instanceId))
      const [topics, setTopics] = React.useState([])
      const [topicsExpanded, setTopicsExpanded] = React.useState(() => topicBarPreference())
      const topicBarId = React.useRef(`sa-topic-bar-${Math.random().toString(36).slice(2)}`).current
      const [topicCreateMode, setTopicCreateMode] = React.useState(false)
      const [sharedNotes, setSharedNotes] = React.useState('')
      const [memoryData, setMemoryData] = React.useState(undefined)
      const [contextPlan, setContextPlan] = React.useState(undefined)
      const [topicBusy, setTopicBusy] = React.useState(false)
      const [topicError, setTopicError] = React.useState('')
      const [activityScope, setActivityScope] = React.useState(() => savedTopic(instanceId) === 'main' ? 'instance' : 'topic')
      const [activitySnapshotScope, setActivitySnapshotScope] = React.useState(() => savedTopic(instanceId) === 'main' ? 'instance' : 'topic')
      const [sessionId, setSessionId] = React.useState(() => cachedPanelSession(topicId === 'main' ? instanceId : `${instanceId}/${topicId}`))
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
      const [activityTotal, setActivityTotal] = React.useState(undefined)
      const [activityLoadingMore, setActivityLoadingMore] = React.useState(false)
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
      const topicRef = React.useRef(topicId)
      const activityScopeRef = React.useRef(activityScope)
      const selectionVersion = React.useRef(0)
      const clientId = React.useRef(window.__SA_TOPIC_CLIENT_ID ?? `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
      window.__SA_TOPIC_CLIENT_ID = clientId.current
      const scopedUrl = React.useCallback((path, body = {}) => topicRequestUrl(path, {
        instanceId: body.instance_id ?? instanceRef.current, topicId: body.topic_id ?? topicRef.current,
        clientId: clientId.current, activityScope: activityScopeRef.current, visible: panelVisibleNow(),
      }), [])
      const postJson = React.useCallback((path, body = {}) => sendJson(scopedUrl(path, body), body), [scopedUrl])
      const getJson = React.useCallback((path) => readJson(scopedUrl(path)), [scopedUrl])
      const detailRequest = React.useRef('')
      const modelsAttempted = React.useRef(false)

      React.useEffect(() => { instanceRef.current = instanceId }, [instanceId])
      React.useEffect(() => { topicRef.current = topicId; rememberTopic(instanceId, topicId) }, [topicId, instanceId])
      React.useEffect(() => { activityScopeRef.current = activityScope }, [activityScope])
      React.useEffect(() => () => { mounted.current = false }, [])

      /** 所有会话切换的唯一入口（见 sessionTransition）：事件回调不走这里。 */
      const adoptSession = React.useCallback((event) => {
        setSessionId((current) => sessionTransition(current, event))
      }, [])

      // 记住这条会话，供下一次重挂续接（内存级，不持久化）。
      React.useEffect(() => {
        const id = instanceRef.current.length > 0 ? instanceRef.current : instanceId
        rememberPanelSession(topicId === 'main' ? id : `${id}/${topicId}`, sessionId)
      }, [sessionId, instanceId, topicId])

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
          if (instanceRef.current !== instanceId || topicRef.current !== topicId) return
          const visible = panelVisibleNow()
          void fetch(scopedUrl(ROUTES.instanceActive), {
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
        const leaveBody = JSON.stringify({ instance_id: instanceId, topic_id: topicId, client_id: clientId.current, panel: false, visible: false })
        const onPageHide = () => {
          if (instanceRef.current !== instanceId || topicRef.current !== topicId) return
          try {
            if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
              navigator.sendBeacon(scopedUrl(ROUTES.instanceActive), new Blob([leaveBody], { type: 'application/json' }))
              return
            }
          } catch {
            // 回退到 keepalive fetch。
          }
          void fetch(scopedUrl(ROUTES.instanceActive), {
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
          if (instanceRef.current !== instanceId || topicRef.current !== topicId) return
          void fetch(scopedUrl(ROUTES.instanceActive), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: leaveBody,
            keepalive: true,
          }).catch(() => undefined)
        }
      }, [instanceId, topicId, scopedUrl])

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
        const version = selectionVersion.current
        const scope = activityScopeRef.current
        try {
          const response = await fetch(scopedUrl(ROUTES.state), { credentials: 'same-origin' })
          const payload = await response.json()
          if (!mounted.current || version !== selectionVersion.current || scope !== activityScopeRef.current) return undefined
          if (typeof payload?.activeInstanceId === 'string' && instanceRef.current.length > 0 && payload.activeInstanceId !== instanceRef.current) return undefined
          if (Array.isArray(payload?.instances)) setInstances(payload.instances)
          if (Array.isArray(payload?.topics)) setTopics(payload.topics)
          if (typeof payload?.sharedNotes === 'string') setSharedNotes(payload.sharedNotes)
          if (payload?.memory) setMemoryData(payload.memory)
          if (payload?.contextPlan) setContextPlan(payload.contextPlan)
          if (Array.isArray(payload?.routerSessionIds)) setRouterSessionIds(payload.routerSessionIds)
          syncRouterRetains(payload?.routers)
          if (typeof payload?.unreadTotal === 'number') publishUnread(payload.unreadTotal)
          if (payload?.ok && payload.router) {
            setRouterInfo(payload.router)
            setActivitySnapshotScope(scope)
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
                try { window.sessionStorage?.setItem('dsh.super-agent.instance', payload.activeInstanceId) } catch { /* 隐私模式 */ }
              }
              return live.sessionId
            }
          }
        } catch {
          // 轮询失败不打断对话；下一次再试。
        }
        return undefined
      }, [t])

      const ensure = React.useCallback(async (requestedId, requestedTopicId) => {
        const version = ++selectionVersion.current
        setBusy(true)
        setError('')
        try {
          // 不传 cwd：宿主按实例 home 恢复 Router。项目选择属于 Router，不属于 UI。
          const targetId = typeof requestedId === 'string' ? requestedId : instanceRef.current
          const targetTopic = requestedTopicId ?? topicRef.current
          const { response, payload } = await postJson(ROUTES.ensure, { ...(targetId.length > 0 ? { instance_id: targetId } : {}), topic_id: targetTopic })
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          if (!mounted.current || version !== selectionVersion.current) return false
          const info = payload.router ?? {
            sessionId: payload.sessionId,
            instanceId: payload.instanceId,
            projectRoot: payload.projectRoot,
            status: payload.status,
          }
          if (typeof payload.instanceId === 'string' && payload.instanceId.length > 0) {
            setInstanceId(payload.instanceId)
            instanceRef.current = payload.instanceId
            try { window.sessionStorage?.setItem('dsh.super-agent.instance', payload.instanceId) } catch { /* 隐私模式 */ }
          }
          topicRef.current = targetTopic
          setTopicId(targetTopic)
          if (Array.isArray(payload.topics)) setTopics(payload.topics)
          if (typeof payload.sharedNotes === 'string') setSharedNotes(payload.sharedNotes)
          if (payload.memory) setMemoryData(payload.memory)
          if (payload.contextPlan) setContextPlan(payload.contextPlan)
          if (Array.isArray(payload.instances)) setInstances(payload.instances)
          if (Array.isArray(payload.routerSessionIds)) setRouterSessionIds(payload.routerSessionIds)
          if (typeof payload.unreadTotal === 'number') publishUnread(payload.unreadTotal)
          setRouterInfo(info)
          setActivitySnapshotScope(activityScopeRef.current)
          adoptSession({ kind: 'user', sessionId: payload.sessionId })
          const summary = summarizeStatus(info)
          if (summary !== null) {
            const pieces = [summary.active ? t('running') : t('idle')]
            if (summary.workers > 0) pieces.push(format(t, 'workers', { count: summary.workers }))
            if (summary.pending > 0) pieces.push(format(t, 'pending', { count: summary.pending }))
            if (summary.tasks > 0) pieces.push(format(t, 'tasks', { count: summary.tasks }))
            setStatusLine(pieces.join(' · '))
          }
          return true
        } catch (cause) {
          if (mounted.current && version === selectionVersion.current) setError(format(t, 'ensureFailed', { reason: String(cause?.message ?? cause) }))
          return false
        } finally {
          if (mounted.current && version === selectionVersion.current) setBusy(false)
        }
      }, [t])

      /** 切换实例：先告诉宿主活跃/可见（并清空该实例未读），再确保它的 Router。 */
      const switchInstance = React.useCallback(async (nextId, requestedTopicId) => {
        if (typeof nextId !== 'string' || nextId.length === 0) return
        const nextTopic = requestedTopicId ?? savedTopic(nextId)
        const version = ++selectionVersion.current
        instanceRef.current = nextId
        topicRef.current = nextTopic
        setTopicId(nextTopic)
        activityScopeRef.current = nextTopic === 'main' ? 'instance' : 'topic'
        setActivityScope(activityScopeRef.current)
        setTopics([])
        setMemoryData(undefined)
        setContextPlan(undefined)
        setDrawer('')
        setInstanceOpen(false)
        setInstanceBusy(true)
        setError('')
        try {
          const active = await postJson(ROUTES.instanceActive, {
            instance_id: nextId,
            topic_id: nextTopic,
            panel: true,
            visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
            read: true,
          })
          if (!mounted.current || version !== selectionVersion.current) return false
          if (active.response.ok && active.payload?.ok === true) {
            if (Array.isArray(active.payload.instances)) setInstances(active.payload.instances)
            if (typeof active.payload.unreadTotal === 'number') publishUnread(active.payload.unreadTotal)
          }
          instanceRef.current = nextId
          setInstanceId(nextId)
          try { window.sessionStorage?.setItem('dsh.super-agent.instance', nextId) } catch { /* 隐私模式 */ }
          attempted.current = true
          adoptSession({ kind: 'user', sessionId: '' })
          setRouterInfo(null)
          setWorkspaceSessions([])
          setRouterSessionIds([])
          setStatusLine('')
          setActivityFull(undefined)
          setActivityTotal(undefined)
          attempted.current = true
          return await ensure(nextId, nextTopic)
        } catch (cause) {
          if (mounted.current) setError(format(t, 'instanceSwitchFailed', { reason: String(cause?.message ?? cause) }))
          return false
        } finally {
          if (mounted.current) setInstanceBusy(false)
        }
      }, [ensure, t])

      const switchTopic = React.useCallback(async (nextTopic) => {
        if (typeof nextTopic !== 'string' || !nextTopic) return
        const targetInstance = instanceRef.current
        topicRef.current = nextTopic
        setTopicId(nextTopic)
        rememberTopic(instanceRef.current, nextTopic)
        activityScopeRef.current = nextTopic === 'main' ? 'instance' : 'topic'
        setActivityScope(activityScopeRef.current)
        setDrawer('')
        setResetConfirm(false)
        setActivityFull(undefined)
        setActivityTotal(undefined)
        setDetailId('')
        setDetail(undefined)
        setPreview({ tabs: [], activeId: '' })
        setRulesData(undefined)
        setSchedulesData(undefined)
        setMemoryData(undefined)
        setContextPlan(undefined)
        adoptSession({ kind: 'user', sessionId: '' })
        attempted.current = true
        if (await ensure(targetInstance, nextTopic) !== true) return false
        await postJson(ROUTES.instanceActive, { instance_id: targetInstance, topic_id: nextTopic, read: true, panel: true, visible: panelVisibleNow() })
        await fetchState()
        return true
      }, [ensure, fetchState, postJson, adoptSession])

      const topicAction = React.useCallback(async (body) => {
        const version = selectionVersion.current
        setTopicBusy(true)
        setTopicError('')
        try {
          const { response, payload } = await postJson(ROUTES.topics, { instance_id: instanceRef.current, ...body })
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (!mounted.current || version !== selectionVersion.current) return
          if (Array.isArray(payload.topics)) setTopics(payload.topics)
          if (typeof payload.sharedNotes === 'string') setSharedNotes(payload.sharedNotes)
          if (payload.memory) setMemoryData(payload.memory)
          if (payload.contextPlan) setContextPlan(payload.contextPlan)
          if (body.action === 'create') await switchTopic(payload.topic.id)
          else if (body.archived === true && body.topic_id === topicRef.current) await switchTopic('main')
          await fetchState()
          return true
        } catch (cause) {
          if (mounted.current && version === selectionVersion.current) {
            const reason = String(cause?.message ?? cause)
            setTopicError(/version conflict/.test(reason) ? t('memoryConflict') : /topic name.*already exists/.test(reason) ? t('topicDuplicate') : reason)
            await fetchState()
          }
          return false
        }
        finally { if (mounted.current) setTopicBusy(false) }
      }, [postJson, switchTopic, fetchState, t])

      const changeActivityScope = React.useCallback(async (next) => {
        if (!['topic', 'instance'].includes(next) || next === activityScopeRef.current) return
        activityScopeRef.current = next
        setActivityScope(next)
        setActivityFull(undefined)
        setActivityTotal(undefined)
        setDetailId('')
        setDetail(undefined)
        await fetchState()
      }, [fetchState])

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
          setActivitySnapshotScope(activityScopeRef.current)
          adoptSession({ kind: 'user', sessionId: payload.sessionId })
          setResetConfirm(false)
          attempted.current = true
          setActivityFull(undefined)
          setActivityTotal(undefined)
          setActivityLoadingMore(false)
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
        const version = selectionVersion.current
        setModelsLoading(true)
        setModelsError('')
        try {
          const payload = await getJson(`${ROUTES.models}${force ? '?refresh=1' : ''}`)
          if (version !== selectionVersion.current) return
          if (mounted.current) setModelsData(payload)
        } catch (cause) {
          if (mounted.current) setModelsError(format(t, 'modelsFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setModelsLoading(false)
        }
      }, [t])

      const saveModels = React.useCallback(async (body) => {
        const version = selectionVersion.current
        setModelsSaving(true)
        setModelsError('')
        try {
          const { response, payload } = await postJson(ROUTES.models, body)
          if (version !== selectionVersion.current) return
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

      const saveModelDefaultSet = React.useCallback(async (defaults) => {
        const version = selectionVersion.current
        setModelsSaving(true)
        setModelsError('')
        try {
          const { response, payload } = await postJson(ROUTES.modelDefaults, { defaults })
          if (version !== selectionVersion.current) return
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (mounted.current) setModelsData(payload)
          return payload
        } catch (cause) {
          if (mounted.current) setModelsError(format(t, 'modelsDefaultFailed', { reason: String(cause?.message ?? cause) }))
          return undefined
        } finally {
          if (mounted.current) setModelsSaving(false)
        }
      }, [t])

      const loadRules = React.useCallback(async () => {
        const version = selectionVersion.current
        setRulesLoading(true)
        setRulesError('')
        try {
          const payload = await getJson(ROUTES.agreements)
          if (version !== selectionVersion.current) return
          if (mounted.current) setRulesData(payload)
        } catch (cause) {
          if (mounted.current) setRulesError(format(t, 'rulesFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setRulesLoading(false)
        }
      }, [t])

      const rulesAction = React.useCallback(async (body) => {
        const version = selectionVersion.current
        setRulesSaving(true)
        setRulesError('')
        try {
          const { response, payload } = await postJson(ROUTES.agreements, body)
          if (version !== selectionVersion.current) return
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
        const version = selectionVersion.current
        setSchedulesLoading(true)
        setSchedulesError('')
        try {
          const payload = await getJson(ROUTES.schedules)
          if (version !== selectionVersion.current) return
          if (mounted.current) setSchedulesData(payload)
        } catch (cause) {
          if (mounted.current) setSchedulesError(format(t, 'schedulesFailed', { reason: String(cause?.message ?? cause) }))
        } finally {
          if (mounted.current) setSchedulesLoading(false)
        }
      }, [t])

      const scheduleAction = React.useCallback(async (url, body) => {
        const version = selectionVersion.current
        setSchedulesBusy(true)
        setSchedulesError('')
        try {
          const { response, payload } = await postJson(url, body)
          if (version !== selectionVersion.current) return
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

      const loadActivityMore = React.useCallback(async (cursor) => {
        const version = selectionVersion.current
        const scope = activityScopeRef.current
        if (activityLoadingMore) return undefined
        setActivityLoadingMore(true)
        try {
          const suffix = typeof cursor === 'string' && cursor.length > 0 ? `&cursor=${encodeURIComponent(cursor)}` : ''
          const payload = await getJson(`${ROUTES.activity}?limit=${ACTIVITY_PAGE_SIZE}${suffix}`)
          if (version !== selectionVersion.current || scope !== activityScopeRef.current) return undefined
          if (!mounted.current) return undefined
          const page = Array.isArray(payload.activity) ? payload.activity : []
          const base = Array.isArray(activityFull)
            ? activityFull
            : Array.isArray(routerInfo?.status?.activity)
              ? routerInfo.status.activity
              : []
          const seen = new Set(base.map((row) => row?.id))
          const fresh = page.filter((row) => row?.id !== undefined && !seen.has(row.id))
          if (fresh.length > 0) setActivityFull([...base, ...fresh])
          if (Number.isFinite(payload.total)) setActivityTotal(payload.total)
          return {
            added: fresh.length,
            total: Number.isFinite(payload.total) ? payload.total : undefined,
            hasMore: payload.hasMore === true,
          }
        } catch {
          // 状态轮询里已有最近活动，扩展失败不阻断面板。
          return undefined
        } finally {
          if (mounted.current) setActivityLoadingMore(false)
        }
      }, [activityLoadingMore, activityFull, routerInfo?.status?.activity])

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
       * 执行一次定位：切实例 + adopt 会话（通知点击的落点）。
       *
       * 成功定位不弹提示；只有认不出的会话和实例切换失败才给一条可见提示。
       * 认不出的会话不 adopt——那会把面板落到一条空会话上，会话若还在左侧
       * 列表里，用户仍能点开。
       */
      const applyReveal = React.useCallback(async (request) => {
        if (request === undefined) return
        const target = typeof request.instanceId === 'string' && request.instanceId.length > 0
          ? request.instanceId
          : undefined
        if (target !== undefined && target !== instanceRef.current) {
          lastRevealAt.current = Date.now()
          navLog('reveal.apply', { sessionId: request.sessionId, instanceId: target, switched: true })
          const switched = await switchInstance(target, request.topicId ?? 'main')
          if (!mounted.current) return
          // 切换失败（宿主拒绝/HTTP 错）时 `switchInstance` 只设置 error、不抛：
          // 这时绝不能把另一个实例的会话 adopt 进来，明确提示用户。
          if (switched !== true || instanceRef.current !== target) {
            navLog('reveal.switch.failed', { sessionId: request.sessionId, instanceId: target })
            setNavNotice({ kind: 'failed', sessionId: request.sessionId, instanceId: target })
            return
          }
        }
        if (typeof request.topicId === 'string' && request.topicId !== topicRef.current && await switchTopic(request.topicId) !== true) {
          setNavNotice({ kind: 'failed', sessionId: request.sessionId, instanceId: target })
          return
        }
        lastRevealAt.current = Date.now()
        if (target !== undefined || routerSessionIds.includes(request.sessionId)) {
          adoptSession({ kind: 'user', sessionId: request.sessionId })
          navLog('reveal.adopt', { sessionId: request.sessionId, instanceId: target ?? instanceRef.current })
          // 定位成功不再弹顶部提示：跳转本身已经说明结果，提示属于噪声。
          setNavNotice(undefined)
          return
        }
        navLog('reveal.unknown', { sessionId: request.sessionId })
        setNavNotice({ kind: 'unknown', sessionId: request.sessionId, instanceId: undefined })
      }, [adoptSession, switchInstance, switchTopic, routerSessionIds])

      // 通知点击的落点。`showSession` 的语义是「定位」，所以即使已经在目标实例/会话
      // 也照常执行；行为固定为 away-notify 的原生落点，面板不再提供「跟随」开关。
      React.useEffect(() => {
        if (revealRequest === undefined) return
        const request = revealRequest
        setRevealRequest(undefined)
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
      }, [drawer, modelsData, rulesData, schedulesData, loadModels, loadRules, loadSchedules])

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
        setActivityFull(undefined)
        setActivityTotal(undefined)
        attempted.current = true
        void ensure()
      }

      const tasks = Array.isArray(routerInfo?.status?.tasks) ? routerInfo.status.tasks : []
      const activityScopeReady = activitySnapshotScope === activityScope
      const activityRows = !activityScopeReady ? [] : Array.isArray(activityFull)
        ? activityFull
        : Array.isArray(routerInfo?.status?.activity)
          ? routerInfo.status.activity
          : tasks
      const activityShownTotal = !activityScopeReady ? 0 : Number.isFinite(activityTotal)
        ? Math.max(activityTotal, activityRows.length)
        : Number.isFinite(routerInfo?.status?.activityTotal)
          ? Math.max(routerInfo.status.activityTotal, activityRows.length)
          : activityRows.length
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
          : format(t, 'navSwitchFailed', { instance: navInstanceName(navNotice.instanceId) })

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
          .sa-name-control, .sa-header-action, .sa-icon-button, .sa-instance-row,
          .sa-menu-action, .sa-activity-row, .sa-more-button {
            background: transparent;
            border: 0;
          }
          .sa-name-control {
            color: var(--dsw-alias-label-primary);
            transition: background-color .1s ease, color .1s ease;
          }
          .sa-name-control:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10)); }
          .sa-name-control:active:not(:disabled),
          .sa-name-control[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
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
          .sa-header-action[data-active="true"], .sa-toolbar-more[open] > summary {
            background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.14));
            color: var(--dsw-alias-label-primary);
          }
          .sa-help > summary::-webkit-details-marker, .sa-toolbar-more > summary::-webkit-details-marker { display: none; }
          .sa-help > summary::marker, .sa-toolbar-more > summary::marker { content: ''; }
          .sa-help > summary:hover { color: var(--dsw-alias-label-primary); }
          .sa-help > summary:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4f7cff); outline-offset: 2px; }
          .sa-header-action[data-danger="true"] { color: var(--dsw-alias-state-error-primary, #d95c5c); }
          .sa-header-action[data-danger="true"]:hover:not(:disabled) {
            background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d95c5c) 10%, transparent);
            color: var(--dsw-alias-state-error-primary, #d95c5c);
          }
          .sa-header-action:disabled, .sa-name-control:disabled { opacity: .42; cursor: default; }
          .sa-name-control:focus-visible, .sa-header-action:focus-visible,
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
            .sa-name-control, .sa-header-action, .sa-icon-button, .sa-instance-row,
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
          topics.length > 0 ? h('button', {
            type: 'button', className: 'sa-name-control sa-topic-switcher', style: S.titleButton,
            'aria-expanded': topicsExpanded, 'aria-controls': topicBarId, 'aria-label': `${t('topicNavigation')}: ${topics.find((row) => row.id === topicId)?.name ?? t('topicOverview')}`,
            title: t('topicToggle'), 'data-active': topicsExpanded ? 'true' : undefined,
            onClick: () => { const next = !topicsExpanded; topicBarPreference(undefined, next); setTopicsExpanded(next) },
          }, h('span', { style: { color: T.textSecondary, flex: 'none', fontWeight: 400 } }, t('topicNavigation')), h('span', { style: S.nameText }, topics.find((row) => row.id === topicId)?.name ?? t('topicOverview')), h('span', { 'aria-hidden': 'true', style: { ...S.nameChevron, transform: topicsExpanded ? 'rotate(180deg)' : 'none' } }, h(Glyph, { name: 'chevronDown', size: 12, strokeWidth: 1.2 }))) : null,
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
          h(ToolbarMore, { t, actions: [
            { key: 'refresh', label: t('refresh'), disabled: busy, run: retry },
            openSessionAvailable ? { key: 'session', label: t('openSession'), run: () => {
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
            } } : null,
            { key: 'reset', label: resetting ? t('resetting') : resetConfirm ? t('resetConfirm') : t('reset'), danger: true, title: t('resetNote'), disabled: busy || resetting || !hasSession || topicId !== 'main', keepOpen: true, run: reset },
          ] }),
        ),
        topics.length > 0 ? h(TopicStrip, { id: topicBarId, expanded: topicsExpanded, t, topics, topicId, busy: busy || topicBusy,
          onSelect: (id) => { void switchTopic(id) },
          onCreate: () => { setTopicError(''); setTopicCreateMode(true); setDrawer('topics') },
          onManage: () => { setTopicError(''); setTopicCreateMode(false); setDrawer('topics') },
        }) : null,
        error.length > 0
          ? h('div', { style: S.error }, h('strong', {}, `${t('error')}: `), error)
          : null,
        navNotice === undefined
          ? null
          : h('div', { style: S.navNotice },
              h('span', { style: S.navNoticeText }, navNoticeText),
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
          activityRailVisible(preview)
            ? h(ActivityRail, {
                scope: activityScope, onScopeChange: changeActivityScope, loading: !activityScopeReady,
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
                total: activityShownTotal,
                onLoadMore: loadActivityMore,
              })
            : null,
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
        drawer === 'topics'
          ? h(TopicsPanel, {
              key: topicId, t, topics, topicId, memory: memoryData, contextPlan, busy: topicBusy, error: topicError, initialCreate: topicCreateMode,
              onClose: () => setDrawer(''),
              onCreate: (name, sharing) => topicAction({ action: 'create', name, sharing }),
              onUpdate: (body) => { void topicAction({ action: 'update', ...body }) },
              onAction: (body) => topicAction(body),
            })
          : null,
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
              onSaveDefault: saveModelDefaultSet,
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
          ? h(Drawer, { title: t('activityTitle'), t, onClose: () => setDrawer(''), wide: true },
              h('div', { style: { height: '100%', minHeight: 320, display: 'flex' } },
                h(ActivityRail, {
                  scope: activityScope, onScopeChange: changeActivityScope, loading: !activityScopeReady,
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
                  total: activityShownTotal,
                  onLoadMore: loadActivityMore,
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
    /**
     * 面板守卫的开关（localStorage）。
     *
     * **默认关。** 守卫那套「没有用户手势就不许切走面板 / 不许换会话」是启发式：
     * 系统通知点击在页面里没有指针事件（见下方「点了系统通知」一节），所以它会把
     * away-notify 的正常回跳一起拦掉。根因已经在源头修掉——super-agent 的 worker
     * 会话由创建方登记为「内部会话」，away-notify 不再为它弹通知，也就不会写入
     * pendingFocus 把界面切到 worker 会话。守卫不再需要默认常开。
     *
     * 写 `on` 才启用，仅用于诊断「面板被宿主自动关掉」这类问题；缺省或 `off`
     * 一律按原生行为放行。取不到存储（隐私模式/精简宿主）也按**关**处理。
     */
    const NAV_GUARD_KEY = 'dsh.super-agent.navGuard'

    /**
     * 面板守卫是否开启（默认关；localStorage 写 `on` 才开）。
     *
     * @param {{ getItem?: Function }} [storage] 测试注入的存储。
     * @returns {boolean} 是否开启。
     */
    function navGuardEnabled(storage) {
      try {
        const store = storage ?? window.localStorage
        return store?.getItem?.(NAV_GUARD_KEY) === 'on'
      } catch {
        return false
      }
    }

    /**
     * 面板守卫（**默认关，仅诊断用**）：本面板处于激活状态时，只允许「用户显式操作」
     * 把它切走。
     *
     * 历史：它曾经默认开启，用来对抗「刚打开面板就被切走」。真正的根因不在这里——
     * away-notify 把普通 Session 的 worker 当成用户会话，在 `turn/end` 时弹通知并写
     * `pendingFocus`；用户回到前台时 away-notify 原生消费 pendingFocus
     * （`switchTo → replaceMain → selectPanel(null)`），于是面板被关、界面换到 worker。
     * 现在 worker 由创建方登记为内部会话（`awayNotify.markInternal`），通知与
     * pendingFocus 都不再产生，守卫不必默认拦导航。系统通知点击在页面里没有任何
     * 指针事件，默认拦会把正常回跳一起挡掉（旧 bug：「点通知不跳」）。
     *
     * 开启方式：`localStorage['dsh.super-agent.navGuard'] = 'on'`。开启后：
     *   - 包装 `layout.selectPanel`：切走必须伴随最近 1.5 秒内的真实手势
     *     （pointerdown / mousedown / keydown / popstate / hashchange），且手势是
     *     一次性令牌；打开本面板（to === PANEL_ID）永远放行；
     *   - 包装会话打开器（`uiWorkspace.openSession` / `sessions.open` / `replaceMain`）：
     *     无手势的跨会话跳转拦下并排队「定位」提示；
     *   - 直接写 store 的路径由 `panelInfo` 订阅兜住：条目还在就恢复面板。
     * 插件卸载、面板条目真的消失时 `isRegistered()` 为假，一律放行（不硬撑）。
     *
     * **默认关时必须拆掉上一版留在 window 注册表里的守卫**：HMR 重新求值时旧实例的
     * 清理不一定跑，否则「默认放行」只是代码里的一句话。
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
      const storage = options.storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
      if (!navGuardEnabled(storage)) {
        // 默认关：如果本页还挂着上一版（默认开）装好的守卫，必须主动拆掉。
        // HMR 只重新求值模块，旧实例的 `ctx.effect` 清理不一定跑；窗口级注册表
        // 里那份包装继续拦导航的话，「默认放行」就只是代码里的一句话。
        const stale = typeof window === 'undefined' ? undefined : window[NAV_GUARD_REGISTRY_KEY]
        if (stale !== undefined && stale !== null && typeof stale.restore === 'function') {
          try {
            stale.restore()
            navLog('guard.off', { restored: true }, 'super-agent.navGuard')
          } catch {
            // 旧实例的 layout 已经不在了：忽略。
            navLog('guard.off', { restored: false }, 'super-agent.navGuard')
          }
        } else {
          navLog('guard.off', {})
        }
        return () => {}
      }
      // 同一个 layout 只包一层：`ctx.inject` 的回调可能重复跑（服务重启/补丁重载），
      // 叠两层包装会让「解绑」只还原到上一层。
      if (navGuardInstalled.has(layout)) return () => {}
      // 跨闭包的幂等：同一个 layout 对象在整页只包一层。模块级 WeakMap 挡不住
      // 两份闭包，所以注册表放在 window 上；上一份实例的包装如果还活着（卸载清理
      // 没跑），先拆掉它再装，绝不叠加。
      const registry = typeof window === 'undefined' ? undefined : window[NAV_GUARD_REGISTRY_KEY]
      if (registry !== undefined && registry !== null && registry.layout === layout && typeof registry.restore === 'function') {
        // 同一个 layout 已经有主：**不能再把销毁权交出去**。否则后到的那份 ctx
        // 卸载（HMR 卸旧条目）时会把它当自己的清理执行，把守卫整层拆掉——
        // 页面看起来正常，实际已经没有任何保护。
        navLog('guard.shared', { reason: 'another instance owns this layout' }, 'super-agent.navGuard')
        return () => {}
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
      // 记录每个监听对应的处理函数，还原时按对删除（visibilitychange 用的不是
      // markGesture，按类型一刀切会漏删）。
      const boundHandlers = new Map()
      if (doc !== undefined && doc !== null && typeof doc.addEventListener === 'function') {
        for (const type of gestureEvents) {
          const handler = (type === 'popstate' || type === 'hashchange')
            ? (event) => { armFromLocation(); markGesture(event) }
            : markGesture
          doc.addEventListener(type, handler, true)
          bound.push(type)
          boundHandlers.set(type, handler)
        }
      }
      const gestureRecent = () => now() - lastGestureAt <= NAV_GESTURE_WINDOW_MS

      // ── 「点了系统通知」的唯一放行信号 ──────────────────────────────────────
      //
      // 结论（先查过、确认没有确定性信号）：系统通知由宿主用 OS 通知弹出，点击走
      // `dshnotify:` 协议把窗口置前（dsh-away-notify/lib/protocol.js），协议脚本
      // **不回连服务器**；宿主 presence 只有 `pending-focus` / `ack-focus`
      // （dsh-away-notify/lib/host.js:719、:727），没有任何「通知被点击」的时间戳或
      // 计数。页面里也收不到 pointerdown/click。
      //
      // 「文档从 hidden 回到 visible」**不能**当作点击信号：切标签页/最小化几秒再
      // 回来完全一样，只会把「切走」再犯一遍。所以这条启发式已经删掉：默认对一切
      // 无手势的跨会话跳转说「不」（拦下 + 面板内定位提示条）。
      //
      // 唯一保留的确定性信号：通知以**新标签页**打开时 URL 上的
      // `?dshAwayNotifyFocus=<sessionId>`（dsh-away-notify/lib/host.js:426）。
      let notificationJumpSession
      let notificationJumpUntil = Number.NEGATIVE_INFINITY
      const armFromLocation = () => {
        try {
          const search = String(location?.search ?? '')
          const match = /[?&]dshAwayNotifyFocus=([^&]+)/.exec(search)
          if (match === null) return
          const id = decodeURIComponent(match[1])
          if (typeof id !== 'string' || id.length === 0) return
          notificationJumpSession = id
          notificationJumpUntil = now() + NAV_GESTURE_WINDOW_MS
          navLog('nav.armed', { sessionId: id, window: NAV_GESTURE_WINDOW_MS }, 'notification.url')
        } catch {
          // 没有 location 的精简宿主：忽略。
        }
      }
      // 自愈：守卫装好之后，如果 `selectPanel` 又被别人换掉（HMR 重载、服务换实例、
      // 另一个实例的还原），在下一次可见性变化时把包装装回去。没有这层，页面看起来
      // 正常、实际已经没有任何保护。
      const healGuard = () => {
        try {
          if (layout.selectPanel !== guarded && typeof guarded === 'function') {
            layout.selectPanel = guarded
            navLog('nav.healed', { reason: 'selectPanel was replaced' }, 'super-agent.navGuard')
          }
        } catch {
          // 只读属性：放弃自愈。
        }
      }
      if (doc !== undefined && doc !== null && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', healGuard, true)
        boundHandlers.set('visibilitychange', healGuard)
      }
      armFromLocation()

      /**
       * 该目标会话是否正是「通知 URL 带来的那一条」，且令牌还在有效期内。
       * 令牌**绑定 sessionId**：只放行那一条，且只放行一次。
       */
      const consumeNotificationJump = (targetId) => {
        if (now() > notificationJumpUntil) return false
        if (typeof notificationJumpSession !== 'string' || notificationJumpSession !== targetId) return false
        notificationJumpUntil = Number.NEGATIVE_INFINITY
        notificationJumpSession = undefined
        return true
      }
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
        // 已经包过：`ctx.inject` 的回调可能重复跑（服务重启/补丁重载），第二次
        // 拿到的就是我们的包装函数；再包一层会让「还原」只拆掉最外层。
        if (openerRestores.some((entry) => entry.original === original || entry.guarded === original)) return
        const guardedOpener = function guardedSessionOpener(target, ...rest) {
          let targetId
          try {
            targetId = typeof target === 'string' ? target : target?.sessionId
          } catch {
            targetId = undefined
          }
          const allow = () => original.apply(this, [target, ...rest])
          // `replaceMain(target, signal, panel)`：`preserve` 是启动/恢复（放行），
          // 只有 `reveal` 是「切到某条会话」的用户可见导航。
          if (key === 'replaceMain' && rest[1] !== 'reveal') return allow()
          if (typeof targetId !== 'string' || targetId.length === 0) return allow()
          const current = currentMainSession()
          // 已经在目标会话上、或者还没有任何会话（启动/launch URL/协议链接）→ 放行。
          if (current === undefined || targetId === current) return allow()
          // 我们自己的用户意图导航（点击后 await 过，手势窗口可能已过期）。
          if (Date.now() <= authorizedNavUntil) return allow()
          // 通知以新标签页打开时带来的那一条会话：放行一次。
          if (consumeNotificationJump(targetId)) {
            navLog('nav.allow.notification', { from: current, to: targetId }, 'notification.url')
            return allow()
          }
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
          // 降级：面板内「定位」提示条，用户点一下才真正切过去。面板没在台上时
          // 先把它切出来（切到我们自己的面板是被允许的方向），否则用户什么都看不到。
          try {
            requestPanelReveal({ sessionId: targetId, reason: 'blocked-switch' })
          } catch {
            // 队列满/无面板：只记录日志。
          }
          try {
            if (activePanelId() !== PANEL_ID && typeof layout.selectPanel === 'function') {
              layout.selectPanel(PANEL_ID)
              navLog('nav.fallback.panel', { to: PANEL_ID, sessionId: targetId }, source)
            }
          } catch {
            // 面板不可用：只留提示条。
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
        // ui-workspace 里除了 openSession，还有直接调 replaceMain 的路径
        // （openWorkspaceSession:1489、恢复流程:1608/1614/1627）。启动/恢复传
        // 'preserve'（guardedOpener 里直接放行），'reveal' 才是要守的跨会话跳转。
        wrapSessionOpener(workspace, 'replaceMain', 'uiWorkspace.replaceMain')
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
          for (const [type, handler] of boundHandlers) doc.removeEventListener(type, handler, true)
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
    /**
     * Router 会话的**常驻** retain：面板关着也要让 away-notify 认得出归属。
     *
     * `panelForSession` 的第一步是看目标会话的 `retainedBy` 里有没有「算面板」的来源
     * （away-notify client.js:460-490）。面板自己只在挂载期间 retain 当前会话，关掉就
     * 释放；此时点通知只能靠 away-notify 的「上次显示在哪个面板」记忆兜底，从没打开过
     * 面板的 profile 会 fallback 到 `switchTo`（主视图开一条普通会话，不是面板）。
     *
     * 这里在插件层按 `/ui/state` 的 `routers` 常驻 retain 所有 live Router：面板挂载时
     * 还会再 retain 一次（计数叠加），卸载只减一；Router 消失/实例关闭/插件卸载时释放。
     * 只影响「谁能说这条会话归我」，不改会话内容，也不阻止宿主显式关闭。
     */
    const routerRetains = new Map()
    /** apply 时解析的 sessions 服务（测试可注入）。 */
    let retainSessionsService

    /** 释放一条常驻 retain（幂等）。 */
    function releaseRouterRetain(sessionId) {
      const held = routerRetains.get(sessionId)
      if (held === undefined) return false
      routerRetains.delete(sessionId)
      try {
        held.reference?.release?.()
      } catch {
        // 会话已经销毁/服务换实例：引用失效即可。
      }
      return true
    }

    /** 释放全部常驻 retain（插件卸载/热重载）。 */
    function releaseAllRouterRetains() {
      for (const sessionId of [...routerRetains.keys()]) releaseRouterRetain(sessionId)
    }

    /** 当前常驻 retain 的 Router 会话 id（诊断/测试）。 */
    function routerRetainedIds() {
      return [...routerRetains.keys()]
    }

    /**
     * 用一次 `/ui/state` 的 `routers` 对齐常驻 retain：新增的 retain、消失的释放。
     * `routers` 缺失（老宿主/读失败）时不动现有集合——不能因为一次坏应答把归属清空。
     *
     * @param {Array<{sessionId?: string}>|undefined} routers `/ui/state` 的 live Router 清单。
     * @returns {number} 对齐后常驻 retain 的数量。
     */
    function syncRouterRetains(routers) {
      if (!Array.isArray(routers)) return routerRetains.size
      const sessions = retainSessionsService
      if (sessions === undefined || typeof sessions.retain !== 'function') return routerRetains.size
      const live = new Set()
      for (const row of routers) {
        if (typeof row?.sessionId === 'string' && row.sessionId.length > 0) live.add(row.sessionId)
      }
      for (const sessionId of [...routerRetains.keys()]) {
        if (!live.has(sessionId)) releaseRouterRetain(sessionId)
      }
      for (const sessionId of live) {
        const held = routerRetains.get(sessionId)
        // 服务换实例（客户端热重载）后旧句柄不再有效：丢掉重登记。
        if (held !== undefined && held.service === sessions) continue
        if (held !== undefined) releaseRouterRetain(sessionId)
        try {
          const reference = sessions.retain(sessionId, { source: PANEL_SOURCE })
          routerRetains.set(sessionId, { service: sessions, reference })
          Promise.resolve(reference?.ready).catch(() => {
            releaseRouterRetain(sessionId)
          })
        } catch {
          // 会话还没装好/列表未就绪：下一次 state 再试。
        }
      }
      return routerRetains.size
    }

    /** 拉一次 `/ui/state` 对齐常驻 retain；失败静默（下次再说）。 */
    async function refreshRouterRetains() {
      if (retainSessionsService === undefined) return routerRetainedIds()
      const state = await readUiState()
      syncRouterRetains(state?.routers)
      return routerRetainedIds()
    }

    /** 测试注入口：替换 sessions 服务。 */
    function setRetainSessionsService(serviceValue) {
      retainSessionsService = serviceValue
    }
    /** 请求有效期：away-notify 的待跳转会话是 90 秒，留一点余量。 */
    const PANEL_REVEAL_TTL_MS = 120000
    /** 面板不再提供「跟随」开关：落点固定为 away-notify 原生行为。 */

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
        const usable = payload !== null && typeof payload === 'object' && payload.ok === true ? payload : undefined
        syncRouterRetains(usable?.routers)
        return usable
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
      return instanceId === undefined ? { sessionId } : { sessionId, instanceId, ...(typeof owner.topicId === 'string' ? { topicId: owner.topicId } : {}) }
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
    /**
     * 在插件层常驻 retain 所有 live Router（见 `routerRetains`）。
     *
     * 与面板的 retain 是叠加关系：面板开着时自己那条保留，关掉后这里仍持有，
     * away-notify 的 `panelForSession` 因此始终能看到 `superAgentUi` 拥有 Router，
     * 点击通知才会走 `selectPanel(panelId) + showSession` 而不是 `switchTo`。
     *
     * @param {object} ctx 浏览器插件上下文（`sessions` 已在 inject 中声明）。
     */
    function installRouterRetains(ctx) {
      try {
        retainSessionsService = service(ctx, 'sessions')
      } catch {
        retainSessionsService = undefined
      }
      if (retainSessionsService === undefined) return
      try {
        ctx.effect(() => {
          void refreshRouterRetains()
          return () => {
            releaseAllRouterRetains()
          }
        }, 'super-agent: router retains')
      } catch {
        // 老上下文没有 effect：至少尝试一次。
        void refreshRouterRetains()
      }
    }

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

    const PANEL_VIEW_KEY = 'dsh.super-agent.panel-view'

    /**
     * 宿主只持久化 Session，不持久化 main 面板；槽热替换还会把 activePanelId 清空。
     * 本面板重新注册且会话目录就绪后恢复一次；显式切换会取消待恢复状态。
     * 只观察、转发公开导航，不拦截；不轮询、不在任意关闭事件后强制重开。
     * sessionStorage 隔离窗口，存储不可用时仍能在本页热替换期间记住选择。
     */
    function createPanelViewRestore({ storage, eventTarget, sessions, isRegistered = () => false } = {}) {
      try { storage ??= window.sessionStorage } catch { /* 存储禁用：只保留本页状态。 */ }
      eventTarget ??= typeof window === 'undefined' ? undefined : window
      let remembered = false
      try { remembered = storage?.getItem(PANEL_VIEW_KEY) === 'panel' } catch { /* 隐私模式。 */ }
      // 通知链接的明确目标优先，后续原生通知导航仍可正常打开面板。
      if (typeof location !== 'undefined' && /[?&]dshAwayNotifyFocus=/.test(location.search ?? '')) remembered = false
      let alive = true
      let ready = false
      let attempted = false
      let scheduled = false
      let binding
      const sessionsReady = () => {
        const phase = sessions?.list?.getSnapshot?.()?.phase
        return phase === undefined || phase === 'ready'
      }
      const remember = (open) => {
        remembered = open
        try { storage?.setItem(PANEL_VIEW_KEY, open ? 'panel' : 'session') } catch { /* 隐私模式。 */ }
        navLog('panel.remember', { open })
      }
      const queueRestore = () => {
        if (!alive || !ready || !binding || !remembered || attempted || scheduled || !sessionsReady()) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          if (!alive || !ready || !binding || !remembered || attempted || !isRegistered() || !sessionsReady()) return
          const current = binding.snapshot()
          if (current === undefined) return
          attempted = true
          if (current !== null && current !== PANEL_ID) { remember(false); return }
          if (current === PANEL_ID) return
          try {
            binding.layout.selectPanel(PANEL_ID)
            navLog('panel.resumed', {})
          } catch (error) {
            // 注册失败不重试，不把用户困在持续抢焦点的循环里。
            navLog('panel.resume.failed', { error: String(error?.message ?? error) })
          }
        })
      }
      const capture = () => {
        const current = binding?.snapshot()
        if (current === undefined) return
        // 注册表暂时缺条目造成的 null 不代表用户选择了 Session。
        if (current !== null || isRegistered()) remember(current === PANEL_ID)
      }
      const onPageHide = () => capture()
      eventTarget?.addEventListener?.('pagehide', onPageHide)
      let unsubscribeSessions
      try { unsubscribeSessions = sessions?.list?.subscribe?.(queueRestore) } catch { /* 旧宿主。 */ }
      return {
        attach(layout) {
          if (!alive || !layout?.panelInfo?.getSnapshot || typeof layout.selectPanel !== 'function') return () => {}
          if (binding?.layout === layout) return () => {}
          binding?.dispose()
          const snapshot = () => {
            try { return layout.panelInfo.getSnapshot()?.activePanelId } catch { return undefined }
          }
          let active = true
          let previous = snapshot()
          const original = layout.selectPanel
          const observed = function (id, ...rest) {
            const result = original.call(this, id, ...rest)
            // 即使当前已经是 null，显式打开 Session 也应取消尚未完成的恢复。
            if (active && snapshot() === id) remember(id === PANEL_ID)
            return result
          }
          try { layout.selectPanel = observed } catch { /* 只读服务仍用公开快照订阅。 */ }
          let unsubscribe
          try {
            unsubscribe = layout.panelInfo.subscribe?.(() => {
              const next = snapshot()
              if (active && next !== previous && next !== undefined) {
                if (next !== null || isRegistered()) remember(next === PANEL_ID)
              }
              previous = next
            })
          } catch { /* 精简宿主可不提供订阅。 */ }
          const connection = {
            layout, snapshot,
            dispose() {
              if (!active) return
              active = false
              unsubscribe?.()
              if (layout.selectPanel === observed) layout.selectPanel = original
              if (binding === connection) binding = undefined
            },
          }
          binding = connection
          attempted = false
          navLog('panel.attached', { previous, remembered })
          if (previous !== null && previous !== undefined) remember(previous === PANEL_ID)
          queueRestore()
          return () => connection.dispose()
        },
        registered() {
          ready = true
          attempted = false
          navLog('panel.registered', { remembered, registered: isRegistered(), attached: !!binding })
          queueRestore()
          return () => { ready = false }
        },
        dispose() {
          if (!alive) return
          capture()
          alive = false
          eventTarget?.removeEventListener?.('pagehide', onPageHide)
          unsubscribeSessions?.()
          binding?.dispose()
        },
      }
    }

    /** @param {import('cordis').Context} ctx 浏览器插件上下文。 */
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
      const panelView = createPanelViewRestore({ sessions: service(ctx, 'sessions'), isRegistered: () => {
        try { return (ctx.slots.entries?.('main') ?? []).some((entry) => entry?.options?.key === PANEL_ID) } catch { return false }
      } })
      ctx.effect(() => () => panelView.dispose(), 'super-agent: remember panel view')

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
          const owner = typeof services?.effect === 'function' ? services : ctx
          owner.effect(() => {
            // 先拆默认关闭的旧守卫，避免观察器把它包住后又把它带回原生调用链。
            if (!navGuardEnabled()) installNavGuard(ctx, { layout: layoutService })
            return panelView.attach(layoutService)
          }, 'super-agent: restore panel view')
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
      installRouterRetains(ctx)

      // `?navdebug=1` 时才装导航诊断（默认关闭，不在 window 上留任何东西）。
      // 挂到 ctx.effect：插件卸载/热重载时把 document/window 监听一起摘掉。
      try {
        ctx.effect(() => installNavDebug(ctx), 'super-agent: nav debug')
      } catch {
        installNavDebug(ctx)
      }

      // 导航守卫：**默认关**（`localStorage['dsh.super-agent.navGuard']='on'` 才启用），
      // 默认行为完全交给宿主 + away-notify 原生导航。这里仍要调一次：默认关时它负责
      // 把上一版（默认开）留在 window 上的守卫拆掉。根因见 installNavGuard 的注释。
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
        // Cordis 在注册时遍历所有 yield；生命周期释放函数也应 yield，不能放在 finally。
        yield handle
        yield panelView.registered()
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
    // 测试入口：纯逻辑与组件在最小宿主桩上验证。
    module.exports.__internals = {
      TopicStrip,
      TopicCreateForm,
      HelpDisclosure,
      SelectMenu,
      ToolbarMore,
      ActivityRail,
      sharingOptions,
      topicBarPreference,
      topicRequestUrl,
      TopicsPanel,
      MemoryEditor,
      TopicStateEditor,
      badgeSummary,
      badgeParts,
      badgeCount,
      publishBadge,
      summarizeStatus,
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
      initialActivityList,
      activityListNext,
      catalogEntries,
      initialModelDraft,
      activityListSummary,
      ACTIVITY_PAGE_SIZE,
      ACTIVITY_DEFAULT_VISIBLE,
      requestPanelReveal,
      takePanelReveal,
      revealTargetOf,
      revealNotificationSession,
      syncRouterRetains,
      refreshRouterRetains,
      releaseAllRouterRetains,
      routerRetainedIds,
      setRetainSessionsService,
      installRouterRetains,
      navGuardEnabled,
      installNavGuard,
      createPanelViewRestore,
      PANEL_VIEW_KEY,
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
      activityRailVisible,
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
