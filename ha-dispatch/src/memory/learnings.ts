/**
 * Shared learnings memory.
 *
 * Every LLM call that touches Home Assistant — chat, entity discovery,
 * flow suggestions, future adapters — should pull from and write to the
 * same learnings store. This is how the assistant gets smarter about a
 * specific installation without relearning it every turn.
 *
 * What belongs here:
 *  - entity aliases ("office blinds" → cover.shellyplus2pm_d48afc76...)
 *  - entity quirks ("cover.office_right_blinds reports 'unknown' — use the
 *    shellyplus entity directly")
 *  - user preferences ("Markus likes blinds at 50% when closing")
 *  - successful patterns ("set_cover_position works via the direct Shelly
 *    entity; open_cover on the template entity does not")
 *  - anything else the assistant figures out that would help future turns
 *
 * What doesn't belong here:
 *  - one-off facts that don't generalize
 *  - secrets, tokens, API keys (these are separately redacted in
 *    diagnostics/recorder — but the LLM shouldn't be putting them here)
 *  - very long transcripts (we cap at ~200 entries)
 */

import type { AppStore } from '../store.js'

export type LearningCategory =
  | 'entity_alias'       // "office blinds" → cover.xxx
  | 'entity_quirk'       // "template entity reports unknown"
  | 'user_preference'    // "prefers 50% when closing"
  | 'pattern'            // "use set_cover_position not open_cover for shellyplus"
  | 'note'               // everything else

export interface Learning {
  id: string
  createdAt: number
  updatedAt: number
  category: LearningCategory
  text: string
  /** Entities this learning references (so we can surface it when those entities come up). */
  entityIds?: string[]
  /** Optional source — tool name, flow id, chat turn, etc. */
  source?: string
}

const KEY = 'memory:learnings'
const MAX_LEARNINGS = 200

export interface LearningsStore {
  list(): Promise<Learning[]>
  add(input: Omit<Learning, 'id' | 'createdAt' | 'updatedAt'>): Promise<Learning>
  update(id: string, patch: Partial<Omit<Learning, 'id' | 'createdAt'>>): Promise<Learning | null>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export function createLearningsStore(store: AppStore): LearningsStore {
  return {
    async list() {
      return (await store.kvGet<Learning[]>(KEY)) ?? []
    },
    async add(input) {
      const all = (await store.kvGet<Learning[]>(KEY)) ?? []
      const now = Date.now()
      // Deduplicate: if an identical text already exists, just bump timestamp
      const existing = all.find(
        (l) => l.category === input.category && l.text.trim() === input.text.trim(),
      )
      if (existing) {
        existing.updatedAt = now
        await store.kvSet(KEY, all)
        return existing
      }
      const learning: Learning = {
        id: `l-${now}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        updatedAt: now,
        ...input,
      }
      const next = [...all, learning].slice(-MAX_LEARNINGS)
      await store.kvSet(KEY, next)
      return learning
    },
    async update(id, patch) {
      const all = (await store.kvGet<Learning[]>(KEY)) ?? []
      const idx = all.findIndex((l) => l.id === id)
      if (idx < 0) return null
      all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() }
      await store.kvSet(KEY, all)
      return all[idx]
    },
    async remove(id) {
      const all = (await store.kvGet<Learning[]>(KEY)) ?? []
      await store.kvSet(KEY, all.filter((l) => l.id !== id))
    },
    async clear() {
      await store.kvSet(KEY, [])
    },
  }
}
