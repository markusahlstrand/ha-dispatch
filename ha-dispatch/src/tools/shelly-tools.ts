/**
 * Shelly tools for the chat agent.
 *
 * These let the assistant reach out to Shelly devices directly (not
 * through Home Assistant), inspect them, and install/remove Shelly
 * Scripts — the piece that makes one-shot "send a webhook when power
 * crosses a threshold" requests fully automatable.
 *
 * Known devices live under KV keys `shelly:device:<id>` (one per
 * device). The agent discovers a Shelly by asking the user for IP
 * (for now — mDNS discovery is a future iteration), stores it, and
 * then references it by id from there on.
 */

import type { Tool } from './types.js'
import type { AppStore } from '../store.js'
import type { KnownShelly } from '../adapters/shelly/types.js'
import { createShellyClient } from '../adapters/shelly/client.js'
import {
  scriptTemplates,
  type ScriptTemplateId,
  powerThresholdWebhook,
  cycleFinishWebhook,
} from '../adapters/shelly/scripts.js'

const KEY_PREFIX = 'shelly:device:'

async function getKnown(store: AppStore, idOrAddress: string): Promise<KnownShelly | undefined> {
  // Try by id first, then by scanning known devices for matching address
  const byId = await store.kvGet<KnownShelly>(KEY_PREFIX + idOrAddress)
  if (byId) return byId
  // Scan (KV list is backed by sqlite LIKE lookup, cheap)
  // The list is expected small; enumerating via a known-devices index
  // keeps things simple.
  const index = (await store.kvGet<string[]>('shelly:index')) ?? []
  for (const id of index) {
    const d = await store.kvGet<KnownShelly>(KEY_PREFIX + id)
    if (d && (d.address === idOrAddress || d.id === idOrAddress || d.name === idOrAddress)) return d
  }
  return undefined
}

async function saveKnown(store: AppStore, device: KnownShelly): Promise<void> {
  await store.kvSet(KEY_PREFIX + device.id, device)
  const index = (await store.kvGet<string[]>('shelly:index')) ?? []
  if (!index.includes(device.id)) {
    await store.kvSet('shelly:index', [...index, device.id])
  }
}

async function clientFor(
  store: AppStore,
  idOrAddress: string,
  addressOverride?: string,
  passwordOverride?: string,
) {
  const known = await getKnown(store, idOrAddress)
  const address = addressOverride ?? known?.address
  if (!address) {
    throw new Error(
      `No known Shelly for "${idOrAddress}". Call shelly_add first (with the device's IP) or pass address.`,
    )
  }
  const password = passwordOverride ?? known?.password
  return createShellyClient({ address, password })
}

// ─── Tools ─────────────────────────────────────────────────

export const shellyAddTool: Tool<
  { address: string; password?: string; name?: string },
  unknown
> = {
  spec: {
    name: 'shelly_add',
    description:
      'Register a Shelly Gen2+ device by IP or hostname. Call this once per device before other shelly_* tools. The tool probes the device for its id and stores the mapping so the user can refer to it by name later.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'IP or hostname, e.g. "192.168.1.50" or "shelly-em.local"' },
        password: { type: 'string', description: 'Optional device password for digest auth.' },
        name: { type: 'string', description: 'Optional friendly name (defaults to Shelly-reported name or id).' },
      },
      required: ['address'],
    },
  },
  async execute({ store }, args) {
    const client = createShellyClient({ address: args.address, password: args.password })
    const info = await client.info()
    const device: KnownShelly = {
      id: info.id,
      name: args.name ?? info.name ?? info.id,
      address: args.address,
      password: args.password,
      lastSeen: Date.now(),
    }
    await saveKnown(store, device)
    return {
      ok: true,
      device: {
        id: device.id,
        name: device.name,
        address: device.address,
        model: info.model,
        firmware: info.ver,
        auth_required: info.auth_en,
      },
    }
  },
}

export const shellyListTool: Tool<Record<string, never>, unknown> = {
  spec: {
    name: 'shelly_list',
    description: 'List Shelly devices Dispatch knows about (added via shelly_add).',
    parameters: { type: 'object', properties: {} },
  },
  async execute({ store }) {
    const index = (await store.kvGet<string[]>('shelly:index')) ?? []
    const devices = await Promise.all(
      index.map((id) => store.kvGet<KnownShelly>(KEY_PREFIX + id)),
    )
    return devices.filter(Boolean).map((d) => ({
      id: d!.id,
      name: d!.name,
      address: d!.address,
      last_seen: d!.lastSeen ?? null,
    }))
  },
}

export const shellyInfoTool: Tool<{ id_or_address: string }, unknown> = {
  spec: {
    name: 'shelly_info',
    description: 'Get a Shelly device\'s info (model, firmware, auth_enabled, etc.).',
    parameters: {
      type: 'object',
      properties: { id_or_address: { type: 'string' } },
      required: ['id_or_address'],
    },
  },
  async execute({ store }, args) {
    const client = await clientFor(store, args.id_or_address)
    return client.info()
  },
}

export const shellyStatusTool: Tool<{ id_or_address: string }, unknown> = {
  spec: {
    name: 'shelly_status',
    description: 'Get the full status snapshot (all components) for a Shelly device.',
    parameters: {
      type: 'object',
      properties: { id_or_address: { type: 'string' } },
      required: ['id_or_address'],
    },
  },
  async execute({ store }, args) {
    const client = await clientFor(store, args.id_or_address)
    return client.status()
  },
}

