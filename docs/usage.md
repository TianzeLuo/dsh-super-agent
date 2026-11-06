# 使用与配置

本文放安装、UI、Worker 复用、CLI、HTTP 和配置细节。架构见
[design.md](design.md)，入口和最短路径见 [README](../README.md)。

## 安装

```sh
dsh plugin --profile web add /abs/path/to/dsh-super-agent
```

安装后重启 `dsh web`，硬刷新浏览器，左栏点击 **Super-agent**。首次使用会自动
创建独立的 Super-agent Workspace，不需要先选工作区。

## UI

- 直接输入任务；Router 通过 `superagent_projects` 选择项目并派 Worker。
- 右侧「近期活动」按更新时间倒序展示进行中和已结束的任务；默认 6 条，点
  「显示更多」展开。每条显示状态、项目和时间。
- 点任务在右侧活动栏打开详情卡：状态、项目、模型/思考强度、Worker 是否在线、Brief、
  报告（倒序）、关联线程。卡片顶部 `‹` 返回列表，`✕` 关闭；详情占满右侧活动栏，
  不向对话区扩展，因此不会压到底部输入框。
- 任务有在线 Worker 时，详情卡提供「给 Worker 发指令」输入框，可直接纠正方向、
  补充约束；发送后 Worker 的报告仍以 trigger 回到 Router。底部固定「打开聊天」
  跳到完整 Worker 会话；关闭任务只释放 Agent、不归档会话，所以历史任务也能回看。
- 「在会话中打开」把当前 Router 作为普通 DSH 会话打开；如果宿主尚未注入
  `uiWorkspace`，面板会提示重试，而不是静默无反应。
- 顶部只保留一个「Worker 模型」按钮，打开统一面板：
  - 逐个勾选（点击模型名或复选框）允许 Router 使用的模型；
  - 每个模型可以限制 reasoning efforts，并指定默认模型/effort；
  - 「全部启用」是快捷方式，跟随宿主目录，不是唯一选项；保存写到项目配置。
- 面板、活动详情、模型/规则/定时抽屉全部使用 DSH 主题 token，跟随系统或宿主切换浅色/深色；
  下拉项也是自绘菜单，深色下不会出现白底的原生弹层。
- 「Rules」维护长期工作约定：全局或项目、追加或覆盖全局；可停用/编辑/删除。
- 「Schedules」创建和取消定时唤醒：一次、每日、每周、Cron 或绝对时间；可
  「立即执行」一次。上限由 `schedule.maxActive` 控制。
- 「Reset」二次确认后中止当前 Worker、取消当前 Router 的定时任务（reminder 绑定
  会话，旧会话隐藏后不应继续唤醒）、切换新的 dataDir generation、创建新 Router；
  旧 Worker 归档，旧 Router 会话保留但隐藏。长期约定文件不随 Reset 丢失。
- Worker Session 不出现在侧栏，`[super-agent]` 内部 trigger 不出现在聊天流。
- 点通知（`dsh-away-notify`）会回到产生它的**实例 + 会话**：选中面板 → 切实例 →
  adopt 那条会话，面板顶部给一条可撤销提示。已经在那个实例/面板上也照样定位。
  **自动跟随默认关**（`localStorage['dsh.super-agent.navFollow']`，写 `on` 打开）：
  通知只提示不自动跳转，点提示条里的「定位」再跳；顶部「跟随：关/开」是同一个开关。
  这样 Alt-Tab 切回来不会被跳到旧通知的会话。
- 打开面板后如果被自动切走（宿主注册表抖动、`openSession` 回退、会话归档都会自动关
  面板），守卫会拦下没有用户手势的切换并恢复面板；用户自己的点击/快捷键照常生效。
  排障看 `__SA_NAV_LOG__` 的 `nav.close` / `nav.restored`（带调用栈）；
  `localStorage['dsh.super-agent.navGuard'] = 'off'` 可关掉守卫。
- 文件预览是面板右侧的一列（560px，最宽 640px）：对话区跟着变窄，Esc 或右上角 ✕ 关闭。
  正文用宿主官方 `CodeBlock` / `MarkdownText`，`.tex`/Markdown 的代码围栏也能正常渲染。
- 排障：地址栏加 `?navdebug=1`（默认关闭），每条日志带 `source`（`layout.panelInfo` /
  `layout.selectPanel` / `away-notify.showSession` / `super-agent.*`）。之后每次 `activePanelId` 变化、实例/会话
  切换都连调用栈打到 console（`[super-agent][nav]`），并累积在
  `window.__SA_NAV_LOG__`（最多 500 条）——复现一次「被切走」就能看到调用点。

