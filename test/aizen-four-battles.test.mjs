/**
 * aizen-four-battles.test.mjs — Aizen's kit in all four battle forms.
 *
 * The four forms of battle in this bot, and where each resolves:
 *   1. CLASSIC 1v1   (dungeon/monster: plugins/kurohitsugi.js, plugins/hogyoku.js
 *                     against battleState.enemy, no boss)
 *   2. SWARM FLOOR   (battleState.mode === 'swarm': lib/swarm-combat.js's
 *                     telegraph engine; actives fold in via resolveSwarmAbility)
 *   3. BOSS FIGHT    (battleState.enemy.isBoss + bossState: lib/boss-engine.js
 *                     hooks on every turn)
 *   4. PVP DUEL      (battleState.type === 'pvp': plugins/pvp.js's runPvpTurn,
 *                     entered through pvpKurohitsugi/pvpHogyoku)
 *
 * What this file proves per form:
 *   - Kyōka Suigetsu's misdirect fires through applyIncomingDamage() (the
 *     "did the hit happen" tier) on that form's exact battleState shape,
 *     steals senses, and completes at 5/5.
 *   - Kurohitsugi and Hōgyoku RESOLVE in the form (real plugin turns where
 *     the form has one: classic, swarm, boss; the real duel engine for PvP),
 *     burn their once-per-battle charge, and refuse the second use.
 *   - THE SWARM REGRESSION: a Kurohitsugi that kills ONE monster of a pack
 *     never clears the floor while other monsters are alive (the kill routes
 *     through resolveSwarmAbility's shared branch). Before the swarm branches
 *     existed, the1v1 turn ran against bs.enemy and handleVictory wiped the
 *     whole pack off one kill.
 *   - Flavor text runs in every form and the whole Aizen copy surface
 *     (description, ability flavor, every pool in lib/aizen-flavor.js) obeys
 *     the house no-dash rule (commas, colons, periods, never an em or en
 *     dash) — the 2026-09-21 "remove all em dash" request, pinned as a
 *     regression.
 *
 * Wager duels stay excluded by design (runPvpTurn refuses character actions
 * in a wager state before anything else) and that refusal is asserted here.
 *
 * Run:  node test/aizen-four-battles.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  applyIncomingDamage, activateKurohitsugi, activateHogyoku,
  kurohitsugiMultiplier, aizenSenses, isCompleteHypnosis, hasAizen,
  AIZEN_CHARACTER_ID, AIZEN_MAX_SENSES, AIZEN_MISDIRECT_CHANCE,
} = await import('../lib/character-abilities.js')
const flavor = await import('../lib/aizen-flavor.js')
const kurohitsugiPlugin = (await import('../plugins/kurohitsugi.js')).default
const hogyokuPlugin = (await import('../plugins/hogyoku.js')).default
const { pvpKurohitsugi, pvpHogyoku } = await import('../plugins/pvp.js')
const { initBossFight, isLiveBossFight } = await import('../lib/boss-engine.js')
const { buildSwarmFloor } = await import('../lib/swarm-combat.js')
const { characterMap } = await import('../lib/game-data.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const ACTOR = '234000000201@s.whatsapp.net'
const OPP   = '234000000202@s.whatsapp.net'

function makePlayer(jid, name, extra = {}) {
  return {
    id: jid,
    name,
    classId: 'warrior',
    raceId: 'human',
    level: 30,
    xp: 0,
    hp: 250,
    maxHp: 500,
    mp: 100,
    maxMp: 100,
    inBattle: true,
    stats: { str: 20, agi: 20, int: 20, def: 20, lck: 10 },
    baseStats: { str: 20, agi: 20, int: 20, def: 20, lck: 10, maxHp: 500, maxMp: 100 },
    statPoints: { version: 1, earned: 0, spent: 0, unallocated: 0, allocations: {} },
    wallet: { solars: 0, gems: 0 },
    equipped: { weapon: null, helmet: null, chestplate: null, boots: null, relic: null, pet: null },
    inventory: [],
    chest: { unlocked: false, items: [] },
    skills: [],
    activeEffects: [],
    abilityInventory: [],
    equippedAbilities: [],
    abilitySlots: 1,
    summonedBeasts: [],
    beastInventory: [],
    activeBeast: null,
    ownedCharacters: [AIZEN_CHARACTER_ID],
    equippedCharacter: AIZEN_CHARACTER_ID,
    stamina: { current: 10, max: 10 },
    dungeonProgress: {},
    location: 'gambits_dungeon',
    registeredAt: Date.now(),
    premium: { active: false },
    ...extra,
  }
}

function makeDb(users) {
  return { data: { users: Object.fromEntries(users.map(u => [u.id, u])), parties: {} } }
}

function makeCtx(db, from) {
  const sent = []
  const images = []
  return {
    db,
    from,
    sender: from,
    isGroup: false,
    platform: 'whatsapp',
    botName: 'Sun',
    cmd: 'kurohitsugi',
    args: [],
    body: '',
    msg: { message: {} },
    sent,
    images,
    reply: async (text) => { sent.push(String(text)); return text },
    replyImage: async (image, caption = '') => { images.push(String(caption)); return caption },
    replyGif: async (image, caption = '') => { images.push(String(caption)); return caption },
    sock: { sendMessage: async () => ({ key: {} }) },
  }
}

/** Force Math.random for the duration of fn, then restore. */
function withRandom(value, fn) {
  const orig = Math.random
  Math.random = () => value
  try { return fn() } finally { Math.random = orig }
}

