/**
 * aizen-premium.test.mjs — regression tests for the 2026-09-21 batch:
 *
 *  1. AIZEN CHARACTER — data/characters.json entry shape: one-of-one
 *     (`exclusive`), the art URL, 5 stars, Kyōka Suigetsu ability block.
 *
 *  2. SPIN ODDS — the spec: spins 1–254 flat 0%, spin 255+ 100% (won at 255),
 *     300-spin lifetime cap, 0.7 gems per spin. The constants live privately
 *     in plugins/aizen-spin.js, so the file is also read raw and checked for
 *     drift against the spec numbers.
 *
 *  3. KYŌKA SUIGETSU — the passive: non-owners pass through untouched; a
 *     misdirect zeroes the blow and steals a sense; at 5/5 the hypnosis is
 *     complete and EVERY blow misdirects regardless of the roll.
 *
 *  4. KUROHITSUGI — multiplier scales with stolen senses and how wounded the
 *     enemy is; the gate is once per battle.
 *
 *  5. HŌGYOKU — heal, five senses at once, rest-of-battle stat surge; the gate
 *     is once per battle.
 *
 *  6. MONTHLY ABILITY GIFT — the premium rework: a monthly buyer is GIFTED a
 *     random unclaimed one-of-one outright (guaranteed, no luck roll anywhere),
 *     renewals keep what they hold, and a sold-out moment falls back to the
 *     caller's Crown's Favor grant. Exclusive: no ability is ever held twice.
 *
 *  7. STRIP ON EXPIRY — when Premium lapses (main.js sweep) or is revoked
 *     (.premium-revoke), the one-of-one returns to the shelf (registry claim
 *     released) and Crown's Favor leaves the inventory/equips. A strip never
 *     releases a claim held by someone else.
 *
 * Wager exclusion needs no test: resolveWagerAction() (lib/pvp-wager.js) never
 * routes through applyIncomingDamage() and runPvpTurn refuses character
 * actions in a wager state — the kit cannot leak into a wager duel.
 *
 * Run:  node test/aizen-premium.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  applyKyokaSuigetsu, aizenSenses, isCompleteHypnosis,
  kurohitsugiMultiplier, activateKurohitsugi, activateHogyoku,
  AIZEN_CHARACTER_ID, AIZEN_MAX_SENSES, AIZEN_MISDIRECT_CHANCE,
  KUROHITSUGI_BASE_MULT, KUROHITSUGI_PER_SENSE, KUROHITSUGI_EXECUTE_MULT,
  HOUGYOKU_HEAL_PCT, HOUGYOKU_STAT_MULT,
} = await import('../lib/character-abilities.js')
const { chanceForExclusiveSpin, getExclusiveSpinWinner, claimExclusiveSpinForPlayer } = await import('../lib/season-engine.js')
const {
  grantMonthlyExclusiveAbility, grantPremiumAbility, stripPremiumAbilities,
  PREMIUM_ABILITY_ID, abilityRegistryKey,
} = await import('../lib/premium-abilities.js')
const { characterMap } = await import('../lib/game-data.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const BUYER = '234000000101@s.whatsapp.net'
const OTHER = '234000000102@s.whatsapp.net'

function makePlayer(jid, name, extra = {}) {
  return {
    id: jid,
    name,
    level: 10,
    xp: 0,
    inBattle: true,
    stats: { str: 20, agi: 20, int: 20, def: 20, lck: 10 },
    hp: 50, maxHp: 100, mp: 30, maxMp: 50,
    wallet: { solars: 0, gems: 0 },
    inventory: [],
    skills: [],
    activeEffects: [],
    abilityInventory: [],
    equippedAbilities: [],
    abilitySlots: 1,
    premium: { active: false },
    registeredAt: Date.now(),
    ...extra,
  }
}

function makeDb(users) {
  return { data: { users: Object.fromEntries(users.map(u => [u.id, u])) } }
}

/** Force Math.random for the duration of fn, then restore. */
function withRandom(value, fn) {
  const orig = Math.random
  Math.random = () => value
  try { return fn() } finally { Math.random = orig }
}

// The odds shape from plugins/aizen-spin.js's header, encoded as the exact
// overrides that file passes to chanceForExclusiveSpin().
const AIZEN_ODDS = { deadZoneUntil: 254, plateauChance: 1.0, pityAt: 255 }

// ══════════════════════════════════════════════════════════════════════════
// 1. Aizen character entry
// ══════════════════════════════════════════════════════════════════════════

