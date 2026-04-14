/**
 * HA device registry access via the Template API.
 *
 * HA's device_registry and area_registry are WebSocket-only REST-wise,
 * but the Jinja template engine can see them via device_id(), area_id(),
 * device_attr(), and area_name(). We render a template that enumerates
 * every entity with its device + area metadata and parse that on our
 * side. Slightly wasteful compared to native registry access but gets
 * the job done with our existing REST auth and no new scope.
 */

import type { HAClient } from '../ha-client.js'

export interface DeviceEntity {
  entity_id: string
  device_id: string
  device_name: string | null
  manufacturer: string | null
  model: string | null
  area_id: string | null
  area_name: string | null
  configuration_url: string | null
}

export interface Device {
  id: string
  name: string | null
  manufacturer: string | null
  model: string | null
  area_id: string | null
  area_name: string | null
  configuration_url: string | null
  entity_ids: string[]
}

const TEMPLATE = `
{%- set ns = namespace(items=[]) -%}
{%- for ent in states -%}
  {%- set did = device_id(ent.entity_id) -%}
  {%- if did -%}
    {%- set aid = area_id(ent.entity_id) -%}
    {%- set ns.items = ns.items + [{
      'entity_id': ent.entity_id,
      'device_id': did,
      'device_name': device_attr(did, 'name_by_user') or device_attr(did, 'name'),
      'manufacturer': device_attr(did, 'manufacturer'),
      'model': device_attr(did, 'model'),
      'area_id': aid,
      'area_name': area_name(aid) if aid else none,
      'configuration_url': device_attr(did, 'configuration_url'),
    }] -%}
  {%- endif -%}
{%- endfor -%}
{{ ns.items | tojson }}
`

/** Enumerate every entity that has a device registry entry. */
export async function listDeviceEntities(ha: HAClient): Promise<DeviceEntity[]> {
  const rendered = await ha.renderTemplate(TEMPLATE)
  try {
    return JSON.parse(rendered) as DeviceEntity[]
  } catch (e) {
    throw new Error(`Device registry template did not render valid JSON: ${rendered.slice(0, 160)}`)
  }
}

/** Group by device_id. */
export async function listDevices(ha: HAClient): Promise<Device[]> {
  const entities = await listDeviceEntities(ha)
  const byId = new Map<string, Device>()
  for (const e of entities) {
    const existing = byId.get(e.device_id)
    if (existing) {
      existing.entity_ids.push(e.entity_id)
      // Prefer a non-null area over null if we saw both; typically they're consistent
      existing.area_id = existing.area_id ?? e.area_id
      existing.area_name = existing.area_name ?? e.area_name
    } else {
      byId.set(e.device_id, {
        id: e.device_id,
        name: e.device_name,
        manufacturer: e.manufacturer,
        model: e.model,
        area_id: e.area_id,
        area_name: e.area_name,
        configuration_url: e.configuration_url,
        entity_ids: [e.entity_id],
      })
    }
  }
  return [...byId.values()]
}

/** Filter helper used by tools. */
export function filterDevices(
  devices: Device[],
  filter: { area?: string; manufacturer?: string; model?: string; entity_substring?: string },
): Device[] {
  const areaLc = filter.area?.toLowerCase()
  const mfrLc = filter.manufacturer?.toLowerCase()
  const modelLc = filter.model?.toLowerCase()
  const entSubLc = filter.entity_substring?.toLowerCase()
  return devices.filter((d) => {
    if (areaLc) {
      const aName = d.area_name?.toLowerCase() ?? ''
      const aId = d.area_id?.toLowerCase() ?? ''
      if (!aName.includes(areaLc) && !aId.includes(areaLc)) return false
    }
    if (mfrLc && !(d.manufacturer ?? '').toLowerCase().includes(mfrLc)) return false
    if (modelLc && !(d.model ?? '').toLowerCase().includes(modelLc)) return false
    if (entSubLc && !d.entity_ids.some((e) => e.toLowerCase().includes(entSubLc))) return false
    return true
  })
}

/**
 * Extract an IP or hostname from a configuration_url like
 *   "http://192.168.1.50"  or  "http://shelly-plug-s-abc.local/"
 */
export function extractAddress(configUrl: string | null | undefined): string | null {
  if (!configUrl) return null
  try {
    const u = new URL(configUrl)
    return u.hostname
  } catch {
    // configuration_url isn't always well-formed; try a cheap regex fallback
    const m = /https?:\/\/([^\/:]+)/.exec(configUrl)
    return m?.[1] ?? null
  }
}
