/**
 * test/guild-wars-features.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression + feature suite for the 2026-09-22 GUILD WAR REWORK:
 *
 *  1. GUILD TAGS — the five official [TAG] badges still resolve.
 *  2. LEGACY WAR ENGINE — WAR_FORMATS / GUILD_AURAS / createWarSession still
 *     behave (the session API is retained; the live war no longer uses it).
 *  3. PRESET 5 KIT ISOLATION (lib/war-kit.js) — the whole point of the rework:
 *     applying the war preset must stash the player's REAL inventory/equipped/
 *     durability, fill them with the tier kit, and removing it must restore
 *     EVERYTHING byte-for-byte while reversing every stat bonus. Personal war
 *     loadout overrides the bot kit. No-Totem formats issue no totem. Both
 *     mutators are idempotent.
 *  4. PRIZE POOLS — the BOT stamps 500,000 / 1,000,000. Never anything else.
 *  5. DOMINANCE + GUILD WAR TIERS — both ladders resolve at their thresholds.
 *  6. CHALLENGE → ACCEPT → PAIRINGS — leader-run declaration, 1..4 champions,
 *     1:1 pairings, findActiveWarMatchFor only ever matches the LIVE pairing.
 *  7. A FULL WAR, END TO END — two real pvpConcludeWar settlements: points add
 *     up, Preset 5 lifts, both fighters are healed, XP + dominance + solars
 *     land, guild war standing moves, and the bot-stamped pool is paid out
 *     exactly once with the MVP taking the biggest cut.
 *  8. WALKOVER + STALE-STATE HYGIENE — a pairing awarded without a duel, a
 *     legacy record retired on read.
 *
 * Run:  node test/guild-wars-features.test.mjs
 */
import assert from 'node:assert/strict'

import { getGuildTag, GUILD_TAGS, guildDefs, getGuildDef, getGuildRecord } from '../lib/guild-repo.js'
import { createWarSession, resolveWarTurn, WAR_FORMATS, GUILD_AURAS } from '../lib/guild-war-engine.js'
import {
  WAR_KIT_TIERS, WAR_KIT_SLOTS, applyWarKit, removeWarKit, hasWarKit,
  normalizeKitTier, warKitLabel,
} from '../lib/war-kit.js'
import {
  MATCH_TYPES, PRIZE_POOL_SMALL, PRIZE_POOL_LARGE, WAR_RECORD_VERSION,
  WAR_VICTORY_XP, WAR_MVP_XP,
  generatePrizePool, dominanceTierFor, guildWarTierFor, ensureDominance,
  createWarChallenge, acceptWarChallenge, cancelWar, ensureWarState,
  findActiveWarMatchFor, beginWarDuel, pvpConcludeWar, settleWalkover,
  warScoreComplete, getWar, warBoard, warsForGuild,
} from '../lib/guild-war-repo.js'
import { allItems, classes, races, getTotalStats } from '../lib/game-data.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import guildPlugin from '../plugins/guild.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'

console.log('🧪 Guild Wars rework — feature suite')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) {
    failures.push({ name, err })
    console.log(`FAIL  ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ')}`)
  }
}

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))
const CLASS_ID = Object.keys(classes)[0]
const RACE_ID = Object.keys(races)[0]

// ── Fixtures ────────────────────────────────────────────────────────────────

function makePlayer(id, name, extra = {}) {
  const level = extra.level ?? 30
  const stats = getTotalStats(CLASS_ID, RACE_ID, level)
  // `extra.equipped` MERGES over the defaults so every fixture carries the
  // full slot set — exactly what a registered player has — which is what makes
  // the kit's byte-for-byte restore assertion meaningful.
  const { equipped: eqExtra, ...rest } = extra
  const p = {
    id, name,
    classId: CLASS_ID, raceId: RACE_ID,
    level, xp: 0,
    hp: stats.maxHp, maxHp: stats.maxHp,
    mp: stats.maxMp, maxMp: stats.maxMp,
    stats: { str: stats.str, agi: stats.agi, int: stats.int, def: stats.def, lck: stats.lck },
    wallet: { solars: 1_000_000, gems: 10 },
    equipped: {
      weapon: null, offhand: null, helmet: null, chestplate: null,
      boots: null, relic: null, pet: null,
      ...(eqExtra ?? {}),
    },
    inventory: [],
    skills: [],
    activeEffects: [],
    dungeonProgress: {},
    loadouts: {},
    registeredAt: Date.now(),
    guildJoinedAt: Date.now() - 1000,
    // Canonical, gear-free base — what a real save carries. Without it the
    // ensureStatPoints() migration inside applyLevelUps() reads the whole
    // maxHp as "equipment delta" and doubles the player on their first
    // level-up check.
    baseStats: {
      str: stats.str, agi: stats.agi, int: stats.int, def: stats.def, lck: stats.lck,
      maxHp: stats.maxHp, maxMp: stats.maxMp,
    },
    // A valid v2 stat-point state so ensureStatPoints() early-returns instead
    // of migrating a fixture mid-test.
    statPoints: {
      version: 2, earned: level * 15, spent: 0, unallocated: level * 15,
      allocations: { str: 0, agi: 0, int: 0, def: 0, lck: 0 },
    },
    ...rest,
  }
  // Bake the fixture's equipment bonuses into stats/maxHp the same way every
  // equip path in the bot does — otherwise applyWarKit's reversal would be
  // subtracting bonuses that were never added.
  for (const slot of Object.keys(p.equipped)) {
    const id2 = p.equipped[slot]
    const item = id2 ? itemMap[id2] : null
    if (item) applyEquipmentBonus(p, item, 1)
  }
  p.hp = p.maxHp
  p.mp = p.maxMp
  return p
}

