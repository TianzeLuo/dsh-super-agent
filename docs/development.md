# 开发

## 目录

- `lib/index.js` — 宿主半部：实例注册、Router/Worker、工具、Trigger、journal。
- `lib/client.js` — 浏览器半部（单文件 bundle）：面板、实例切换、预览、通知落点。
- `lib/*.js` — 纯逻辑模块（attendance、instances、objectives、agreements…）；
  `lib/prompt.js` 组织 Router/Worker 提示词。
- `test/` — Node 单元/集成测试；`test/client-bundle.mjs` 在 Node 里加载 client bundle。
- `cordis.patch.yml` — profile 挂载行。

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

## 验证

先跑 `npm run check:core` 检查所有宿主、浏览器与 CLI 模块语法，再跑
`npm run test:core`（或 `npm test`）执行离线回归。测试入口只选 `test/*.test.mjs`，
不会自动执行 `test/manual/` 的截图采集脚本。依赖本机证据的用例在缺失时跳过。

主题回归覆盖：单 Store 与共享配额、异步调用作用域、报告／审批归属、附件来源、
私有状态与对象／Thread 读取、共享撤销竞态、召回预算、并发 ensure、冷主题恢复、
主题／实例约定和定时任务归属。真实宿主验证应使用全新 DSH_HOME 与测试实例，
明确固定 Router 和 Worker 的模型，验证并行任务、跨主题召回、重启后定时唤醒、
浏览器刷新、隐藏／恢复和窄屏管理抽屉。结果记录在[兼容记录](compat-matrix.md)。

记忆回归还覆盖版本冲突、有效容量与归档、同名本地覆盖、整条预算选择、完整旧格式
迁移及备份、来源消息和原生请求准入刷新顺序。界面测试验证编辑草稿在并发更新时保留，
不得把后台轮询的新版本偷偷带入旧草稿保存。Windows 的受限文件系统环境可能拒绝
临时 JSON 的原子替换；应在具备正常文件替换权限的测试环境运行，不能因此改为非原子写入。

真实多轮场景要对回答中的当前事实、否定条件和隐私字段评分，并使用全新读者与重启
场景，不能仅检查工具成功。复跑请求使用唯一标记，避免读取上一轮缓存结果；保留失败
记录并区分产品问题、模型问题与评分脚本问题。方法和本轮结果见
[记忆场景验证](memory-evaluation.md)。

分身界面的回归覆盖折叠偏好、创建失败保留草稿与共享选择、从任意页签创建、任务范围
选择，以及共享菜单的说明与键盘操作。嵌套菜单要模拟文档捕获阶段先于组件键盘事件的
真实顺序，不能仅调用组件的 Escape 处理器；切换任务范围的旧分页响应不得混入新范围。
编排依据与实际页面验证见[界面设计](ui-design.md)。

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
- **不依赖任何皮肤插件**：面板只注册自己的槽，不引用别的插件的类名、令牌或配置
  （`test/independence.test.mjs` 断言）。
- **证据**：`test/independence.test.mjs`（3 项）；隔离实例
  `DSH_HOME=/tmp/dsh-indep-sa dsh web --port 3099` 启动 HTTP 200，boot combo 只含
  `dsh-super-agent/client.js`，服务端日志无 error。
