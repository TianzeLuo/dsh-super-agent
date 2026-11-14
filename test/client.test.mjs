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
  // 只允许宿主的 seed 静态模块：react + 官方 primitives（预览正文的渲染组件）。
  // 其余一律不走 require（宿主没有该 seed 时会抛，面板不该依赖它们）。
  assert.deepEqual(
    [...new Set([...client.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]))].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react'],
  )
})

test('client registers the sidebar entry, main panel and session-scoped child', () => {
  assert.match(client, /name: 'sidebar\.panellist'/)
  assert.match(client, /name: 'main'/)
  assert.match(client, /CONVERSATION_SLOT/)
  assert.match(client, /conversation\.input\.left/)
  assert.match(client, /scope: 'session'/)
  assert.match(client, /\/api\/super-agent\/ui\/ensure/)
  assert.match(client, /\/api\/super-agent\/ui\/reset/)
  assert.match(client, /conversation\.content/)
})

test('client has no project picker or focus endpoint', () => {
  assert.doesNotMatch(client, /FOCUS_KEY|ROUTES\.focus|sa-project-label/)
  assert.doesNotMatch(client, /<select|target project|目标项目/i)
  assert.match(client, /instance_id: targetId/)
  assert.match(client, /topic_id: targetTopic/)
  assert.match(client, /ROUTES\.instanceActive/)
  assert.match(client, /InstanceSwitcher/)
  assert.match(client, /publishUnread/)
  assert.match(client, /data-super-agent-nav-badge/)
  assert.match(client, /rgba\(79,124,255,\.72\)/)
  assert.match(client, /\/ui\/instances\/active/)
  assert.match(client, /instanceRename/)
  assert.doesNotMatch(client, /projectsAuto|welcomeBody|welcomeHint|disclaimer|activityHint|subtitle/)
  assert.doesNotMatch(client, /phase:\s*'hero'|hero:\s*true|useSessionBlank/)
  assert.match(client, /GLYPHS/)
  assert.match(client, /sa-activity-row/)
  assert.match(client, /sa-icon-button/)
  assert.match(client, /--dsw-alias-interactive-bg-hover/)
  assert.match(client, /sa-header-action/)
  assert.match(client, /data-slot="conversation\.session"\]:empty/)
  assert.match(client, /sa-conversation/)
  assert.doesNotMatch(client, /▾|✕|‹|＋|✓/)
})

test('client shows the live activity rail and hides Worker sessions', () => {
  assert.match(client, /activityTitle/)
  assert.match(client, /ActivityRail/)
  assert.match(client, /data-row-key/)
  assert.match(client, /data-chat-flow-kind/)
  assert.match(client, /Super-agent worker ·/)
  assert.match(client, /resetConfirm/)
  assert.match(client, /resetNote/)
  assert.match(client, /workspaceSessions/)
  assert.match(client, /activityListNext/)
  assert.match(client, /loadActivityMore/)
  assert.match(client, /sa-activity-collapse/)
  // 排序在数据层（runtime/activity.js），面板不再二次排序。
  assert.doesNotMatch(client, /rows\.slice\(\)\.sort/)
  assert.match(client, /async function reset|const reset = React\.useCallback/)
})
