/**
 * HA automation writer.
 *
 * Lets Dispatch deploy "native" flows as honest-to-goodness Home Assistant
 * automations. We POST a fully-formed automation spec to
 *   /api/config/automation/config/{id}
 * which creates or updates it, then reload to make HA pick it up.
 *
 * Naming convention: every automation ID we create starts with
 *   `dispatch_`
 * so we can identify ours later (listManagedAutomations) without mixing
 * with the user's hand-written automations.
 *
 * Once an automation is in HA, HA owns it: triggers, traces, history,
 * disable/enable in the HA UI all just work. If the user uninstalls
 * Dispatch, the automations stay — no lock-in.
 */

import type { HAClient } from '../ha-client.js'

/**
 * Minimal HA automation spec. We use loose `unknown` for trigger/condition/
 * action arrays because HA's automation schema is wide and we want flow
 * authors to be able to use any platform without us shipping a giant
 * shape repo.
 */
export interface HAAutomationSpec {
  alias: string
  description?: string
  /** single (default), restart, queued, parallel */
  mode?: 'single' | 'restart' | 'queued' | 'parallel'
  trigger: unknown[]
  /** HA accepts this as condition or conditions; we use condition */
  condition?: unknown[]
  action: unknown[]
}

const DISPATCH_TAG = 'dispatch_managed'

export interface AutomationWriter {
  /**
   * Create or update an automation. `id` is the Dispatch flow id (we
   * prefix it with `dispatch_` so HA stores the entity as
   * `automation.dispatch_{flowId}`).
   *
   * Returns the entity_id HA assigned (e.g. "automation.dispatch_motion_lights").
   */
  upsert(flowId: string, spec: HAAutomationSpec): Promise<string>

  /** Remove an automation we previously created. Idempotent. */
  remove(flowId: string): Promise<void>

  /** Get the raw config (or null if not present). */
  get(flowId: string): Promise<HAAutomationSpec | null>

  /** Trigger HA to reload its automations after a write. */
  reload(): Promise<void>
}

export function createAutomationWriter(ha: HAClient): AutomationWriter {
  function automationId(flowId: string): string {
    return `dispatch_${flowId.replace(/-/g, '_')}`
  }
  function entityId(flowId: string): string {
    return `automation.${automationId(flowId)}`
  }

  return {
    async upsert(flowId, spec) {
      const id = automationId(flowId)
      // Embed our tag in the description so we can identify ours later
      // even if the user renames the alias.
      const description = `${spec.description ?? ''}\n\n[${DISPATCH_TAG}]`.trim()
      const body = { ...spec, description }
      const res = await ha.request(`/api/config/automation/config/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        throw new Error(
          `upsert automation ${id} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`,
        )
      }
      await this.reload()
      return entityId(flowId)
    },

    async remove(flowId) {
      const id = automationId(flowId)
      const res = await ha.request(`/api/config/automation/config/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      // 404 is fine — already gone
      if (!res.ok && res.status !== 404) {
        throw new Error(`delete automation ${id} failed: HTTP ${res.status}`)
      }
      await this.reload()
    },

    async get(flowId) {
      const id = automationId(flowId)
      const res = await ha.request(`/api/config/automation/config/${encodeURIComponent(id)}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`get automation ${id} failed: HTTP ${res.status}`)
      return (await res.json()) as HAAutomationSpec
    },

    async reload() {
      await ha.callService({ domain: 'automation', service: 'reload' })
    },
  }
}
