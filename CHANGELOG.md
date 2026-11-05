# Changelog

## Unreleased

### Fixed

- **文件链接在 Super-agent 面板里打不开**。面板注册为全局 `main` 面板，右侧栏因此没有
  「屏上会话」，官方 `sidebarRight.openResource` 会对会话里的每个文件链接抛
  `sidebarRight: no session surface is mounted`。插件现在在面板挂载期间只包装这一个
  公开方法：没有屏上会话且地址是 `dsh-resource://file/…` 时，解析成「会话 + 路径 +
  行号」交给面板自带的预览抽屉（读 `remote.workspaceFiles` 一页并按行渲染）；
  其余情况（普通会话语义、非文件资源、面板已卸载）原样调用官方实现。
  覆盖的工具行路径、`@file` 引用和交付卡片都走同一条 `openResource` 路径。
