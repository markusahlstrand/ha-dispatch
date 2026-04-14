/**
 * LLM-powered flow suggestions.
 *
 * Sends a compact summary of the user's HA entity inventory to the LLM
 * and asks it to propose useful automations/flows. Returns a list of
 * suggested flow ideas with the capabilities they'd need and a short
 * description — these aren't executable flows yet, just a recommendation
 * surface for the dashboard.
 */

import type { HAClient, HAState } from '../ha-client.js'
import type { LLMProvider } from '../llm/index.js'

export interface FlowSuggestion {
  id: string
  name: string
  description: string
  /** What entities/capabilities this flow needs (human-readable) */
  needs: string[]
  /** Why this is useful for THIS user */
  rationale: string
  /** Rough estimate of monthly value: savings, convenience, safety, etc. */
  value: string
  /** Rough complexity to implement */
  complexity: 'low' | 'medium' | 'high'
}

/** Compact inventory — domains, counts, and a few example entity names per domain */
function buildInventorySummary(states: HAState[]): string {
  const byDomain = new Map<string, { count: number; examples: string[] }>()
  for (const s of states) {
    const [domain] = s.entity_id.split('.')
    const slot = byDomain.get(domain) ?? { count: 0, examples: [] }
    slot.count++
    if (slot.examples.length < 8) slot.examples.push(s.entity_id)
    byDomain.set(domain, slot)
  }
  const lines: string[] = []
  for (const [domain, info] of [...byDomain.entries()].sort()) {
    lines.push(`${domain} (${info.count}): ${info.examples.join(', ')}${info.count > info.examples.length ? ', ...' : ''}`)
  }
  return lines.join('\n')
}

export async function suggestFlowsLLM(
  ha: HAClient,
  llm: LLMProvider,
): Promise<FlowSuggestion[]> {
  const states = await ha.getStates()
  const inventory = buildInventorySummary(states)

  const system = `You are an expert Home Assistant automation designer. Given a user's entity inventory, propose 3-6 automation ideas that would clearly benefit them. Be specific: reference their actual devices. Prefer ideas that save money, improve comfort, or prevent problems. Skip generic ideas that don't use the user's specific hardware.`

  const prompt = `Here is the user's Home Assistant entity inventory (domain with entity counts and example entity IDs):

${inventory}

Propose 3-6 useful automation flows. For each, include the needs (what devices/integrations it requires, referencing actual entity IDs from the inventory when possible), a one-line description, a rationale for why it's useful, rough monthly value, and complexity.`

  const schema = {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'kebab-case slug' },
            name: { type: 'string' },
            description: { type: 'string' },
            needs: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' },
            value: { type: 'string' },
            complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['id', 'name', 'description', 'needs', 'rationale', 'value', 'complexity'],
        },
      },
    },
    required: ['suggestions'],
  }

  const res = await llm.generateJson<{ suggestions: FlowSuggestion[] }>({
    system,
    prompt,
    schema,
  })
  return res.suggestions ?? []
}
