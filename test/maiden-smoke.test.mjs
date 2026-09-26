/**
 * maiden-smoke.test.mjs - end-to-end smoke for .maiden: runs the REAL plugin
 * through a mocked ctx/db the way handler.js would, with a stubbed fetch
 * standing in for Groq and OpenRouter, so the whole path is exercised without
 * a socket, a key, or a network:
 *
 *   1. STRANGER GATE - a non-holder gets her static dismissal and the provider
 *      stack is never touched. A scene word does not leak either.
 *   2. HER VOICE - a holder's chat reaches GROQ first (url, credential and
 *      model checked), and whatever punctuation and emoji the model sends
 *      back is rewritten into her lowercase stream before it is sent and
 *      before it is stored.
 *   3. CONTINUITY - the exchange is written to the player's own record and fed
 *      back in on the next turn, so she remembers the thread across restarts.
 *   4. FAILOVER - a dead Groq (429) falls through to the OpenRouter credential
 *      the same way Echidna's voice does; both providers down returns her
 *      quiet-time line and stores nothing.
 *   5. MESSAGE LIMIT - a wall of text is trimmed before it reaches the model.
 *
 * Run:  node test/maiden-smoke.test.mjs
 */
import { config } from '../config.js'
import { SWORD_MAIDEN_ID } from '../lib/maiden-persona.js'

const maidenMod = await import('../plugins/maiden.js')

function makeDb(users) {
  return { data: { users }, write: async () => {}, read: async () => {} }
}

function makeCtx(db, from, args = []) {
  const replies = []
  return {
    db, from, args,
    player: db.data.users[from],
    sender: from,
    isGroup: false,
    platform: 'whatsapp',
    reply: async (t) => { replies.push(String(t)); return {} },
    replies,
  }
}

const HOLDER = 'holder@s.whatsapp.net'
const STRANGER = 'stranger@s.whatsapp.net'

const holderPlayer = () => ({
  name: 'Blader', level: 88,
  ownedCharacters: [SWORD_MAIDEN_ID], equippedCharacter: SWORD_MAIDEN_ID,
  wallet: { solars: 12500, gems: 9.5 },
  hp: 140, maxHp: 200, mp: 30, maxMp: 60,
  swordMaidenSpins: 300,
  inBattle: false,
})

let failures = 0
function check(name, cond) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name)
  if (!cond) failures++
}

const PUNCT_FREE = /^[\p{L}\p{N}\s]*$/u
const realFetch = globalThis.fetch
const savedKeys = [config.groqApiKey, config.openrouterApiKey]

/** An OpenAI-shaped success body carrying the text a model would have written. */
const completion = (text) => ({
  ok: true, status: 200, statusText: 'OK',
  json: async () => ({ choices: [{ message: { content: text } }] }),
})
const failure = (status) => ({
  ok: false, status, statusText: 'Error',
  json: async () => ({ error: { code: status, message: 'Unavailable' } }),
})

/** Records every provider call so the test can read urls, bodies and keys. */
function recordFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    const record = { url: String(url), auth: opts?.headers?.Authorization, body: JSON.parse(opts.body) }
    calls.push(record)
    return handler(record, calls.length)
  }
  return calls
}

