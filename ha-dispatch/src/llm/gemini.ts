/**
 * Google Gemini provider.
 *
 * Uses the Generative Language REST API with structured output
 * (responseSchema) so we always get parseable JSON back.
 * Defaults to gemini-2.5-flash which is fast, cheap, and supports
 * structured output.
 */

import type { LLMProvider, ChatTurn, ToolSpec, LLMStep } from './types.js'
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

    async chatStep({
      system,
      history,
      tools,
      model,
      tag,
    }: {
      system?: string
      history: ChatTurn[]
      tools: ToolSpec[]
      model?: string
      tag?: string
    }): Promise<LLMStep> {
      const startedAt = Date.now()
      const usedModel = model ?? DEFAULT_MODEL
      const url = `${API_BASE}/models/${usedModel}:generateContent?key=${apiKey}`

      // Convert our turns into Gemini's `contents` format.
      const contents = historyToGeminiContents(history)

      const body: Record<string, unknown> = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: { temperature: 0.2 },
      }
      if (tools.length > 0) {
        body.tools = [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      }

      const promptChars = JSON.stringify(contents).length + (system?.length ?? 0)
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
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }>
            }
          }>
        }
        const parts = data.candidates?.[0]?.content?.parts ?? []

        // Prefer tool calls over text; if both are present we surface the
        // tool call so the loop continues.
        for (const p of parts) {
          if (p.functionCall) {
            reportLLMCall({
              provider: 'gemini',
              model: usedModel,
              promptChars,
              durationMs: Date.now() - startedAt,
              ok: true,
              tag: tag ? `${tag}.tool_call` : 'tool_call',
            })
            return { kind: 'tool_call', toolName: p.functionCall.name, args: p.functionCall.args ?? {} }
          }
        }

        const text = parts.map((p) => p.text ?? '').join('').trim()
        reportLLMCall({
          provider: 'gemini',
          model: usedModel,
          promptChars,
          durationMs: Date.now() - startedAt,
          ok: true,
          tag,
        })
        return { kind: 'message', content: text || '(no reply)' }
      } catch (e) {
        reportLLMCall({
          provider: 'gemini',
          model: usedModel,
          promptChars,
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

function historyToGeminiContents(history: ChatTurn[]): unknown[] {
  return history.map((turn) => {
    if (turn.role === 'user') {
      return { role: 'user', parts: [{ text: turn.content }] }
    }
    if (turn.role === 'assistant') {
      return { role: 'model', parts: [{ text: turn.content }] }
    }
    // Tool result — Gemini calls this "function" role.
    return {
      role: 'function',
      parts: [
        {
          functionResponse: {
            name: turn.toolName,
            response: { result: turn.result },
          },
        },
      ],
    }
  })
}
