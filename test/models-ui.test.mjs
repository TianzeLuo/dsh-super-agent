/**
 * models-ui.test.mjs — 宿主目录不可用时，模型面板仍展示已保存的模型。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientBundle } from './client-bundle.mjs'

const { __internals: internals } = loadClientBundle()

test('model panel falls back to saved models when the host catalog is unavailable', () => {
  const data = {
    mode: 'defaults',
    catalogTotal: 0,
    catalog: { groups: [] },
    defaultId: 'demo/alpha',
    models: [
      { id: 'demo/alpha', provider: 'demo', providerName: 'Demo', model: 'alpha', modelName: 'Demo-Alpha', label: 'Demo-Alpha', efforts: [], configured: false, available: undefined },
      { id: 'demo/beta', provider: 'demo', providerName: 'Demo', model: 'beta', modelName: 'Demo-Beta', label: 'Demo-Beta', efforts: [], configured: false, available: undefined },
    ],
  }
  const entries = internals.catalogEntries(data)
  assert.equal(entries.length, 2)
  const draft = internals.initialModelDraft(data)
  assert.equal(draft.checked['demo/alpha'].on, true)
  assert.equal(draft.checked['demo/beta'].on, true)
  assert.equal(draft.defaultId, 'demo/alpha')
})
