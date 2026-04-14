/**
 * Add-on configuration loader.
 *
 * When running as an HA add-on, options are read from /data/options.json
 * (injected by the Supervisor). When running locally for development,
 * we fall back to environment variables and sane defaults.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'

/**
 * On HA's Alpine base image, the Supervisor stores the auth token (and
 * other env vars it injects) as files under the s6 container env dir.
 * When our process is launched without s6's `with-contenv` wrapper,
 * process.env is empty for those vars. Read them directly from disk.
 */
function readSupervisorToken(): string | undefined {
  if (process.env.SUPERVISOR_TOKEN) return process.env.SUPERVISOR_TOKEN
  const candidates = [
    '/run/s6/container_environment/SUPERVISOR_TOKEN',
    '/var/run/s6/container_environment/SUPERVISOR_TOKEN',
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8').trim()
      } catch {
        /* fall through */
      }
    }
  }
  return undefined
}

function listS6Env(): string[] {
  for (const dir of ['/run/s6/container_environment', '/var/run/s6/container_environment']) {
    if (existsSync(dir)) {
      try {
        return readdirSync(dir)
      } catch {
        /* ignore */
      }
    }
  }
  return []
}

export interface AddonConfig {
  log_level: string
  llm_provider: 'gemini' | 'openai' | 'anthropic' | 'none'
  llm_api_key?: string
  enabled_flows: string[]
  price_provider: 'pvpc' | 'tibber' | 'octopus' | 'awattar' | 'none'
  solcast_api_key?: string
  solcast_resource_id?: string
}

export interface RuntimeConfig extends AddonConfig {
  isAddon: boolean
  port: number
  dataDir: string
  hassUrl: string
  supervisorToken?: string
}

const DEFAULTS: AddonConfig = {
  log_level: 'info',
  llm_provider: 'none',
  enabled_flows: ['energy-optimizer'],
  price_provider: 'pvpc',
}

export function loadConfig(): RuntimeConfig {
  const isAddon = existsSync('/data/options.json')

  let options: Partial<AddonConfig> = {}
  if (isAddon) {
    try {
      options = JSON.parse(readFileSync('/data/options.json', 'utf-8'))
    } catch (e) {
      console.error('Failed to read /data/options.json:', e)
    }
  }

  return {
    ...DEFAULTS,
    ...options,
    isAddon,
    port: Number(process.env.PORT ?? 8099),
    dataDir: isAddon ? '/data' : process.env.DATA_DIR ?? './data',
    // REST base URL. Via the Supervisor proxy, http://supervisor/core/*
    // is forwarded to HA with an internal admin token. Direct access uses
    // HA's origin.
    hassUrl: isAddon
      ? 'http://supervisor/core'
      : process.env.HASS_URL ?? 'http://localhost:8123',
    supervisorToken: readSupervisorToken(),
  }
}

export function debugS6Env(): string {
  const keys = listS6Env()
  return keys.length > 0 ? keys.sort().join(' ') : '(s6 env dir not present)'
}
