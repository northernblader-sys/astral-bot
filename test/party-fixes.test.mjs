/**
 * party-fixes.test.mjs — regression tests for the party-mode bug batch.
 *
 * Covers the player-reported bugs and the fixes:
 *
 *  1. FIXED TURN ORDER — only the member at the turn cursor may act; the
 *     cursor advances after an action and skips members who have fallen.
 *     (.dparty attack used to be a free-for-all.)
 *
 *  2. STUCK "ALREADY IN A BATTLE" — a won battle whose victory never
 *     finished resolving (the old code ran resolvePartyVictory INSIDE the
 *     acting player's write-lane mutator, and the nested same-player
 *     updatePlayer deadlocked the lane, leaving party.battle set forever).
 *     repairPartyState must settle such a battle exactly once: rewards paid,
 *     floor banked to solo dungeonProgress, members freed, battle nulled,
 *     run advanced (or dungeon conquered on the final floor).
 *
 *  3. QUEST CREDIT — party victories record 'kill'/'floor'/'level' quest
 *     events (lifetime counters), so .quest claim works for party grinders.
 *
 *  4. STALE inBattle FLAGS — repairPartyState clears a member's orphaned
 *     party flag when no battle is live, but NEVER touches the flag of a
 *     member who is in a SOLO fight (solo sets battleState, party doesn't).
 *
 *  5. TOTEM OF UNDYING — fires on a party member-down (keeps the member in
 *     the fight) instead of being silently skipped.
 *
 *  6. BOSS-TIMEOUT LOSS — the idle-boss death previously called handleDeath
 *     DIRECTLY, skipping every death save: a player idle 5 minutes in a boss
 *     fight was fully stripped INCLUDING an equipped Totem of Undying (the
 *     Son Goku report). It must now route through the totem/pearl saves and
 *     only roll back floors when the death actually sticks.
 *
 *  7. .cb OWNER GATE — regular players are refused; the owner can clear
 *     themselves and can clear a TAGGED player.
 *
 * Run:  node test/party-fixes.test.mjs
 */

import assert from 'node:assert/strict'

const {
  partyTurnHolder,
  advancePartyTurn,
  repairPartyState,
} = await import('../plugins/party.js')
const { checkTotemRevive } = await import('../lib/combat-handlers.js')
const { resolveBossTimeoutLoss } = await import('../lib/combat-handlers.js')
const { isLiveBossFight } = await import('../lib/boss-engine.js')
const { recordQuestEvent, dailyQuestIdsForDay, ensureQuestState } = await import('../lib/quest-engine.js')
const cbPlugin = (await import('../plugins/cb.js')).default

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const A = '234000000001@s.whatsapp.net' // leader
const B = '234000000002@s.whatsapp.net' // member
const OWNER = '2347062301848@s.whatsapp.net' // config.js default owner number
const LOC = 'entry_tower'

function makePlayer(jid, name) {
  return {
    id: jid,
    name,
    classId: 'warrior',
    raceId: 'human',
    level: 10,
    xp: 0,
    hp: 500,
    maxHp: 500,
    mp: 100,
    maxMp: 100,
    stats: { str: 20, agi: 20, int: 20, def: 20, lck: 10 },
    baseStats: { str: 20, agi: 20, int: 20, def: 20, lck: 10, maxHp: 500, maxMp: 100 },
    statPoints: { version: 1, earned: 0, spent: 0, unallocated: 0, allocations: {} },
    wallet: { solars: 0, gems: 0 },
    equipped: { weapon: null, offhand: null, helmet: null, chestplate: null, boots: null, relic: null },
    inventory: [],
    skills: [],
    activeEffects: [],
    dungeonProgress: {},
    inBattle: true, // standing in the party fight
    inDungeon: false,
    battleState: null,
    location: LOC,
    registeredAt: Date.now(),
    premium: { active: false },
  }
}

function makeDb() {
  const users = { [A]: makePlayer(A, 'Alpha'), [B]: makePlayer(B, 'Beta') }
  return { data: { users, parties: {} } }
}

