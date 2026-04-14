/**
 * Flow Runner
 *
 * Executes a flow and records the result. Phase 1 implementation:
 * - step.run caches by id within a single execution
 * - step.sleep is a plain setTimeout (not durable — survives restart = Phase 2)
 * - Results go into the `flow_runs` table for history
 *
 * Phase 2 swaps this for Dispatch primitives so sleeps + retries survive
 * restarts and step results memoize across runs.
 */

import type { Flow, FlowContext, FlowResult } from './types.js'
import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { Storage } from '../adapters/index.js'
import type { Recorder } from '../diagnostics/recorder.js'
import { createEntityPublisher } from '../ha/entity-publisher.js'

export interface RunOptions {
  ha: HAClient
  store: AppStore
  storage: Storage
  trigger: 'schedule' | 'event' | 'manual'
  config?: Record<string, unknown>
  recorder?: Recorder
}

export async function runFlow(flow: Flow, opts: RunOptions): Promise<FlowResult> {
  const startedAt = Date.now()
  const runId = `${flow.id}-${startedAt}`
  const stepCache = new Map<string, unknown>()

  const ctx: FlowContext = {
    ha: opts.ha,
    store: opts.store,
    storage: opts.storage,
    config: opts.config ?? {},
    log: (msg, data) => {
      console.log(`[flow:${flow.id}] ${msg}`, data ?? '')
    },
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
    result = {
      status: 'error',
      summary: (e as Error).message,
    }
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

  // Publish any HA entities the flow asked for. Best-effort; failures
  // here don't fail the flow run.
  if (result.publish && result.publish.length > 0 && result.status !== 'error') {
    const publisher = createEntityPublisher(opts.ha)
    publisher.publish(flow.id, result.publish).catch((e) => {
      console.warn(`[flow:${flow.id}] entity publish failed:`, (e as Error).message)
    })
  }

  return result
}
