import { randomUUID } from 'node:crypto'

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