export const shellyCallTool: Tool<
  { id_or_address: string; method: string; params?: Record<string, unknown> },
  unknown
> = {
  spec: {
    name: 'shelly_call',
    description:
      'Call any Shelly RPC method on a known device. Use for advanced control the other tools don\'t cover (Switch.Set, Cover.Open, Schedule.Create, WiFi.SetConfig, etc.). Consult Shelly API docs for method names.',
    parameters: {
      type: 'object',
      properties: {
        id_or_address: { type: 'string' },
        method: { type: 'string', description: 'RPC method, e.g. "Switch.Set".' },
        params: { type: 'object', description: 'Method parameters.' },
      },
      required: ['id_or_address', 'method'],
    },
  },
  async execute({ store }, args) {
    const client = await clientFor(store, args.id_or_address)
    return client.call(args.method, args.params ?? {})
  },
}

export const shellyListScriptsTool: Tool<{ id_or_address: string }, unknown> = {
  spec: {
    name: 'shelly_list_scripts',
    description: 'List the Shelly Scripts currently installed on a device, including which are running.',
    parameters: {
      type: 'object',
      properties: { id_or_address: { type: 'string' } },
      required: ['id_or_address'],
    },
  },
  async execute({ store }, args) {
    const client = await clientFor(store, args.id_or_address)
    return client.scriptList()
  },
}

export const shellyInstallScriptTool: Tool<
  {
    id_or_address: string
    name: string
    /** Provide EITHER a template_id + params OR raw code. */
    template_id?: ScriptTemplateId
    template_params?: Record<string, unknown>
    code?: string
    autostart?: boolean
  },
  unknown
> = {
  spec: {
    name: 'shelly_install_script',
    description:
      'Install (or update) a Shelly Script on a device and start it. Provide EITHER a template_id + template_params to use a bundled template, OR raw mJS code. Names starting with "dispatch_" are reserved for Dispatch-managed scripts so they can be found and cleaned up later. Prefer templates when possible — they are tested and handle edge cases like cooldowns and hysteresis. Available template_ids: power_threshold_webhook, cycle_finish_webhook.',
    parameters: {
      type: 'object',
      properties: {
        id_or_address: { type: 'string' },
        name: { type: 'string', description: 'Script name on the device (prefix with dispatch_ for managed scripts).' },
        template_id: {
          type: 'string',
          enum: Object.keys(scriptTemplates),
          description: 'Optional bundled template to render.',
        },
        template_params: { type: 'object', description: 'Params passed to the template.' },
        code: { type: 'string', description: 'Raw mJS code if not using a template.' },
        autostart: { type: 'boolean', description: 'Start the script after install (default true).' },
      },
      required: ['id_or_address', 'name'],
    },
  },
  async execute({ store }, args) {
    const client = await clientFor(store, args.id_or_address)
    let code: string
    if (args.template_id && args.template_params) {
      if (args.template_id === 'power_threshold_webhook') {
        code = powerThresholdWebhook(
          args.template_params as Parameters<typeof powerThresholdWebhook>[0],
        )
      } else if (args.template_id === 'cycle_finish_webhook') {
        code = cycleFinishWebhook(args.template_params as Parameters<typeof cycleFinishWebhook>[0])
      } else {
        throw new Error(`Unknown template_id: ${args.template_id}`)
      }
    } else if (args.code) {
      code = args.code
    } else {
      throw new Error('Provide either template_id + template_params or raw code')
    }
    const result = await client.installScript({
      name: args.name,
      code,
      autostart: args.autostart ?? true,
    })
    return {
      ok: true,
      script_id: result.id,
      created: result.created,
      code_preview: code.slice(0, 300),
    }
  },
}

export const shellyRemoveScriptTool: Tool<
  { id_or_address: string; name_or_id: string },
  unknown
> = {
  spec: {
    name: 'shelly_remove_script',
    description: 'Stop and delete a Shelly Script on a device, targeted by name or numeric id.',
    parameters: {
      type: 'object',
      properties: {
        id_or_address: { type: 'string' },
        name_or_id: { type: 'string', description: 'Script name (e.g. "dispatch_laundry_done") or numeric id.' },
      },
      required: ['id_or_address', 'name_or_id'],
    },
  },
  async execute({ store }, args) {
    const client = await clientFor(store, args.id_or_address)
    const list = await client.scriptList()
    const target = isNaN(Number(args.name_or_id))
      ? list.find((s) => s.name === args.name_or_id)
      : list.find((s) => s.id === Number(args.name_or_id))
    if (!target) return { ok: false, error: `Script not found: ${args.name_or_id}` }
    if (target.running) await client.scriptStop(target.id)
    await client.scriptDelete(target.id)
    return { ok: true, removed: { id: target.id, name: target.name } }
  },
}

export const shellyTools = [
  shellyAddTool,
  shellyListTool,
  shellyInfoTool,
  shellyStatusTool,
  shellyCallTool,
  shellyListScriptsTool,
  shellyInstallScriptTool,
  shellyRemoveScriptTool,
] as Tool<Record<string, unknown>, unknown>[]
