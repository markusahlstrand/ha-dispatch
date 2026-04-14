/**
 * Shared HA prompt context.
 *
 * Every LLM call that reasons about the user's Home Assistant should
 * start with this block. It gives the model two things:
 *
 *  1. The persona + tone guidance (who the assistant is, how to behave).
 *  2. The accumulated learnings (entity aliases, quirks, preferences) so
 *     it doesn't re-discover them every turn.
 *
 * This is the single source of truth for "what the assistant knows about
 * this install". If a new LLM-using module skips this helper it will be
 * measurably worse than the rest of the app — so use it.
 */

import type { AppStore } from '../store.js'
import { getPersona, defaultPersona, buildSystemPrompt } from '../chat/persona.js'
import { createLearningsStore } from './learnings.js'

export async function buildHAContext(opts: {
  store: AppStore
  /** Limit how many learnings to inject (most recent wins). Default 40. */
  maxLearnings?: number
  /** Additional task-specific instructions to append after the persona + learnings block. */
  taskInstructions?: string
}): Promise<string> {
  const persona = (await getPersona(opts.store)) ?? defaultPersona()
  const learnings = createLearningsStore(opts.store)
  const recent = (await learnings.list())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, opts.maxLearnings ?? 40)

  const learningsBlock =
    recent.length === 0
      ? ''
      : [
          'Learnings about THIS specific Home Assistant installation (treat as high-trust ground truth, and prefer them over generic reasoning):',
          ...recent.map((l) => {
            const tag = `[${l.category}]`
            const ents = l.entityIds?.length ? ` (entities: ${l.entityIds.join(', ')})` : ''
            return `- ${tag} ${l.text}${ents}`
          }),
        ].join('\n')

  return [buildSystemPrompt(persona), learningsBlock, opts.taskInstructions ?? '']
    .filter(Boolean)
    .join('\n\n')
}