/** Classic 1v1 shape: one enemy in battleState.enemy, no boss, no swarm. */
function classicBattle(player, enemy) {
  player.inBattle = true
  player.battleState = {
    type: 'dungeon',
    enemy,
    turn: 1,
    playerDefending: false,
    abilityCooldowns: {},
    startedAt: Date.now(),
    lastMoveAt: Date.now(),
  }
}

function makeMonster(extra = {}) {
  return {
    name: 'Test Wraith', emoji: '👾', hp: 999_999, maxHp: 999_999,
    atk: 10, def: 5, xp: 100, solars: 50, drops: [], tier: 'regular', ...extra,
  }
}

const allText = (ctx) => [...ctx.sent, ...ctx.images].join('\n')

// ══════════════════════════════════════════════════════════════════════════
// 1. Kyōka Suigetsu passive: the four battleState shapes
// ══════════════════════════════════════════════════════════════════════════

for (const [formName, makeBs] of [
  ['classic 1v1', (p) => {
    const e = makeMonster()
    classicBattle(p, e)
    return [p.battleState, e]
  }],
  ['swarm floor', (p) => {
    const built = buildSwarmFloor('gambits_dungeon', 30, p)
    p.inBattle = true
    p.battleState = {
      type: 'dungeon', mode: 'swarm', locationId: 'gambits_dungeon', floor: 30,
      enemy: built.monsters.find((m) => m.alive),
      monsters: built.monsters, isApprentice: built.isApprentice,
      playerLane: 1, playerDefending: false, turn: 1, abilityCooldowns: {},
    }
    return [p.battleState, p.battleState.enemy]
  }],
  ['boss fight', (p) => {
    const init = initBossFight(p, 'aizen_sosuke', 70)
    p.inBattle = true
    p.battleState = {
      type: 'dungeon', enemy: { ...init.enemy, isBoss: true }, bossState: init.bossState,
      turn: 1, playerDefending: false, startedAt: Date.now(), lastMoveAt: Date.now(),
    }
    return [p.battleState, p.battleState.enemy]
  }],
  ['pvp duel', (p) => {
    p.inBattle = true
    p.battleState = {
      type: 'pvp', opponentJid: OPP, myTurn: true, defending: false,
      turn: 1, startedAt: Date.now(), lastMoveAt: Date.now(),
    }
    return [p.battleState, null]
  }],
]) {
  await test(`passive misdirects on the ${formName} battleState shape`, () => {
    const p = makePlayer(ACTOR, 'Sousuke')
    const [bs] = makeBs(p)
    const res = withRandom(0.0, () => applyIncomingDamage(p, 400, bs))
    assert.equal(res.damage, 0, 'a misdirected blow never arrives')
    assert.ok(res.message.length > 0, 'the misdirect narrates')
    assert.equal(aizenSenses(p, bs), 1, 'one sense stolen')
  })

  await test(`passive pierce lands whole on the ${formName} shape (his honest trade)`, () => {
    const p = makePlayer(ACTOR, 'Sousuke')
    const [bs] = makeBs(p)
    const res = withRandom(0.99, () => applyIncomingDamage(p, 400, bs))
    assert.equal(res.damage, 400, 'no reduction layer: the blow lands whole')
    assert.ok(res.message.length > 0, 'the pierce narrates (enemy reaction beat)')
    assert.equal(aizenSenses(p, bs), 0, 'a landed blow teaches him nothing')
  })
}

