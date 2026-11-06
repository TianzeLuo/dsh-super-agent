# Changelog

## Unreleased

### Added

- **预览列多标签（对齐宿主右侧栏）**：一个文件一个标签，点新文件追加并激活、不关已有
  标签；标签栏可横向滚动，文件名 + 类型图标 + 当前标签高亮 + 每个标签的关闭按钮；
  关闭当前标签激活相邻、关到最后一个才收起整列；同一文件重复点击只激活已有标签。
  列宽可拖拽（360–720），宽屏默认 640、面板 < 1000 时 480，且始终给对话区留 ≥ 320；
  方向键微调、双击在 480/640 间切换。每个标签的正文常驻（切换不重新读取、不丢各自
  滚动），打开/关闭/切换都不重置对话滚动。预览打开时**不再渲染近期活动栏**（不是盖住），
  关闭后恢复。点会话里的另一个文件链接不会再把整列关掉（预览列禁用 outside-dismiss，
  Esc 逐级关标签）。回归 `test/preview-tabs.test.mjs`、`test/preview-drawer.test.mjs`；
  截图 `docs/screenshots/preview-tabs-light.png` / `preview-tabs-dark.png`。

### Fixed

- **根因：worker 会话触发 away-notify 通知 → 面板被关/界面切到 worker**。worker 是普通
  Session（`SessionHeader.origin` 只允许 `'subagent'`，worker 没有该标记），away-notify
  会在它的 `turn/end` 弹通知并写 `pendingFocus`；用户回到前台时 away-notify 原生消费
  pendingFocus（`switchTo → replaceMain → selectPanel(null)`），于是关掉本面板、跳到没有
  用户可读内容的 worker 会话。创建方现在在创建/恢复 worker 时调用
  `awayNotify.markInternal(id, 'super-agent-worker')`（`lib/internal-sessions.js`），
  关闭/归档时释放；away-notify 的 `rootsOnly` 判定按「内部会话」静默，不再产生通知与
  pendingFocus。回归：`test/internal-sessions.test.mjs`、`test/plugin.test.mjs`
  （worker 创建登记/关闭释放/服务晚到补登记）。
- **导航守卫改为默认关，恢复 away-notify 原生行为**：系统通知点击在页面里没有指针
  事件，「无手势就拦」的启发式会误伤正常回跳（点通知不跳）。现在默认完全放行，只有
  `localStorage['dsh.super-agent.navGuard']='on'` 才启用（诊断用）；默认关时还会主动
  拆掉上一版默认开启时留在 `window` 上的守卫（HMR 后立即生效）。单实例约束保留。
- **切标签页回来又被切走（放行判据误伤）**：`hidden→visible`（0.4–20s）与「点系统通知」
  在页面里不可区分，已删除该启发式。现在只认两条确定性信号：页面内手势、
  `?dshAwayNotifyFocus=<id>`（绑 sessionId、一次性）。系统通知点击改为**不自动跳**：
  把 Super-agent 面板切到前台并显示「定位」提示条，用户点一下才切。
- **点通知后整块面板被关（守卫静默消失）**：只有属主能还原守卫，非属主 install 返回
  空操作；`replaceMain('reveal')` 也纳入守卫（`'preserve'` 启动/恢复放行）；
  `visibilitychange` 时自愈 `selectPanel` 包装（`nav.healed`）。

### Added

- **预览列多标签（对齐宿主右侧栏）**：一个文件一个标签，点新文件追加并激活、不关已有
  标签；标签栏可横向滚动，文件名 + 类型图标 + 当前标签高亮 + 每个标签的关闭按钮；
  关闭当前标签激活相邻、关到最后一个才收起整列；同一文件重复点击只激活已有标签。
  列宽可拖拽（360–720），宽屏默认 640、面板 < 1000 时 480，且始终给对话区留 ≥ 320；
  方向键微调、双击在 480/640 间切换。每个标签的正文常驻（切换不重新读取、不丢各自
  滚动），打开/关闭/切换都不重置对话滚动。预览打开时**不再渲染近期活动栏**（不是盖住），
  关闭后恢复。点会话里的另一个文件链接不会再把整列关掉（预览列禁用 outside-dismiss，
  Esc 逐级关标签）。回归 `test/preview-tabs.test.mjs`、`test/preview-drawer.test.mjs`；
  截图 `docs/screenshots/preview-tabs-light.png` / `preview-tabs-dark.png`。

