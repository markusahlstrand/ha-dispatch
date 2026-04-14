/**
 * Heuristic entity classification for the energy-optimizer flow.
 *
 * Scans all HA entities and guesses which one plays each role
 * (solar_power, battery_soc, grid_power, ev_battery_level, ev_charger_switch).
 * Phase 3 will add an LLM pass to refine the mapping.
 */

import type { HAClient } from '../../ha-client.js'

export type EnergyRole =
  | 'solar_power'
  | 'battery_soc'
  | 'battery_power'
  | 'grid_power'
  | 'house_load'
  | 'ev_battery_level'
  | 'ev_charger_switch'
  | 'ev_charger_current'

export interface Candidate {
  entityId: string
  role: EnergyRole
  confidence: number
  reason: string
}

interface Pattern {
  role: EnergyRole
  keywords: RegExp
  domain?: string
  deviceClass?: string
  unit?: RegExp
}

const PATTERNS: Pattern[] = [
  { role: 'solar_power', keywords: /\b(pv|solar|panel)\b.*\b(power|now)\b|\b(generation|production)\b/i, domain: 'sensor', deviceClass: 'power', unit: /^W|kW$/i },
  { role: 'battery_soc', keywords: /\b(battery|batt|bms)\b.*\b(soc|state[_ ]?of[_ ]?charge|level|percent)\b/i, domain: 'sensor', unit: /^%$/ },
  { role: 'battery_power', keywords: /\b(battery|bat)\b.*\bpower\b/i, domain: 'sensor', deviceClass: 'power' },
  { role: 'grid_power', keywords: /\b(grid|mains|import|export|meter)\b.*\bpower\b/i, domain: 'sensor', deviceClass: 'power' },
  { role: 'house_load', keywords: /\b(house|home|load|consumption)\b.*\bpower\b/i, domain: 'sensor', deviceClass: 'power' },
  { role: 'ev_battery_level', keywords: /\b(ev|tesla|car|vehicle|model[_ ]?[sy3x])\b.*\b(battery|level|soc)\b/i, domain: 'sensor', unit: /^%$/ },
  { role: 'ev_charger_switch', keywords: /\b(charger|wall[_ ]?connector|charging|tesla)\b/i, domain: 'switch' },
  { role: 'ev_charger_current', keywords: /\b(charging[_ ]?current|charger[_ ]?amp)\b/i, domain: 'sensor' },
]

export async function classifyEntities(ha: HAClient): Promise<Record<EnergyRole, Candidate[]>> {
  const states = await ha.getStates()
  const result: Partial<Record<EnergyRole, Candidate[]>> = {}

  for (const pattern of PATTERNS) {
    result[pattern.role] = []
  }

  for (const state of states) {
    const id = state.entity_id
    const [domain] = id.split('.')
    const attrs = state.attributes ?? {}
    const friendlyName = (attrs.friendly_name as string) ?? ''
    const deviceClass = attrs.device_class as string | undefined
    const unit = attrs.unit_of_measurement as string | undefined
    const haystack = `${id} ${friendlyName}`

    for (const p of PATTERNS) {
      if (p.domain && p.domain !== domain) continue

      let score = 0
      const reasons: string[] = []

      if (p.keywords.test(haystack)) {
        score += 0.5
        reasons.push('name-match')
      }
      if (p.deviceClass && deviceClass === p.deviceClass) {
        score += 0.3
        reasons.push(`device_class=${deviceClass}`)
      }
      if (p.unit && unit && p.unit.test(unit)) {
        score += 0.2
        reasons.push(`unit=${unit}`)
      }

      if (score >= 0.4) {
        result[p.role]!.push({
          entityId: id,
          role: p.role,
          confidence: Math.min(score, 1),
          reason: reasons.join(', '),
        })
      }
    }
  }

  // Sort each role's candidates by confidence descending
  for (const role in result) {
    result[role as EnergyRole]!.sort((a, b) => b.confidence - a.confidence)
  }

  return result as Record<EnergyRole, Candidate[]>
}
