/** OpenAI-compatible transport. Defaults to OpenRouter for legacy callers.
 * lib/ai.js selects Groq first and an optional OpenRouter backup.
 * Authentication errors are terminal within a provider, never retried.
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

async function callOnce(model, apiKey, payload, fetchImpl, timeoutMs, apiUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(apiUrl, {
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
    // Keep the timeout alive through body consumption too: a provider can
    // send headers successfully, then stall forever before the JSON arrives.
    let json = null
    try { json = await res.json() } catch (err) {
      if (controller.signal.aborted) throw err
      if (res.ok) throw Object.assign(new Error('AI provider returned invalid JSON'), { status: 502, apiMessage: 'invalid_json' })
    }
    if (!res.ok || json?.error) {
      const apiMessage = json?.error?.message ?? res.statusText ?? 'unknown error'
      const status = Number.isInteger(json?.error?.code) ? json.error.code : res.status
      throw Object.assign(new Error(`AI provider request failed (${status})`), { status, apiMessage })
    }
    const content = json?.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content.trim() : Array.isArray(content)
      ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim()
      : ''
    if (!text) throw Object.assign(new Error('AI provider returned an empty reply'), { status: 502, apiMessage: 'empty' })
    return text
  } catch (err) {
    if (err.status !== undefined) throw err
    throw Object.assign(new Error(controller.signal.aborted ? 'AI request timed out' : 'AI network request failed'), {
      status: 0, apiMessage: controller.signal.aborted ? 'timeout' : 'network',
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Send one conversational turn and get the model's text back. */
export async function askAI({
  system,
  messages,
  model,
  temperature = 0.9,
  maxTokens = 400,
  apiKey = config.openrouterApiKey,
  apiUrl = API_URL,
  fallbackModels = FALLBACK_MODELS,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  sleepImpl = sleep,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive')
  const key = String(apiKey ?? '').trim()
  if (!key) throw Object.assign(new Error('No AI credential configured'), { status: 0 })

  const payload = {
    messages: buildMessages(system, messages),
    temperature,
    max_tokens: maxTokens,
  }

  const ladder = [...new Set([model ?? config.openrouterModel, ...fallbackModels].filter(Boolean))]
  let lastErr = null
  for (const candidate of ladder) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callOnce(candidate, key, payload, fetchImpl, timeoutMs, apiUrl)
        return { text, model: candidate }
      } catch (err) {
        lastErr = err
        const badModel = err.status === 404 ||
          (err.status === 400 && /model|not a valid|not found|no endpoints/i.test(err.apiMessage ?? ''))
        if (badModel) break
        if (err.status === 429 || err.status >= 500 || err.status === 0) {
          if (attempt === 0) { await sleepImpl(1200); continue }
          break // move down the ladder after the retry
        }
        throw err
      }
    }
  }
  throw lastErr ?? new Error('AI request failed')
}
