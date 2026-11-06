# 开发

## 目录

- `lib/index.js` — 宿主半部：实例注册、Router/Worker、工具、Trigger、journal。
- `lib/client.js` — 浏览器半部（单文件 bundle）：面板、实例切换、预览、通知落点。
- `lib/*.js` — 纯逻辑模块（attendance、instances、objectives、agreements…）。
- `test/` — Node 单元/集成测试；`test/client-bundle.mjs` 在 Node 里加载 client bundle。
- `cordis.patch.yml` — profile 挂载行；`prompts/` — Router/Worker 提示词。

## 本地开发

```sh
dsh plugin --profile web add /abs/path/to/dsh-super-agent
npm test
```

- **没有构建步骤**：`lib/client.js` 就是浏览器直接加载的 bundle，改完刷新页面即可；
  `dsh-client-hmr` 监视文件变更并重建客户端模块。
- 改 `lib/index.js`（宿主半部）需要重启 `dsh web`；`app-boot` 的配置热重载不会重新
  加载已加载的模块。
- 面板里 `?navdebug=1` 打开导航诊断，详见 [troubleshooting.md](troubleshooting.md)。

## 边界

- 单机、单进程；状态在项目/实例 dataDir 的 journal 里，只追加。
- Worker 会话不跨宿主进程恢复；重启后活动任务转 `interrupted`，由 Router 决定复用或关闭。
- 跨项目 Worker 使用 DSH 普通 Session，审批走目标项目默认策略。
- 插件不直接调用 IM/GitHub API；频道桥读 outbox。
- 没有删除/清理逻辑；journal、旧 generation、归档会话都保留。
- 目标事件是新增 journal 类型：旧版本读新 journal 会忽略，新版本读旧 journal 只是
  没有目标，不需要 schema 迁移。

## 与其它插件的独立性

本插件不 import 其它插件包，也不要求对方存在：

- **只装本插件**：宿主加载 `cordis.patch.yml` → 注册 `main` 的 `super-agent` 槽与
  `conversation.input.left` 徽标；`awayNotify`、`awayNotifyPanels`、`uiWorkspace`、
  `layout` 全部走 `ctx.inject` 可选探测（`lib/index.js`、`lib/client.js`）。
- **同时装 dsh-chatgpt-ui**：它的 dot 分段只在探测到 `super-agent` 槽时出现；本插件
  不知道皮肤是否存在，也不依赖它的类名/令牌（`test/independence.test.mjs` 断言）。
- **证据**：`test/independence.test.mjs`（3 项）；隔离实例
  `DSH_HOME=/tmp/dsh-indep-sa dsh web --port 3099` 启动 HTTP 200，boot combo 只含
  `dsh-super-agent/client.js`，服务端日志无 error。
