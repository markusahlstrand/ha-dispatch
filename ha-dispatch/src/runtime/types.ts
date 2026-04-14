/**
 * HA Dispatch Flow Types
 *
 * A Flow is the unit of automation. It can be triggered by:
 *  - A schedule (cron-like)
 *  - An HA event (entity state change)
 *  - A manual run (user click)
 *  - Another flow's emission
 *
 * The runtime gives each flow a Context with durable step primitives,
 * HA access, and storage. Flows can yield intermediate states and
 * produce a plan/result that the runtime records in history.
 */

import type { HAClient } from '../ha-client.js'
import type { Database } from '../db.js'

export interface FlowContext {
  ha: HAClient
  db: Database
  log: (msg: string, data?: unknown) => void
  // Durable step primitives (Phase 1: simple wrappers; Phase 2+: DO-backed)
  step: {
    run<T>(id: string, fn: () => Promise<T>): Promise<T>
    sleep(id: string, ms: number): Promise<void>
  }
  // Access flow-scoped config set by the user in the UI
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
}

export interface Flow {
  /** Unique slug — also the folder name under src/flows/ */
  id: string
  /** Human-readable name */
  name: string
  /** One-line description shown in the flow list */
  description: string
  /** Emoji or MDI icon (mdi:...) */
  icon?: string
  /** What triggers this flow */
  triggers: FlowTrigger[]
  /** Config schema — used to render the per-flow settings form */
  configSchema?: FlowConfigField[]
  /** The flow function itself */
  run: (ctx: FlowContext) => Promise<FlowResult>
}

export interface FlowConfigField {
  key: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'entity'
  default?: unknown
  options?: { value: string; label: string }[]
  /** For type: 'entity' — filter by HA domain (e.g., 'sensor', 'switch') */
  domain?: string
}
