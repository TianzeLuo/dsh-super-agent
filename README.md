# dsh-super-agent

一个 DeepSeek Harness 的 **Super-agent 控制面插件**：自然语言入口、Router/Worker
双层调度、持久化 Trigger/Thread、跨项目 Worker 和 Web 面板。

它不是另一套聊天 UI；面板复用 DSH 官方会话，把 Router 提示词和工具装进一条常驻
根会话。Router 负责判断和分派，具体任务交给 Worker。

## 特性

- **统一入口**：左栏 Super-agent 面板，无工作区选择器；Router 自主选择项目。
- **双层调度**：同项目任务用 subagent，跨项目任务在目标项目建普通 Session，
  保证 `workspace-write` 沙箱正确。
- **可复用 Worker**：连续任务可沿用一个 Worker 的上下文，独立任务仍可并行。
- **模型/思考强度可选**：默认跟随 DSH 宿主全部模型；面板可维护 allowlist、默认 Worker 模型，
  也可选地按 provider/名字过滤，并一键恢复全部。
- **近期活动可打开**：任务列表点开是占满右侧栏的详情卡，含报告、线程、模型和「给 Worker 发指令」；
  也可以直接打开完整 Worker 会话。默认 Worker 模型只在「Worker 模型」抽屉里设置，逐个勾选。
  面板跟随 DSH 的浅色/深色主题。
- **长期工作约定**：用户说「以后都这样」后，Router 把它写成全局或项目规则，注入自己
  和每个 Worker；Reset 不会丢。
- **定时唤醒**：用宿主 `ctx.schedule` 建一次/每日/每周/Cron 任务，到点唤醒 Router 再决定是否派活。
- **原生目标（objective）**：目标 = 客观目标 + 里程碑 + 显式检查节奏。只在到点检查、
  Worker 报告或用户指令时推进；创建/更新目标不会唤醒 Router，也不会自动续轮。
  宿主 goal 的每轮自动续轮在这一条 Router 会话里被禁用（工具摘除 + 执行拒绝 + disarm）。
- **事件驱动**：外部事件进入持久化 Trigger 队列，程序层过滤后合批给 Router。
- **Thread 直通**：已归属 Worker 的讨论后续直接投递，不再经过 Router。
- **可审计**：journal 只追加；活动栏只展示任务，不展示 Worker 内部会话。
- **输入区状态徽标**：每个会话的 composer 工具行左端有一枚 Status 徽标（`运行中 N / 未读 M`），
  没有任务时自动消失；点它回到面板。它只读 `/api/super-agent/ui/state`，不依赖皮肤。
- **多实例**：每个实例有独立名称、目录、模型/规则/计划/未读；侧栏仍只保留一个 Workspace 入口。

## 安装

```sh
dsh plugin --profile web add /abs/path/to/dsh-super-agent
```

重启 `dsh web`，硬刷新页面，点击左栏 **Super-agent**。首次打开会自动准备独立的
Super-agent Workspace，不需要先选项目。

### 多实例

面板左上角的 **Super-agent** 名称是实例切换器。每个实例有独立名称、运行目录、
dataDir、模型/规则/定时任务和未读计数；切换实例不会串数据。新建/重命名都在
下拉里完成。

侧栏只保留一个 **Super-agent Workspace** 锚点；其余实例在
`<锚点>/instances/<id>` 下运行，不额外生成工作区条目。旧安装的锚点根目录和
已有会话/模型/规则原地成为默认实例，不会迁移或覆盖。未读用半透明蓝色气泡
显示：左栏入口右侧是总数，顶部切换器显示总数，下拉每一项右侧显示该实例的
未读数。未读的 **+1 与清零走同一个判定**（`lib/attendance.js`）：面板是该实例、
页面可见、面板心跳新鲜时回复直接算已读（并顺手清掉此前残留），否则回合结束
才 +1，同一回合只记一次；窗口重新获得焦点会补一次上报，因此「在面板里但失去
焦点又回来」不会留下未读。面板可见性由浏览器半部按
「`document.visibilityState` 可见 + `layout.panelInfo.activePanelId` 是本面板」
上报，和清零共用这一个定义。