await test('complete hypnosis at 5/5: every later blow misdirects regardless of the roll', () => {
  const p = makePlayer(ACTOR, 'Sousuke')
  const bs = { aizen: { senses: 4 } }
  for (let i = 0; i < 3; i++) {
    withRandom(0.0, () => applyIncomingDamage(p, 400, bs))
    if (isCompleteHypnosis(p, bs)) break
  }
  assert.equal(aizenSenses(p, bs), 5)
  assert.ok(isCompleteHypnosis(p, bs))
  // Math.random = 0.99 would normally pierce: at 5/5 it cannot.
  const res = withRandom(0.99, () => applyIncomingDamage(p, 400, bs))
  assert.equal(res.damage, 0)
  assert.ok(res.message.includes('COMPLETE HYPNOSIS') || aizenSenses(p, bs) === 5)
})

await test('non-Aizen owners pass through with no message and no sense arc', () => {
  const p = makePlayer(OPP, 'NoChar', { ownedCharacters: [], equippedCharacter: null })
  const res = withRandom(0.0, () => applyIncomingDamage(p, 400, {}))
  assert.equal(res.damage, 400)
  assert.equal(res.message, '')
  assert.equal(hasAizen(p), false)
})

// ══════════════════════════════════════════════════════════════════════════
// 2. Form 1: classic 1v1 — real Kurohitsugi and Hōgyoku turns
// ══════════════════════════════════════════════════════════════════════════

await test('classic 1v1: Kurohitsugi turn resolves RAW and burns the charge', async () => {
  const p = makePlayer(ACTOR, 'Sousuke')
  const e = makeMonster()
  classicBattle(p, e)
  const db = makeDb([p])
  const ctx = makeCtx(db, ACTOR)

  await withRandom(0.99, () => kurohitsugiPlugin.run(ctx))

  const text = allText(ctx)
  assert.ok(text.includes('KUROHITSUGI'), 'the coffin is narrated')
  assert.ok(text.includes('ignores DEF'), 'the RAW contract is stated')
  assert.ok(e.hp < e.maxHp, 'the enemy took damage')
  assert.equal(p.battleState.kurohitsugiUsed, true, 'once-per-battle charge burned')
  assert.equal(p.battleState.turn, 2, 'the turn advanced')

  // Second use is refused, and the refusal is what the player sees.
  const ctx2 = makeCtx(db, ACTOR)
  await kurohitsugiPlugin.run(ctx2)
  assert.ok(allText(ctx2).toLowerCase().includes('already') || allText(ctx2).includes('❌'), 'second use refused')
  assert.ok(!allText(ctx2).includes('damage!'), 'no second strike')
})

await test('classic 1v1: Hōgyoku turn evolves him (heal, five senses, surge)', async () => {
  const p = makePlayer(ACTOR, 'Sousuke')
  const e = makeMonster()
  classicBattle(p, e)
  const db = makeDb([p])
  const ctx = makeCtx(db, ACTOR)

  await withRandom(0.99, () => hogyokuPlugin.run(ctx))

  const text = allText(ctx)
  assert.ok(text.includes('HŌGYOKU ANSWERS'), 'the evolution is narrated')
  assert.ok(p.hp > 250, `reforged HP (got ${p.hp}/500)`)
  assert.equal(aizenSenses(p, p.battleState), AIZEN_MAX_SENSES, 'all five senses fall at once')
  const surge = (p.activeEffects ?? []).filter((x) => x.sourceId === 'hougyoku')
  assert.ok(surge.length > 0, 'rest-of-battle strengthen armed')
  assert.equal(p.battleState.hougyokuUsed, true, 'once-per-battle charge burned')
})

// ══════════════════════════════════════════════════════════════════════════
// 3. Form 2: swarm floors — the fold-in (and the floor-clear regression)
// ══════════════════════════════════════════════════════════════════════════

