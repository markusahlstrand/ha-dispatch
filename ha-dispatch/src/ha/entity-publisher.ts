/**
 * HA entity publisher.
 *
 * Lets a Dispatch flow expose its internal state as first-class Home
 * Assistant entities (sensors, binary sensors, switches). HA discovers
 * them automatically and the user can drop them on Lovelace cards, use
 * them in their own automations, or query them from voice assistants.
 *
 * We use HA's REST `/api/states/{entity_id}` endpoint which creates the
 * entity on first publish and updates it on subsequent calls. No MQTT or
 * config flow required — works on any HA install.
 *
 * Publishing is opt-in per flow: a flow returns `publish: [...]` in its
 * FlowResult and the runner pushes those specs after a successful run.
 *
 * Naming convention: `sensor.dispatch_{flow_id}_{key}` so all our
 * sensors group under the `dispatch_` prefix and don't collide with
 * other integrations.
 */

import type { HAClient } from '../ha-client.js'

export interface PublishSpec {
  /** Short slug, no domain prefix; e.g. 'savings_today' */
  key: string
  /** State value — coerced to string */
  state: string | number | boolean | null
  /** Human-readable label (defaults to a title-cased version of the key) */
  name?: string
  /** Domain to publish under. Defaults to 'sensor'. */
  domain?: 'sensor' | 'binary_sensor'
  /** HA device_class (power, energy, monetary, timestamp, ...) */
  deviceClass?: string
  /** Unit of measurement, e.g. 'EUR', 'W', 'kWh', '%' */
  unit?: string
  /** state_class for energy dashboard integration ('measurement' | 'total' | 'total_increasing') */
  stateClass?: 'measurement' | 'total' | 'total_increasing'
  /** Free-form attributes attached to the state */
  attributes?: Record<string, unknown>
  /** Optional HA icon (mdi:...) */
  icon?: string
}

export interface EntityPublisher {
  publish(flowId: string, specs: PublishSpec[]): Promise<void>
}

export function createEntityPublisher(ha: HAClient): EntityPublisher {
  return {
    async publish(flowId, specs) {
      if (!ha.isConnected()) return
      const flowSlug = flowId.replace(/-/g, '_')
      await Promise.all(
        specs.map((spec) => publishOne(ha, flowSlug, spec)),
      )
    },
  }
}

async function publishOne(ha: HAClient, flowSlug: string, spec: PublishSpec): Promise<void> {
  const domain = spec.domain ?? 'sensor'
  const entityId = `${domain}.dispatch_${flowSlug}_${spec.key}`
  const stateValue =
    spec.state === null
      ? 'unknown'
      : typeof spec.state === 'boolean'
        ? spec.state ? 'on' : 'off'
        : String(spec.state)

  const attributes: Record<string, unknown> = {
    friendly_name: spec.name ?? defaultFriendlyName(flowSlug, spec.key),
    ...(spec.deviceClass ? { device_class: spec.deviceClass } : {}),
    ...(spec.unit ? { unit_of_measurement: spec.unit } : {}),
    ...(spec.stateClass ? { state_class: spec.stateClass } : {}),
    ...(spec.icon ? { icon: spec.icon } : {}),
    ...(spec.attributes ?? {}),
  }

  try {
    await haPostState(ha, entityId, stateValue, attributes)
  } catch (e) {
    console.warn(`[publisher] failed to publish ${entityId}: ${(e as Error).message}`)
  }
}

function defaultFriendlyName(flowSlug: string, key: string): string {
  const titled = (s: string) =>
    s
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  return `Dispatch ${titled(flowSlug)} ${titled(key)}`
}

/**
 * Direct REST POST to HA's /api/states/{entity_id}. We reuse the
 * HAClient's auth and base URL by accessing its internal fetch helper.
 * To keep HAClient's public API small, we expose a `postState` method
 * on it (added separately).
 */
async function haPostState(
  ha: HAClient,
  entityId: string,
  state: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  await ha.postState(entityId, state, attributes)
}
