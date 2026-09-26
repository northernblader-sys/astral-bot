/**
 * lib/openrouter.js - the bot's one AI client (OpenRouter, OpenAI-compatible
 * chat completions). Replaces the old lib/gemini.js client: Echidna and all
 * five Guardian of the Innocent companions speak through here, on ONE shared
 * key (config.openrouterApiKey).
 *
 * Zero dependencies: plain global fetch (Node 18+).
 *
 *   askAI({ system, messages, model?, temperature?, maxTokens?, apiKey? })
 *     -> { text, model }   (the model that actually answered)
 *     throws Error with .status / .apiMessage on failure.
 *
 * `messages` are { role: 'user' | 'assistant', content } turns, oldest first
 * (the same shape lib/echidna-persona.js's chatHistory() already keeps).
 *
 * Model fallback: if the configured model is unknown / unavailable to the key
 * (404, or a 400 that says the model id is invalid), it walks a short ladder
 * of other models. 429 and 5xx get ONE patient retry on the same model. Auth
 * errors (401/402/403) surface immediately so the caller can say so in
 * character.
 */
import { config } from '../config.js'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const FALLBACK_MODELS = [
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'meta-llama/llama-3.3-70b-instruct',
]
const REQUEST_TIMEOUT_MS = 30_000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Build the OpenAI-style message list. Exported for tests. */
export function buildMessages(system, messages = []) {
  const out = []
  if (system) out.push({ role: 'system', content: String(system) })
  for (const m of messages) {
    if (!m || !m.content) continue
    const role = m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user'
    out.push({ role, content: String(m.content) })
  }
  return out
}

async function callOnce(model, apiKey, payload, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.siteUrl || 'https://animeastral.qzz.io',
        'X-Title': 'Astral Bot',
      },
      body: JSON.stringify({ ...payload, model }),
      signal: controller.signal,
    })
  } catch (err) {
    throw Object.assign(new Error(`OpenRouter request failed: ${err.message}`), { status: 0 })
  } finally {
    clearTimeout(timer)
  }

  let json = null
  try { json = await res.json() } catch { json = null }

  if (!res.ok || json?.error) {
    const apiMessage = json?.error?.message ?? res.statusText ?? 'unknown error'
    const status = json?.error?.code && Number.isInteger(json.error.code) ? json.error.code : res.status
    throw Object.assign(new Error(`OpenRouter ${status}: ${apiMessage}`), { status, apiMessage })
  }

  const text = String(json?.choices?.[0]?.message?.content ?? '').trim()
  if (!text) throw Object.assign(new Error('OpenRouter returned an empty reply'), { status: 502, apiMessage: 'empty' })
  return text
}

/** Send one conversational turn and get the model's text back. */
export async function askAI({
  system,
  messages,
  model,
  temperature = 0.9,
  maxTokens = 400,
  apiKey = config.openrouterApiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = String(apiKey ?? '').trim()
  if (!key) throw Object.assign(new Error('No OpenRouter API key configured'), { status: 0 })

  const payload = {
    messages: buildMessages(system, messages),
    temperature,
    max_tokens: maxTokens,
  }

  const ladder = [...new Set([model ?? config.openrouterModel, ...FALLBACK_MODELS].filter(Boolean))]
  let lastErr = null
  for (const candidate of ladder) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callOnce(candidate, key, payload, fetchImpl)
        return { text, model: candidate }
      } catch (err) {
        lastErr = err
        const badModel = err.status === 404 ||
          (err.status === 400 && /model|not a valid|not found|no endpoints/i.test(err.apiMessage ?? ''))
        if (badModel) break
        if (err.status === 429 || err.status >= 500 || err.status === 0) {
          if (attempt === 0) { await sleep(1200); continue }
          break // move down the ladder after the retry
        }
        throw err
      }
    }
  }
  throw lastErr ?? new Error('OpenRouter failed')
}
