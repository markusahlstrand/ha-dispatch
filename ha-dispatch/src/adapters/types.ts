/**
 * Storage adapter interfaces.
 *
 * Dispatch is designed to run on a range of hosts: locally as an HA
 * add-on (today), on a plain Node server, and on Cloudflare Workers
 * (later, for the hosted SaaS). Each host has different storage
 * primitives. These three interfaces are the seam:
 *
 *   KV        — simple key/value lookups, no queries
 *   Database  — SQL-ish, queryable, for history/mappings/config
 *   Blob      — opaque large values (caches, attachments)
 *
 * A `Storage` bundle groups one implementation of each. Higher-level
 * code consumes the bundle and never touches the underlying driver,
 * so swapping sqlite for D1 or KV-on-disk for Cloudflare KV is a
 * single-file change.
 *
 * Hybrid deployments (some concerns local, some in the cloud) compose
 * multiple concrete adapters behind a routing wrapper — the Storage
 * type doesn't care how it was assembled.
 */

export type SqlValue = null | number | string | Uint8Array

export interface KVAdapter {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string, limit?: number): Promise<string[]>
}

export interface DatabaseAdapter {
  /** SELECT-shaped queries returning rows. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>
  /** Statements without a result set (INSERT/UPDATE/DELETE/DDL). */
  execute(sql: string, params?: SqlValue[]): Promise<void>
  /** Run multiple statements atomically. */
  batch(statements: { sql: string; params?: SqlValue[] }[]): Promise<void>
}

export interface BlobAdapter {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, data: Uint8Array, opts?: { contentType?: string }): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string, limit?: number): Promise<string[]>
}

export interface Storage {
  kv: KVAdapter
  db: DatabaseAdapter
  blob: BlobAdapter
  /** Called on process shutdown; implementations flush and close handles. */
  close(): Promise<void>
}