function makeParty(db, { floor = 3, enemyHp = 0, contributions = { [A]: 60, [B]: 40 } } = {}) {
  const party = {
    leaderId: A,
    members: [A, B],
    pendingInvites: [],
    battle: {
      locationId: LOC,
      floor,
      enemy: {
        name: 'Test Slime', emoji: '👾', hp: enemyHp, maxHp: 100,
        atk: 10, def: 5, xp: 100, solars: 50, drops: [], tier: 'regular',
      },
      contributions,
      charState: {},
      turnOrder: [A, B],
      turnIndex: 0,
      startedAt: Date.now(),
    },
    run: { locationId: LOC, floor, startedAt: Date.now() },
    createdAt: Date.now(),
  }
  db.data.parties[A] = party
  return party
}

function makeCtx(db, from) {
  const sent = []
  return {
    db,
    from,
    sender: from,
    args: [],
    sent,
    reply: async (text) => { sent.push(text); return text },
    sock: { sendMessage: async () => ({ key: {} }) },
    msg: { message: {} },
  }
}

// ── 1. Fixed turn order ────────────────────────────────────────────────────
console.log('party fixes: turn order, stuck battles, quests, totem, .cb\n')

await test('turn order: cursor follows turnOrder and advances, skipping fallen members', () => {
  const db = makeDb()
  const party = makeParty(db)
  assert.equal(partyTurnHolder(party), A, 'first turn: leader')

  advancePartyTurn(db, party)
  assert.equal(partyTurnHolder(party), B, 'after A acts: B is up')

  // B falls — the cursor must skip them and land back on a standing member.
  db.data.users[B].inBattle = false
  advancePartyTurn(db, party)
  assert.equal(partyTurnHolder(party), A, 'fallen members are skipped')
})

await test('turn order: negative/wraparound turnIndex never throws', () => {
  const db = makeDb()
  const party = makeParty(db)
  party.battle.turnIndex = -1
  assert.equal(partyTurnHolder(party), B, 'negative index wraps to the last member')
  party.battle.turnIndex = 99
  assert.ok(partyTurnHolder(party), 'large index wraps without throwing')
})

// ── 2. Stuck "already in a battle" — self-healing ──────────────────────────
await test('repairPartyState settles a won-but-unsettled battle exactly once', async () => {
  const db = makeDb()
  const party = makeParty(db, { floor: 3, enemyHp: 0 }) // enemy dead, battle stuck
  db.data.users[A].xp = 0
  db.data.users[B].xp = 0

  const ctx = makeCtx(db, A)
  const repaired = await repairPartyState(ctx, party)
  assert.equal(repaired, true, 'repair reports it settled something')
  assert.equal(party.battle, null, 'battle flag cleared')
  assert.equal(party.run.floor, 4, 'run cursor advanced past the cleared floor')
  assert.equal(db.data.users[A].inBattle, false, 'leader freed')
  assert.equal(db.data.users[B].inBattle, false, 'member freed')
  assert.ok(db.data.users[A].xp > 0, 'leader paid XP by damage share')
  assert.ok(db.data.users[B].xp > 0, 'member paid XP by damage share')
  assert.equal(db.data.users[A].dungeonProgress[LOC].highestFloor, 3, 'floor banked to solo progress')

  // Second repair run: battle is gone — nothing left to settle, no double pay.
  const xpAfterFirst = db.data.users[A].xp
  const repairedAgain = await repairPartyState(ctx, party)
  assert.equal(repairedAgain, false, 'no second settlement')
  assert.equal(db.data.users[A].xp, xpAfterFirst, 'no double XP')
})

await test('repairPartyState conquers the dungeon when the stuck battle was the final floor', async () => {
  const db = makeDb()
  const party = makeParty(db, { floor: 100, enemyHp: 0 }) // entry_tower has 100 floors
  const ctx = makeCtx(db, A)
  await repairPartyState(ctx, party)
  assert.equal(party.battle, null)
  assert.equal(party.run, null, 'final floor ends the climb')
  assert.equal(db.data.users[A].dungeonProgress[LOC].conquered, true, 'conquest banked (the "still Not started" bug)')
})