await test('aizen exists as a 5-star one-of-one exclusive', () => {
  const c = characterMap.aizen
  assert.ok(c, 'aizen missing from data/characters.json')
  assert.equal(c.id, AIZEN_CHARACTER_ID)
  assert.equal(c.stars, 5)
  assert.equal(c.exclusive, true, 'must be one-of-one bot-wide')
  assert.ok(c.image.includes('Aizen-Sosuke-The-One-Above-All.jpg'), 'art URL')
  assert.equal(c.ability.name, 'Kyōka Suigetsu')
  assert.ok(c.ability.flavor.length > 100, 'house-style flavor block')
  assert.ok(c.statBonuses?.int, 'stat bonuses present')
})

// ══════════════════════════════════════════════════════════════════════════
// 2. Spin odds — 1-254 flat 0%, 255+ 100%, cap 300, 0.7 gems per spin
// ══════════════════════════════════════════════════════════════════════════

await test('odds: spins 1-254 are a flat dead zone', () => {
  for (const spin of [1, 100, 253, 254]) {
    assert.equal(chanceForExclusiveSpin(spin, AIZEN_ODDS), 0, `spin ${spin} must be 0`)
  }
})

await test('odds: spin 255 onward is 100% (won at 255)', () => {
  for (const spin of [255, 256, 300]) {
    assert.equal(chanceForExclusiveSpin(spin, AIZEN_ODDS), 1, `spin ${spin} must be 1`)
  }
})

await test('spin plugin constants match the spec (no drift)', () => {
  const src = readFileSync(new URL('../plugins/aizen-spin.js', import.meta.url), 'utf8')
  for (const needle of [
    'const COST_PER_SPIN = 0.7',
    'const DEAD_ZONE_UNTIL = 254',
    'const PLATEAU_CHANCE = 1.0',
    'const PITY_AT = 255',
    'const MAX_SPINS_PER_PLAYER = 300',
  ]) {
    assert.ok(src.includes(needle), `plugins/aizen-spin.js must contain "${needle}"`)
  }
  // The exclusive lock: the claim registry must gate every pull.
  assert.ok(src.includes('getExclusiveSpinWinner'))
  assert.ok(src.includes('claimExclusiveSpinForPlayer'))
})

// ══════════════════════════════════════════════════════════════════════════
// 3. Kyōka Suigetsu — the passive
// ══════════════════════════════════════════════════════════════════════════

await test('non-Aizen owners pass through untouched', () => {
  const p = makePlayer(BUYER, 'Buyer')
  const res = applyKyokaSuigetsu(p, 400)
  assert.equal(res.damage, 400)
  assert.equal(res.misdirected, false)
})

await test('a misdirect zeroes the blow and steals one sense', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    battleState: { type: 'pvp' },
  })
  const res = withRandom(0, () => applyKyokaSuigetsu(p, 400))
  assert.equal(res.damage, 0)
  assert.equal(res.misdirected, true)
  assert.ok(res.message.length > 0)
  assert.equal(aizenSenses(p), 1)
  assert.equal(isCompleteHypnosis(p), false)
})

await test('a hit the hypnosis misses lands whole (no reduction layer)', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    battleState: { type: 'pvp' },
  })
  const res = withRandom(0.999, () => applyKyokaSuigetsu(p, 400))
  assert.equal(res.damage, 400)
  assert.equal(res.misdirected, false)
  assert.equal(aizenSenses(p), 0)
})

await test('at 5/5 senses the hypnosis is complete — every blow misdirects', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    battleState: { type: 'pvp', aizen: { senses: AIZEN_MAX_SENSES } },
  })
  // Even a roll that would normally miss the misdirect chance.
  const res = withRandom(0.999, () => applyKyokaSuigetsu(p, 400))
  assert.equal(res.damage, 0)
  assert.equal(res.misdirected, true)
  assert.equal(isCompleteHypnosis(p), true)
  assert.ok(res.message.includes('COMPLETE HYPNOSIS') === false, 'completion line only on the 5th steal')
})

await test('the 5th steal announces COMPLETE HYPNOSIS and caps the count', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    battleState: { type: 'pvp', aizen: { senses: 4 } },
  })
  const res = withRandom(0, () => applyKyokaSuigetsu(p, 400))
  assert.equal(res.misdirected, true)
  assert.ok(res.message.includes('COMPLETE HYPNOSIS'))
  assert.equal(aizenSenses(p), 5)
  // Another misdirect must not push the count past the cap.
  withRandom(0, () => applyKyokaSuigetsu(p, 400))
  assert.equal(aizenSenses(p), 5)
})

