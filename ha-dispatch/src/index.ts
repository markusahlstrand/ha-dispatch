/**
 * HA Dispatch — main entry point.
 *
 * Loads config, assembles the Storage bundle (sqlite KV + DB, local
 * Blob), boots the HA client, sets up the flow runtime, and serves
 * the dashboard + API on the port HA Ingress expects.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { loadConfig, debugS6Env } from './config.js'
import { HAClient } from './ha-client.js'
import { createLocalStorage, type Storage } from './adapters/index.js'
import { createAppStore, type AppStore } from './store.js'
import { createFlowsRouter } from './api/flows.js'
import { createChatRouter } from './api/chat.js'
import { createDiagnosticsRouter } from './api/diagnostics.js'
import { createRecorder } from './diagnostics/recorder.js'
import { setLLMObserver } from './llm/types.js'
import { listFlows } from './runtime/flow-registry.js'
import { runFlow } from './runtime/flow-runner.js'
import { createLLM } from './llm/index.js'
import { suggestFlowsLLM } from './runtime/suggest-flows.js'
import { dashboardHtml } from './ui.js'

async function start() {
  const config = loadConfig()
  console.log(`[ha-dispatch] Starting (addon=${config.isAddon}, port=${config.port})`)

  // Storage: sqlite KV + DB + local blob (all under /data).
  // When we host Dispatch on Cloudflare, swap in the D1/KV/R2 bundle here.
  const storage = await createLocalStorage(config.dataDir)
  const store = await createAppStore(storage)
  console.log(`[ha-dispatch] Storage ready at ${config.dataDir}`)

  // Dump both native env keys and any values the Supervisor staged in
  // the s6 container_environment directory (used when we're launched
  // without s6's with-contenv wrapper).
  console.log(`[ha-dispatch] process.env keys: ${Object.keys(process.env).sort().join(' ')}`)
  console.log(`[ha-dispatch] s6 env keys: ${debugS6Env()}`)

  const ha = new HAClient(
    config.hassUrl,
    config.supervisorToken ?? process.env.HASS_TOKEN ?? '',
  )

  // Diagnostics recorder + LLM observer wired up
  const recorder = createRecorder(store)
  setLLMObserver({ onCall: (e) => recorder.record({ type: 'llm_call', ...e }) })

  // LLM provider (null when llm_provider=none or no API key)
  const llm = createLLM(config)
  console.log(
    `[ha-dispatch] LLM: ${llm ? `${llm.id} enabled` : `disabled (provider=${config.llm_provider}, key=${config.llm_api_key ? 'set' : 'missing'})`}`,
  )

  // Hono app
  const app = new Hono()

  app.use('*', async (c, next) => {
    c.set('ha' as never, ha)
    c.set('store' as never, store)
    c.set('storage' as never, storage)
    c.set('llm' as never, llm)
    c.set('recorder' as never, recorder)
    c.set('version' as never, '0.1.17')
    await next()
  })

  // Health
  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      version: '0.1.0',
      connected: ha.isConnected(),
      addon: config.isAddon,
      llm: llm ? llm.id : null,
      flows: listFlows().map((f) => f.id),
    }),
  )

  // Flows router
  app.route('/api/flows', createFlowsRouter())

  // Chat router (persona, onboarding, conversational surface)
  app.route('/api/chat', createChatRouter())

  // Diagnostics router (event buffer + downloadable report)
  app.route('/api/diagnostics', createDiagnosticsRouter())

  // LLM-powered flow suggestions (based on the user's entity inventory)
  app.post('/api/suggestions', async (c) => {
    if (!llm) return c.json({ error: 'llm_disabled', suggestions: [] }, 400)
    try {
      const suggestions = await suggestFlowsLLM(ha, llm)
      return c.json({ suggestions })
    } catch (e) {
      return c.json({ error: (e as Error).message, suggestions: [] }, 500)
    }
  })

  // Dashboard shell (all non-API routes)
  app.get('*', (c) => c.html(dashboardHtml()))

  // Connect to HA (non-blocking — client will auto-reconnect)
  ha.connect()
    .then(() => console.log('[ha-dispatch] Connected to Home Assistant'))
    .catch((e) => {
      console.error('[ha-dispatch] Initial HA connection failed:', e)
      console.log('[ha-dispatch] Will keep retrying in background')
    })

  // Minimal scheduler: tick every minute and run flows whose cron matches
  const scheduler = startScheduler(ha, store, storage, config, recorder)

  // HTTP server
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[ha-dispatch] Server running on http://localhost:${info.port}`)
    if (config.isAddon) console.log('[ha-dispatch] Accessible via HA Ingress')
  })

  // Shutdown
  process.on('SIGTERM', async () => {
    console.log('[ha-dispatch] Shutting down...')
    clearInterval(scheduler)
    ha.disconnect()
    await storage.close()
    process.exit(0)
  })
}

/**
 * Phase 1 scheduler: every minute, check each enabled flow's cron
 * triggers and run them if the minute matches.
 *
 * Phase 2 replaces this with Dispatch DO alarms so scheduled work
 * survives restarts and doesn't double-fire.
 */
function startScheduler(
  ha: HAClient,
  store: AppStore,
  storage: Storage,
  config: ReturnType<typeof loadConfig>,
  recorder: ReturnType<typeof createRecorder>,
) {
  const enabled = new Set(config.enabled_flows)
  return setInterval(async () => {
    const now = new Date()
    for (const flow of listFlows()) {
      if (!enabled.has(flow.id)) continue
      // Only managed flows have schedule triggers; native flows live in HA
      if (flow.mode === 'native') continue
      for (const trigger of flow.triggers) {
        if (trigger.type !== 'schedule' || !trigger.cron) continue
        if (cronMatches(trigger.cron, now)) {
          console.log(`[ha-dispatch] Scheduled run: ${flow.id}`)
          const flowConfig = await store.getFlowConfig(flow.id)
          runFlow(flow, { ha, store, storage, trigger: 'schedule', config: flowConfig, recorder }).catch((e) =>
            console.error(`[ha-dispatch] ${flow.id} failed:`, e),
          )
        }
      }
    }
  }, 60_000)
}

/** Minimal cron matcher: "min hour dom month dow" with only * and numbers. */
function cronMatches(cron: string, d: Date): boolean {
  const parts = cron.split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, month, dow] = parts
  const matches = (field: string, value: number): boolean => {
    if (field === '*') return true
    if (field.startsWith('*/')) return value % Number(field.slice(2)) === 0
    if (field.includes(',')) return field.split(',').some((v) => Number(v) === value)
    if (field.includes('-')) {
      const [a, b] = field.split('-').map(Number)
      return value >= a && value <= b
    }
    return Number(field) === value
  }
  return (
    matches(min, d.getMinutes()) &&
    matches(hour, d.getHours()) &&
    matches(dom, d.getDate()) &&
    matches(month, d.getMonth() + 1) &&
    matches(dow, d.getDay())
  )
}

start().catch((e) => {
  console.error('[ha-dispatch] Fatal error:', e)
  process.exit(1)
})
