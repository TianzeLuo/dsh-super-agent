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
- **事件驱动**：外部事件进入持久化 Trigger 队列，程序层过滤后合批给 Router。
- **Thread 直通**：已归属 Worker 的讨论后续直接投递，不再经过 Router。
- **可审计**：journal 只追加；活动栏只展示任务，不展示 Worker 内部会话。

## 安装

```sh
dsh plugin --profile web add /abs/path/to/dsh-super-agent
```

重启 `dsh web`，硬刷新页面，点击左栏 **Super-agent**。首次打开会自动准备独立的
Super-agent Workspace，不需要先选项目。

## 使用

- 直接输入任务；Router 根据描述和 `superagent_projects` 选择目标项目。
- 右侧「近期活动」按时间倒序显示进行中和已结束的任务；超过 8 条可展开。
- 「Reset」二次确认后中止当前 Worker、切换新的数据目录 generation、创建新 Router。
- Worker 会话和内部 `[super-agent]` trigger 不出现在侧栏/聊天流。

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

源任务必须是 `idle`/`blocked`，目标 cwd/project 必须一致，且 Worker 当前没有其他
执行中任务。需要独立并行时不要复用。细节见 [docs/usage.md](docs/usage.md)。

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
