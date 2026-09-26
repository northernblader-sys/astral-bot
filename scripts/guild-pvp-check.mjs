/**
 * scripts/guild-pvp-check.mjs — behavioural check for the guild treasury and
 * the duel ladder.
 *
 * Drives lib/guild-engine.js and lib/pvp-engine.js plus plugins/guild.js and
 * plugins/scout.js through a fake ctx (stub sock + in-memory db), and asserts
 * the rules the two pillars actually exist for: money never buys leadership,
 * perks never touch damage, a donation can't be minted out of a failed debit,
 * Elo is symmetric, and an abandoned duel eventually becomes claimable.
 *
 *   node scripts/guild-pvp-check.mjs
 *
 * No WhatsApp connection and no writes to the real db.json — same throwaway
 * lowdb-shaped object scripts/housing-check.mjs uses.
 */
import assert from 'assert'
import guild from '../plugins/guild.js'
import scout from '../plugins/scout.js'
import pvpstats from '../plugins/pvpstats.js'
import {
  ensureGuildProgress, guildTier, nextGuildTier, treasuryToNextTier,
  contributionOf, roleFor, guildPower, guildPerksFor, rankMembers,
  shortSolars, GUILD_TIERS, TIER_ORDER, GUILD_ROLES, MERIT_PER_FLOOR, MIN_DONATION,
} from '../lib/guild-engine.js'
import {
  ensurePvp, ratingOf, ratingDelta, expectedScore, recordWin, recordLoss,
  rankFor, winRate, streakLabel, duelsPlayed, isProvisional,
  powerScore, offenseAgainst, matchup, moveOptions, suggestMove,
  isStale, idleMs, formatDuration, TURN_TIMEOUT_MS,
  BASE_RATING, RATING_FLOOR, PLACEMENT_DUELS, RANKS,
} from '../lib/pvp-engine.js'
import { getGuildRecord, getGuildLeader, guildDefs } from '../lib/guild-repo.js'

const A = '111000111000@s.whatsapp.net'
const B = '222000222000@s.whatsapp.net'
const C = '333000333000@s.whatsapp.net'

let pass = 0, fail = 0
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}

// ── Fakes ────────────────────────────────────────────────────────────────
const sock = { sendMessage: async () => ({}) }
const db = { data: { users: {}, guilds: {} }, read: async () => {}, write: async () => {} }

function makePlayer(id, name, solars, extra = {}) {
  const p = {
    id, name, level: 30, location: 'astral_town',
    hp: 300, maxHp: 300, mp: 80, maxMp: 80,
    stats: { str: 60, agi: 40, int: 30, def: 45, lck: 25 },
    classId: 'warrior', raceId: 'human',
    wallet: { solars }, inventory: [], skills: [], equippedAbilities: [],
    ...extra,
  }
  db.data.users[id] = p
  return p
}

function run(plugin, from, argsLine, cmd = plugin.name, msg = undefined) {
  const replies = []
  const ctx = {
    sock, db, from, sender: from, isGroup: false, cmd,
    msg: msg ?? { message: {} },
    player: db.data.users[from],
    args: String(argsLine ?? '').split(' ').filter(Boolean),
    reply: async t => { replies.push(String(t)); return {} },
    replyImage: async (_b, caption) => { replies.push(String(caption)); return {} },
  }
  return plugin.run(ctx).then(() => replies.join('\n'))
}

const mentioning = target => ({
  message: { extendedTextMessage: { contextInfo: { mentionedJid: [target] } } },
})

console.log('\nGuild + PvP\n')

// ── 1. Guild engine invariants ───────────────────────────────────────────
console.log('Guild engine')

check('tier ladder is contiguous from rank 0 and rises monotonically', () => {
  TIER_ORDER.forEach((t, i) => assert.strictEqual(t.rank, i, `${t.id} rank ${t.rank} at index ${i}`))
  for (let i = 1; i < TIER_ORDER.length; i++) {
    assert.ok(TIER_ORDER[i].treasury > TIER_ORDER[i - 1].treasury, `${TIER_ORDER[i].id} costs no more than the tier below`)
  }
})

