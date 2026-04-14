/**
 * Inventory builder — produces a compact summary of what's installed
 * and active in this Home Assistant. Used to (a) show the user what
 * the assistant can see, (b) feed the LLM enough context to make
 * grounded suggestions, and (c) match capability templates.
 */

import type { HAClient } from '../ha-client.js'
import type { InventorySummary } from './types.js'

const NON_AUTOMATION_DOMAINS = new Set([
  'sensor',
  'binary_sensor',
  'switch',
  'light',
  'media_player',
  'camera',
  'climate',
  'cover',
  'fan',
  'lock',
  'person',
  'device_tracker',
  'sun',
  'weather',
  'input_boolean',
  'input_number',
  'input_select',
  'input_text',
  'input_datetime',
  'group',
  'zone',
])

export async function buildInventory(ha: HAClient): Promise<InventorySummary> {
  const states = await ha.getStates()

  // Per-domain breakdown
  const byDomain = new Map<string, { count: number; examples: string[] }>()
  for (const s of states) {
    const [domain] = s.entity_id.split('.')
    const slot = byDomain.get(domain) ?? { count: 0, examples: [] }
    slot.count++
    if (slot.examples.length < 5) slot.examples.push(s.entity_id)
    byDomain.set(domain, slot)
  }

  const domains = [...byDomain.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([domain, info]) => ({ domain, count: info.count, examples: info.examples }))

  // Automations are entities under the automation.* domain
  const automations = states
    .filter((s) => s.entity_id.startsWith('automation.'))
    .map((s) => ({
      entityId: s.entity_id,
      name: (s.attributes.friendly_name as string) ?? s.entity_id,
      lastTriggered: s.attributes.last_triggered as string | undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Areas — peek at any entity's `area_id` attribute as a cheap aggregator
  const areaSet = new Set<string>()
  for (const s of states) {
    const area = s.attributes.area_id as string | undefined
    if (area) areaSet.add(area)
  }

  const totalEntities = states.length

  // Lightweight, deterministic highlights — we don't need an LLM call
  // for the basic ones; the chat agent can layer LLM commentary on top.
  const highlights: string[] = []
  const has = (kw: RegExp) =>
    states.some((s) => kw.test(s.entity_id) || kw.test((s.attributes.friendly_name as string) ?? ''))

  if (has(/inverter|solar|pv|panel/i)) highlights.push('Solar / inverter sensors detected')
  if (has(/battery.*power|battery_soc|home[_ ]battery|inverter[_ ]battery/i))
    highlights.push('Home battery storage detected')
  if (has(/tesla|model[_ ]?[sy3x]|wall[_ ]connector/i)) highlights.push('Tesla / EV charging detected')
  if (has(/lock\./)) highlights.push('Smart locks detected')
  if (has(/alarm/i)) highlights.push('Alarm panel or alarm-related entities detected')
  if (has(/water|irrigation|sprinkler|valve/i)) highlights.push('Water / irrigation entities detected')
  if (has(/camera\.|doorbell/i)) highlights.push('Cameras / doorbell detected')
  if (automations.length > 0) highlights.push(`${automations.length} existing HA automations`)
  if (NON_AUTOMATION_DOMAINS.has('light') && (byDomain.get('light')?.count ?? 0) > 0) {
    highlights.push(`${byDomain.get('light')?.count} smart lights`)
  }

  return {
    totalEntities,
    domains,
    automations,
    areas: [...areaSet].sort(),
    highlights,
  }
}
