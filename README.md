# dsh-super-agent

一个基于 DeepSeek Harness 的 **Super-agent 控制面插件**。它把文章
《[Super-agent 设计探索](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)》
里的几个架构选择落成可运行的 DSH 插件：

- **自然语言统一入口**：左栏 Super-agent 面板没有工作区选择器；用户直接说目标，
  Router 从宿主项目清单自主选择项目并在其中发起 Worker。
- **双层 Router/Worker**：宿主里的根会话是 Router；具体任务交给上下文隔离的
  Worker 执行。同项目任务使用 DSH subagent；跨项目任务在目标项目里创建普通
  Session（沙箱的 workspace-write 根必须跟着目标项目走）。Router 不被长任务
  阻塞，Worker 不直接对人说话。
- **事件驱动**：群聊、Issue/PR、CI、邮件等事件先进入可持久化的 Trigger 队列，
  由程序层快路径过滤，再合批交给 Router 做语义判断。
- **订阅直通**：已归属某个 Worker 的 Thread，后续事件由程序直接投递给它，
  不再经过 Router。
- **Inline & Spill + 链式召回**：批次只内联 id、actor 和一行摘要；全文留在
  journal，`superagent_recall` 沿引用图逐跳展开。
- **异步 ReAct**：`dispatch` / `steer` / `close` 立即返回；Worker 的结果以后续
  Trigger 的形式回来。
- **Watchdog**：外部定时控制回路，检查丢失/卡住的 Worker、积压的 Trigger，
  能确定性修复的先修，修不了的才升级给 Router。
- **多信道输出**：面向人的消息走 outbox，按信道限制字数（IM 默认 100 词）。

本仓库是一个**独立实现**，不是 DeepSeek 官方的
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)。
官方原型覆盖 GitHub/Feishu Source、授权策略、完整 Web 面板等部署；本插件刻意只做
**单机、可审计、可测试的控制面**，外加一个复用官方会话的薄 UI 入口；频道适配器
和云端存算分离留给部署侧。

---

## 1. 快速开始

```sh
cd /path/to/dsh-super-agent

# 1) 装进 web profile（会写入 profile 的 package.json 与 bundles）
dsh plugin --profile web add /abs/path/to/dsh-super-agent

# 2) 重启 dsh web（新插件包需要重新加载 profile）
# 3) 左侧栏点击 Super-agent，直接用自然语言说你要做什么。
#    不需要选工作区；项目由 Router 自动发现，首次使用会自动准备 Router。
```

### 统一入口：Super-agent 面板

左栏「Super-agent」和「插件」「Automation tasks」并列。打开后是一个真正的官方
会话面板，不是另一套聊天实现：

- 面板 retain 一条普通 DSH 根会话，本插件把 Router 提示词和七个工具装上去；
- 消息流、停止按钮、模型选择、审批、工具卡片全部复用官方 `conversation.content`；
- **没有「目标项目」选择器**。打开面板就直接说话；Router 通过
  `superagent_projects` 查看左侧栏已有项目，并从用户描述中自主选择目标，
  再用 `superagent_dispatch(project: "...")` 在目标项目里发起 Worker。用户不需要
  先选工作区，也不需要把项目路径贴进对话；
- 宿主自动恢复/选择 Router 的**运行目录**；这个目录只是 Router 会话的宿主，
  不是任务目标。一个 DSH 进程仍只有一条常驻 Router；
- 同项目用隔离 subagent，跨项目用目标项目的普通 Session，因此
  `workspace-write` 真正覆盖目标目录；
- 面板会显示 Router 状态、活跃 Worker/pending/task 数量；会话重启后通过
  `.dsh/super-agent/router.json` 指针恢复同一条 Router，而不是每次新建；
  UI 管理的指针带 `"ui": true`，因此 DSH 启动时自动打开的空白会话不会抢占
  Router，只有面板的 ensure 能恢复它；