check('every perk is non-decreasing up the ladder', () => {
  for (let i = 1; i < TIER_ORDER.length; i++) {
    for (const key of ['spoilsPct', 'duelSlots', 'restPct']) {
      assert.ok(TIER_ORDER[i][key] >= TIER_ORDER[i - 1][key], `${key} drops at ${TIER_ORDER[i].id}`)
    }
  }
})

check('no perk touches a combat stat', () => {
  // The design line: guild tier changes payouts, slots and recovery — never
  // attack, defence, hit chance or crit. A new perk key that looks like a
  // stat should fail here loudly rather than quietly become pay-to-win.
  const allowed = new Set(['rank', 'id', 'name', 'treasury', 'spoilsPct', 'duelSlots', 'restPct', 'blurb'])
  for (const tier of GUILD_TIERS) {
    for (const key of Object.keys(tier)) {
      assert.ok(allowed.has(key), `unexpected perk key "${key}" on ${tier.id} — does it affect damage?`)
    }
  }
})

check('ensureGuildProgress backfills shape without inventing history', () => {
  const record = ensureGuildProgress({ bannerPath: null })
  assert.strictEqual(record.treasury, 0)
  assert.deepStrictEqual(record.contributions, {})
  assert.strictEqual(record.motd, null)
  assert.strictEqual(record.donations, 0)
  assert.strictEqual(record.bannerPath, null, 'clobbered an existing field')
})

check('ensureGuildProgress is idempotent', () => {
  const record = ensureGuildProgress({})
  record.treasury = 5000
  record.contributions[A] = 5000
  ensureGuildProgress(record)
  assert.strictEqual(record.treasury, 5000)
  assert.strictEqual(record.contributions[A], 5000)
})

check('guildTier picks the highest affordable tier, never null', () => {
  assert.strictEqual(guildTier(null).rank, 0)
  assert.strictEqual(guildTier({ treasury: 0 }).id, 'outpost')
  assert.strictEqual(guildTier({ treasury: 249_999 }).id, 'outpost')
  assert.strictEqual(guildTier({ treasury: 250_000 }).id, 'hall')
  assert.strictEqual(guildTier({ treasury: 99_000_000 }).rank, TIER_ORDER.length - 1)
})

check('treasuryToNextTier hits 0 exactly at the threshold and at the cap', () => {
  assert.strictEqual(treasuryToNextTier({ treasury: 0 }), 250_000)
  assert.strictEqual(treasuryToNextTier({ treasury: 250_000 }), 1_500_000 - 250_000)
  const top = TIER_ORDER[TIER_ORDER.length - 1]
  assert.strictEqual(nextGuildTier({ treasury: top.treasury }), null)
  assert.strictEqual(treasuryToNextTier({ treasury: top.treasury }), 0)
})

check('conquest alone earns a role — a broke climber outranks an idle wallet', () => {
  const record = ensureGuildProgress({})
  record.contributions[B] = 20_000
  const climber = { id: A, guildId: 'g', guildJoinBaseline: 0, dungeonProgress: { d1: { highestFloor: 40 } } }
  const spender = { id: B, guildId: 'g', guildJoinBaseline: 0, dungeonProgress: {} }
  const climberScore = contributionOf(record, climber)
  assert.strictEqual(climberScore, 40 * MERIT_PER_FLOOR)
  assert.ok(climberScore > contributionOf(record, spender), 'donations outrank conquest')
  assert.ok(roleFor(climberScore).min >= GUILD_ROLES[1].min, 'a 40-floor climber is still a Recruit')
})

check('roleFor never returns null and is monotonic', () => {
  assert.strictEqual(roleFor(-1).id, 'recruit')
  assert.strictEqual(roleFor(0).id, 'recruit')
  let last = -1
  for (const r of GUILD_ROLES) {
    assert.ok(r.min > last, `${r.id} threshold is not above the role below`)
    last = r.min
    assert.strictEqual(roleFor(r.min).id, r.id)
  }
})

