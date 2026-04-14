/**
 * Flow Runner
 *
 * Two execution paths:
 *
 *   - Managed flows: we invoke `flow.run(ctx)`, save the result to
 *     flow_runs, optionally publish HA entities. Phase 1 step
 *     primitives are simple wrappers; Phase 2 swaps for DO-backed
 *     durable execution.
 *
 *   - Native flows: we materialize the HAAutomationSpec and POST it to
 *     HA. The "result" we record is just whether the upsert succeeded.
 *     HA owns runtime from then on; HA traces are the run history.
 */

import type { Flow, FlowContext, FlowResult, NativeFlowContext } from './types.js'
import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { Storage } from '../adapters/index.js'
import type { Recorder } from '../diagnostics/recorder.js'
import { isNativeFlow } from './types.js'
import { createEntityPublisher } from '../ha/entity-publisher.js'
import { createAutomationWriter } from '../ha/automation-writer.js'

export interface RunOptions {
  ha: HAClient
  store: AppStore
  storage: Storage
  trigger: 'schedule' | 'event' | 'manual'
  config?: Record<string, unknown>
  recorder?: Recorder | null
}

export async function runFlow(flow: Flow, opts: RunOptions): Promise<FlowResult> {
  return isNativeFlow(flow) ? runNative(flow, opts) : runManaged(flow, opts)
}

async function runManaged(flow: Extract<Flow, { mode?: 'managed' }>, opts: RunOptions): Promise<FlowResult> {
  const startedAt = Date.now()
  const runId = `${flow.id}-${startedAt}`
  const stepCache = new Map<string, unknown>()

  const ctx: FlowContext = {
    ha: opts.ha,
    store: opts.store,
    storage: opts.storage,
    config: opts.config ?? {},
    log: (msg, data) => console.log(`[flow:${flow.id}] ${msg}`, data ?? ''),
    step: {
      async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (stepCache.has(id)) return stepCache.get(id) as T
        const result = await fn()
        stepCache.set(id, result)
        return result
      },
      async sleep(_id: string, ms: number): Promise<void> {
        await new Promise((r) => setTimeout(r, ms))
      },
    },
  }

  let result: FlowResult
  try {
    result = await flow.run(ctx)
  } catch (e) {
    result = { status: 'error', summary: (e as Error).message }
  }

  const finishedAt = Date.now()
  await opts.store.saveFlowRun({
    runId,
    flowId: flow.id,
    trigger: opts.trigger,
    startedAt,
    finishedAt,
    status: result.status,
    summary: result.summary,
    data: result.data,
  })

  opts.recorder?.record({
    type: 'flow_run',
    flowId: flow.id,
    trigger: opts.trigger,
    status: result.status,
    durationMs: finishedAt - startedAt,
    summary: result.summary,
  })

  if (result.publish && result.publish.length > 0 && result.status !== 'error') {
    const publisher = createEntityPublisher(opts.ha)
    publisher.publish(flow.id, result.publish).catch((e) => {
      console.warn(`[flow:${flow.id}] entity publish failed:`, (e as Error).message)
    })
  }

  return result
}

async function runNative(flow: Extract<Flow, { mode: 'native' }>, opts: RunOptions): Promise<FlowResult> {
  const startedAt = Date.now()
  const runId = `${flow.id}-${startedAt}`

  const ctx: NativeFlowContext = {
    ha: opts.ha,
    store: opts.store,
    storage: opts.storage,
    config: opts.config ?? {},
    log: (msg, data) => console.log(`[flow:${flow.id}] ${msg}`, data ?? ''),
  }

  let result: FlowResult
  try {
    const spec = await flow.materialize(ctx)
    if (!spec) {
      result = { status: 'noop', summary: 'Setup required — config incomplete' }
    } else {
      const writer = createAutomationWriter(opts.ha)
      const entityId = await writer.upsert(flow.id, spec)
      // Track which HA entity belongs to this flow
      await opts.store.kvSet(`native:${flow.id}:entity_id`, entityId)
      result = {
        status: 'success',
        summary: `Deployed to HA as ${entityId}`,
        data: { entityId, spec },
      }
    }
  } catch (e) {
    result = { status: 'error', summary: (e as Error).message }
  }

  const finishedAt = Date.now()
  await opts.store.saveFlowRun({
    runId,
    flowId: flow.id,
    trigger: opts.trigger,
    startedAt,
    finishedAt,
    status: result.status,
    summary: result.summary,
    data: result.data,
  })

  opts.recorder?.record({
    type: 'flow_run',
    flowId: flow.id,
    trigger: opts.trigger,
    status: result.status,
    durationMs: finishedAt - startedAt,
    summary: result.summary,
  })

  return result
}

/**
 * Disable a flow. For managed flows this is a no-op (the registry
 * handles it). For native flows we delete the HA automation so it
 * stops triggering.
 */
export async function disableFlow(flow: Flow, opts: { ha: HAClient; store: AppStore }): Promise<void> {
  if (!isNativeFlow(flow)) return
  const writer = createAutomationWriter(opts.ha)
  await writer.remove(flow.id)
  await opts.store.kvSet(`native:${flow.id}:entity_id`, null)
}
