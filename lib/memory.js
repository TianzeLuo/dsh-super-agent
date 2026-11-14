import { createHash, randomUUID } from 'node:crypto'
import { redactSecrets } from './text.js'

export const MEMORY_LIMITS = Object.freeze({ entries: 128, key: 64, text: 1200, legacyText: 4000, history: 5, readChars: 8000 })
const copy = (value) => structuredClone(value)
const keyOf = (value) => value.normalize('NFKC').trim().toLocaleLowerCase()

function textField(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > limit) throw new Error(`${label} must contain 1-${limit} characters; summarize a complete fact instead of truncating it`)
  return redactSecrets(value.trim())
}

export function legacyMemory(text, source, now = 0, scope = 'topic') {
  if (!text?.trim()) return []
  const value = textField(text, MEMORY_LIMITS.legacyText, 'legacy notes')
  const id = `mem_legacy-${createHash('sha256').update(`${scope}:${source?.topicId ?? 'instance'}:${value}`).digest('hex').slice(0, 20)}`
  return [{ id, key: 'legacy-notes', text: value, priority: 'normal', status: 'active', revision: 1, createdAt: now, updatedAt: now, source, legacy: true, history: [] }]
}

export function validateMemories(value) {
  if (!Array.isArray(value) || value.filter((entry) => entry?.status === 'active').length > MEMORY_LIMITS.entries) throw new Error('invalid memory collection')
  const ids = new Set()
  const keys = new Set()
  return value.map((raw) => {
    if (!/^mem_[a-z0-9-]+$/.test(raw?.id) || ids.has(raw.id)) throw new Error('invalid or duplicate memory id')
    const key = textField(raw.key, MEMORY_LIMITS.key, 'memory key')
    if (keys.has(keyOf(key))) throw new Error('duplicate memory key')
    ids.add(raw.id)
    keys.add(keyOf(key))
    if (!['normal', 'important'].includes(raw.priority) || !['active', 'archived'].includes(raw.status) || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('invalid memory status or revision')
    if (!Array.isArray(raw.history) || raw.history.length > MEMORY_LIMITS.history) throw new Error('invalid memory history')
    return { ...copy(raw), key, text: textField(raw.text, raw.legacy ? MEMORY_LIMITS.legacyText : MEMORY_LIMITS.text, 'memory text') }
  })
}

export const activeNotes = (entries) => entries.filter((entry) => entry.status === 'active').map((entry) => entry.text).join('\n')

/** A scoped upsert. Different writers must acknowledge the version they read. */
export function changeMemory(entries, input, source, now = Date.now()) {
  const action = input.action === 'remember' ? 'save' : input.action
  if (!['save', 'archive', 'restore'].includes(action)) throw new Error('memory action must be save, archive or restore')
  let key = typeof input.key === 'string' ? textField(input.key, MEMORY_LIMITS.key, 'memory key') : undefined
  let existing = input.id ? entries.find((entry) => entry.id === input.id) : key ? entries.find((entry) => keyOf(entry.key) === keyOf(key)) : undefined
  if (input.id && !existing) throw new Error('memory id was not found in this scope')
  // Compatibility for the old append tool. New callers supply a stable key.
  if (input.action === 'remember' && !input.id && !key) {
    const text = textField(input.text, MEMORY_LIMITS.text, 'memory text')
    existing = entries.find((entry) => entry.status === 'active' && entry.text === text)
    if (existing) return { entries, entry: copy(existing), changed: false }
    key = `note-${randomUUID().slice(0, 8)}`
  }
  if (existing) {
    if (input.expected_revision !== existing.revision) throw new Error(`memory version conflict: read ${existing.id} again; current revision is ${existing.revision}`)
    key ??= existing.key
  } else {
    if (input.expected_revision !== undefined && input.expected_revision !== 0) throw new Error('memory version conflict: record no longer exists; read again before creating a fact')
    if (action !== 'save') throw new Error('read the memory before changing its status')
    if (!key) throw new Error('a stable memory key is required, for example release.deadline; reuse that key when the fact changes')
  }
  if (entries.some((entry) => entry.id !== existing?.id && keyOf(entry.key) === keyOf(key))) throw new Error('another memory already uses this key')
  const text = action === 'save' ? textField(input.text, MEMORY_LIMITS.text, 'memory text') : existing.text
  const priority = input.priority ?? existing?.priority ?? 'normal'
  if (!['normal', 'important'].includes(priority)) throw new Error('memory priority must be normal or important')
  const status = action === 'archive' ? 'archived' : 'active'
  if (status === 'active' && existing?.status !== 'active' && entries.filter((entry) => entry.status === 'active').length >= MEMORY_LIMITS.entries) throw new Error(`at most ${MEMORY_LIMITS.entries} active memories per scope; archive obsolete facts or consolidate them explicitly`)
  if (existing && existing.key === key && existing.text === text && existing.priority === priority && existing.status === status) return { entries, entry: copy(existing), changed: false }
  const previous = existing ? { key: existing.key, text: existing.text, priority: existing.priority, status: existing.status, revision: existing.revision, updatedAt: existing.updatedAt, source: existing.source } : undefined
  const entry = {
    id: existing?.id ?? `mem_${randomUUID()}`, key, text, priority, status,
    revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now, source,
    history: previous ? [previous, ...existing.history].slice(0, MEMORY_LIMITS.history) : [],
    ...(action !== 'save' && existing?.legacy ? { legacy: true } : {}),
  }
  return { entries: existing ? entries.map((row) => row.id === existing.id ? entry : row) : [...entries, entry], entry: copy(entry), changed: true }
}

export function effectiveMemories(local, shared) {
  const own = local.filter((entry) => entry.status === 'active')
  const keys = new Set(own.map((entry) => keyOf(entry.key)))
  return [
    ...own.map((entry) => ({ ...entry, scope: 'topic' })),
    ...shared.filter((entry) => entry.status === 'active' && !keys.has(keyOf(entry.key))).map((entry) => ({ ...entry, scope: 'instance' })),
  ]
}

/** Complete records only; omission is explicit and a cursor permits bounded paging. */
export function readMemories(local, shared, input = {}) {
  if (input.scope !== undefined && !['topic', 'instance'].includes(input.scope)) throw new Error('memory scope must be topic or instance')
  const effective = new Set(effectiveMemories(local, shared).map((entry) => entry.id))
  const query = typeof input.query === 'string' ? input.query.toLocaleLowerCase().slice(0, 200) : ''
  const entries = [
    ...(input.scope === 'instance' ? [] : local.map((entry) => ({ ...entry, scope: 'topic' }))),
    ...(input.scope === 'topic' ? [] : shared.map((entry) => ({ ...entry, scope: 'instance' }))),
  ].filter((entry) => (input.include_archived === true || entry.status === 'active') && (input.scope || input.include_archived === true || effective.has(entry.id)) && (!input.id || entry.id === input.id) && (!query || `${entry.key} ${entry.text}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const start = input.after ? entries.findIndex((entry) => entry.id === input.after) + 1 : 0
  if (input.after && start === 0) throw new Error('memory cursor was not found; read again without a cursor')
  const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || 12)))
  const maxChars = Math.max(1000, Math.min(MEMORY_LIMITS.readChars, Math.floor(Number(input.max_chars) || 6000)))
  const result = { ok: true, entries: [], total: entries.length, omitted: entries.length - start, next_after: undefined, chars: 0 }
  for (const entry of entries.slice(start, start + limit)) {
    const { history, ...current } = entry
    const view = { ...current, effective: effective.has(entry.id), ...(input.include_history === true ? { history } : {}) }
    const candidate = { ...result, entries: [...result.entries, view], omitted: entries.length - start - result.entries.length - 1, next_after: entry.id, chars: maxChars }
    if (JSON.stringify(candidate).length > maxChars) {
      if (!result.entries.length) return { ok: false, error: 'complete memory does not fit this read budget; increase max_chars or read without history', id: entry.id, max_chars: maxChars }
      break
    }
    Object.assign(result, candidate)
  }
  if (result.omitted === 0) delete result.next_after
  result.chars = JSON.stringify(result).length
  return result
}