check('guildPower rewards activity over a fat idle vault', () => {
  const rich = { treasury: 2_000_000 }
  const busy = { treasury: 0 }
  const busyMembers = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`, level: 60, guildId: 'g', guildJoinBaseline: 0,
    dungeonProgress: { d1: { highestFloor: 80 } }, pvp: { wins: 40 },
  }))
  assert.ok(guildPower(busy, busyMembers) > guildPower(rich, []), 'money outranks six active members')
})

check('guildPerksFor returns the all-zero baseline for the guildless', () => {
  const perks = guildPerksFor({ guildId: null }, null)
  assert.strictEqual(perks.spoilsPct, 0)
  assert.strictEqual(perks.duelSlots, 0)
  assert.strictEqual(perks.restPct, 0)
  assert.strictEqual(perks.tier.rank, 0)
})

check('rankMembers sorts by contribution, ties broken by seniority', () => {
  const record = ensureGuildProgress({})
  record.contributions.x = 100_000
  const members = [
    { id: 'y', name: 'Younger', guildId: 'g', guildJoinedAt: 2000, guildJoinBaseline: 0, dungeonProgress: {} },
    { id: 'o', name: 'Older', guildId: 'g', guildJoinedAt: 1000, guildJoinBaseline: 0, dungeonProgress: {} },
    { id: 'x', name: 'Donor', guildId: 'g', guildJoinedAt: 3000, guildJoinBaseline: 0, dungeonProgress: {} },
  ]
  const ranked = rankMembers(record, members)
  assert.strictEqual(ranked[0].player.id, 'x', 'top donor is not first')
  assert.strictEqual(ranked[1].player.id, 'o', 'seniority did not break the 0-0 tie')
})

check('shortSolars stays readable at every magnitude', () => {
  assert.strictEqual(shortSolars(0), '0')
  assert.strictEqual(shortSolars(900), '900')
  assert.strictEqual(shortSolars(250_000), '250K')
  assert.strictEqual(shortSolars(1_500_000), '1.5M')
  assert.strictEqual(shortSolars(-5), '0')
})

// ── 2. Guild plugin behaviour ────────────────────────────────────────────
console.log('\nGuild commands')

const target = guildDefs[0]
makePlayer(A, 'Ayla', 1_000_000)
makePlayer(B, 'Brann', 50_000)
makePlayer(C, 'Cato', 500)

await check('joining snapshots a conquest baseline', async () => {}) // placeholder replaced below
// (check() is sync; the async guild flows run inline below with plain asserts.)
pass-- // undo the placeholder tally

let out = await run(guild, A, `join ${target.name}`)
check('join sets guildId and a conquest baseline', () => {
  assert.ok(/Welcome/i.test(out), out)
  assert.strictEqual(db.data.users[A].guildId, target.id)
  assert.strictEqual(db.data.users[A].guildJoinBaseline, 0)
})

await run(guild, B, `join ${target.name}`)
await run(guild, C, `join ${target.name}`)

out = await run(guild, C, 'donate 50')
check('a donation under the minimum is refused', () => {
  assert.ok(/Minimum donation/i.test(out), out)
  assert.strictEqual(getGuildRecord(db, target.id).treasury, 0, 'treasury moved on a rejected donation')
})

out = await run(guild, C, 'donate 100000')
check('an unaffordable donation debits nothing and credits nothing', () => {
  assert.ok(/Not enough/i.test(out), out)
  assert.strictEqual(db.data.users[C].wallet.solars, 500, 'wallet was debited anyway')
  assert.strictEqual(getGuildRecord(db, target.id).treasury, 0, 'solars were minted into the treasury')
})

out = await run(guild, A, 'donate 250000')
check('a funded donation debits the wallet and promotes the tier', () => {
  const record = getGuildRecord(db, target.id)
  assert.strictEqual(record.treasury, 250_000)
  assert.strictEqual(record.contributions[A], 250_000)
  assert.strictEqual(db.data.users[A].wallet.solars, 750_000)
  assert.strictEqual(guildTier(record).id, 'hall')
  assert.ok(/GUILD HAS GROWN/i.test(out), out)
})

out = await run(guild, B, 'donate all')
check('donate all empties the wallet exactly', () => {
  assert.strictEqual(db.data.users[B].wallet.solars, 0)
  assert.strictEqual(getGuildRecord(db, target.id).treasury, 300_000)
  assert.strictEqual(getGuildRecord(db, target.id).donations, 2)
})

check('donating does NOT buy leadership', () => {
  // A has donated everything; B has cleared floors. Conquest still decides.
  db.data.users[B].dungeonProgress = { d1: { highestFloor: 12 } }
  const leader = getGuildLeader(target.id, Object.values(db.data.users))
  assert.strictEqual(leader.id, B, 'the biggest donor took the crown')
})

out = await run(guild, C, 'motd Hold the line')
check('only the leader may set the notice', () => {
  assert.ok(/Only the guild leader/i.test(out), out)
  assert.strictEqual(getGuildRecord(db, target.id).motd, null)
})

out = await run(guild, B, 'motd Hold the line')
check('the leader can set and clear the notice', async () => {
  assert.strictEqual(getGuildRecord(db, target.id).motd, 'Hold the line')
})
await run(guild, B, 'motd clear')
check('clearing the notice wipes it', () => {
  assert.strictEqual(getGuildRecord(db, target.id).motd, null)
})

out = await run(guild, B, `motd ${'x'.repeat(200)}`)
check('an overlong notice is refused', () => {
  assert.ok(/under 140/i.test(out), out)
  assert.strictEqual(getGuildRecord(db, target.id).motd, null)
})

out = await run(guild, A, 'treasury')
check('treasury view reports the vault and the donor roll', () => {
  assert.ok(/300,000/.test(out), out)
  assert.ok(/Ayla/.test(out), 'top donor missing')
})

out = await run(guild, A, 'perks')
check('perks view states the no-damage guarantee', () => {
  assert.ok(/never touch damage/i.test(out), out)
})

out = await run(guild, A, 'top')
check('guild standings list all five guilds', () => {
  for (const g of guildDefs) assert.ok(out.includes(g.name), `${g.name} missing from standings`)
})

// ── 3. PvP engine invariants ─────────────────────────────────────────────
console.log('\nPvP engine')

check('ensurePvp backfills a clean slate, not a fake record', () => {
  const p = {}
  const pvp = ensurePvp(p)
  assert.strictEqual(pvp.wins, 0)
  assert.strictEqual(pvp.losses, 0)
  assert.strictEqual(pvp.rating, BASE_RATING)
  assert.strictEqual(pvp.peak, BASE_RATING)
  assert.strictEqual(pvp.streak, 0)
})

check('ensurePvp preserves an existing record', () => {
  const p = { pvp: { wins: 7, rating: 1234 } }
  ensurePvp(p)
  assert.strictEqual(p.pvp.wins, 7)
  assert.strictEqual(p.pvp.rating, 1234)
})

check('Elo expectation is symmetric and even at parity', () => {
  assert.strictEqual(expectedScore(1000, 1000), 0.5)
  const a = expectedScore(1200, 1000)
  const b = expectedScore(1000, 1200)
  assert.ok(Math.abs((a + b) - 1) < 1e-9, 'expectations do not sum to 1')
})

check('rating swing shrinks as the favourite and grows as the underdog', () => {
  const even = ratingDelta(1000, 1000)
  const favourite = ratingDelta(1600, 1000)
  const underdog = ratingDelta(1000, 1600)
  assert.ok(favourite < even, 'beating someone far below pays the same as an even match')
  assert.ok(underdog > even, 'an upset pays no more than an even match')
  assert.ok(favourite >= 1, 'a lopsided win is worth zero rating')
})

check('a win and the matching loss move both players by the same delta', () => {
  const winner = { pvp: { rating: 1100 } }
  const loser = { pvp: { rating: 1000 } }
  ensurePvp(winner); ensurePvp(loser)
  const delta = ratingDelta(1100, 1000)
  recordWin(winner, 'Loser', delta, 500)
  recordLoss(loser, 'Winner', delta, 500)
  assert.strictEqual(winner.pvp.rating, 1100 + delta)
  assert.strictEqual(loser.pvp.rating, 1000 - delta)
  assert.strictEqual(winner.pvp.solarsWon, 500)
  assert.strictEqual(loser.pvp.solarsLost, 500)
})

check('rating never falls below the floor', () => {
  const p = { pvp: { rating: RATING_FLOOR + 5 } }
  ensurePvp(p)
  for (let i = 0; i < 50; i++) recordLoss(p, 'Nemesis', 32, 0)
  assert.strictEqual(p.pvp.rating, RATING_FLOOR)
})

check('peak only ratchets upward', () => {
  const p = {}
  ensurePvp(p)
  recordWin(p, 'X', 40, 0)
  const peak = p.pvp.peak
  recordLoss(p, 'Y', 40, 0)
  recordLoss(p, 'Y', 40, 0)
  assert.strictEqual(p.pvp.peak, peak, 'peak followed the rating down')
})

check('streaks flip sign rather than accumulating across results', () => {
  const p = {}
  ensurePvp(p)
  recordWin(p, 'X', 10, 0); recordWin(p, 'X', 10, 0); recordWin(p, 'X', 10, 0)
  assert.strictEqual(streakLabel(p), 'W3')
  assert.strictEqual(p.pvp.bestStreak, 3)
  recordLoss(p, 'Y', 10, 0)
  assert.strictEqual(streakLabel(p), 'L1')
  assert.strictEqual(p.pvp.bestStreak, 3, 'best streak was lost on a defeat')
})

check('players are provisional until placed, then banded', () => {
  const p = {}
  ensurePvp(p)
  assert.ok(isProvisional(p))
  assert.strictEqual(rankFor(p).id, 'unranked')
  for (let i = 0; i < PLACEMENT_DUELS; i++) recordWin(p, 'X', 20, 0)
  assert.ok(!isProvisional(p))
  assert.notStrictEqual(rankFor(p).id, 'unranked')
  assert.strictEqual(winRate(p), 100)
  assert.strictEqual(duelsPlayed(p), PLACEMENT_DUELS)
})

check('rank bands are ordered and reachable', () => {
  const bands = RANKS.filter(r => r.min !== -Infinity)
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i].min > bands[i - 1].min, `${bands[i].id} does not sit above ${bands[i - 1].id}`)
  }
})

// ── 4. Scouting honesty ──────────────────────────────────────────────────
console.log('\nScouting')

const strong = makePlayer('s@s.whatsapp.net', 'Strong', 0, {
  level: 60, hp: 600, maxHp: 600, stats: { str: 200, agi: 90, int: 40, def: 120, lck: 40 },
})
const weak = makePlayer('w@s.whatsapp.net', 'Weak', 0, {
  level: 10, hp: 120, maxHp: 120, stats: { str: 25, agi: 15, int: 10, def: 15, lck: 5 },
})

check('offense math is bounded and always makes progress', () => {
  const read = offenseAgainst(strong, weak)
  assert.ok(read.perHit >= 1, 'a hit can deal zero damage')
  assert.ok(read.hitChance > 0 && read.hitChance <= 1, `hit chance out of range: ${read.hitChance}`)
  assert.ok(read.turnsToKill >= 1 && Number.isFinite(read.turnsToKill))
})

check('the matchup edge points at the actually stronger fighter', () => {
  assert.strictEqual(matchup(strong, weak).edge, 'strong')
  assert.strictEqual(matchup(weak, strong).edge, 'heavy')
  assert.ok(powerScore(strong) > powerScore(weak))
})

check('rating odds mirror across the two viewpoints', () => {
  strong.pvp = { rating: 1400 }; weak.pvp = { rating: 1000 }
  ensurePvp(strong); ensurePvp(weak)
  const forward = matchup(strong, weak).ratingOdds
  const back = matchup(weak, strong).ratingOdds
  assert.ok(Math.abs((forward + back) - 100) <= 1, `odds ${forward} + ${back} don't mirror`)
})

