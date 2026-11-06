/**
 * make-preview-screenshots.mjs — 文件预览抽屉的隔离复现 + 截图。
 *
 * 目的：不启动 dsh、不碰真实数据，只用 **lib/client.js 里真实的样式对象**
 * （`__internals.styles`）搭一个「宿主左栏 + 面板 + 抽屉」的最小页面，用
 * headless Chrome 截图，证明：
 *   1. 打开文件后主界面仍可见（抽屉没有铺满整屏、没有遮罩）；
 *   2. 抽屉在右侧、宽 520/640、高 100%、正文可滚动；
 *   3. `Esc` 能关掉抽屉；
 *   4. 旧外壳（`S.backdrop` 铺满面板 + 深色遮罩）会显示成什么样——作为对照。
 *
 * 用法：
 *   node test/manual/make-preview-screenshots.mjs
 *   （默认写 docs/screenshots/*.png；`CHROME=` 指定浏览器可执行文件）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadClientBundle } from '../client-bundle.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
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
  --shiki-background: #f6f8fa;
  --shiki-foreground: #1f2328;
  --page-bg: #f7f8fa;
`
const DARK = `
  --dsw-alias-bg-base: #14161a;
  --dsw-alias-bg-layer-1: #1a1d22;
  --dsw-alias-bg-layer-2: #22262c;
  --dsw-alias-label-primary: #e8eaf0;
  --dsw-alias-label-secondary: #9aa2b1;
  --dsw-alias-label-tertiary: #77808f;
  --dsw-alias-border-l1: rgba(255, 255, 255, .12);
  --dsw-alias-border-l2: rgba(255, 255, 255, .22);
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, .62);
  --shiki-background: #16181d;
  --shiki-foreground: #e6edf3;
  --page-bg: #0f1114;
`

const CODE = `import { definePlugin } from '@deepseek-ai/dsh'

export function apply(ctx) {
  ctx.slots.inject('main', function* () {
    const handle = ctx.slots.register({
      name: 'main',
      key: 'super-agent',
    }, (props) => h(SuperAgentPage, props))
    yield handle
  })
}

export const inject = ['sessions', 'slots', 'locale']
`

const SESSIONS = ['重构通知跳转', '文件预览抽屉', '未读判定', '定时任务清理', '模型选择器']

/**
 * 生成一个隔离页面。
 *
 * @param {object} options 选项。
 * @param {'light'|'dark'} options.theme 主题。
 * @param {'drawer'|'modal-old'} options.shell 抽屉外壳（新/旧）。
 * @param {boolean} options.closed 截图时抽屉是否已被 Esc 关掉。
 * @param {'code'|'error'|'hw7'} [options.body] 预览正文：正常代码 / 渲染错误态 / 真实 hw7.tex。
 * @param {boolean} [options.preview] 是否渲染预览列（false = 对照用：对话区独占全宽）。
 * @returns {string} HTML。
 */
