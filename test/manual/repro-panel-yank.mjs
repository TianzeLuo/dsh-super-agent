/**
 * repro-panel-yank.mjs — 复现「刚打开 super-agent 面板就被切走」的三条自动路径。
 *
 * 这里不启动 dsh：把宿主三条关闭面板的**真实语义**抄成最小桩（文件:行号见注释），
 * 然后按「用户点开面板 → 2 秒内发生一次自动事件」的顺序回放，打印 activePanelId
 * 的每一次变化。守卫打开后再回放一次，对比同一序列。
 *
 * 用法：
 *   node test/manual/repro-panel-yank.mjs
 *   node test/manual/repro-panel-yank.mjs --navdebug   # 同时打印 __SA_NAV_LOG__
 */

import { loadClientBundle } from '../client-bundle.mjs'

const PANEL_ID = 'super-agent'
const navdebug = process.argv.includes('--navdebug')

/**
 * 宿主 layout 的 store 桩（语义照抄 dsh-client-ui-layout/lib/client.js:405-412）。
 *
 * @returns {object} store。
 */
function fakePanelStore() {
  const state = { panelInfo: { activePanelId: null } }
  const subscribers = new Set()
  const emit = () => { for (const fn of [...subscribers]) fn() }
  return {
    state,
    // 宿主的 panelInfo 是带 subscribe 的 store（ui-layout:614 的 getSnapshot/subscribe）
    panelInfo: { getSnapshot: () => ({ ...state.panelInfo }), subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn) } },
    actions: {
      selectPanel: (panelId) => { state.panelInfo.activePanelId = panelId; emit() },
      // :410 —— 每次 main 注册表变动都会跑（直接写 store，不经过 selectPanel）
      retainMainPanels: (panelIds) => {
        if (state.panelInfo.activePanelId !== null && !panelIds.includes(state.panelInfo.activePanelId)) {
          state.panelInfo.activePanelId = null
          emit()
        }
      },
    },
  }
}

/**
 * 宿主会写 activePanelId 的三种自动来源。
 *
 * @param {object} store 面板 store。
 * @param {object} layout `selectPanel` 服务（可能已被守卫包装）。
 * @param {string[]} mainKeys `slots.entries('main')` 当前内容。
 * @returns {Array<{ name: string, run: () => void }>} 场景列表。
 */
function scenarios(store, layout, mainKeys) {
  return [
    {
      name: 'main 注册表瞬时缺条目（插件热重载 / 条目重注册）→ retainMainPanels',
      // ui-layout:614-616 + :689
      run: () => store.actions.retainMainPanels([]),
    },
    {
      name: '通知落点回退 / 任何 uiWorkspace.openSession → replaceMain(…, "reveal")',
      // ui-workspace:1673
      run: () => {
        const panel = 'reveal'
        if (panel === 'reveal') layout.selectPanel(null)
      },
    },
    {
      name: '当前会话被归档 / 显式关闭 → clearMain()',
      // ui-workspace:1649
      run: () => layout.selectPanel(null),
    },
  ]
}

/**
 * 回放一条完整序列。
 *
 * @param {object} options 选项。
 * @param {boolean} options.guard 是否安装守卫。
 * @returns {Promise<object[]>} 每一步的结果。
 */
async function replay({ guard }) {
  // navLog 会打 console.info；回放时静音，只留最后的表格。
  const realInfo = console.info
  const realError = console.error
  console.info = () => {}
  if (navdebug) console.error = () => {}
  const exports = loadClientBundle(navdebug ? {} : {}, navdebug ? { location: { search: '?navdebug=1' } } : {})
  const internals = exports.__internals
  const store = fakePanelStore()
  const layout = {
    panelInfo: store.panelInfo,
    selectPanel: (panelId) => store.actions.selectPanel(panelId),
  }
  const listeners = new Map()
  const doc = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener: () => {},
    fire: (type) => { for (const fn of listeners.get(type) ?? []) fn({ type }) },
  }
  // 假时钟：真实里两次点击不会落在同一毫秒；同一次点击的多个事件才会。
  let clock = 1_000_000
  const tick = (ms) => { clock += ms }
  const gesture = (type = 'pointerdown') => { tick(400); doc.fire(type) }
  let disableGuard = () => {}
  if (guard) {
    disableGuard = internals.installNavGuard({}, {
      layout,
      document: doc,
      now: () => clock,
      storage: { getItem: () => null },
      isRegistered: () => true,
    })
  }

  const log = []
  const record = (step) => {
    log.push({ step, activePanelId: store.state.panelInfo.activePanelId })
  }

  // 1. 用户点左栏入口（真实手势）→ 打开面板
  gesture()
  layout.selectPanel(PANEL_ID)
  record('用户点击入口 → 打开面板')

  // 2. 2 秒内的自动事件（每条之间让事件循环走一圈，恢复逻辑才有机会跑）
  for (const scenario of scenarios(store, layout, [PANEL_ID])) {
    tick(300)
    scenario.run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    record(`自动：${scenario.name}`)
    if (store.state.panelInfo.activePanelId !== PANEL_ID) {
      // 只有没被挡住时才需要用户重新打开
      gesture()
      layout.selectPanel(PANEL_ID)
      record('（用户不得不重新打开面板）')
    }
  }

  // 3. 合法导航：用户重新打开面板，再点左栏会话 / Conversation（有手势）
  gesture()
  layout.selectPanel(PANEL_ID)
  record('用户重新打开面板')
  gesture()
  layout.selectPanel(null)
  record('用户点会话（合法导航）')

  disableGuard()
  console.info = realInfo
  console.error = realError
  return { log, navLog: navdebug ? exports.__window.__SA_NAV_LOG__ ?? [] : undefined }
}

const withoutGuard = await replay({ guard: false })
const withGuard = await replay({ guard: true })

const print = (title, result) => {
  console.log(`\n=== ${title} ===`)
  let previous
  for (const row of result.log) {
    const value = row.activePanelId === null ? 'null（面板被关掉）' : row.activePanelId
    const flag = previous !== undefined && previous !== row.activePanelId ? '  ← 变化' : ''
    console.log(`  ${row.step.padEnd(58)} activePanelId = ${value}${flag}`)
    previous = row.activePanelId
  }
}

print('未装守卫（现状）', withoutGuard)
print('装了守卫', withGuard)

if (navdebug) {
  console.log('\n=== __SA_NAV_LOG__（装了守卫的那次） ===')
  for (const entry of withGuard.navLog) {
    const detail = JSON.stringify(entry.detail)
    console.log(`  [${entry.kind}] ${detail}`)
    if (entry.kind === 'nav.blocked') {
      console.log(String(entry.stack).split('\n').slice(1, 4).map((line) => `      ${line.trim()}`).join('\n'))
    }
  }
}
