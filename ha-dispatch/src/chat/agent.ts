/**
 * Chat agent.
 *
 * Two modes layered on the same surface:
 *
 *  1. Onboarding (when persona.onboardedAt is unset). A short staged
 *     conversation: greet → take a look → ask about interests →
 *     suggest specific things → save persona. Each stage produces a
 *     reply with optional structured attachments (forms, pickers).
 *
 *  2. Free-form (after onboarding). The user types something; we route
 *     it through the LLM with the persona system prompt and a tight
 *     summary of inventory + flow state. No tool calling yet — Phase 2
 *     adds get_state / call_service / run_flow tools.
 *
 * The agent never imports a concrete LLM provider — it always takes an
 * LLMProvider | null and degrades gracefully when none is configured
 * (still useful: persona setup, template suggestions all work without
 * an LLM).
 */

import type { HAClient } from '../ha-client.js'
import type { AppStore } from '../store.js'
import type { LLMProvider } from '../llm/index.js'
import type { Message, Persona } from './types.js'
import { getPersona, patchPersona, defaultPersona, buildSystemPrompt } from './persona.js'
import { buildInventory } from './inventory.js'
import { CAPABILITY_TEMPLATES, applicableTemplates } from './templates.js'

const HISTORY_KEY = 'chat:history'
const MAX_HISTORY = 50

interface AgentDeps {
  ha: HAClient
  store: AppStore
  llm: LLMProvider | null
}

export interface AgentReply {
  message: Message
  /** Updated history that the UI can re-render. */
  history: Message[]
}

export async function loadHistory(store: AppStore): Promise<Message[]> {
  return (await store.kvGet<Message[]>(HISTORY_KEY)) ?? []
}

async function appendHistory(store: AppStore, ...messages: Message[]): Promise<Message[]> {
  const history = (await loadHistory(store)).concat(messages).slice(-MAX_HISTORY)
  await store.kvSet(HISTORY_KEY, history)
  return history
}

export async function clearHistory(store: AppStore): Promise<void> {
  await store.kvSet(HISTORY_KEY, [])
}

function makeMessage(role: Message['role'], content: string, attachments?: Message['attachments']): Message {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    content,
    createdAt: Date.now(),
    attachments,
  }
}

/** Get the initial assistant message — used when the user opens the chat. */
export async function getOpening(deps: AgentDeps): Promise<{ message: Message; persona: Persona }> {
  const persona = (await getPersona(deps.store)) ?? defaultPersona()
  if (!persona.onboardedAt) {
    return {
      persona,
      message: makeMessage(
        'assistant',
        `Hi! I'm Dispatch — a little assistant that lives inside your Home Assistant. Before we go any further: what should I call you, and what would you like to call me?`,
        [{ kind: 'persona_form' }],
      ),
    }
  }
  return {
    persona,
    message: makeMessage(
      'assistant',
      `Hi ${persona.userName}, ${persona.assistantName} here. What can I help with?`,
    ),
  }
}

/** Handle a user-submitted utterance. */
export async function handleUserMessage(deps: AgentDeps, userText: string): Promise<AgentReply> {
  const userMsg = makeMessage('user', userText)
  const persona = (await getPersona(deps.store)) ?? defaultPersona()

  let assistantMsg: Message
  if (!persona.onboardedAt) {
    assistantMsg = await handleOnboarding(deps, persona, userText)
  } else {
    assistantMsg = await handleFreeForm(deps, persona, userText)
  }

  const history = await appendHistory(deps.store, userMsg, assistantMsg)
  return { message: assistantMsg, history }
}

/**
 * Special action handler — used when the UI submits a structured
 * answer (saving persona name, picking templates, etc.) instead of
 * free-form text.
 */
