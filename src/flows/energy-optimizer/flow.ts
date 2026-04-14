/**
 * Energy Optimizer Flow
 *
 * Phase 1: price-aware EV charging. Pulls hourly PVPC prices, finds the
 * cheapest window long enough to charge the EV to its target SoC, and
 * (if user approves) schedules the charger accordingly.
 *
 * Phase 2 adds solar forecast + battery scheduling.
 * Phase 3 adds LLM reasoning for edge cases.
 */

import type { Flow, FlowContext, FlowResult } from '../../runtime/types.js'
import { fetchPVPCPrices } from './pvpc.js'

interface PlanAction {
  kind: 'start_charger' | 'stop_charger' | 'noop'
  at: number // unix ms
  entityId?: string
  reason: string
}

interface Plan {
  actions: PlanAction[]
  reasoning: string
  estimatedSavings: number
}

async function run(ctx: FlowContext): Promise<FlowResult> {
  const { ha, db, step, log } = ctx

  // Check mapping
  const mapping = db.getMapping('energy-optimizer')
  if (mapping.length === 0) {
    return {
      status: 'noop',
      summary: 'Setup required — no entity mapping saved yet',
    }
  }

  const evSoc = db.getMappingByRole('energy-optimizer', 'ev_battery_level')
  const charger = db.getMappingByRole('energy-optimizer', 'ev_charger_switch')

  if (!evSoc || !charger) {
    return {
      status: 'noop',
      summary: 'EV battery level or charger switch not mapped',
    }
  }

  // Fetch prices (memoized per run)
  const prices = await step.run('fetch-prices', async () => {
    log('Fetching PVPC prices')
    return await fetchPVPCPrices()
  })

  if (prices.today.length === 0) {
    return { status: 'error', summary: 'No prices returned from PVPC' }
  }

  // Read EV state
  const evState = await step.run('read-ev-soc', async () => {
    const s = await ha.getState(evSoc.entityId)
    return Number(s?.state ?? 0)
  })

  const targetSoc = Number(ctx.config.ev_target_soc ?? 80)
  const evCapacityKwh = Number(ctx.config.ev_battery_kwh ?? 75)
  const chargingRateKw = Number(ctx.config.charging_rate_kw ?? 11)

  const kwhNeeded = Math.max(0, ((targetSoc - evState) / 100) * evCapacityKwh)
  const hoursNeeded = Math.ceil(kwhNeeded / chargingRateKw)

  if (kwhNeeded <= 0) {
    return {
      status: 'noop',
      summary: `EV already at ${evState}% — above target ${targetSoc}%`,
    }
  }

  // Find cheapest N consecutive hours in the today+tomorrow window
  const allPrices = [...prices.today, ...prices.tomorrow].map((p) => ({
    timestamp: new Date(p.timestamp).getTime(),
    price: p.price,
  }))
  const cheapest = findCheapestWindow(allPrices, hoursNeeded)

  if (!cheapest) {
    return { status: 'error', summary: 'Could not find a charging window' }
  }

  const avgPrice = cheapest.prices.reduce((s, p) => s + p.price, 0) / cheapest.prices.length
  const avgAll = allPrices.reduce((s, p) => s + p.price, 0) / allPrices.length
  const savings = (avgAll - avgPrice) * kwhNeeded

  const plan: Plan = {
    actions: [
      {
        kind: 'start_charger',
        at: cheapest.prices[0].timestamp,
        entityId: charger.entityId,
        reason: `Cheapest ${hoursNeeded}h window @ ${avgPrice.toFixed(3)} EUR/kWh (avg is ${avgAll.toFixed(3)})`,
      },
      {
        kind: 'stop_charger',
        at: cheapest.prices[cheapest.prices.length - 1].timestamp + 3600_000,
        entityId: charger.entityId,
        reason: `End of cheapest window — EV should reach ${targetSoc}%`,
      },
    ],
    reasoning: `Need ${kwhNeeded.toFixed(1)} kWh (${evState}%→${targetSoc}%). Scheduled for ${hoursNeeded}h at €${avgPrice.toFixed(3)}/kWh, saving ~€${savings.toFixed(2)} vs average.`,
    estimatedSavings: savings,
  }

  // Phase 1: just record the plan, don't actually flip switches yet
  // (The user will approve actuation in Phase 2 via a dry-run → enable toggle)
  db.kvSet('energy-optimizer:latest-plan', plan)

  return {
    status: 'success',
    summary: plan.reasoning,
    data: plan,
  }
}

function findCheapestWindow(
  prices: { timestamp: number; price: number }[],
  hours: number,
): { prices: { timestamp: number; price: number }[]; total: number } | null {
  if (prices.length < hours) return null

  let bestStart = 0
  let bestTotal = Infinity

  // Only consider windows starting from "now" onwards
  const now = Date.now()
  const startIdx = prices.findIndex((p) => p.timestamp >= now)
  if (startIdx === -1) return null

  for (let i = startIdx; i <= prices.length - hours; i++) {
    let total = 0
    for (let j = 0; j < hours; j++) total += prices[i + j].price
    if (total < bestTotal) {
      bestTotal = total
      bestStart = i
    }
  }

  return {
    prices: prices.slice(bestStart, bestStart + hours),
    total: bestTotal,
  }
}

export const energyOptimizerFlow: Flow = {
  id: 'energy-optimizer',
  name: 'Energy Optimizer',
  description: 'Price-aware EV charging and battery scheduling',
  icon: 'mdi:solar-power',
  triggers: [
    { type: 'schedule', cron: '0 * * * *' }, // every hour
    { type: 'manual' },
  ],
  configSchema: [
    { key: 'ev_target_soc', label: 'EV target SoC (%)', type: 'number', default: 80 },
    { key: 'ev_battery_kwh', label: 'EV battery size (kWh)', type: 'number', default: 75 },
    { key: 'charging_rate_kw', label: 'Charging rate (kW)', type: 'number', default: 11 },
    { key: 'ready_by_hour', label: 'Ready by (hour, 0–23)', type: 'number', default: 7 },
    { key: 'min_battery_soc', label: 'Min home battery reserve (%)', type: 'number', default: 20 },
  ],
  run,
}
