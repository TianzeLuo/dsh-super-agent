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

点通知回到产生它的实例：面板把 `panelId` / retain 来源 / `showSession` 一起注册给
`dsh-away-notify`（见它的 `docs/plugin-api.md`「面板点击落点」）。点击后先选中面板，
再用 `/ui/state` 的 `routers` 把会话映射到实例，然后切实例（`/ui/instances/active` +
ensure）并 adopt 那条会话；面板顶部给一条可撤销的提示（「返回」回到你原来看的实例与
会话）。**已经在目标实例/面板上也照样定位**，不会变成空操作。三处可关：
提示里的「以后不自动跟随」只提示不跳转（`localStorage['dsh.super-agent.navFollow']`），
需要时点「定位」。

排障：地址栏加 `?navdebug=1` 打开导航诊断（默认关闭）。之后每次 `activePanelId`
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
  预览是**右侧抽屉**：贴面板右侧、宽 640（设置类 520）、高 100%、正文自己滚动，
  **不画遮罩**——左栏、顶部和输入框始终可见可点；`Esc`、右上角 ✕、点抽屉外都能关。
  官方渲染器万一在渲染期抛错，只让抽屉正文显示错误态（含「重试」），面板和宿主界面
  都不受影响，不需要刷新。截图：`docs/screenshots/preview-drawer-{light,dark}.png`
  （生成脚本 `test/manual/make-preview-screenshots.mjs`，用的是 `lib/client.js` 里
  真实的样式对象）。

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