**「打开面板被自动切走」的根因不在面板本身**：super-agent 派发的 worker 是普通
Session（header 上没有 `origin: 'subagent'`），之前会被 dsh-away-notify 当成用户会话，
在 `turn/end` 时弹通知并写下 `pendingFocus`；下次窗口/标签页回到前台时，away-notify 的
`consumePendingFocus` 会 `switchTo → replaceMain → selectPanel(null)`，于是面板被关、
界面跳到没有用户可读内容的 worker 会话。修复放在源头：worker 创建/恢复时由创建方调用
`awayNotify.markInternal(sessionId, 'super-agent-worker')`（见 `lib/internal-sessions.js`），
away-notify 的 `rootsOnly` 判定就会按「内部会话」静默，不再产生通知和 pendingFocus。

**导航守卫默认关**：曾经为了对抗上述症状加过「没有用户手势就不许切走面板 / 不许换会话」
的守卫，但系统通知点击在页面里没有任何指针事件，这条启发式会把 away-notify 的正常回跳
一起拦掉（表现为「点通知不跳」）。根因修掉后不再需要默认常开：`installNavGuard` 现在
默认放行，只有 `localStorage['dsh.super-agent.navGuard'] = 'on'` 才启用，仅用于诊断
「面板被宿主自动关闭」这类问题；`?navdebug=1` 可看 `__SA_NAV_LOG__`。
复现脚本：`node test/manual/repro-panel-yank.mjs --navdebug`（`NAV_GUARD=on` 时对比装/不装）。

**系统通知点击**：完全交给 dsh-away-notify 的原生行为——普通会话点通知正常跳回该会话；
目标会话被本面板 retain 时由 away-notify 激活面板（`awayNotifyPanels` 显式登记）。
页面不可见/失焦时弹过的通知会在回到前台时被 away-notify 消费，这是它本来的语义；
worker 会话不再弹通知，因此不会再把界面带去 worker。

**同一页面只会跑一份**：同一个包的 client 确实可能求值两次——启动时进聚合 boot
combo（`plugins/??…dsh-super-agent/client.js…&rev=…`），之后 `dsh-client-hmr` 每
500ms stat 轮询 `lib/client.js`，mtime/size 一变就 `clientModules.rebuilt(id)`，
浏览器改从这条行的 one-resource combo（`plugins/??dsh-super-agent/client.js&rev=…`）
重新求值。正常路径宿主会先拆掉旧 entry 的 fiber（我们的 `ctx.effect` 清理随它跑）；
若旧 entry 没被拆掉，两份闭包会同时活着。模块级 WeakMap 挡不住，所以单实例约束
落在 `window` 上：`__dshSuperAgentInstance`（**先到者持有，后到者直接退出**并打一条
`console.warn`，不重复注册）、`__dshSuperAgentNavGuard`（同一 layout 只包一层）、
`__dshSuperAgentNavDebug`（诊断只保一份订阅）。

清理旧实例：`Ctrl+Shift+R` 硬刷新即可（插件读的是磁盘上的 `lib/client.js`，宿主
不需要重启）；刷新后 DevTools Network 里 `plugins/??…super-agent/client.js` 只应
出现一条（boot combo）。