默认 workspace：

| 平台 | 路径 |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/dsh-super-agent/workspace` |
| macOS | `~/Library/Application Support/dsh-super-agent/workspace` |
| Windows | `%LOCALAPPDATA%\dsh-super-agent\workspace` |

可用 `DSH_SUPER_AGENT_HOME` 或 profile 配置 `superAgentHome` 覆盖。

## Worker 模型与思考强度

`models.allowed` 是 Router 唯一可选的 Worker 模型集合；为空时跟随宿主目录。
默认就是“宿主目录全部模型”（当前这台机器是 11 个：Qoder、DeepSeek、DeepSeek Account、
commandcode）。每条可以写：

```json
{
  "models": {
    "allowed": [
      {
        "id": "flash",
        "label": "DeepSeek-Flash",
        "provider": "dsh-provider-qoder",
        "model": "dfmodel",
        "efforts": ["low", "high", "max"],
        "defaultEffort": "high",
        "note": "日常默认，快"
      }
    ],
    "default": "flash",
    "defaultEffort": "high"
  }
}
```

- `id` 是 Router/面板看到的短 id，缺省为 `provider/model`；
- `efforts` 缺省表示该模型目录里的全部 effort 都允许；空数组表示不限制；
- `defaultEffort` 缺省用目录默认；显式指定但不在允许列表会被拒绝；
- 目录暂时不可用时，显式 allowlist 仍保留，标成 `available: false`，真正调用由
  宿主报错；
- Router 可以在 `superagent_dispatch` 里传 `model` / `reasoning_effort`；
  `superagent_models` 返回当前可选模型和 efforts。

只想暴露一个渠道的几个模型、又不想抄 model id 时，用可选的来源过滤：

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

`onlyNames` 同时匹配 model id 和显示名，顺序即默认模型优先级；`allowed` 非空
时以显式 allowlist 为准。过滤后的目录也会限制面板，不会在 UI 里冒出其它渠道；
此时面板会显示“当前只显示 N 个 / DSH 共 M 个”，并给出一键
「使用 DSH 全部模型」（清空 `allowed`、`onlyProvider`、`onlyNames`，默认模型保持不变）。

## 长期工作约定

约定保存在 `<项目根>/.dsh/super-agent.agreements.json`，不放在 generation 的
dataDir 里，所以 Reset 不会丢。条目：

```json
{
  "id": "agr_...",
  "title": "先给结论",
  "text": "回复先给结果，再给必要解释；不要贴 Worker 原文。",
  "project": "",
  "projectTitle": "",
  "mode": "append",
  "enabled": true
}
```

- `project: ""` 是全局；绝对项目路径是项目级；
- `append` 追加到全局规则；`replace` 在该项目里覆盖全局规则（其它项目规则保留）；
- Router 和每个 Worker 的提示词都会注入启用中的约定；
- 用户说「以后都这样」时，Router 用 `superagent_agreement` 保存；面板也可以维护；
- 文件损坏时降级为 warning，不影响 Router 启动。

## 定时任务

使用宿主 `@deepseek-ai/dsh-schedule`（`ctx.schedule`），不是插件自己的计时器。
到点后宿主向 Router 投递一条 reminder，Router 被唤醒并自行判断是否派活。支持：

- `after_seconds`：N 秒后一次；
- `at`：绝对时间（RFC3339）；
- `daily` / `weekly` / `cron`：需要 IANA 时区；
- `every_seconds`：固定间隔（≥60 秒）。

每条必须有 `title`（≤120）和 `prompt`；插件会加
`[super-agent scheduled task]` 框，避免模型把唤醒当成用户即时消息。默认最多
`schedule.maxActive` 条活跃任务。面板可立即执行一次，不影响下一次时间。

## 目标（objective）

长期目标用 `superagent_goal`，不要用宿主的 `create_goal`。差别是**是否自动续轮**：
宿主 goal 由 `dsh-goal-round-driver` 在每轮结束时再唤醒一次，Router 会空转；原生
objective 是**被动**的，只有三种推进来源：

1. **到点检查**：目标的 `cadence` 建一条宿主 schedule，到点唤醒一次，Router 显式
   `check`；
2. **Worker 报告**：`superagent_dispatch` 带 `objective_id`，该任务的报告自动记一条
   `source: "report"` 的检查；
3. **用户指令**：用户说「继续/汇报/改目标」时由 Router 显式 `check`/`update`。

创建或更新目标**不会**唤醒 Router，也不会排 0 延迟调度。没有 `cadence` 就是
`manual`，完全靠报告和用户指令推进。

```json
{
  "action": "create",
  "objective": "把 dsh-chatgpt-ui 的 M2 交付完",
  "milestones": ["接入流式消息", "补齐错误态", "通过 Playwright 回归"],
  "every_seconds": 3600
}
```

- `action`：`create` / `list` / `check` / `update` / `close` / `import`。
- `check` 可带 `note`、`complete_milestones`（`ms_N` 或原文）、`source`
  （`user` 默认 / `schedule` / `report`）。
- `update` 可改文本、里程碑（`milestones` 整体替换，`add_milestones` 追加）、
  `status`（`active`/`paused`）和节奏；改节奏会先取消旧 schedule。
- `close` 关闭目标并取消它的检查调度；之后不会再被唤醒。
- `import` 把当前会话里已有的宿主 goal 迁移成 manual 节奏的目标（宿主 goal 保持
  暂停，并被 disarm，不再续轮）。Router 启动时也会自动做一次同样的迁移（幂等：
  同一个 hostGoalId 只迁一次，已完成的 goal 不迁），所以之前 paused 的
  dsh-chatgpt-ui 交付目标会被自动接管，不需要额外操作。

节奏选择器和 `superagent_schedule` 一样：`every_seconds`（≥60）、`at`、`daily`、
`weekly`、`cron`。`daily`/`weekly`/`cron` 的墙钟计算交给宿主，目标只保存它返回的
下一次时间。

**关于宿主 goal**：Router 会话里 `create_goal` / `update_goal` 被摘除并拒绝执行，
已有的 armed goal 会被 `disarm`，`get_goal` 仍可读。普通会话不受影响。

## Worker 复用

Worker 默认隔离；同一项目里的连续工作可以复用已有上下文。Router 在
`superagent_dispatch` 里传入一个已完成/等待中任务的 id：

```json
{
  "title": "继续修登录测试",
  "brief": "基于上一轮的失败日志继续，不要重复已完成的部分。",
  "project": "project6",
  "reuse_task_id": "tsk_..."
}
```

- 新任务复用同一个 Worker Session，保留之前的对话、工具状态和项目 cwd；
- 只有源任务处于 `idle` / `blocked` / `resumable`、且 Worker 没有其他
  `starting`/`working` 任务时才允许；
- 新任务必须使用同一 cwd/project；
- 需要独立并行或跨项目时不要复用，直接创建新 Worker；
- 旧任务保持为独立活动记录；关闭其中一个不会掐掉仍被其他任务共享的 Worker。

### 重启之后

`dsh web` 重启后 Worker 会话从内存里消失，任务注册表（journal）还在。启动时插件
会对每条非 closed 任务尝试 `sessionController.resolveAgent()` 把会话装回内存：

| 结果 | 状态 | 怎么继续 |
| --- | --- | --- |
| 会话装回来了 | `resumable` | `reuse_task_id` 续同一会话（上下文完整，被打断那一轮不重放） |
| 会话装不回来 | `interrupted` | `reuse_task_id` 用原 brief 起新 Worker（继承项目/模型/目标/线程，记 `resumedFrom`），或 close |

`interrupted` 取代了重启路径上的 `lost`；`lost` 只留给「跑着的时候 Worker 会话被
宿主回收」。`superagent_status detail=full` 里能看到这两种状态和每条任务的 brief。

Worker 的最终 assistant 消息仍是报告，以 trigger 回到 Router。

## CLI

```sh
node bin/super-agent.mjs init [--project DIR] [--data-dir DIR]
node bin/super-agent.mjs enable|disable [--project DIR]
node bin/super-agent.mjs emit ...
node bin/super-agent.mjs status [--full] [--json]
node bin/super-agent.mjs recall <id> [--max-chars N] [--json]
node bin/super-agent.mjs outbox [--channel C] [--since …] [--json]
node bin/super-agent.mjs config
```

`emit` 会追加 `<dataDir>/inbox.jsonl`，宿主下次轮询消费；不需要宿主正在运行。

## HTTP

所有端点走 DSH 的 `/api` 鉴权栏：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/super-agent/ingest` | 投一条事件，body 同 `emit` 的 JSON |
| GET | `/api/super-agent/status` | 健康状态 + 紧凑快照 |
| GET | `/api/super-agent/outbox?channel=im&since=…` | 读待发送的人类消息 |
| GET | `/api/super-agent/ui/state` | 面板状态、项目、任务、workspace sessions |
| POST | `/api/super-agent/ui/ensure` | 确保 Router；body 可省略，或传 `{"cwd":"/abs/project"}` |
| POST | `/api/super-agent/ui/focus` | 兼容旧脚本的 focus 设置 |
| POST | `/api/super-agent/ui/reset` | 中止并归档 Worker、取消定时任务、切换 generation、创建新 Router |
| GET | `/api/super-agent/ui/activity?limit=N` | 近期活动（含已结束），`limit` 最大 50 |
| GET | `/api/super-agent/ui/task?task_id=…` | 单个任务详情：Brief、报告、线程、Worker 是否在线 |
| POST | `/api/super-agent/ui/task/steer` | 给在线 Worker 发一条指令，body `{task_id,text}` |
| GET/POST | `/api/super-agent/ui/models` | 读/写 Worker 模型 allowlist 和默认选择 |
| GET/POST | `/api/super-agent/ui/agreements` | 读/写长期工作约定 |
| GET/POST | `/api/super-agent/ui/schedules` | 读/建定时唤醒 |
| POST | `/api/super-agent/ui/schedules/run` | 立即执行一次某条定时任务 |
| POST | `/api/super-agent/ui/schedules/cancel` | 取消某条定时任务 |

