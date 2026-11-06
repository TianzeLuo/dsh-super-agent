# Changelog

## Unreleased

### Added

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