export async function handleStructuredAction(
  deps: AgentDeps,
  action:
    | { type: 'set_names'; userName: string; assistantName: string }
    | { type: 'set_interests'; templateIds: string[] }
    | { type: 'finish_onboarding' },
): Promise<AgentReply> {
  const persona = (await getPersona(deps.store)) ?? defaultPersona()
  let assistantMsg: Message

  if (action.type === 'set_names') {
    const updated = await patchPersona(deps.store, {
      userName: action.userName.trim() || persona.userName,
      assistantName: action.assistantName.trim() || persona.assistantName,
    })
    // Move to inventory stage — show what we see and ask about interests
    const inventory = await buildInventory(deps.ha)
    const apt = applicableTemplates(inventory.domains.flatMap((d) => d.examples))
    assistantMsg = makeMessage(
      'assistant',
      `Nice to meet you, ${updated.userName}. I'll go by ${updated.assistantName} from now on. Let me take a quick look at your Home Assistant...`,
      [
        { kind: 'inventory_summary', data: inventory },
        { kind: 'capability_picker', data: { templates: apt.length > 0 ? apt : CAPABILITY_TEMPLATES } },
      ],
    )
  } else if (action.type === 'set_interests') {
    const updated = await patchPersona(deps.store, { interests: action.templateIds })
    const interests = action.templateIds
      .map((id) => CAPABILITY_TEMPLATES.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))

    let body: string
    if (interests.length === 0) {
      body = `No problem — we can pick areas later. I'll stay quiet until you ask. Just say "what can you help with?" any time and I'll suggest things.`
    } else {
      const ideas = await suggestForInterests(deps, updated, interests)
      body = `Got it. Based on your setup, here are some ideas in those areas:\n\n${ideas}\n\nReply with the number of one you'd like me to set up, or just tell me what you want to do in your own words.`
    }
    await patchPersona(deps.store, { onboardedAt: Date.now() })
    assistantMsg = makeMessage('assistant', body)
  } else {
    await patchPersona(deps.store, { onboardedAt: Date.now() })
    assistantMsg = makeMessage(
      'assistant',
      `All set. I'm here when you need me — just type what you want to happen.`,
    )
  }

  const history = await appendHistory(deps.store, assistantMsg)
  return { message: assistantMsg, history }
}

async function handleOnboarding(_deps: AgentDeps, persona: Persona, userText: string): Promise<Message> {
  // The structured form submits names through handleStructuredAction.
  // If the user typed free text during onboarding, treat it as a name.
  if (!persona.onboardedAt && persona.userName === 'friend') {
    const name = userText.trim().split(/\s+/).slice(0, 3).join(' ')
    await patchPersona(_deps.store, { userName: name })
    return makeMessage(
      'assistant',
      `Great, ${name}. And what would you like to call me?`,
    )
  }
  // Otherwise nudge them to use the form
  return makeMessage(
    'assistant',
    `Tell me — what should I call you, and what would you like to call me?`,
    [{ kind: 'persona_form' }],
  )
}

async function handleFreeForm(deps: AgentDeps, persona: Persona, userText: string): Promise<Message> {
  if (!deps.llm) {
    return makeMessage(
      'assistant',
      `${persona.userName}, I don't have an AI provider configured yet. Add a Gemini API key in the add-on Configuration tab and I'll be able to chat properly.`,
    )
  }

  // Tight context: a slim inventory summary + recent chat history.
  const inventory = await buildInventory(deps.ha)
  const inventorySummary = inventory.highlights.join('. ') + '.'
  const history = await loadHistory(deps.store)

  const recent = history.slice(-10).map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')

  const prompt = `Recent conversation:\n${recent}\n\nUser just said: ${userText}\n\nWhat the assistant can see in this Home Assistant: ${inventorySummary}\n\nReply naturally. If the user is asking you to do something, describe what you'd do (we'll add real tool execution next). Keep it short.`

  try {
    const reply = await deps.llm.generateJson<{ reply: string }>({
      system: buildSystemPrompt(persona),
      prompt,
      schema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
      },
    })
    return makeMessage('assistant', reply.reply)
  } catch (e) {
    return makeMessage('assistant', `(LLM error: ${(e as Error).message})`)
  }
}

async function suggestForInterests(
  deps: AgentDeps,
  persona: Persona,
  interests: { id: string; name: string; starterIdeas: string[] }[],
): Promise<string> {
  // Without an LLM, just enumerate starter ideas.
  if (!deps.llm) {
    return interests
      .flatMap((t) => t.starterIdeas.map((idea) => `- [${t.name}] ${idea}`))
      .slice(0, 6)
      .map((line, i) => `${i + 1}. ${line.replace(/^- /, '')}`)
      .join('\n')
  }

  // With an LLM, ask it to tailor 4–6 ideas to the actual entities.
  const inventory = await buildInventory(deps.ha)
  try {
    const out = await deps.llm.generateJson<{ ideas: string[] }>({
      system: buildSystemPrompt(persona),
      prompt: `The user wants help with: ${interests.map((i) => i.name).join(', ')}.

Their HA setup at a glance: ${inventory.highlights.join('; ')}.
Total entities: ${inventory.totalEntities}. Existing automations: ${inventory.automations.length}.

Propose 4-6 specific automations they'd benefit from, referencing their actual setup where possible. Phrase each idea as a single sentence. Avoid generic suggestions.`,
      schema: {
        type: 'object',
        properties: {
          ideas: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['ideas'],
      },
    })
    return out.ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n')
  } catch {
    // Fall back to starter ideas
    return interests
      .flatMap((t) => t.starterIdeas)
      .slice(0, 6)
      .map((idea, i) => `${i + 1}. ${idea}`)
      .join('\n')
  }
}