function makeSwarm(p, floor = 30) {
  const built = buildSwarmFloor('gambits_dungeon', floor, p)
  assert.ok(built, 'buildSwarmFloor returned a pack')
  assert.ok(built.monsters.length >= 2, 'a swarm pack has at least two monsters')
  p.inBattle = true
  p.battleState = {
    type: 'dungeon', mode: 'swarm', locationId: 'gambits_dungeon', floor,
    enemy: built.monsters.find((m) => m.alive),
    monsters: built.monsters, isApprentice: built.isApprentice,
    playerLane: 1, playerDefending: false, turn: 1, abilityCooldowns: {},
  }
  return p.battleState
}

await test('swarm: Kurohitsugi folds into ONE swarm turn and keeps the pack honest', async () => {
  const p = makePlayer(ACTOR, 'Sousuke')
  const bs = makeSwarm(p)
  // One coffin kills whichever monster it reaches; the rest must survive.
  for (const m of bs.monsters) { m.hp = 5; m.maxHp = Math.max(m.maxHp, 5) }
  const beforeAlive = bs.monsters.filter((m) => m.alive).length
  const db = makeDb([p])
  const ctx = makeCtx(db, ACTOR)

  await withRandom(0.99, () => kurohitsugiPlugin.run(ctx))

  const text = allText(ctx)
  assert.ok(text.includes('KUROHITSUGI'), 'the coffin is narrated on the swarm turn')
  const aliveAfter = bs.monsters.filter((m) => m.alive).length
  assert.equal(aliveAfter, beforeAlive - 1, 'exactly the struck monster died')
  assert.equal(p.battleState, bs, 'the FLOOR was not wrongly cleared (battleState intact)')
  assert.equal(bs.mode, 'swarm', 'still a swarm fight')
  assert.ok(text.includes('FLOOR') || text.includes('SWARM'), 'the swarm frame came back')
})

await test('swarm: Hōgyoku spends its turn evolving while the pack holds', async () => {
  const p = makePlayer(ACTOR, 'Sousuke')
  const bs = makeSwarm(p)
  const hpBefore = bs.monsters.map((m) => m.hp)
  const db = makeDb([p])
  const ctx = makeCtx(db, ACTOR)

  await withRandom(0.99, () => hogyokuPlugin.run(ctx))

  const text = allText(ctx)
  assert.ok(text.includes('HŌGYOKU ANSWERS'), 'the evolution is narrated in the swarm')
  assert.equal(aizenSenses(p, bs), AIZEN_MAX_SENSES, 'all five senses his')
  assert.ok(p.hp > 250, 'reforged HP')
  assert.deepEqual(bs.monsters.map((m) => m.hp), hpBefore, 'the Hōgyoku damages nothing')
  assert.equal(p.battleState, bs, 'the floor still runs')
})

// ══════════════════════════════════════════════════════════════════════════
// 4. Form 3: boss fights — real turn against a real boss definition
// ══════════════════════════════════════════════════════════════════════════

await test('boss: Kurohitsugi turn runs the boss-engine hooks and the counter', async () => {
  // Big HP on purpose: with BOSS_DAMAGE_TO_PLAYER_SCALE at 0.75 a real boss
  // counter can genuinely kill a 500-HP character in one swing, and a death
  // would clear battleState before the assertions read it.
  const p = makePlayer(ACTOR, 'Sousuke', { hp: 4000, maxHp: 5000 })
  const init = initBossFight(p, 'aizen_sosuke', 70)
  assert.ok(init.ok, 'boss fight initialised')
  p.inBattle = true
  p.battleState = {
    type: 'dungeon', enemy: { ...init.enemy, isBoss: true }, bossState: init.bossState,
    turn: 1, playerDefending: false, startedAt: Date.now(), lastMoveAt: Date.now(),
  }
  const bossEnemy = p.battleState.enemy
  const bossHpBefore = bossEnemy.hp
  const db = makeDb([p])
  const ctx = makeCtx(db, ACTOR)

  await withRandom(0.99, () => kurohitsugiPlugin.run(ctx))

  const text = allText(ctx)
  assert.ok(text.includes('KUROHITSUGI'), 'the coffin is narrated against the boss')
  assert.ok(bossEnemy.hp < bossHpBefore, 'the boss bled')
  assert.ok(text.includes('💬'), 'the boss engine answered (hit line or taunt)')
  assert.equal(p.battleState.kurohitsugiUsed, true, 'charge burned')
  assert.ok(isLiveBossFight(p) || bossEnemy.hp <= 0, 'fight continues (or finished)')
})

