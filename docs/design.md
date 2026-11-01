# 设计说明：dsh-super-agent

本文记录实现里的不变量、调度算法、失败路径和取舍。概念映射与使用方式见
[README](../README.md)。

## 1. 目标与非目标

### 目标

1. 在一个 DSH 宿主进程里提供可用的 **Router/Worker 双层** 调度。
2. 把「事件 → 过滤 → Thread 归属 → 合批 → 判断 → 执行 → 汇报」做成
   **可持久化、可审计、可测试** 的控制面。
3. Worker 不阻塞 Router；Router 不亲自执行长任务。
4. 所有注入模型的文本都有明确上限；全文可按 id 召回。
5. 宿主重启后，状态与任务意图仍在；能确定性修复的先修，不能的升级给人。
6. 默认关闭、按项目开启；配置坏掉不连坐会话创建。
7. 提供一个薄 Web 入口，让使用者不必知道 CLI/HTTP 就能开始与 Super-agent 对话；
   入口只做会话/焦点编排，不复制聊天协议。

### 非目标

- 不做 GitHub/Feishu/邮件 API 客户端；频道适配器在 outbox 之外。
- 不做云端无状态计算、多设备 daemon、分布式存储。
- 不复制一套聊天 UI；浏览器半部只注册入口和面板，消息流复用官方 Conversation。
- 不保证 exactly-once 外部副作用；只保证事件去重与至少一次投递。
- 不把提示词注入当成可完全防御的问题；安全边界在宿主与部署。

## 2. 组件与职责

| 组件 | 文件 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 插件入口 | `lib/index.js` | 项目开关、Router 认领、注册工具/提示词/HTTP/UI、租约、跨项目 Session Worker | 不做调度 |
| 浏览器半部 | `lib/client.js` | 左栏入口、main 面板、自动准备 Router、嵌入式官方会话、右侧活动栏、二次确认重置、Worker/旧 Router 展示层隐藏；无项目选择器 | 不定义消息协议，不选项目 |
| Runtime | `lib/runtime.js` | 批处理、直通、Worker 生命周期、报告、Watchdog、恢复、inbox | 不调模型 |
| Store | `lib/store.js` | journal 追加、重放、内存索引 | 不做策略 |
| Filter | `lib/filter.js` | 程序层快路径 | 不调模型 |
| Render | `lib/render.js` | 批次/Worker 提示/状态文本 | 不读外部状态 |
| Recall | `lib/recall.js` | 链式召回 | 不写状态 |
| Config | `lib/config.js` | 默认值、合并、路径边界 | 不读会话 |
| Prompt | `lib/prompt.js` | Router 提示词/动态上下文 | 不执行工具 |
| Tools | `lib/tools.js` | 七个模型工具 | 不直接改 journal |

依赖方向是单向的：`runtime → store / filter / render / recall / config`；
`index → runtime / tools / prompt / store`。`store`、`filter`、`render`、`recall`
不依赖 DSH 包，因此可以脱离宿主单测。

## 3. 不变量

1. **单写者**：一个 `journal.jsonl` 在一个宿主进程内只有一个 `Store` 实例写；
   跨进程由 `owner.json` 的 pid 租约阻止第二个写者。
2. **单 Router**：一个 `dataDir` 在进程内只允许一个 root agent 认领；后开的根会话
   不安装工具。
3. **Worker 不安装 Router 工具**：`header.origin === 'subagent'` 或
   `delegationDepth > 0` 直接跳过；UI/跨项目任务创建的普通 Session 由进程内
   `reservedWorkerSessions` 集合跳过（即使目标项目碰巧开着插件）。
4. **已关闭任务不复活**：所有异步回调（spawn 失败、activation 结束、turn/end）
   在写状态前重新读 store，`closed` 一律跳过。
5. **有界注入**：批次有 `maxBatch` / `maxBatchChars` / `inlineChars`；报告有
   `maxReportChars`；召回有 `maxChars`；Worker 初始上下文有 `initialContextChars`。