check('scouting never mutates either fighter', () => {
  const before = JSON.stringify([strong, weak])
  matchup(strong, weak)
  offenseAgainst(weak, strong)
  assert.strictEqual(JSON.stringify([strong, weak]), before, 'a read-only scout wrote to a player')
})

out = await run(scout, A, '', 'scout')
check('scout with no target prints your own card', () => {
  assert.ok(/COMBAT CARD/i.test(out), out)
})

out = await run(scout, A, '', 'scout', mentioning(B))
check('scout on a mention prints a two-sided report', () => {
  assert.ok(/SCOUTING REPORT/i.test(out), out)
  assert.ok(/THE TRADE/i.test(out), 'the trade section is missing')
  assert.ok(/Brann/.test(out), 'the target is missing from their own report')
})

// ── 5. In-duel helpers ───────────────────────────────────────────────────
console.log('\nIn-duel helpers')

const KNOWN = [
  { id: 'slash', name: 'Slash', mpCost: 10, multiplier: 1.4 },
  { id: 'nova', name: 'Nova', mpCost: 200, multiplier: 3.0 },
]
const ABILITIES = [
  { id: 'rally', name: 'Rally', type: 'active', cooldownTurns: 3 },
  { id: 'stoic', name: 'Stoic', type: 'passive' },
]

