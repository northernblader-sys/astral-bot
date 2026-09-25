import test from 'node:test'
import assert from 'node:assert/strict'
import { askAI, buildMessages } from '../lib/openrouter.js'
import { config } from '../config.js'

const okReply = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) })
const errReply = (status, message) => ({ ok: false, status, statusText: 'x', json: async () => ({ error: { code: status, message } }) })

test('the shared key is configured and used by default', () => {
  assert.ok(config.openrouterApiKey.startsWith('sk-or-v1-'))
})

test('no key throws a status 0 error', async () => {
  await assert.rejects(() => askAI({ apiKey: '', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 0)
})

test('sends a bearer key, a system turn and OpenAI-style messages', async () => {
  let captured = null
  const fetchImpl = async (url, opts) => { captured = { url, opts, body: JSON.parse(opts.body) }; return okReply('hello there') }
  const res = await askAI({
    apiKey: 'sk-or-v1-test', model: 'google/gemini-2.5-flash', system: 'You are Tenma.',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }, { role: 'model', content: 'x' }],
    fetchImpl,
  })
  assert.equal(res.text, 'hello there')
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(captured.opts.headers.Authorization, 'Bearer sk-or-v1-test')
  assert.equal(captured.body.model, 'google/gemini-2.5-flash')
  assert.deepEqual(captured.body.messages.map(m => m.role), ['system', 'user', 'assistant', 'assistant'])
})

test('an unknown model falls down the ladder', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => {
    const { model } = JSON.parse(opts.body)
    seen.push(model)
    return model === 'bogus/model' ? errReply(404, 'No endpoints found') : okReply('fine')
  }
  const res = await askAI({ apiKey: 'k', model: 'bogus/model', messages: [{ role: 'user', content: 'hi' }], fetchImpl })
  assert.equal(res.text, 'fine')
  assert.equal(seen[0], 'bogus/model')
  assert.notEqual(res.model, 'bogus/model')
})

test('auth errors surface immediately', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return errReply(401, 'User not found') }
  await assert.rejects(() => askAI({ apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], fetchImpl }), (e) => e.status === 401)
  assert.equal(calls, 1)
})

test('buildMessages drops empty turns', () => {
  assert.equal(buildMessages('', [{ role: 'user', content: '' }, null]).length, 0)
})
