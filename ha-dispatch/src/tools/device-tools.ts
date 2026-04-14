/**
 * Device-oriented tools for the chat agent.
 *
 * Until now the agent only had `list_states` (flat) and `list_areas`
 * (names only). That made perfectly natural questions like "what
 * shellys are in the laundry?" unanswerable — the agent had no way
 * to bridge entities ↔ devices ↔ areas.
 *
 * These tools expose HA's device_registry (via the template backdoor)
 * so the agent can filter devices by area, manufacturer, or model,
 * see the entities each device owns, and grab its configuration_url
 * (Shellys, Sonoff, Hue, etc. all expose one when possible).
 */

import type { Tool } from './types.js'
import { listDevices, filterDevices } from '../ha/device-registry.js'

export const listDevicesTool: Tool<
  {
    area?: string
    manufacturer?: string
    model?: string
    entity_substring?: string
    limit?: number
  },
  unknown
> = {
  spec: {
    name: 'list_devices',
    description:
      'List physical devices from HA\'s device registry, grouped with their entities and area. Filter by area ("laundry"), manufacturer ("Shelly"), model, or a substring in any entity id. This is the right tool to use when the user asks about devices in a room ("shellys in the laundry?", "what climate devices do I have upstairs?") — don\'t try to reconstruct that from list_states. Each device includes configuration_url when HA has one, which for LAN devices (Shelly, Sonoff, etc.) is the IP or hostname you can use directly.',
    parameters: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          description: 'Case-insensitive substring match against area_name or area_id.',
        },
        manufacturer: {
          type: 'string',
          description: 'e.g. "Shelly", "Aqara", "IKEA". Case-insensitive substring.',
        },
        model: { type: 'string', description: 'Case-insensitive substring on device model.' },
        entity_substring: {
          type: 'string',
          description: 'Match devices that have any entity id containing this substring.',
        },
        limit: { type: 'integer', description: 'Max devices to return (default 50).' },
      },
    },
  },
  async execute({ ha }, args) {
    const all = await listDevices(ha)
    const filtered = filterDevices(all, {
      area: args.area,
      manufacturer: args.manufacturer,
      model: args.model,
      entity_substring: args.entity_substring,
    })
    const limit = Math.min(Number(args.limit ?? 50), 200)
    return filtered.slice(0, limit).map((d) => ({
      id: d.id,
      name: d.name,
      manufacturer: d.manufacturer,
      model: d.model,
      area_name: d.area_name,
      configuration_url: d.configuration_url,
      entity_count: d.entity_ids.length,
      entity_ids: d.entity_ids.slice(0, 20),
    }))
  },
}

export const deviceTools = [listDevicesTool] as Tool<Record<string, unknown>, unknown>[]
