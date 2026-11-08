/**
 * make-nav-notice-screenshots.mjs — 通知跳转落点的「顶部提示」前后对照截图。
 *
 * 背景（用户实测）：从 away-notify 弹窗点进来后，面板顶部会多出一条
 * 「已定位到实例「plugin-agent」产生通知的会话。」——跳转本身已经说明结果，
 * 这条提示是噪声。这里用 **lib/client.js 里真实的样式对象**（`__internals.styles`）
 * 搭一个「宿主左栏 + super-agent 面板」的最小页面，分别渲染旧版（带提示）和
 * 新版（无提示）的同一个落点状态，用于同一路径的顶部对比。
 *
 * 只做静态复现，不启动 dsh、不读真实数据、不改任何状态。
 *
 * 用法：
 *   node test/manual/make-nav-notice-screenshots.mjs
 *   （默认写 ../../docs/screenshots/*.png；`CHROME=` 指定浏览器可执行文件）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadClientBundle } from '../client-bundle.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = join(ROOT, 'docs', 'screenshots')
const CHROME = process.env.CHROME
  ?? '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'

/** 无单位属性：数值不加 px。 */
const UNITLESS = new Set(['zIndex', 'opacity', 'flex', 'flexGrow', 'flexShrink', 'order', 'fontWeight', 'lineHeight', 'zoom', 'columnCount'])

/**
 * 把 React 的样式对象转成 CSS 声明。
 *
 * @param {Record<string, unknown>} style 样式对象（camelCase）。
 * @returns {string} `a: b; c: d` 形式。
 */
function cssOf(style) {
  return Object.entries(style).map(([key, value]) => {
    const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    const cssValue = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value)
    return `${name}: ${cssValue};`
  }).join(' ')
}

const { __internals: internals } = loadClientBundle()
const S = internals.styles

/** 宿主的主题 token（真实宿主由 theme 插件注入，这里给等价取值）。 */
const LIGHT = `
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f4f5f7;
  --dsw-alias-label-primary: #12141a;
  --dsw-alias-label-secondary: #5c6270;
  --dsw-alias-label-tertiary: #8b91a0;
  --dsw-alias-border-l1: rgba(0, 0, 0, .10);
  --dsw-alias-border-l2: rgba(0, 0, 0, .18);
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, .28);
  --dsw-alias-brand-primary-new-colorprimary-new-color: #4f7cff;
  --page-bg: #f7f8fa;
`

const SESSIONS = ['重构通知跳转', '文件预览抽屉', '未读判定', '定时任务清理', '模型选择器']

/**
 * 生成落点页：面板顶部只在 `notice` 时多一条旧版提示，其余完全相同。
 *
 * @param {{ notice: boolean, instanceName?: string }} options 选项。
 * @returns {string} HTML。
 */
