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
import type { Database } from '../db.js'

export interface RunOptions {
  ha: HAClient
  db: Database
  trigger: 'schedule' | 'event' | 'manual'
  config?: Record<string, unknown>
}

export async function runFlow(flow: Flow, opts: RunOptions): Promise<FlowResult> {
  const startedAt = Date.now()
  const runId = `${flow.id}-${startedAt}`
  const stepCache = new Map<string, unknown>()

  const ctx: FlowContext = {
    ha: opts.ha,
    db: opts.db,
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

  // Record in history
  opts.db.saveFlowRun({
    runId,
    flowId: flow.id,
    trigger: opts.trigger,
    startedAt,
    finishedAt: Date.now(),
    status: result.status,
    summary: result.summary,
    data: result.data,
  })

  return result
}