- 若自动选中的运行项目没有配置，首次 ensure 会写最小
  `{"version":1,"enabled":true}`；已有配置不会被覆盖；显式 `enabled:false`
  会拒绝并显示原因。

也可以完全不用 UI，走下面的 CLI/HTTP 事件链路：

```sh
# 在目标项目里开启（UI 会自动做；这里给脚本化部署用）
node bin/super-agent.mjs init --project /path/to/project

# 发一条外部事件（模拟 IM 里有人点名）
node bin/super-agent.mjs emit \
  --project /path/to/project \
  --source im \
  --thread team:dev \
  --actor alice \
  --mention super-agent \
  --text "@super-agent 登录页在 Safari 上白屏，能复现并修一下吗？"

# 在 web 里新开一个会话。本项目第一个根会话会成为 Router，
# 下一轮它会收到 [super-agent] 批次，然后 dispatch 一个 Worker。
node bin/super-agent.mjs status --project /path/to/project
```

> **谁是 Router？** 一个项目只允许一个 Router：第一个开启插件、且不是 subagent
> 的根会话认领 `<项目>/.dsh/super-agent` 状态目录。后开的根会话不会重复装工具，
> 避免多个 Router 抢同一批 Trigger。关闭该会话（或换项目）后，下一个根会话接管。
> 也可以用 `router.sessionId` 固定某条会话。通过 UI 使用后，`router.json` 会带上
> `"ui": true`，重启时自动打开的空白会话不会接管，只有面板 ensure 恢复这条 Router。

没有 `.dsh/super-agent.json` 的项目完全惰性：不注册工具、不注入提示词、不读队列。
这和省 token 的考虑一致——普通会话不该背 Super-agent 的系统提示词。

### 用 HTTP 投递

宿主有 web 载体时，插件注册以下端点（都受 `/api` 的浏览器鉴权围栏保护）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/super-agent/ingest` | 投一条事件，body 同 `emit` 的 JSON |
| GET | `/api/super-agent/status` | 健康状态 + 紧凑快照 |
| GET | `/api/super-agent/outbox?channel=im&since=…` | 读待发送的人类消息 |
| GET | `/api/super-agent/ui/state` | 面板状态：活跃 Router、项目清单、任务计数 |
| POST | `/api/super-agent/ui/ensure` | 确保 Router 会话；body 可省略，或传 `{"cwd":"/abs/project"}` 显式指定运行目录 |
| POST | `/api/super-agent/ui/focus` | 兼容脚本：设置旧版 focus project；面板已不再调用 |

后三个端点是面板内部接口；脚本也可以用它做轻量自动化。`ensure` 不要求 cwd：
它会优先恢复带 UI 指针的 Router，否则从宿主项目清单里选一个运行目录；只有脚本
需要指定目录时才传 cwd。首次 ensure 可能创建一条普通 DSH Session（已在运行则
复用/恢复），并写最小项目配置。

```sh
curl -s http://127.0.0.1:3080/api/super-agent/ingest \
  -H 'content-type: application/json' \
  -d '{"id":"im-001","source":"im","threadKey":"team:dev","actor":"alice",
       "text":"@super-agent 登录页白屏","mentions":["super-agent"]}'