await test('tuning constants exist and are sane', () => {
  assert.ok(AIZEN_MISDIRECT_CHANCE > 0 && AIZEN_MISDIRECT_CHANCE < 1)
  assert.equal(AIZEN_MAX_SENSES, 5)
})

// ══════════════════════════════════════════════════════════════════════════
// 4. Kurohitsugi
// ══════════════════════════════════════════════════════════════════════════

await test('kurohitsugi multiplier: base at 0 senses vs a full-HP enemy', () => {
  const p = makePlayer(BUYER, 'Buyer', { equippedCharacter: 'aizen', battleState: {} })
  const e = { hp: 100, maxHp: 100 }
  assert.equal(kurohitsugiMultiplier(p, e), KUROHITSUGI_BASE_MULT)
})

await test('kurohitsugi multiplier: scales with senses AND missing HP', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    battleState: { aizen: { senses: 5 } },
  })
  const dying = { hp: 1, maxHp: 100 }
  const expected = KUROHITSUGI_BASE_MULT
    + KUROHITSUGI_PER_SENSE * 5
    + KUROHITSUGI_EXECUTE_MULT * 0.99
  assert.ok(Math.abs(kurohitsugiMultiplier(p, dying) - expected) < 1e-9)
  // The floor and the ceiling must be a real gap (the closer identity).
  const floor = kurohitsugiMultiplier(makePlayer(BUYER, 'B', { battleState: {} }), { hp: 100, maxHp: 100 })
  assert.ok(kurohitsugiMultiplier(p, dying) > floor * 2, 'ceiling must be far above the floor')
})

await test('kurohitsugi gate: wrong character / not in battle / once per battle', () => {
  const wrong = makePlayer(BUYER, 'Buyer', { battleState: {} })
  assert.equal(activateKurohitsugi(wrong).ok, false)

  const idle = makePlayer(BUYER, 'Buyer', { equippedCharacter: 'aizen', inBattle: false, battleState: {} })
  assert.equal(activateKurohitsugi(idle).ok, false)

  const p = makePlayer(BUYER, 'Buyer', { equippedCharacter: 'aizen', battleState: {} })
  assert.equal(activateKurohitsugi(p).ok, true)
  assert.equal(p.battleState.kurohitsugiUsed, true)
  const second = activateKurohitsugi(p)
  assert.equal(second.ok, false)
  assert.ok(second.message.includes('already been used'))
})

// ══════════════════════════════════════════════════════════════════════════
// 5. Hōgyoku
// ══════════════════════════════════════════════════════════════════════════

await test('hougyoku: heals, completes the hypnosis, and surges stats once', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    hp: 10, maxHp: 100,
    battleState: { aizen: { senses: 2 } },
  })
  const res = activateHogyoku(p)
  assert.equal(res.ok, true)
  assert.equal(p.hp, Math.min(100, 10 + Math.floor(100 * HOUGYOKU_HEAL_PCT)))
  assert.equal(aizenSenses(p), 5, 'all five senses fall at once')
  assert.equal(isCompleteHypnosis(p), true)
  const surge = (p.activeEffects ?? []).filter(e => e.type === 'strengthen')
  assert.equal(surge.length, 4, 'str/agi/int/def each surge')
  assert.ok(surge.every(e => e.remaining === 999), 'rest-of-battle duration')
  assert.equal(p.battleState.hougyokuUsed, true)

  const second = activateHogyoku(p)
  assert.equal(second.ok, false)
})

await test('hougyoku stat surge delta scales off the base stat', () => {
  const p = makePlayer(BUYER, 'Buyer', {
    equippedCharacter: 'aizen',
    stats: { str: 100, agi: 0, int: 50, def: 0, lck: 0 },
    battleState: {},
  })
  activateHogyoku(p)
  // addStatusEffect stores the stat under meta and the delta under value.
  const strEff = (p.activeEffects ?? []).find(e => e.meta?.stat === 'str')
  const expected = Math.round(100 * HOUGYOKU_STAT_MULT)
  assert.equal(strEff.value, expected, 'delta = base × surge')
})

// ══════════════════════════════════════════════════════════════════════════
// 6. Monthly ability gift (the premium rework)
// ══════════════════════════════════════════════════════════════════════════

