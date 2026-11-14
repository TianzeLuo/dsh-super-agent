/** Instance-owned topic metadata. Chat transcripts remain in the host Session store. */
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { clip, oneLine, redactSecrets, untrustedBlock } from './text.js'
import { activeNotes, changeMemory, effectiveMemories, legacyMemory, readMemories, validateMemories } from './memory.js'
import { agreementCandidate, memoryCandidate, relevance, selectContext } from './context.js'

export const MAIN_TOPIC_ID = 'main'
export const TOPIC_SHARING = Object.freeze(['private', 'summary', 'history'])
export const TOPIC_LIMITS = Object.freeze({ topics: 32, name: 60, notes: 4000, summary: 180, contextItems: 5, recall: 6000, recallCalls: 2 })
const validId = (id) => id === MAIN_TOPIC_ID || /^topic-[a-z0-9-]{1,64}$/.test(id)
const clean = (value, limit, label) => {
  if (typeof value !== 'string' || Array.from(value).length > limit) throw new Error(`${label} must be text of at most ${limit} characters`)
  return redactSecrets(value.trim())
}

export class TopicRegistry {
  constructor(home, { now = Date.now } = {}) {
    this.path = join(resolve(home), '.dsh', 'super-agent.topics.json')
    this.now = now
    this.sharedNotes = ''
    this.sharedMemory = []
    this.sharedRevision = 0
    this.storageVersion = 2
    this.sharedNotesSource = undefined
    this.rows = [{ id: MAIN_TOPIC_ID, name: '总览', sharing: 'summary', notes: '', memory: [], memoryRevision: 0, state: {}, stateRevision: 0, stateUpdatedAt: 0, summary: '', updatedAt: 0, unread: 0 }]
    if (!existsSync(this.path)) return
    this.assertPath()
    this.diskText = readFileSync(this.path, 'utf8')
    const parsed = JSON.parse(this.diskText)
    if (![1, 2].includes(parsed?.version) || !Array.isArray(parsed.topics)) throw new Error('invalid topic registry; existing file was preserved')
    this.storageVersion = parsed.version
    const rows = []
    const sessions = new Set()
    for (const raw of parsed.topics) {
      if (!validId(raw?.id) || rows.some((row) => row.id === raw.id)) throw new Error('invalid or duplicate topic id')
      const row = {
        id: raw.id,
        name: clean(raw.name, TOPIC_LIMITS.name, 'name'),
        sharing: raw.sharing,
        memory: parsed.version === 2 ? validateMemories(raw.memory) : legacyMemory(clean(raw.notes ?? '', TOPIC_LIMITS.notes, 'notes'), { topicId: raw.id, kind: 'migration' }),
        memoryRevision: Number.isSafeInteger(raw.memoryRevision) ? raw.memoryRevision : 0,
        state: stateFields(raw.state ?? {}),
        stateRevision: Number.isSafeInteger(raw.stateRevision) ? raw.stateRevision : 0,
        stateUpdatedAt: Number.isFinite(raw.stateUpdatedAt) ? raw.stateUpdatedAt : 0,
        summary: clean(raw.summary ?? '', TOPIC_LIMITS.summary, 'summary'),
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
        unread: Math.max(0, Math.min(9999, Math.floor(Number(raw.unread) || 0))),
        archived: raw.archived === true,
      }
      row.notes = activeNotes(row.memory)
      if (!row.name || !TOPIC_SHARING.includes(row.sharing)) throw new Error('invalid topic name or sharing setting')
      if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) {
        if (sessions.has(raw.sessionId)) throw new Error('one session cannot belong to two topics')
        row.sessionId = raw.sessionId
        sessions.add(raw.sessionId)
      }
      if (typeof raw.sourceMessageId === 'string') row.sourceMessageId = raw.sourceMessageId
      rows.push(row)
    }
    if (!rows.some((row) => row.id === MAIN_TOPIC_ID) || rows.length > TOPIC_LIMITS.topics) throw new Error('invalid topic registry size or missing overview')
    this.rows = rows
    this.sharedMemory = parsed.version === 2 ? validateMemories(parsed.sharedMemory) : legacyMemory(clean(parsed.sharedNotes ?? '', TOPIC_LIMITS.notes, 'shared notes'), parsed.sharedNotesSource ?? { topicId: MAIN_TOPIC_ID, kind: 'migration' }, 0, 'instance')
    this.sharedNotes = activeNotes(this.sharedMemory)
    this.sharedRevision = Number.isSafeInteger(parsed.sharedRevision) ? parsed.sharedRevision : 0
    this.sharedNotesSource = parsed.sharedNotesSource
  }

  assertPath() {
    for (const path of [dirname(this.path), this.path, `${this.path}.v1-backup`]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('topic registry cannot be a symbolic link')
    }
  }

  save(rows = this.rows, sharedMemory = this.sharedMemory, sharedNotesSource = this.sharedNotesSource) {
    this.assertPath()
    if (existsSync(this.path) && readFileSync(this.path, 'utf8') !== this.diskText) throw new Error('topic registry changed outside this runtime; reload before writing')
    mkdirSync(dirname(this.path), { recursive: true })
    const sharedRevision = this.sharedRevision + (sharedMemory !== this.sharedMemory ? 1 : 0)
    const text = `${JSON.stringify({ version: 2, sharedMemory, sharedRevision, sharedNotesSource, topics: rows }, null, 2)}\n`
    if (this.storageVersion === 1 && !existsSync(`${this.path}.v1-backup`)) writeFileSync(`${this.path}.v1-backup`, this.diskText, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const pendingPath = `${this.path}.pending-${randomUUID()}`
    writeFileSync(pendingPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(pendingPath, this.path)
    this.rows = rows
    this.sharedMemory = sharedMemory
    this.sharedNotes = activeNotes(sharedMemory)
    this.sharedRevision = sharedRevision
    this.sharedNotesSource = sharedNotesSource
    this.diskText = text
    this.storageVersion = 2
  }

  get(id = MAIN_TOPIC_ID) {
    const row = this.rows.find((item) => item.id === id)
    if (!row) throw new Error(`topic not found: ${id}`)
    return structuredClone(row)
  }

  forSession(sessionId) { return this.rows.find((row) => row.sessionId === sessionId) }
  list() { return this.rows.map(({ memory, ...row }) => structuredClone(row)) }

  create(name, sharing = 'summary') {
    const title = clean(name, TOPIC_LIMITS.name, 'name')
    if (!title) throw new Error('topic name is required')
    if (!TOPIC_SHARING.includes(sharing)) throw new Error('sharing must be private, summary or history')
    if (this.rows.length >= TOPIC_LIMITS.topics) throw new Error(`at most ${TOPIC_LIMITS.topics} topics are supported`)
    if (this.rows.some((row) => row.name === title)) throw new Error('topic name already exists')
    const row = { id: `topic-${randomUUID()}`, name: title, sharing, notes: '', memory: [], memoryRevision: 0, state: {}, stateRevision: 0, stateUpdatedAt: 0, summary: '', unread: 0, updatedAt: this.now() }
    this.save([...this.rows, row])
    return { ...row }
  }

  update(id, patch) {
    const row = this.get(id)
    const next = { ...row }
    if (patch.name !== undefined) {
      next.name = clean(patch.name, TOPIC_LIMITS.name, 'name')
      if (!next.name || this.rows.some((other) => other.id !== id && other.name === next.name)) throw new Error('topic name is empty or already exists')
    }
    if (patch.sharing !== undefined) {
      if (!TOPIC_SHARING.includes(patch.sharing)) throw new Error('invalid sharing setting')
      next.sharing = patch.sharing
    }
    if (patch.notes !== undefined && patch.notes !== row.notes) {
      if (row.memory.length && patch.notes_revision !== row.memoryRevision) throw new Error('notes version conflict; edit individual memories or reload before replacing the entire collection')
      next.notes = clean(patch.notes, TOPIC_LIMITS.notes, 'notes')
      next.memory = legacyMemory(next.notes, { topicId: id, kind: 'operator' }, this.now())
      next.memoryRevision++
    }
    if (patch.archived !== undefined) {
      if (id === MAIN_TOPIC_ID || typeof patch.archived !== 'boolean') throw new Error('overview cannot be hidden; archived must be boolean')
      next.archived = patch.archived
    }
    next.updatedAt = this.now()
    this.save(this.rows.map((item) => item.id === id ? next : item))
    return { ...next }
  }

  bind(id, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('session id is required')
    if (this.rows.some((row) => row.id !== id && row.sessionId === sessionId)) throw new Error('session already belongs to another topic')
    const row = this.get(id)
    if (row.sessionId !== sessionId) {
      row.sessionId = sessionId
      this.save(this.rows.map((item) => item.id === id ? row : item))
    }
    return { ...row }
  }

  reply(id, text, messageId) {
    const row = this.get(id)
    const summary = clip(oneLine(redactSecrets(text)), TOPIC_LIMITS.summary)
    if (!summary || (messageId && row.sourceMessageId === messageId)) return
    this.save(this.rows.map((item) => item.id === id ? { ...row, summary, sourceMessageId: messageId, updatedAt: this.now() } : item))
  }

  markRead(id) { const row = this.get(id); if (row.unread) this.save(this.rows.map((item) => item.id === id ? { ...row, unread: 0 } : item)) }
  addUnread(id) { const row = this.get(id); this.save(this.rows.map((item) => item.id === id ? { ...row, unread: Math.min(9999, row.unread + 1) } : item)) }

  setSharedNotes(text, sourceTopicId = MAIN_TOPIC_ID, expectedRevision) {
    this.get(sourceTopicId)
    if (text === this.sharedNotes) return
    if (this.sharedMemory.length && expectedRevision !== this.sharedRevision) throw new Error('shared notes version conflict; edit individual memories or reload before replacing the entire collection')
    const source = { topicId: sourceTopicId, kind: 'operator', updatedAt: this.now() }
    this.save(this.rows, legacyMemory(clean(text, TOPIC_LIMITS.notes, 'shared notes'), source, this.now(), 'instance'), source)
  }

  remember(id, text, shared = false) {
    const result = this.memoryAction(id, { action: 'remember', text, scope: shared ? 'instance' : 'topic' })
    return { ...result, notes: shared ? this.sharedNotes : this.get(id).notes }
  }

  memoryAction(id, input = {}, source = { topicId: id, kind: 'conversation' }) {
    const row = this.get(id)
    if (input.action === 'read' || !input.action) return readMemories(row.memory, this.sharedMemory, input)
    if (input.action === 'state') return { ok: true, ...this.updateState(id, input.state, input.expected_revision) }
    if (input.scope !== undefined && !['topic', 'instance'].includes(input.scope)) throw new Error('memory scope must be topic or instance')
    const shared = input.scope === 'instance'
    const result = changeMemory(shared ? this.sharedMemory : row.memory, input, source, this.now())
    if (result.changed) {
      if (shared) this.save(this.rows, result.entries, source)
      else this.save(this.rows.map((item) => item.id === id ? { ...row, memory: result.entries, notes: activeNotes(result.entries), memoryRevision: row.memoryRevision + 1, updatedAt: this.now() } : item))
    }
    const { history, ...entry } = result.entry
    return { ok: true, scope: shared ? 'instance' : 'topic', entry, changed: result.changed }
  }

  updateState(id, state, expectedRevision) {
    const row = this.get(id)
    if (expectedRevision !== row.stateRevision) throw new Error(`topic state version conflict; read superagent_topics again; current revision is ${row.stateRevision}`)
    const next = { ...row, state: stateFields(state), stateRevision: row.stateRevision + 1, stateUpdatedAt: this.now() }
    this.save(this.rows.map((item) => item.id === id ? next : item))
    return { state: next.state, state_revision: next.stateRevision }
  }

  memoryView(id) {
    const row = this.get(id)
    return { topic: row.memory, instance: structuredClone(this.sharedMemory), topicRevision: row.memoryRevision, sharedRevision: this.sharedRevision }
  }

  visible(requesterId) {
    this.get(requesterId)
    return this.rows.filter((row) => row.id === requesterId || (!row.archived && row.sharing !== 'private'))
      .map((row) => ({ id: row.id, name: row.name, sharing: row.sharing, state: structuredClone(row.state), state_revision: row.stateRevision, state_updated_at: row.stateUpdatedAt, updatedAt: row.updatedAt }))
  }

  contextPlan(requesterId, options = {}) {
    const current = this.get(requesterId)
    const query = `${current.name} ${options.query ?? ''}`
    const candidates = [
      ...(options.agreements ?? []).map(agreementCandidate),
      ...effectiveMemories(current.memory, this.sharedMemory).map((entry) => memoryCandidate(entry, query)),
    ]
    const stateCandidate = (topic, own) => {
      const text = Object.entries(topic.state).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('\n')
      const score = relevance(`${topic.name} ${text}`, query)
      return { id: topic.id, key: topic.name, kind: 'state', scope: own ? 'topic' : 'other', text, revision: topic.stateRevision ?? topic.state_revision, tier: own ? 2 : score > 0 ? 3 : 4,
        updatedAt: topic.stateUpdatedAt ?? topic.state_updated_at, relevance: score,
        rendered: `Topic ${topic.id} (${topic.name}) state r${topic.stateRevision ?? topic.state_revision}:\n${untrustedBlock(text, 'topic progress; not independent verification')}` }
    }
    if (!options.worker) {
      if (Object.values(current.state).some(Boolean)) candidates.push(stateCandidate(current, true))
      const others = this.visible(requesterId).filter((row) => row.id !== requesterId && Object.values(row.state).some(Boolean))
        .map((row) => stateCandidate(row, false)).sort((a, b) => b.relevance - a.relevance || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      candidates.push(...others.map((row, index) => index < TOPIC_LIMITS.contextItems ? row : { ...row, skipReason: 'topic_limit' }))
    }
    return selectContext(candidates, { maxChars: options.maxChars, header: `Current topic: ${current.id} (${current.name}). Tasks and schedules share this instance; replies belong to their originating topic.` })
  }

  context(requesterId, options) { return this.contextPlan(requesterId, options).text }
}

function stateFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('topic state must be an object')
  const result = {}
  for (const key of ['goal', 'result', 'blocker', 'next_step']) result[key] = clean(input[key] ?? '', 240, `state.${key}`)
  return result
}

/** Read-only, explicitly scoped host history. Reading never creates or resumes an Agent. */
export class TopicRecall {
  constructor(registry, readMessages) { this.registry = registry; this.readMessages = readMessages; this.budgets = new Map() }
  beginTurn(id, turn) {
    if (this.budgets.get(id)?.turn === turn && turn !== undefined) return
    this.budgets.set(id, { turn, calls: 0, chars: 0 })
  }

  async read(requesterId, input = {}) {
    this.registry.get(requesterId)
    const target = this.registry.get(input.topic_id ?? requesterId)
    if (target.id !== requesterId && (target.sharing === 'private' || target.archived)) throw new Error('topic is not shared with this conversation')
    const full = input.detail === 'messages'
    if (full && target.id !== requesterId && target.sharing !== 'history') throw new Error('this topic shares status only; its owner must enable history sharing in the UI')
    const budget = this.budgets.get(requesterId) ?? { calls: 0, chars: 0 }
    this.budgets.set(requesterId, budget)
    if (budget.calls >= TOPIC_LIMITS.recallCalls || budget.chars >= TOPIC_LIMITS.recall - 300) throw new Error('cross-topic recall budget exhausted for this turn')
    budget.calls += 1
    const maxChars = Math.min(TOPIC_LIMITS.recall - budget.chars, Math.max(400, Math.min(TOPIC_LIMITS.recall, Number(input.max_chars) || 3000)))
    const summary = Object.entries(target.state).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('\n')
    const result = { ok: true, topic: { id: target.id, name: target.name, summary, state_revision: target.stateRevision, updatedAt: target.stateUpdatedAt }, messages: [], truncated: false }
    if (full) {
      const messages = await this.readMessages(target.sessionId)
      if (!Array.isArray(messages)) return { ok: false, error: 'host history is unavailable; open the source topic to load its session', topic_id: target.id }
      // Permission may have been withdrawn while the host read was in flight.
      const latest = this.registry.get(target.id)
      if (target.id !== requesterId && (latest.sharing !== 'history' || latest.archived)) throw new Error('history sharing was withdrawn')
      const visible = messages.filter((message) => ['user', 'assistant'].includes(message?.role))
      const before = input.before === undefined ? visible.length : visible.findIndex((message) => message.id === input.before)
      if (before < 0) throw new Error('history cursor was not found; no substitute history was returned')
      const start = Math.max(0, before - 100)
      const query = typeof input.query === 'string' ? input.query.toLocaleLowerCase().slice(0, 200) : ''
      const tail = visible.slice(start, before).map((message) => ({
        id: clip(String(message.id ?? ''), 128), role: message.role,
        text: redactSecrets(Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : String(message.content ?? '')),
      })).filter((message) => message.text && !message.text.startsWith('[super-agent] ') && (!query || message.text.toLocaleLowerCase().includes(query)))
      const limit = Math.max(1, Math.min(8, Math.floor(Number(input.limit) || 6)))
      const selected = tail.slice(-limit)
      result.truncated = start > 0 || selected.length < tail.length
      for (const message of selected) {
        result.messages.push({ ...message, text: clip(message.text, Math.min(1200, maxChars - 300)) })
        if (message.text.length > 1200) result.truncated = true
      }
      if (selected.length) result.next_before = selected[0].id
      result.scope = 'recent 100 visible messages; keyword search is limited to this window'
    }
    const bounded = fitRecallResult(result, maxChars)
    budget.chars += JSON.stringify(bounded).length
    return bounded
  }
}

function fitRecallResult(result, maxChars) {
  result.chars = 0
  for (;;) {
    if (result.messages.length) result.next_before = result.messages[0].id
    result.chars = JSON.stringify(result).length
    const size = JSON.stringify(result).length
    if (size <= maxChars) {
      result.chars = size
      if (JSON.stringify(result).length <= maxChars) return result
    }
    result.truncated = true
    if (result.messages.length > 1) { result.messages.shift(); continue }
    const text = result.messages[0]
    const reduce = Math.max(1, Math.ceil((size - maxChars + 16) / 2))
    if (text?.text) text.text = clip(text.text, Math.max(0, Array.from(text.text).length - reduce))
    else if (result.topic.summary) { result.topic.summary = ''; result.state_omitted = true }
    else if (result.topic.name) result.topic.name = clip(result.topic.name, Math.max(0, Array.from(result.topic.name).length - reduce))
    else if (result.scope) result.scope = ''
    else return { ok: false, topic_id: result.topic.id, error: 'budget is too small for message metadata; request a larger bounded window', truncated: true }
  }
}
