/**
 * Home Assistant WebSocket API client.
 *
 * Connects to HA via the Supervisor API (when running as an add-on)
 * or directly via the HA WebSocket endpoint (for local dev).
 *
 * Provides methods to:
 * - Get all entity states
 * - Get a single entity state
 * - Call a service (e.g., switch.turn_on, number.set_value)
 * - Subscribe to state changes
 * - Get HA configuration (timezone, location, etc.)
 */

import WebSocket from 'ws'

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

type StateChangeCallback = (entityId: string, newState: HAState, oldState: HAState) => void

export class HAClient {
  private ws: WebSocket | null = null
  private msgId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private stateListeners: StateChangeCallback[] = []
  private hassUrl: string
  private token: string
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(hassUrl: string, token: string) {
    this.hassUrl = hassUrl
    this.token = token
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // hassUrl must already point at the WebSocket endpoint (addon mode:
      // ws://supervisor/core/websocket, direct mode: ws://host:8123/api/websocket).
      // Only normalize the scheme so http(s):// is accepted.
      const wsUrl = this.hassUrl.replace(/^http/, 'ws')

      console.log(`[HA] Connecting to ${wsUrl}`)
      this.ws = new WebSocket(wsUrl)

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        this.handleMessage(msg, resolve)
      })

      this.ws.on('error', (err) => {
        console.error('[HA] WebSocket error:', err.message)
        if (!this.connected) reject(err)
      })

      this.ws.on('close', () => {
        console.log('[HA] WebSocket closed')
        this.connected = false
        this.scheduleReconnect()
      })
    })
  }

  private handleMessage(msg: Record<string, unknown>, onConnect?: (v: void) => void) {
    switch (msg.type) {
      case 'auth_required':
        this.ws?.send(JSON.stringify({ type: 'auth', access_token: this.token }))
        break

      case 'auth_ok':
        console.log('[HA] Authenticated successfully')
        this.connected = true
        onConnect?.()
        break

      case 'auth_invalid':
        console.error('[HA] Authentication failed:', msg.message)
        break

      case 'result': {
        const id = msg.id as number
        const pending = this.pending.get(id)
        if (pending) {
          this.pending.delete(id)
          if (msg.success) {
            pending.resolve(msg.result)
          } else {
            pending.reject(new Error(String((msg.error as Record<string, unknown>)?.message ?? 'Unknown error')))
          }
        }
        break
      }

      case 'event': {
        const event = msg.event as Record<string, unknown>
        if ((event?.event_type ?? (event as Record<string, unknown>)?.type) === 'state_changed') {
          const data = (event.data ?? event) as Record<string, unknown>
          const entityId = data.entity_id as string
          const newState = data.new_state as HAState
          const oldState = data.old_state as HAState
          if (entityId && newState) {
            for (const listener of this.stateListeners) {
              try {
                listener(entityId, newState, oldState)
              } catch (e) {
                console.error('[HA] State listener error:', e)
              }
            }
          }
        }
        break
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    console.log('[HA] Reconnecting in 5s...')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
        // Re-subscribe to state changes if we had listeners
        if (this.stateListeners.length > 0) {
          await this.send({ type: 'subscribe_events', event_type: 'state_changed' })
        }
      } catch (e) {
        console.error('[HA] Reconnect failed:', e)
        this.scheduleReconnect()
      }
    }, 5000)
  }

  private send(msg: Record<string, unknown>): Promise<unknown> {
    const id = ++this.msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws?.send(JSON.stringify({ ...msg, id }))

      // Timeout after 10s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`HA request ${id} timed out`))
        }
      }, 10_000)
    })
  }

  /** Get all entity states */
  async getStates(): Promise<HAState[]> {
    return (await this.send({ type: 'get_states' })) as HAState[]
  }

  /** Get a single entity state */
  async getState(entityId: string): Promise<HAState | null> {
    const states = await this.getStates()
    return states.find((s) => s.entity_id === entityId) ?? null
  }

  /** Get multiple entity states at once */
  async getEntityValues(entityIds: string[]): Promise<Record<string, string>> {
    const states = await this.getStates()
    const result: Record<string, string> = {}
    for (const id of entityIds) {
      const state = states.find((s) => s.entity_id === id)
      result[id] = state?.state ?? 'unavailable'
    }
    return result
  }

  /** Get HA configuration (timezone, location, etc.) */
  async getConfig(): Promise<HAConfig> {
    return (await this.send({ type: 'get_config' })) as HAConfig
  }

  /** Call a Home Assistant service */
  async callService(call: HAServiceCall): Promise<unknown> {
    return this.send({
      type: 'call_service',
      domain: call.domain,
      service: call.service,
      target: call.target,
      service_data: call.service_data,
    })
  }

  /** Subscribe to state changes */
  async onStateChange(callback: StateChangeCallback): Promise<void> {
    if (this.stateListeners.length === 0) {
      // First listener — subscribe to events
      await this.send({ type: 'subscribe_events', event_type: 'state_changed' })
    }
    this.stateListeners.push(callback)
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected
  }

  /** Disconnect */
  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
    this.connected = false
  }
}
