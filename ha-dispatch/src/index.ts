/**
 * HA Dispatch — main entry point.
 *
 * Loads config, boots the HA client, sets up the flow runtime, and
 * serves the dashboard + API on the port HA Ingress expects.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { join } from 'path'
import { loadConfig, debugS6Env } from './config.js'
import { HAClient } from './ha-client.js'
import { createDatabase } from './db.js'
import { createFlowsRouter } from './api/flows.js'
import { listFlows, getFlow } from './runtime/flow-registry.js'
import { runFlow } from './runtime/flow-runner.js'
import { dashboardHtml } from './ui.js'

async function start() {
  const config = loadConfig()
  console.log(`[ha-dispatch] Starting (addon=${config.isAddon}, port=${config.port})`)

  // DB
  const db = await createDatabase(join(config.dataDir, 'ha-dispatch.db'))
  console.log(`[ha-dispatch] Database ready at ${config.dataDir}/ha-dispatch.db`)

  // Dump both native env keys and any values the Supervisor staged in
  // the s6 container_environment directory (used when we're launched
  // without s6's with-contenv wrapper).
  console.log(`[ha-dispatch] process.env keys: ${Object.keys(process.env).sort().join(' ')}`)
  console.log(`[ha-dispatch] s6 env keys: ${debugS6Env()}`)

  const ha = new HAClient(
    config.hassUrl,
    config.supervisorToken ?? process.env.HASS_TOKEN ?? '',
  )

  // Hono app
  const app = new Hono()

  app.use('*', async (c, next) => {
    c.set('ha' as never, ha)
    c.set('db' as never, db)
    await next()
  })

  // Health
  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      version: '0.1.0',
      connected: ha.isConnected(),
      addon: config.isAddon,
      flows: listFlows().map((f) => f.id),
    }),
  )

  // Flows router
  app.route('/api/flows', createFlowsRouter())

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
  const scheduler = startScheduler(ha, db, config)

  // HTTP server
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[ha-dispatch] Server running on http://localhost:${info.port}`)
    if (config.isAddon) console.log('[ha-dispatch] Accessible via HA Ingress')
  })

  // Shutdown
  process.on('SIGTERM', () => {
    console.log('[ha-dispatch] Shutting down...')
    clearInterval(scheduler)
    ha.disconnect()
    db.close()
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
function startScheduler(ha: HAClient, db: Awaited<ReturnType<typeof createDatabase>>, config: ReturnType<typeof loadConfig>) {
  const enabled = new Set(config.enabled_flows)
  return setInterval(async () => {
    const now = new Date()
    for (const flow of listFlows()) {
      if (!enabled.has(flow.id)) continue
      for (const trigger of flow.triggers) {
        if (trigger.type !== 'schedule' || !trigger.cron) continue
        if (cronMatches(trigger.cron, now)) {
          console.log(`[ha-dispatch] Scheduled run: ${flow.id}`)
          const flowConfig = db.getFlowConfig(flow.id)
          runFlow(flow, { ha, db, trigger: 'schedule', config: flowConfig }).catch((e) =>
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
  const matches = (field: string, value: number, max: number): boolean => {
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
    matches(min, d.getMinutes(), 59) &&
    matches(hour, d.getHours(), 23) &&
    matches(dom, d.getDate(), 31) &&
    matches(month, d.getMonth() + 1, 12) &&
    matches(dow, d.getDay(), 6)
  )
}

start().catch((e) => {
  console.error('[ha-dispatch] Fatal error:', e)
  process.exit(1)
})