### Fixed

- **刷新 + 重启后点系统通知仍会被踢回普通会话视图**：根因不是缺入口，而是守卫被
  静默拆掉——同一个 layout 上第二份实例的还原会连带把守卫卸掉（HMR 卸旧条目时必现），
  之后 `selectPanel(null)` 与 `replaceMain('reveal')` 都无人拦。现在只有属主能还原，
  并在每次 `visibilitychange` 自愈（`nav.healed`）；同时把 `replaceMain` 也纳入守卫
  （`'preserve'` 启动/恢复直接放行，只守 `'reveal'`）。

- **点通知不再跳转（守卫误拦的回归）**：系统通知由 OS 弹出、点击走 `dshnotify:`
  协议置前窗口，页面里没有指针事件，被「无手势跨会话拦截」挡掉了。曾用
  `?dshAwayNotifyFocus=` + 「hidden→visible 且离开 0.4–20 秒」放行；后者与切标签页
  不可区分，已在后一轮删除，见上文「切标签页回来又被切走」。

- **刷新后仍被切到另一个已有会话**：away-notify 的 pendingFocus 走
  `uiWorkspace.openSession → replaceMain`，绕过 `selectPanel` 守卫，会话在
  `replaceMain` 里就换掉了。现在守卫同时包一层会话打开器（`uiWorkspace.openSession`
  与 `sessions.open`）：无手势窗口（1.5s）的跨会话跳转一律拦下，降级为面板内
  「定位」提示条；启动/首次导航、目标即当前会话、`authorizeNavigation()` 授权的
  自有导航放行。

- **P0：点文件链接后整屏变黑、只能刷新**。预览以前用共享的「弹层」外壳：一层
  `position: absolute; inset: 0` 的遮罩铺满面板、盖在面板内容之上（`S.backdrop`，
  `background: T.mask`）。面板占的就是宿主整个主区域，所以遮罩一上就是「整个界面
  变黑」；遮罩默认接收指针事件，面板因此整体点不动，唯一可以点的只有右侧那条抽屉
  （正文若还在加载/报错，看起来就是彻底卡死）。改成**真正的右侧抽屉**：贴面板右侧、
  宽 520/640、`top/bottom: 0`、正文自己滚动、**不画遮罩**，`Esc` / 头部关闭按钮关闭
  （预览列不响应「点外面」：那是在会话里再开一个文件标签），`z-index` 在面板内容
  之上、宿主对话框之下。另加**渲染错误边界**：官方
  `CodeBlock`/`MarkdownText` 渲染期抛错时只让抽屉正文显示错误态（消息 + 重试），
  面板与宿主界面继续可用；面板整体也包了一层边界，最坏情况是面板里一张错误卡片，
  不再是黑屏。回归用例 `test/preview-drawer.test.mjs`，截图见
  `docs/screenshots/preview-drawer-*.png`。

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

### Fixed

- **刚打开面板就被自动切走**。宿主有三条不经过用户点击就会关掉面板的路径：
  `ui-layout` 的 `retainMainPanels`（`dsh-client-ui-layout/lib/client.js:410`，`:689`
  订阅 main 槽、`:614` 取注册表，条目瞬时缺失就把 `activePanelId` 置 null）、
  `ui-workspace` 的 `replaceMain(…, 'reveal')`（`:1673`，任何
  `uiWorkspace.openSession` 都经过它，包括 away-notify 的通知落点回退）和
  `clearMain()`（`:1649`）。插件现在装**面板守卫**：本面板激活期间，
  `layout.selectPanel` 的「切走」必须带最近 1.5 秒内的真实手势，且手势是一次性令牌
  （点开面板那一下不替随后的自动关闭背书）；拦下的调用记 `nav.blocked`。
  直接写 store 的路径（`retainMainPanels`）由 `panelInfo` 订阅兜住：等一个 tick，
  我们的 main 条目还在就恢复面板（`nav.restored`，附关闭时的调用栈），条目没了就
  放行。开关：`localStorage['dsh.super-agent.navGuard'] = 'off'`。
  复现：`node test/manual/repro-panel-yank.mjs --navdebug`；用例
  `test/nav-guard.test.mjs`。