**文件预览为什么不是宿主官方右栏**：官方右栏（`dsh-client-ui-sidebar-right`）在
`activePanelId !== null` 时整体停用——绑定只给「屏上会话」（`lib/client.js:4837`）、
座位组件本身也要 `activePanelId === null` 才渲染（`:1608`），而且 `openResource()`
在没有 mounted 会话时直接抛 `no session surface is mounted`（`:2479-2482`）。宿主也没有
「把某条会话渲染成自定义 surface」的接口：中栏只认 `main` 这个 keyed 槽，渲染键是
`activePanelId ?? 'conversation'`（`dsh-client-ui-layout/lib/client.js:119`），而
`conversation` 已被 ui-conversation 占用（`:20019-20026`）；`uiSession.provide()` 只提供
数据 hooks/props（`dsh-client-ui-session/lib/client.js:849`）。所以插件面板里只能用宿主
同一批正文组件（`CodeBlock` / `MarkdownText`），预览做成**面板内的一列**（宽屏 640、
面板 < 1000 时 480，可拖到 360–720）：对话区 `flex:1 1 auto; min-width:0` 跟着变窄，
观感与官方三列一致。

座位归属把这条路彻底堵死：`shell.leading` 归 `dsh-client-ui-sidebar`（`lib/client.js:523`）、
`rightbar` 归 `dsh-client-ui-sidebar-right`（`:4915`），`main` 里 `conversation` 归
ui-conversation；唯一可注入的是会话自己的 `main.conversation` 子槽
（ui-conversation 渲染于 `:17887`），它只能**加**一块 UI 到会话面板里，既替换不了会话、
也不给我们的 Router 侧栏一个座位。要真正复用官方右栏，需要宿主把 `mounted` 绑到
「当前面板 retain 的会话」而不是 `undefined`（一行改动，不在我们仓库）。

截图：`docs/screenshots/preview-column-closed-light.png`（预览关：对话区独占全宽）、
`preview-column-open-light.png`（打开后对话区让位）、`preview-hw7-dark.png`
（真实 `hw7.tex` 正文，latex 高亮 + 行号）。

点通知回到产生它的实例：面板把 `panelId` / retain 来源 / `showSession` 一起注册给
`dsh-away-notify`（见它的 `docs/plugin-api.md`「面板点击落点」）。点击后先选中面板，
再用 `/ui/state` 的 `routers` 把会话映射到实例，然后切实例（`/ui/instances/active` +
ensure）并 adopt 那条会话；面板顶部给一条可撤销的提示（「返回」回到你原来看的实例与
会话）。**已经在目标实例/面板上也照样定位**，不会变成空操作。

**自动跟随默认开**（显式 `localStorage['dsh.super-agent.navFollow']='off'` 才关闭）：
点通知 → 选中面板 → 切到对应实例 → adopt 那条 Router 会话，和普通会话点通知一样。
保留「跟随：关」开关只是留给「切回窗口不想被任何待跳转会话带走」的场景；关闭后只出
提示条 +「定位」按钮，点击不自动跳。

**Router 会话常驻 retain**：插件按 `/ui/state` 的 `routers` 在插件层 retain 所有 live
Router（来源 `superAgentUi`，与面板内的 retain 叠加）。这样即使面板关着，away-notify
的 `panelForSession` 也能看到「这条会话属于 super-agent 面板」，走
`selectPanel(panelId) + showSession` 分支；不会掉进 `switchTo → openSession →
replaceMain('reveal') → selectPanel(null)`（那条会关面板、把 Router 开成主视图里的普通
会话）。Router 消失/实例关闭/插件卸载时释放常驻 retain。

排障：地址栏加 `?navdebug=1` 打开导航诊断（默认关闭；结构化一行：`{type,source,target,at,detail}` + 两帧调用点）。每条日志都带 `source`：
`layout.panelInfo`（宿主直接写 store，如 `retainMainPanels`）、`layout.selectPanel`
（宿主或别的插件调服务）、`away-notify.showSession`（点通知/焦点恢复回跳，附
`trigger: foreground|regain` 与可见/焦点快照）、`super-agent.*`（我们自己）。之后每次 `activePanelId`
变化、实例/会话切换都连同**调用栈**打到 console（前缀 `[super-agent][nav]`），并累积在
`window.__SA_NAV_LOG__`（最多 500 条，整段复制即可）。复现一次「被切走」就能看到是谁
改的（`dsh-away-notify` 的 focus 回跳、面板自己的 ensure/挂载快照都在栈里）。

