/**
 * Automation & flow tools for the chat agent.
 *
 * These let the assistant actually *create* things in Home Assistant
 * rather than just read state or call services on existing entities:
 *
 *   create_ha_automation   — write a raw HA automation via the config API
 *   list_ha_automations    — see what's currently deployed (Dispatch-managed)
 *   remove_ha_automation   — undo, targeted by flow_id / alias-slug
 *   list_flows             — what Dispatch flows exist + state
 *   configure_flow         — set a managed/native flow's config
 *   deploy_flow            — for native flows: materialize + push YAML to HA
 *
 * Naming discipline: every automation the assistant creates goes under
 * the `dispatch_ad_hoc_{slug}` prefix (or `dispatch_{flow_id}` for
 * flow-backed ones) so we can always identify and remove ours without
 * touching user-written automations.
 */

import type { Tool } from './types.js'
import { createAutomationWriter } from '../ha/automation-writer.js'
import type { HAAutomationSpec } from '../ha/automation-writer.js'
import { listFlows, getFlow } from '../runtime/flow-registry.js'
import { runFlow, disableFlow } from '../runtime/flow-runner.js'
import { isNativeFlow } from '../runtime/types.js'

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

// ─── Raw automation creation ───────────────────────────────

export const createHAAutomationTool: Tool<
  {
    alias: string
    description?: string
    mode?: 'single' | 'restart' | 'queued' | 'parallel'
    trigger: unknown[]
    condition?: unknown[]
    action: unknown[]
    slug?: string
  },
  unknown
> = {
  spec: {
    name: 'create_ha_automation',
    description:
      'Create or replace a Home Assistant automation. HA owns runtime from then on — this is the primary way to wire up if-this-then-that automations. Use this when the user asks you to automate something and no existing Dispatch flow covers it. The automation is tagged as Dispatch-managed so it can be removed later. Before calling this, confirm with the user what the trigger/condition/action will be in plain language.',
    parameters: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Human-readable title shown in HA, e.g. "Terrace lights on padel person detection".',
        },
        description: {
          type: 'string',
          description: 'Optional longer description.',
        },
        mode: {
          type: 'string',
          enum: ['single', 'restart', 'queued', 'parallel'],
          description: 'HA automation mode. Use "restart" for motion/occupancy patterns so re-triggers reset timers. Default single.',
        },
        trigger: {
          type: 'array',
          description: 'Array of HA triggers. Each item is an object like {trigger: "state", entity_id: "...", to: "on"} or {trigger: "numeric_state", ...}. Check HA docs for the current platform names.',
          items: { type: 'object' },
        },
        condition: {
          type: 'array',
          description: 'Array of HA conditions (optional). Common: {condition: "sun", after: "sunset"}, {condition: "state", entity_id: "...", state: "..."}, {condition: "time", after: "22:00"}.',
          items: { type: 'object' },
        },
        action: {
          type: 'array',
          description: 'Array of HA actions. Each item typically {action: "light.turn_on", target: {entity_id: "..."}, data?: {...}} followed by a {delay: {minutes: N}} and a matching turn_off for timed patterns.',
          items: { type: 'object' },
        },
        slug: {
          type: 'string',
          description: 'Optional stable identifier for this automation (lowercase snake_case). Use when you want to update the same automation across turns instead of creating duplicates. Defaults to a slug of alias.',
        },
      },
      required: ['alias', 'trigger', 'action'],
    },
  },
  async execute({ ha }, args) {
    const spec: HAAutomationSpec = {
      alias: args.alias,
      description: args.description,
      mode: args.mode,
      trigger: args.trigger,
      condition: args.condition,
      action: args.action,
    }
    const slug = args.slug ? slugify(args.slug) : `ad_hoc_${slugify(args.alias)}`
    const writer = createAutomationWriter(ha)
    const entityId = await writer.upsert(slug, spec)
    return {
      ok: true,
      ha_entity_id: entityId,
      slug,
      alias: args.alias,
      note:
        'Automation deployed to Home Assistant. The user can inspect it under Settings → Automations & Scenes, and you can remove it later with remove_ha_automation.',
    }
  },
}

export const listHAAutomationsTool: Tool<Record<string, never>, unknown> = {
  spec: {
    name: 'list_ha_automations',
    description: 'List the Home Assistant automations Dispatch has deployed (both ad-hoc and flow-backed). Useful before offering to modify or remove one.',
    parameters: { type: 'object', properties: {} },
  },
  async execute({ ha }) {
    const states = await ha.getStates()
    return states
      .filter((s) => s.entity_id.startsWith('automation.dispatch_'))
      .map((s) => ({
        entity_id: s.entity_id,
        alias: s.attributes?.friendly_name ?? s.entity_id,
        state: s.state,
        last_triggered: s.attributes?.last_triggered ?? null,
      }))
  },
}

