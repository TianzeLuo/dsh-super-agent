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
- **模型/思考强度可选**：默认跟随 DSH 宿主全部模型；面板可维护 allowlist、默认 Worker 模型，
  也可选地按 provider/名字过滤，并一键恢复全部。
- **近期活动可打开**：任务列表点开是占满右侧栏的详情卡，含报告、线程、模型和「给 Worker 发指令」；
  也可以直接打开完整 Worker 会话。默认 Worker 模型只在「Worker 模型」抽屉里设置，逐个勾选。
  面板跟随 DSH 的浅色/深色主题。
- **长期工作约定**：用户说「以后都这样」后，Router 把它写成全局或项目规则，注入自己
  和每个 Worker；Reset 不会丢。
- **定时唤醒**：用宿主 `ctx.schedule` 建一次/每日/每周/Cron 任务，到点唤醒 Router 再决定是否派活。
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
- 右侧「近期活动」按更新时间倒序显示进行中和已结束的任务；默认 6 条，可展开。
  点一条任务会在右侧活动栏内打开详情卡：状态、项目、模型/强度、Brief、报告、线程，以及
  「给 Worker 发指令」；卡片底部固定「打开聊天」，可直接回到完整 Worker 会话。
  关闭任务只释放运行中的 Agent，会话仍保留，所以历史任务也能回看。
- 顶部「Worker 模型」按钮打开统一抽屉：逐个勾选可调用模型、设置默认模型和
  每个模型的 effort 限制；默认值不再在顶栏重复一份。
- 「Rules」维护长期工作约定；「Schedules」管理定时唤醒。
- 「Reset」二次确认后中止当前 Worker、归档旧 Worker 会话、取消绑定当前 Router 的定时任务、
  切换新的数据目录 generation、创建新 Router。
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

### 只允许一个来源的模型

如果宿主同时配置了多个渠道，但只想让 Worker 用其中一家的几个模型，可以同时设置
`onlyProvider` 和 `onlyNames`，不用把每个 model id 抄一遍：

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

`onlyNames` 的顺序也是默认模型优先级；名字匹配 model id / 显示名，大小写不敏感。
`allowed` 非空时以显式 allowlist 为准，`onlyProvider` / `onlyNames` 只影响空
allowlist 时的可见目录。

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