6. **只追加**：插件没有删除/清理/镜像逻辑。`owner.json`、`cursor.json` 与
   `router.json` 是单文件覆盖；其余全是 append。
7. **跨项目写入的沙箱正确性**：DSH subagent 的 `header.cwd` 固定为父会话，
   `request.cwd` 只改 working directory；因此跨项目 Worker 必须是目标项目的
   普通 Session，不能靠 subagent 的 cwd 参数硬闯 sandbox。
8. **单 Router 的 UI 一致性**：`/ui/ensure` 只复用/创建一条 Router；没有 cwd
   时固定使用独立的 Super-agent Workspace（默认平台应用数据目录），不借用用户
   项目。UI 创建的 Router 指针带 `ui: true`，`maybeInstall` 对「指针里是另一条
   UI Router」的普通新会话直接跳过，避免 DSH 启动时自动打开的空白会话在 ensure
   之前抢占 Router。
9. **独立 workspace 不进入项目清单**：独立 workspace 根有
   `.dsh-super-agent-workspace` 边界标记；`findProjectRoot` 把它当项目根，
   `superagent_projects` 排除它，用户不会把它当成可派工的项目。Router 在它里面
   运行，所有用户项目相对它都是“项目外”，任务使用目标项目的普通 Session。
10. **项目由 Router 选，不由 UI 选**：`superagent_projects` 暴露宿主 workspace 清单；
    `superagent_dispatch(project)` 做标题/id/路径的唯一解析。UI 没有项目选择器，
    也不把“目标项目”写进配置。
11. **事件正文默认脱敏**：`redact: true` 时，常见 key/token 在进入 journal 前被替换。
12. **失败不连坐**：配置错误、目录不可写、端口被占、服务缺失，都只让插件对
    本次会话保持关闭，不影响 `agent/created`。
13. **Worker 的通知抑制由创建方登记**：worker 是普通 Session，`dsh-away-notify`
    只能按标题前缀兜底识别，用户一改名就失效。因此创建 worker 时调
    `awayNotify.markInternal(sessionId, 'super-agent-worker')`（`lib/internal-sessions.js`），
    关闭/归档/agent 销毁时释放；`awayNotify` 缺席或没有该方法时**静默降级**，
    worker 创建/关闭完全不受影响，通知侧退回标题前缀。
14. **面板来源由面板插件显式登记**：`dsh-away-notify` 点通知时要判断「这条会话在哪个
    主区域面板里」，否则只能靠启发式——面板被选中后 15 秒内第一个新出现的 retain 来源。
    面板从没打开过、或同时有别的插件 retain 会话时，启发式会认错。因此浏览器半部在
    `apply` 时调 `awayNotifyPanels.register({ panelId: 'super-agent', sources: ['superAgentUi'] })`
    （`lib/client.js` 的 `registerAwayNotifyPanel`），注册句柄挂在 `scope.effect` 上，
    插件卸载/热重载时自动注销；`awayNotifyPanels` 缺席、没有 `register`、调用抛错一律
    **静默降级**，面板照常打开，最坏退回自动学习。`PANEL_ID` 与 `PANEL_SOURCE` 是
    「槽注册 / retain / 登记」三处共用的常量，改名只需改一处。

## 4. 事件 intake 算法

```
ingest(input):
  source  = input.source or "unknown"
  dedupeKey = source + "\0" + input.externalId     # externalId 可选
  if dedupeKey seen: return {duplicate, existing id}

  text = redact(input.text)                        # 可选
  text = clip(text, sourcePolicy.maxTextChars)
  summary = oneLine(text)[:180]
  decision = filterEvent({source, actor, text, mentions, direct}, config)

  trigger = {
    id, source, threadId=hash(source, threadKey or id),
    actor, kind, title, summary, text (空 when filtered),
    addressed, priority, state=pending|filtered
  }

  if !decision.pass:
    append(trigger.filtered, reason)
    return {filtered, reason}

  append(trigger.received)
  if any live task subscribes threadId:
      for each live task: followup(renderWorkerEvent(trigger))
      append(trigger.delivered, target=worker, taskId)
      return {delivered, deliveredTo}
  else:
      scheduleFlush()
      return {pending}
```