```

如果宿主不是 web profile，CLI 的 `emit` 仍然有效：它只追加
`<dataDir>/inbox.jsonl`，插件下一次轮询时消费。

---

## 2. 架构

```mermaid
flowchart LR
  subgraph Sources[外部环境]
    IM[IM / 群聊]
    GH[GitHub / CI]
    MAIL[邮件 / 文档]
    CLI[CLI / HTTP 桥]
  end

  subgraph Browser[浏览器]
    PANEL[Super-agent 面板\n官方会话 + 自然语言]
  end

  subgraph Host[DSH 宿主进程]
    UI[UI ensure / projects\n单 Router 指针]
    INBOX[(inbox.jsonl)]
    FILTER[程序层过滤\nFast Path]
    STORE[(journal.jsonl\nTrigger / Thread / Task)]
    ROUTER[Router Session\n唯一、常驻]
    BATCH[批处理\n空闲时合并]
    WORKER1[Worker Session A\n隔离上下文]
    WORKER2[Worker Session B\n隔离上下文]
    WD[Watchdog\n定时 Control Loop]
    OUTBOX[(outbox.jsonl)]
  end

  IM --> INBOX
  GH --> INBOX
  MAIL --> INBOX
  CLI --> INBOX
  INBOX --> FILTER
  FILTER -->|候选| STORE
  FILTER -->|过滤| STORE
  STORE --> BATCH
  BATCH -->|"[super-agent] 批次"| ROUTER
  PANEL -->|ensure| UI
  UI --> ROUTER
  ROUTER -->|projects + dispatch(project)| WORKER1
  ROUTER -->|dispatch| WORKER2
  WORKER1 -->|turn/end → worker-report Trigger| STORE
  WORKER2 -->|worker-report| STORE
  STORE -->|已订阅 Thread 直通| WORKER1
  STORE -->|已订阅 Thread 直通| WORKER2
  ROUTER -->|superagent_tell| OUTBOX
  WD -->|自愈 / 升级| STORE
