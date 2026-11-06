# Worker 审批阻塞：检测、通知与策略化自动回答

本文记录 super-agent Worker 在宿主要求**手动审批权限**时的问题、宿主 API 结论、
三层设计与当前落地范围。结论先行：

- 宿主**没有** `approvals.*` 或 `remote.approvals` 这样的注册表服务；审批等待是
  `ctx.approval`（`ApprovalService`）派发的一次 **agent/session 作用域 waterfall**，
  `approval/request`。可以在某个 Worker 的 `agent.ctx` 上注册 listener，只回答
  那条会话的请求（见 §1）。
- `approval/asked` / `approval/decided` 是**会话事件**，插件现有的
  `session/event` 转发能看到；`user-questions/request` 是另一条 waterfall，不是
  session 事件（见 §2）。
- Worker 等审批时 Agent 状态仍是 `running`，没有 `awaiting-approval` 状态；旧
  watchdog 只看 starting 超时、worker 丢失、working+idle，所以**完全看不到**
  审批阻塞（见 §3）。
- 本版本落地 **A（检测与可见性）**；B（策略化自动回答）只预留策略解析、
  dispatch 参数、journal 字段与 answerer 工厂，不注册；C 仍是现有面板/outbox
  人工通道（见 §4）。

## 1. 宿主审批链路

宿主编译产物在 `@deepseek-ai/dsh-user-approval`（DSH 0.2.1-rc.1）：

| 位置 | 事实 |
| --- | --- |
| `lib/types/index.js:121-138` | `ApprovalService.request()`：必须在打开的 turn 内；先 append `approval/asked`（`:129`），再 `decide()`（`:135`），最后 append `approval/decided`（`:136`）。 |
| `lib/types/index.js:169-206` | `decide()`：`never` 策略在这里直接 rejected（`:177`）；否则 `ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, () => 'unavailable')`（`:184`）。**这就是 answerer 注册点**。 |
| `lib/types/types.d.ts:26` | 结果只有 `allowed-once` / `rejected` / `cancelled` / `unavailable`；只有 `allowed-once` 是放行。 |
| `lib/types/types.d.ts:55-83` | `ApprovalRequestEvent` 带 `agent`、`toolName`、可选 `callId` / `reason` / `signal`；waterfall 签名见 `:81`。`agent-scoped listeners receive only that agent`。 |
| `lib/types/index.d.ts:20-22` | Cordis Context 上的服务名是 **`approval`**（`ApprovalService`），不是 `approvals`。 |
| `lib/types/index.d.ts:34-38` | `approval/policy` 只有 `ask` / `never`；这是宿主策略，不等于本插件的 `auto-workspace`。 |
| `@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:18` | `approval/request` 以 waterfall 模式转发给远程/客户端 answerer。 |
| `@deepseek-ai/dsh-client-ui-approval/lib/client.js:355` | 官方 UI 通过 `ctx.remote.$on('approval/request', ...)` 回答；它靠 `request.agent` + 作用域只处理自己会话。 |

**能否按会话注册 answerer？能。** 两种方式：

1. **宿主侧（本插件适用）**：拿到某个 Worker 的 `agent.ctx` 后
   `agent.ctx.on('approval/request', (request, next) => outcome)`。因为 `request()`
   用 `scopeTarget(req.agent, req.agent)` 派发，只有注册在该 agent 作用域上的
   listener 会收到；全局 listener 也能收到，但必须自己用
   `request.agent.id` / `request.agent.session.id` 匹配会话，不能误答别人的请求。
2. **客户端侧**：`ctx.remote.$on('approval/request', ...)`，同样按作用域/agent
   路由；面板要“一键 allow/deny”时应走这条，而不是直接改宿主 session。

没有 `approvals.register()` 之类的 API；answerer 就是普通 Cordis waterfall
listener。返回一个 outcome 即 claim；`next()` 交给下一个 answerer；没有 answerer
时服务 fail-closed 为 `unavailable`。`ctx.userQuestions` 是问句侧的同构服务：
`@deepseek-ai/dsh-user-questions/lib/types/index.js:326-327` 同样用
`scopeTarget(agent, agent)` 派发 `user-questions/request`，声明在
`lib/types/types.d.ts:145`；它没有 `questions.*` 注册表。

## 2. 事件流与状态

