/**
 * config.test.mjs — 项目开关、合并顺序与数据根边界。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULTS,
  DEFAULT_DATA_DIR,
  SUPER_AGENT_WORKSPACE_MARKER,
  checkDataDir,
  defaultSuperAgentWorkspaceHome,
  findProjectRoot,
  isSuperAgentWorkspace,
  loadProjectConfig,
  mergeConfig,
  sourcePolicy,
  channelConfig,
} from '../lib/config.js'

/** 建一个带 .git 的项目目录；不删除，测试进程退出后由系统临时目录处理。 */
function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-super-agent-config-'))
  mkdirSync(join(root, '.git'))
  if (config !== undefined) {
    mkdirSync(join(root, '.dsh'))
    writeFileSync(join(root, '.dsh', 'super-agent.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return root
}

test('findProjectRoot walks up to the nearest .git', () => {
  const root = project({ enabled: true })
  const nested = join(root, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), root)
})

test('the dedicated Super-agent workspace is its own project boundary', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-agent-home-config-'))
  writeFileSync(join(home, SUPER_AGENT_WORKSPACE_MARKER), '{}\n')
  const nested = join(home, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), home)
  assert.equal(isSuperAgentWorkspace(home, home), true)
  assert.equal(isSuperAgentWorkspace(nested, home), false)
  assert.equal(defaultSuperAgentWorkspaceHome({ DSH_SUPER_AGENT_HOME: home }, 'linux', '/home/test'), home)
  const fallback = defaultSuperAgentWorkspaceHome({}, 'linux', '/home/test')
  assert.match(fallback, /dsh-super-agent[\\/]workspace$/)
  assert.doesNotMatch(fallback, /[\\/]\.dsh[\\/]/)
})

test('missing config keeps the project disabled by default', () => {
  const root = project()
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, false)
  assert.match(gate.reason, /缺少/)
  assert.equal(gate.dataDir, join(root, DEFAULT_DATA_DIR))
})

test('config file enables the project and relative dataDir resolves under the project', () => {
  const root = project({ enabled: true, dataDir: 'var/super-agent' })
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, true)
  assert.equal(gate.dataDir, join(root, 'var', 'super-agent'))
})

test('enabled:false disables even when the file exists', () => {
  const root = project({ enabled: false })
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, false)
  assert.match(gate.reason, /enabled=false/)
})

test('profile config can force-disable and cannot be overridden by the project', () => {
  const root = project({ enabled: true })
  const gate = loadProjectConfig({ cwd: root, pluginConfig: { enabled: false } })
  assert.equal(gate.enabled, false)
  assert.match(gate.reason, /显式关闭/)
})

test('profile config can enable a project without a config file', () => {
  const root = project()
  const gate = loadProjectConfig({ cwd: root, pluginConfig: { enabled: true } })
  assert.equal(gate.enabled, true)
  assert.equal(gate.dataDir, join(root, DEFAULT_DATA_DIR))
})

test('environment switch enables a project without a config file', () => {
  const root = project()
  const gate = loadProjectConfig({ cwd: root, env: { DSH_SUPER_AGENT_ENABLED: '1' } })
  assert.equal(gate.enabled, true)
})

test('malformed JSON fails closed with a diagnostic', () => {
  const root = project('{not json')
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, false)
  assert.match(gate.reason, /配置读取失败/)
})

test('absolute dataDir outside the project is allowed, but account/system roots are not', () => {
  const target = join(tmpdir(), 'dsh-super-agent-external-state')
  const root = project({ enabled: true, dataDir: target })
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, true)
  assert.equal(gate.dataDir, target)

  assert.match(checkDataDir(join(homedir(), '.dsh', 'super-agent')), /账户目录/)
  assert.match(checkDataDir('/etc/super-agent'), /系统目录/)
  assert.match(checkDataDir('/'), /文件系统根/)
  assert.match(checkDataDir('relative/path'), /绝对路径/)
  assert.match(checkDataDir('~/state'), /~/)
})

test('config warnings do not throw and keep defaults', () => {
  const root = project({
    enabled: true,
    sources: { im: { mode: 'sometimes', ignorePatterns: ['['] } },
    router: { maxBatch: -1 },
    worker: { maxWorkers: 0 },
  })
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, true)
  assert.ok(gate.warnings.length >= 3)
  assert.equal(gate.config.router.maxBatch, 24)
  assert.equal(gate.config.worker.maxWorkers, 4)
})

test('mergeConfig is a deep merge with array replacement', () => {
  const merged = mergeConfig({ a: { b: 1, c: [1, 2] } }, { a: { c: [3], d: 4 } })
  assert.deepEqual(merged, { a: { b: 1, c: [3], d: 4 } })
})

test('sourcePolicy falls back to defaultSource for unknown sources', () => {
  const config = mergeConfig({ defaultSource: { mode: 'candidate', maxTextChars: 123 }, sources: { im: { mode: 'addressed' } } })
  assert.equal(sourcePolicy(config, 'im').mode, 'addressed')
  assert.equal(sourcePolicy(config, 'unknown').mode, 'candidate')
  assert.equal(sourcePolicy(config, 'unknown').maxTextChars, 123)
})


test('router execution guard is on by default and can be turned off', () => {
  assert.equal(DEFAULTS.router.guardExecutionTools, true)
  const off = mergeConfig({ router: { guardExecutionTools: false } })
  assert.equal(off.router.guardExecutionTools, false)
})

test('null/malformed sections fall back instead of throwing', () => {
  const root = project()
  mkdirSync(join(root, '.dsh'))
  writeFileSync(join(root, '.dsh', 'super-agent.json'), JSON.stringify({
    version: 1,
    enabled: true,
    router: null,
    worker: { maxWorkers: 0 },
    channels: { im: { maxWords: -5 } },
  }))
  const gate = loadProjectConfig({ cwd: root })
  assert.equal(gate.enabled, true)
  assert.equal(gate.config.router.maxBatch, 24)
  assert.equal(gate.config.worker.maxWorkers, 4)
  assert.ok(gate.warnings.some((warning) => warning.includes('router')))
  assert.equal(channelConfig(gate.config, 'im').maxWords, 0)
})