```

### 数据流

1. **Ingest**：`emit` / HTTP / inbox 轮询把事件送进 runtime。
2. **去重**：`(source, externalId)` 相同的事件只落一次。
3. **程序层过滤**：来源策略（addressed / candidate / ignore）、actor 黑白名单、
   正则忽略、是否点名、是否自消息。被过滤的事件也记一条 journal，便于审计。
4. **Thread 归属**：`(source, threadKey)` 哈希成稳定 `thr_…`；事件落到 Thread。
5. **直通或排队**：
   - 该 Thread 已被某个 live Worker 订阅 → 直接 `followup` 给 Worker；
   - 否则进入 pending，等 Router 空闲时合批。
6. **Router 判断**：批次里只带 id、来源、actor、一行摘要、原文长度；需要细节时
   调 `superagent_recall`。
7. **Worker 执行**：`superagent_dispatch` 立即返回。同项目任务起隔离 subagent；
   跨项目任务起目标项目的普通 Session（`header.cwd` 指向目标，sandbox 才允许写）。
   Worker 的 `turn/end` 被转成 `worker-report` Trigger 回到 Router。
8. **面向人**：Router 用 `superagent_tell` 把消息写进 outbox；频道桥负责真正发送。

### 为什么 Router 不会被长任务阻塞

所有 Worker 操作都是异步的：

- `superagent_dispatch` 只做「建任务 + 订阅 Thread + 起会话」，Worker 启动、执行、
  失败都在后台；
- Worker 结束时，runtime 把最后一条 assistant 文本截断后作为新 Trigger 注入；
- Router 忙时，新 Trigger 继续积压；Router 回到 `idle` 时，积压的 Trigger 合成
  一条消息再次注入（文章 §2.1 的 batching）。

因此 Router 的一轮可以只做几个轻量决定，不必等待 shell、测试或长推理。

---

## 3. 与文章的概念映射

| 文章 | 本插件 |
| --- | --- |
| §2 双层架构 | 根会话 = Router；同项目用 `ctx.subagents` 隔离会话，跨项目用目标目录的普通 Session = Worker；Router 工具与 Worker 工具集分离 |
| §2 统一入口 | 左栏 Super-agent 面板 + `/ui/ensure`；一条常驻 Router，项目由 Router 自主选择 |
| §2.1 Router 批处理 | `runtime.scheduleFlush` + `agent/status=idle` 时合并 pending Trigger；单批有数量/字符上限 |
| §3.1 Fast/Slow Path | `lib/filter.js` 程序层过滤；Router 提示词 + 批次做语义层判断 |
| §3.2 订阅与直通 | `task.subscribed` 关系；已订阅 Thread 的事件直接 `followup` 给 Worker，多对多 |
| §3.3 Inline & Spill | 批次内联 `id / source / actor / 摘要 / 原长`；全文留 journal，`superagent_recall` 展开 |
| §3.3 链式召回 | Trigger → Thread → Task → Report → Thread 的 `links`，每跳都有 id |
| §3.4 投机执行 | `dispatch({speculative:true})`：Worker 在后台准备，Router 决定是否交付或丢弃；提示词禁止不可逆外部动作 |
| §4.1 异步 ReAct | dispatch/steer/close 立即返回；结果以后续 Trigger 回来 |
| §4.2 多信道 | `channels` 字数上限 + `superagent_tell` + outbox；IM 默认 100 词 |
| §5 存算/环境分离 | journal 独立于 Session；任务记录 cwd；跨项目 Worker 用目标项目 Session；Worker 会话丢失后状态仍在，可恢复/重派 |
| §6 Watchdog | 定时检查 + 确定性修复 + 去重升级；无问题时完全安静 |

---

## 4. 领域对象

| 对象 | id | 说明 |
| --- | --- | --- |
| Trigger | `trg_…` | 一条不可变环境事件；带来源、actor、Thread、去重键、过滤结果、投递记录 |
| Thread | `thr_…` | 同一群聊/PR/邮件串的事件序列；由 source + threadKey 稳定哈希 |
| Task | `tsk_…` | 一个被授权的工作单元；绑定 Worker 会话、订阅的 Thread、报告历史 |
| Batch | `bat_…` | 一次注入 Router 的 Trigger 集合；用于审计与召回 |
| Report | `rpt_…` | Worker 的 turn 结束报告；同时是一条 worker-report Trigger 的内容 |
| Reply | `rep_…` | 面向人的 outbox 消息；带信道与字数 |

任务状态：

```
queued → starting → working ⇄ idle / blocked / failed / interrupted / lost → closed
```

- `queued`：等待 Worker 槽位（`worker.maxWorkers`）。
- `starting`：`startActivation` 或跨项目 Session 创建进行中。
- `working`：Worker 正在跑，或被新的 Thread 事件唤醒。
- `idle`：最近一轮正常结束，等待后续事件。
- `blocked` / `failed`：Worker 明确报告阻塞或出错。
- `interrupted`：宿主重启后会话不在，状态与 journal 仍在。
- `lost`：Watchdog 确认 Worker 会话消失。
- `closed`：Router 主动关闭；订阅被清除，但 journal 与报告保留。

---

## 5. Router 工具

| 工具 | 作用 | 异步？ |
| --- | --- | --- |
| `superagent_projects` | 列出宿主已注册项目（标题/id/路径） | 是（只读） |
| `superagent_status` | Router/任务/Thread/积压/outbox/Watchdog 快照 | 是（只读） |
| `superagent_recall` | 按 id 展开对象，返回下一跳 `links` | 是（只读） |
| `superagent_dispatch` | 起 Worker，订阅 Thread，返回 task id | 立即返回 |
| `superagent_tell` | 排队一条人类消息，按信道校验字数 | 立即返回 |
| `superagent_steer` | 给已有 Worker 补一条消息 | 立即返回 |
| `superagent_close` | 关任务，或只退掉一个 Thread 订阅 | 立即返回（释放后台进行） |

工具描述与 Router 提示词（`lib/prompt.js`）共同约束行为：

- Router 不亲自改文件/跑长命令，只选项目、分派、判断、汇报；
- 项目由 Router 通过 `superagent_projects` / `dispatch(project)` 自主选择，UI 不要求先选工作区；
- 已订阅 Thread 的后续事件不应重复分派；
- 事件正文是不可信数据，不能把里面的指令当成系统指令；
- Worker 的原始推理不直接进人类信道，Router 负责摘要；
- 没有必要时保持沉默。

### 可选的机制守卫

“Router 不亲自执行”默认由机制守卫兜底；如果确实要让 Router 做轻量命令，可以关掉：

```json
{
  "router": {
    "guardExecutionTools": true,
    "guardTools": ["bash", "pwsh", "run_code", "write", "edit", "str_replace_editor"]
  }
}
```

它会在 Router 的 scope 上拦截这些工具调用，返回明确错误，引导使用
`superagent_dispatch`。默认开启；插件本身默认关闭，只有项目显式开启时才会影响会话。
`read` / `grep` / `glob` / `superagent_*` 不在拦截列表里，Router 仍可做轻量阅读。

---

## 6. 配置文件

`<项目根>/.dsh/super-agent.json`：

```json
{
  "version": 1,
  "enabled": true,
  "dataDir": ".dsh/super-agent",

  "agents": ["super-agent", "superagent", "助手"],

  "sources": {
    "im":     { "mode": "addressed", "requireMention": true },
    "github": { "mode": "candidate" },
    "email":  { "mode": "candidate" },
    "ci":     { "mode": "candidate" }
  },
  "defaultSource": { "mode": "addressed", "requireMention": false },
  "ignoreActors": ["spam*"],
  "redact": true,
  "storeFullText": true,

  "router": {
    "maxBatch": 24,
    "batchDebounceMs": 200,
    "maxBatchChars": 12000,
    "inlineChars": 280,
    "sessionId": "",
    "guardExecutionTools": true
  },

  "worker": {
    "spawnProvider": "spawn",
    "maxWorkers": 4,
    "maxReportChars": 4000,
    "defaultCwd": "",
    "initialContextChars": 12000,
    "routeTextChars": 8000
  },

  "watchdog": {
    "enabled": true,
    "intervalMs": 30000,
    "pendingStaleMs": 90000,
    "startTimeoutMs": 120000,
    "idleStaleMs": 300000,
    "repeatMs": 600000
  },

  "channels": {
    "im":     { "maxWords": 100, "guidance": "One decision or result." },
    "github": { "maxWords": 600, "guidance": "Context, change, verification." },
    "email":  { "maxWords": 500 }
  }
}
```

字段说明（只列容易误用的）：

- `sources.<name>.mode`
  - `addressed`：必须点名才进入 Router（默认 IM）；
  - `candidate`：全部作为候选进入 Router，由提示词判断（默认 GitHub/CI）；
  - `ignore`：程序层直接丢弃。
- `requireMention`：`addressed` 模式下是否要求 `@agent` / `mentions` / `direct`。
- `actorsDeny` + `ignoreActors`：支持末尾 `*` 通配。
- `ignorePatterns`：正文正则；坏正则会得到 warning，不会让插件失败。
- `dataDir`：相对项目根或绝对路径。拒绝盘符根、`~/.dsh`、系统目录。
- `router.sessionId`：固定 Router 会话；留空表示本项目第一个根会话。
- `worker.maxWorkers`：同时驻留的 Worker 上限；超出进入 `queued`。**idle 的 Worker
  仍占槽位**，Router 应及时 `close` 已完成任务。
- `worker.defaultCwd`：Router 自己也没选项目、dispatch 又不给 cwd 时的兜底。
  UI 没有目标项目选择器；正常路径是 Router 用 `project` 显式选目标。
- `channels.<name>.maxWords`：`superagent_tell` 的硬上限；`0` 表示不限。
- `redact`：入库前遮盖常见 key/token；不是安全边界，凭据仍不应进入事件。

> 配置坏了（JSON 语法、路径越界、字段类型）时插件**保持关闭**并记 warn；
> 不会让会话创建失败。

---

## 7. CLI

```sh
node bin/super-agent.mjs init [--project DIR] [--data-dir DIR]
node bin/super-agent.mjs enable|disable [--project DIR]
node bin/super-agent.mjs emit ...        # 追加 inbox.jsonl
node bin/super-agent.mjs status [--full] [--json]
node bin/super-agent.mjs recall <id> [--max-chars N] [--json]
node bin/super-agent.mjs outbox [--channel C] [--since …] [--json]
node bin/super-agent.mjs config
```

`emit` 示例：

```sh
node bin/super-agent.mjs emit \
  --source github --thread 'owner/repo#42' --actor reviewer \
  --kind review_comment --direct \
  --text '请把字体设置收进「更多外观设置」折叠区，不要单开分区。'
