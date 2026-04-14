/**
 * Diagnostics recorder.
 *
 * Captures interesting events to a rotating buffer in KV so the user
 * (or you) can later download a report and pipe it back to whoever is
 * iterating on Dispatch. The goal is to make every "this got stuck"
 * moment debuggable without needing console access to the add-on.
 *
 * Privacy: events redact obvious secrets (API keys, tokens). The
 * downloadable report is meant for the user to read and share — not
 * an automatic upload anywhere.
 */

import type { AppStore } from '../store.js'

export type DiagnosticEvent =
  | { type: 'llm_call'; provider: string; model?: string; promptChars: number; durationMs: number; ok: boolean; error?: string; tag?: string }
  | { type: 'inventory'; entityCount: number; durationMs: number; ok: boolean; error?: string }
  | { type: 'discovery'; source: 'llm' | 'heuristics'; rolesFound: number; durationMs: number; ok: boolean; error?: string }
  | { type: 'flow_run'; flowId: string; trigger: string; status: string; durationMs: number; summary: string }
  | { type: 'ha_call'; method: string; path: string; status: number; durationMs: number; error?: string }
  | { type: 'user_correction'; what: string; before?: unknown; after?: unknown }
  | { type: 'user_note'; text: string }
  | { type: 'error'; where: string; message: string; stack?: string }

export interface RecordedEvent {
  id: string
  at: number
  event: DiagnosticEvent
}

export interface Recorder {
  record(event: DiagnosticEvent): void
  list(limit?: number): Promise<RecordedEvent[]>
  clear(): Promise<void>
}

const KEY = 'diagnostics:events'
const MAX_EVENTS = 250

export function createRecorder(store: AppStore): Recorder {
  // Buffer in memory and flush after a short debounce to avoid hammering
  // the KV store on bursty events (e.g. 50 LLM call records in a row).
  let pending: RecordedEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  async function flush(): Promise<void> {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    flushTimer = null
    try {
      const existing = (await store.kvGet<RecordedEvent[]>(KEY)) ?? []
      const combined = existing.concat(batch).slice(-MAX_EVENTS)
      await store.kvSet(KEY, combined)
    } catch (e) {
      // Swallow — diagnostics must never break the app
      console.warn('[diagnostics] flush failed:', (e as Error).message)
    }
  }

  return {
    record(event: DiagnosticEvent): void {
      pending.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        event: redact(event),
      })
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          void flush()
        }, 500)
      }
    },
    async list(limit = 250) {
      // Make sure pending items are visible to the report
      await flush()
      const events = (await store.kvGet<RecordedEvent[]>(KEY)) ?? []
      return events.slice(-limit)
    },
    async clear() {
      pending = []
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await store.kvSet(KEY, [])
    },
  }
}

/** Strip obvious secrets from any event payload before persisting. */
function redact(event: DiagnosticEvent): DiagnosticEvent {
  return JSON.parse(
    JSON.stringify(event, (_key, value) => {
      if (typeof value === 'string') {
        // API keys / tokens — replace any 24+ char alnum-with-hyphens blob
        if (/^[A-Za-z0-9_\-]{24,}$/.test(value)) return '[redacted]'
      }
      return value
    }),
  ) as DiagnosticEvent
}
