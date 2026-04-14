/**
 * Flow management API.
 *
 * GET  /api/flows                    List all registered flows + status
 * GET  /api/flows/:id                Flow details (config, last run, etc.)
 * POST /api/flows/:id/run            Trigger a manual run
 * GET  /api/flows/:id/runs           Flow run history
 * GET  /api/flows/:id/config         Get flow-specific config
 * POST /api/flows/:id/config         Update flow-specific config
 * GET  /api/flows/:id/mapping        Get entity mapping (for flows that use it)
 * POST /api/flows/:id/mapping        Save entity mapping
 * POST /api/flows/:id/discover       Run entity discovery (LLM when available)
 */

import { Hono } from 'hono'
import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { Storage } from '../adapters/index.js'
import type { LLMProvider } from '../llm/index.js'
import type { Recorder } from '../diagnostics/recorder.js'
import { listFlows, getFlow } from '../runtime/flow-registry.js'
import { runFlow, disableFlow } from '../runtime/flow-runner.js'
import { isNativeFlow } from '../runtime/types.js'
import { classifyEntities } from '../flows/energy-optimizer/discover.js'
import { classifyEntitiesLLM } from '../flows/energy-optimizer/classify-llm.js'

type Deps = { ha: HAClient; store: AppStore; storage: Storage; llm: LLMProvider | null; recorder: Recorder | null }

export function createFlowsRouter() {
  const app = new Hono<{ Variables: Deps }>()

  // List flows
  app.get('/', async (c) => {
    const store = c.get('store') as AppStore
    const flows = await Promise.all(
      listFlows().map(async (f) => {
        const runs = await store.getFlowRuns(f.id, 1)
        const mapping = await store.getMapping(f.id)
        const native = isNativeFlow(f)
        const haEntityId = native
          ? await store.kvGet<string>(`native:${f.id}:entity_id`)
          : null
        return {
          id: f.id,
          name: f.name,
          description: f.description,
          icon: f.icon,
          mode: native ? 'native' : 'managed',
          triggers: native ? [] : f.triggers,
          lastRun: runs[0] ?? null,
          hasMapping: mapping.length > 0,
          deployed: Boolean(haEntityId),
          haEntityId: haEntityId ?? null,
        }
      }),
    )
    return c.json({ flows })
  })

  // Flow details
  app.get('/:id', async (c) => {
    const flow = getFlow(c.req.param('id'))
    if (!flow) return c.json({ error: 'not_found' }, 404)
    const store = c.get('store') as AppStore
    const native = isNativeFlow(flow)
    const haEntityId = native
      ? await store.kvGet<string>(`native:${flow.id}:entity_id`)
      : null
    return c.json({
      id: flow.id,
      name: flow.name,
      description: flow.description,
      icon: flow.icon,
      mode: native ? 'native' : 'managed',
      triggers: native ? [] : flow.triggers,
      configSchema: flow.configSchema ?? [],
      config: await store.getFlowConfig(flow.id),
      mapping: await store.getMapping(flow.id),
      lastRuns: await store.getFlowRuns(flow.id, 10),
      deployed: Boolean(haEntityId),
      haEntityId: haEntityId ?? null,
    })
  })

  // Disable a (native) flow — removes it from HA. Managed flows: no-op.
  app.post('/:id/disable', async (c) => {
    const flow = getFlow(c.req.param('id'))
    if (!flow) return c.json({ error: 'not_found' }, 404)
    try {
      await disableFlow(flow, {
        ha: c.get('ha') as HAClient,
        store: c.get('store') as AppStore,
      })
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  // Manual run
  app.post('/:id/run', async (c) => {
    const flow = getFlow(c.req.param('id'))
    if (!flow) return c.json({ error: 'not_found' }, 404)

    const ha = c.get('ha') as HAClient
    const store = c.get('store') as AppStore
    const storage = c.get('storage') as Storage
    const config = await store.getFlowConfig(flow.id)

    const recorder = (c.get('recorder') as Recorder | null) ?? undefined
    const result = await runFlow(flow, { ha, store, storage, trigger: 'manual', config, recorder })
    return c.json({ result })
  })

  // Run history
  app.get('/:id/runs', async (c) => {
    const store = c.get('store') as AppStore
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ runs: await store.getFlowRuns(c.req.param('id'), limit) })
  })

  // Config
  app.get('/:id/config', async (c) => {
    const store = c.get('store') as AppStore
    return c.json({ config: await store.getFlowConfig(c.req.param('id')) })
  })

  app.post('/:id/config', async (c) => {
    const store = c.get('store') as AppStore
    const body = (await c.req.json()) as { config: Record<string, unknown> }
    await store.setFlowConfig(c.req.param('id'), body.config ?? {})
    return c.json({ ok: true })
  })

  // Mapping
  app.get('/:id/mapping', async (c) => {
    const store = c.get('store') as AppStore
    return c.json({ mapping: await store.getMapping(c.req.param('id')) })
  })

  app.post('/:id/mapping', async (c) => {
    const store = c.get('store') as AppStore
    const body = (await c.req.json()) as {
      mappings: { role: string; entityId: string; confidence: number }[]
    }
    await store.saveMapping(c.req.param('id'), body.mappings ?? [])
    return c.json({ ok: true })
  })

  // Discovery (currently only for energy-optimizer — flows can
  // register their own discovery in Phase 2).
  // Uses the LLM when an API key is configured; falls back to regex
  // heuristics otherwise.
  app.post('/:id/discover', async (c) => {
    const id = c.req.param('id')
    if (id !== 'energy-optimizer') {
      return c.json({ error: 'discovery not supported for this flow' }, 400)
    }
    const ha = c.get('ha') as HAClient
    const llm = c.get('llm') as LLMProvider | null
    if (llm) {
      try {
        const { candidates, notes } = await classifyEntitiesLLM(ha, llm)
        return c.json({ candidates, notes, source: 'llm' })
      } catch (e) {
        console.warn('[discover] LLM classification failed; falling back:', (e as Error).message)
      }
    }
    const candidates = await classifyEntities(ha)
    return c.json({ candidates, source: 'heuristics' })
  })

  return app
}
