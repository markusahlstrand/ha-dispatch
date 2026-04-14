/**
 * Chat API.
 *
 * GET    /api/chat              opening message + history + persona + templates
 * POST   /api/chat              { text } -> reply (free-form)
 * POST   /api/chat/action       structured action (set_names, set_interests, finish_onboarding)
 * DELETE /api/chat              wipe history (keeps persona)
 * GET    /api/chat/inventory    introspect what the assistant can see
 */

import { Hono } from 'hono'
import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { LLMProvider } from '../llm/index.js'
import type { Recorder } from '../diagnostics/recorder.js'
import {
  loadHistory,
  clearHistory,
  getOpening,
  handleUserMessage,
  handleStructuredAction,
} from '../chat/agent.js'
import { getPersona } from '../chat/persona.js'
import { CAPABILITY_TEMPLATES } from '../chat/templates.js'
import { buildInventory } from '../chat/inventory.js'

type Deps = { ha: HAClient; store: AppStore; llm: LLMProvider | null; recorder: Recorder | null }

export function createChatRouter() {
  const app = new Hono<{ Variables: Deps }>()

  app.get('/', async (c) => {
    const deps = ctxDeps(c)
    const history = await loadHistory(deps.store)
    const persona = await getPersona(deps.store)
    const opening = history.length === 0 ? await getOpening(deps) : null
    return c.json({
      persona,
      history,
      opening: opening?.message ?? null,
      templates: CAPABILITY_TEMPLATES,
      llmEnabled: Boolean(deps.llm),
    })
  })

  app.post('/', async (c) => {
    const deps = ctxDeps(c)
    const body = (await c.req.json()) as { text: string }
    if (!body.text || typeof body.text !== 'string') {
      return c.json({ error: 'text is required' }, 400)
    }
    const reply = await handleUserMessage(deps, body.text)
    return c.json(reply)
  })

  app.post('/action', async (c) => {
    const deps = ctxDeps(c)
    const action = (await c.req.json()) as Parameters<typeof handleStructuredAction>[1]
    const reply = await handleStructuredAction(deps, action)
    return c.json(reply)
  })

  app.delete('/', async (c) => {
    const deps = ctxDeps(c)
    await clearHistory(deps.store)
    return c.json({ ok: true })
  })

  app.get('/inventory', async (c) => {
    const deps = ctxDeps(c)
    const inventory = await buildInventory(deps.ha)
    return c.json(inventory)
  })

  return app
}

function ctxDeps(c: { get: (key: string) => unknown }): Deps {
  return {
    ha: c.get('ha') as HAClient,
    store: c.get('store') as AppStore,
    llm: c.get('llm') as LLMProvider | null,
    recorder: (c.get('recorder') as Recorder | null) ?? null,
  }
}
