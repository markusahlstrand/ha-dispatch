/**
 * sql.js-backed KV + Database adapters.
 *
 * Both adapters share one SQL.Database instance and one `save()` path,
 * so a mutation to either surfaces immediately to the other and a
 * single fsync gives us the full snapshot. Good enough for HA add-on
 * scale; when we host Dispatch on Cloudflare we swap in a D1-backed
 * DatabaseAdapter and a Cloudflare-KV-backed KVAdapter.
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import type { KVAdapter, DatabaseAdapter, SqlValue } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface SqliteBundle {
  kv: KVAdapter
  db: DatabaseAdapter
  raw: SqlJsDatabase
  save: () => void
  close: () => void
}

/** Create a shared sql.js instance with KV + Database adapters on top. */
export async function openSqlite(dbPath: string): Promise<SqliteBundle> {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const SQL = await initSqlJs({
    locateFile: (file: string) => {
      const bundled = `${HERE}/${file}`
      return existsSync(bundled)
        ? bundled
        : `${HERE}/../node_modules/sql.js/dist/${file}`
    },
  })

  const raw: SqlJsDatabase = existsSync(dbPath)
    ? new SQL.Database(readFileSync(dbPath))
    : new SQL.Database()

  raw.run(`
    CREATE TABLE IF NOT EXISTS _kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kv_expires ON _kv(expires_at);
  `)

  const save = () => {
    writeFileSync(dbPath, Buffer.from(raw.export()))
  }
  save()

  const kv: KVAdapter = {
    async get<T>(key: string): Promise<T | undefined> {
      const stmt = raw.prepare(
        `SELECT value, expires_at FROM _kv WHERE key = ?`,
      )
      stmt.bind([key])
      try {
        if (!stmt.step()) return undefined
        const row = stmt.getAsObject() as { value: string; expires_at: number | null }
        if (row.expires_at && row.expires_at < Date.now()) {
          // Expired — best effort delete, return undefined
          stmt.free()
          const del = raw.prepare(`DELETE FROM _kv WHERE key = ?`)
          del.bind([key])
          del.step()
          del.free()
          save()
          return undefined
        }
        try {
          return JSON.parse(row.value) as T
        } catch {
          return row.value as unknown as T
        }
      } finally {
        stmt.free()
      }
    },
    async set(key, value, opts) {
      const expires = opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : null
      const stmt = raw.prepare(
        `INSERT OR REPLACE INTO _kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      stmt.bind([key, JSON.stringify(value), expires, Date.now()])
      stmt.step()
      stmt.free()
      save()
    },
    async delete(key) {
      const stmt = raw.prepare(`DELETE FROM _kv WHERE key = ?`)
      stmt.bind([key])
      stmt.step()
      stmt.free()
      save()
    },
    async list(prefix, limit = 1000) {
      const stmt = raw.prepare(
        `SELECT key FROM _kv WHERE key LIKE ? ORDER BY key LIMIT ?`,
      )
      stmt.bind([`${prefix}%`, limit])
      const out: string[] = []
      while (stmt.step()) {
        out.push((stmt.getAsObject() as { key: string }).key)
      }
      stmt.free()
      return out
    },
  }

  const db: DatabaseAdapter = {
    async query<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const stmt = raw.prepare(sql)
      stmt.bind(params as never)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      stmt.free()
      return rows
    },
    async execute(sql: string, params: SqlValue[] = []): Promise<void> {
      const stmt = raw.prepare(sql)
      stmt.bind(params as never)
      stmt.step()
      stmt.free()
      save()
    },
    async batch(statements) {
      raw.run('BEGIN')
      try {
        for (const s of statements) {
          const stmt = raw.prepare(s.sql)
          if (s.params) stmt.bind(s.params as never)
          stmt.step()
          stmt.free()
        }
        raw.run('COMMIT')
      } catch (e) {
        raw.run('ROLLBACK')
        throw e
      }
      save()
    },
  }

  return {
    kv,
    db,
    raw,
    save,
    close: () => {
      save()
      raw.close()
    },
  }
}