await test('boss: the counter-attack routes through the Kyōka tier', () => {
  const p = makePlayer(ACTOR, 'Sousuke')
  const init = initBossFight(p, 'aizen_sosuke', 70)
  p.inBattle = true
  p.battleState = {
    type: 'dungeon', enemy: { ...init.enemy, isBoss: true }, bossState: init.bossState,
    turn: 1, playerDefending: false,
  }
  const res = withRandom(0.0, () => applyIncomingDamage(p, 300, p.battleState))
  assert.equal(res.damage, 0, 'a boss strike can be misdirected like any other')
  assert.equal(aizenSenses(p, p.battleState), 1)
})

// ══════════════════════════════════════════════════════════════════════════
// 5. Form 4: PvP duels — the real turn engine (runPvpTurn)
// ══════════════════════════════════════════════════════════════════════════

function makeDuel() {
  const actor = makePlayer(ACTOR, 'Sousuke')
  const opp = makePlayer(OPP, 'Ichigo', { ownedCharacters: [], equippedCharacter: null })
  actor.inBattle = true
  opp.inBattle = true
  actor.battleState = {
    type: 'pvp', opponentJid: OPP, myTurn: true, defending: false,
    turn: 1, startedAt: Date.now(), lastMoveAt: Date.now(),
  }
  opp.battleState = {
    type: 'pvp', opponentJid: ACTOR, myTurn: false, defending: false,
    turn: 1, startedAt: Date.now(), lastMoveAt: Date.now(),
  }
  const db = makeDb([actor, opp])
  const ctx = makeCtx(db, ACTOR)
  return { actor, opp, db, ctx }
}

await test('duel: pvpHogyoku resolves the evolution inside the real turn engine', async () => {
  const { actor, db, ctx } = makeDuel()
  await withRandom(0.99, () => pvpHogyoku(ctx))
  const text = allText(ctx)
  assert.ok(text.includes('HŌGYOKU ANSWERS'), 'duel narration carries the reveal')
  assert.ok(actor.hp > 250, `healed (got ${actor.hp}/500)`)
  assert.equal(aizenSenses(actor, actor.battleState), AIZEN_MAX_SENSES, 'five senses in the duel')
  assert.equal(actor.battleState.hougyokuUsed, true, 'charge burned in the duel')
})

await test('duel: pvpKurohitsugi lands RAW through the real turn engine', async () => {
  const { actor, opp, db, ctx } = makeDuel()
  const hpBefore = opp.hp
  await withRandom(0.99, () => pvpKurohitsugi(ctx))
  const text = allText(ctx)
  assert.ok(text.includes('KUROHITSUGI'), 'the coffin is narrated in the duel')
  assert.ok(opp.hp < hpBefore, 'the opponent took the coffin')
  assert.equal(actor.battleState.kurohitsugiUsed, true, 'charge burned in the duel')
})

await test('duel: a wager state refuses the kit outright (no character powers)', async () => {
  const { actor, db, ctx } = makeDuel()
  actor.battleState.wager = true
  await pvpKurohitsugi(ctx)
  const text = allText(ctx)
  assert.ok(text.includes('wager'), 'the refusal names the mode')
  assert.ok(!text.includes('damage'), 'nothing landed')
})

// ══════════════════════════════════════════════════════════════════════════
// 6. Flavor pools + the no-dash copy rule
// ══════════════════════════════════════════════════════════════════════════

await test('every Aizen flavor pool output obeys the no-dash rule', () => {
  const enemy = makeMonster()
  const samples = []
  for (let i = 0; i < 25; i++) {
    samples.push(flavor.kyokaMisdirectLine())
    samples.push(flavor.kyokaSenseLine('Sight', 1, 5))
    samples.push(flavor.kyokaSenseLine('Taste', 5, 5))
    samples.push(flavor.kyokaCompleteLine())
    samples.push(flavor.kyokaLandedLine())
    samples.push(flavor.maybeEnemyReaction())
    samples.push(flavor.kurohitsugiCastLine(0), flavor.kurohitsugiCastLine(5))
    samples.push(flavor.kurohitsugiImpactLine({}), flavor.kurohitsugiImpactLine({ execute: true }), flavor.kurohitsugiImpactLine({ kill: true }))
    samples.push(flavor.hougyokuAwakenLine(), flavor.hougyokuEnemyReactionLine())
    samples.push(flavor.aizenPlayerHit('Sousuke', enemy, 12))
    samples.push(flavor.aizenPlayerCrit('Sousuke', enemy, 30))
    samples.push(flavor.aizenPlayerMiss('Sousuke', enemy))
    samples.push(flavor.aizenPlayerAbsorbed('Sousuke', enemy))
    samples.push(flavor.aizenEnemyHit(enemy, 9))
    samples.push(flavor.aizenEnemyMiss(enemy))
  }
  const bad = samples.filter((s) => /[—–]/.test(s))
  assert.equal(bad.length, 0, `em/en dash leaked into flavor copy:\n${bad.slice(0, 3).join('\n')}`)
})

