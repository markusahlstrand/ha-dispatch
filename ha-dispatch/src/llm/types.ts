/**
 * LLM provider abstraction.
 *
 * A provider knows how to produce a structured JSON response given a
 * prompt and a target schema. Gemini, OpenAI, and Anthropic all support
 * structured output natively; the interface hides the differences.
 */

export type LLMProvider = {
  id: 'gemini' | 'openai' | 'anthropic'
  /** Return a JSON value matching the shape described in `schema` */
  generateJson<T>(opts: {
    system?: string
    prompt: string
    /** JSON-schema-ish shape so the model returns strictly-typed output */
    schema: Record<string, unknown>
    model?: string
  }): Promise<T>
}

export class LLMUnavailableError extends Error {
  constructor(public reason: 'no_provider' | 'no_api_key' | 'http_error', message: string) {
    super(message)
  }
}