function page({ theme, shell, closed, body = 'code', preview = true }) {
  const tokens = theme === 'light' ? LIGHT : DARK
  const isDrawer = shell === 'drawer'
  // 新外壳：没有遮罩层，抽屉自己贴右侧（`S.drawerPanel`）；旧外壳：`S.backdrop`
  // 铺满面板 + 遮罩 + 右侧 `S.drawer`——两者都用真实样式对象。
  const layerCss = isDrawer ? 'display: contents;' : cssOf(S.backdrop)
  const sheetCss = isDrawer
    ? cssOf({ ...S.drawerPanel, ...S.drawerPanelWide })
    : cssOf({ ...S.drawer, ...S.drawerWide })

  const crashNote = `
            <div class="crash" role="alert">
              <div class="crash-title">这段内容没能渲染出来</div>
              <div class="crash-detail">TypeError: Cannot read properties of undefined (reading 'split')</div>
              <button type="button" class="icon-button" style="width:auto;padding:0 10px">重试</button>
            </div>`

  // 真实数据：用户报错现场就是这类 .tex 文件（`<local>/code/dsa/homework/hw7.tex`）。
  // 读不到就退回内置样例，截图脚本不能因为别处文件缺失而失败。
  const HW7_PATH = process.env.HW7 ?? '<local>/code/dsa/homework/hw7.tex'
  let hw7 = ''
  try {
    hw7 = readFileSync(HW7_PATH, 'utf8').split('\n').slice(0, 14).join('\n')
  } catch {
    hw7 = CODE
  }
  const sample = body === 'hw7' ? hw7 : CODE
  const codeLines = sample.split('\n').map((line, index) => {
    const text = line.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    return `<span class="ln">${String(index + 1).padStart(3, ' ')}</span>${text || ' '}`
  }).join('\n')

  return `<!doctype html>
<html lang="zh" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>super-agent 文件预览抽屉 · ${theme}</title>
<style>
  :root { ${tokens} }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    background: var(--page-bg);
    color: var(--dsw-alias-label-primary);
    font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  /* 宿主左栏：抽屉必须留在右侧，不能盖住这里。 */
  aside {
    width: 264px; flex: 0 0 264px; height: 100%;
    border-right: 1px solid var(--dsw-alias-border-l1);
    background: var(--dsw-alias-bg-layer-2);
    padding: 14px 12px; display: flex; flex-direction: column; gap: 6px;
  }
  aside .brand { font-weight: 650; font-size: 13px; margin-bottom: 6px; }
  aside .row { padding: 6px 8px; border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
  aside .row.active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
  main { flex: 1 1 auto; min-width: 0; height: 100%; position: relative; }
  /* 面板主体是「一列对话 + 一列预览」的 flex 行：预览占宽，对话区让位。 */
  .panel-main { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: row; position: relative; }
  /* 面板根：和 S.root 一样 relative，抽屉绝对定位在它的右侧。 */
  .panel {
    position: relative; display: flex; flex-direction: column;
    width: 100%; height: 100%; min-width: 0; min-height: 0;
    background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  }
  .panel-header {
    display: flex; align-items: center; gap: 8px; min-height: 40px;
    padding: 5px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
    font-size: 13px; font-weight: 600;
  }
  .panel-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px 18px; }
  .msg { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
  .msg.user { background: var(--dsw-alias-bg-layer-2); }
  .composer { flex: 0 0 auto; margin: 0 18px 16px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-tertiary); }

  /* ── 抽屉外壳：与 lib/client.js 的 S.drawerPanel 完全一致 ── */
  .dismiss-layer { ${layerCss} }
  .dismiss-layer[hidden] { display: none !important; }
  .sheet { ${sheetCss} }
  .sheet-header { ${cssOf(S.drawerHeader)} }
  .sheet-title { ${cssOf(S.drawerTitle)} }
  .sheet-body { ${cssOf(S.drawerBody)} }
  .sheet-footer { ${cssOf(S.drawerFooter)} }
  .icon-button {
    appearance: none; border: 0; background: none; color: inherit; cursor: pointer;
    width: 26px; height: 26px; border-radius: 6px; font-size: 15px; line-height: 1;
  }
  .icon-button:hover { background: var(--dsw-alias-bg-layer-2); }
  .preview-path { ${cssOf(S.previewPath)} }
  .preview-note { ${cssOf(S.previewNote)} }
  .crash { ${cssOf(S.crashBox)} }
  .crash-title { ${cssOf(S.crashTitle)} }
  .crash-detail { ${cssOf(S.crashDetail)} }
  .esc-note {
    margin: 0 0 12px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-primary); font-size: 12px;
  }

  /* 官方 CodeBlock 的样子（class 名与宿主一致，仅用于截图）。 */
  .md-code-block { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; background: var(--shiki-background); }
  .md-code-block .banner {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary);
    border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  }
  .md-code-block pre {
    margin: 0; padding: 10px 12px; overflow: auto;
    font: 12px/1.55 "Cascadia Code", Consolas, ui-monospace, monospace;
    color: var(--shiki-foreground);
  }
  .md-code-block .ln { color: var(--dsw-alias-label-tertiary); user-select: none; margin-right: 10px; }
  .hint { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 10px 0 0; }
</style>
</head>
<body>
  <aside>
    <div class="brand">DeepSeek Harness</div>
    ${SESSIONS.map((name, index) => `<div class="row${index === 0 ? ' active' : ''}">${name}</div>`).join('\n    ')}
  </aside>
  <main>
    <div class="panel" id="panel">
      <div class="panel-header"><span>☰</span><span>super-agent</span></div>
      <div class="panel-main">
      <div class="panel-body" id="panel-body">
        ${closed ? '<div class="esc-note">脚本在截图前派发了 <b>Escape</b>：抽屉已关闭，面板恢复可交互（刷新不是必需的）。</div>' : ''}
        <div class="msg user">点这个文件看看：<b>lib/client.js</b>（打开后主界面应当仍然可见）</div>
        <div class="msg">预览是面板右侧的一列（560px，最宽 640px）：对话区会跟着变窄，左栏、顶部、输入框都还能看见、还能点。按 <b>Esc</b> 或右上角 ✕ 关闭。</div>
        <div class="composer">输入任务…（这里应当始终可见，不能被遮罩盖住）</div>
      </div>
      ${preview ? '' : '<!-- 对照：预览关闭 -->'}
      <div class="dismiss-layer" id="layer"${preview ? '' : ' hidden=""'}>
        <div class="sheet" id="sheet" role="dialog" aria-modal="false" aria-label="文件预览">
          <div class="sheet-header">
            <div class="sheet-title">文件预览</div>
            <button type="button" class="icon-button" id="close" aria-label="关闭">✕</button>
          </div>
          <div class="sheet-body">
            <div class="preview-path">${body === 'hw7' ? HW7_PATH : '<local>/project/tools/plugin/dsh-super-agent/lib/client.js'}</div>
            ${body === 'error'
              ? crashNote
              : `<div class="md-code-block" data-line-numbers="true">
              <div class="banner" data-code-block-banner="true"><span>${body === 'hw7' ? 'latex' : 'js'}</span><span>复制</span></div>
              <pre><code>${codeLines}</code></pre>
            </div>`}
            <div class="preview-note">${body === 'hw7' ? '只读预览 · 第 1–14 行 · 共 342 行' : '只读预览 · 第 1–13 行 · 共 4759 行'}</div>
            <p class="hint">Esc 关闭 · 正文独立滚动 · 对话区让位</p>
          </div>
          <div class="sheet-footer"><button type="button" class="icon-button" style="width:auto;padding:0 10px">重试</button></div>
        </div>
      </div>
      </div>
    </div>
  </main>
<script>
  // 真实抽屉的关闭手势：Esc + 点抽屉外（与 bindDrawerDismiss 一致）。
  const layer = document.getElementById('layer')
  const sheet = document.getElementById('sheet')
  function close() { layer.hidden = true }
  document.getElementById('close').addEventListener('click', close)
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close() }, true)
  document.addEventListener('mousedown', (event) => { if (!sheet.contains(event.target)) close() }, true)
  // 截图用：让 Esc 的关闭结果可见（截图只能拍到静态帧）。
  if (location.hash === '#after-esc') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
</script>
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

const shots = [
  { file: 'preview-drawer-light.png', theme: 'light', shell: 'drawer', closed: false },
  { file: 'preview-drawer-dark.png', theme: 'dark', shell: 'drawer', closed: false },
  { file: 'preview-drawer-esc-light.png', theme: 'light', shell: 'drawer', closed: true },
  { file: 'preview-drawer-old-mask-dark.png', theme: 'dark', shell: 'modal-old', closed: false },
  { file: 'preview-drawer-error-light.png', theme: 'light', shell: 'drawer', closed: false, body: 'error' },
  // 宽度对照：预览关闭时对话区独占；打开后对话区让位给右侧列。
  { file: 'preview-column-closed-light.png', theme: 'light', shell: 'drawer', closed: false, preview: false },
  { file: 'preview-column-open-light.png', theme: 'light', shell: 'drawer', closed: false },
  // 真实数据：hw7.tex 的正文（LaTeX 语言标签 + 行号），验证渲染不再抛错。
  { file: 'preview-hw7-dark.png', theme: 'dark', shell: 'drawer', closed: false, body: 'hw7' },
]

for (const shot of shots) {
  const html = page({
    theme: shot.theme,
    shell: shot.shell,
    closed: shot.closed === true,
    body: shot.body,
    preview: shot.preview !== false,
  })
  // 页面放在 docs/screenshots/ 里：Chrome 读得到，也能作为截图的可复现来源留着。
  const htmlPath = join(OUT, shot.file.replace(/\.png$/, '.html'))
  writeFileSync(htmlPath, html, 'utf8')
  const url = `file:///${toWindows(htmlPath).replace(/\\/g, '/')}${shot.closed ? '#after-esc' : ''}`
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
  console.log(`wrote ${join('docs/screenshots', shot.file)} + ${shot.file.replace(/\.png$/, '.html')}`)
}
