/**
 * protocol.js — 插件与外部世界共享的稳定字符串。
 *
 * 频道桥、CLI、测试和 HTTP 客户端都从这里取常量，避免路径/字段各写一份。
 */

/** inbox 中一条外部事件的协议版本。 */
export const EVENT_VERSION = 1

/** HTTP 端点；都以 `/api` 开头，因此受宿主浏览器鉴权围栏保护。 */
export const HTTP_PATHS = Object.freeze({
  ingest: '/api/super-agent/ingest',
  status: '/api/super-agent/status',
  outbox: '/api/super-agent/outbox',
  uiEnsure: '/api/super-agent/ui/ensure',
  uiState: '/api/super-agent/ui/state',
  uiFocus: '/api/super-agent/ui/focus',
  uiReset: '/api/super-agent/ui/reset',
})

/** 内部来源名。 */
export const SOURCES = Object.freeze({
  worker: 'worker',
  watchdog: 'watchdog',
})

/** 任务状态。 */
export const TASK_STATUS = Object.freeze([
  'queued',
  'starting',
  'working',
  'idle',
  'blocked',
  'failed',
  'interrupted',
  'lost',
  'closed',
])

/** 一条外部事件的最小形状（inbox.jsonl / HTTP ingest）。 */
export function eventEnvelope(input) {
  return {
    v: EVENT_VERSION,
    id: input.id,
    source: input.source,
    threadKey: input.threadKey,
    kind: input.kind,
    actor: input.actor,
    title: input.title,
    text: input.text,
    url: input.url,
    mentions: input.mentions,
    direct: input.direct,
    meta: input.meta,
    receivedAt: input.receivedAt,
  }
}
