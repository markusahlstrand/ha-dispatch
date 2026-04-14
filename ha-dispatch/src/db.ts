/**
 * SQLite state store for HA Dispatch.
 *
 * Uses sql.js (WebAssembly SQLite) — no native compilation, works everywhere
 * the add-on runs. Each mutation persists the database file synchronously.
 *
 * Schema:
 *  - flow_runs: history of every flow execution
 *  - flow_config: per-flow configuration (set by the user in the UI)
 *  - entity_mapping: generic role -> entity_id map used by flows
 *  - kv: catch-all key-value store for flow-specific state
 */

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

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

export interface Database {
  // Flow runs
  saveFlowRun(run: FlowRun): void
  getFlowRuns(flowId?: string, limit?: number): FlowRun[]

  // Flow config
  getFlowConfig(flowId: string): Record<string, unknown>
  setFlowConfig(flowId: string, config: Record<string, unknown>): void

  // Entity mapping (shared by flows)
  getMapping(flowId: string): EntityMapping[]
  getMappingByRole(flowId: string, role: string): EntityMapping | undefined
  saveMapping(flowId: string, mappings: Omit<EntityMapping, 'updatedAt' | 'flowId'>[]): void

  // KV
  kvGet<T>(key: string): T | undefined
  kvSet(key: string, value: unknown): void

  // Lifecycle
  close(): void
}

export async function createDatabase(dbPath: string): Promise<Database> {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const SQL = await initSqlJs({})

  let db: SqlJsDatabase
  if (existsSync(dbPath)) {
    db = new SQL.Database(readFileSync(dbPath))
  } else {
    db = new SQL.Database()
  }

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS flow_runs (
      run_id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_flow_runs_flow_id ON flow_runs(flow_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS flow_config (
      flow_id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_mapping (
      flow_id TEXT NOT NULL,
      role TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (flow_id, role)
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  const save = () => {
    writeFileSync(dbPath, Buffer.from(db.export()))
  }
  save()

  function query<T>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
    stmt.free()
    return rows
  }

  function run(sql: string, params: SqlValue[] = []) {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    stmt.step()
    stmt.free()
    save()
  }

  return {
    saveFlowRun(r) {
      run(
        `INSERT OR REPLACE INTO flow_runs (run_id, flow_id, trigger, started_at, finished_at, status, summary, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.runId, r.flowId, r.trigger, r.startedAt, r.finishedAt, r.status, r.summary, JSON.stringify(r.data ?? null)],
      )
    },
    getFlowRuns(flowId, limit = 50) {
      const rows = flowId
        ? query<any>(
            `SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?`,
            [flowId, limit],
          )
        : query<any>(`SELECT * FROM flow_runs ORDER BY started_at DESC LIMIT ?`, [limit])
      return rows.map((r) => ({
        runId: r.run_id,
        flowId: r.flow_id,
        trigger: r.trigger,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status,
        summary: r.summary,
        data: r.data ? JSON.parse(r.data) : undefined,
      }))
    },
    getFlowConfig(flowId) {
      const rows = query<any>(`SELECT config FROM flow_config WHERE flow_id = ?`, [flowId])
      if (rows.length === 0) return {}
      try {
        return JSON.parse(rows[0].config)
      } catch {
        return {}
      }
    },
    setFlowConfig(flowId, config) {
      run(
        `INSERT OR REPLACE INTO flow_config (flow_id, config, updated_at) VALUES (?, ?, ?)`,
        [flowId, JSON.stringify(config), Date.now()],
      )
    },
    getMapping(flowId) {
      return query<any>(`SELECT * FROM entity_mapping WHERE flow_id = ?`, [flowId]).map((r) => ({
        role: r.role,
        flowId: r.flow_id,
        entityId: r.entity_id,
        confidence: r.confidence,
        updatedAt: r.updated_at,
      }))
    },
    getMappingByRole(flowId, role) {
      const rows = query<any>(
        `SELECT * FROM entity_mapping WHERE flow_id = ? AND role = ?`,
        [flowId, role],
      )
      if (rows.length === 0) return undefined
      const r = rows[0]
      return {
        role: r.role,
        flowId: r.flow_id,
        entityId: r.entity_id,
        confidence: r.confidence,
        updatedAt: r.updated_at,
      }
    },
    saveMapping(flowId, mappings) {
      const now = Date.now()
      run(`DELETE FROM entity_mapping WHERE flow_id = ?`, [flowId])
      for (const m of mappings) {
        run(
          `INSERT INTO entity_mapping (flow_id, role, entity_id, confidence, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [flowId, m.role, m.entityId, m.confidence, now],
        )
      }
    },
    kvGet<T>(key: string): T | undefined {
      const rows = query<any>(`SELECT value FROM kv WHERE key = ?`, [key])
      if (rows.length === 0) return undefined
      try {
        return JSON.parse(rows[0].value) as T
      } catch {
        return undefined
      }
    },
    kvSet(key, value) {
      run(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`,
        [key, JSON.stringify(value), Date.now()],
      )
    },
    close() {
      save()
      db.close()
    },
  }
}