export const removeHAAutomationTool: Tool<{ slug: string }, unknown> = {
  spec: {
    name: 'remove_ha_automation',
    description: 'Remove a Dispatch-managed Home Assistant automation by its slug (the value after "automation.dispatch_"). Only works on automations Dispatch created.',
    parameters: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Slug portion of the automation id. E.g. for automation.dispatch_ad_hoc_padel_lights, slug = "ad_hoc_padel_lights".',
        },
      },
      required: ['slug'],
    },
  },
  async execute({ ha }, args) {
    const writer = createAutomationWriter(ha)
    await writer.remove(args.slug)
    return { ok: true, removed_slug: args.slug }
  },
}

// ─── Flow tools ────────────────────────────────────────────

export const listFlowsTool: Tool<Record<string, never>, unknown> = {
  spec: {
    name: 'list_flows',
    description: 'List the Dispatch flows available in this installation with their current config and deployment state. Use this before configure_flow / deploy_flow to check what fields a flow expects.',
    parameters: { type: 'object', properties: {} },
  },
  async execute({ store }) {
    const flows = listFlows()
    return Promise.all(
      flows.map(async (f) => {
        const config = await store.getFlowConfig(f.id)
        const native = isNativeFlow(f)
        const deployed = native ? await store.kvGet<string>(`native:${f.id}:entity_id`) : null
        return {
          id: f.id,
          name: f.name,
          description: f.description,
          mode: native ? 'native' : 'managed',
          config_schema: f.configSchema ?? [],
          current_config: config,
          deployed: Boolean(deployed),
          ha_entity_id: deployed ?? null,
        }
      }),
    )
  },
}

export const configureFlowTool: Tool<
  { flow_id: string; config: Record<string, unknown> },
  unknown
> = {
  spec: {
    name: 'configure_flow',
    description: 'Set (or update) the config for a Dispatch flow. Call list_flows first to see the expected config_schema. Fields not provided keep their current value.',
    parameters: {
      type: 'object',
      properties: {
        flow_id: { type: 'string' },
        config: { type: 'object', description: 'Object whose keys match the flow\'s config_schema keys.' },
      },
      required: ['flow_id', 'config'],
    },
  },
  async execute({ store }, args) {
    const existing = await store.getFlowConfig(args.flow_id)
    const merged = { ...existing, ...args.config }
    await store.setFlowConfig(args.flow_id, merged)
    return { ok: true, flow_id: args.flow_id, config: merged }
  },
}

export const deployFlowTool: Tool<{ flow_id: string }, unknown> = {
  spec: {
    name: 'deploy_flow',
    description: 'Deploy (for native flows, materialize + push YAML to HA) or run (for managed flows) a flow by id. For native flows make sure configure_flow was called first — if required fields are missing this returns noop.',
    parameters: {
      type: 'object',
      properties: { flow_id: { type: 'string' } },
      required: ['flow_id'],
    },
  },
  async execute({ ha, store, storage, recorder }, args) {
    if (!storage) {
      return { ok: false, error: 'storage not available in tool context' }
    }
    const flow = getFlow(args.flow_id)
    if (!flow) return { ok: false, error: `unknown flow: ${args.flow_id}` }
    const config = await store.getFlowConfig(flow.id)
    const result = await runFlow(flow, { ha, store, storage, trigger: 'manual', config, recorder })
    return {
      ok: result.status !== 'error',
      status: result.status,
      summary: result.summary,
      data: result.data,
    }
  },
}

export const disableFlowTool: Tool<{ flow_id: string }, unknown> = {
  spec: {
    name: 'disable_flow',
    description: 'For native flows, remove the deployed HA automation so the flow stops triggering. No-op for managed flows.',
    parameters: {
      type: 'object',
      properties: { flow_id: { type: 'string' } },
      required: ['flow_id'],
    },
  },
  async execute({ ha, store }, args) {
    const flow = getFlow(args.flow_id)
    if (!flow) return { ok: false, error: `unknown flow: ${args.flow_id}` }
    await disableFlow(flow, { ha, store })
    return { ok: true }
  },
}

export const automationTools = [
  createHAAutomationTool,
  listHAAutomationsTool,
  removeHAAutomationTool,
  listFlowsTool,
  configureFlowTool,
  deployFlowTool,
  disableFlowTool,
] as Tool<Record<string, unknown>, unknown>[]