function page({ notice, instanceName = 'plugin-agent' }) {
  const noticeHtml = notice
    ? `
      <div class="nav-notice" id="nav-notice">
        <span class="nav-notice-text">已定位到实例「${instanceName}」产生通知的会话。</span>
        <button type="button" class="small-button">返回</button>
        <button type="button" class="small-button">知道了</button>
      </div>`
    : ''

  return `<!doctype html>
<html lang="zh" data-theme="light">
<head>
<meta charset="utf-8">
<title>super-agent 通知跳转顶部 · ${notice ? 'before' : 'after'}</title>
<style>
  :root { ${LIGHT} }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    background: var(--page-bg);
    color: var(--dsw-alias-label-primary);
    font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  /* 宿主左栏：跳转后面板占主区域，左栏仍在。 */
  aside {
    width: 264px; flex: 0 0 264px; height: 100%;
    border-right: 1px solid var(--dsw-alias-border-l1);
    background: var(--dsw-alias-bg-layer-2);
    padding: 14px 12px; display: flex; flex-direction: column; gap: 6px;
  }
  aside .brand { font-weight: 650; font-size: 13px; margin-bottom: 6px; }
  aside .row { padding: 6px 8px; border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
  aside .row.active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
  main { flex: 1 1 auto; min-width: 0; height: 100%; }
  .panel { display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--dsw-alias-bg-base); }
  .panel-header { ${cssOf(S.header)} }
  .title-block { ${cssOf(S.titleBlock)} }
  .title-button { ${cssOf(S.titleButton)} }
  .title { ${cssOf(S.title)} }
  .caret { ${cssOf(S.status)} margin-left: 0; }
  .status { ${cssOf(S.status)} }
  .status-text { ${cssOf(S.statusText)} }
  .dot { ${cssOf(S.dot)} }
  .header-sep { ${cssOf(S.headerSeparator)} }
  .header-action { ${cssOf(S.headerAction)} }
  .header-action:hover { background: var(--dsw-alias-bg-layer-2); }
  .spacer { ${cssOf(S.spacer)} }
  .nav-notice { ${cssOf(S.navNotice)} }
  .nav-notice-text { ${cssOf(S.navNoticeText)} }
  .small-button { ${cssOf(S.smallButton)} }
  .panel-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .conversation { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 20px 22px 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 680px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 10px 12px; line-height: 1.55; }
  .msg.user { align-self: flex-end; background: var(--dsw-alias-bg-layer-2); }
  .msg .meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 3px; }
  .composer { flex: 0 0 auto; margin: 0 20px 18px; padding: 11px 13px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-tertiary); }
</style>
</head>
<body>
  <aside>
    <div class="brand">DeepSeek Harness</div>
    ${SESSIONS.map((name, index) => `<div class="row${index === 0 ? ' active' : ''}">${name}</div>`).join('\n    ')}
  </aside>
  <main>
    <div class="panel" data-super-agent-panel="">
      <div class="panel-header">
        <div class="title-block">
          <button type="button" class="title-button">
            <span class="title">${instanceName}</span>
            <span class="status caret" aria-hidden="true">▾</span>
          </button>
        </div>
        <span class="status" title="已连接">
          <span class="dot" aria-hidden="true"></span>
          <span class="status-text">已连接</span>
        </span>
        <span class="header-sep" aria-hidden="true"></span>
        <button type="button" class="header-action">模型</button>
        <button type="button" class="header-action">规则</button>
        <button type="button" class="header-action">定时</button>
        <span class="spacer"></span>
        <button type="button" class="header-action">刷新</button>
        <button type="button" class="header-action">重置</button>
        <button type="button" class="header-action">打开会话</button>
      </div>
      ${noticeHtml}
      <div class="panel-body">
        <div class="conversation">
          <div class="msg user">
            <div class="meta">你</div>
            修一下通知跳转：点桌面通知要直接到产生通知的那条会话。
          </div>
          <div class="msg">
            <div class="meta">super-agent</div>
            收到，已定位到「plugin-agent」的 Router 会话；面板、实例、会话三者按通知里的 id 对齐。
          </div>
        </div>
        <div class="composer">继续输入任务…</div>
      </div>
    </div>
  </main>
</body>
</html>
`
}

/** WSL 路径 → Windows 路径：headless Chrome 是 Windows 进程，只认盘符路径。 */
function toWindows(path) {
  const match = /^\/mnt\/([a-z])\//.exec(path)
  if (match === null) throw new Error(`not a drive path under /mnt: ${path}`)
  return `${match[1].toUpperCase()}:\\${path.slice(match[0].length).replace(/\//g, '\\')}`
}

mkdirSync(OUT, { recursive: true })
const shots = [
  { file: 'n1-notify-before.png', notice: true },
  { file: 'n1-notify-after.png', notice: false },
]

for (const shot of shots) {
  const htmlPath = join(OUT, shot.file.replace(/\.png$/, '.html'))
  writeFileSync(htmlPath, page({ notice: shot.notice }), 'utf8')
  const url = `file:///${toWindows(htmlPath).replace(/\\/g, '/')}`
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    '--virtual-time-budget=2000',
    `--screenshot=${toWindows(join(OUT, shot.file))}`,
    url,
  ], { stdio: 'ignore' })
  if (!existsSync(join(OUT, shot.file))) throw new Error(`chrome did not write ${shot.file}`)
  console.log(`wrote docs/screenshots/${shot.file} + ${shot.file.replace(/\.png$/, '.html')}`)
}
