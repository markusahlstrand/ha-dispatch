/**
 * Heuristic entity classification for the energy-optimizer flow.
 *
 * Scans all HA entities, scores candidates against per-role patterns, and
 * returns the top few per role so the setup wizard can show alternatives.
 *
 * Lessons from Markus's setup (Deye + Tesla via Solarman + PVPC):
 *  - "battery" matches phone batteries too — require an inverter/energy
 *    context word (or negative-match personal-device names) for battery_soc.
 *  - L1/L2/L3 phase sensors exist alongside totals — prefer the total.
 *  - Tesla charger switch is `switch.model_y_charge` not
 *    `switch.inverter_battery_generator_charging` — require a Tesla/model
 *    context near the "charge" hit and exclude inverter/battery-generator.
 *  - Charger current is on the `number` domain, not `sensor`.
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
  | 'ev_charge_cable'

export interface Candidate {
  entityId: string
  role: EnergyRole
  confidence: number
  reason: string
}

interface Pattern {
  role: EnergyRole
  /** Strong positive keyword — adds 0.5 if matched */
  keywords: RegExp
  /** Any of these must appear somewhere in the haystack — required gate (drops match if absent) */
  mustContain?: RegExp
  /** If matched, the candidate is rejected outright */
  reject?: RegExp
  /** Allowed domains (sensor/switch/number/binary_sensor). Any match is OK. */
  domains?: string[]
  deviceClass?: string
  unit?: RegExp
  /** Penalty if id contains _l1_/_l2_/_l3_ (we prefer the total over per-phase) */
  penalizePhase?: boolean
}

const EV_CONTEXT = /\b(ev|tesla|car|vehicle|model[_ ]?[sy3x]|wall[_ ]?connector)\b/i

const PATTERNS: Pattern[] = [
  {
    role: 'solar_power',
    keywords: /\b(pv|solar|panel|photovoltaic)\b.*\b(power|now)\b|\b(pv[_ ]?power|solar[_ ]?power|generation|production)\b/i,
    domains: ['sensor'],
    deviceClass: 'power',
    unit: /^(W|kW)$/i,
    // Exclude energy counters (kWh) unless they have explicit _power suffix
    reject: /\bforecast\b|\bdaily\b|\btotal\b|kwh$/i,
  },
  {
    role: 'battery_soc',
    // Require inverter/home/house/residential context OR explicit "home battery"
    keywords: /\b(inverter|home|house|residential)[_ \-]*battery|battery[_ \-]*(soc|state[_ ]?of[_ ]?charge)|storage[_ \-]*soc/i,
    // Hard gate: must mention inverter/home or be a dedicated SoC sensor
    mustContain: /\b(inverter|home|house|residential|bms|storage)\b|\bsoc\b/i,
    // Reject personal-device batteries
    reject: /\b(iphone|ipad|android|phone|watch|airpods|laptop|macbook|mouse|keyboard|headphone|earbud|remote|door[_ ]?lock|sensor[_ ]?battery|zigbee|z[-_ ]?wave|hue)\b/i,
    domains: ['sensor'],
    unit: /^%$/,
  },
  {
    role: 'battery_power',
    keywords: /\b(inverter|home|house)[_ \-]*battery[_ \-]*power|battery[_ \-]*(charge|discharge)[_ \-]*power/i,
    reject: /\b(iphone|phone|laptop|ev|tesla|model[_ ]?[sy3x])\b/i,
    domains: ['sensor'],
    deviceClass: 'power',
    penalizePhase: true,
  },
  {
    role: 'grid_power',
    keywords: /\b(grid|mains|import|export|meter|utility)[_ \-]*power|\b(grid|mains)\b/i,
    mustContain: /\b(grid|mains|import|export|utility|meter)\b/i,
    domains: ['sensor'],
    deviceClass: 'power',
    penalizePhase: true,
  },
  {
    role: 'house_load',
    // Prefer "load" over "consumption" since your inverter uses load_power.
    // Require the result to NOT look like an EV/Tesla/solar sensor.
    keywords: /\b(house|home|load|consumption|total[_ ]?load)\b.*\bpower\b|\binverter[_ ]*load/i,
    reject: EV_CONTEXT.source ? new RegExp(`(${EV_CONTEXT.source})|\\b(pv|solar|battery)\\b`, 'i') : /xxx/,
    domains: ['sensor'],
    deviceClass: 'power',
    penalizePhase: true,
  },
  {
    role: 'ev_battery_level',
    keywords: /\b(ev|tesla|car|vehicle|model[_ ]?[sy3x])\b.*\b(battery|level|soc)\b/i,
    mustContain: EV_CONTEXT,
    reject: /\b(iphone|phone|ipad|android|watch)\b/i,
    domains: ['sensor'],
    unit: /^%$/,
  },
  {
    role: 'ev_charger_switch',
    // Must be both a "charge/charger" word AND an EV context.
    keywords: /\b(charg(e|er|ing))\b/i,
    mustContain: EV_CONTEXT,
    // Reject home-battery-related switches that happen to contain "charging"
    reject: /\b(inverter|home[_ \-]?battery|battery[_ \-]?generator|solar|grid|export)\b/i,
    domains: ['switch'],
  },
  {
    role: 'ev_charger_current',
    // Amperage control for the EV charger — usually on number.* domain
    keywords: /\b(charge|charging|charger)[_ \-]?(current|amp|ampere)/i,
    mustContain: EV_CONTEXT,
    domains: ['number', 'sensor'],
  },
  {
    role: 'ev_charge_cable',
    keywords: /\b(charge|charging)[_ \-]?(cable|plug|connector|connected)/i,
    mustContain: EV_CONTEXT,
    domains: ['binary_sensor'],
  },
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
      if (p.domains && !p.domains.includes(domain)) continue
      if (p.reject && p.reject.test(haystack)) continue
      if (p.mustContain && !p.mustContain.test(haystack)) continue

      let score = 0
      const reasons: string[] = []

      if (p.keywords.test(haystack)) {
        score += 0.5
        reasons.push('name')
      }
      if (p.deviceClass && deviceClass === p.deviceClass) {
        score += 0.2
        reasons.push(`class=${deviceClass}`)
      }
      if (p.unit && unit && p.unit.test(unit)) {
        score += 0.2
        reasons.push(`unit=${unit}`)
      }
      if (p.mustContain) {
        score += 0.1 // bonus for passing the gate
      }
      if (p.penalizePhase && /_l[123](_|$)/i.test(id)) {
        score -= 0.15
        reasons.push('phase-penalty')
      }

      if (score >= 0.45) {
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
