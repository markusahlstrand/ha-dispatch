/**
 * Home Assistant tools the chat agent can call.
 *
 * Each tool is a small wrapper around HAClient that returns a clean
 * JSON-serialisable result. The parameters JSON schema is what the LLM
 * sees — keep it tight and well-described.
 *
 * Tools that mutate state (call_service) verify the outcome via the
 * verify module so the assistant can't claim success when nothing
 * actually changed.
 */

import type { Tool } from './types.js'
import { verifyServiceCall } from './verify.js'

export const listStatesTool: Tool<{ domain?: string; limit?: number }, unknown> = {
  spec: {
    name: 'list_states',
    description:
      'List Home Assistant entity states. Optionally filter by domain (e.g. "light", "switch", "cover"). Use this to discover what entities exist before acting on them.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain prefix, e.g. "light"' },
        limit: { type: 'integer', description: 'Max entities to return (default 50)' },
      },
    },
  },
  async execute({ ha }, args) {
    const states = await ha.getStates()
    const filtered = args.domain
      ? states.filter((s) => s.entity_id.startsWith(`${args.domain}.`))
      : states
    const limit = Math.min(Number(args.limit ?? 50), 200)
    return filtered.slice(0, limit).map((s) => ({
      entity_id: s.entity_id,
      friendly_name: s.attributes?.friendly_name ?? null,
      state: s.state,
      area_id: s.attributes?.area_id ?? null,
      device_class: s.attributes?.device_class ?? null,
      unit: s.attributes?.unit_of_measurement ?? null,
    }))
  },
}

export const getStateTool: Tool<{ entity_id: string }, unknown> = {
  spec: {
    name: 'get_state',
    description: 'Get the current state and attributes of one Home Assistant entity.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  async execute({ ha }, args) {
    const s = await ha.getState(args.entity_id)
    if (!s) return { entity_id: args.entity_id, found: false }
    return {
      entity_id: s.entity_id,
      state: s.state,
      attributes: s.attributes,
      last_changed: s.last_changed,
    }
  },
}

export const callServiceTool: Tool<
  {
    domain: string
    service: string
    entity_id?: string | string[]
    data?: Record<string, unknown>
  },
  unknown
> = {
  spec: {
    name: 'call_service',
    description:
      'Call a Home Assistant service and verify the resulting state. Use for actions: light.turn_on, switch.turn_off, cover.open_cover, etc. Do NOT claim the action worked unless the verification field is true.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain, e.g. "light"' },
        service: { type: 'string', description: 'Service name, e.g. "turn_on"' },
        entity_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Target entity id or list of ids',
        },
        data: {
          type: 'object',
          description: 'Optional service data (brightness, position, etc.)',
        },
      },
      required: ['domain', 'service'],
    },
  },
  async execute({ ha }, args) {
    const entityIds = !args.entity_id
      ? []
      : Array.isArray(args.entity_id)
        ? args.entity_id
        : [args.entity_id]

    await ha.callService({
      domain: args.domain,
      service: args.service,
      target: entityIds.length > 0 ? { entity_id: entityIds } : undefined,
      service_data: args.data,
    })

    const verification = await verifyServiceCall({
      ha,
      domain: args.domain,
      service: args.service,
      entityIds,
    })

    let note: string | undefined
    if (verification.verified === false) {
      const failures = verification.details.filter((d) => !d.ok)
      note =
        `State did not change as expected after ${args.domain}.${args.service}. ` +
        failures
          .map((d) => `${d.entityId} expected ${d.expected}, actually ${d.actual}`)
          .join('; ')
    } else if (verification.verified === true) {
      note = `Verified ${verification.details.length} entity/entities reached expected state.`
    } else {
      note = `Service called; outcome not auto-verified for ${args.domain}.${args.service}.`
    }

    return {
      called: { domain: args.domain, service: args.service, entity_id: entityIds, data: args.data },
      verified: verification.verified,
      verificationNote: note,
      states: verification.details,
    }
  },
}

export const listAreasTool: Tool<Record<string, never>, unknown> = {
  spec: {
    name: 'list_areas',
    description: 'List the area_ids defined in Home Assistant. Useful before filtering entities by area.',
    parameters: { type: 'object', properties: {} },
  },
  async execute({ ha }) {
    const states = await ha.getStates()
    const areas = new Set<string>()
    for (const s of states) {
      const a = s.attributes?.area_id
      if (typeof a === 'string') areas.add(a)
    }
    return [...areas].sort()
  },
}

export const haTools = [listStatesTool, getStateTool, callServiceTool, listAreasTool] as Tool<
  Record<string, unknown>,
  unknown
>[]