- `approval/asked`、`approval/decided`（不是 `approval/resolved`）是 log-only 的
  Session 事件，声明在 `@deepseek-ai/dsh-user-approval/lib/types/types.d.ts:37-51`，
  也在宿主已知事件表 `@deepseek-ai/dsh-session/lib/types/known-event-types.js:24-25`。
  Session 每次 append 都会向 `session/event` 观察者派发
  （`@deepseek-ai/dsh-session/lib/index.js:1585-1592`）。
- 因此插件不需要额外的宿主事件桥：`lib/index.js` 的 profile 级
  `session/event` 监听（`lib/index.js:1086`）本来就把所有 Session 事件转给
  runtime；`observeSessionEvent` 现在识别 `tool/call`、`approval/asked`、
  `approval/decided`。
- `user-questions/request` **不在** `session/event` 里；它是独立的 waterfall。
  宿主另有 `userQuestions` projection 表示“还可回答的定时问句”，但审批没有对应
  projection；审批等待只体现为日志里有一对 `asked`/`decided` 包在打开的 turn 内。
- Worker 等审批时的状态：turn 仍开着，工具调用在 await，Agent 状态是
  **`running`**。既不是 `idle`，也没有 `awaiting-approval`/`streaming` 这种宿主
  状态。审批未决时唯一的可靠信号就是 `approval/asked`（session 日志）与
  `approval/request`（waterfall 尚未完成）。

## 3. 旧 watchdog 为什么看不到

`lib/runtime.js` 的 `#checkWatchdog()` 原先只有：

- `starting` 超过 `startTimeoutMs`；
- 有 `workerSessionId` 但拿不到 live Agent；
- `working` 且 child 已 `idle` 超过 `idleStaleMs`；
- pending trigger 积压。

审批等待时任务仍是 `working`、child 仍是 `running`、turn 没有 `turn/end`，所以
四条都不命中。`superagent_status` 也只显示 `working`，Router 收不到任何 trigger，
看起来就是“卡死”。这是本问题的根因，不是通知渠道丢了。

## 4. 三层设计

### A. 检测与可见性（本版本已实现）

1. `approval/asked` 一到，runtime 立刻把任务置为 **`blocked-approval`**，并在
   journal 追加 `approval.asked`（含 `id`、`toolName`、`callId`、`summary`、
   `argumentsPreview`、`policy`、可选 `suggestion`、`askedAt`）。
2. 同一时刻 ingest 一条内部 trigger（`kind: approval-request`，`direct: true`，
   `internal: true`，所以不会被 `sources.worker` 的过滤挡掉），正文含任务 id、
   工具、请求摘要（命令/路径）、原因、策略与“请用户 allow/deny”的明确指引，并
   在 `meta` 里带 `taskId` / `approvalId` / `toolName` / `callId` / `summary` /
   `suggestion`。
3. `approval/decided` 一到，追加 `approval.resolved`（outcome、decidedBy=host），
   清掉等待标记并把任务恢复为 `working`。如果原 trigger 还在 pending，补一条
   `approval-resolved` trigger 与它合批，避免 Router 醒来后再问一次。
4. **面板**：新增 `blocked-approval` 状态与“等待审批”标签；活动详情展示工具、
   请求摘要、策略、原因与提示。状态接口/活动列表/完整任务详情都带
   `approvalMode` 与 `pendingApproval`。
5. **watchdog 兜底**：默认 `watchdog.approvalTimeoutMs = 60_000`；任务在
   `blocked-approval` 超过该时长且 `pendingApproval.escalatedAt` 为空时，合成
   `approval.escalated` 事件并升级给 Router（只升级一次；决定后不再重复）。
6. 恢复矩阵：重启时 `blocked-approval` 按“本该在跑”处理，会话救回来则转
   `resumable`，没救回来转 `interrupted`；旧的 `pendingApproval` 不复活。
7. `#routeToWorkers` 在 `blocked-approval` 时不再向 Worker 投递新事件（否则会把
   状态覆盖成 `working`）；`#liveWorkerCount` 仍把它算作占用槽位。

### B. 策略化自动回答（接口已预留，未启用）

`superagent_dispatch` 新增 `approval`：

| 值 | 本版本行为 | 将来行为 |
| --- | --- | --- |
| `ask`（默认） | 全部转人工 | 全部转人工 |
| `auto-workspace` | 记录到 task/journal，仍转人工 | 白名单命中自动 allow，其余 `next()` 转人工 |
| `deny-all` | 记录到 task/journal，仍转人工 | 自动 rejected（测试用） |

已预留的代码：