```

它会把事件追加到 `<dataDir>/inbox.jsonl`，打印生成的 `trg_…` 与 `thr_…`。
即使宿主没运行，事件也会排队；插件启动后从 `cursor.json` 继续消费。

---

## 8. 频道桥接

插件**不直接调用 IM/GitHub API**。这是有意的：

- 凭据、网络出口、重试策略属于部署；
- 让控制面保持可测试、无外部副作用；
- 文章 §8.4 提醒过凭据进入模型上下文的风险，插件只保存事件正文，不持有频道凭据。

频道桥只要读 outbox 并发送即可：

```sh
tail -F /path/to/project/.dsh/super-agent/outbox.jsonl
```

每行是一个 JSON 对象：

```json
{
  "id": "rep_ab12cd34ef",
  "channel": "im",
  "text": "已修复：Safari 登录页在 100% 缩放下不再白屏，已加回归测试。",
  "threadId": "thr_...",
  "taskId": "tsk_...",
  "words": 22,
  "createdAt": 1760000000000,
  "status": "queued"
}
```

桥接器可以按 `channel` 选择 API、写回执，或在发送成功后自行记一份已发送状态。
插件不会删除 outbox 行（R2：不写清理逻辑）。

---

## 9. 测试

```sh
npm test
```

覆盖 97 个用例：

- 程序层过滤的所有分支；
- 项目开关、配置合并、数据根安全边界；
- journal 追加、重放、坏行处理、任务状态折叠；
- Inline/Spill 批次预算、Worker 初始提示、字数、脱敏；
- 链式召回的 trigger/thread/task/batch/report/reply 引用图；
- 假宿主上的完整调度：去重、批处理、直通、多订阅者、报告、steer、close、
  容量队列、Watchdog、恢复、inbox 轮询、outbox；
- 插件接线：工具/提示词注册、单 Router、subagent 跳过、HTTP 端点、租约释放；
- UI 接线：`/ui/ensure` 通过通用 Session API 建 Router、无 cwd 时从宿主项目清单
  自动选运行目录、`/ui/focus` 兼容、复用；
- 项目解析：`superagent_projects` 清单、标题/id/path 唯一匹配、dispatch(project)；
- 跨项目调度：普通 Session Worker 的创建、prompt 延迟、报告、关闭取消；
- 浏览器 bundle 合约：单文件 loader、id、仅 require react、面板/侧栏/子槽注册；
- CLI：init/enable/emit/status/recall/outbox。

测试用假 Agent/假 subagents 替代模型调用，因此不需要网络与 token。

另外在**隔离的 DSH headless profile** 里用脚本化测试 LLM 跑过真实宿主链路
（不写用户 profile、不需要凭据），并在隔离的 **web profile** 里用 Playwright
跑了真实浏览器：

- 插件被 profile 加载，`agent/created` 后只注册到一个 Router；
- Router 系统提示词、动态状态段与七个工具出现在真实请求头里；
- `superagent_dispatch` 真的创建了 subagent Session，Worker 任务提示完整送达；
- Worker `turn/end` 被正确读取（包括 `{type, data}` 事件包），报告合成
  `worker-report` Trigger 并合批回到 Router；
- `superagent_tell` 真的写出 outbox 行；
- 默认机制守卫在 Router 调 `bash` 时返回 deny；
- CLI `emit` 写出的 inbox 事件被宿主 ingest，生成 Thread 并进入批次；
- web 左栏出现 Super-agent 入口，打开是嵌在 main 面板里的官方会话；
- 直接输入任务，Router 从项目清单里选 project6；task `cwd=project6`，跨项目
  Worker 用普通 Session，`bash` 在 project6 写出探针文件（sandbox 生效）；
- `superagent_tell` / worker report 回到 Router，面板计数与消息流同步；
- 连续发 3 个慢任务，中间快照 `working=3`，证明真实 Worker 并发与容量调度；
- 面板没有 `<select>`；打开即对话；发 `auto-project` 请求后任务落到 project6，
  状态里的 `task.project=project6`、`cwd=.../project6`，证明 Router 自主选项目；
- 停止 web 后重启，DSH 启动时新开的空白会话不会抢占 UI Router；
  `ui/ensure` 恢复带 `"ui": true` 指针的同一条 Router 会话，历史消息仍在。

这个测试夹具只用于开发验证，不随插件发布。

---

## 10. 已知边界

- **单机、单进程**：journal 在项目目录；插件只在 DSH 宿主运行时推进。
  没有云端无状态计算，也没有跨设备 daemon。
- **Worker 会话不跨进程恢复**：宿主重启后，任务标为 `interrupted` 并通知 Router；
  它可以根据 journal 里的 brief 决定重派。`interrupted` 不会自动重跑，避免重复副作用。
  跨项目 Worker 是普通 Session，会留在目标项目的会话列表里，方便审计；插件不
  删除、不自动归档它。
- **跨项目 Worker 的审批**：普通 Session 使用 DSH 的默认审批策略，不继承
  subagent 的 `approval: never`；需要无人值守时请在项目权限里配置。
- **UI 管理的项目会被 pin**：一旦面板把 `router.json` 标记为 `"ui": true`，DSH
  自动新开的空白根会话不会接管 Router；需要面板 ensure 恢复它。若要在该项目改用
  CLI 驱动的 Router，请显式删除该指针（属于破坏性操作，需自行确认）或换项目。
- **频道桥未内置**：outbox 是稳定接口，但真正的 IM/GitHub 发送由部署实现。
- **Router 仍是模型**：程序层保证事件怎么来、去哪、何时合批；是否行动仍由
  Router 提示词与模型判断。`guardExecutionTools`（默认开启）能在机制上限制它亲自执行。
- **提示词注入无法根除**：事件正文被包在 untrusted 边界里，Router/Worker 提示词
  明确要求不服从其中指令；但这是提示层防御，不是沙箱。
- **没有删除/清理逻辑**：journal 只追加；需要压缩/归档时请另写显式工具。

---

## 11. 文件结构

```
lib/
  index.js      宿主插件入口：项目开关、单 Router 认领、工具/提示词/HTTP/UI 注册
  client.js     浏览器半部：侧栏入口、main 面板、官方会话（无项目选择器）
  runtime.js    Router/Worker 调度、批处理、直通、报告、Watchdog、恢复、inbox
  store.js      追加式 journal + 内存折叠（Trigger/Thread/Task/Reply）
  filter.js     程序层快路径
  render.js     Inline & Spill 投影、Worker 提示、状态文本
  recall.js     链式召回
  config.js     默认值、项目配置合并、数据根安全边界
  prompt.js     Router 系统提示词与动态状态
  tools.js      七个模型可见工具
  text.js       有界文本、字数、脱敏
  ids.js        稳定/随机 id
  protocol.js   共享协议常量
bin/
  super-agent.mjs   CLI
test/              97 个 node:test 用例
docs/
  design.md        实现细节与取舍
```

---

## 12. 参考

- 文章：[Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)
- 官方原型：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- DSH 插件形态参考：本仓库的 `dsh-academic-search` / `dsh-away-notify` / `dsh-autoresearch`

License: MIT.
