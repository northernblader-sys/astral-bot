/**
 * Guardian of the Innocent + Orihime Inoue.
 *
 * Data rules the owner set (no level gates, no "Ashen/Gilded" style names, all
 * companion speech lowercase with no punctuation, one week, not finishable in a
 * day, five one-per-bot companions), the pure engine, and an end-to-end run of
 * the REAL plugins (.guardian, .rescue, .attack, .companion) through a mocked
 * ctx/db, the same way handler.js drives them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import eventData from '../data/guardian-event.json' with { type: 'json' }
import companionData from '../data/guardian-companions.json' with { type: 'json' }
import {
  REGIONS, COMPANIONS, REGION_MAP, GUARDIAN, DAY_MS, startGuardianEvent, isGuardianActive, isRegionOpen,
  skipGuardianDays, captorDue, ensureGuardianState, claimCompanion, companionOwner, buildSlaver,
  rollCaptives, sanitizeCompanionSpeech, renderCompanionSystemPrompt, companionTurnStrike,
  companionVictoryHeal, yeniseiIntercept, recordCompanionTalk, resolveRescueVictory, rescuesLeftToday,
  consumeRescue, dailyCap, companionStoryChapters, renownRank, expireOffer,
} from '../lib/guardian-event.js'
import { awardFlatFame } from '../lib/fame-engine.js'
import { tickShunShunRikka, orihimeVictoryHeal } from '../lib/orihime.js'
import { buildNewPlayer } from '../lib/player-factory.js'
import { characterMap } from '../lib/game-data.js'
import * as orihimeSpin from '../plugins/orihime-spin.js'

const guardianPlugin = (await import('../plugins/guardian.js')).default
const rescuePlugin = (await import('../plugins/rescue.js')).default
const attackPlugin = (await import('../plugins/attack.js')).default
const companionPlugin = (await import('../plugins/companion.js')).default

const makeDb = (users = {}) => ({ data: { users }, write: async () => {}, read: async () => {} })
function makeCtx(db, from, args = []) {
  const replies = []
  return {
    db, from, args, sender: from, isGroup: false, platform: 'whatsapp',
    player: db.data.users[from],
    reply: async (t) => { replies.push(String(t)); return {} },
    replyImage: async (img, t) => { replies.push(`[IMG ${typeof img === 'string' ? img : 'buffer'}] ${t ?? ''}`); return {} },
    replyGif: async (_img, t) => { replies.push(`[GIF] ${t ?? ''}`); return {} },
    sendMessage: async () => ({}),
    replies,
  }
}
const run = async (plugin, db, from, args = []) => {
  const ctx = makeCtx(db, from, args)
  await plugin.run(ctx)
  return ctx.replies.join('\n')
}
const newPlayer = (id, name = 'Tester') => {
  const p = buildNewPlayer({ id, name, classId: 'warrior', raceId: 'human' })
  p.level = 40
  return p
}

// ── data rules ──────────────────────────────────────────────────────────────

test('seven locations, none level gated, none with AI-sounding names', () => {
  assert.equal(REGIONS.length, 7)
  for (const r of REGIONS) {
    assert.ok(!/ashen|gilded|shadow|whisper|obsidian|crimson|ember|veil/i.test(r.name), r.name)
    for (const key of Object.keys(r)) assert.ok(!/level/i.test(key), `${r.id} has a level key: ${key}`)
  }
})

test('five companions, one per location, all speech lowercase without punctuation', () => {
  assert.equal(COMPANIONS.length, 5)
  assert.deepEqual(COMPANIONS.map(c => c.id).sort(), ['lebore', 'minna', 'rune_lica', 'tenma', 'yenisei'])
  for (const c of COMPANIONS) {
    assert.ok(c.image?.startsWith('https://i.ibb.co/'), c.id)
    assert.equal(REGION_MAP[c.regionId]?.companionId, c.id)
    assert.ok(c.backstory.length >= 4)
    for (const k of ['request', 'accept', 'reject']) assert.match(c[k], /^[a-z0-9 ]+$/, `${c.id}.${k}`)
    assert.notEqual(c.type, 'pleasure')
  }
  assert.equal(companionData.companions.find(c => c.id === 'tenma').type, 'entertainer')
  assert.equal(eventData.banner, 'https://i.ibb.co/GQTZMN8H/Tanma.jpg')
})

test('one week long and not finishable in one day', () => {
  assert.equal(GUARDIAN.durationDays, 7)
  const maxPerDay = (GUARDIAN.dailyRescueCap + 5) * 3 // Lebore's +5, 3 captives each
  const top = eventData.renownRanks.at(-1).min
  assert.ok(top > maxPerDay * 3, 'top renown needs several days even at max luck')
  // Lebore's +5 cannot help here: a player who has Lebore can never earn a second companion.
  assert.ok(GUARDIAN.companionWinsNeeded >= GUARDIAN.dailyRescueCap, 'a companion takes more than one day')
  assert.ok(REGIONS.some(r => r.opensOnDay > 1), 'locations open over several days')
})

// ── engine ──────────────────────────────────────────────────────────────────

test('event clock opens locations day by day', () => {
  const db = makeDb()
  const now = Date.now()
  startGuardianEvent(db, { now })
  assert.equal(isGuardianActive(db), true)
  const open = () => REGIONS.filter(r => isRegionOpen(db, r)).map(r => r.id)
  assert.deepEqual(open(), ['mudgate', 'saltwick'])
  skipGuardianDays(db, 5)
  assert.equal(open().length, 7)
  skipGuardianDays(db, 2)
  assert.equal(isGuardianActive(db), false)
})

test('daily cap and Lebore +5', () => {
  const db = makeDb()
  startGuardianEvent(db)
  const p = newPlayer('a@s')
  assert.equal(rescuesLeftToday(db, p), GUARDIAN.dailyRescueCap)
  for (let i = 0; i < GUARDIAN.dailyRescueCap; i++) consumeRescue(db, p)
  assert.equal(rescuesLeftToday(db, p), 0)
  p.guardian.companion = 'lebore'
  assert.equal(dailyCap(p), GUARDIAN.dailyRescueCap + 5)
  skipGuardianDays(db, 1)
  assert.equal(rescuesLeftToday(db, p), GUARDIAN.dailyRescueCap + 5)
})

test('captor appears after 30 wins and vanishes for everyone once claimed', () => {
  const db = makeDb()
  startGuardianEvent(db)
  const region = REGION_MAP.brackenmoor
  const a = newPlayer('a@s'); const b = newPlayer('b@s')
  for (const p of [a, b]) ensureGuardianState(p)
  captorDue(db, a, region) // sync run
  captorDue(db, b, region)
  a.guardian.regionWins.brackenmoor = 29
  assert.equal(captorDue(db, a, region), false)
  a.guardian.regionWins.brackenmoor = 30
  b.guardian.regionWins.brackenmoor = 30
  assert.equal(captorDue(db, a, region), true)
  assert.equal(claimCompanion(db, 'lebore', 'a@s'), true)
  assert.equal(claimCompanion(db, 'lebore', 'b@s'), false)
  assert.equal(companionOwner(db, 'lebore'), 'a@s')
  assert.equal(captorDue(db, b, region), false)
  assert.equal(captorDue(db, a, REGION_MAP.mudgate), false, 'no companion there')
})

test('slavers scale to the player: no fight is trivial or impossible', () => {
  for (const level of [1, 40, 200]) {
    const p = newPlayer('x@s'); p.level = level
    const e = buildSlaver(p, REGION_MAP.mudgate)
    assert.ok(e.hp >= 60 && e.atk >= 5)
    const cap = buildSlaver(p, REGION_MAP.morrow, { captor: true })
    assert.ok(cap.hp > e.hp && cap.isCaptor)
  }
  const caps = rollCaptives(3)
  assert.equal(new Set(caps.map(c => c.name)).size, 3)
})

test('companion speech sanitizer', () => {
  assert.equal(sanitizeCompanionSpeech("Hello, Darling! I'm HERE 💕... okay?"), 'hello darling im here okay')
  assert.equal(sanitizeCompanionSpeech('  *smiles*  hi  '), 'smiles hi')
})

test('fame: flat award, tenma doubles, yenisei trust 25 adds 25%', () => {
  const p = { fame: 0 }
  const r = awardFlatFame(p, 'rescue', 120, 'Mudgate Market')
  assert.equal(r.gained, 120); assert.equal(p.fame, 120)
  const db = makeDb(); startGuardianEvent(db)
  const run1 = (comp, trust = 0) => {
    const pl = newPlayer('f@s'); ensureGuardianState(pl); pl.guardian.companion = comp; pl.guardian.trust = trust
    resolveRescueVictory(db, pl, { regionId: 'mudgate', captives: rollCaptives(2), isCaptor: false, slaverName: 'x' }, { rng: () => 0.99 })
    return pl.fame
  }
  const base = run1(null)
  assert.equal(base, GUARDIAN.fameBasePerCaptive * 2)
  assert.equal(run1('tenma'), base * 2)
  assert.equal(run1('yenisei', 25), Math.round(base * 1.25))
})

test('companion perks: battle strike, heals, yenisei save', () => {
  const p = newPlayer('p@s'); ensureGuardianState(p)
  const e = { name: 'Slaver', hp: 1000, maxHp: 1000 }
  p.guardian.companion = 'minna'
  assert.equal(companionTurnStrike(p, e, { turn: 1 }).damage, 50)
  assert.equal(companionTurnStrike(p, { ...e }, { type: 'pvp' }), null)
  p.guardian.companion = 'rune_lica'
  e.hp = 1000
  assert.equal(companionTurnStrike(p, e, { turn: 1 }).damage, 60)
  p.guardian.companion = 'tenma'; p.hp = 10
  assert.match(companionVictoryHeal(p), /Tenma/)
  p.guardian.companion = 'yenisei'; p.guardian.trust = 49; p.hp = 0
  p.battleState = { type: 'rescue' }
  assert.equal(yeniseiIntercept(p), '')
  p.guardian.trust = 50
  assert.match(yeniseiIntercept(p), /Yenisei/)
  assert.ok(p.hp > 0)
  p.hp = 0
  assert.equal(yeniseiIntercept(p), '', 'once per battle')
})

test('yenisei: trust from talking, story unlocks by trust, prompt carries live facts', () => {
  const y = COMPANIONS.find(c => c.id === 'yenisei')
  const p = newPlayer('y@s'); ensureGuardianState(p); p.guardian.companion = 'yenisei'
  const t0 = 1_000_000
  assert.equal(recordCompanionTalk(p, t0).gained, 1)
  assert.equal(recordCompanionTalk(p, t0 + 1000).gained, 0, '3 minute cooldown')
  assert.equal(companionStoryChapters(y, p), 1)
  p.guardian.trust = 50
  assert.equal(companionStoryChapters(y, p), 4)
  p.inventory = ['health_potion', 'health_potion']
  p.wallet.solars = 4321
  const prompt = renderCompanionSystemPrompt(y, p, makeDb())
  assert.match(prompt, /4321 solars/)
  assert.match(prompt, /x2/)
  assert.match(prompt, /not an ai/)
  assert.match(prompt, /lowercase/)
})

test('renown ranks', () => {
  assert.equal(renownRank(0).label, 'Bystander')
  assert.equal(renownRank(eventData.renownRanks.at(-1).min).label, 'Guardian of the Innocent')
})

// ── Orihime ─────────────────────────────────────────────────────────────────

test('orihime is a 3 star global exclusive with the given art', () => {
  const o = characterMap.orihime
  assert.equal(o.stars, 3)
  assert.equal(o.exclusive, true)
  assert.equal(o.image, 'https://i.ibb.co/tPMVJG1g/Inoue-Orihime.jpg')
  assert.equal(o.ability.name, 'Shun Shun Rikka')
})

test('orihime spin: 3000 solars, 250 cap, 0% until 230, guaranteed at 231', () => {
  assert.equal(orihimeSpin.COST_PER_SPIN, 3000)
  assert.equal(orihimeSpin.MAX_SPINS_PER_PLAYER, 250)
  for (let s = 1; s <= 230; s++) assert.equal(orihimeSpin.orihimeSpinWins(s, () => 0), false, `spin ${s}`)
  for (const s of [231, 240, 250]) assert.equal(orihimeSpin.orihimeSpinWins(s, () => 0.99999), true)
})

test('orihime spin end to end: closed without the event, wins on spin 231, then locked', async () => {
  const db = makeDb({ 'o@s': newPlayer('o@s', 'Ori'), 'q@s': newPlayer('q@s', 'Other') })
  const plugin = orihimeSpin.default
  assert.match(await run(plugin, db, 'o@s', ['5']), /banner is closed/)
  startGuardianEvent(db)
  const p = db.data.users['o@s']
  p.wallet.solars = 3000 * 250
  p.orihimeSpins = 225
  const out = await run(plugin, db, 'o@s', ['50'])
  assert.match(out, /ORIHIME INOUE OBTAINED/)
  assert.equal(p.orihimeSpins, 231)
  assert.ok(p.ownedCharacters.includes('orihime'))
  assert.equal(p.wallet.solars, 3000 * 250 - 6 * 3000)
  db.data.users['q@s'].wallet.solars = 1e7
  assert.match(await run(plugin, db, 'q@s', ['1']), /ALREADY TAKEN/)
  assert.equal(db.data.users['q@s'].wallet.solars, 1e7)
})

test('shun shun rikka heals each turn, rejects one poison per battle, halves in pvp', () => {
  const p = { equippedCharacter: 'orihime', hp: 50, maxHp: 1000, activeEffects: [{ type: 'poison', turns: 3 }] }
  const bs = {}
  const r = tickShunShunRikka(p, bs)
  assert.ok(r.healed > 0)
  assert.equal(p.activeEffects.length, 0)
  p.activeEffects.push({ type: 'poison', turns: 3 })
  tickShunShunRikka(p, bs)
  assert.equal(p.activeEffects.length, 1, 'only one rejection per battle')
  const q = { equippedCharacter: 'orihime', hp: 900, maxHp: 1000, activeEffects: [] }
  const pve = tickShunShunRikka({ ...q }, {}).healed
  const pvp = tickShunShunRikka({ ...q }, {}, { pvp: true }).healed
  assert.equal(pvp, Math.floor(pve / 2))
  assert.equal(tickShunShunRikka({ hp: 1, maxHp: 10 }, {}), null, 'not equipped')
  assert.match(orihimeVictoryHeal({ equippedCharacter: 'orihime', hp: 1, maxHp: 100 }), /\+15/)
})

// ── end to end through the real plugins ─────────────────────────────────────

async function fightToTheEnd(db, from) {
  let out = ''
  for (let i = 0; i < 80 && db.data.users[from].inBattle; i++) out += '\n' + await run(attackPlugin, db, from)
  return out
}

test('rescue end to end: travel, fight, captives talk, freed, fame', async () => {
  const db = makeDb({ 'r@s': newPlayer('r@s', 'Rescuer') })
  startGuardianEvent(db)
  const p = db.data.users['r@s']
  p.maxHp = p.hp = 5000

  assert.match(await run(rescuePlugin, db, 'r@s'), /Pick where to go/)
  assert.match(await run(guardianPlugin, db, 'r@s', ['travel', 'brackenmoor']), /opens in/)
  assert.match(await run(guardianPlugin, db, 'r@s', ['travel', 'mudgate']), /Mudgate Market/)
  const start = await run(rescuePlugin, db, 'r@s')
  assert.equal(p.battleState?.type, 'rescue')
  assert.match(start, /In the cage/)
  assert.equal(rescuesLeftToday(db, p), GUARDIAN.dailyRescueCap - 1)

  const fameBefore = p.fame ?? 0
  const out = await fightToTheEnd(db, 'r@s')
  assert.equal(p.inBattle, false)
  if (/RESCUE WON/.test(out)) {
    assert.ok(p.guardian.freed >= 1)
    assert.ok(p.fame > fameBefore)
    assert.match(out, /FREED/)
  } else {
    assert.match(out, /RESCUE FAILED/)
  }
  assert.match(await run(guardianPlugin, db, 'r@s'), /GUARDIAN OF THE INNOCENT/)
  assert.match(await run(guardianPlugin, db, 'r@s', ['map']), /Morrow Keep/)
})

test('a lost rescue is not a death: gear and inventory stay', async () => {
  const db = makeDb({ 'l@s': newPlayer('l@s', 'Loser') })
  startGuardianEvent(db)
  const p = db.data.users['l@s']
  await run(guardianPlugin, db, 'l@s', ['travel', 'saltwick'])
  await run(rescuePlugin, db, 'l@s')
  const inv = [...p.inventory]
  const eq = JSON.stringify(p.equipped)
  p.battleState.enemy.atk = 1e7
  p.battleState.enemy.hp = p.battleState.enemy.maxHp = 1e9
  const out = await fightToTheEnd(db, 'l@s')
  assert.match(out, /RESCUE FAILED/)
  assert.equal(p.inBattle, false)
  assert.ok(p.hp >= 1)
  assert.deepEqual(p.inventory, inv)
  assert.equal(JSON.stringify(p.equipped), eq)
})

test('captor, companion request with image, accept, exclusivity, talk', async () => {
  const db = makeDb({ 'c@s': newPlayer('c@s', 'Keeper'), 'd@s': newPlayer('d@s', 'Late') })
  startGuardianEvent(db)
  skipGuardianDays(db, 5)
  const p = db.data.users['c@s']
  p.maxHp = p.hp = 5000
  await run(guardianPlugin, db, 'c@s', ['travel', 'morrow keep'])
  p.guardian.regionWins.morrow = 30
  const start = await run(rescuePlugin, db, 'c@s')
  assert.equal(p.battleState.guardian.isCaptor, true)
  assert.match(start, /Baron Oskar Vell/)
  p.battleState.enemy.hp = 1
  const win = await fightToTheEnd(db, 'c@s')
  assert.match(win, /RESCUE WON/)
  assert.match(win, /\[IMG https:\/\/i\.ibb\.co\/[^\]]+\] ⛓️ \*SOMEONE IS ASKING FOR YOU\*/)
  assert.match(win, /Tenma/)
  assert.equal(p.guardian.offer.companionId, 'tenma')

  // Blocks new rescues until answered.
  assert.match(await run(rescuePlugin, db, 'c@s'), /still waiting on your answer/)
  const acc = await run(guardianPlugin, db, 'c@s', ['accept'])
  assert.match(acc, /TENMA IS YOURS/)
  assert.equal(companionOwner(db, 'tenma'), 'c@s')

  // The other player never meets her.
  const d = db.data.users['d@s']
  await run(guardianPlugin, db, 'd@s', ['travel', 'morrow'])
  d.guardian.regionWins.morrow = 50
  await run(rescuePlugin, db, 'd@s')
  assert.equal(d.battleState.guardian.isCaptor, false)
  assert.doesNotMatch(await run(guardianPlugin, db, 'd@s', ['map']), /someone important is held here.*\n.*Morrow/)

  // Talk: model replies with capitals, punctuation and emoji; she comes out clean.
  const realFetch = globalThis.fetch
  let sentSystem = ''
  globalThis.fetch = async (_url, opts) => {
    sentSystem = JSON.parse(opts.body).messages[0].content
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Oh, DARLING! You came back 💕 — sit with me?' } }] }) }
  }
  try {
    const talk = await run(companionPlugin, db, 'c@s', ['talk', 'hi', 'tenma'])
    assert.match(talk, /\*Tenma:\* oh darling you came back sit with me$/)
    assert.match(sentSystem, /you are Tenma/)
    assert.equal(p.guardian.chat.length, 2)
    assert.equal(p.guardian.trust, 1)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.match(await run(companionPlugin, db, 'c@s'), /Tenma/)
  assert.match(await run(companionPlugin, db, 'c@s', ['story']), /TENMA/)
})

test('an unanswered request lapses and pushes the captor back', () => {
  const p = newPlayer('e@s'); ensureGuardianState(p)
  p.guardian.regionWins.kettle = 30
  p.guardian.offer = { companionId: 'minna', regionId: 'kettle', expiresAt: Date.now() - 1 }
  const c = expireOffer(p)
  assert.equal(c.id, 'minna')
  assert.equal(p.guardian.offer, null)
  assert.equal(p.guardian.captorRetryAt.kettle, 30 + GUARDIAN.captorRetryWins)
  assert.ok(DAY_MS > 0)
})