### 过滤顺序

1. `internal` 事件直接通过（worker report / watchdog）。
2. 空正文。
3. 全局 `ignoreActors`。
4. actor 等于 Agent 名（自消息）。
5. 来源 `mode === ignore`。
6. 来源 `actorsDeny`。
7. 来源 `ignorePatterns`（坏正则忽略）。
8. `mode === addressed` 且 `requireMention !== false` 且没有 `direct`/mention。

被过滤的事件仍写入 journal（正文置空），这样 `status` 能解释「为什么没进来」，
但不会把噪音正文留在状态里。

## 5. 批处理算法

```
scheduleFlush(delay):
  if router.status == running: return     # 等 agent/status=idle
  timer = setTimeout(flush, delay)         # 默认 200ms，自动 unref

flushNow():
  if router.status == running: return {deferred}
  pending = store.pendingTriggers(limit=1000)
  if empty: return
  {text, ids} = renderBatch(pending, maxBatch, maxBatchChars, inlineChars)
  append(batch.created, ids)
  append(trigger.delivered, target=router) for ids
  router.followup(userMessage(text))
```

关键点：

- **先标记后投递**，投递失败时逐条写 `trigger.failed` 回退为 pending。
- Router 忙时**不排 timer**；`agent/status = idle` 事件再排。这样一轮推理期间
  到达的事件会在下一轮合并，形成文章里的 batching。
- `renderBatch` 只把真正内联进文本的 id 标记为 delivered；因预算没进来的
  继续 pending，下一次 flush 再送。
- Router 暂停/忙不会丢失事件；Watchdog 的 `pendingStaleMs` 会兜底补 flush。

### 预算与局部性

- 每条 Trigger 默认内联 280 字符摘要，附原文长度与 `recall` 提示。
- 单批最多 24 条、12000 字符；超出留在下一批。
- 线程上下文只在 Worker 初始提示/直通消息里带最近 3–4 条摘要，不内联全文。
- 召回默认 6000 字符，调用方可以按需放大到 50000。

## 6. Worker 生命周期

```
dispatch:
  create task(status=queued)
  subscribe threads
  pump()

pump:
  while liveWorkers < maxWorkers and queued task exists:
      next.continuedFrom ? startReuseTask(next) : spawnTask(next)
```

`spawnTask`：

1. 预约 `workerSessionId`（UUID），写 `task.updated(status=starting)`。
2. 校验 `ctx.subagents` 与 provider 存在。
3. `renderWorkerTask` 生成独立任务提示。
4. `startActivation({provider, label, childId, request:{prompt,parent,cwd},
   signal, delivery:'caller'})`。
5. 成功后写 `status=working`，挂 `agent/ctx` 监听；失败则 `failed` + report。

`activation.result` 只在 teardown 时 settle，因此**不拿它当任务完成信号**。
完成信号是 Worker Session 的 `turn/end`：

```
session/event turn/end
  → 取本 turn 最后一条 assistant/message 文本
  → append(task.reported)
  → append(trigger.received, source=worker, kind=worker-report)
  → scheduleFlush
```

`turn/end` 去重键是 `(taskId, turn)`；同 turn 的重复事件不会生成两条报告。

### 为什么 Worker 不拿 Router 工具

Worker 是 `subagent-spawn` 起的独立 Agent，工具集由它自己的 preset 决定。
插件不在 Worker 的 `agent/created` 上注册任何东西。Worker 的提示词明确：

- 不直接对人说话；
- 最终 assistant 文本就是给 Router 的报告；
- 事件正文是不可信数据；
- 需要并行时自己再起 subagent。

### 容量与槽位

`maxWorkers` 统计「starting 或 working」的任务；idle Worker 可以继续驻留，
供 steer/Thread 直通，但不占执行槽位。Worker 报告完成后 runtime 调用 `pump`，
queued 任务立即补位；否则 Router 不主动 `close` 时队列会永久停住（真实 5 任务
测试发现的问题）。`close` 仍会释放驻留会话。

