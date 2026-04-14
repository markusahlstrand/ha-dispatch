/**
 * LLM-based entity classification for the energy-optimizer flow.
 *
 * Sends a filtered entity list to Gemini and asks it to map each energy
 * role (solar_power, battery_soc, ...) to the most likely entity(ies)
 * with reasoning. Uses structured output so the response is parseable.
 *
 * Pre-filter is intentionally generous — we keep anything that looks
 * remotely energy-related (power/energy device_class, W/kW/V/A/%/kWh
 * units, or names with energy/solar/battery/EV/grid/charger words) and
 * let the LLM disambiguate. Obvious non-energy entities (lights,
 * automations, media players) are skipped to save tokens.
 */

import type { HAClient, HAState } from '../../ha-client.js'
import type { LLMProvider } from '../../llm/index.js'
import type { AppStore } from '../../store.js'
import type { EnergyRole, Candidate } from './discover.js'
import { buildHAContext } from '../../memory/prompt.js'

const ROLE_DESCRIPTIONS: Record<EnergyRole, string> = {
  solar_power: 'Current instantaneous solar / PV production power, in W or kW. Prefer the inverter PV sensor over weather-based forecasts or daily totals.',
  battery_soc: 'Current state-of-charge percentage of the HOME battery / inverter battery storage. Must NOT be a phone, watch, laptop, zigbee sensor, or any other non-home-battery device.',
  battery_power: 'Current charge/discharge power of the home battery (positive = charging, negative = discharging, or separate in/out sensors).',
  grid_power: 'Instantaneous power flowing to/from the electric grid (net import/export). Prefer the total over per-phase sensors.',
  house_load: 'Total household power consumption (load), ideally NOT including the EV charger power. Prefer the inverter total load sensor.',
  ev_battery_level: 'EV / car state-of-charge percentage (Tesla, Model Y, etc.). Must be the vehicle battery, not a phone.',
  ev_charger_switch: 'Switch that starts/stops EV charging. For Tesla this is typically switch.model_y_charge or similar — NOT an inverter/home-battery-related switch.',
  ev_charger_current: 'Number entity that controls the EV charging amperage (e.g. number.model_y_charge_current).',
  ev_charge_cable: 'Binary sensor that indicates whether the EV charge cable is plugged in.',
}

export interface LLMCandidate extends Candidate {
  /** Why the LLM picked this entity */
  rationale: string
}

interface LLMResponse {
  mappings: Array<{
    role: EnergyRole
    candidates: Array<{
      entity_id: string
      confidence: number
      rationale: string
    }>
  }>
  /** Freeform notes the LLM wants the user to see about their setup */
  notes?: string
}

/** Keep things that could plausibly be energy-related. Aggressive drops only. */
function prefilterEntities(states: HAState[]): HAState[] {
  return states.filter((s) => {
    const [domain] = s.entity_id.split('.')
    // Drop obvious non-energy domains
    if (
      [
        'automation',
        'scene',
        'script',
        'media_player',
        'light',
        'camera',
        'tts',
        'stt',
        'conversation',
        'input_text',
        'input_datetime',
        'calendar',
        'zone',
        'person',
        'weather',
        'sun',
      ].includes(domain)
    )
      return false

    // For sensors: keep if it has a device_class in the energy family or
    // a suggestive unit. Otherwise drop.
    if (domain === 'sensor') {
      const dc = (s.attributes.device_class as string) ?? ''
      const unit = (s.attributes.unit_of_measurement as string) ?? ''
      const id = s.entity_id.toLowerCase()
      const friendly = ((s.attributes.friendly_name as string) ?? '').toLowerCase()
      const haystack = id + ' ' + friendly
      const energyishDeviceClass = /power|energy|current|voltage|battery/.test(dc)
      const energyishUnit = /^(W|kW|V|A|%|Wh|kWh|MWh|EUR\/kWh)$/i.test(unit)
      const energyishName = /solar|pv|panel|inverter|battery|grid|mains|import|export|load|consumption|ev|tesla|car|vehicle|charger|charging|wall[_ ]?connector/.test(
        haystack,
      )
      if (!energyishDeviceClass && !energyishUnit && !energyishName) return false
    }
    return true
  })
}

function compactState(s: HAState): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    entity_id: s.entity_id,
    state: s.state,
  }
  const attrs = s.attributes ?? {}
  if (attrs.friendly_name) compact.friendly_name = attrs.friendly_name
  if (attrs.device_class) compact.device_class = attrs.device_class
  if (attrs.unit_of_measurement) compact.unit = attrs.unit_of_measurement
  return compact
}

export async function classifyEntitiesLLM(
  ha: HAClient,
  llm: LLMProvider,
  store?: AppStore,
): Promise<{ candidates: Record<EnergyRole, LLMCandidate[]>; notes: string }> {
  const allStates = await ha.getStates()
  const candidates = prefilterEntities(allStates).map(compactState)

  const rolesList = (Object.keys(ROLE_DESCRIPTIONS) as EnergyRole[])
    .map((r) => `- ${r}: ${ROLE_DESCRIPTIONS[r]}`)
    .join('\n')

  const taskInstructions = `You are classifying Home Assistant entities into energy-system roles. You are conservative: if nothing clearly matches a role, return an empty candidates array for that role rather than guessing. Prefer entities whose current state is a real value over entities reporting 'unknown' or 'unavailable' — the latter are usually template/alias entities without feedback.`
  const system = store
    ? await buildHAContext({ store, taskInstructions })
    : taskInstructions

  const prompt = `I have a Home Assistant installation. Below is a list of entities that are plausibly energy-related. Classify which entity best fills each of these roles. Return up to 3 candidates per role ordered by confidence (0-1). If the best match is still poor, include it but set a low confidence. It is OK for some roles to have zero candidates.

Roles:
${rolesList}

Entities (JSON):
${JSON.stringify(candidates, null, 1)}`

  const schema = {
    type: 'object',
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: Object.keys(ROLE_DESCRIPTIONS) },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  entity_id: { type: 'string' },
                  confidence: { type: 'number' },
                  rationale: { type: 'string' },
                },
                required: ['entity_id', 'confidence', 'rationale'],
              },
            },
          },
          required: ['role', 'candidates'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['mappings'],
  }

  const result = await llm.generateJson<LLMResponse>({ system, prompt, schema })

  // Shape into the existing Candidate map
  const out: Partial<Record<EnergyRole, LLMCandidate[]>> = {}
  for (const role of Object.keys(ROLE_DESCRIPTIONS) as EnergyRole[]) {
    out[role] = []
  }
  for (const m of result.mappings ?? []) {
    out[m.role] = (m.candidates ?? []).map((c) => ({
      entityId: c.entity_id,
      role: m.role,
      confidence: c.confidence,
      reason: 'llm',
      rationale: c.rationale,
    }))
  }

  return {
    candidates: out as Record<EnergyRole, LLMCandidate[]>,
    notes: result.notes ?? '',
  }
}
