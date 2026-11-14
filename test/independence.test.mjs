import assert from 'node:assert/strict'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const libDir = join(root, 'lib')

function jsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...jsFiles(path))
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(path)
  }
  return out
}

test('不 import 其它插件包：与 dsh-chatgpt-ui 只靠运行时槽位/面板 id 联动', () => {
  for (const file of jsFiles(libDir)) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /from\s+['"]dsh-[a-z-]+['"]/, `${file} 不应跨包 import`)
    assert.doesNotMatch(source, /require\(\s*['"]dsh-[a-z-]+['"]\s*\)/, `${file} 不应跨包 require`)
  }
})

test('浏览器半部只声明宿主基础服务；可选联动走 ctx.inject 探测', () => {
  const source = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.match(source, /module\.exports\.inject = \['sessions', 'slots', 'locale'\]/)
  assert.match(source, /ctx\.inject\(\['awayNotifyPanels'\]/, 'away-notify 缺席时自动跳过')
  assert.match(source, /ctx\.inject\(\['uiWorkspace'\]/, 'uiWorkspace 是可选注入')
  assert.doesNotMatch(source, /data-chatgpt|--dsh-chatgpt|chatgpt-ui/, '面板不依赖皮肤类名/令牌')
})

test('宿主半部可选依赖 away-notify：没有它仍能启动', () => {
  const source = readFileSync(join(libDir, 'index.js'), 'utf8')
  assert.match(source, /inject\?\.\(\['awayNotify'\]/, 'awayNotify 用可选 inject')
  assert.match(source, /catch[\s\S]{0,160}退回标题前缀/, '缺失时退回标题前缀')
})
