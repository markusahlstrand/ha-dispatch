/**
 * Learnings API.
 *
 * GET    /api/learnings             all learnings, newest first
 * POST   /api/learnings             manually add a learning {text, category?, entityIds?}
 * PATCH  /api/learnings/:id         edit {text?, category?}
 * DELETE /api/learnings/:id         remove one
 * DELETE /api/learnings             clear all
 */

import { Hono } from 'hono'
import type { AppStore } from '../store.js'
import { createLearningsStore, type LearningCategory } from '../memory/learnings.js'

type Deps = { store: AppStore }

export function createLearningsRouter() {
  const app = new Hono<{ Variables: Deps }>()

  app.get('/', async (c) => {
    const learnings = createLearningsStore(c.get('store') as AppStore)
    const all = (await learnings.list()).sort((a, b) => b.updatedAt - a.updatedAt)
    return c.json({ learnings: all })
  })

  app.post('/', async (c) => {
    const body = (await c.req.json()) as {
      text: string
      category?: LearningCategory
      entityIds?: string[]
    }
    if (!body.text || typeof body.text !== 'string') {
      return c.json({ error: 'text is required' }, 400)
    }
    const learnings = createLearningsStore(c.get('store') as AppStore)
    const added = await learnings.add({
      text: body.text.trim(),
      category: body.category ?? 'note',
      entityIds: body.entityIds,
      source: 'manual',
    })
    return c.json({ learning: added })
  })

  app.patch('/:id', async (c) => {
    const body = (await c.req.json()) as { text?: string; category?: LearningCategory }
    const learnings = createLearningsStore(c.get('store') as AppStore)
    const updated = await learnings.update(c.req.param('id'), body)
    if (!updated) return c.json({ error: 'not_found' }, 404)
    return c.json({ learning: updated })
  })

  app.delete('/:id', async (c) => {
    const learnings = createLearningsStore(c.get('store') as AppStore)
    await learnings.remove(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.delete('/', async (c) => {
    const learnings = createLearningsStore(c.get('store') as AppStore)
    await learnings.clear()
    return c.json({ ok: true })
  })

  return app
}
