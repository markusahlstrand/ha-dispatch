/**
 * Persona persistence — single source of truth for "what the assistant
 * knows about the user". Stored in KV so it's swappable when storage
 * moves to a different backend.
 */

import type { AppStore } from '../store.js'
import type { Persona } from './types.js'

const KEY = 'chat:persona'

export async function getPersona(store: AppStore): Promise<Persona | undefined> {
  return store.kvGet<Persona>(KEY)
}

export async function setPersona(store: AppStore, persona: Persona): Promise<void> {
  await store.kvSet(KEY, persona)
}

export async function patchPersona(
  store: AppStore,
  patch: Partial<Persona>,
): Promise<Persona> {
  const current = (await getPersona(store)) ?? defaultPersona()
  const next = { ...current, ...patch }
  await setPersona(store, next)
  return next
}

export function defaultPersona(): Persona {
  return {
    userName: 'friend',
    assistantName: 'Dispatch',
    proactiveness: 'suggest',
    interests: [],
    notes: [],
  }
}

export function buildSystemPrompt(persona: Persona): string {
  const tone = persona.tone ?? 'warm but concise; no fluff, no emojis unless the user uses them first'
  const interests = persona.interests?.length
    ? `The user said they care about: ${persona.interests.join(', ')}.`
    : ''
  const notes = persona.notes?.length ? `Earlier notes about the user/setup:\n- ${persona.notes.join('\n- ')}` : ''

  return `You are ${persona.assistantName}, a personal automation assistant running inside this user's Home Assistant via the Dispatch add-on. The user's name is ${persona.userName}.

Tone: ${tone}.
Proactiveness: ${persona.proactiveness ?? 'suggest'} (ask = wait to be asked; suggest = surface ideas; act = take action with a brief heads-up).

${interests}
${notes}

When you don't know something specific about the user's setup, you can ask. When you propose actions, be concrete: name the entities, the schedule, and the expected outcome. You never invent entity IDs or sensors that don't exist.`
}