### Fixed

- **预览正文 `.tex`/Markdown 抛 `Cannot read properties of undefined (reading 'code')`**：
  宿主 `MarkdownText` 渲染代码围栏时读 `labels.code.{copyLabel,toolbarLabels}`、
  `CodeBlock` 横幅读 `toolbarLabels.codeLabel`（对照
  `dsh-client-ui-sidebar-documentpreview` 的 `CodeBody` 与 `dsh-client-ui-tool`
  的 `codeToolbarLabels`）。我们只传了 `text`，现在按官方形状补 `labels` /
  `toolbarLabels`（中英文案一并补齐）。
- **预览从浮层改成面板内的一列**：占 560px（最宽 640px），对话区 `flex:1 1 auto;
  min-width:0` 跟着变窄，不再盖住内容；Esc / ✕ 关闭（停靠列不再点外部关闭）。

### Fixed

- **同一页面跑了两份客户端**：启动时聚合 boot combo 一份，之后 `dsh-client-hmr`
  每 500ms stat 轮询 `lib/client.js`，mtime/size 一变就让浏览器从该行的 one-resource
  combo 重新求值；旧 entry 没被拆掉时两份闭包同时活着，守卫叠两层、navdebug 订阅两份、
  away-notify 收到两个 `showSession`。现在用 `window` 上的全局槽做跨闭包单实例：
  **先到者持有，后到者直接退出并 `console.warn`**（不接管、不重复注册），守卫按 layout
  只包一层，诊断只保一份订阅，卸载时让出槽位。清理旧实例只需硬刷新页面，不必重启
  `dsh web`。
- **预览接口非 ok 时按成功结构取正文**：`readFilePreview` 现在保留 `RemoteResult.error.code`，
  错误态显示「code: 原因」；`previewBodyOf` 遇到非字符串正文只出提示，不再把 `undefined`
  喂给 `CodeBlock`/`MarkdownText`（TypeError 的下游来源）。
- **navdebug 打印 `Object Error: navdebug`**：改成结构化一行
  `[super-agent][nav] {"type","source","target","at","detail"}` + 两帧调用点。

### Added

- **预览宽度对照 + 真实数据截图**：`preview-column-closed-light.png` /
  `preview-column-open-light.png`（预览打开后对话区真正缩宽）、
  `preview-hw7-dark.png`（真实 `/mnt/f/code/dsa/homework/hw7.tex` 正文）。
- **真实文件回归**：`test/preview-body.test.mjs` 读真实 `hw7.tex`（缺失则跳过），
  CodeBlock / Markdown 两条路径都断言宿主读取的字段存在。

### Changed

- **导航日志加来源标签**（`source`）：`layout.panelInfo` / `layout.selectPanel` /
  `away-notify.showSession`（附 `trigger: foreground|regain` 与可见/焦点快照）/
  `super-agent.*`，复现「被切走」时一眼看出是谁改的。
- **自动跟随通知默认关**（`localStorage['dsh.super-agent.navFollow']` 写 `on` 才开）。
  away-notify 在**发通知时**就写下待跳转会话（`host.js:461-465`，TTL 90 秒 `:721`），
  之后任意一次焦点/可见性恢复都会消费（`client.js:1139-1153`）——这就是「刚打开面板
  就被切走」「切到的界面没有活动」的机制。页面内无法区分「点通知」与「切焦点」
  （只有 `showSession(sessionId)` 一条通路，没有来源标记），所以默认只提示不跳：
  面板顶部给「定位」提示条，顶部新增 **「跟随：关 / 跟随：开」** 按钮
  （提示条里也有「以后自动跟随」）。开关只影响本面板的自动落点，通知与点击选中面板不受影响。

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
