import { randomUUID } from 'node:crypto'
import { catalogIndex } from './models.js'

export function normalizeMemoryModel(value) {
  if (value === null) return null
  const provider = typeof value?.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value?.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) throw new Error('Select a memory model with a provider and model, or follow the Worker default')
  const effort = value.reasoningEffort
  if (effort !== undefined && (typeof effort !== 'string' || !effort.trim())) throw new Error('Memory model reasoning effort must be a non-empty string when provided')
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort.trim() }) }
}

/** Resolve an explicit choice against the host catalog, independently of Worker routing. */
export function resolveMemoryModel(choice, catalog) {
  const route = `${choice.provider}/${choice.model}`
  const entry = catalogIndex(catalog).get(`${choice.provider}\u0000${choice.model}`)
  if (!entry) throw new Error(`Memory model ${route} is unavailable in DSH. Select another model or follow the Worker default.`)
  if (choice.reasoningEffort && !entry.efforts.some(({ id }) => id === choice.reasoningEffort)) {
    throw new Error(`Memory model ${route} does not support the ${choice.reasoningEffort} reasoning effort`)
  }
  const reasoningEffort = choice.reasoningEffort ?? entry.defaultEffort
  return { provider: choice.provider, model: choice.model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/** A tool-free call through the host's configured model router. No new Session or credentials. */
export async function completeMemoryText(llm, selection, { system, input, signal, maxTokens = 12_000 }) {
  if (typeof llm?.stream !== 'function') throw new Error('This host does not expose memory model calls; manual memory editing remains available')
  if (!selection?.provider || !selection?.model) throw new Error('Select an available Worker model before organizing memory')
  const config = { ...selection, maxTokens }
  const prepared = typeof llm.prepareCall === 'function' ? await llm.prepareCall(config, signal) : undefined
  const options = {
    ...(prepared?.config ?? config), system, tools: [], signal,
    messages: [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: input }] }],
  }
  const stream = prepared ? prepared.stream(options) : llm.stream(options)
  let text = '', finish
  for await (const chunk of stream) {
    signal?.throwIfAborted()
    if (chunk.type === 'text-delta') {
      text += chunk.text ?? ''
      if (text.length > 64_000) throw new Error('Memory model output exceeds the structured result budget')
    }
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') throw new Error('Memory organization cannot call tools')
    if (chunk.type === 'finish') finish = chunk.reason
  }
  // llm.stream reports `stop`; Agent turn outcomes use `completed` on some hosts.
  if (!['stop', 'completed'].includes(finish?.kind)) throw new Error(finish?.failure?.message ?? `Memory model did not complete (${finish?.kind ?? 'no terminal outcome'})`)
  if (!text.trim()) throw new Error('Memory model returned no text')
  return { text, provider: selection.provider, model: selection.model }
}
