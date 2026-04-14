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
import type { Storage } from '../adapters/index.js'
import type { LLMProvider, ChatTurn } from '../llm/index.js'
import type { Recorder } from '../diagnostics/recorder.js'
import type { Message, Persona, InventorySummary, ToolTraceEntry } from './types.js'
import { getPersona, patchPersona, defaultPersona, buildSystemPrompt } from './persona.js'
import { buildInventory } from './inventory.js'
import { CAPABILITY_TEMPLATES, applicableTemplates } from './templates.js'
import { createToolkit } from '../tools/types.js'
import { haTools } from '../tools/ha-tools.js'
import { automationTools } from '../tools/automation-tools.js'
import { shellyTools } from '../tools/shelly-tools.js'
import { buildHAContext } from '../memory/prompt.js'

const HISTORY_KEY = 'chat:history'
const MAX_HISTORY = 50

interface AgentDeps {
  ha: HAClient
  store: AppStore
  storage?: Storage | null
  llm: LLMProvider | null
  recorder?: Recorder | null
}

async function timedInventory(deps: AgentDeps): Promise<InventorySummary> {
  const startedAt = Date.now()
  try {
    const inv = await buildInventory(deps.ha)
    deps.recorder?.record({
      type: 'inventory',
      entityCount: inv.totalEntities,
      durationMs: Date.now() - startedAt,
      ok: true,
    })
    return inv
  } catch (e) {
    deps.recorder?.record({
      type: 'inventory',
      entityCount: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: (e as Error).message,
    })
    throw e
  }
}

// Widen the AgentDeps type used in the router so storage can be null
// rather than undefined when Hono gives it to us.
export type { Storage } from '../adapters/index.js'

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
    let inventory: InventorySummary
    try {
      inventory = await timedInventory(deps)
    } catch (e) {
      assistantMsg = makeMessage(
        'assistant',
        `Nice to meet you, ${updated.userName}. I tried to look around but couldn't reach Home Assistant: ${(e as Error).message}. Try refreshing once HA is reachable.`,
      )
      const history = await appendHistory(deps.store, assistantMsg)
      return { message: assistantMsg, history }
    }
    const apt = applicableTemplates(inventory.domains.flatMap((d) => d.examples))
    assistantMsg = makeMessage(
      'assistant',
      `Nice to meet you, ${updated.userName}. I'll go by ${updated.assistantName} from now on. Here's what I can see in your setup — pick the areas you'd like help with.`,
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

const MAX_TOOL_ITERATIONS = 6

async function handleFreeForm(deps: AgentDeps, persona: Persona, userText: string): Promise<Message> {
  if (!deps.llm) {
    return makeMessage(
      'assistant',
      `${persona.userName}, I don't have an AI provider configured yet. Add a Gemini API key in the add-on Configuration tab and I'll be able to chat properly.`,
    )
  }

  const toolkit = createToolkit([...haTools, ...automationTools, ...shellyTools])
  const inventory = await timedInventory(deps).catch(() => null)
  const inventoryHint = inventory
    ? `Highlights: ${inventory.highlights.join('; ')}. ${inventory.totalEntities} entities total.`
    : 'Could not read inventory right now — assume entities exist but call list_states to discover.'

  const recent = (await loadHistory(deps.store)).slice(-8)
  const turns: ChatTurn[] = recent.map((m) => ({
    role: m.role === 'system' ? 'assistant' : (m.role as 'user' | 'assistant'),
    content: m.content,
  }))
  turns.push({ role: 'user', content: userText })

  const taskInstructions = `You have real tools for Home Assistant: you can inspect state (list_states / get_state / list_areas), call services (call_service), AND create / modify / remove automations (create_ha_automation, list_ha_automations, remove_ha_automation). You can also work with Dispatch flows (list_flows, configure_flow, deploy_flow, disable_flow). You CAN create automations — do not tell the user you can't.

How to build an automation the user describes:
1. Confirm the entity ids with list_states / get_state. Never invent ids.
2. Plan the trigger / condition / action in plain language and confirm with the user in one short sentence.
3. Call create_ha_automation with a concrete spec. Prefer 'restart' mode for motion/occupancy patterns so re-triggers reset timers.
4. After creating, call list_ha_automations to confirm it shows up and tell the user the slug so they can reference it later.

Honesty rules:
- NEVER claim an action succeeded unless the call_service result has \`verified: true\` (or, for create_ha_automation, list_ha_automations shows the new entity).
- If \`verified: false\`, tell the user the call did not produce the expected state and explain what you saw.
- If \`verified\` is undefined for that service, say what you tried and that you couldn't auto-confirm.
- Prefer reading state with list_states / get_state before acting if you're unsure which entity to use.

When reading list_states, prefer entities whose state is a real value (on/off/open/closed/numbers) over entities reporting \`unknown\` or \`unavailable\` — the latter are usually template/alias entities that won't report feedback. Figure out which underlying device entity actually has state feedback.

When you discover something the user or future turns should remember — an entity alias that maps to a physical device, an entity whose verification fails because it's a template/alias, a preferred way to control a device, a user preference — call record_learning so it sticks. Be specific; cite entity ids.

Keep user-facing responses short and concrete; quote the specific entity ids you acted on.

You can also reach Shelly Gen2+ devices directly over the LAN (bypassing HA) via the shelly_* tools: shelly_add to register a device by IP, shelly_info / shelly_status / shelly_call for state and control, and shelly_install_script / shelly_list_scripts / shelly_remove_script to deploy mJS scripts on the device. Use this when the user wants behavior running on the Shelly itself — e.g. "send a webhook when power spikes above X" — where an HA automation would be slower or less reliable. Prefer bundled templates (power_threshold_webhook, cycle_finish_webhook) over writing raw mJS. Name Dispatch-managed scripts with a "dispatch_" prefix. If you don't have the device's IP in shelly_list, ask the user for it once and call shelly_add.

About the user's setup: ${inventoryHint}`

  const systemPrompt = await buildHAContext({
    store: deps.store,
    taskInstructions,
  })

  const trace: ToolTraceEntry[] = []
  let finalText = ''

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let step
    try {
      step = await deps.llm.chatStep({
        system: systemPrompt,
        history: turns,
        tools: toolkit.list(),
        tag: 'chat.freeform',
      })
    } catch (e) {
      finalText = `(LLM error: ${(e as Error).message})`
      break
    }

    if (step.kind === 'message') {
      finalText = step.content
      break
    }

    // Tool call — execute, append to history, loop.
    const startedAt = Date.now()
    const result = await toolkit.call(
      { ha: deps.ha, store: deps.store, storage: deps.storage ?? undefined, recorder: deps.recorder },
      step.toolName,
      step.args,
    )
    trace.push({
      toolName: step.toolName,
      args: step.args,
      result: result.ok ? result.data : { error: result.error },
      ok: result.ok,
      verified: result.ok ? result.verified : undefined,
      verificationNote: result.ok ? result.verificationNote : undefined,
      durationMs: Date.now() - startedAt,
    })
    turns.push({ role: 'tool', toolName: step.toolName, result: result.ok ? result.data : { error: result.error } })
  }

  if (!finalText) {
    finalText = `(Reached max tool iterations without a final answer. Use the ⬇ report button to share details.)`
  }

  return makeMessage('assistant', finalText, trace.length > 0 ? [{ kind: 'tool_trace', data: trace }] : undefined)
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
  const inventory = await timedInventory(deps)
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