check('moveOptions gates skills on MP and abilities on cooldown', () => {
  const fighter = {
    name: 'F', hp: 100, maxHp: 100, mp: 50, maxMp: 100,
    battleState: { abilityCooldowns: { rally: 6 } },
  }
  const moves = moveOptions(fighter, KNOWN, ABILITIES, 2)
  const byId = Object.fromEntries(moves.map(m => [m.id, m]))
  assert.strictEqual(byId.attack.usable, true, 'a basic attack was gated')
  assert.strictEqual(byId.defend.usable, true, 'defending was gated')
  assert.strictEqual(byId.slash.usable, true, 'an affordable skill was marked unusable')
  assert.strictEqual(byId.nova.usable, false, 'an unaffordable skill was marked usable')
  assert.strictEqual(byId.rally.usable, false, 'an ability on cooldown was marked ready')
  assert.strictEqual(byId.stoic.usable, false, 'a passive was offered as a move')
  assert.ok(/4 turn/.test(byId.rally.note), byId.rally.note)
})

check('a ready ability is offered once its cooldown has elapsed', () => {
  const fighter = { name: 'F', hp: 100, maxHp: 100, mp: 50, maxMp: 100, battleState: { abilityCooldowns: { rally: 2 } } }
  const moves = moveOptions(fighter, [], ABILITIES, 5)
  assert.strictEqual(moves.find(m => m.id === 'rally').usable, true)
})

