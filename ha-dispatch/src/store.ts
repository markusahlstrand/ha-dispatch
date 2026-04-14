/**
 * Domain store.
 *
 * Higher-level typed helpers built on top of the Storage adapters.
 * Call sites use `store.saveFlowRun(...)` etc. and never touch SQL or
 * KV keys directly. This is the line that separates "what Dispatch
 * knows about" from "where it's stored" — everything above is portable,
 * everything below is swappable.
 */

import type { Storage } from './adapters/index.js'

export interface FlowRun {
  runId: string
  flowId: string
  trigger: string
  startedAt: number
  finishedAt: number
  status: string
  summary: string
  data?: unknown
}

export interface EntityMapping {
  role: string
  flowId: string
  entityId: string
  confidence: number
  updatedAt: number
}

export interface AppStore {
  // Flow runs
  saveFlowRun(run: FlowRun): Promise<void>
  getFlowRuns(flowId?: string, limit?: number): Promise<FlowRun[]>

  // Per-flow config
  getFlowConfig(flowId: string): Promise<Record<string, unknown>>
  setFlowConfig(flowId: string, config: Record<string, unknown>): Promise<void>

  // Entity mapping per flow
  getMapping(flowId: string): Promise<EntityMapping[]>
  getMappingByRole(flowId: string, role: string): Promise<EntityMapping | undefined>
  saveMapping(flowId: string, mappings: Omit<EntityMapping, 'updatedAt' | 'flowId'>[]): Promise<void>

  // Generic KV passthrough for flow-scoped state (latest plan, caches, etc.)
  kvGet<T>(key: string): Promise<T | undefined>
  kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<void>
}

export async function createAppStore(storage: Storage): Promise<AppStore> {
  const { kv, db } = storage

  // One-time schema init for domain tables.
  await db.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS flow_runs (
        run_id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        data TEXT
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_flow_runs_flow_id ON flow_runs(flow_id, started_at DESC)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS flow_config (
        flow_id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS entity_mapping (
        flow_id TEXT NOT NULL,
        role TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (flow_id, role)
      )`,
    },
  ])

  return {
    async saveFlowRun(r) {
      await db.execute(
        `INSERT OR REPLACE INTO flow_runs (run_id, flow_id, trigger, started_at, finished_at, status, summary, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.runId,
          r.flowId,
          r.trigger,
          r.startedAt,
          r.finishedAt,
          r.status,
          r.summary,
          JSON.stringify(r.data ?? null),
        ],
      )
    },
    async getFlowRuns(flowId, limit = 50) {
      const rows = flowId
        ? await db.query<Record<string, unknown>>(
            `SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?`,
            [flowId, limit],
          )
        : await db.query<Record<string, unknown>>(
            `SELECT * FROM flow_runs ORDER BY started_at DESC LIMIT ?`,
            [limit],
          )
      return rows.map((r) => ({
        runId: r.run_id as string,
        flowId: r.flow_id as string,
        trigger: r.trigger as string,
        startedAt: r.started_at as number,
        finishedAt: r.finished_at as number,
        status: r.status as string,
        summary: r.summary as string,
        data: r.data ? JSON.parse(r.data as string) : undefined,
      }))
    },
    async getFlowConfig(flowId) {
      const rows = await db.query<{ config: string }>(
        `SELECT config FROM flow_config WHERE flow_id = ?`,
        [flowId],
      )
      if (rows.length === 0) return {}
      try {
        return JSON.parse(rows[0].config) as Record<string, unknown>
      } catch {
        return {}
      }
    },
    async setFlowConfig(flowId, config) {
      await db.execute(
        `INSERT OR REPLACE INTO flow_config (flow_id, config, updated_at) VALUES (?, ?, ?)`,
        [flowId, JSON.stringify(config), Date.now()],
      )
    },
    async getMapping(flowId) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT * FROM entity_mapping WHERE flow_id = ?`,
        [flowId],
      )
      return rows.map((r) => ({
        role: r.role as string,
        flowId: r.flow_id as string,
        entityId: r.entity_id as string,
        confidence: r.confidence as number,
        updatedAt: r.updated_at as number,
      }))
    },
    async getMappingByRole(flowId, role) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT * FROM entity_mapping WHERE flow_id = ? AND role = ?`,
        [flowId, role],
      )
      if (rows.length === 0) return undefined
      const r = rows[0]
      return {
        role: r.role as string,
        flowId: r.flow_id as string,
        entityId: r.entity_id as string,
        confidence: r.confidence as number,
        updatedAt: r.updated_at as number,
      }
    },
    async saveMapping(flowId, mappings) {
      const now = Date.now()
      const statements: { sql: string; params: (string | number)[] }[] = [
        { sql: `DELETE FROM entity_mapping WHERE flow_id = ?`, params: [flowId] },
      ]
      for (const m of mappings) {
        statements.push({
          sql: `INSERT INTO entity_mapping (flow_id, role, entity_id, confidence, updated_at) VALUES (?, ?, ?, ?, ?)`,
          params: [flowId, m.role, m.entityId, m.confidence, now],
        })
      }
      await db.batch(statements)
    },
    async kvGet(key) {
      return kv.get(key)
    },
    async kvSet(key, value, ttlSeconds) {
      return kv.set(key, value, ttlSeconds ? { ttlSeconds } : undefined)
    },
  }
}