## 使用

- 直接输入任务；Router 根据描述和 `superagent_projects` 选择目标项目。
- 右侧「近期活动」按更新时间倒序显示进行中和已结束的任务；默认 6 条，可展开。
  点一条任务会在右侧活动栏内打开详情卡：状态、项目、模型/强度、Brief、报告、线程，以及
  「给 Worker 发指令」；卡片底部固定「打开聊天」，可直接回到完整 Worker 会话。
  关闭任务只释放运行中的 Agent，会话仍保留，所以历史任务也能回看。
- 顶部「Worker 模型」按钮打开统一抽屉：逐个勾选可调用模型、设置默认模型和
  每个模型的 effort 限制；默认值不再在顶栏重复一份。
- 「Rules」维护长期工作约定；「Schedules」管理定时唤醒。
- 多步目标用 `superagent_goal`（create/check/update/close/list）：给目标写清完成标准、
  里程碑和检查节奏。派活时把 `objective_id` 传给 `superagent_dispatch`，Worker 报告
  会自动记一次检查。旧会话里已暂停的宿主 goal 可用 `action: "import"` 迁移成原生目标，
  宿主 goal 保持暂停且不再续轮。
- 「Reset」二次确认后中止当前 Worker、归档旧 Worker 会话、取消绑定当前 Router 的定时任务、
  切换新的数据目录 generation、创建新 Router。
- Worker 会话和内部 `[super-agent]` trigger 不出现在侧栏/聊天流。
- 会话里的文件链接（工具行的路径、`@file`、交付卡片）在面板内打开官方渲染的预览抽屉：
  代码用官方 `CodeBlock`（shiki 高亮、行号、复制、换行），markdown 用 `MarkdownText`，
  图片用 `readBytes` 转 object URL 显示。原因：面板是全局 `main` 面板，右侧栏此时
  没有「屏上会话」，官方 `openResource` 会报 `sidebarRight: no session surface is mounted`
  （官方座位整体 `hidden`，也没有对外渲染 tab 正文的入口）；所以插件只在「没有屏上
  会话」时包装这个公开方法，正文复用官方组件、读取走公开的 `remote.workspaceFiles`。
  该能力在浏览器里是独立的 Cordis 服务，必须 `ctx.inject(['remote.workspaceFiles'], …)`
  取，写成 `ctx.remote.workspaceFiles` 会因未声明 inject 而抛错；接口或官方组件缺席时
  预览给出可读提示和重试按钮，面板照常工作。PDF/Office/视频面板不渲染，提示用官方
  链接查看。普通会话里的文件链接仍然走官方右侧栏，行为不变。
  预览是**面板里的一列**（不是浮层）：宽屏 640、面板 < 1000 时 480，左缘可拖拽
  （360–720，始终给对话区留 ≥ 320；方向键微调、双击 480/640 切换）；打开时不再渲染
  右侧「近期活动栏」，关闭后恢复。行为对齐宿主右侧栏：一个文件一个标签，点新文件
  **追加并激活**、不关已有标签；同文件重复点击只激活；标签栏可横向滚动（文件名 +
  类型图标 + 当前标签高亮 + 每个标签的关闭按钮）；关当前标签激活相邻、关到最后一个
  才收起整列；每个标签正文常驻，切换不重新读取、不丢滚动。`Esc` 逐级关标签；点会话
  里的另一个文件链接是「再开一个标签」，不会先把整列关掉。官方渲染器万一在渲染期
  抛错，只让该标签正文显示错误态（含「重试」），面板和宿主界面都不受影响，不需要刷新。
  截图：`preview-tabs-light.png` / `preview-tabs-dark.png`（两个文件、两个标签）；
  旧版单文件对照 `preview-column-{closed,open}-light.png`、`preview-hw7-dark.png`。