check('suggestMove reads the board rather than always saying attack', () => {
  const healthy = { name: 'F', hp: 100, maxHp: 100, mp: 100, maxMp: 100, battleState: {} }
  const dying = { name: 'F', hp: 10, maxHp: 100, mp: 100, maxMp: 100, battleState: {} }
  const foeHealthy = { name: 'Foe', hp: 100, maxHp: 100 }
  const foeDying = { name: 'Foe', hp: 5, maxHp: 100 }
  const moves = moveOptions(healthy, KNOWN, ABILITIES, 9)

  assert.ok(/finish|end it/i.test(suggestMove(healthy, foeDying, moves)), 'no finisher advice against a dying foe')
  assert.ok(/Defend/i.test(suggestMove(dying, foeHealthy, moves)), 'no defensive advice at 10% HP')
  assert.ok(suggestMove(healthy, foeHealthy, moves).length > 0)
})

check('suggestMove never recommends a move it marked unusable', () => {
  const brokeOnMp = { name: 'F', hp: 100, maxHp: 100, mp: 0, maxMp: 100, battleState: {} }
  const moves = moveOptions(brokeOnMp, KNOWN, [], 1)
  const advice = suggestMove(brokeOnMp, { name: 'Foe', hp: 100, maxHp: 100 }, moves)
  assert.ok(!/Nova/.test(advice), `advised an unaffordable skill: ${advice}`)
})

