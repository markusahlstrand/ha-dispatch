/**
 * Shelly RPC client (Gen2+).
 *
 * Talks to a Shelly device over HTTP RPC (POST /rpc). Supports optional
 * HTTP digest auth when the device has `auth_en: true`. Handles just
 * what the agent needs right now — device info, status snapshots, raw
 * method dispatch, and script lifecycle.
 *
 * All errors are thrown — callers (tools) convert to `{ ok: false, error }`
 * so the LLM can see what went wrong.
 */

import type { ShellyDeviceInfo, ShellyScriptEntry } from './types.js'
import { createHash } from 'crypto'

const DEFAULT_TIMEOUT_MS = 10_000

export interface ShellyClientOptions {
  address: string
  password?: string
  username?: string // always 'admin' for Shelly Gen2+, exposed for flexibility
  timeoutMs?: number
}

export interface ShellyRPCClient {
  info(): Promise<ShellyDeviceInfo>
  status(): Promise<Record<string, unknown>>
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  scriptList(): Promise<ShellyScriptEntry[]>
  scriptCreate(name: string): Promise<{ id: number }>
  scriptPutCode(id: number, code: string): Promise<void>
  scriptStart(id: number): Promise<void>
  scriptStop(id: number): Promise<void>
  scriptDelete(id: number): Promise<void>
  /** Convenience: create (or find), upload code, and start. Returns the script id. */
  installScript(opts: { name: string; code: string; autostart?: boolean }): Promise<{ id: number; created: boolean }>
}

export function createShellyClient(opts: ShellyClientOptions): ShellyRPCClient {
  const base = opts.address.startsWith('http') ? opts.address : `http://${opts.address}`
  const username = opts.username ?? 'admin'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /**
   * POST to /rpc, transparently retrying once with digest auth on 401.
   * Shelly Gen2+ digest uses the body SHA-256 as part of the challenge,
   * so we compute it after the server gives us the www-authenticate header.
   */
  async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const rpcBody = { id: Date.now() & 0x7fffffff, src: 'dispatch', method, params: params ?? {} }
    const bodyStr = JSON.stringify(rpcBody)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let res = await timeoutFetch(`${base}/rpc`, { method: 'POST', headers, body: bodyStr }, timeoutMs)
    if (res.status === 401 && opts.password) {
      const ch = res.headers.get('www-authenticate') || ''
      headers['Authorization'] = buildDigestHeader(ch, username, opts.password, bodyStr)
      res = await timeoutFetch(`${base}/rpc`, { method: 'POST', headers, body: bodyStr }, timeoutMs)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Shelly ${method} HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as { result?: T; error?: { code: number; message: string } }
    if (data.error) throw new Error(`Shelly ${method} error ${data.error.code}: ${data.error.message}`)
    return data.result as T
  }

  return {
    info: () => rpc<ShellyDeviceInfo>('Shelly.GetDeviceInfo'),
    status: () => rpc<Record<string, unknown>>('Shelly.GetStatus'),
    call: <T>(method: string, params?: Record<string, unknown>) => rpc<T>(method, params),
    scriptList: async () => (await rpc<{ scripts: ShellyScriptEntry[] }>('Script.List')).scripts ?? [],
    scriptCreate: (name) => rpc<{ id: number }>('Script.Create', { name }),
    scriptPutCode: async (id, code) => {
      // Shelly devices have a per-chunk size limit (~1024 bytes) — split and
      // send sequentially, first call has append=false to clear any old code.
      const CHUNK = 1024
      for (let i = 0; i < Math.max(1, Math.ceil(code.length / CHUNK)); i++) {
        const chunk = code.slice(i * CHUNK, (i + 1) * CHUNK)
        await rpc<void>('Script.PutCode', { id, code: chunk, append: i > 0 })
      }
    },
    scriptStart: async (id) => {
      await rpc<void>('Script.Start', { id })
    },
    scriptStop: async (id) => {
      await rpc<void>('Script.Stop', { id })
    },
    scriptDelete: async (id) => {
      await rpc<void>('Script.Delete', { id })
    },
    async installScript({ name, code, autostart = true }) {
      const list = await rpc<{ scripts: ShellyScriptEntry[] }>('Script.List')
      const existing = list.scripts?.find((s) => s.name === name)
      let id: number
      let created = false
      if (existing) {
        id = existing.id
        if (existing.running) await rpc<void>('Script.Stop', { id })
      } else {
        id = (await rpc<{ id: number }>('Script.Create', { name })).id
        created = true
      }
      // Upload via chunked PutCode
      const CHUNK = 1024
      for (let i = 0; i < Math.max(1, Math.ceil(code.length / CHUNK)); i++) {
        const chunk = code.slice(i * CHUNK, (i + 1) * CHUNK)
        await rpc<void>('Script.PutCode', { id, code: chunk, append: i > 0 })
      }
      // Make sure enable=true so it starts on boot
      await rpc<void>('Script.SetConfig', { id, config: { enable: autostart } }).catch(() => {})
      if (autostart) await rpc<void>('Script.Start', { id })
      return { id, created }
    },
  }
}

function timeoutFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer))
}

/**
 * Build an HTTP Digest Authorization header for Shelly Gen2+.
 * Shelly implements RFC 7616 with SHA-256 and auth-int-style body hashing.
 */
function buildDigestHeader(
  wwwAuth: string,
  username: string,
  password: string,
  body: string,
): string {
  const params = parseDigestChallenge(wwwAuth)
  const realm = params.realm ?? 'shelly'
  const nonce = params.nonce ?? ''
  const qop = params.qop ?? 'auth'
  const algorithm = (params.algorithm ?? 'SHA-256').toUpperCase()
  const hash = (s: string) => createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex')

  const ha1 = hash(`${username}:${realm}:${password}`)
  const bodyHash = hash(body)
  const ha2 = hash(`POST:/rpc:${bodyHash}`)
  const nc = '00000001'
  const cnonce = Math.random().toString(36).slice(2, 10)
  const response = hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)

  return [
    'Digest',
    [
      `username="${username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="/rpc"`,
      `qop=${qop}`,
      `nc=${nc}`,
      `cnonce="${cnonce}"`,
      `response="${response}"`,
      `algorithm=${algorithm}`,
    ].join(', '),
  ].join(' ')
}

function parseDigestChallenge(header: string): Record<string, string> {
  // Strip leading "Digest "
  const body = header.replace(/^Digest\s+/i, '')
  const out: Record<string, string> = {}
  // Split on commas outside of quotes
  for (const part of splitKV(body)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function splitKV(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') depth = depth === 0 ? 1 : 0
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}
