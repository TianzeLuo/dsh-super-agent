/**
 * client-bundle.mjs — 在最小桩上求值 lib/client.js（浏览器半部）的共享加载器。
 *
 * 浏览器半部是 `window.__ModuleLoader__.load({…})` 形式的经典脚本，Node 里没有
 * `window`。这里只铺 bundle 求值需要的最小 DOM/计时器桩，拿到 registration 后用
 * 一个只认识 `react`（以及调用方显式给的 seed 模块）的 require 执行 factory，
 * 返回它的导出与测试用内部函数。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const SOURCE = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')

/**
 * 求值 client bundle 并返回它的导出（含 `__internals`）。
 *
 * @param {Record<string, object>} [modules] 除 `react` 之外的 seed 模块；
 *   例如 `{ '@deepseek-ai/dsh-client-ui-primitives': stub }`。没给的模块 require
 *   时抛错，和宿主缺 seed 时一样。
 * @param {{ location?: { search?: string, href?: string }, window?: object, reuseWindow?: boolean }} [env]
 *   `location`/`window` 桩：`?navdebug=1` 这类开关在 bundle 求值时读取，必须在
 *   加载前给。`window` 上已有的字段会被保留（`__SA_NAV_LOG__` 断言用得到）。
 * @returns {object} bundle 导出；`__window` 是本次求值用的 window 桩。
 */
export function loadClientBundle(modules = {}, env = {}) {
  let registration
  // `reuseWindow: true` 时把调用方的 window 对象**原样**当全局用（同一页面被求值
  // 两次的场景：单实例标记、守卫注册表这些 window 级槽必须真的共享）。
  const windowStub = env.reuseWindow === true && env.window !== undefined
    ? env.window
    : {
        ...(env.window ?? {}),
        __ModuleLoader__: { load: (value) => { registration = value } },
      }
  windowStub.__ModuleLoader__ = { load: (value) => { registration = value } }
  const locationStub = env.location ?? { search: '' }
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const requireStub = (name) => {
    if (name === 'react' && Object.prototype.hasOwnProperty.call(modules, 'react')) return modules.react
    if (name === 'react') return React
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name]
    throw new Error(`unexpected require: ${name}`)
  }
  const run = new Function( // eslint-disable-line no-new-func
    'window',
    'location',
    'document',
    'MutationObserver',
    'setInterval',
    'clearInterval',
    'fetch',
    'AbortController',
    SOURCE,
  )
  run(
    windowStub,
    locationStub,
    env.document ?? { querySelectorAll: () => [], body: {} },
    class { observe() {} disconnect() {} },
    () => 0,
    () => {},
    async () => { throw new Error('client bundle must not fetch during load') },
    globalThis.AbortController,
  )
  const exports = registration.factory(requireStub)
  exports.__window = windowStub
  return exports
}
