# Changelog

## Unreleased

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
  行号」交给面板自带的预览抽屉（读 `remote.workspaceFiles` 一页并按行渲染）；
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
