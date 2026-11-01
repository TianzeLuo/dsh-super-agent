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
- 右侧「近期活动」按任务创建时间倒序展示进行中和已结束的任务；超过 8 条可
  展开。
- Worker Session 不出现在侧栏，`[super-agent]` 内部 trigger 不出现在聊天流。
- 顶部「Reset」二次确认后中止当前 Worker、切换新的 dataDir generation、创建新
  Router；旧 Worker 归档，旧 Router 会话保留但隐藏。

默认 workspace：

| 平台 | 路径 |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/dsh-super-agent/workspace` |
| macOS | `~/Library/Application Support/dsh-super-agent/workspace` |
| Windows | `%LOCALAPPDATA%\dsh-super-agent\workspace` |

可用 `DSH_SUPER_AGENT_HOME` 或 profile 配置 `superAgentHome` 覆盖。

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
- 只有源任务处于 `idle` / `blocked`、且 Worker 没有其他 `starting`/`working`
  任务时才允许；
- 新任务必须使用同一 cwd/project；
- 需要独立并行或跨项目时不要复用，直接创建新 Worker；
- 旧任务保持为独立活动记录；关闭其中一个不会掐掉仍被其他任务共享的 Worker。

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
| POST | `/api/super-agent/ui/reset` | 中止 Worker、切换 generation、创建新 Router |

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

配置坏了（JSON 语法、路径越界、字段类型）时插件保持关闭并记 warn，不会阻止
普通会话创建。

## 频道桥

插件不直接调用 IM/GitHub API。桥接器读 `outbox.jsonl`：

```sh
tail -F /path/to/project/.dsh/super-agent/outbox.jsonl
```

每行包含 `id`、`channel`、`text`、`threadId`、`taskId`、`words`、`createdAt`、
`status`。发送成功后由桥接器自行记录回执；插件不删除 outbox 行。
