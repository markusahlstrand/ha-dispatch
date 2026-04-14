/**
 * LLM provider abstraction.
 *
 * A provider knows how to produce a structured JSON response given a
 * prompt and a target schema. Gemini, OpenAI, and Anthropic all support
 * structured output natively; the interface hides the differences.
 */

/** Tool definition shared across providers (provider-agnostic schema). */
export interface ToolSpec {
  /** Unique tool name (snake_case). The model uses this verbatim. */
  name: string
  /** Short description so the model knows when to call it. */
  description: string
  /** JSON-schema for the arguments object. */
  parameters: Record<string, unknown>
}

/** A turn in a multi-step tool-calling conversation. */
export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool'; toolName: string; result: unknown }

/** Output of one LLM step in a tool-calling loop. */
export type LLMStep =
  | { kind: 'message'; content: string }
  | { kind: 'tool_call'; toolName: string; args: Record<string, unknown>; rawId?: string }

export type LLMProvider = {
  id: 'gemini' | 'openai' | 'anthropic'
  /** Return a JSON value matching the shape described in `schema` */
  generateJson<T>(opts: {
    system?: string
    prompt: string
    /** JSON-schema-ish shape so the model returns strictly-typed output */
    schema: Record<string, unknown>
    model?: string
    /** Free-form label recorded with the diagnostic event for this call. */
    tag?: string
  }): Promise<T>

  /**
   * One step in a tool-calling loop. Caller supplies the running history
   * (user + assistant + tool turns), plus the tool registry. Returns
   * either a final `message` to show the user or a `tool_call` to
   * execute and append to history before calling again.
   */
  chatStep(opts: {
    system?: string
    history: ChatTurn[]
    tools: ToolSpec[]
    model?: string
    tag?: string
  }): Promise<LLMStep>
}

/**
 * Optional sink for diagnostic events. When set on a provider, every
 * generateJson call records a diagnostic. Decoupled this way so the
 * llm module never imports from diagnostics.
 */
export interface LLMObserver {
  onCall(event: {
    provider: string
    model?: string
    promptChars: number
    durationMs: number
    ok: boolean
    error?: string
    tag?: string
  }): void
}

let activeObserver: LLMObserver | null = null
export function setLLMObserver(observer: LLMObserver | null): void {
  activeObserver = observer
}
export function reportLLMCall(event: Parameters<LLMObserver['onCall']>[0]): void {
  activeObserver?.onCall(event)
}

export class LLMUnavailableError extends Error {
  constructor(public reason: 'no_provider' | 'no_api_key' | 'http_error', message: string) {
    super(message)
  }
}