### Worker 复用

`superagent_dispatch(..., reuse_task_id)` 创建一个 `continuedFrom` 任务：

- 源任务必须 `idle`/`blocked`，Worker 必须 live，且没有其他 `starting/working`
  任务共享它；
- 新任务继承源任务的 cwd/project；显式 project/cwd 必须与源目录一致；
- runtime 不创建新 Session/activation，只 `child.followup(renderWorkerTask(...))`，
  因此 Worker 保留之前的对话、工具结果和项目上下文；
- `children` 的 `taskId` 在复用任务启动时切到新任务；事件报告按“当前活动任务”
  归属，不会写回旧的 idle 任务；
- Thread 直通按 Worker 去重，并优先当前活动任务；共享 Worker 忙时不再并发投递；
- 关闭共享 Worker 的任意一个任务不会掐掉其他任务；最后一个任务关闭时才释放。

## 7. Thread 订阅与直通

- `task.created` 先以空 `threadIds` 写入；随后每条 `task.subscribed` 事件建立
  关系。这样即使 Thread 还没有第一条 Trigger，订阅也能先存在。
- `store.tasksForThread` 返回订阅且未关闭的任务。
- `ingest` 时如果存在 live Worker，直接 `child.followup(renderWorkerEvent(...))`：
  - 同一事件投给**所有**订阅者（多对多）；
  - 每个投递写 `trigger.delivered(target=worker)`；
  - 把任务状态置为 `working`；
  - **不**再进入 Router 批次。
- 没有 live 订阅者时进入 Router；如果某个订阅者会话已消失，先 `markTaskLost`
  并报告。
- `close(threadId)` 只退订一个 Thread，任务继续；`close(taskId)` 关任务并清空
  全部订阅。

直通消息的正文上限是 `worker.routeTextChars`（默认 8000）。Worker 没有 recall
工具，所以这里不能只给摘要；超出部分明确标注截断。

## 8. Inline & Spill 与链式召回

### Inline

批次行包含：

```
- trg_x [im/message|addressed] thr_y "标题" alice: 280 字摘要… (1830 chars; recall trg_x) · 12s ago
```

只给模型做判断所需的最小集合。线程标题、actor、来源、优先级、年龄都在内。

### Spill

全文、完整报告、完整 Thread 历史都在 journal。`superagent_recall(id)` 返回：

- 当前对象的完整（有界）内容；
- `links`：下一跳对象的 `{id, kind, label}`。

引用图：

```
Trigger ──threadId──▶ Thread ──taskIds──▶ Task
   │                     ▲                 │
   └──delivery.batchId──▶ Batch             ├──threadIds──▶ Thread
                                             └──reports──▶ Report
```

召回不会递归展开，只展开一跳；模型需要更多就继续按 `links` 调。这避免一次
召回把整个图塞进窗口，也符合文章「按需展开」的意图。

## 9. Watchdog

它是宿主内的**确定性**控制回路，不是另一个 LLM Session：

```
每 intervalMs:
  for each open task:
    starting 超过 startTimeoutMs        → 标记 failed + report
    workerSessionId 无 live agent        → 标记 lost + report
    working 但 worker idle 超过 idleStaleMs → 合成 completed report
  pending 且 router idle 且最老超 pendingStaleMs → flushNow
  有 queued 任务且容量可用             → pump

  issues = 上述问题（去重键 + repeatMs 抑制）
  if fresh issues:
      append(watchdog.checked)
      ingest(internal watchdog trigger)   # Router 决定 retry/close/steer
```

- 没有问题时**不写 journal、不唤醒 Router**，保持安静。
- 同一问题在 `repeatMs` 内只升级一次；问题消失后清掉抑制键，允许再次升级。
- 能确定性修复的（lost/failed、flush、pump）先修；需要判断的才升级。
- Watchdog 的 Trigger 走 `internal: true`，绕过程序层过滤，避免被自己的策略挡掉。

