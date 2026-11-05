import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_INSTANCE_ID, InstanceRegistry, instanceRegistryPath } from '../lib/instances.js'

function root() {
  return mkdtempSync(join(tmpdir(), 'dsh-super-agent-instances-'))
}

test('missing registry migrates to one default instance at the anchor root', () => {
  const dir = root()
  const registry = new InstanceRegistry(dir)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.getDefault().id, DEFAULT_INSTANCE_ID)
  assert.equal(registry.getDefault().name, 'Super-agent')
  assert.equal(registry.getDefault().home, dir)
  assert.equal(registry.get(DEFAULT_INSTANCE_ID).unread, 0)
  assert.ok(readFileSync(instanceRegistryPath(dir), 'utf8').includes('"default"'))
})

test('create/rename keeps isolated homes and rejects duplicate names', () => {
  const dir = root()
  const registry = new InstanceRegistry(dir)
  const writing = registry.create('写作')
  assert.match(writing.id, /^inst-/)
  assert.equal(writing.home, join(dir, 'instances', writing.id))
  assert.throws(() => registry.create(' 写作 '), /名称已存在/)
  const renamed = registry.rename(writing.id, '长文写作')
  assert.equal(renamed.name, '长文写作')
  assert.equal(renamed.home, writing.home)
  assert.throws(() => registry.rename(writing.id, ''), /名称需为/)
})

test('unread survives reload and can be cleared', () => {
  const dir = root()
  const registry = new InstanceRegistry(dir)
  const writing = registry.create('写作')
  registry.addUnread(writing.id)
  registry.addUnread(writing.id)
  assert.equal(registry.unreadTotal(), 2)
  const reloaded = new InstanceRegistry(dir)
  assert.equal(reloaded.get(writing.id).unread, 2)
  assert.equal(reloaded.unreadTotal(), 2)
  reloaded.clearUnread(writing.id)
  assert.equal(reloaded.unreadTotal(), 0)
  assert.equal(new InstanceRegistry(dir).get(writing.id).unread, 0)
})

test('invalid/corrupt registry falls back without losing valid rows', () => {
  const dir = root()
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  writeFileSync(instanceRegistryPath(dir), JSON.stringify({
    version: 1,
    instances: [
      { id: 'default', name: 'Super-agent', home: '.', unread: 1 },
      { id: '../../escape', name: 'bad', home: '../../escape' },
      { id: 'dup', name: 'A', home: 'instances/dup' },
      { id: 'dup', name: 'B', home: 'instances/dup' },
    ],
  }))
  const registry = new InstanceRegistry(dir)
  assert.deepEqual(registry.list().map((row) => row.id), ['default', 'dup'])
  assert.equal(registry.get('default').unread, 1)
})
