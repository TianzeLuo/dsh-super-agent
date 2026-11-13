# dsh-super-agent

在一个 DSH 窗口里跑**两层代理**：Router 负责判断与分派，Worker 在独立会话里执行；
面板复用官方会话，不是另一套聊天 UI。

## 截图

任务列表：两条执行中、一条排队、一条已完成、一条已丢失；顶部只把执行中算作「进行中」。

![任务列表与状态](docs/images/task-status-dark.png)

Worker 报告与给 Worker 补指令；发送默认插队到当前 run 的下一个模型步。

![Worker 报告与插队 steer](docs/images/worker-report-steer-dark.png)

从 Router 会话引用粘贴或上传的图片、文件，复制成副本后交给 Worker。

![会话附件引用](docs/images/attachment-flow-dark.png)

## 安装

```bash
dsh plugin --profile web add github:TianzeLuo/dsh-super-agent
```

1. 重启 `dsh web`（首次安装或替换包必须重启）
2. 刷新页面，左栏出现 **Super-agent**

开发调试时可改装本地目录：`dsh plugin --profile web add /path/to/dsh-super-agent`。

装不上或装完没反应，看 [排障](docs/troubleshooting.md)。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | `>=0.2.1`（只写下界） |
| 验证于 | 0.2.2-rc.3（2026-11-13） |
| Node | `>=22.5` |
| 平台 | web profile；Windows / WSL2 已验证 |

## 能做什么

- **两层代理**：Router 判断、Worker 执行，长任务不阻塞对话；面板复用官方会话，消息、审批和平时一致。
- **插队 steer**：给在线 Worker 补一句话，默认在它的下一个模型步生效，不必等整轮跑完。
- **会话附件引用**：当前 Router 会话里粘贴或上传的图片、文件可直接交给 Worker，不用先另存。
- **任务看板与定时唤醒**：进行中 / 已丢失 / 等待审批分得清；到点自动唤醒 Router 继续。

## 用法

| 触发方式 | 位置 | 行为 |
| --- | --- | --- |
| 左栏 **Super-agent** | 侧栏 | 打开面板；首次使用自动准备独立的 Super-agent Workspace |
| 直接说话派活 | Router 对话 | Router 自行决定开 Worker 还是直接回答 |
| 项目开关 | 项目根 `.dsh/super-agent.json` | 写入 `{"version":1,"enabled":true}` 才启用；没有文件默认关闭 |
| 任务徽标 / 报告 | 面板 | 查看状态、补指令（steer）、处理审批 |

关掉插件后：面板与 Worker 入口消失，普通会话和其他插件照常；项目配置与 journal 保留。

配置项、工具参数与 HTTP 接口见 [使用与配置](docs/usage.md)；设计取舍见 [架构](docs/design.md)。

## 已知限制

- 单机单进程；状态在 dataDir 的追加式 journal 里，不轮转。同一 dataDir 只允许一个 Router。
- Worker 会话不跨 `dsh web` 重启恢复：能救回的转为可续跑，救不回的标记为中断，由 Router 决定下一步。
- 未装 [dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify) 时没有系统通知，只退回标题前缀标记。

完整清单见 [已知限制](docs/limitations.md)。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/development.md](docs/development.md) | 目录结构、本地调试、测试 |
| [docs/usage.md](docs/usage.md) | 使用、配置、HTTP API |
| [docs/design.md](docs/design.md) | 架构与不变量 |
| [docs/limitations.md](docs/limitations.md) | 完整限制清单 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见故障对照 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |

## 隐私与数据

- 读取：Router 会话的消息与附件（只在你明确引用某个附件时）、任务与项目配置。
- 外发：Worker 的模型请求走你已配置的 DSH provider；插件自身不发第三方请求。
- 存储：dataDir 下的 journal 与附件副本；项目开关在项目根的 `.dsh/super-agent.json`。
- 关闭后：不再派工或唤醒；已有 journal、暂存附件和归档会话都保留，不自动清理。

## 许可证

MIT，见 [LICENSE](LICENSE)。