## 10. 恢复矩阵

| 重启前任务状态 | 重启后发现 | 处理 |
| --- | --- | --- |
| `queued` | 无 worker | 保留 queued，`pump` 按容量重新启动 |
| `starting`/`working`/`idle`/`blocked`/`failed` | Worker Session live | 重新挂监听，继续 |
| 同上 | Worker 不 live | 标 `interrupted`，写一次 recovery report |
| `interrupted` 且已通知过 | 仍不 live | 不再重复报告 |
| `lost` | 仍不 live | 保持 lost，等 Router 决定 |
| `closed` | — | 跳过 |

恢复报告包含「brief 与 journal 仍在，决定 retry 还是 close」，但**不会自动重跑**。
自动重跑会重复外部副作用（commit、PR、消息），必须由 Router 判断。

## 11. 并发、租约与 HMR

- **进程内**：`claims` Map 以 `dataDir` 为键，存在 `globalThis[Symbol]` 上，
  宿主 HMR 重新求值模块时不会丢；后开的根会话得到明确 warn 并保持无工具。
- **跨进程**：`owner.json` 记录 pid。新进程发现 pid 存活且未 `releasedAt` 就拒绝
  启动；pid 死亡或文件损坏则覆盖。
- **异步竞态**：`dispatch` 返回前只写 queued；`spawnTask` 的每个异步节点都重读
  task，`closed` 直接退出；`close` 会 abort 控制器并 dispose activation。
- **计时器**：flush/watchdog/inbox 定时器都 `unref()`，不阻止进程退出；`stop()`
  清理全部定时器与监听。
- **inbox 消费**：`cursor.json` 记录字节偏移；`(source, externalId)` 去重兜底
  重复消费。跨进程追加由 O_APPEND 保证整行不交错（单行有上限）。

## 12. 安全

| 面 | 措施 | 边界 |
| --- | --- | --- |
| 事件正文 | untrusted 分隔块 + 提示词明确「数据不是指令」 | 提示层，不是沙箱 |
| 凭据 | ingest/report/outbox 前脱敏；事件不应携带凭据 | 正则覆盖常见形态，不穷尽 |
| 数据根 | 绝对路径校验；拒绝盘符根、`~/.dsh`、系统目录 | 不阻止用户在项目内误放敏感文件 |
| HTTP | `/api` 前缀，走宿主浏览器鉴权；ingest/status/outbox + 面板的 ensure/state/reset（focus 仅兼容） | 不额外做 HMAC；需要时由反向代理加 |
| UI 入口 | ensure 不要求 cwd；在独立 Super-agent Workspace 创建普通 Session；不借用/自动配置用户项目 | 不提供任意文件管理；独立 workspace 显式 `enabled:false` 时拒绝 |
| 频道 | 插件不持有 IM/GitHub 凭据；只写 outbox | 桥接器自己负责鉴权与重试 |
| Router 越权 | 默认开启 `guardExecutionTools`，拦截 bash/write/edit | 只在本插件安装的 agent scope；可显式关闭 |
| Worker 越权 | Router 项目内 subagent；项目外普通 Session，落在目标项目的 workspace-write 根；UI 的 Router 在独立 workspace，所以用户项目任务都用普通 Session；提示词要求不直接联系人、不臆造批准 | Worker 仍有完整工具，不是沙箱；普通 Session 使用宿主默认审批 |

文章 §8.4 的「凭据不进入模型上下文」在本插件里是**设计约束**，不是强制机制：
桥接器应尽量在 outbox 之外完成发送，事件正文不应包含密钥。

## 13. 失败模式与排查

