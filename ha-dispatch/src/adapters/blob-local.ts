/**
 * Local filesystem Blob adapter.
 *
 * Stores blobs as files under a root directory. Keys may contain `/`
 * which maps to subdirectories. Good enough for HA's `/data/blobs/`;
 * trivially replaceable by R2/S3 in hosted environments.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative } from 'path'
import type { BlobAdapter } from './types.js'

export function createLocalBlob(root: string): BlobAdapter {
  if (!existsSync(root)) mkdirSync(root, { recursive: true })

  function keyToPath(key: string): string {
    // Strip leading slashes and reject path traversal
    const safe = key.replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '')
    return join(root, safe)
  }

  return {
    async get(key) {
      const path = keyToPath(key)
      if (!existsSync(path)) return null
      return new Uint8Array(readFileSync(path))
    },
    async put(key, data) {
      const path = keyToPath(key)
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, Buffer.from(data))
    },
    async delete(key) {
      const path = keyToPath(key)
      if (existsSync(path)) unlinkSync(path)
    },
    async list(prefix, limit = 1000) {
      const searchRoot = keyToPath(prefix)
      const results: string[] = []
      const base = existsSync(searchRoot) && statSync(searchRoot).isDirectory()
        ? searchRoot
        : root
      walk(base, root, results, limit)
      return results.filter((k) => k.startsWith(prefix)).slice(0, limit)
    },
  }
}

function walk(dir: string, base: string, out: string[], limit: number) {
  if (out.length >= limit) return
  for (const entry of readdirSync(dir)) {
    if (out.length >= limit) return
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      walk(p, base, out, limit)
    } else {
      out.push(relative(base, p).replace(/\\/g, '/'))
    }
  }
}
