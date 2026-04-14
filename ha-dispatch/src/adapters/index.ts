/**
 * Storage factory.
 *
 * `createLocalStorage` is the default HA add-on bundle: sqlite on disk
 * for KV + Database, a local directory for Blob. Other factories will
 * live here as we add environments:
 *
 *   createCloudflareStorage({ d1, kv, r2 })  // hosted SaaS
 *   createHybridStorage(local, cloud, routes) // privacy-aware split
 *
 * Call sites only see the `Storage` bundle, so the choice of adapters
 * is a composition concern and never leaks into flow/domain code.
 */

import { join } from 'path'
import { openSqlite } from './sqlite.js'
import { createLocalBlob } from './blob-local.js'
import type { Storage } from './types.js'

export async function createLocalStorage(dataDir: string): Promise<Storage> {
  const sqlite = await openSqlite(join(dataDir, 'ha-dispatch.db'))
  const blob = createLocalBlob(join(dataDir, 'blobs'))

  return {
    kv: sqlite.kv,
    db: sqlite.db,
    blob,
    async close() {
      sqlite.close()
    },
  }
}

export type { KVAdapter, DatabaseAdapter, BlobAdapter, Storage, SqlValue } from './types.js'
