/**
 * Google Gemini provider.
 *
 * Uses the Generative Language REST API with structured output
 * (responseSchema) so we always get parseable JSON back.
 * Defaults to gemini-2.5-flash which is fast, cheap, and supports
 * structured output.
 */

import type { LLMProvider } from './types.js'
import { LLMUnavailableError, reportLLMCall } from './types.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export function createGeminiProvider(apiKey: string): LLMProvider {
  if (!apiKey) {
    throw new LLMUnavailableError('no_api_key', 'Gemini API key is empty')
  }

  return {
    id: 'gemini',
    async generateJson<T>({
      system,
      prompt,
      schema,
      model,
      tag,
    }: {
      system?: string
      prompt: string
      schema: Record<string, unknown>
      model?: string
      tag?: string
    }): Promise<T> {
      const startedAt = Date.now()
      const usedModel = model ?? DEFAULT_MODEL
      const url = `${API_BASE}/models/${usedModel}:generateContent?key=${apiKey}`
      const body = {
        ...(system
          ? { systemInstruction: { parts: [{ text: system }] } }
          : {}),
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new LLMUnavailableError(
            'http_error',
            `Gemini HTTP ${res.status}: ${text.slice(0, 200)}`,
          )
        }

        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) {
          throw new LLMUnavailableError('http_error', 'Gemini returned no text')
        }

        let parsed: T
        try {
          parsed = JSON.parse(text) as T
        } catch {
          throw new LLMUnavailableError('http_error', `Gemini returned non-JSON: ${text.slice(0, 200)}`)
        }
        reportLLMCall({
          provider: 'gemini',
          model: usedModel,
          promptChars: prompt.length + (system?.length ?? 0),
          durationMs: Date.now() - startedAt,
          ok: true,
          tag,
        })
        return parsed
      } catch (e) {
        reportLLMCall({
          provider: 'gemini',
          model: usedModel,
          promptChars: prompt.length + (system?.length ?? 0),
          durationMs: Date.now() - startedAt,
          ok: false,
          error: (e as Error).message,
          tag,
        })
        throw e
      }
    },
  }
}