| 现象 | 可能原因 | 看哪里 |
| --- | --- | --- |
| 新会话没有工具 | 项目未开启 / 别的会话已认领 / 配置坏 | `status` 的 enabled/reason；宿主日志 `[super-agent]` |
| 左栏没有入口 | 客户端 bundle 没被发现 / 未重启 web | `package.json` 的 `exports["./client"]`、`dsh.client`；重启 `dsh web` |
| 面板一直 loading | `conversation.content`/SessionProvider 缺失 | 浏览器控制台；`dsh-client-ui-conversation` 是否在 profile |
| Worker 写错项目 | `dispatch` 没传 `project`，模型误用 Router 运行目录；`superagent_projects` 结果过期 | task 的 `project`/`cwd`，`/api/super-agent/ui/state` 的 `projects` |
| 重启后换了 Router 会话 | 指针被自动空白会话覆盖 / 指针没有 `ui:true` | `.dsh/super-agent/router.json`；面板 ensure 会把当前 Router 标记为 ui |
| 跨项目 Worker 无写权限 | 误用了 subagent | task.workerSessionId 以 `session-` 开头表示普通 Session；journal 的 cwd |
| 事件一直 pending | Router 忙或宿主无 Router；flush 失败 | `status --full`、`journal` 的 `trigger.failed` |
| Worker 一直 starting | subagents 服务缺失 / provider 未注册 / 启动慢 | `status`、`journal`、`startTimeoutMs` 后的 watchdog |
| 收不到 worker 报告 | turn/end 未触发 / session 事件没到 | `children` 日志、`status` 的 lastReport、watchdog |
| outbox 有消息但没人收到 | 没部署频道桥 | `outbox` 文件 / HTTP `/outbox` |
| 两个进程抢状态 | owner pid 检查 | `owner.json`、宿主日志 |
| journal 有坏行 | 崩溃/手工编辑 | `status` 的 `journalBadLines` |

## 14. 扩展点

### 新增一个 Source

1. 在项目配置 `sources.<name>` 写 `mode`/`requireMention`/黑白名单。
2. 适配器把 payload 转成：
   ```json
   {"id":"...", "source":"...", "threadKey":"...", "actor":"...",
    "kind":"...", "text":"...", "mentions":["super-agent"], "direct":false}
   ```
3. 追加到 `<dataDir>/inbox.jsonl`，或 POST `/api/super-agent/ingest`。
4. 不需要改插件；Thread 归属与去重由 `(source, threadKey)`/`externalId` 完成。

### 新增一个 Channel

1. 配置 `channels.<name>` 的 `maxWords`/`guidance`。
2. 桥接器 tail `outbox.jsonl` 或轮询 `/api/super-agent/outbox`。
3. 发送成功后自行记录回执；插件不删除 outbox 行。
4. 若需要结构化卡片，可在 bridge 侧按 `taskId`/`threadId` 关联 journal。

### 替换持久化

`Store` 的接口很小：`append`、`apply`、若干查询。可以把 journal 换成 SQLite，
但要保留：
- 单写者；
- 事件重放得到同一内存状态；
- 任务/Trigger 的 id 稳定；
- 不删除历史。

### 扩展 Web 面板

面板已经存在：`lib/client.js` 注册 `sidebar.panellist` + `main`，并通过
`/api/super-agent/ui/*` 与宿主交互。新增只读可视化时：

- 优先读 `/api/super-agent/ui/state` 的紧凑快照；需要更多字段时扩展 `routerView`；
- 不要在浏览器里直接写 journal；所有写入走 runtime/ensure；
- 不要把 Router 会话换成自定义消息协议；继续用 `conversation.content`，否则会丢掉
  工具、审批、停止与模型选择。
- 面板的 retain 来源（`PANEL_SOURCE`）同时用于 `sessions.retain()` 和向 `dsh-away-notify`
  的 `awayNotifyPanels.register()` 登记；改来源名或面板 key 时改常量，别在别处写死名字
  （见不变量 14）。

## 15. 与官方原型的差异

