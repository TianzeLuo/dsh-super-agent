/**
 * client.test.mjs — 浏览器半部的安装契约。
 *
 * 这些错误不会在宿主里报错：包被安装、按钮不出现、页面空白。只检查单文件
 * bundle 的 loader 形状、id、依赖边界，以及 package.json 的发现字段。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', ROOT)), 'utf8'))
const client = readFileSync(fileURLToPath(new URL('lib/client.js', ROOT)), 'utf8')

test('package.json exposes the web client bundle', () => {
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, [])
  assert.equal(manifest.dsh.client.external, undefined)
  assert.ok(manifest.files.includes('lib'))
})

test('client bundle is a single classic-script module with the stable id', () => {
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{/m)
  assert.match(client, /id: 'dsh-super-agent'/)
  assert.doesNotMatch(client, /^\s*import\s/m)
  assert.doesNotMatch(client, /^\s*export\s/m)
  assert.deepEqual([...client.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]), ['react'])
})

test('client registers the sidebar entry, main panel and session-scoped child', () => {
  assert.match(client, /name: 'sidebar\.panellist'/)
  assert.match(client, /name: 'main'/)
  assert.match(client, /CONVERSATION_SLOT/)
  assert.match(client, /scope: 'session'/)
  assert.match(client, /\/api\/super-agent\/ui\/ensure/)
  assert.match(client, /conversation\.content/)
})