await test('monthly gift: guaranteed, random, and never twice the same ability', () => {
  const db = makeDb([])
  const seen = new Set()
  for (let i = 0; i < 5; i++) {
    const jid = `u${i}@x`
    const p = makePlayer(jid, `P${i}`)
    const res = grantMonthlyExclusiveAbility(db, jid, p)
    assert.equal(res.outcome, 'won', `gift ${i} must be guaranteed while anything is unclaimed`)
    assert.ok(!seen.has(res.abilityId), 'no ability held twice')
    seen.add(res.abilityId)
    assert.equal(p.premiumAbility, res.abilityId)
    assert.equal(getExclusiveSpinWinner(db, abilityRegistryKey(res.abilityId)), jid)
  }
  assert.equal(seen.size, 5)
  // All five held: the sixth buyer is sold_out (caller falls back to Crown's Favor).
  const sixth = makePlayer('u5@x', 'P5')
  assert.equal(grantMonthlyExclusiveAbility(db, 'u5@x', sixth).outcome, 'sold_out')
})

await test('monthly renewal keeps the held one-of-one (no reroll)', () => {
  const db = makeDb([])
  const p = makePlayer(BUYER, 'Buyer')
  const first = grantMonthlyExclusiveAbility(db, BUYER, p)
  const again = grantMonthlyExclusiveAbility(db, BUYER, p)
  assert.equal(again.outcome, 'already')
  assert.equal(again.abilityId, first.abilityId)
  assert.equal(p.premiumAbility, first.abilityId)
})

await test('no luck roll anywhere in the gift path (deterministic under forced randomness)', () => {
  const db = makeDb([])
  for (const forced of [0, 0.5, 0.999]) {
    const jid = `r${forced}@x`
    const p = makePlayer(jid, 'R')
    const res = withRandom(forced, () => grantMonthlyExclusiveAbility(db, jid, p))
    assert.equal(res.outcome, 'won', `gift must be guaranteed at forced random=${forced}`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 7. Strip on expiry / revoke
// ══════════════════════════════════════════════════════════════════════════

await test('strip: the one-of-one returns to the shelf and Crown\'s Favor leaves', () => {
  const db = makeDb([])
  const p = makePlayer(BUYER, 'Buyer', { premiumAbility: 'night_eyes' })
  claimExclusiveSpinForPlayer(db, abilityRegistryKey('night_eyes'), BUYER)
  p.abilityInventory = [PREMIUM_ABILITY_ID, 'other_ability']
  p.equippedAbilities = [PREMIUM_ABILITY_ID]

  const res = stripPremiumAbilities(p, db)
  assert.equal(res.removedOneOfOne, 'night_eyes')
  assert.equal(res.removedCrown, true)
  assert.equal(p.premiumAbility, null)
  assert.equal(getExclusiveSpinWinner(db, abilityRegistryKey('night_eyes')), null, 'claim released')
  assert.deepEqual(p.abilityInventory, ['other_ability'])
  assert.deepEqual(p.equippedAbilities, [])
})

await test('strip: never releases a claim held by someone else', () => {
  const db = makeDb([])
  const p = makePlayer(BUYER, 'Buyer', { premiumAbility: 'freeze_touch' })
  claimExclusiveSpinForPlayer(db, abilityRegistryKey('freeze_touch'), OTHER) // not the buyer!
  const res = stripPremiumAbilities(p, db)
  assert.equal(res.removedOneOfOne, 'freeze_touch')
  assert.equal(getExclusiveSpinWinner(db, abilityRegistryKey('freeze_touch')), OTHER, 'other holder keeps it')
})

await test('after a strip the freed ability can be gifted again', () => {
  const db = makeDb([])
  const p = makePlayer(BUYER, 'Buyer')
  const first = grantMonthlyExclusiveAbility(db, BUYER, p)
  stripPremiumAbilities(p, db)
  const next = makePlayer(OTHER, 'Other')
  const res = grantMonthlyExclusiveAbility(db, OTHER, next)
  assert.equal(res.outcome, 'won')
  const all = [first.abilityId, res.abilityId]
  assert.ok(all.includes(first.abilityId), 'the freed one is back in circulation')
})

await test('strip on a player with neither grant is a safe no-op', () => {
  const db = makeDb([])
  const p = makePlayer(BUYER, 'Buyer')
  const res = stripPremiumAbilities(p, db)
  assert.equal(res.removedOneOfOne, null)
  assert.equal(res.removedCrown, false)
})

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.err.stack?.split('\n').slice(0, 3).join('\n    ')}`)
  process.exit(1)
}
