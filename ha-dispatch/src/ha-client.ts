/**
 * Home Assistant client.
 *
 * Uses the HA REST API via the Supervisor proxy. The Supervisor rewrites
 * the request with an internal admin token, so our SUPERVISOR_TOKEN (which
 * HA does NOT accept directly on WebSocket) works reliably for REST.
 *
 * Phase 1 needs: get states, get single state, call service, health check.
 * State-change subscriptions are polled via getStates() in the flow runner.
 * We can reintroduce a WebSocket layer later for event-driven flows.
 */

export interface HAState {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed: string
  last_updated: string
}

export interface HAConfig {
  latitude: number
  longitude: number
  elevation: number
  unit_system: Record<string, string>
  location_name: string
  time_zone: string
  currency: string
}

export interface HAServiceCall {
  domain: string
  service: string
  target?: { entity_id: string | string[] }
  service_data?: Record<string, unknown>
}

type StateChangeCallback = (entityId: string, newState: HAState, oldState: HAState | null) => void

export class HAClient {
  private baseUrl: string
  private token: string
  private connected = false
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastStates = new Map<string, HAState>()
  private stateListeners: StateChangeCallback[] = []

  /**
   * @param baseUrl Either an HA REST base (e.g. http://hass:8123) or a
   *   Supervisor-proxied base (http://supervisor/core). A trailing "/api"
   *   is accepted and normalized away.
   */
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl
      .replace(/^ws(s?):/, 'http$1:')
      .replace(/\/+$/, '')
      .replace(/\/websocket$/, '')
      .replace(/\/api$/, '')
    this.token = token
  }

  async connect(): Promise<void> {
    console.log(
      `[HA] Base=${this.baseUrl} tokenLen=${this.token.length} tokenPrefix=${this.token.slice(0, 6)}...`,
    )
    await this.ping()
    console.log('[HA] Connected to Home Assistant')
    this.connected = true
    // Periodic health check so the dashboard "Connected" indicator is accurate.
    this.healthTimer = setInterval(() => {
      this.ping().catch(() => {
        if (this.connected) {
          console.log('[HA] Health check failed; marking disconnected')
          this.connected = false
        }
      }).then(() => {
        if (!this.connected) {
          console.log('[HA] Health check recovered')
          this.connected = true
        }
      })
    }, 30_000)
  }

  private async ping(): Promise<void> {
    // /api/config is a low-cost, well-defined endpoint: any authed caller
    // can read it, and HA returns 200 with a small JSON payload.
    const res = await this.fetch('/api/config')
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `HA ping failed: HTTP ${res.status} ${res.statusText} body=${body.slice(0, 120)}`,
      )
    }
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    return fetch(this.baseUrl + path, { ...init, headers })
  }

  async getStates(): Promise<HAState[]> {
    const res = await this.fetch('/api/states')
    if (!res.ok) throw new Error(`getStates failed: HTTP ${res.status}`)
    return (await res.json()) as HAState[]
  }

  async getState(entityId: string): Promise<HAState | null> {
    const res = await this.fetch(`/api/states/${encodeURIComponent(entityId)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`getState failed: HTTP ${res.status}`)
    return (await res.json()) as HAState
  }

  async getEntityValues(entityIds: string[]): Promise<Record<string, string>> {
    const states = await this.getStates()
    const result: Record<string, string> = {}
    const byId = new Map(states.map((s) => [s.entity_id, s]))
    for (const id of entityIds) {
      result[id] = byId.get(id)?.state ?? 'unavailable'
    }
    return result
  }

  async getConfig(): Promise<HAConfig> {
    const res = await this.fetch('/api/config')
    if (!res.ok) throw new Error(`getConfig failed: HTTP ${res.status}`)
    return (await res.json()) as HAConfig
  }

  /**
   * Authenticated request to an arbitrary HA REST path. Used by adapters
   * that need to hit endpoints we don't wrap in this client (automation
   * config, conversation API, etc.). Reuses our base URL and bearer token.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, init)
  }

  /**
   * POST a state to HA — creates the entity on first call and updates it
   * thereafter. Used by the entity publisher to expose flow state as
   * first-class HA sensors / binary_sensors.
   */
  async postState(
    entityId: string,
    state: string,
    attributes: Record<string, unknown> = {},
  ): Promise<void> {
    const res = await this.fetch(`/api/states/${encodeURIComponent(entityId)}`, {
      method: 'POST',
      body: JSON.stringify({ state, attributes }),
    })
    if (!res.ok) throw new Error(`postState ${entityId} failed: HTTP ${res.status}`)
  }

  async callService(call: HAServiceCall): Promise<unknown> {
    const body: Record<string, unknown> = { ...(call.service_data ?? {}) }
    if (call.target?.entity_id) {
      body.entity_id = call.target.entity_id
    }
    const res = await this.fetch(`/api/services/${call.domain}/${call.service}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`callService failed: HTTP ${res.status}`)
    return res.json()
  }

  /**
   * Polling-based state-change subscription. Calls the listener whenever
   * an entity's state changes. Simple but sufficient for Phase 1 flows
   * that only care about slow-changing state.
   */
  async onStateChange(callback: StateChangeCallback, intervalMs = 10_000): Promise<void> {
    this.stateListeners.push(callback)
    if (this.pollTimer) return

    // Prime the cache
    for (const s of await this.getStates()) this.lastStates.set(s.entity_id, s)

    this.pollTimer = setInterval(async () => {
      try {
        const current = await this.getStates()
        for (const s of current) {
          const prev = this.lastStates.get(s.entity_id) ?? null
          if (!prev || prev.state !== s.state || prev.last_updated !== s.last_updated) {
            this.lastStates.set(s.entity_id, s)
            for (const l of this.stateListeners) {
              try {
                l(s.entity_id, s, prev)
              } catch (e) {
                console.error('[HA] State listener error:', e)
              }
            }
          }
        }
      } catch (e) {
        // swallow; health check will flip connected
      }
    }, intervalMs)
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect() {
    if (this.healthTimer) clearInterval(this.healthTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.healthTimer = null
    this.pollTimer = null
    this.connected = false
  }
}
