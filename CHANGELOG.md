# Changelog

## Unreleased

### Fixed

- **点通知不跳转（多实例）**：面板只把 `panelId` / retain 来源注册给
  `dsh-away-notify`，没注册 `showSession`，所以点击最多把面板选中——面板仍停在它当时
  显示的实例上，且 away-notify 完全没有实例概念（`layout.selectPanel` 是它唯一能做的
  事，见 `docs/plugin-api.md`「面板点击落点」）。现在注册 `showSession`，点击后依次：
  `selectPanel` → 用 `/ui/state` 的 `routers` 把会话映射到实例 → 切实例
  （`/ui/instances/active` + ensure）并 adopt 该会话。**已在目标实例/面板上也照样执行
  定位**，不再有「状态没变就早退」的空操作；面板顶部给一条可撤销提示（「返回」回到原
  实例+会话）。切换实例失败时只提示、不改当前会话；认不出的会话不 adopt（避免落到空
  会话），改为提示。请求在面板挂载前排队（away-notify 是 `selectPanel` 之后同步回调），
  挂载后消费；`showSession` 的落点与挂载快照的竞态用 5 秒保护窗避免互相覆盖。

### Added

- **导航诊断开关** `?navdebug=1`（默认关闭）：`activePanelId` 变化、实例切换、会话切换
  连同调用栈写进 console（`[super-agent][nav]`）并累积到 `window.__SA_NAV_LOG__`
  （500 条上限）。关闭时只有一次字符串判断，不订阅服务、不在 window 上留东西。
- **通知自动跟随开关**：提示里的「以后不自动跟随」把
  `localStorage['dsh.super-agent.navFollow']` 设为 `off`，之后点击通知只提示、由用户点
  「定位」再跳。这是面板侧对 `dsh-away-notify`「回到前台就跳会话」的抑制（它的待跳转
  会话在**发通知**时写入 `lib/host.js:463-464`，客户端在任意焦点/可见性恢复时消费
  `lib/client.js:1139-1141`，TTL 90 秒 `lib/host.js:136`），不需要全局关掉
  `openOnClick`（那会把点击完全变成不可用，而且会让「点通知回 dsh」这条唯一通路失效）。

### Changed

- **文件预览改用官方渲染器**（替代上一轮的自绘抽屉）。官方右侧栏预览在插件面板里
  打不开：面板占着 `main` 槽，`layout.panelInfo.activePanelId` 非空，
  `dsh-client-ui-sidebar-right` 的座位整体 `hidden: !active`，`openResource` 的
  `require()` 也拿不到屏上会话；`openResourceIn(sessionId, …)` 只能把 tab 放进隐藏的
  座位，官方 tab 正文又是 keyed 槽条目、没有对外渲染入口。所以插件保留自己的抽屉壳，
  正文交给官方 primitives：代码 → `CodeBlock`（shiki 高亮、行号、复制、换行；从
  第 N 行开始读时补空行让行号对齐文件真实行号），markdown → `MarkdownText`，
  图片 → `readBytes` 字节转 object URL。PDF/Office/视频明确提示到官方链接查看；
  读取失败/接口缺失/组件缺失都有文案和重试按钮。读取仍走公开的
  `remote.workspaceFiles`（`read` 一页文本、`readBytes` 整文件并拆 `RemoteResult`）。
  删掉自绘的逐行 `<pre>` 渲染（`previewScroll`/`previewPre`/`previewLine*` 样式、
  行高亮 ref、`targetLine` 状态字段），新代码只 require 一个额外的 seed 模块
  `@deepseek-ai/dsh-client-ui-primitives`（缺它则显示提示，不影响其它功能）。

### Added

- **重启恢复**：Worker 会话只存在于宿主内存里，`dsh web` 重启后整批消失、任务被
  判 `lost`。现在 `start()` 会异步跑一次恢复：任务注册表本来就在 journal 里
  （`task.created/updated` 带 id/title/brief/cwd/workerSessionId/status/objective/
  模型/时间戳），重启后读回；对每条还需要的任务调用宿主
  `sessionController.resolveAgent(sessionId)`（`lib/index.js` 的 `resumeWorker` 桥，
  runtime 不认识任何 `@deepseek-ai/*` 包）把磁盘上的会话装回内存。救回来 → 标
  `resumable`（上下文完整、可 `reuse_task_id` 继续）；救不回来 → 标 `interrupted`
  （新状态，取代重启路径上的 `lost`），保留 brief 供 `reuse_task_id` 起新 Worker。
  `lib/recovery.js` 是纯判定（`planRecovery`/`resumedPatch`/`interruptedPatch`），
  runtime 只做 IO。**不重放被打断的那一轮 turn**（做不到，也不假装做到）。旧 journal
  没有这些字段时按默认值读，无迁移；`lost` 仍保留给「跑着的时候会话被宿主回收」。
- `superagent_dispatch` 的 `reuse_task_id` 现在也接受 `resumable`（续同一会话）与
  `interrupted`/`lost`（起新 Worker，继承项目/模型/目标/线程并记 `resumedFrom`）；
  `superagent_status detail=full` 额外给出每条任务的 brief，方便直接重新派工。

