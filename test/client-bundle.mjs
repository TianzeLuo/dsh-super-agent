/**
 * client-bundle.mjs — 在最小桩上求值 lib/client.js（浏览器半部）的共享加载器。
 *
 * 浏览器半部是 `window.__ModuleLoader__.load({…})` 形式的经典脚本，Node 里没有
 * `window`。这里只铺 bundle 求值需要的最小 DOM/计时器桩，拿到 registration 后用
 * 一个只认识 `react` 的 require 执行 factory，返回它的导出与测试用内部函数。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const SOURCE = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')

/** 求值 client bundle 并返回它的导出（含 `__internals`）。 */
export function loadClientBundle() {
  let registration
  const windowStub = { __ModuleLoader__: { load: (value) => { registration = value } } }
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  const run = new Function( // eslint-disable-line no-new-func
    'window',
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
    { querySelectorAll: () => [], body: {} },
    class { observe() {} disconnect() {} },
    () => 0,
    () => {},
    async () => { throw new Error('client bundle must not fetch during load') },
    globalThis.AbortController,
  )
  return registration.factory(requireStub)
}
