/**
 * Flow Registry
 *
 * Holds all registered flows. In Phase 1 flows are imported statically
 * at build time (bundled with the add-on). In Phase 3+ we'll support
 * dynamic loading of user flows from /share/ha-dispatch/flows/.
 */

import type { Flow } from './types.js'
import { energyOptimizerFlow } from '../flows/energy-optimizer/flow.js'
import { motionLightsFlow } from '../flows/motion-lights/flow.js'

const registry = new Map<string, Flow>()

export function registerFlow(flow: Flow) {
  if (registry.has(flow.id)) {
    throw new Error(`Flow already registered: ${flow.id}`)
  }
  registry.set(flow.id, flow)
}

export function getFlow(id: string): Flow | undefined {
  return registry.get(id)
}

export function listFlows(): Flow[] {
  return [...registry.values()]
}

// ─── Bundled flows ────────────────────────────────────────
// Each new bundled flow gets registered here.
registerFlow(energyOptimizerFlow)
registerFlow(motionLightsFlow)
