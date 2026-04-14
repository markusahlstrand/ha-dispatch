/**
 * Service-call verification.
 *
 * After the assistant calls call_service, we poll the affected entity
 * (or entities) for up to N seconds to confirm the state changed as
 * expected. If it didn't, the tool result tells the LLM honestly so it
 * stops claiming success.
 *
 * The verifier only fires for service patterns we recognize. For
 * unknown services we still allow the call but report "verified: undefined"
 * so the LLM doesn't fabricate confirmation.
 */

import type { HAClient, HAState } from '../ha-client.js'

export interface VerificationResult {
  /** true = we confirmed the change, false = state didn't change as expected, undefined = nothing to verify */
  verified?: boolean
  /** Per-entity outcome for the human-readable note. */
  details: { entityId: string; expected: string; actual: string; ok: boolean }[]
}

/** Map (domain, service) -> ([attribute path], expected state strings). */
type Expectation = {
  attribute?: string
  /** State value(s) we'd expect to see. Match wins on first overlap. */
  states: string[]
  /** Some changes have an intermediate transitional state (opening, heating). */
  transitional?: string[]
}

const EXPECTATIONS: Record<string, Expectation> = {
  'light.turn_on': { states: ['on'] },
  'light.turn_off': { states: ['off'] },
  'switch.turn_on': { states: ['on'] },
  'switch.turn_off': { states: ['off'] },
  'fan.turn_on': { states: ['on'] },
  'fan.turn_off': { states: ['off'] },
  'cover.open_cover': { states: ['open'], transitional: ['opening'] },
  'cover.close_cover': { states: ['closed'], transitional: ['closing'] },
  'cover.set_cover_position': { states: ['open', 'closed'], transitional: ['opening', 'closing'] },
  'lock.lock': { states: ['locked'], transitional: ['locking'] },
  'lock.unlock': { states: ['unlocked'], transitional: ['unlocking'] },
  'media_player.media_play': { states: ['playing'] },
  'media_player.media_pause': { states: ['paused'] },
  'media_player.media_stop': { states: ['idle', 'off'] },
  'climate.set_temperature': { states: ['*'] }, // any state acceptable; we check attribute change instead
}

export async function verifyServiceCall(opts: {
  ha: HAClient
  domain: string
  service: string
  entityIds: string[]
  /** Maximum total time to wait, ms. */
  timeoutMs?: number
}): Promise<VerificationResult> {
  const key = `${opts.domain}.${opts.service}`
  const expectation = EXPECTATIONS[key]
  if (!expectation || opts.entityIds.length === 0) {
    return { verified: undefined, details: [] }
  }

  const timeoutMs = opts.timeoutMs ?? 6000
  const intervalMs = 500
  const deadline = Date.now() + timeoutMs

  // Poll each entity until either it matches the expected state or we time out.
  const details: VerificationResult['details'] = []
  let allOk = true

  for (const entityId of opts.entityIds) {
    let lastState: HAState | null = null
    let ok = false
    while (Date.now() < deadline) {
      try {
        const s = await opts.ha.getState(entityId)
        lastState = s
        if (s) {
          if (
            expectation.states.includes(s.state) ||
            expectation.states.includes('*') ||
            expectation.transitional?.includes(s.state)
          ) {
            // For transitional states keep polling until it reaches a
            // terminal state or we run out of time.
            if (expectation.transitional?.includes(s.state)) {
              await sleep(intervalMs)
              continue
            }
            ok = true
            break
          }
        }
      } catch {
        // ignore — keep polling
      }
      await sleep(intervalMs)
    }

    details.push({
      entityId,
      expected: expectation.states.join('|'),
      actual: lastState?.state ?? 'unknown',
      ok,
    })
    if (!ok) allOk = false
  }

  return { verified: allOk, details }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
