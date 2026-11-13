# 已知限制

[← 返回 README](../README.md)

这些是**有意保留**的边界，不是待修 bug；遇到时知道「这是预期行为」即可。

## 运行模型

- **单机、单进程**：状态写在 dataDir 的追加式 journal 里，只追加、不删除、不轮转。
  同一 dataDir 只允许一个 Router（靠租约），多开 DSH 实例请用各自的实例目录。
- **不跨宿主重启恢复 Worker**：能救回的 Worker 会话转为可续跑（resumable），救不回的
  转为中断（interrupted）；被打断的那一轮不会重放，由 Router 决定续跑、复用还是关闭。
- **不保证外部副作用恰好一次**：只保证事件去重与至少一次投递。
- **默认关闭**：项目根没有 `.dsh/super-agent.json`（或 `enabled` 不为真）时不启用；
  配置损坏降级为 warning，不阻塞项目里其它会话。

## 委派与审批

- **跨项目 Worker 使用普通 Session**，审批走目标项目的默认策略；本插件不自动放行。
- Worker 并发默认 4（`worker.maxWorkers`），超出会排队而不是丢弃。
- 模型 allowlist 为空表示不限制；一旦显式配置，面板与 Worker 都只看到过滤后的目录。

## 附件

- 只解析**当前 Router 会话**里的消息，不跨会话取附件。
- 暂存副本留在 dataDir 的 `attachments/<taskId>/` 下，**不自动清理**；本插件没有删除逻辑。
- 目录、符号链接、失效引用、越界 part 和不支持的图片格式（BMP/TIFF/HEIC/AVIF/ICO）
  都会显式报错；复制失败整体拒绝，不会留下半个任务。

## 外部通道与集成

- **不内置 IM / GitHub / 邮件 API**；频道桥只读 outbox，由外部适配器负责发送。
- 没有安装 [dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify) 时没有系统
  通知，Worker 只退回标题前缀标记，其余功能不受影响。
- 不提供云端无状态计算、多设备 daemon 或分布式存储；面板也不复制宿主聊天协议。
