/**
 * Diagnostics API.
 *
 * GET    /api/diagnostics            full report (downloadable JSON)
 * GET    /api/diagnostics/events     just the recent events array
 * POST   /api/diagnostics/note       { text }   user-submitted note
 * DELETE /api/diagnostics            clear the buffer
 */

import { Hono } from 'hono'
import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { Recorder } from '../diagnostics/recorder.js'
import { buildReport } from '../diagnostics/report.js'

type Deps = { ha: HAClient; store: AppStore; recorder: Recorder; version: string }

export function createDiagnosticsRouter() {
  const app = new Hono<{ Variables: Deps }>()

  app.get('/', async (c) => {
    const deps = ctxDeps(c)
    const report = await buildReport(deps)
    c.header('Content-Disposition', `attachment; filename="dispatch-report-${Date.now()}.json"`)
    return c.json(report)
  })

  app.get('/events', async (c) => {
    const deps = ctxDeps(c)
    const events = await deps.recorder.list()
    return c.json({ events })
  })

  app.post('/note', async (c) => {
    const deps = ctxDeps(c)
    const body = (await c.req.json()) as { text: string }
    if (!body.text || typeof body.text !== 'string') {
      return c.json({ error: 'text is required' }, 400)
    }
    deps.recorder.record({ type: 'user_note', text: body.text })
    return c.json({ ok: true })
  })

  app.delete('/', async (c) => {
    const deps = ctxDeps(c)
    await deps.recorder.clear()
    return c.json({ ok: true })
  })

  return app
}

function ctxDeps(c: { get: (key: string) => unknown }): Deps {
  return {
    ha: c.get('ha') as HAClient,
    store: c.get('store') as AppStore,
    recorder: c.get('recorder') as Recorder,
    version: (c.get('version') as string) ?? '0.0.0',
  }
}
