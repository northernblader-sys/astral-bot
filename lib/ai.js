/** Shared voice routing: Groq first, OpenRouter only as a backup. */
import { config } from '../config.js'
import { askAI as requestCompletion } from './openrouter.js'

export function hasAIKey() {
  return Boolean(config.groqApiKey || config.openrouterApiKey)
}

export async function askAI(options = {}) {
  const providers = [
    { name: 'groq', apiKey: config.groqApiKey,
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: config.groqModel, fallbackModels: ['llama-3.1-8b-instant'] },
    { name: 'openrouter', apiKey: config.openrouterApiKey,
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: config.openrouterModel },
  ].filter(p => p.apiKey)
  let lastError
  for (const { name, ...provider } of providers) {
    try {
      return { ...await requestCompletion({ ...options, ...provider }), provider: name }
    } catch (err) {
      // Never log credentials, prompts, or raw provider error bodies.
      console.warn('[ai] provider unavailable', { provider: name, status: Number(err?.status) || 0 })
      lastError = err
      // Only fail over on auth, quota, unavailable models and transient errors.
      const badModel = err?.status === 400 && /model|not a valid|not found|no endpoints/i.test(err?.apiMessage ?? '')
      if (!badModel && ![0, 401, 402, 403, 404, 429].includes(err?.status) && !(err?.status >= 500)) throw err
    }
  }
  throw lastError ?? Object.assign(new Error('AI is not configured'), { status: 0 })
}