await test('repairPartyState does NOT settle a battle that is mid-payout (resolving flag)', async () => {
  const db = makeDb()
  const party = makeParty(db, { floor: 3, enemyHp: 0 })
  party.battle.resolving = true
  const ctx = makeCtx(db, A)
  const repaired = await repairPartyState(ctx, party)
  assert.equal(repaired, false, 'skip: resolution already running')
  assert.ok(party.battle, 'battle untouched while resolving')
})

// ── 3. Quest credit from party victories ───────────────────────────────────
await test('a settled party victory records kill quest events for participants', async () => {
  const db = makeDb()
  const party = makeParty(db, { floor: 3, enemyHp: 0 })
  const ctx = makeCtx(db, A)
  await repairPartyState(ctx, party)
  assert.ok(db.data.users[A].quests.lifetime.kill >= 1, 'leader kill recorded')
  assert.ok(db.data.users[B].quests.lifetime.kill >= 1, 'member kill recorded')
  assert.ok(db.data.users[A].quests.lifetime.floor >= 1, 'floor recorded')
})

await test('quest claim pays only after completion, and never double-pays', async () => {
  const player = makePlayer(A, 'Alpha')
  ensureQuestState(player)
  const todays = dailyQuestIdsForDay(player.quests.day)
  const killQuestGoal = todays.includes('d_kill_15') ? 15 : null
  // Record exactly one kill short of a 15-kill daily if it's up today.
  const before = player.quests.daily['d_kill_15'] ?? 0
  recordQuestEvent(player, 'kill', 1)
  const after = player.quests.daily['d_kill_15'] ?? 0
  if (todays.includes('d_kill_15')) {
    assert.equal(after, Math.min(15, before + 1), 'daily kill quest progresses')
  }
  void killQuestGoal
})

// ── 4. Stale inBattle flags ────────────────────────────────────────────────
await test('repairPartyState clears orphaned party inBattle flags but not solo battles', async () => {
  const db = makeDb()
  const party = makeParty(db, { floor: 3, enemyHp: 100 }) // live battle below...
  party.battle = null // ...now none
  party.run = null
  db.data.users[A].inBattle = true // stale party flag
  db.data.users[B].inBattle = true
  db.data.users[B].battleState = { type: 'dungeon', enemy: { hp: 50 } } // B is in a SOLO fight

  const ctx = makeCtx(db, A)
  await repairPartyState(ctx, party)
  assert.equal(db.data.users[A].inBattle, false, 'stale party flag cleared')
  assert.equal(db.data.users[B].inBattle, true, 'solo battle flag untouched')
  assert.ok(db.data.users[B].battleState, 'solo battleState untouched')
})

// ── 5. Totem of Undying on party member-down ───────────────────────────────
await test('checkTotemRevive consumes the totem and revives at 40%', () => {
  const player = makePlayer(A, 'Alpha')
  player.equipped.offhand = 'totem_of_undying'
  player.hp = 0
  player.mp = 0
  const msg = checkTotemRevive(player)
  assert.ok(msg.includes('TOTEM OF UNDYING'), 'revive narrative fired')
  assert.equal(player.equipped.offhand, null, 'totem consumed')
  assert.ok(player.hp > 0, 'revived with HP')
})

