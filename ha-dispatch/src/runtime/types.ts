/**
 * HA Dispatch Flow Types
 *
 * Two flow modes coexist:
 *
 *   - 'managed' — Dispatch's runtime executes the flow. Use this when
 *     you need LLM calls, multi-step orchestration, memoization, or
 *     anything HA's automation engine doesn't do well. The flow's
 *     `run(ctx)` is invoked by our scheduler / manual triggers.
 *
 *   - 'native' — Dispatch generates a Home Assistant automation YAML
 *     once and HA owns it from then on (triggers, traces, scheduling
 *     all native). Use for if-this-then-that flows the user might want
 *     to inspect or edit in HA. The flow's `materialize(ctx)` is
 *     called when the flow is enabled or its config changes; the
 *     output is POSTed to /api/config/automation/config/.
 *
 * A flow is always one or the other — discriminated by `mode`. A future
 * 'hybrid' mode (Dispatch plans then writes a one-shot native automation
 * as the actuator) is left for later.
 */

import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { Storage } from '../adapters/index.js'
import type { HAAutomationSpec } from '../ha/automation-writer.js'

export interface FlowContext {
  ha: HAClient
  /** High-level domain helpers (saveFlowRun, getMapping, kvSet, ...) */
  store: AppStore
  /** Raw storage adapters when a flow needs direct KV/Blob/SQL access */
  storage: Storage
  log: (msg: string, data?: unknown) => void
  // Durable step primitives (Phase 1: simple wrappers; Phase 2+: DO-backed)
  step: {
    run<T>(id: string, fn: () => Promise<T>): Promise<T>
    sleep(id: string, ms: number): Promise<void>
  }
  // Access flow-scoped config set by the user in the UI
  config: Record<string, unknown>
}

/** Lighter context used for native materialization — no step primitives. */
export interface NativeFlowContext {
  ha: HAClient
  store: AppStore
  storage: Storage
  log: (msg: string, data?: unknown) => void
  config: Record<string, unknown>
}

export interface FlowTrigger {
  type: 'schedule' | 'event' | 'manual'
  // For schedule: cron expression
  cron?: string
  // For event: HA entity IDs or event types
  entities?: string[]
  events?: string[]
}

export interface FlowResult {
  status: 'success' | 'error' | 'noop'
  summary: string
  data?: unknown
  /**
   * Optional list of HA entity states to publish after the run. The
   * runner will POST each spec to /api/states so they appear as first
   * class HA sensors. Naming: sensor.dispatch_{flow_id}_{key}.
   */
  publish?: import('../ha/entity-publisher.js').PublishSpec[]
}

interface FlowBase {
  /** Unique slug — also the folder name under src/flows/ */
  id: string
  /** Human-readable name */
  name: string
  /** One-line description shown in the flow list */
  description: string
  /** Emoji or MDI icon (mdi:...) */
  icon?: string
  /** Config schema — used to render the per-flow settings form */
  configSchema?: FlowConfigField[]
}

export interface ManagedFlow extends FlowBase {
  mode?: 'managed' // default
  /** What triggers this flow (managed-only — native flows put triggers in the YAML) */
  triggers: FlowTrigger[]
  /** The flow function itself */
  run: (ctx: FlowContext) => Promise<FlowResult>
}

export interface NativeFlow extends FlowBase {
  mode: 'native'
  /**
   * Build the HA automation spec from current config. Returning null
   * means "config incomplete, can't materialize yet" — the runtime
   * will surface that as a Setup-needed state.
   */
  materialize: (ctx: NativeFlowContext) => Promise<HAAutomationSpec | null> | HAAutomationSpec | null
}

export type Flow = ManagedFlow | NativeFlow

export function isNativeFlow(flow: Flow): flow is NativeFlow {
  return flow.mode === 'native'
}

export function isManagedFlow(flow: Flow): flow is ManagedFlow {
  return !flow.mode || flow.mode === 'managed'
}

export interface FlowConfigField {
  key: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'entity' | 'entity[]'
  default?: unknown
  options?: { value: string; label: string }[]
  /** For type: 'entity' / 'entity[]' — filter by HA domain (e.g., 'sensor', 'switch') */
  domain?: string | string[]
  /** Optional: for type: 'entity' / 'entity[]', filter by device_class */
  deviceClass?: string
}
