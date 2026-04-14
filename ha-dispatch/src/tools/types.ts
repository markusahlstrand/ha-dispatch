/**
 * Tool framework for the chat agent.
 *
 * A Tool is a callable function the LLM can ask us to execute. Each tool
 * carries its own JSON-schema for arguments + a typed handler. Tools are
 * grouped into a Toolkit (a registry) which the chat loop assembles per
 * request from the available capabilities (HA, Shelly, internal flows...).
 *
 * Discipline:
 *  - Tools never depend on the chat module — they just take ToolContext
 *    (HA, store, recorder) and return a plain JSON-serialisable value.
 *  - Side-effecting tools (call_service, run_flow) verify the outcome
 *    where possible and return both the request and the verified state.
 *  - Errors are returned as `{ error: '...' }` rather than thrown so the
 *    LLM can see what went wrong and react.
 */

import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { Storage } from '../adapters/index.js'
import type { Recorder } from '../diagnostics/recorder.js'
import type { ToolSpec } from '../llm/types.js'

export interface ToolContext {
  ha: HAClient
  store: AppStore
  storage?: Storage
  recorder?: Recorder | null
}

export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  spec: ToolSpec
  execute(ctx: ToolContext, args: Args): Promise<Result>
}

export type ToolResult =
  | { ok: true; data: unknown; verified?: boolean; verificationNote?: string }
  | { ok: false; error: string }

export interface Toolkit {
  list(): ToolSpec[]
  call(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult>
}

export function createToolkit(tools: Tool<Record<string, unknown>, unknown>[]): Toolkit {
  const byName = new Map(tools.map((t) => [t.spec.name, t]))
  return {
    list() {
      return tools.map((t) => t.spec)
    },
    async call(ctx, name, args) {
      const tool = byName.get(name)
      if (!tool) return { ok: false, error: `unknown tool: ${name}` }
      const startedAt = Date.now()
      try {
        const data = await tool.execute(ctx, args)
        ctx.recorder?.record({
          type: 'ha_call',
          method: 'TOOL',
          path: name,
          status: 200,
          durationMs: Date.now() - startedAt,
        })
        // The tool may have returned `{ verified: false, ... }` itself —
        // pass through any verification metadata it surfaces.
        if (data && typeof data === 'object' && 'verified' in (data as object)) {
          const d = data as { verified?: boolean; verificationNote?: string }
          return { ok: true, data, verified: d.verified, verificationNote: d.verificationNote }
        }
        return { ok: true, data }
      } catch (e) {
        ctx.recorder?.record({
          type: 'ha_call',
          method: 'TOOL',
          path: name,
          status: 500,
          durationMs: Date.now() - startedAt,
          error: (e as Error).message,
        })
        return { ok: false, error: (e as Error).message }
      }
    },
  }
}