- **composer 状态徽标**：注册 `conversation.input.left`（会话级 list 槽），在聊天输入区
  左端显示「运行中 N · 未读 M」。计数复用 `/api/super-agent/ui/state`（`activeWorkers`
  与 `unreadTotal`），没有新协议、没有额外端点；两项都为 0 时不渲染、不占位。点击回到
  `super-agent` 面板（`layout.selectPanel`，服务缺席时静默）。样式全内联且只用
  `currentColor`/中性边框，因此不装任何皮肤也正常显示；侧栏入口的未读气泡与徽标共用
  同一条 4 秒轮询和同一个计数器，不再各发一份请求。

- **原生目标（objective）**：`superagent_goal` 用「客观目标 + 里程碑 + 显式检查节奏」表达
  长期目标，状态存 journal（`objective.created/updated/checked/closed`，旧版本忽略、
  旧 journal 无需迁移）。推进只来自三种来源：到点的宿主 schedule 检查、挂在目标上的
  Worker 报告（`superagent_dispatch` 的 `objective_id`）、用户指令。创建/更新目标不唤醒
  会话、不制造 0 延迟调度，因此不会出现空转回合。动作：`create`/`list`/`check`/`update`/
  `close`/`import`（把已暂停的宿主 goal 迁移成 manual 节奏的目标）。
- Router 启动时若会话里已有宿主 goal（含之前 paused 的 dsh-chatgpt-ui 交付目标），
  自动复制成 manual 节奏的原生目标并 disarm；同一个 hostGoalId 只迁一次，已完成的
  goal 不迁。也可用 `action: "import"` 手动重跑。
- Router 会话里禁用宿主 goal 的自动续轮：`tools.restrict` 摘掉 `create_goal`/
  `update_goal`，`tools.guard`（无此接口时退回 `tools/pre-execute`）拒绝执行，
  `goals.disarm` 在安装时和每次 `goal/changed` 时取消续轮授权。`get_goal` 保留只读。
  普通会话不装本插件，行为不变；DSH 内核无改动。

### Fixed

- **文件链接在 Super-agent 面板里打不开**。面板注册为全局 `main` 面板，右侧栏因此没有
  「屏上会话」，官方 `sidebarRight.openResource` 会对会话里的每个文件链接抛
  `sidebarRight: no session surface is mounted`。插件现在在面板挂载期间只包装这一个
  公开方法：没有屏上会话且地址是 `dsh-resource://file/…` 时，解析成「会话 + 路径 +
  行号」交给面板自带的预览抽屉（读取走 `remote.workspaceFiles`，正文见上一条 Changed）；
  其余情况（普通会话语义、非文件资源、面板已卸载）原样调用官方实现。
  覆盖的工具行路径、`@file` 引用和交付卡片都走同一条 `openResource` 路径。

- **预览抽屉提示「这个宿主没有提供文件读取接口」**（上一轮修复的后续）。`workspaceFiles`
  在浏览器里不是 `ctx.remote` 的普通属性，而是 api-gateway 装出来的独立 Cordis 服务
  `remote.workspaceFiles`；cordis 的嵌套服务转发按调用方 fiber 的 `inject` 过滤，插件
  没声明过就抛 `cannot get property "remote.workspaceFiles" without inject`，旧的
  `service(ctx, 'remote')` 又把这次 throw 当成「服务不存在」。现在改用官方写法
  `ctx.inject(['remote.workspaceFiles'], …)` 等命名空间就绪并缓存；读取按宿主契约
  `read(sessionId, path, { offset, limit }, signal)` 调用，并拆开生成的 `RemoteResult`
  （`{ ok, value }` / `{ ok: false, error }`）——之前即使拿到接口也会把包络当成正文。
  接口缺席仍然只显示降级提示，不崩溃。`package.json` 的 `dsh.client.inject` 不需要改：
  那一层是模块到达顺序，服务可用性由 `ctx.inject` 负责。

- **未读不清零 / 切回面板被重置 / 打字时被切走**。三处都出在「当前选择」被
  多处各自维护：
  - 未读的 +1 与清零原本是两套条件（`turn/end` 里跳过 +1，但没人负责清零），
    于是人就在面板里也会越攒越多、点消息区也不会清。现在合并进
    `lib/attendance.js` 的 `replyEffect`：面板可见时回复即已读**并清零**，
    不可见才 +1；浏览器半部的 `visible`/`read` 也改用同一个 `panelVisibleNow()`
    （页面可见 + `layout.panelInfo.activePanelId` 是本面板），心跳与窗口
    `focus`/`pageshow` 都会补一次上报，`document.visibilityState` 失焦再回来
    的残留也随之清掉。
  - 面板的 `sessionId` 只是组件 state，一重挂（切面板 / HMR / 布局重排）就归零，
    先闪「新会话」落地页再等 `ensure`；现在用内存级续接值先渲染同一条 Router，
    并在挂载时先读 `/ui/state` **沿用宿主活着的 Router**（只有确实没有才
    `ensure` 新建），因此重挂不再落到空面板、也不会多建会话。
  - 所有会话写入收敛到 `sessionTransition`：只有用户动作（切实例 / Reset / 重试）
    与挂载时的宿主快照能改，轮询、未读、徽标、worker 报告等事件回调一律不改，
    避免输入过程中被切走。
  未读仍只存内存，不持久化。