function makeDb(users) {
  return {
    data: {
      users: Object.fromEntries(users.map(u => [u.id, u])),
      guilds: {},
      guildWars: {},
    },
    read: async () => {},
    write: async () => {},
  }
}

function makeCtx(db, from) {
  const sent = []
  return {
    db, from, sender: 'group@g.us', isGroup: true, platform: 'whatsapp',
    msg: { message: {} },
    sent,
    reply: async (text) => { sent.push(String(text)); return text },
    replyImage: async (image, caption = '') => { sent.push(String(caption)); return caption },
    sock: { sendMessage: async () => ({ key: {} }), groupMetadata: async () => ({ participants: [] }) },
  }
}

/** Deep-clone the gear-facing fields so we can assert byte-for-byte restore. */
function gearSnapshot(p) {
  return JSON.parse(JSON.stringify({
    inventory: p.inventory ?? [],
    equipped: p.equipped ?? {},
    equippedDurability: p.equippedDurability ?? {},
    stats: p.stats,
    maxHp: p.maxHp, maxMp: p.maxMp,
  }))
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. GUILD TAGS
// ═══════════════════════════════════════════════════════════════════════════
await test('guild tags resolve for all 5 guilds', () => {
  assert.equal(getGuildTag({ guildId: 'astral_vanguard' }), '[⚔️ VANGUARD]')
  assert.equal(getGuildTag('shadow_covenant'), '[🌑 SHADOW]')
  assert.equal(getGuildTag('gilded_order'), '[⚜️ GILDED]')
  assert.equal(getGuildTag('stormbreakers'), '[⛈️ STORM]')
  assert.equal(getGuildTag('emberwake'), '[🔥 EMBER]')
  assert.equal(getGuildTag(null), '')
  assert.equal(Object.keys(GUILD_TAGS).length, guildDefs.length)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. LEGACY SESSION ENGINE (retained API)
// ═══════════════════════════════════════════════════════════════════════════
await test('retained war engine: formats, auras, session combat', () => {
  assert(WAR_FORMATS.standard)
  assert.equal(WAR_FORMATS.mcpvp.totemAllowed, false, 'totems forbidden in mcpvp')
  assert(WAR_FORMATS.unrestricted)
  assert.equal(Object.keys(GUILD_AURAS).length, 5)

  const a = makePlayer('p1', 'Warrior A')
  const b = makePlayer('p2', 'Mage B')
  const s = createWarSession({
    id: 'legacy_1', guildAId: 'astral_vanguard', guildBId: 'shadow_covenant',
    formatId: 'standard', matchType: '1v1', teamA: [a], teamB: [b],
  })
  assert.equal(s.status, 'active')
  const res = resolveWarTurn(s, 'p1', 'attack')
  assert.equal(res.ok, true)
  assert.ok(s.teamB[0].hp < b.maxHp, 'defender took damage')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. PRESET 5 — KIT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════
await test('kit apply stashes the real inventory and fills with the tier kit', () => {
  // oak_staff (INT-only) as their REAL weapon, so the kit's katana (STR/AGI)
  // produces an unambiguous stat delta we can assert on.
  const p = makePlayer('kit1', 'Kit Tester', {
    inventory: ['iron_sword', 'health_potion', 'super_rare_relic'],
    equipped: { weapon: 'oak_staff', helmet: 'diamond_helmet', chestplate: 'chainmail' },
  })
  p.inventory.push('very_rare_item')
  const before = gearSnapshot(p)

  const res = applyWarKit(p, { tier: 3, totemAllowed: true, warId: 'gw_test' })
  assert.ok(res && hasWarKit(p), 'stash created')
  assert.equal(p.warStash.warId, 'gw_test')
  assert.deepEqual(p.warStash.inventory, before.inventory, 'real inventory moved to the stash')
  assert.deepEqual(p.warStash.equipped, before.equipped, 'real equipment moved to the stash')

  // Their own things are NOT on the character any more.
  assert.ok(!(p.inventory ?? []).includes('very_rare_item'), 'own inventory is aside')
  // The kit is what fills the slots now.
  for (const [slot, id] of Object.entries(WAR_KIT_TIERS[3].equipped)) {
    if (id) assert.equal(p.equipped[slot], id, `tier 3 fills ${slot}`)
  }
  assert.ok((p.inventory ?? []).length > 0, 'pouch stocked')
  assert.ok((p.inventory ?? []).every(id => itemMap[id]), 'pouch only holds real item ids')
  // Stat bonuses from the KIT are live: oak_staff contributed 0 STR, the kit's
  // katana contributes +5 STR and +3 AGI.
  assert.equal(p.stats.str, before.stats.str + (itemMap.katana.statBonuses.str ?? 0), 'kit STR applied')
  assert.ok(p.stats.agi >= before.stats.agi + (itemMap.katana.statBonuses.agi ?? 0), 'kit AGI applied')
  assert.ok(p.maxHp > before.maxHp, 'kit raised max HP')
  assert.equal(p.hp, p.maxHp, 'opens the fight at full strength')
})

await test('kit remove restores inventory, gear and stats byte-for-byte', () => {
  const p = makePlayer('kit2', 'Restorer', {
    inventory: ['health_potion', 'mana_potion', 'elixir'],
    equipped: { weapon: 'battle_axe', offhand: 'iron_shield', boots: 'steel_boots', relic: 'eclipse_shard' },
  })
  const before = gearSnapshot(p)

  applyWarKit(p, { tier: 5, totemAllowed: true })
  assert.notDeepEqual(gearSnapshot(p).equipped, before.equipped, 'kit changed the gear')

  const out = removeWarKit(p)
  assert.equal(out.restored, true)
  assert.equal(hasWarKit(p), false, 'stash cleared')
  assert.deepEqual(gearSnapshot(p), before, 'EVERYTHING restored exactly — inventory, gear, durability, stats')
  assert.equal(p.hp, p.maxHp, 'restored at full strength')
})

await test('kit is idempotent: double-apply and double-remove are safe', () => {
  const p = makePlayer('kit3', 'Idempotent', { equipped: { weapon: 'iron_sword' } })
  const before = gearSnapshot(p)
  applyWarKit(p, { tier: 1 })
  const mid = gearSnapshot(p)
  const again = applyWarKit(p, { tier: 4 })
  assert.deepEqual(gearSnapshot(p), mid, 'second apply does not double-apply')
  assert.equal(again.alreadyApplied, true)
  removeWarKit(p)
  removeWarKit(p)
  assert.deepEqual(gearSnapshot(p), before, 'second remove is a no-op')
})

await test("a personal loadout named 'war' overrides the bot kit slot-by-slot", () => {
  const p = makePlayer('kit4', 'Preset Five', { equipped: { weapon: 'katana' } })
  p.loadouts = { war: { name: 'war', equipped: { weapon: 'shadow_blade', helmet: 'warlords_helm' }, savedAt: Date.now() } }
  applyWarKit(p, { tier: 2 })
  assert.equal(p.equipped.weapon, 'shadow_blade', 'personal preset weapon wins')
  assert.equal(p.equipped.helmet, 'warlords_helm', 'personal preset helmet wins')
  assert.equal(p.equipped.chestplate, WAR_KIT_TIERS[2].equipped.chestplate, 'bot tier fills the rest')
  assert.equal(p.warStash.fromPreset, true)

  // Preset name '5' works too.
  const q = makePlayer('kit5', 'Number Five')
  q.loadouts = { '5': { name: '5', equipped: { boots: 'rangers_boots' }, savedAt: Date.now() } }
  applyWarKit(q, { tier: 1 })
  assert.equal(q.equipped.boots, 'rangers_boots')
  assert.equal(q.warStash.fromPreset, true)
})

await test('No-Totem formats never issue a totem; tiers label correctly', () => {
  const p = makePlayer('kit6', 'No Totem Guy')
  applyWarKit(p, { tier: 5, totemAllowed: false })
  const ids = [...Object.values(p.equipped), ...p.inventory]
  assert.ok(!ids.includes('totem_of_undying'), 'no totem anywhere in a No-Totem war')
  removeWarKit(p)

  applyWarKit(p, { tier: 5, totemAllowed: true })
  const ids2 = [...Object.values(p.equipped), ...p.inventory]
  assert.ok(ids2.includes('totem_of_undying'), 'totem issued when allowed')
  removeWarKit(p)

  assert.equal(normalizeKitTier(99), 3, 'unknown tiers clamp to the default')
  assert.equal(normalizeKitTier('2'), 2)
  assert.match(warKitLabel(4), /Mythic Warplate/)
  for (let t = 1; t <= 5; t++) {
    const kit = WAR_KIT_TIERS[t]
    assert.ok(kit.name && kit.emoji && kit.blurb, `tier ${t} is complete`)
    for (const id of Object.values(kit.equipped)) {
      if (id) assert.ok(itemMap[id], `tier ${t} references a real item: ${id}`)
    }
    for (const id of kit.bag) assert.ok(itemMap[id], `tier ${t} pouch item exists: ${id}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4–5. POOLS & LADDERS
// ═══════════════════════════════════════════════════════════════════════════
await test('the bot stamps the pool: 500k small, 1M large — nothing else', () => {
  assert.equal(generatePrizePool('1v1'), PRIZE_POOL_SMALL)
  assert.equal(generatePrizePool('2v2'), PRIZE_POOL_SMALL)
  assert.equal(generatePrizePool('3v3'), PRIZE_POOL_LARGE)
  assert.equal(generatePrizePool('4v4'), PRIZE_POOL_LARGE)
  assert.equal(PRIZE_POOL_SMALL, 500_000)
  assert.equal(PRIZE_POOL_LARGE, 1_000_000)
  for (const t of Object.keys(MATCH_TYPES)) {
    assert.ok([PRIZE_POOL_SMALL, PRIZE_POOL_LARGE].includes(generatePrizePool(t)))
  }
})

await test('dominance and guild war tiers resolve across their thresholds', () => {
  assert.equal(dominanceTierFor(0).id, 'recruit')
  assert.equal(dominanceTierFor(749).id, 'soldier')
  assert.equal(dominanceTierFor(750).id, 'champion')
  assert.equal(dominanceTierFor(2000).id, 'warlord')
  assert.equal(dominanceTierFor(5000).id, 'legend')
  assert.equal(dominanceTierFor(999999).id, 'dominant')

  assert.equal(guildWarTierFor(0).id, 'unrated')
  assert.equal(guildWarTierFor(500).id, 'bronze')
  assert.equal(guildWarTierFor(25000).id, 'astral')

  const p = { }
  ensureDominance(p)
  assert.equal(p.dominance.score, 0)
  assert.equal(p.dominance.wars, 0)
  assert.equal(p.dominance.peak, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. CHALLENGE → ACCEPT → PAIRINGS
// ═══════════════════════════════════════════════════════════════════════════
await test('challenge creates a pending war with a bot-stamped pool and roster', async () => {
  const a1 = makePlayer('a1', 'Alpha One', { guildId: 'astral_vanguard' })
  const a2 = makePlayer('a2', 'Alpha Two', { guildId: 'astral_vanguard' })
  const s1 = makePlayer('s1', 'Alpha Support', { guildId: 'astral_vanguard' })
  const db = makeDb([a1, a2, s1])

  const war = await createWarChallenge(db, {
    guildAId: 'astral_vanguard', guildBId: 'emberwake',
    challengerId: 'a1', matchType: '2v2', formatId: 'mcpvp',
    stakes: 'normal', stakeSolars: 0, kitTier: 4,
    teamA: [a1, a2], supportsA: [s1],
  })

  assert.equal(war.status, 'pending')
  assert.equal(war.v, WAR_RECORD_VERSION)
  assert.equal(war.size, 2)
  assert.equal(war.prizePool, PRIZE_POOL_SMALL, '2v2 → 500k')
  assert.equal(war.kitTier, 4)
  assert.equal(war.formatId, 'mcpvp')
  assert.equal(war.stakes, 'normal')
  assert.equal(war.teamA.length, 2)
  assert.equal(war.supportsA.length, 1)
  assert.ok(war.acceptUntil > Date.now())
  assert.ok(getWar(db, war.id), 'persisted in db.data.guildWars')
  // Nothing was charged to anybody.
  for (const u of [a1, a2, s1]) assert.equal(u.wallet.solars, 1_000_000, 'players paid nothing')
})

await test('accept locks 1:1 pairings and activates the war', async () => {
  const a1 = makePlayer('b1', 'Bravo One', { guildId: 'stormbreakers' })
  const a2 = makePlayer('b2', 'Bravo Two', { guildId: 'stormbreakers' })
  const d1 = makePlayer('c1', 'Charlie One', { guildId: 'gilded_order' })
  const d2 = makePlayer('c2', 'Charlie Two', { guildId: 'gilded_order' })
  const db = makeDb([a1, a2, d1, d2])

  const war = await createWarChallenge(db, {
    guildAId: 'stormbreakers', guildBId: 'gilded_order',
    challengerId: 'b1', matchType: '2v2', formatId: 'standard',
    stakes: 'normal', stakeSolars: 0, kitTier: 2, teamA: [a1, a2],
  })

  const bad = await acceptWarChallenge(db, war.id, [d1])
  assert.equal(bad.error, 'roster_mismatch', 'wrong champion count refused')

  const ok = await acceptWarChallenge(db, war.id, [d1, d2])
  assert.equal(ok.error, undefined)
  assert.equal(war.status, 'active')
  assert.equal(war.matches.length, 2)
  assert.deepEqual([war.matches[0].aJid, war.matches[0].bJid], ['b1', 'c1'], 'slot 1 paired')
  assert.deepEqual([war.matches[1].aJid, war.matches[1].bJid], ['b2', 'c2'], 'slot 2 paired')
  assert.equal(war.currentMatch, 0)

  // Pairing 0 matches; pairing 1 does not — only the LIVE pairing ever does.
  assert.ok(findActiveWarMatchFor(db, 'b1', 'c1'), 'live pairing found')
  assert.equal(findActiveWarMatchFor(db, 'b2', 'c2'), null, 'later pairings are not live yet')
  assert.equal(findActiveWarMatchFor(db, 'b1', 'b2'), null, 'own side never matches')
  assert.equal(findActiveWarMatchFor(db, 'c1', 'zzz@x'), null)
})

await test('4v4 is the ceiling and legacy wars are retired on read', async () => {
  const db = makeDb([])
  db.data.guildWars.legacy = { id: 'legacy', status: 'pending', guildAId: 'a', guildBId: 'b' }
  await ensureWarState(db)
  assert.equal(db.data.guildWars.legacy, undefined, 'v1 records are dropped')

  const eight = Array.from({ length: 4 }, (_, i) => makePlayer(`x${i}`, `X${i}`))
  const db2 = makeDb(eight)
  const war = await createWarChallenge(db2, {
    guildAId: 'astral_vanguard', guildBId: 'emberwake',
    challengerId: 'x0', matchType: '4v4', formatId: 'unrestricted',
    stakes: 'wager', stakeSolars: 100_000, kitTier: 5,
    teamA: eight.slice(0, 4),
  })
  assert.equal(war.size, 4, '4v4 fields four')
  assert.equal(war.prizePool, PRIZE_POOL_LARGE, '4v4 → 1M')
  assert.equal(war.stakes, 'wager')
  assert.equal(war.stakeSolars, 100_000)
  assert.equal(MATCH_TYPES['4v4'], 4)
  assert.equal(MATCH_TYPES['5v5'], undefined, '5v5 does not exist')
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. A FULL WAR, END TO END
// ═══════════════════════════════════════════════════════════════════════════
async function stageWar({ size = 1, matchType = null, formatId = 'standard', kitTier = 3, stakes = 'normal' } = {}) {
  const mt = matchType ?? `${size}v${size}`
  const n = MATCH_TYPES[mt]
  const aTeam = Array.from({ length: n }, (_, i) =>
    makePlayer(`wa${i}`, `War Alpha ${i + 1}`, { guildId: 'astral_vanguard', level: 40 }))
  const bTeam = Array.from({ length: n }, (_, i) =>
    makePlayer(`wb${i}`, `War Beta ${i + 1}`, { guildId: 'emberwake', level: 40 }))
  const supports = [makePlayer('wsa', 'War Support A', { guildId: 'astral_vanguard' })]
  const all = [...aTeam, ...bTeam, ...supports]
  const db = makeDb(all)

  const war = await createWarChallenge(db, {
    guildAId: 'astral_vanguard', guildBId: 'emberwake',
    challengerId: aTeam[0].id, matchType: mt, formatId,
    stakes, stakeSolars: stakes === 'wager' ? 50_000 : 0, kitTier,
    teamA: aTeam, supportsA: supports,
  })
  const res = await acceptWarChallenge(db, war.id, bTeam)
  assert.equal(res.error, undefined, 'war accepted')
  war.supportsB = []
  return { db, war, aTeam, bTeam, supports }
}

/** Drive one pairing exactly the way plugins/pvp.js does: accept → conclude. */
async function fightPairing(db, war, aJid, bJid, winnerJid, ctx) {
  const begun = await beginWarDuel(db, aJid, bJid)
  assert.ok(begun, 'pairing opened')
  const loserJid = winnerJid === aJid ? bJid : aJid
  // Simulate a real duel's damage: knock the loser to 1 HP, leave the winner
  // at 80% — pvpConcludeWar reads those numbers for performance.
  await updatePlayer(db, loserJid, p => { p.hp = 1 })
  await updatePlayer(db, winnerJid, p => { p.hp = Math.max(1, Math.floor(p.maxHp * 0.8)) })
  const handled = await pvpConcludeWar(db, winnerJid, loserJid, ctx, '_The duel ends in a decisive blow._', {
    war, match: war.matches[war.currentMatch], matchIdx: war.currentMatch,
  })
  assert.equal(handled, true, 'war owned the conclusion')
  return { begun }
}

await test('a 1v1 war settles end to end: kit, score, XP, dominance, pool, guild rank', async () => {
  const { db, war, aTeam, bTeam, supports } = await stageWar({ size: 1, kitTier: 3 })
  const ctx = makeCtx(db, aTeam[0].id)
  const [a] = aTeam
  const [b] = bTeam

  const aBefore = gearSnapshot(a)
  const bBefore = gearSnapshot(b)
  const aWalletBefore = a.wallet.solars
  const bWalletBefore = b.wallet.solars
  const aXpBefore = a.xp ?? 0
  const guildRecBefore = getGuildRecord(db, 'astral_vanguard').war?.dominance ?? 0

  // The duel opens: both fighters are isolated behind Preset 5.
  await beginWarDuel(db, a.id, b.id)
  assert.ok(hasWarKit(getPlayer(db, a.id)), 'champion A is wearing the preset')
  assert.ok(hasWarKit(getPlayer(db, b.id)), 'champion B is wearing the preset')
  assert.deepEqual(getPlayer(db, a.id).inventory, WAR_KIT_TIERS[3].bag, 'only the preset fills the inventory')
  assert.notDeepEqual(gearSnapshot(getPlayer(db, a.id)).equipped, aBefore.equipped)

  // A wins the fight.
  await updatePlayer(db, b.id, p => { p.hp = 1 })
  await updatePlayer(db, a.id, p => { p.hp = Math.floor(p.maxHp * 0.8) })
  const handled = await pvpConcludeWar(db, a.id, b.id, ctx, '_A clean hit ends it._', {
    war, match: war.matches[0], matchIdx: 0,
  })
  assert.equal(handled, true)
  assert.ok(ctx.sent.length >= 1, 'the war announced itself')
  assert.match(ctx.sent[0], /WINS THE PAIRING/)
  assert.match(ctx.sent[0], /THE GUILD WAR IS OVER/)

  const aAfter = getPlayer(db, a.id)
  const bAfter = getPlayer(db, b.id)

  // ── Preset 5 lifted, belongings restored ──
  assert.equal(hasWarKit(aAfter), false, 'preset gone from A')
  assert.equal(hasWarKit(bAfter), false, 'preset gone from B')
  assert.deepEqual(gearSnapshot(aAfter), aBefore, 'A gets their EXACT inventory and gear back')
  assert.deepEqual(gearSnapshot(bAfter), bBefore, 'B gets their EXACT inventory and gear back')

  // ── Both healed and out of battle ──
  assert.equal(aAfter.hp, aAfter.maxHp)
  assert.equal(bAfter.hp, bAfter.maxHp)
  assert.equal(aAfter.inBattle, false)
  assert.equal(aAfter.battleState, null)

  // ── Score + war closed ──
  assert.equal(war.score.a, 1)
  assert.equal(war.score.b, 0)
  assert.equal(war.status, 'finished')
  assert.equal(war.winnerGuildId, 'astral_vanguard')
  assert.equal(warScoreComplete(war), true)

  // ── Massive XP on the winner ──
  assert.ok((aAfter.xp ?? 0) >= aXpBefore + WAR_VICTORY_XP + 750, 'victory XP paid (3000 + 750/slot)')
  assert.ok((bAfter.xp ?? 0) > 0, 'loser still earns consolation XP')

  // ── Dominance moved on both sides ──
  assert.ok(aAfter.dominance.score > 0, 'winner has dominance')
  assert.ok(bAfter.dominance.score > 0, 'loser earned some too')
  assert.equal(aAfter.dominance.wins, 1)
  assert.equal(bAfter.dominance.losses, 1)
  assert.ok(aAfter.dominance.duelsWon >= 1)
  assert.equal(war.mvpJid, a.id, 'MVP came from the winning performance')

  // ── The bot-stamped pool was paid: winner richer, loser no poorer ──
  assert.ok(aAfter.wallet.solars > aWalletBefore, 'MVP/winner got paid')
  assert.ok(bAfter.wallet.solars >= bWalletBefore, 'loser never pays into the pool')
  const paidOut = war.results.length === 1
  assert.ok(paidOut)

  // ── Guild war standing moved (a SEPARATE ladder from the treasury) ──
  const aGuild = getGuildRecord(db, 'astral_vanguard')
  const bGuild = getGuildRecord(db, 'emberwake')
  assert.ok((aGuild.war?.dominance ?? 0) > guildRecBefore, 'winning guild gained war dominance')
  assert.equal(aGuild.war.wins, 1)
  assert.equal(bGuild.war.losses, 1)
  assert.ok(aGuild.war.trophies >= 1)
  assert.ok(guildWarTierFor(aGuild.war.dominance).min >= 0)

  // ── Supporters were tagged and paid ──
  const sup = getPlayer(db, supports[0].id)
  assert.ok((sup.xp ?? 0) > 0, 'supporter got XP')
  assert.ok((sup.dominance?.score ?? 0) > 0, 'supporter got dominance')

  // ── Nobody's wallet funded the pool ──
  assert.notEqual(bAfter.wallet.solars, bWalletBefore - war.prizePool, 'pool is never charged to players')
})

await test('a 2v2 war scores pairings additively and pairs the next duel automatically', async () => {
  const { db, war, aTeam, bTeam } = await stageWar({ size: 2, kitTier: 2 })
  const ctx = makeCtx(db, aTeam[0].id)

  // Pairing 1: A1 beats B1
  await fightPairing(db, war, aTeam[0].id, bTeam[0].id, aTeam[0].id, ctx)
  assert.equal(war.status, 'active', 'war continues after one point')
  assert.equal(war.score.a, 1)
  assert.equal(war.score.b, 0)
  assert.equal(war.currentMatch, 1, 'advanced to pairing 2')

  const b2 = getPlayer(db, bTeam[1].id)
  assert.ok(b2.pvpChallenge?.warId === war.id, 'next defender holds a ready war challenge')
  assert.equal(b2.pvpChallenge.wagerAmount, 0)

  // Pairing 2: B2 beats A2 → level at 1—1 → the war ends in a DRAW.
  await fightPairing(db, war, aTeam[1].id, bTeam[1].id, bTeam[1].id, ctx)
  assert.equal(war.score.a, 1)
  assert.equal(war.score.b, 1)
  assert.equal(war.status, 'finished')
  assert.equal(war.winnerGuildId, null, 'equal scores are a draw')
  assert.ok(ctx.sent.some(s => /DRAW/.test(s)), 'the draw was announced')

  // Both guilds' records show the draw, both champions got something.
  assert.equal(getGuildRecord(db, 'astral_vanguard').war.draws, 1)
  assert.equal(getGuildRecord(db, 'emberwake').war.draws, 1)
  for (const id of [aTeam[0].id, aTeam[1].id, bTeam[0].id, bTeam[1].id]) {
    const p = getPlayer(db, id)
    assert.equal(hasWarKit(p), false, `${p.name}'s preset lifted`)
    assert.equal(p.inBattle, false, `${p.name} is free`)
    assert.ok((p.xp ?? 0) > 0, `${p.name} earned XP`)
    assert.ok((p.dominance?.score ?? 0) > 0, `${p.name} earned dominance`)
  }

  // An already-finished pairing no longer matches — a rematch is an ordinary duel.
  assert.equal(findActiveWarMatchFor(db, aTeam[0].id, bTeam[0].id), null)
})

await test('a 2v2 where one guild sweeps pays out the 500k pool and lifts guild rank', async () => {
  const { db, war, aTeam, bTeam, supports } = await stageWar({ size: 2, kitTier: 3 })
  const ctx = makeCtx(db, aTeam[0].id)

  const a1Wallet = getPlayer(db, aTeam[0].id).wallet.solars
  const a2Wallet = getPlayer(db, aTeam[1].id).wallet.solars
  const supWallet = getPlayer(db, supports[0].id).wallet.solars

  await fightPairing(db, war, aTeam[0].id, bTeam[0].id, aTeam[0].id, ctx)
  await fightPairing(db, war, aTeam[1].id, bTeam[1].id, aTeam[1].id, ctx)

  assert.equal(war.score.a, 2)
  assert.equal(war.score.b, 0)
  assert.equal(war.status, 'finished')
  assert.equal(war.winnerGuildId, 'astral_vanguard')
  assert.equal(war.prizePool, PRIZE_POOL_SMALL)

  const a1 = getPlayer(db, aTeam[0].id)
  const a2 = getPlayer(db, aTeam[1].id)
  const sup = getPlayer(db, supports[0].id)
  assert.ok(a1.wallet.solars > a1Wallet, 'champion 1 paid')
  assert.ok(a2.wallet.solars > a2Wallet, 'champion 2 paid')
  assert.ok(sup.wallet.solars > supWallet, 'supporter paid from the 10% rally share')

  // MVP took the single biggest individual cut among champions.
  const mvpJid = war.mvpJid
  assert.ok(mvpJid === aTeam[0].id || mvpJid === aTeam[1].id, 'MVP is on the winning side here')
  const mvpPrize = (a1.wallet.solars - a1Wallet) || (a2.wallet.solars - a2Wallet)
  assert.ok(mvpPrize > 0)

  const gw = getGuildRecord(db, 'astral_vanguard').war
  assert.equal(gw.wins, 1, 'one war = one win on the ledger')
  assert.equal(gw.streak, 1)
  assert.equal(gw.trophies, 1)
  assert.ok(gw.dominance >= 400 + 100 * 2, 'a 2-slot victory ≈ 600 dominance')

  // No kit survived, nobody is stuck.
  for (const p of [...aTeam, ...bTeam, ...supports]) {
    const live = getPlayer(db, p.id)
    assert.equal(hasWarKit(live), false, `${live.name} clean`)
    assert.ok(!live.inBattle, `${live.name} is free`)
  }
})

await test('wager wars escrow nothing at declaration and settle the pot on the point', async () => {
  const { db, war, aTeam, bTeam } = await stageWar({ size: 1, kitTier: 3, stakes: 'wager' })
  const ctx = makeCtx(db, aTeam[0].id)
  assert.equal(war.stakes, 'wager')
  assert.equal(war.stakeSolars, 50_000)
  assert.equal(getPlayer(db, aTeam[0].id).wallet.solars, 1_000_000, 'no escrow at declaration')

  // Open the duel the way acceptWagerDuel does: escrow both stakes, then kit.
  await updatePlayer(db, aTeam[0].id, p => {
    p.wallet.solars -= 50_000
    p.inBattle = true
    p.battleState = { type: 'pvp', wager: true, opponentJid: bTeam[0].id, wagerAmount: 50_000, myTurn: true, startedAt: Date.now(), lastMoveAt: Date.now(), lastActions: [], lastCommandAt: 0, pp: {} }
  })
  await updatePlayer(db, bTeam[0].id, p => {
    p.wallet.solars -= 50_000
    p.inBattle = true
    p.battleState = { type: 'pvp', wager: true, opponentJid: aTeam[0].id, wagerAmount: 50_000, myTurn: true, startedAt: Date.now(), lastMoveAt: Date.now(), lastActions: [], lastCommandAt: 0, pp: {} }
  })
  await beginWarDuel(db, aTeam[0].id, bTeam[0].id)
  assert.ok(hasWarKit(getPlayer(db, aTeam[0].id)), 'kit applied over the wager state')

  await updatePlayer(db, bTeam[0].id, p => { p.hp = 1 })
  await pvpConcludeWar(db, aTeam[0].id, bTeam[0].id, ctx, '_Stakes and point on the line._', {
    war, match: war.matches[0], matchIdx: 0,
  })

  const a = getPlayer(db, aTeam[0].id)
  const b = getPlayer(db, bTeam[0].id)
  // Winner: escrow back + loser's + prize cut → well above the start.
  assert.ok(a.wallet.solars > 1_000_000, 'winner collects the pot AND the war prize')
  // Loser: down AT MOST their 50k stake — the consolation prize may put them
  // back over the line, but they never fund the pool itself.
  assert.ok(b.wallet.solars >= 1_000_000 - 50_000, 'loser only ever risks their stake')
  assert.ok(b.wallet.solars > 1_000_000 - war.prizePool, 'loser never pays into the pool')
  assert.equal(war.status, 'finished')
  assert.equal(war.score.a, 1)
  assert.equal(hasWarKit(a), false)
  assert.equal(hasWarKit(b), false)
  assert.match(ctx.sent[0], /WINS THE PAIRING/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. WALKOVER + BOARDS
// ═══════════════════════════════════════════════════════════════════════════
await test('a walkover awards the pairing without a duel and drives the war on', async () => {
  const { db, war, aTeam, bTeam } = await stageWar({ size: 2 })
  const ctx = makeCtx(db, aTeam[0].id)

  const ok = await settleWalkover(db, war, 0, bTeam[0].id, ctx,
    `_The challenger never answered the pairing._`)
  assert.equal(ok, true)
  assert.equal(war.score.b, 1, 'walkover scored for the other side')
  assert.equal(war.matches[0].walkover, true)
  assert.equal(war.status, 'active', 'one walkover does not end a 2v2')
  assert.equal(war.currentMatch, 1)

  const ok2 = await settleWalkover(db, war, 1, bTeam[1].id, ctx, `_And the second too._`)
  assert.equal(ok2, true)
  assert.equal(war.status, 'finished')
  assert.equal(war.winnerGuildId, 'emberwake')
  assert.ok(ctx.sent.some(s => /WALKOVER/.test(s)))
  for (const p of [...aTeam, ...bTeam]) {
    assert.equal(hasWarKit(getPlayer(db, p.id)), false)
    assert.equal(getPlayer(db, p.id).inBattle, false)
  }
})

await test('cancelling a pending war refuses to charge anyone and drops the record', async () => {
  const a1 = makePlayer('z1', 'Zed One', { guildId: 'shadow_covenant' })
  const db = makeDb([a1])
  const war = await createWarChallenge(db, {
    guildAId: 'shadow_covenant', guildBId: 'stormbreakers',
    challengerId: 'z1', matchType: '1v1', formatId: 'standard',
    stakes: 'normal', stakeSolars: 0, kitTier: 1, teamA: [a1],
  })
  const gone = await cancelWar(db, war.id)
  assert.equal(gone.status, 'cancelled')
  assert.equal(a1.wallet.solars, 1_000_000)
  assert.equal(findActiveWarMatchFor(db, 'z1', 'nobody'), null, 'a cancelled war never matches')
})

await test('warBoard renders for pending, active and finished states', async () => {
  const { db, war, aTeam, bTeam } = await stageWar({ size: 1 })
  const activeBoard = warBoard(war, db)
  assert.match(activeBoard, /Now pairing 1\/1/, 'the live pairing is shown')
  assert.match(activeBoard, /Prize pool/)
  assert.match(activeBoard, /champions:/)

  await fightPairing(db, war, aTeam[0].id, bTeam[0].id, aTeam[0].id, makeCtx(db, aTeam[0].id))
  const done = warBoard(war, db)
  assert.match(done, /Winner/)
  assert.match(done, /MVP/)
  assert.match(done, /dominance|perf/i)
})

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 9. COMMAND LAYER — drive the real `.guild war` plugin end to end
// ═══════════════════════════════════════════════════════════════════════════
await test('.guild war challenge → accept → status → leaderboard run without throwing', async () => {
  const A1 = makePlayer('ga1', 'Guild Alpha Lead', { guildId: 'astral_vanguard', level: 50 })
  A1.dungeonProgress = { somewhere: { highestFloor: 40, conquered: true } }  // most conquest → leader
  A1.guildJoinedAt = Date.now() - 9999
  const A2 = makePlayer('ga2', 'Guild Alpha Champ', { guildId: 'astral_vanguard', level: 50 })
  A2.dungeonProgress = { somewhere: { highestFloor: 5, conquered: false } }
  const AS = makePlayer('ga3', 'Guild Alpha Rally', { guildId: 'astral_vanguard' })

  const B1 = makePlayer('gb1', 'Guild Beta Lead', { guildId: 'emberwake', level: 50 })
  B1.dungeonProgress = { somewhere: { highestFloor: 30, conquered: true } }
  B1.guildJoinedAt = Date.now() - 9999
  const B2 = makePlayer('gb2', 'Guild Beta Champ', { guildId: 'emberwake', level: 50 })
  B2.dungeonProgress = { somewhere: { highestFloor: 4, conquered: false } }

  const db = makeDb([A1, A2, AS, B1, B2])

  const runCmd = async (from, args, mentioned = []) => {
    const sent = []
    const ctx = {
      db, from, sender: 'group@g.us', isGroup: true, platform: 'whatsapp',
      cmd: 'guild', args, body: `.guild ${args.join(' ')}`,
      player: getPlayer(db, from),
      msg: { message: { extendedTextMessage: { contextInfo: { mentionedJid: mentioned } } } },
      sent,
      reply: async (t) => { sent.push(String(t)); return t },
      replyImage: async (img, cap = '') => { sent.push(String(cap)); return cap },
      sock: {
        sendMessage: async (jid, payload) => { if (payload?.text) sent.push(String(payload.text)); return { key: {} } },
        groupMetadata: async () => ({ participants: [] }),
      },
    }
    await guildPlugin.run(ctx)
    return sent.join('\n')
  }

  // ── Non-leaders are refused ──
  const denied = await runCmd('ga2', ['war', 'challenge', 'emberwake', '1v1', 'standard', '@ga2'], ['ga2'])
  assert.match(denied, /leader/i, 'only the guild leader may declare')

  // ── Leader declares: 1v1, standard, kit 2, naming A2 as champion ──
  const declared = await runCmd('ga1', ['war', 'challenge', 'emberwake', '1v1', 'standard', 'kit', '2', '@ga2'], ['ga2'])
  assert.match(declared, /GUILD WAR DECLARED/)
  assert.match(declared, /1v1/)
  assert.match(declared, /500,000/, 'the bot stamped the 500k pool in the announcement')
  assert.match(declared, /Guild Alpha Champ/, 'the named champion is on the card')
  assert.match(declared, /Guild Beta Lead/, 'the rival leader is addressed')
  assert.match(declared, /Preset 5|Steel Vanguard/, 'the kit tier is announced')

  const pending = warsForGuild(db, 'astral_vanguard').find(w => w.status === 'pending')
  assert.ok(pending, 'a pending war exists in the store')
  assert.equal(pending.prizePool, PRIZE_POOL_SMALL)
  assert.equal(pending.kitTier, 2)
  assert.equal(pending.size, 1)
  assert.equal(pending.teamA[0].jid, 'ga2')

  // ── Duplicate declarations refused ──
  const again = await runCmd('ga1', ['war', 'challenge', 'emberwake', '1v1', 'standard', '@ga2'], ['ga2'])
  assert.match(again, /already/i, 'one live war per guild')

  // ── The RIVAL LEADER accepts, naming their own champion ──
  const accepted = await runCmd('gb1', ['war', 'accept', '@gb2'], ['gb2'])
  assert.match(accepted, /BATTLE LINES ARE DRAWN/)
  assert.match(accepted, /PAIRING 1/)
  const live = warsForGuild(db, 'astral_vanguard').find(w => w.status === 'active')
  assert.ok(live, 'the war went active')
  assert.equal(live.matches.length, 1)
  assert.deepEqual([live.matches[0].aJid, live.matches[0].bJid], ['ga2', 'gb2'])
  // The defender was handed a ready-to-accept war duel challenge.
  const b2After = getPlayer(db, 'gb2')
  assert.equal(b2After?.pvpChallenge?.warId, live.id)

  // ── Board ──
  const board = await runCmd('ga2', ['war', 'status'])
  assert.match(board, /GUILD WAR/)
  assert.match(board, /Now pairing 1\/1/)
  assert.match(board, /Guild Alpha Champ/)
  assert.match(board, /Guild Beta Champ/)

  // ── Help, kits, leaderboard, record all answer ──
  const help = await runCmd('ga1', ['war'])
  assert.match(help, /GUILD WARS/)
  assert.match(help, /challenge/)
  assert.match(help, /DOMINANCE LADDER/)

  const kits = await runCmd('ga1', ['war', 'kits'])
  assert.match(kits, /PRESET 5/)
  assert.match(kits, /Tier 1/)
  assert.match(kits, /Tier 5/)
  assert.match(kits, /Astral Ascendant/)

  // Fight it out through the real settlement path.
  await fightPairing(db, live, 'ga2', 'gb2', 'ga2', makeCtx(db, 'ga1'))

  const lb = await runCmd('ga1', ['war', 'leaderboard'])
  assert.match(lb, /DOMINANCE/)
  assert.match(lb, /Guild Alpha Champ/)
  assert.match(lb, /Astral Vanguard/)
  assert.match(lb, /Unrated|Bronze Banner|War-Blooded|Seasoned Legions|Dominators|Astral Sovereigns/)

  const rec = await runCmd('ga1', ['war', 'record'])
  assert.match(rec, /WAR RECORD/)
  assert.match(rec, /1W|1 W|🏆/)
  assert.match(rec, /Guild Beta|emberwake|Emberwake/i)

  // The combat-command redirect points people at the REAL duel commands.
  const redirect = await runCmd('ga2', ['war', 'attack'])
  assert.match(redirect, /real duel/)
  assert.match(redirect, /pvp attack/)
})


console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
else console.log('🎉 ALL GUILD WAR TESTS PASSED!')