- `lib/approval.js`：`APPROVAL_MODES`、`normalizeApprovalMode` /
  `approvalModeFor`（策略解析）；`describeApprovalRequest`（命令/路径摘要，含
  脱敏）；`suggestApproval`（只在证据足够时给 allow/deny 建议，给 trigger 展示
  用，不是自动决定）；`createApprovalAnswerer`（B 阶段的 answerer 工厂，返回
  `undefined` 表示不注册，未命中白名单调用 `next()`）。
- `lib/runtime.js`：`dispatch()` 解析并写入 `task.approvalMode`，
  journal `task.created` 因此带上该字段；`approval.asked` 写 `policy` 与可选
  `suggestion`；`approval.resolved` 预留 `decidedBy` / `rule` 审计字段（本版本
  `decidedBy` 固定为 `host`）。
- 将来接线只需在 Worker 的 `agent.ctx` 上注册：
  ```js
  child.ctx.on('approval/request', createApprovalAnswerer({
    mode: task.approvalMode,
    // B 阶段：把 { mode, outcome, rule, descriptor } 写成 approval.resolved，
    // decidedBy 用 `policy:<mode>`，不要静默回答。
    onDecision: (record) => { /* journal 审计 */ },
  }))
  ```
  每个自动决定必须带 `mode`、命中的规则与理由写入 `approval.resolved`，
  被拒绝的动作由宿主把 outcome 回给 Worker 作为明确失败理由。

刻意不做：没有“全部自动放行”开关；没有跨会话的全局 answerer；没有把
`auto-workspace` 当作已经生效的承诺。

### C. 人工通道

本版本审批回答仍由宿主自带的 approval UI（`dsh-client-ui-approval`）完成；本插件
面板负责**显示**“等待审批”并提供任务详情。后续可在面板顶部/IM 用现有
`superagent_tell` + outbox 做提醒，点击后通过客户端 `ctx.remote.$on('approval/request')`
或宿主 approval UI 的同一 decision 通道回答，按 approval id 去重。

## 5. 代码位置

| 文件 | 作用 |
| --- | --- |
| `lib/approval.js` | 策略解析、请求摘要/脱敏、建议、B 阶段 answerer 工厂 |
| `lib/runtime.js:1434-1620` | `session/event` 识别、tool/call 缓存、`approval.asked` / `approval.decided` 处理 |
| `lib/runtime.js:2883-2945` | watchdog 审批超时升级 |
| `lib/store.js:196-204, 488-528` | `approval.asked` / `approval.resolved` / `approval.escalated` 折叠 |
| `lib/config.js` | `approval.mode`、`watchdog.approvalTimeoutMs` 默认值与校验 |
| `lib/tools.js` | `superagent_dispatch` 的 `approval` 参数 |
| `lib/protocol.js` | `blocked-approval` 状态常量 |
| `lib/recovery.js` | 重启时把 `blocked-approval` 纳入 running/restorable |
| `lib/client.js` | 状态标签、活动详情审批块 |
| `test/approval.test.mjs` | 9 个用例：检测、trigger、幂等、解决、超时升级、策略解析、B 接口、journal 回放 |

## 6. 验证与重启

- `npm test`：326 个用例全部通过（新增 9 个）。
- 本次改了宿主半部（`lib/index.js`/`lib/runtime.js`/`lib/store.js` 等）与客户端
  bundle（`lib/client.js`）：必须**重启 `dsh web`**，再硬刷新页面；只刷新页面
  不会加载新的宿主逻辑。
- 端到端手动验证建议：派一个需要写沙箱外路径/执行非白名单命令的 Worker，确认
  面板活动行在几秒内显示“等待审批”，Router 收到 `approval-request` trigger；
  60 秒不决定后收到 watchdog 升级；在宿主 approval UI 选择 allow/deny 后任务回到
  `working`，`superagent_status` 的 `pendingApproval` 消失。

## 7. 剩余风险

- `tool/call` 缓存依赖 `session/event` 的到达顺序；极端情况下审批事件先于
  tool/call 被观察，摘要会退化为 reason/tool 名，但仍会阻塞并通知。
- 本版本不自动回答，`auto-workspace` / `deny-all` 只是记录；不要向用户宣称已
  自动放行。
- 面板一键 allow/deny 尚未接线；宿主自带 approval UI 已可用。
- 宿主未来若把 `approval/asked` 改成 surface event 或重命名 outcome，需要跟着
  升级；当前依赖的 manifest 在 §1 已列明。