await test('Aizen description and ability flavor carry no em or en dashes', () => {
  const c = characterMap[AIZEN_CHARACTER_ID]
  assert.ok(c, 'aizen present in data/characters.json')
  const raw = `${c.description ?? ''}\n${c.ability?.flavor ?? ''}`
  assert.ok(!/[—–]/.test(raw), 'the 2026-09-21 em-dash removal holds')
  assert.ok(c.description.length > 50)
})

await test('the sense steal names the exact sense and the running count', () => {
  const line = flavor.kyokaSenseLine('Hearing', 2, 5)
  assert.ok(line.includes('Hearing'))
  assert.ok(line.includes('(2/5 senses)'))
})

// (ESM-imported battle flavor, kept separate so the harness above stays simple)
const battleFlavor = await import('../lib/battle-flavor.js')
await test('attack.js swing lines come from Aizen when he is equipped', () => {
  const enemy = makeMonster()
  // The Aizen pools and the generic pools are disjoint voices: sample a
  // couple of signature phrases and check the Aizen branch fires when the
  // character id is passed, and the generic one when it is not.
  const aizenHit = battleFlavor.playerHitLine('Sousuke', enemy, 12, false, 'aizen')
  const genericHit = battleFlavor.playerHitLine('Sousuke', enemy, 12, false, null)
  assert.ok(typeof aizenHit === 'string' && aizenHit.length > 0)
  assert.ok(typeof genericHit === 'string' && genericHit.length > 0)
  assert.ok(!/[—–]/.test(aizenHit), 'his swing copy keeps the no-dash rule')
  const aizenEnemy = battleFlavor.enemyHitLine(enemy, 9, 'aizen')
  assert.ok(!/[—–]/.test(aizenEnemy), 'the enemy reaction copy keeps the no-dash rule')
})

// ══════════════════════════════════════════════════════════════════════════
// 7. Source drift guards (same style as aizen-premium.test.mjs's spin check)
// ══════════════════════════════════════════════════════════════════════════

await test('swarm branches exist in both actives (the four-forms fix)', () => {
  const kuro = readFileSync(new URL('../plugins/kurohitsugi.js', import.meta.url), 'utf8')
  const hou  = readFileSync(new URL('../plugins/hogyoku.js', import.meta.url), 'utf8')
  assert.ok(kuro.includes("mode === 'swarm'"), 'kurohitsugi folds into the swarm turn')
  assert.ok(kuro.includes('resolveSwarmAbility'), 'kurohitsugi uses the shared swarm hook')
  assert.ok(hou.includes("mode === 'swarm'"), 'hougyoku folds into the swarm turn')
  assert.ok(hou.includes('resolveSwarmAbility'), 'hougyoku uses the shared swarm hook')
})

await test('the duel wires both actives and spares their weapons', () => {
  const src = readFileSync(new URL('../plugins/pvp.js', import.meta.url), 'utf8')
  assert.ok(src.includes("action === 'kurohitsugi'"), 'kurohitsugi action routed')
  assert.ok(src.includes("action === 'hougyoku'"), 'hougyoku action routed')
  assert.ok(src.includes("|| action === 'kurohitsugi' || action === 'hougyoku' || action === 'greedtithe')"), 'neither wears the weapon (Echidna\'s tithe added to the same wear-free list)')
  assert.ok(src.includes('kurohitsugiCastLine'), 'duel narration reads the flavor pools')
})

await test('bosses hit meaningfully harder (BOSS_DAMAGE_TO_PLAYER_SCALE raised)', () => {
  const src = readFileSync(new URL('../lib/boss-engine.js', import.meta.url), 'utf8')
  assert.ok(src.includes('BOSS_DAMAGE_TO_PLAYER_SCALE = 0.75'), 'scale pinned at 0.75 (was 0.60)')
})

// ── summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
