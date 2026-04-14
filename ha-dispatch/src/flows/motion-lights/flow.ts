/**
 * Motion Lights — first native flow.
 *
 * When the configured motion sensor turns on (Unifi camera, PIR, etc.),
 * turn on the configured lights, leave them on for N minutes, then
 * turn them off. If motion re-triggers within the window, the timer
 * restarts (mode: restart on the HA side, no-op when lights already on).
 *
 * This is a textbook HA automation — we just generate the YAML and let
 * HA own runtime. Dispatch's contribution is the configuration UI and
 * the chat-driven discovery that knows how to suggest it.
 */

import type { NativeFlow } from '../../runtime/types.js'
import type { HAAutomationSpec } from '../../ha/automation-writer.js'

export const motionLightsFlow: NativeFlow = {
  id: 'motion-lights',
  name: 'Motion Lights',
  description: 'Turn lights on when motion is detected; turn off after N minutes.',
  icon: 'mdi:motion-sensor',
  mode: 'native',
  configSchema: [
    {
      key: 'motion_entity',
      label: 'Motion sensor',
      description: 'Binary sensor that turns "on" when motion is detected (Unifi camera, PIR, etc.)',
      type: 'entity',
      domain: 'binary_sensor',
      deviceClass: 'motion',
    },
    {
      key: 'light_entities',
      label: 'Lights to turn on',
      description: 'One or more lights to turn on with the motion',
      type: 'entity[]',
      domain: ['light', 'switch'],
    },
    {
      key: 'duration_minutes',
      label: 'On for (minutes)',
      description: 'How long to leave lights on after the last motion',
      type: 'number',
      default: 30,
    },
    {
      key: 'only_after_sunset',
      label: 'Only after sunset',
      description: 'Skip during daylight',
      type: 'boolean',
      default: true,
    },
  ],

  materialize(ctx) {
    const motionEntity = String(ctx.config.motion_entity ?? '')
    const lightEntitiesRaw = ctx.config.light_entities
    const lightEntities = Array.isArray(lightEntitiesRaw)
      ? lightEntitiesRaw.map(String).filter(Boolean)
      : typeof lightEntitiesRaw === 'string' && lightEntitiesRaw.length
        ? [lightEntitiesRaw]
        : []
    const durationMinutes = Number(ctx.config.duration_minutes ?? 30)
    const onlyAfterSunset = ctx.config.only_after_sunset !== false

    if (!motionEntity || lightEntities.length === 0) {
      // Config incomplete — runner returns "noop / setup required"
      return null
    }

    const conditions: unknown[] = []
    if (onlyAfterSunset) {
      conditions.push({ condition: 'sun', after: 'sunset' })
    }

    // Compute domain for the action — `light.turn_on/off` for lights,
    // `switch.turn_on/off` for switches. If mixed, split into two action
    // blocks targeting each domain so HA validates cleanly.
    const lightsByDomain = new Map<string, string[]>()
    for (const e of lightEntities) {
      const [domain] = e.split('.')
      const slot = lightsByDomain.get(domain) ?? []
      slot.push(e)
      lightsByDomain.set(domain, slot)
    }

    const onActions: unknown[] = []
    const offActions: unknown[] = []
    for (const [domain, ids] of lightsByDomain) {
      onActions.push({
        action: `${domain}.turn_on`,
        target: { entity_id: ids },
      })
      offActions.push({
        action: `${domain}.turn_off`,
        target: { entity_id: ids },
      })
    }

    const spec: HAAutomationSpec = {
      alias: `Dispatch: Motion lights (${shortName(motionEntity)})`,
      description:
        `Turn on ${lightEntities.length} light(s) when ${motionEntity} detects motion, ` +
        `for ${durationMinutes} min${onlyAfterSunset ? ', after sunset only' : ''}.`,
      mode: 'restart',
      trigger: [
        {
          trigger: 'state',
          entity_id: motionEntity,
          to: 'on',
        },
      ],
      condition: conditions.length > 0 ? conditions : undefined,
      action: [
        ...onActions,
        { delay: { minutes: durationMinutes } },
        ...offActions,
      ],
    }

    return spec
  },
}

function shortName(entityId: string): string {
  const [, name] = entityId.split('.')
  return (name ?? entityId).replace(/_/g, ' ')
}