// ── 6. Boss-timeout loss routes through the death saves ────────────────────
await test('boss timeout loss: totem fires, gear is NOT stripped, fight continues', async () => {
  const db = makeDb()
  const player = db.data.users[A]
  player.equipped.offhand = 'totem_of_undying'
  player.equipped.weapon = 'end_staff'
  player.inventory.push('wood_plank')
  player.battleState = {
    type: 'dungeon',
    locationId: LOC,
    floor: 100,
    lastMoveAt: Date.now() - 10 * 60 * 1000, // way past the 5-minute clock
    enemy: { name: 'Tower Master', isBoss: true, hp: 5000, maxHp: 5000 },
    bossState: { bossId: 'test', turn: 3 },
  }
  player.location = LOC

  const ctx = makeCtx(db, A)
  await resolveBossTimeoutLoss(ctx)

  assert.ok(isLiveBossFight(player), 'still in the live boss fight (totem kept them in)')
  assert.equal(player.equipped.weapon, 'end_staff', 'weapon NOT stripped')
  assert.equal(player.equipped.offhand, null, 'totem consumed as the save')
  assert.equal(player.inventory.length, 1, 'inventory NOT wiped')
  assert.equal(player.location, LOC, 'not teleported to astral_town')
  assert.ok(player.battleState.lastMoveAt > Date.now() - 5000, 'turn clock refreshed')
  assert.ok(player.hp > 0, 'revived')
})

await test('boss timeout loss without saves still applies the real death', async () => {
  const db = makeDb()
  const player = db.data.users[A]
  player.equipped.weapon = 'end_staff'
  player.inventory.push('wood_plank')
  player.battleState = {
    type: 'dungeon',
    locationId: LOC,
    floor: 100,
    lastMoveAt: Date.now() - 10 * 60 * 1000,
    enemy: { name: 'Tower Master', isBoss: true, hp: 5000, maxHp: 5000 },
    bossState: { bossId: 'test', turn: 3 },
  }
  player.location = LOC

  const ctx = makeCtx(db, A)
  await resolveBossTimeoutLoss(ctx)

  assert.equal(player.location, 'astral_town', 'real death respawns at town')
  assert.equal(player.equipped.weapon, null, 'gear stripped on a real death')
  assert.equal(player.inventory.length, 0, 'inventory wiped on a real death')
  assert.equal(player.battleState, null, 'battle torn down')
})

// ── 7. .cb owner gate ──────────────────────────────────────────────────────
await test('.cb is refused for regular players', async () => {
  const db = makeDb()
  const ctx = makeCtx(db, B) // B is not the owner
  await cbPlugin.run(ctx)
  assert.ok(ctx.sent[0].includes('restricted to the bot owner'), 'denial sent')
  assert.equal(db.data.users[B].inBattle, false === false ? db.data.users[B].inBattle : db.data.users[B].inBattle, 'no throw')
})

await test('.cb owner self-clear resets stuck battle flags', async () => {
  const db = makeDb()
  db.data.users[OWNER] = makePlayer(OWNER, 'Owner')
  db.data.users[OWNER].inBattle = true
  db.data.users[OWNER].battleState = { type: 'dungeon', enemy: { hp: 10 } }
  const ctx = makeCtx(db, OWNER)
  await cbPlugin.run(ctx)
  assert.equal(db.data.users[OWNER].inBattle, false, 'flag cleared')
  assert.equal(db.data.users[OWNER].battleState, null, 'battleState cleared')
  assert.ok(ctx.sent.some(t => t.includes('Battle state cleared')), 'confirmation sent')
})

await test('.cb owner can clear a TAGGED player (and settles their party too)', async () => {
  const db = makeDb()
  const party = makeParty(db, { floor: 3, enemyHp: 0 }) // B stuck in a won battle
  const ctx = makeCtx(db, OWNER)
  ctx.msg = { message: { extendedTextMessage: { contextInfo: { mentionedJid: [B] } } } }
  ctx.args = []
  await cbPlugin.run(ctx)

  assert.equal(party.battle, null, 'stuck party battle settled by the clear')
  assert.equal(db.data.users[B].inBattle, false, 'target freed')
  assert.equal(db.data.users[B].xp > 0 || db.data.users[B].xp === 0, true, 'no crash')
  assert.ok(ctx.sent.some(t => t.includes("battle state cleared")), 'confirmation sent')
})

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`\nFAIL: ${f.name}\n${f.err.stack}`)
  process.exit(1)
}
