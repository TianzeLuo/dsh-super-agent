import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  findModel,
  modelSummary,
  modelViewPayload,
  normalizeModelConfig,
  resolveModelSelection,
} from '../lib/models.js'

const catalog = {
  groups: [
    {
      id: 'qoder',
      name: 'Qoder',
      models: [
        {
          id: 'dfmodel',
          name: 'DeepSeek-V4-Pro',
          description: 'strong reasoning',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
        },
        {
          id: 'qfmodel',
          name: 'Qwen3.8-Flash',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'medium' },
        },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
    },
  ],
  failures: [],
  default: { provider: 'qoder', model: 'dfmodel', reasoningEffort: 'high' },
}

test('allowlist normalizes, keeps catalog efforts, and picks the configured default', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [
        { id: 'pro', provider: 'qoder', model: 'dfmodel', label: 'Pro', efforts: ['low', 'max'], defaultEffort: 'max', note: 'hard tasks' },
        { provider: 'qoder', model: 'qfmodel' },
      ],
      default: 'pro',
    },
  }, { catalog })
  assert.equal(view.mode, 'allowlist')
  assert.equal(view.models.length, 2)
  assert.equal(view.defaultId, 'pro')
  const pro = view.models[0]
  assert.equal(pro.label, 'Pro')
  assert.deepEqual(pro.efforts.map((effort) => effort.id), ['low', 'max'])
  assert.equal(pro.defaultEffort, 'max')
  assert.equal(pro.available, true)
  const flash = view.models[1]
  assert.equal(flash.id, 'qoder/qfmodel')
  assert.deepEqual(flash.efforts.map((effort) => effort.id), ['low', 'medium'])
  assert.equal(flash.defaultEffort, 'medium')
})

test('empty allowlist exposes the whole catalog and falls back to the host default', () => {
  const view = normalizeModelConfig({ models: { allowed: [] } }, { catalog })
  assert.equal(view.mode, 'all')
  assert.equal(view.models.length, 3)
  assert.equal(view.catalogTotal, 3)
  assert.equal(modelViewPayload(view).catalogTotal, 3)
  assert.equal(view.defaultId, 'qoder/dfmodel')
  assert.ok(modelSummary(view).includes('default qoder/dfmodel'))
  assert.ok(modelViewPayload(view).models.every((entry) => entry.configured === false))
})

test('resolveModelSelection honors defaults, explicit efforts, and labels', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [
        { id: 'pro', provider: 'qoder', model: 'dfmodel', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
        { id: 'flash', provider: 'qoder', model: 'qfmodel', efforts: ['low', 'medium'], defaultEffort: 'medium' },
      ],
      default: 'pro',
    },
  }, { catalog })
  assert.deepEqual(resolveModelSelection({}, view).selection, { provider: 'qoder', model: 'dfmodel', reasoningEffort: 'high' })
  assert.deepEqual(resolveModelSelection({ model: 'flash' }, view).selection, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'medium' })
  assert.deepEqual(resolveModelSelection({ model: 'flash', reasoningEffort: 'low' }, view).selection, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'low' })
  assert.deepEqual(resolveModelSelection({ model: 'Qwen3.8-Flash', reasoningEffort: 'low' }, view).selection, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'low' })
  assert.deepEqual(resolveModelSelection({ model: 'qoder/dfmodel', reasoningEffort: 'max' }, view).selection, { provider: 'qoder', model: 'dfmodel', reasoningEffort: 'max' })
})

test('resolveModelSelection rejects unknown models and disallowed efforts', () => {
  const view = normalizeModelConfig({
    models: { allowed: [{ id: 'pro', provider: 'qoder', model: 'dfmodel', efforts: ['low'] }], default: 'pro' },
  }, { catalog })
  assert.throws(() => resolveModelSelection({ model: 'nope' }, view), /unknown or disallowed model/)
  assert.throws(() => resolveModelSelection({ reasoningEffort: 'max' }, view), /does not allow reasoning effort/)
  assert.equal(findModel(view, 'pro').provider, 'qoder')
})

test('configured models survive a missing catalog but are marked unavailable', () => {
  const view = normalizeModelConfig({
    models: { allowed: [{ id: 'pro', provider: 'remote', model: 'x', efforts: ['max'] }], default: 'pro' },
  }, { catalog: { groups: [], failures: [{ provider: 'remote', message: 'down' }] } })
  assert.equal(view.models[0].available, undefined)
  const viewWithOthers = normalizeModelConfig({
    models: { allowed: [{ id: 'pro', provider: 'remote', model: 'x' }] },
  }, { catalog })
  assert.equal(viewWithOthers.models[0].available, false)
  assert.match(viewWithOthers.models[0].unavailableReason, /不在宿主当前模型目录/)
})

test('duplicate ids and malformed entries produce warnings, not throws', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [
        { id: 'same', provider: 'qoder', model: 'dfmodel' },
        { id: 'same', provider: 'qoder', model: 'qfmodel' },
        'nope',
      ],
    },
  }, { catalog })
  assert.equal(view.models.length, 1)
  assert.ok(view.warnings.some((warning) => warning.includes('duplicate') || warning.includes('重复')))
  assert.ok(view.warnings.some((warning) => warning.includes('不是对象')))
})

