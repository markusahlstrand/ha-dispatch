/**
 * Add-on configuration loader.
 *
 * When running as an HA add-on, options are read from /data/options.json
 * (injected by the Supervisor). When running locally for development,
 * we fall back to environment variables and sane defaults.
 */

import { readFileSync, existsSync } from 'fs'

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
    hassUrl: isAddon ? 'http://supervisor/core/websocket' : process.env.HASS_URL ?? 'ws://localhost:8123/api/websocket',
    supervisorToken: process.env.SUPERVISOR_TOKEN,
  }
}