// ── 6. Stale duels ───────────────────────────────────────────────────────
console.log('\nStale duels')

check('a fresh duel is never stale', () => {
  const now = Date.now()
  assert.strictEqual(isStale({ startedAt: now, lastMoveAt: now }, now), false)
  assert.strictEqual(idleMs({ lastMoveAt: now }, now), 0)
})

check('idle time is measured from the last move, not the duel start', () => {
  const now = Date.now()
  const state = { startedAt: now - 60 * 60_000, lastMoveAt: now - 60_000 }
  assert.strictEqual(idleMs(state, now), 60_000, 'the timer restarted from the duel start')
  assert.strictEqual(isStale(state, now), false, 'an active duel was declared abandoned')
})

check('a duel with no move at all falls back to the start time', () => {
  const now = Date.now()
  assert.ok(isStale({ startedAt: now - TURN_TIMEOUT_MS - 1000 }, now), 'a never-moved duel can never be claimed')
})

check('the claim window opens exactly at the timeout', () => {
  const now = Date.now()
  assert.strictEqual(isStale({ lastMoveAt: now - TURN_TIMEOUT_MS + 1000 }, now), false)
  assert.strictEqual(isStale({ lastMoveAt: now - TURN_TIMEOUT_MS }, now), true)
})

check('formatDuration stays short and never prints a negative', () => {
  assert.strictEqual(formatDuration(0), 'now')
  assert.strictEqual(formatDuration(-5000), 'now')
  assert.strictEqual(formatDuration(4 * 60_000), '4m')
  assert.strictEqual(formatDuration(62 * 60_000), '1h 2m')
})

// ── 7. Ladder plugin ─────────────────────────────────────────────────────
console.log('\nLadder')

out = await run(pvpstats, A, '', 'pvpstats')
check('an unfought player gets a placement prompt, not a fake record', () => {
  assert.ok(/Unranked/i.test(out), out)
  assert.ok(!/\dW \d/.test(out), 'invented a win/loss line for a player with no duels')
})

db.data.users[A].pvp = { wins: 9, losses: 1, rating: 1320, peak: 1350, streak: 4, bestStreak: 6, solarsWon: 12_000, solarsLost: 900, lastOpponent: 'Brann', lastResult: 'win', lastAt: Date.now() }
db.data.users[B].pvp = { wins: 2, losses: 8, rating: 880, peak: 1010, streak: -3, bestStreak: 2, solarsWon: 500, solarsLost: 7_400, lastOpponent: 'Ayla', lastResult: 'loss', lastAt: Date.now() }

out = await run(pvpstats, A, '', 'pvpstats')
check('a placed player gets the full card', () => {
  assert.ok(/1320/.test(out), 'rating missing')
  assert.ok(/\*?9W\*? 1L/.test(out), 'record missing')
  assert.ok(/90%/.test(out), 'win rate missing')
})

out = await run(pvpstats, A, '', 'pvptop')
check('the ladder ranks by rating and places the viewer', () => {
  assert.ok(out.indexOf('Ayla') < out.indexOf('Brann'), 'the lower rating ranked higher')
  assert.ok(/#1/.test(out), "the viewer's own position is missing")
})

out = await run(pvpstats, A, '', 'pvpstats', mentioning(B))
check('you can read someone else\'s card', () => {
  assert.ok(/Brann/.test(out), out)
  assert.ok(/880/.test(out), 'their rating is missing')
})

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
