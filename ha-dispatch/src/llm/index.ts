/**
 * LLM factory — returns a provider instance based on the runtime config,
 * or null if no LLM is configured. All LLM-using code should handle the
 * null case gracefully and fall back to heuristics.
 */

import type { RuntimeConfig } from '../config.js'
import type { LLMProvider } from './types.js'
import { createGeminiProvider } from './gemini.js'

export function createLLM(config: RuntimeConfig): LLMProvider | null {
  if (config.llm_provider === 'none' || !config.llm_api_key) {
    return null
  }
  switch (config.llm_provider) {
    case 'gemini':
      return createGeminiProvider(config.llm_api_key)
    case 'openai':
    case 'anthropic':
      console.warn(`[llm] ${config.llm_provider} provider not yet implemented; disabling LLM`)
      return null
    default:
      return null
  }
}

export type { LLMProvider, ChatTurn, ToolSpec, LLMStep } from './types.js'
export { LLMUnavailableError } from './types.js'
