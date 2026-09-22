import test from 'node:test'
import assert from 'node:assert/strict'
import { askGemini } from '../lib/gemini.js'

test('Gemini client: auth key header and query param, thinking config, and parts parsing', async (t) => {
  // Test 1: No key throws status 0 error
  await assert.rejects(
    async () => {
      await askGemini({ apiKey: '', messages: [{ role: 'user', content: 'hello' }] })
    },
    (err) => err.status === 0
  )

  // Test 2: Thinking parts filtering and query parameter verification
  let capturedUrl = ''
  let capturedHeaders = {}
  let capturedBody = null

  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    capturedUrl = url
    capturedHeaders = options.headers
    capturedBody = JSON.parse(options.body)

    // Simulate Gemini 2.5 response with thought part + answer part
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'Thinking about the answer...' },
                { text: 'I am Echidna, the Witch of Greed.' }
              ]
            }
          }
        ]
      })
    }
  }

  try {
    const res = await askGemini({
      apiKey: 'test-api-key-123',
      model: 'gemini-2.5-flash',
      system: 'You are Echidna.',
      messages: [{ role: 'user', content: 'Who are you?' }],
      temperature: 0.9,
      maxOutputTokens: 400
    })

    // Check query param key and header
    assert.ok(capturedUrl.includes('key=test-api-key-123'))
    assert.equal(capturedHeaders['x-goog-api-key'], 'test-api-key-123')

    // Check thinkingConfig
    assert.deepEqual(capturedBody.generationConfig?.thinkingConfig, { thinkingBudget: 0 })

    // Check thought part was skipped and only real answer returned
    assert.equal(res.text, 'I am Echidna, the Witch of Greed.')
    assert.equal(res.model, 'gemini-2.5-flash')
  } finally {
    global.fetch = originalFetch
  }
})
