# 排障

## 刷新或热更新后跳到普通会话

宿主保存当前 Session，但不会保存主面板选择；插件热更新还会暂时移除面板注册，
宿主因此清空当前面板。插件现在按浏览器标签页记住是否正在使用 Super-agent，等主面板
注册和原生会话目录就绪后恢复一次；目录未加载时不会提前连接会话。

主动选择普通会话、打开其他面板或点击“在会话中打开”，会取消待恢复状态。通知链接的
明确目标优先。恢复不循环抢焦点，不开启默认导航拦截；浏览器禁用会话存储时，刷新后的
恢复不可用。更新后先正常打开一次 Super-agent，再刷新验证。

## 其他自动切换 / 点通知不跳

- 症状与根因：Worker 曾被 away-notify 当普通会话弹通知并写 `pendingFocus`，回前台时
  `switchTo → replaceMain → selectPanel(null)` 关掉面板。现在 Worker 创建/恢复时由
  `lib/internal-sessions.js` 调 `awayNotify.markInternal`，通知在源头静默；Router 保留
  通知，并由插件层常驻 retain，点击走 `selectPanel + showSession`。
- 地址栏加 `?navdebug=1`：记录 `layout.panelInfo` / `layout.selectPanel` /
  `away-notify.showSession` / `super-agent.*`，带调用栈，最多 500 条到
  `window.__SA_NAV_LOG__`。
- 导航守卫默认关，仅 `localStorage['dsh.super-agent.navGuard']='on'` 时启用诊断式拦截；
  复现脚本 `node test/manual/repro-panel-yank.mjs --navdebug`。
- 刷新与热更新的恢复已单独处理；如果仍出现其他自动切换，用导航诊断中的调用栈定位，
  不把所有切换都归因于通知或热更新。
- 通知依赖 [dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify)；没装时不会弹系统通知，但面板与任务不受影响。

## 面板出现两份 / 热重载后行为怪

同一页面理论上只跑一份 client（`window.__dshSuperAgentInstance` 先到者持有，后到者
退出并 warn）。`Ctrl+Shift+R` 硬刷新；Network 里 `plugins/??…super-agent/client.js`
应只有一条（boot combo）。

## 文件预览

预览是面板内的一列，不是宿主右栏：官方右栏在 `activePanelId !== null` 时停用，且没有
per-session surface 接口。详细原因见 [design.md](design.md) 的不变量 26。

## 配置/数据

- 项目配置：`<project>/.dsh/super-agent.json`；实例数据：dataDir 下的 journal。
- 配置损坏会降级为 warning，不阻塞 Router 启动；完整字段见 [usage.md](usage.md)。
