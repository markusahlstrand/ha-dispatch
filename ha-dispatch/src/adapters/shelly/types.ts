/**
 * Shelly Gen2+ RPC types.
 *
 * We keep the typed surface small — the agent uses `shelly_call` for
 * anything specific and we add typed helpers here as patterns emerge.
 */

export interface ShellyDeviceInfo {
  id: string
  mac: string
  model: string
  gen: number
  fw_id: string
  ver: string
  app: string
  auth_en: boolean
  auth_domain: string | null
  name?: string | null
}

export interface ShellyScriptEntry {
  id: number
  name: string
  enable: boolean
  running: boolean
}

/** Minimum info we persist per known device. */
export interface KnownShelly {
  /** The Shelly's reported id (e.g. shellyplus2pm-d48afc764010) */
  id: string
  /** User-friendly name; falls back to id */
  name: string
  /** IP or hostname the Shelly is reachable at */
  address: string
  /** Optional password for digest auth */
  password?: string
  /** Last-seen timestamp (ms since epoch) */
  lastSeen?: number
  /** Free-form notes the assistant can keep */
  notes?: string[]
}
