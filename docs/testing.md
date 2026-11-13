# 测试

```sh
npm test        # node --test
```

- 全部离线，不调用模型；当前 **382** 个用例，约 12 秒。
- `test/client-bundle.mjs` 用最小 DOM/React 桩加载 `lib/client.js`，暴露 `__internals`，
  因此面板逻辑（落点、retain、预览、徽标、导航守卫）可在 Node 里直接断言。
- 测试文件按模块拆分：`plugin.test.mjs`（宿主生命周期）、`activity.test.mjs`（活动排序/游标分页）、`activity-ui.test.mjs`（活动分页/收起状态机）、`approval.test.mjs`（审批阻塞/策略预留）、`attachment-refs.test.mjs`（会话附件引用 `msg:` 解析/限额/错误）、`independence.test.mjs`
  （不跨包 import / 可选 service）、`notification-nav.test.mjs`（通知落点/retain）、`client-*.test.mjs`（面板）、`instances`/`objectives`/`schedules`/
  `attendance`/`agreements` 等纯逻辑。
- 逐文件映射与契约说明见 [design.md](design.md) 的「测试」一节。
- 端到端验证记录（隔离 profile + Playwright）也保存在 `design.md`；日常回归只跑
  `npm test`。