## 配置文件

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

  "models": {
    "allowed": [],
    "default": "",
    "defaultEffort": "",
    "onlyProvider": "",
    "onlyNames": []
  },

  "agreements": {
    "fileName": "super-agent.agreements.json",
    "maxItems": 40,
    "maxCharsPerItem": 2000,
    "injectChars": 6000
  },

  "schedule": {
    "maxActive": 20,
    "timeZone": "",
    "frame": true
  },

  "voice": {
    "style": "brief",
    "maxWords": 120,
    "expandWhenAsked": true
  },

  "channels": {
    "im":     { "maxWords": 100, "guidance": "One decision or result." },
    "github": { "maxWords": 600, "guidance": "Context, change, verification." },
    "email":  { "maxWords": 500 }
  }
}
```

容易误用的字段：

- `sources.<name>.mode`：`addressed`（默认 IM，需点名）、`candidate`（候选，
  由 Router 判断）、`ignore`（程序层丢弃）。
- `requireMention`：`addressed` 模式下是否要求 `@agent` / `mentions` / `direct`。
- `actorsDeny` + `ignoreActors`：支持末尾 `*` 通配；`ignorePatterns` 是正文正则。
- `dataDir`：相对项目根或绝对路径；拒绝盘符根、`~/.dsh`、系统目录。
- `router.sessionId`：固定 Router 会话；留空表示本项目第一个根会话。
- `worker.maxWorkers`：同时执行中的 Worker 上限；完成的 Worker 让出执行槽位，
  queued 任务自动补位。idle Worker 可供 steer/Thread 直通。
- `channels.<name>.maxWords`：`superagent_tell` 硬上限；`0` 表示不限。
- `redact`：进入 journal 前遮盖常见 key/token；不是安全边界。
- `models.allowed`：Router 唯一可选的 Worker 模型；空数组时按 `onlyProvider` /
  `onlyNames` 过滤，再空则跟随宿主全部目录。面板会显示过滤原因和
  “DSH 共 N 个”的总数。`default` 必须是 allowlist 里的 `id` 或 `provider/model`。
- `models.defaultEffort`：默认思考强度；为空用模型自己的默认。
- `agreements.fileName`：相对项目根 `.dsh/` 的文件名；一般不用改。
- `schedule.maxActive`：活跃定时任务上限；`timeZone` 是未传时区时的默认 IANA
  时区，空表示用宿主本地时区。
- `voice.maxWords`：`superagent_tell` 的短回复上限；`expandWhenAsked` 允许用户
  明确要求长答时放宽。

配置坏了（JSON 语法、路径越界、字段类型）时插件保持关闭并记 warn，不会阻止
普通会话创建。

## 频道桥

插件不直接调用 IM/GitHub API。桥接器读 `outbox.jsonl`：

```sh
tail -F /path/to/project/.dsh/super-agent/outbox.jsonl
```

每行包含 `id`、`channel`、`text`、`threadId`、`taskId`、`words`、`createdAt`、
`status`。发送成功后由桥接器自行记录回执；插件不删除 outbox 行。