### Worker 复用

Router 可在 `superagent_dispatch` 里传 `reuse_task_id`，让新任务复用某个已完成
任务的 Worker 上下文：

```json
{
  "title": "继续修登录测试",
  "brief": "基于上一轮失败日志继续。",
  "project": "project6",
  "reuse_task_id": "tsk_..."
}
```

源任务必须是 `idle`/`blocked`/`resumable`，目标 cwd/project 必须一致，且 Worker
当前没有其他执行中任务。需要独立并行时不要复用。细节见 [docs/usage.md](docs/usage.md)。

### 重启后继续

任务注册表（id、title、brief、cwd/project、workerSessionId、状态、objective、模型、
时间戳）就在 journal 里，`dsh web` 重启后照样读回来。Worker 会话本身存在 DSH 的
会话库里（`~/.dsh/sessions/<project>/<sessionId>/`），启动时会试着用
`sessionController.resolveAgent()` 把每条还需要的会话装回内存：

- `resumable`：会话救回来了，上下文完整、当前空闲。用 `reuse_task_id` 接着做。
  被打断的那一轮 turn 不会重放（做不到，也不该假装做到）。
- `interrupted`：会话救不回来。任务与 brief 都还在，`reuse_task_id` 会用它起一个
  新 Worker（继承项目/模型/目标/线程，记 `resumedFrom` 谱系），或直接 close。

`superagent_status` 能看到这两种状态；它们在 UI 活动列表里也有独立标签。

## 配置

项目配置在 `<project>/.dsh/super-agent.json`；UI Router 使用独立 workspace 的
配置，默认写到平台应用数据目录：

| 平台 | 路径 |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/dsh-super-agent/workspace` |
| macOS | `~/Library/Application Support/dsh-super-agent/workspace` |
| Windows | `%LOCALAPPDATA%\dsh-super-agent\workspace` |

可用 `DSH_SUPER_AGENT_HOME` 或 profile 的 `superAgentHome` 覆盖。完整配置、CLI、
HTTP 端点和频道桥见 [docs/usage.md](docs/usage.md)。

### 只允许一个来源的模型

如果宿主同时配置了多个渠道，但只想让 Worker 用其中一家的几个模型，可以同时设置
`onlyProvider` 和 `onlyNames`，不用把每个 model id 抄一遍：

```json
{
  "models": {
    "onlyProvider": "dsh-provider-qoder",
    "onlyNames": ["DeepSeek-Flash", "Qwen3.8-Flash", "GLM-5.3-Flash"],
    "default": "",
    "defaultEffort": ""
  }
}
```

`onlyNames` 的顺序也是默认模型优先级；名字匹配 model id / 显示名，大小写不敏感。
`allowed` 非空时以显式 allowlist 为准，`onlyProvider` / `onlyNames` 只影响空
allowlist 时的可见目录。

## 文档

- [使用与配置](docs/usage.md)
- [架构与不变量](docs/design.md)

## 开发

```sh
npm test
```

测试不调用模型；另有隔离 profile + 脚本化 LLM + Playwright 的端到端验证记录，
见 [docs/design.md](docs/design.md)。

## 边界

- 单机、单进程；状态在项目 dataDir 的 journal 里。
- Worker 会话不跨宿主进程恢复；重启后活动任务会转 `interrupted`，由 Router 决定。
- 跨项目 Worker 使用 DSH 普通 Session，审批走项目默认策略。
- 插件不直接调用 IM/GitHub API；频道桥读 outbox。
- 没有删除/清理逻辑；journal、旧 generation 和归档会话都保留。
- 目标的 `objective.*` 是新增 journal 事件：旧版本读新 journal 会忽略它们，新版本读
  旧 journal 只是没有目标，两边都不需要 schema 迁移。