| 方面 | 本插件 | 官方原型 |
| --- | --- | --- |
| 目标 | 单机控制面、可测试 | 完整部署（GitHub/Feishu、面板、授权） |
| Source | CLI/HTTP/inbox，适配器自理 | GitHub/Feishu 内置 |
| 执行 | Router 项目内 DSH subagent；项目外目标目录普通 Session；UI 的独立 Router 使所有用户项目走普通 Session | DSH Session + 独立工作目录 + 槽位 |
| 授权 | 程序层过滤 + Router 判断 | Policy/Mandate/Subscription 完整模型 |
| 状态 | JSONL journal | SQLite + migrations + versions |
| Watchdog | 确定性控制回路 + Router 升级 | 独立 Watchdog Session（文章描述） |
| 存算分离 | 本地 journal | 云端无状态 + 端侧 daemon（原型部分实现） |

这些差异是刻意的：在一个插件里复刻完整原型会变成另一个产品。本实现优先让
文章里最容易被忽略的**调度与上下文组织**部分可运行、可观察、可测试。

## 16. 测试矩阵

| 层 | 文件 | 关键断言 |
| --- | --- | --- |
| 过滤 | `test/filter.test.mjs` | mention/direct/candidate/ignore/self/pattern/internal |
| 配置 | `test/config.test.mjs` | 项目根、合并顺序、关闭、坏 JSON、数据根边界 |
| Store | `test/store.test.mjs` | 折叠、去重、订阅、报告、重放、坏行 |
| Render | `test/render.test.mjs` | 摘要、预算、Worker 提示、字数、脱敏 |
| Recall | `test/recall.test.mjs` | 一跳链接、截断、report/reply/batch |
| Runtime | `test/runtime.test.mjs` | 合批、直通、多订阅、报告、steer、close、槽位、idle 释放槽位、Worker 复用、watchdog、恢复、inbox、outbox、speculative、跨项目 Session Worker、project 解析 |
| 接线 | `test/plugin.test.mjs` | 工具/提示词、单 Router、subagent 跳过、HTTP、无 cwd ensure、项目清单、租约、重置 generation/Worker 归档 |
| 浏览器 | `test/client.test.mjs` | 单文件 loader、id、依赖边界、侧栏/面板/子槽注册、无项目选择器、活动栏/重置/Worker 隐藏契约 |
| CLI | `test/cli.test.mjs` | init/enable/emit/status/recall/outbox |

共 132 个用例，全部不需要模型调用。


## 17. 端到端验证记录

除了单元测试，本项目在一个**隔离的 DSH headless profile**（临时 `DSH_HOME`，
不触碰用户 profile）里用脚本化测试 LLM 跑过真实宿主：

1. 用 `dsh plugin --profile <temp> add /abs/path/dsh-super-agent` 安装，`--dump-config`
   确认 `super-agent` 行出现在 profile 合成结果里。
2. 在临时项目写 `.dsh/super-agent.json`，启动 `dsh --profile <temp> headless ...`。
   插件加载，`owner.json`/`journal.jsonl` 创建；Router 的系统提示词与七个工具
   出现在真实 `request/header` 中。
3. 测试 LLM 调用 `superagent_dispatch`，宿主创建独立 subagent Session；Worker
   任务提示完整出现在 `agent/inbox/spliced`，子会话有独立 system prompt 和工具集。
4. Worker `turn/end` 以 `{type, seq, time, data:{turn,reason}}` 形状到达；第一版
   实现按 `event.turn` 读取，导致报告被误判为 `error` 且重复两条。改为同时接受
   `event.data` 与顶层字段后，journal 只剩一条 `completed` 报告。
5. `superagent_tell` 写出 `outbox.jsonl`，CLI `outbox` 能读取。
6. 默认 `guardExecutionTools` 下，Router 的 `bash` 调用返回
   `super-agent router does not execute tasks directly`，证明 `tools/pre-execute`
   守卫在真实 agent scope 上生效。
7. CLI `emit` 写入的 IM 事件被宿主 ingest，生成 `thr_...`，批次进入 Router，
   再触发 `superagent_dispatch` 与 Worker 报告。

### Web UI 与跨项目验证

在隔离的 web profile（临时 `DSH_HOME`，脚本化 LLM）里用 Playwright：