try {
  config.groqApiKey = ''
  config.openrouterApiKey = ''

  // ════════════════ 1. stranger gate ════════════════
  console.log('── .maiden stranger gate (no keys, no network) ──')
  {
    const users = { [STRANGER]: { name: 'Nobody', level: 3, wallet: { solars: 5, gems: 0 } } }
    const db = makeDb(users)
    const calls = recordFetch(() => completion('should never be called'))

    const ctx = makeCtx(db, STRANGER, ['hi'])
    await maidenMod.default.run(ctx)
    check('non-holder gets a static dismissal', /are not the one i am kept by|there is one of me|spoken for in every way/.test(ctx.replies.join(' ')))
    check('no provider was called for a stranger', calls.length === 0)

    const ctx2 = makeCtx(db, STRANGER, ['hug'])
    await maidenMod.default.run(ctx2)
    check('a scene word does not leak to a stranger', /are not the one i am kept by|there is one of me|spoken for in every way/.test(ctx2.replies.join(' ')))
    check('still no provider call', calls.length === 0)
  }

  // ════════════════ 2. her voice over Groq ════════════════
  console.log('── .maiden chat goes to Groq first and comes back in her voice ──')
  {
    const users = { [HOLDER]: holderPlayer() }
    const db = makeDb(users)
    const raw = "Ara ara, my sweet child! I'm so glad you came in — you look exhausted. Let mommy hold you 😊"
    const calls = recordFetch(() => completion(raw))
    config.groqApiKey = 'groq-test-key'

    const ctx = makeCtx(db, HOLDER, ['i', 'am', 'tired', 'today'])
    await maidenMod.default.run(ctx)
    const out = ctx.replies.join('\n')

    check('exactly one reply reached the holder', ctx.replies.length === 1)
    check('the reply is her lowercase, punctuation free stream', PUNCT_FREE.test(out) && out === out.toLowerCase())
    check('the emoji, the dash and the contraction are gone', !out.includes('😊') && !out.includes('—') && !out.includes("i'm"))
    check('her warm words survived the rewrite', out.includes('ara ara') && out.includes('let mommy hold you'))
    check('the call went to Groq with the Groq credential and model', calls.length === 1 &&
      calls[0].url === 'https://api.groq.com/openai/v1/chat/completions' &&
      calls[0].auth === 'Bearer groq-test-key' &&
      calls[0].body.model === config.groqModel)
    check('the system prompt IS her personality file', /Sword Maiden/.test(calls[0].body.messages[0].content) &&
      /STRICT SPEECH RULES/.test(calls[0].body.messages[0].content) &&
      /ara ara/i.test(calls[0].body.messages[0].content))
    check('the holder state is in front of her', /Blader/.test(calls[0].body.messages[0].content) &&
      /12500 Solars/.test(calls[0].body.messages[0].content) &&
      /300 spins/.test(calls[0].body.messages[0].content))
    check('the reply is chat sized and warm', calls[0].body.max_tokens === 400 && calls[0].body.temperature >= 0.9)
    check('their message arrived as one turn', calls[0].body.messages.at(-1).content === 'i am tired today')

    // ════════════════ 3. continuity ════════════════
    console.log('── she remembers the thread, on the record ──')
    const stored = users[HOLDER].maidenChat
    check('the exchange was written to the player record', Array.isArray(stored) && stored.length === 2)
    check('the stored answer is the sanitized one, not the raw model text',
      stored.at(-1).content === out && stored.at(-1).role === 'assistant')
    check('the record stays JSON safe for db.json', JSON.parse(JSON.stringify(users[HOLDER])).maidenChat.length === 2)

    const ctx2 = makeCtx(db, HOLDER, ['do', 'you', 'remember'])
    await maidenMod.default.run(ctx2)
    const second = calls.at(-1).body.messages
    check('the previous turn is sent back as history', second.some(m => m.role === 'assistant' && m.content === out))
    check('and the new turn sits after it', second.at(-1).content === 'do you remember')
    check('the persona is still the system turn', second[0].role === 'system')
  }

  // ════════════════ 4. failover and total failure ════════════════
  console.log('── Groq dies, OpenRouter carries her ──')
  {
    const users = { [HOLDER]: holderPlayer() }
    const db = makeDb(users)
    config.groqApiKey = 'groq-test-key'
    config.openrouterApiKey = 'router-test-key'
    const calls = recordFetch((record) => record.url.includes('api.groq.com')
      ? failure(429)
      : completion('Router voice here my dear, come and rest!'))

    const ctx = makeCtx(db, HOLDER, ['hi'])
    await maidenMod.default.run(ctx)
    const out = ctx.replies.join('\n')
    const groqCalls = calls.filter(c => c.url.includes('api.groq.com'))
    const routerCalls = calls.filter(c => c.url.includes('openrouter.ai'))

    check('Groq was tried first, and retried before giving up', groqCalls.length >= 1)
    check('the OpenRouter backup answered with its own credential',
      routerCalls.length === 1 && routerCalls[0].auth === 'Bearer router-test-key')
    check('her voice was applied to the fallback answer too', out === 'router voice here my dear come and rest')
    check('the fallback exchange was remembered', (users[HOLDER].maidenChat ?? []).at(-1)?.content === out)
  }

  console.log('── both providers down ──')
  {
    const users = { [HOLDER]: holderPlayer() }
    const db = makeDb(users)
    recordFetch(() => failure(500))

    const ctx = makeCtx(db, HOLDER, ['hi'])
    await maidenMod.default.run(ctx)
    check('she answers with her quiet-time line', /i lost the thread for a moment but i have you now/.test(ctx.replies.join('')))
    check('nothing technical reaches the player', !/Error|500|provider|undefined/.test(ctx.replies.join('')))
    check('no half conversation is stored', (users[HOLDER].maidenChat ?? []).length === 0)
  }

  // ════════════════ 5. message limit + scenes + forget ════════════════
  console.log('── limits, scenes and letting the thread rest ──')
  {
    const users = { [HOLDER]: holderPlayer() }
    const db = makeDb(users)
    const calls = recordFetch(() => completion('ara ara my dear'))
    config.groqApiKey = 'groq-test-key'

    const long = 'tired '.repeat(200) // 1400 characters
    const ctx = makeCtx(db, HOLDER, [long])
    await maidenMod.default.run(ctx)
    const sent = calls.at(-1).body.messages.at(-1).content
    check('a wall of text is trimmed before the model sees it', sent.length <= 600 && sent.length > 0)
    check('the stored user turn is trimmed too', users[HOLDER].maidenChat.at(-2).content.length <= 600)

    const before = calls.length
    const scenes = makeCtx(db, HOLDER, ['hug'])
    await maidenMod.default.run(scenes)
    check('a scene answers without any provider call', calls.length === before)
    check('the scene is warm and hers', /ara ara/.test(scenes.replies[0]) && /let mommy hold you properly/.test(scenes.replies[0]))

    const forget = makeCtx(db, HOLDER, ['forget'])
    await maidenMod.default.run(forget)
    check('forget empties the thread', (users[HOLDER].maidenChat ?? []).length === 0)
    check('forget still answers in her voice', /begin again from here/.test(forget.replies.join('')))
  }
} finally {
  globalThis.fetch = realFetch
  config.groqApiKey = savedKeys[0]
  config.openrouterApiKey = savedKeys[1]
}

console.log(failures === 0 ? '\nMAIDEN SMOKE TEST: ALL PASSED' : `\nMAIDEN SMOKE TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