test('onlyProvider and onlyNames keep the router inside one source without an explicit allowlist', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [],
      onlyProvider: 'qoder',
      onlyNames: ['DeepSeek-V4-Pro', 'Qwen3.8-Flash'],
    },
  }, { catalog })
  assert.equal(view.mode, 'filtered')
  assert.equal(view.filtered, true)
  assert.equal(view.models.length, 2)
  assert.deepEqual(view.models.map((entry) => entry.model), ['dfmodel', 'qfmodel'])
  assert.equal(view.defaultId, 'qoder/dfmodel')
  assert.equal(view.catalog.groups.length, 1)
  assert.equal(view.catalog.groups[0].id, 'qoder')
  assert.ok(view.warnings.every((warning) => !warning.includes('没有匹配')))
  const selection = resolveModelSelection({ model: 'Qwen3.8-Flash' }, view)
  assert.equal(selection.selection.model, 'qfmodel')
})

test('clearing onlyProvider/onlyNames exposes the full host catalog', () => {
  const filtered = normalizeModelConfig({
    models: { allowed: [], onlyProvider: 'qoder', onlyNames: ['DeepSeek-V4-Pro'] },
  }, { catalog })
  assert.equal(filtered.mode, 'filtered')
  assert.equal(filtered.models.length, 1)
  assert.equal(filtered.catalogTotal, 3)

  const cleared = normalizeModelConfig({
    models: { allowed: [], onlyProvider: '', onlyNames: [] },
  }, { catalog })
  assert.equal(cleared.mode, 'all')
  assert.equal(cleared.filtered, false)
  assert.equal(cleared.models.length, 3)
  assert.equal(cleared.catalogTotal, 3)
})

test('onlyNames tolerates vendor version insertions and hyphen differences', () => {
  const qoder = {
    groups: [{
      id: 'qoder',
      name: 'Qoder',
      models: [
        { id: 'dfmodel', name: 'DeepSeek-V4.1-Flash' },
        { id: 'qwen38', name: 'Qwen3.8-Flash' },
        { id: 'glm53', name: 'GLM-5.3-Flash' },
      ],
    }],
    failures: [],
  }
  const view = normalizeModelConfig({
    models: {
      allowed: [],
      onlyProvider: 'qoder',
      onlyNames: ['DeepSeek-Flash', 'Qwen-3.8-flash', 'GLM-5.3-Flash'],
    },
  }, { catalog: qoder })
  assert.equal(view.mode, 'filtered')
  assert.deepEqual(view.models.map((entry) => entry.model), ['dfmodel', 'qwen38', 'glm53'])
  assert.equal(view.defaultId, 'qoder/dfmodel')
  assert.ok(view.warnings.every((warning) => !warning.includes('没有匹配')))
})

test('name filter falls back to the matching default and warns when nothing matches', () => {
  const view = normalizeModelConfig({
    models: { allowed: [], onlyProvider: 'deepseek', onlyNames: ['DeepSeek V4'] },
  }, { catalog })
  assert.equal(view.mode, 'filtered')
  assert.deepEqual(view.models.map((entry) => entry.model), ['deepseek-v4-pro'])
  assert.equal(view.defaultId, 'deepseek/deepseek-v4-pro')

  const empty = normalizeModelConfig({
    models: { allowed: [], onlyProvider: 'qoder', onlyNames: ['Kimi-K3'] },
  }, { catalog })
  assert.equal(empty.models.length, 0)
  assert.equal(empty.defaultId, undefined)
  assert.ok(empty.warnings.some((warning) => warning.includes('没有匹配')))
})

test('saved default set becomes the callable set instead of all catalog models', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [],
      defaults: [
        { provider: 'qoder', model: 'dfmodel', id: 'pro', label: 'Pro' },
        { provider: 'qoder', model: 'qfmodel' },
      ],
    },
  }, { catalog })
  assert.equal(view.mode, 'defaults')
  assert.deepEqual(view.models.map((entry) => entry.model), ['dfmodel', 'qfmodel'])
  assert.equal(view.models.length, 2, 'must not fall back to all 3 catalog models')
  assert.equal(view.defaultId, 'pro')
  assert.ok(view.models.every((entry) => entry.configured === false))
  const payload = modelViewPayload(view)
  assert.equal(payload.mode, 'defaults')
  assert.equal(payload.defaults.length, 2)
})

test('default set silently skips models missing from the catalog or source filter', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [],
      defaults: [
        { provider: 'qoder', model: 'dfmodel' },
        { provider: 'qoder', model: 'removed-model' },
        { provider: 'deepseek', model: 'deepseek-v4-pro' },
      ],
      onlyProvider: 'qoder',
    },
  }, { catalog })
  assert.equal(view.mode, 'defaults')
  assert.deepEqual(view.models.map((entry) => entry.model), ['dfmodel'])
  assert.equal(view.warnings.length, 0, 'a removed default entry must not surface an error')
  assert.equal(view.defaults.length, 3, 'the saved set is kept even when some entries are unavailable')
})

test('a default set whose entries all vanished stays empty instead of selecting everything', () => {
  const view = normalizeModelConfig({
    models: { allowed: [], defaults: [{ provider: 'qoder', model: 'removed-model' }] },
  }, { catalog })
  assert.equal(view.mode, 'defaults')
  assert.equal(view.models.length, 0)
  assert.equal(view.defaultId, undefined)
  assert.equal(view.warnings.length, 0)
})

test('an explicit allowlist still wins over the saved default set', () => {
  const view = normalizeModelConfig({
    models: {
      allowed: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
      defaults: [{ provider: 'qoder', model: 'dfmodel' }],
    },
  }, { catalog })
  assert.equal(view.mode, 'allowlist')
  assert.deepEqual(view.models.map((entry) => entry.model), ['deepseek-v4-pro'])
  assert.equal(view.defaults.length, 1)
})
