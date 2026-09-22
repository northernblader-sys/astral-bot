/**
 * lib/gemini.js - minimal Google Gemini (Generative Language API) client.
 *
 * Zero new dependencies: plain global fetch (Node 18+), REST endpoint,
 * supports both `x-goog-api-key` header and `?key=` query parameter.
 * Powers Echidna's voice (plugins/echidna.js).
 *
 * Behaviour:
 *   askGemini({ apiKey, model?, system, messages, temperature?, maxOutputTokens? })
 *     -> { text, model }   (the model that actually answered)
 *     throws Error with .status / .apiMessage on failure.
 *
 * Model fallback: if the configured model 404s / reports not-found (key
 * tiers differ), it retries ONCE down a small fallback ladder
 * (gemini-2.5-flash -> gemini-2.0-flash -> gemini-1.5-flash) so a model
 * name going stale never silences the witch. 429s and 5xx get ONE retry on
 * the same model after a short pause. Anything else surfaces to the caller
 * to handle in character.
 *
 * Thinking Configuration:
 *   Gemini 2.5+ models enable thinking mode by default which consumes tokens from
 *   maxOutputTokens. We pass `thinkingConfig: { thinkingBudget: 0 }` for fast,
 *   direct conversational replies and filter out any thought parts from the output.
 *
 * The API key comes from config.geminiApiKey (GEMINI_API_KEY or GOOGLE_API_KEY in .env).
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']

async function callOnce(model, apiKey, body) {
  const cleanKey = String(apiKey ?? '').trim()
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cleanKey)}`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': cleanKey,
    },
    body: JSON.stringify(body),
  })
  const raw = await resp.text()
  let data = null
  try { data = JSON.parse(raw) } catch { /* non-JSON error body */ }
  if (!resp.ok) {
    const err = new Error(`Gemini API ${resp.status}`)
    err.status = resp.status
    err.apiMessage = data?.error?.message ?? raw?.slice(0, 300) ?? ''
    throw err
  }

  // Filter out any reasoning/thought parts (part.thought === true) and extract genuine response text
  const parts = data?.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .filter(p => !p?.thought)
    .map(p => p?.text ?? '')
    .join('')
    .trim()

  if (!text) {
    // If all parts were thinking or text is empty, check if candidate had any text at all
    const fallbackText = parts.map(p => p?.text ?? '').join('').trim()
    if (fallbackText) return fallbackText

    const err = new Error('Gemini API returned an empty response')
    err.status = resp.status
    err.apiMessage = data?.promptFeedback?.blockReason || 'empty response'
    throw err
  }
  return text
}

function buildBody({ system, messages, temperature, maxOutputTokens }) {
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: (messages ?? []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }],
    })),
    generationConfig: {
      temperature: Number.isFinite(temperature) ? temperature : 0.9,
      maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 500,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * askGemini - send one conversational turn, get the model's text back.
 * See the file header for the fallback/retry policy.
 */
export async function askGemini({ apiKey, model, system, messages, temperature, maxOutputTokens }) {
  const cleanKey = String(apiKey ?? '').trim()
  if (!cleanKey) throw Object.assign(new Error('No Gemini API key configured'), { status: 0 })

  const body = buildBody({ system, messages, temperature, maxOutputTokens })

  // De-duplicated ladder: configured model first, then the known-good names.
  const ladder = [...new Set([model, ...FALLBACK_MODELS].filter(Boolean))]

  let lastErr = null
  for (const candidate of ladder) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callOnce(candidate, cleanKey, body)
        return { text, model: candidate }
      } catch (err) {
        lastErr = err
        const notFound = err.status === 404 || /not found|not supported|unknown model/i.test(err.apiMessage ?? '')
        if (notFound) break // try the next model down the ladder
        if (err.status === 429 || err.status >= 500) {
          if (attempt === 0) { await sleep(1200); continue } // one patient retry
        }
        throw err // auth errors, bad request, etc. - surface immediately
      }
    }
  }
  throw lastErr ?? new Error('Gemini API failed')
}
