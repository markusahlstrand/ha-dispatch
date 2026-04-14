/**
 * Chat module types — kept narrow so the chat surface stays composable
 * with the rest of Dispatch. Persistence goes through AppStore.kv;
 * runtime/AI-provider dependencies are injected by the router.
 */

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Unix ms */
  createdAt: number
  /** Optional structured payload the UI can render specially (suggestions, etc.) */
  attachments?: ChatAttachment[]
}

export type ChatAttachment =
  | { kind: 'inventory_summary'; data: InventorySummary }
  | { kind: 'capability_picker'; data: { templates: CapabilityTemplate[] } }
  | { kind: 'persona_form' }
  | { kind: 'flow_suggestion'; data: { id: string; name: string; description: string; templateId: string } }

export interface Persona {
  /** Whatever the user asks to be called */
  userName: string
  /** Whatever the user asks to call the assistant */
  assistantName: string
  /** "casual" | "concise" | "playful" — free form, fed into the system prompt */
  tone?: string
  /** "ask" | "suggest" | "act" — how proactive the assistant should be */
  proactiveness?: 'ask' | 'suggest' | 'act'
  /** Areas the user said they care about (template ids) */
  interests?: string[]
  /** Free-form notes the assistant builds up over time */
  notes?: string[]
  /** Unix ms when onboarding finished; absent = still onboarding */
  onboardedAt?: number
}

export interface InventorySummary {
  totalEntities: number
  /** Per-domain count + a few example entity ids */
  domains: { domain: string; count: number; examples: string[] }[]
  /** Names of automations Home Assistant currently knows about */
  automations: { entityId: string; name: string; lastTriggered?: string }[]
  /** Areas defined in HA */
  areas: string[]
  /** Brief, LLM-generated highlights — what stands out about this setup */
  highlights: string[]
}

export interface CapabilityTemplate {
  id: string
  name: string
  /** What it does, in one line */
  blurb: string
  /** Domains/keywords we look for to decide if this template is applicable */
  matchKeywords: string[]
  /** Per-template starter ideas the assistant can offer when matched */
  starterIdeas: string[]
  icon: string
}

export type OnboardingStage =
  | 'greet' // ask user their name + assistant name
  | 'inventory' // looking around HA
  | 'interests' // ask what areas they care about
  | 'suggest' // propose specific automations from templates
  | 'done' // free-form chat from here