1. 左栏出现「Super-agent」，点击后 main 面板嵌入官方 Conversation；输入框、
   模型选择、Workspace Write 与消息流都来自官方组件。
2. 页面打开时 `/ui/ensure` 不传 cwd，自动创建/恢复独立 Super-agent Workspace
   里的 Router；`owner.json` / `router.json` 写入。面板没有 `<select>`，不需要先
   选工作区，也不借用用户项目。
3. 全新 DSH home（无 Router 指针、一个 workspace）下打开空白 Router：面板固定
   active，官方 hero 不渲染，WorkspaceChip/工作区选择列表为 0，直接出现 composer。
4. 直接输入自然语言任务；Router 侧的项目工具可见宿主项目清单，fake LLM 用
   `superagent_dispatch(project: "project6")` 选中 project6，task.cwd=project6。
5. 跨项目 Worker 的 `workerSessionId` 以 `session-` 开头（普通 Session），
   `bash` 的 `pwd` 是 project6，`printf > .super-agent-probe.txt` 成功写进 project6；
   UI 的 Router 在独立 workspace，所以这次任务走普通 Session（不是 subagent）。
6. 连续发 3 个慢任务，中间快照 `working=3`，报告随后逐条回到 Router，验证真实
   Worker 并发与容量限制；右侧活动列表按更新时间显示任务状态。
7. 5 个慢任务时前 4 个 `working`、第 5 个 `queued`；第 4 个完成后第 5 个自动
   `working`，最终全部 `idle`，证明 idle 不占执行槽位。
8. `reuse-worker` 连续两阶段任务：两个 task 的 `workerSessionId` 相同，第二个带
   `continuedFrom`；两个都完成后活动栏按创建时间倒序同时显示 Completed。
9. Worker Session 行、旧 Router 行和 `[super-agent]` trigger 用户气泡在浏览器中
   不可见；Worker 结果只进入右侧活动列表和 Router 的最终回复。
10. 点击「重置」：二次确认，切换新 dataDir generation，新会话空白、活动列表清空；
    Worker 会话归档，面板不跳回工作区选择。
11. 关闭并重启 web，DSH 启动时自动打开的空白会话会被 `router.json` 的 `ui:true`
   挡住；`ui/ensure` 恢复同一条 Router，历史消息仍在。
12. 期间发现并修复：
   - `resolveAgent` 恢复会话时不一定重发 `agent/created`，改为恢复后显式
     `maybeInstall`；
   - 旧进程释放 Session writer 有窗口，恢复需要有限重试；
   - subagent 的 `header.cwd` 是父项目，跨项目写会被 sandbox 拒绝；因此引入
     普通 Session Worker，并把它们登记进 `reservedWorkerSessions`，防止目标项目
     的插件把它们误认成 Router；
   - 官方 conversation 的 hero（空白会话欢迎态）自带 WorkspaceChip，点开就是
     工作区选择列表；即使自定义面板没有 select，用户仍会看到“选工作区”。面板
     固定用 `phase: "active"`、`hero: false`，空白会话直接显示官方 composer，
     项目选择完全交给 Router；
   - 重启时 DSH 会先开一条空白根会话；若它抢在 ensure 前成为 Router，历史就会
     丢在旧会话里。UI 指针标记 `ui:true`，`maybeInstall` 跳过其他空白会话，只有
     ensure 能恢复/创建 UI Router；
   - 早期 UI 要求先选工作区，且把选择结果写进 focus；这会让用户误以为项目是
     面板的必填项。现在 ensure 初始化独立 Super-agent Workspace，项目清单只给 Router 的
     `superagent_projects` 工具使用，UI 不再出现“目标项目”。

这次验证还发现并修复了两个只有真宿主才暴露的问题：

- Session 事件是 `{type, data}` 包装，不是顶层字段；
- 子 Agent 的 `turn/end` 与父会话监听可能同时到达，必须用 `(taskId, turn)` 去重。

测试夹具（脚本化 LLM、临时 profile）只用于开发，不随包发布；插件本身仍不依赖
任何特定模型或凭据。
