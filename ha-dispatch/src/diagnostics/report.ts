/**
 * Diagnostic report bundler.
 *
 * Produces a single JSON payload the user can download (and paste back
 * to whoever is helping them) that contains:
 *
 *   - Add-on version + runtime info (no secrets)
 *   - The recorded event buffer
 *   - A redacted persona snapshot (no API keys)
 *   - A summary of the HA inventory (counts only, no entity ids)
 *   - Recent flow runs
 *   - Any user-submitted notes
 *
 * This is read-only and intentionally human-friendly — the goal is
 * something you can skim, not a full state dump.
 */

import type { AppStore } from '../store.js'
import type { HAClient } from '../ha-client.js'
import type { RecordedEvent, Recorder } from './recorder.js'
import { getPersona } from '../chat/persona.js'
import { buildInventory } from '../chat/inventory.js'

export interface DiagnosticReport {
  generatedAt: string
  addon: { version: string; node: string }
  persona: {
    onboarded: boolean
    interests?: string[]
    proactiveness?: string
    notesCount: number
  }
  inventory: {
    totalEntities: number
    automationCount: number
    topDomains: { domain: string; count: number }[]
    highlights: string[]
  } | { error: string }
  recentFlowRuns: {
    flowId: string
    status: string
    summary: string
    startedAt: string
    durationMs: number
  }[]
  events: RecordedEvent[]
}

export async function buildReport(deps: {
  store: AppStore
  ha: HAClient
  recorder: Recorder
  version: string
}): Promise<DiagnosticReport> {
  const persona = await getPersona(deps.store)
  let inventoryBlock: DiagnosticReport['inventory']
  try {
    const inv = await buildInventory(deps.ha)
    inventoryBlock = {
      totalEntities: inv.totalEntities,
      automationCount: inv.automations.length,
      topDomains: inv.domains.slice(0, 12).map((d) => ({ domain: d.domain, count: d.count })),
      highlights: inv.highlights,
    }
  } catch (e) {
    inventoryBlock = { error: (e as Error).message }
  }

  const recentFlowRuns = (await deps.store.getFlowRuns(undefined, 20)).map((r) => ({
    flowId: r.flowId,
    status: r.status,
    summary: r.summary,
    startedAt: new Date(r.startedAt).toISOString(),
    durationMs: r.finishedAt - r.startedAt,
  }))

  return {
    generatedAt: new Date().toISOString(),
    addon: { version: deps.version, node: process.version },
    persona: {
      onboarded: Boolean(persona?.onboardedAt),
      interests: persona?.interests,
      proactiveness: persona?.proactiveness,
      notesCount: persona?.notes?.length ?? 0,
    },
    inventory: inventoryBlock,
    recentFlowRuns,
    events: await deps.recorder.list(),
  }
}
