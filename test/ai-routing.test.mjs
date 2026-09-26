import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { config, describeConfigSources } from '../config.js'
import { askAI, hasAIKey } from '../lib/ai.js'

const success = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Stay for tea.' } }] }) })
const failure = status => ({ ok: false, status, json: async () => ({ error: { code: status, message: 'Unavailable' } }) })
async function withKeys(fn) {
  const saved = [config.groqApiKey, config.openrouterApiKey]
  config.groqApiKey = 'groq-test'
  config.openrouterApiKey = 'router-test'
  try { await fn() } finally { [config.groqApiKey, config.openrouterApiKey] = saved }
}

test('Groq is primary, using only its own credential and model', () => withKeys(async () => {
  const calls = []
  const result = await askAI({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: async (url, opts) => {
    calls.push(url)
    assert.equal(opts.headers.Authorization, 'Bearer groq-test')
    assert.equal(JSON.parse(opts.body).model, config.groqModel)
    return success()
  } })
  assert.equal(result.provider, 'groq')
  assert.deepEqual(calls, ['https://api.groq.com/openai/v1/chat/completions'])
  assert.ok(describeConfigSources().secretKeys.includes('GROQ_API_KEY'))
}))

for (const status of [401, 402, 403, 429, 503]) {
  test(`Groq ${status} fails over with the OpenRouter credential`, () => withKeys(async () => {
    const result = await askAI({ sleepImpl: async () => {}, fetchImpl: async (url, opts) => {
      if (url.includes('api.groq.com')) return failure(status)
      assert.equal(opts.headers.Authorization, 'Bearer router-test')
      assert.equal(JSON.parse(opts.body).model, config.openrouterModel)
      return success()
    } })
    assert.equal(result.provider, 'openrouter')
  }))
}

test('Groq model fallback never sends OpenRouter model IDs to Groq', () => withKeys(async () => {
  const models = []
  const result = await askAI({ fetchImpl: async (url, opts) => {
    assert.ok(url.includes('api.groq.com'))
    models.push(JSON.parse(opts.body).model)
    return models.length === 1 ? failure(404) : success()
  } })
  assert.equal(result.model, 'llama-3.1-8b-instant')
  assert.deepEqual(models, [config.groqModel, 'llama-3.1-8b-instant'])
}))

test('OpenRouter-only configuration still works', () => withKeys(async () => {
  config.groqApiKey = ''
  assert.equal(hasAIKey(), true)
  const result = await askAI({ fetchImpl: async url => {
    assert.ok(url.includes('openrouter.ai'))
    return success()
  } })
  assert.equal(result.provider, 'openrouter')
}))

test('missing keys make no network calls', () => withKeys(async () => {
  config.groqApiKey = config.openrouterApiKey = ''
  assert.equal(hasAIKey(), false)
  await assert.rejects(askAI({ fetchImpl: () => assert.fail('must not call provider') }), e => e.status === 0)
}))

test('both rejected keys terminate after one request per provider', () => withKeys(async () => {
  let calls = 0
  await assert.rejects(askAI({ fetchImpl: async () => { calls++; return failure(401) } }), e => e.status === 401)
  assert.equal(calls, 2)
}))

test('Echidna failure copy contains no provider, credential or status details', () => {
  const source = readFileSync(new URL('../plugins/echidna.js', import.meta.url), 'utf8')
  const copy = source.match(/const quietReply = (.+)/)[1]
  assert.match(copy, /Stay for tea/)
  assert.doesNotMatch(copy, /OpenRouter|Groq|API|401|403|key|deployment/i)
  assert.equal((source.match(/return ctx.reply\(quietReply\)/g) || []).length, 2)
})
