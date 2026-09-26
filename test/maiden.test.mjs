/**
 * maiden.test.mjs - regression tests for Sword Maiden's voice, the .maiden
 * command, and the two rules that make her feel like herself:
 *
 *  1. CHARACTER ENTRY - data/characters.json carries sword_maiden as a
 *     bot-wide exclusive, her portrait is the animated giphy GIF, and her
 *     ability flavor points players at .maiden the same way Echidna's points
 *     at .echidna. plugins/character.js routes her card at .sword-spin.
 *
 *  2. OWNERSHIP - ownsSwordMaiden() reads ownedCharacters (ownership, not
 *     equip: she talks to the person she belongs to whether or not they are
 *     carrying her into battle).
 *
 *  3. PERSONALITY FILE - every section the renderer reads exists, the strict
 *     speech rules and boundaries are present, and every example line she
 *     actually says is ALREADY in her voice: softenMaidenReply() must be a
 *     no-op on all of them, or the data file is teaching the model to write
 *     punctuation her character never uses.
 *
 *  4. PROMPT - her holder's live facts land in the prompt (name, level,
 *     purse, body, battle, equip, spins) with no meta language, plus the
 *     reminder that the reply is post-processed.
 *
 *  5. THE VOICE ENFORCER - lowercase, zero punctuation, no emoji, no stage
 *     directions, contractions expanded, idempotent, and '' for input with
 *     nothing speakable left in it.
 *
 *  6. MEMORY - lives on the player record, bounded, JSON-safe, forgettable.
 *
 *  7. WIRING - the plugin reaches for the shared Groq-first router (no direct
 *     OpenRouter import), carries no dashes in player-facing copy, is not in
 *     either battle gate, and no other plugin claims her command names.
 *
 *  8. THE CHAT DOOR - a stranger gets a static dismissal and never a scene; a
 *     holder (and the bot owner, for live testing) reaches the quiet-time
 *     reply when no key is configured. Proven with both keys blanked: no
 *     network, no API call.
 *
 * Run:  node test/maiden.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'

const persona = await import('../lib/maiden-persona.js')
const { characterMap } = await import('../lib/game-data.js')
const maidenMod = await import('../plugins/maiden.js')
const { config } = await import('../config.js')
const { isOwnerJid } = await import('../lib/group-helpers.js')
const {
  MAIDEN_PERSONALITY, SWORD_MAIDEN_ID, MAIDEN_MEMORY_TURNS,
  ownsSwordMaiden, maidenChatHistory, rememberMaidenTurn, forgetMaidenChat,
  liveFacts, renderMaidenSystemPrompt, softenMaidenReply,
} = persona

let passed = 0
const failures = []
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`) }
  catch (err) { failures.push(name); console.log(`  ❌ ${name}\n      ${err.message.split('\n')[0]}`) }
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const PUNCT_FREE = /^[\p{L}\p{N}\s]*$/u
const speechSegments = (text) => [...String(text ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1])

console.log('── 1. character entry ──────────────────────────────────────────')
await ok('sword_maiden exists in data/characters.json as a bot-wide exclusive', () => {
  const c = characterMap[SWORD_MAIDEN_ID]
  assert.ok(c, 'sword_maiden missing from data/characters.json')
  assert.equal(c.exclusive, true)
  assert.equal(c.gemPrice, null)
  assert.equal(c.rarity, 'boundless')
  assert.match(c.image, /giphy\.com\/media\/.*giphy\.gif$/)
})
await ok('her ability flavor points players at .maiden', () => {
  const flavor = characterMap[SWORD_MAIDEN_ID].ability.flavor
  assert.match(flavor, /\.maiden/)
  assert.match(flavor, /\.sword/)
  assert.match(flavor, /\.ss/)
})
await ok('plugins/character.js routes her card at .sword-spin', () => {
  const src = read('../plugins/character.js')
  assert.match(src, /sword_maiden:\s*'sword-spin'/)
})

console.log('── 2. ownership ───────────────────────────────────────────────')
await ok('ownsSwordMaiden reads ownedCharacters, not equip', () => {
  assert.equal(ownsSwordMaiden({ ownedCharacters: ['sword_maiden'] }), true)
  assert.equal(ownsSwordMaiden({ ownedCharacters: ['sword_maiden'], equippedCharacter: 'echidna' }), true)
  assert.equal(ownsSwordMaiden({ equippedCharacter: 'sword_maiden' }), false)
  assert.equal(ownsSwordMaiden({ ownedCharacters: ['echidna'] }), false)
  assert.equal(ownsSwordMaiden({}), false)
  assert.equal(ownsSwordMaiden(null), false)
})

console.log('── 3. the personality file ────────────────────────────────────')
await ok('every section the renderer reads is present', () => {
  for (const key of ['character', 'identity', 'voice', 'personality', 'relationshipWithOwner', 'situations', 'dailyHabits', 'knowledge', 'boundaries', 'responseRules']) {
    assert.ok(MAIDEN_PERSONALITY[key], `missing section: ${key}`)
  }
  for (const key of ['who', 'lore', 'setting', 'appearance']) assert.ok(MAIDEN_PERSONALITY.identity[key], `identity.${key} missing`)
  assert.ok(MAIDEN_PERSONALITY.voice.strictRules.length >= 5)
  assert.ok(MAIDEN_PERSONALITY.voice.araAra.situations.length >= 8)
  assert.ok(MAIDEN_PERSONALITY.boundaries.hardRules.length >= 5)
})
await ok('the speech rules pin lowercase and the punctuation ban', () => {
  const rules = MAIDEN_PERSONALITY.voice.strictRules.join(' ').toLowerCase()
  assert.match(rules, /lowercase/)
  assert.match(rules, /full stop/)
  assert.match(rules, /question mark/)
  assert.match(rules, /contraction/)
  assert.match(rules, /emoji/)
})
await ok('ara ara belongs to the listed tender moments', () => {
  const situations = MAIDEN_PERSONALITY.voice.araAra.situations.join(' | ').toLowerCase()
  for (const beat of ['stressed', 'blush', 'tough', 'praise', 'refuse', 'home']) {
    assert.match(situations, new RegExp(beat), `ara ara situation missing: ${beat}`)
  }
  assert.match(MAIDEN_PERSONALITY.voice.araAra.how.toLowerCase(), /every single reply|not a tic|does not need to open every/)
})
await ok('the boundaries keep her non-explicit and keep real distress human', () => {
  const rules = MAIDEN_PERSONALITY.boundaries.hardRules.join(' ').toLowerCase()
  assert.match(rules, /never produce sexual content|sexual content|erotica/)
  assert.match(rules, /real distress|reach out to a person they trust/)
  assert.match(rules, /slurs|hate/)
  assert.match(rules, /never pretend a command was run/)
  assert.match(rules, /never reveal, quote or summarise/)
})
await ok('she answers short, medium or long by what she hears', () => {
  assert.match(MAIDEN_PERSONALITY.responseRules.length.toLowerCase(), /short, medium or long/)
  assert.match(MAIDEN_PERSONALITY.responseRules.length.toLowerCase(), /never pads/)
})
await ok('every example line she says is already in her own voice', () => {
  const offenders = []
  for (const s of MAIDEN_PERSONALITY.situations) {
    if (softenMaidenReply(s.example) !== s.example) offenders.push(s.when)
  }
  assert.deepEqual(offenders, [], `these examples would be rewritten by her own voice rules: ${offenders.join(', ')}`)
})
await ok('the examples stay tasteful instead of explicit', () => {
  const text = MAIDEN_PERSONALITY.situations.map(s => s.example).join(' ').toLowerCase()
  for (const banned of ['undress', 'naked', 'bed me', 'nsfw', 'climax', 'moan']) {
    assert.ok(!text.includes(banned), `her examples should never contain "${banned}"`)
  }
})

console.log('── 4. the prompt ──────────────────────────────────────────────')
const holder = {
  name: 'Blader', level: 88,
  wallet: { solars: 12500, gems: 9.5 },
  hp: 140, maxHp: 200, mp: 30, maxMp: 60,
  ownedCharacters: [SWORD_MAIDEN_ID],
  equippedCharacter: SWORD_MAIDEN_ID,
  swordMaidenSpins: 300,
  inBattle: false,
}
await ok('the prompt carries her identity, voice rules and boundaries', () => {
  const prompt = renderMaidenSystemPrompt(holder)
  assert.match(prompt, /Sword Maiden/)
  assert.match(prompt, /STRICT SPEECH RULES/)
  assert.match(prompt, /ARA ARA/)
  assert.match(prompt, /HARD BOUNDARIES/)
  assert.match(prompt, /LIVE FACTS/)
  assert.match(prompt, /WRITE IT RIGHT THE FIRST TIME/)
})
await ok('live facts carry the holder state she is allowed to know', () => {
  const facts = liveFacts(holder)
  assert.match(facts, /"Blader"/)
  assert.match(facts, /level 88/)
  assert.match(facts, /12500 Solars and 9\.5 Gems/)
  assert.match(facts, /140 of 200 health/)
  assert.match(facts, /not in battle/)
  assert.match(facts, /you are the one standing at their side/)
  assert.match(facts, /300 spins/)
  assert.match(facts, /Never mention odds, chances, guarantees or pity/)
})
await ok('a fight and another equip are reflected in the facts', () => {
  const battle = liveFacts({
    ...holder, inBattle: true, equippedCharacter: 'echidna',
    battleState: { enemy: { name: 'Wyrm' } },
  })
  assert.match(battle, /IN BATTLE right now, facing Wyrm/)
  assert.match(battle, /"echidna" equipped/)
  const duel = liveFacts({ ...holder, inBattle: true, battleState: { type: 'pvp' } })
  assert.match(duel, /another player in a duel/)
})
await ok('facts never leak meta words at her', () => {
  const facts = liveFacts(holder).toLowerCase()
  for (const meta of ['prompt', 'system', 'database', 'json', 'api', 'injected']) {
    assert.ok(!facts.includes(meta), `live facts should never say "${meta}"`)
  }
})
await ok('a holder with no spins yet is not told about a spin number', () => {
  assert.doesNotMatch(liveFacts({ ...holder, swordMaidenSpins: 0 }), /spins/i)
  assert.doesNotMatch(liveFacts({ ...holder, swordMaidenSpins: undefined }), /spins/i)
})

console.log('── 5. the voice enforcer ──────────────────────────────────────')
await ok('punctuation, capitals and emoji are rewritten out of a reply', () => {
  const out = softenMaidenReply("Ara ara, my sweet child! Don't you worry — mommy's here 😊")
  assert.equal(out, 'ara ara my sweet child do not worry mommys here')
  assert.ok(PUNCT_FREE.test(out))
})
await ok('no punctuation survives, whatever shape it arrives in', () => {
  const out = softenMaidenReply('Well... isn\'t that nice? "Come here," she said; (softly) {now} [child]')
  assert.ok(PUNCT_FREE.test(out), out)
  assert.ok(!out.includes('"') && !out.includes('_') && !out.includes('*'))
})
await ok('stage directions are dropped rather than spoken aloud', () => {
  assert.equal(softenMaidenReply('Ara ara. (smiling softly) You are home early, my dear.'), 'ara ara you are home early my dear')
  assert.equal(softenMaidenReply('[she laughs] come here'), 'come here')
})
await ok('contractions become her soft full words', () => {
  assert.equal(softenMaidenReply("I'm here, you're safe, it's alright"), 'i am here you are safe it is alright')
  assert.equal(softenMaidenReply("don't worry, won't you rest, can't you see"), 'do not worry will not rest cannot see')
  assert.equal(softenMaidenReply("he's tired and she's sleeping"), 'he is tired and she is sleeping')
})
await ok('typographic apostrophes and dashes are handled too', () => {
  assert.equal(softenMaidenReply('it\u2019s fine \u2014 truly \u2013 my dear'), 'it is fine truly my dear')
  assert.equal(softenMaidenReply('come here - right now'), 'come here right now')
})
await ok('line breaks between her thoughts survive', () => {
  const out = softenMaidenReply('ara ara my dear. come here.\n\nyou have been gone all day!')
  assert.equal(out, 'ara ara my dear come here\n\nyou have been gone all day')
})
await ok('nothing speakable returns empty, never a punctuation ghost', () => {
  assert.equal(softenMaidenReply(''), '')
  assert.equal(softenMaidenReply('   '), '')
  assert.equal(softenMaidenReply('😊 !!! ...'), '')
  assert.equal(softenMaidenReply(null), '')
})
await ok('the enforcer is idempotent', () => {
  const once = softenMaidenReply('Ara ara! Come here, my dear — mommy missed you 😊')
  assert.equal(softenMaidenReply(once), once)
})

console.log('── 6. memory on the player record ─────────────────────────────')
await ok('an empty or broken record reads as no history', () => {
  assert.deepEqual(maidenChatHistory({}), [])
  assert.deepEqual(maidenChatHistory({ maidenChat: 'nope' }), [])
  assert.deepEqual(maidenChatHistory({ maidenChat: [{ role: 'system', content: 'x' }, { role: 'user' }] }), [])
})
await ok('a turn is remembered and is JSON safe for the db', () => {
  const player = {}
  rememberMaidenTurn(player, 'i am tired', 'ara ara come here my sweet child')
  const roundTripped = JSON.parse(JSON.stringify(player))
  assert.deepEqual(maidenChatHistory(roundTripped), [
    { role: 'user', content: 'i am tired' },
    { role: 'assistant', content: 'ara ara come here my sweet child' },
  ])
})
await ok(`memory is bounded to ${MAIDEN_MEMORY_TURNS} exchanges`, () => {
  const player = {}
  for (let i = 0; i < 20; i++) rememberMaidenTurn(player, `turn ${i}`, `answer ${i}`)
  assert.equal(player.maidenChat.length, MAIDEN_MEMORY_TURNS * 2)
  assert.equal(player.maidenChat.at(-1).content, 'answer 19')
  assert.equal(player.maidenChat[0].content, 'turn 14')
})
await ok('forget empties the thread and survives a missing player', () => {
  const player = {}
  rememberMaidenTurn(player, 'hi', 'hello my dear')
  forgetMaidenChat(player)
  assert.deepEqual(player.maidenChat, [])
  assert.doesNotThrow(() => forgetMaidenChat(null))
})

console.log('── 7. wiring ───────────────────────────────────────────────────')
await ok('the plugin goes through the shared Groq-first router', () => {
  const src = read('../plugins/maiden.js')
  assert.match(src, /import \{ askAI, hasAIKey \} from '\.\.\/lib\/ai\.js'/)
  assert.doesNotMatch(src, /from '\.\.\/lib\/openrouter\.js'/)
  assert.match(src, /renderMaidenSystemPrompt/)
  assert.match(src, /softenMaidenReply/)
})
await ok('the plugin registers .maiden, her holder-only description and subcommands', () => {
  assert.equal(maidenMod.default.name, 'maiden')
  assert.ok(maidenMod.default.aliases.includes('sword-maiden'))
  assert.equal(maidenMod.default.category, 'character')
  assert.equal(maidenMod.default.requiresPlayer, true)
  assert.match(maidenMod.default.description, /maiden <message>/)
  assert.match(maidenMod.default.description, /holder only/)
  const subs = (maidenMod.default.subcommands ?? []).map(s => s.cmd).join(' ')
  assert.match(subs, /hug/)
  assert.match(subs, /forget/)
})
await ok('player-facing copy in the plugin carries no dashes', () => {
  const lines = read('../plugins/maiden.js').split('\n')
  const offenders = []
  lines.forEach((raw, i) => {
    if (/[—–‒―]/.test(raw)) offenders.push(`L${i + 1} dash: ${raw.trim().slice(0, 80)}`)
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return
    if (/[`'"]/.test(raw) && / - /.test(raw)) offenders.push(`L${i + 1} spaced dash in copy: ${line.slice(0, 80)}`)
  })
  assert.deepEqual(offenders, [], offenders.join('\n'))
})
await ok('every line she says inside her own scenes is in her voice', () => {
  const src = read('../plugins/maiden.js')
  const quotes = []
  for (const m of src.matchAll(/`(?:\\.|[^`])*`/g)) {
    for (const inner of speechSegments(m[0])) quotes.push(inner)
  }
  assert.ok(quotes.length >= 3, 'expected her quoted lines to be found in the plugin source')
  const offenders = quotes.filter(q => softenMaidenReply(q) !== q)
  assert.deepEqual(offenders, [], `these lines would be rewritten by her own rules: ${offenders.join(' | ')}`)
})
await ok('her card command is NOT battle allowed anywhere', () => {
  for (const rel of ['../handler.js', '../lib/platform/pipeline.js']) {
    const block = read(rel).match(/BATTLE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\n\]\)/)
    assert.ok(block, `${rel}: battle gate not found`)
    for (const token of ['maiden', 'sword-maiden', 'swordmaiden', 'sword_maiden']) {
      assert.ok(!block[1].includes(`'${token}'`), `${rel} whitelists '${token}' mid-battle`)
    }
  }
})
await ok('no other plugin claims her command names', () => {
  const mine = [maidenMod.default.name, ...maidenMod.default.aliases]
  const owners = new Map()
  for (const file of readdirSync(new URL('../plugins', import.meta.url)).filter(f => f.endsWith('.js'))) {
    const src = read(`../plugins/${file}`)
    const name = src.match(/\n\s*name:\s*'([^']+)'/)?.[1]
    const aliases = src.match(/aliases:\s*\[([^\]]*)\]/)?.[1] ?? ''
    for (const token of [name, ...aliases.matchAll(/'([^']+)'/g).map(m => m[1])].filter(Boolean)) {
      if (!owners.has(token)) owners.set(token, [])
      owners.get(token).push(file)
    }
  }
  for (const token of mine) {
    const claimants = owners.get(token) ?? []
    assert.deepEqual(claimants, ['maiden.js'], `'${token}' is also claimed by: ${claimants.join(', ')}`)
  }
})

console.log('── 8. the chat door (no key, no network) ──────────────────────')
function fakeCtx(from, owned = [], args = ['hi']) {
  const replies = []
  const db = { data: { users: { [from]: { name: 'Tester', ownedCharacters: owned } } }, write: async () => {}, read: async () => {} }
  return {
    db, from, args,
    player: db.data.users[from],
    reply: (text) => { replies.push(String(text)); return {} },
    replies,
  }
}

const savedGroqKey = config.groqApiKey
const savedRouterKey = config.openrouterApiKey
try {
  config.groqApiKey = ''
  config.openrouterApiKey = ''

  await ok('a stranger is turned away with the static dismissal', async () => {
    const ctx = fakeCtx('999someoneelse@s.whatsapp.net')
    await maidenMod.default.run(ctx)
    assert.equal(ctx.replies.length, 1)
    assert.match(ctx.replies[0], /are not the one i am kept by|there is one of me|spoken for in every way/)
  })

  await ok('a stranger cannot reach her scenes either', async () => {
    const ctx = fakeCtx('999someoneelse@s.whatsapp.net', [], ['hug'])
    await maidenMod.default.run(ctx)
    assert.equal(ctx.replies.length, 1)
    assert.doesNotMatch(ctx.replies[0], /let mommy hold you properly/)
  })

  await ok('her holder reaches the quiet-time reply without a key', async () => {
    const ctx = fakeCtx('555holder@s.whatsapp.net', [SWORD_MAIDEN_ID])
    await maidenMod.default.run(ctx)
    assert.equal(ctx.replies.length, 1)
    assert.match(ctx.replies[0], /i lost the thread for a moment but i have you now/)
  })

  await ok('the bot owner is let through without holding her', async () => {
    assert.equal(isOwnerJid('2347062301848@s.whatsapp.net'), true, 'config owner number changed')
    const ctx = fakeCtx('2347062301848:5@s.whatsapp.net')
    await maidenMod.default.run(ctx)
    assert.match(ctx.replies[0], /i lost the thread for a moment but i have you now/)
  })

  await ok('her scenes answer with no key and no network', async () => {
    for (const [word, expected] of [['hug', /let mommy hold you properly/], ['lap', /rest your head here/], ['headpat', /let mommy be proud of you/]]) {
      const ctx = fakeCtx('555holder@s.whatsapp.net', [SWORD_MAIDEN_ID], [word])
      await maidenMod.default.run(ctx)
      assert.equal(ctx.replies.length, 1)
      assert.match(ctx.replies[0], expected)
      for (const voice of speechSegments(ctx.replies[0])) {
        assert.equal(softenMaidenReply(voice), voice, `${word}: quoted line is not in her voice`)
      }
    }
  })

  await ok('a sentence that starts with a subcommand is still chat, not a scene', async () => {
    const ctx = fakeCtx('555holder@s.whatsapp.net', [SWORD_MAIDEN_ID], ['hug', 'me', 'mommy', 'i', 'had', 'a', 'bad', 'day'])
    await maidenMod.default.run(ctx)
    assert.doesNotMatch(ctx.replies[0], /let mommy hold you properly/)
    assert.match(ctx.replies[0], /i lost the thread for a moment but i have you now/)
  })

  await ok('her card renders for holders and points at her commands', async () => {
    const ctx = fakeCtx('555holder@s.whatsapp.net', [SWORD_MAIDEN_ID], [])
    await maidenMod.default.run(ctx)
    const text = ctx.replies.join('\n')
    assert.match(text, /SWORD MAIDEN/)
    assert.match(text, /Today's mood/)
    assert.match(text, /maiden <message>/)
    assert.match(text, /maiden hug/)
    assert.match(text, /maiden forget/)
    assert.match(text, /Yours, (and standing at your side|always)/)
    assert.doesNotMatch(text, /still holding your last/, 'no thread is held before the first thing they say')
  })

  await ok('her card shows the thread she is holding, once there is one', async () => {
    const ctx = fakeCtx('555holder@s.whatsapp.net', [SWORD_MAIDEN_ID], [])
    rememberMaidenTurn(ctx.player, 'i am tired', 'ara ara come here my sweet child')
    rememberMaidenTurn(ctx.player, 'i am better now', 'ara ara there is my good child')
    await maidenMod.default.run(ctx)
    assert.match(ctx.replies.join('\n'), /still holding your last \*2\* messages/)
  })

  await ok('her card sold to a stranger still names the spin, never the odds', async () => {
    const ctx = fakeCtx('999someoneelse@s.whatsapp.net', [], [])
    await maidenMod.default.run(ctx)
    const text = ctx.replies.join('\n')
    assert.match(text, /Not yours/)
    assert.match(text, /sword-spin/)
    assert.doesNotMatch(text, /1 gem a spin.*cap|dead zone|guarantee/i)
  })

  await ok('forget clears the thread she remembers', async () => {
    const jid = '555holder@s.whatsapp.net'
    const ctx = fakeCtx(jid, [SWORD_MAIDEN_ID], ['forget'])
    rememberMaidenTurn(ctx.player, 'i am tired', 'ara ara come here my sweet child')
    await maidenMod.default.run(ctx)
    assert.deepEqual(ctx.player.maidenChat, [])
    assert.match(ctx.replies[0], /begin again from here/)
  })

  await ok('an unknown subcommand is still just something you said to her', async () => {
    const ctx = fakeCtx('555holder@s.whatsapp.net', [SWORD_MAIDEN_ID], ['goodnight', 'mommy'])
    await maidenMod.default.run(ctx)
    assert.equal(ctx.replies.length, 1)
    assert.match(ctx.replies[0], /i lost the thread for a moment but i have you now/)
  })
} finally {
  config.groqApiKey = savedGroqKey
  config.openrouterApiKey = savedRouterKey
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.map(f => `  ❌ ${f}`).join('\n'))
  process.exit(1)
}
console.log('ALL MAIDEN CHECKS PASSED')
