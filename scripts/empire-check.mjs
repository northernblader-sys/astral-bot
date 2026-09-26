/**
 * scripts/empire-check.mjs — behavioural check for the Empire pillar (Phases 1-9).
 *
 * Drives plugins/empire.js through a fake ctx (stub sock + in-memory db) and
 * asserts the rules Phase 1 is actually for: founding costs solars and is
 * one-per-player with a bot-wide-unique name, buildings cost solars plus
 * warehouse materials and are tier-gated, production is wall-clock and clamped
 * to the offline cap, upkeep is drawn on collect, the warehouse cap spoils the
 * surplus, upgrading settles at the OLD level so it can't retroactively boost
 * accrued production, and the whole pillar never once calls sock.sendMessage
 * (no broadcasts). Later phases pile their own sections on the end: army,
 * raids, wars, citizens, market, sale, lifecycle, stash and forge, bank, the
 * walkable coffee house, and (Phase 9) the named townsfolk with their trades,
 * their favor and the ten heirloom armors they hand the ruler. Run it directly:
 *
 *   node scripts/empire-check.mjs
 *
 * No WhatsApp connection and no writes to the real db.json — updatePlayer is
 * pointed at a throwaway lowdb-shaped object, same as housing-check.mjs.
 */
import assert from 'assert'
import empire from '../plugins/empire.js'
import army from '../plugins/army.js'
import empireTop from '../plugins/empire-top.js'
import train from '../plugins/train.js'
import raid from '../plugins/raid.js'
import war from '../plugins/war.js'
import travel from '../plugins/travel.js'
import stash from '../plugins/stash.js'
import tp from '../plugins/tp.js'
import emOnline from '../plugins/em-online.js'
import gotoPlugin from '../plugins/goto.js'
import coffee from '../plugins/coffee.js'
import folkPlugin from '../plugins/folk.js'
import {
  ensureEmpireShape, tierForFame, TIER_ORDER, buildingCostFor, buildingDefMap,
  previewCollect, applyCollect, computeUpkeep, warehouseCap, warehouseRoom, validateName,
  populationOf, popCap, popRoom, previewPopulation, POP_CONFIG,
  slugify, EMPIRE_CONFIG, SHOP_PRICES, OFFLINE_CAP_MS, HOUR_MS, MATERIAL_IDS,
  armyCap, armyHeadcount, armyPower, soldierPowerOf, rankMap, wagePerHour,
  recruitCostSolars, RECRUIT_COST_SOLARS, canRecruit, previewPayroll,
  applyPromote, applyPromoteOfficer, OFFICER_CAP, ensureConflictShape, RAID_CONFIG, empireScore,
  MARKET_CONFIG, workerOnBuilding, workerMultFor, generalBonusOf, citizenCap,
  ensureWarShape, expireVassalage, isVassal, applySeasonDecay, removeLowestOfficer,
  WAR_CONFIG, SELL_CONFIG, LIFECYCLE_CONFIG, DAY_MS,
  BLACKSMITH_CONFIG, blacksmithLevel, maxForgeRank, forgeCheck, applyForge,
  bankBuilt, bankTaxRatePerDay, previewBankAccount, previewBankTax,
  accrueBankAccount, accrueBankAll, bankHeld, bankDeposit, bankWithdraw,
  coffeeHouseBuilt, coffeeMenu, coffeeDrink,
  FOLK_CONFIG, FOLK_TRADES, folkTradeMap, folkCap, folkGiftFavor, ensureFolkShape,
  rollFolkMember, accrueFolk, previewFolk, pendingFolkGifts, findFolkMember,
  greetFolkMember, cupFavorForFolk, claimFolkGift, heirloomForTrade,
  PRESETS, PRESET_ORDER, presetMap, findPreset, presetPreview, auditPreset, suggestPreset, RANK_ORDER,
} from '../lib/empire-engine.js'
import {
  buildSnapshot, weightMatchOk, resolveRaid, scoutReport, SCOUT_BAND_LABELS,
  resolveWarRound, resolveWarSpoils,
} from '../lib/empire-combat.js'
import { getOwnedEmpire, empireNeedsSweep, sweepEmpireLifecycle, buildPresetRecord, findEmpireByQuery, freeEmpireId, empireNameTaken } from '../lib/empire-repo.js'
import { listNotifications } from '../lib/notification-repo.js'
import { endSeason, seasons } from '../lib/season-engine.js'
import { allItems, heirlooms } from '../lib/game-data.js'
import { NP_EVENT, applyAllNamedPassives, getEquippedNamedItems } from '../lib/named-passives.js'
// Only to build the owner jid for the preset assign test: the number is used,
// never printed.
import { config } from '../config.js'

let pass = 0, fail = 0
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}
async function acheck(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}

// ── Fakes ────────────────────────────────────────────────────────────────
let sockSends = 0
const sock = { sendMessage: async () => { sockSends++; return {} } }
const db = { data: { users: {}, empires: {} }, read: async () => {}, write: async () => {} }

function makePlayer(id, name, solars, fame = 0) {
  const p = { id, name, level: 50, wallet: { solars }, fame, inventory: [] }
  db.data.users[id] = p
  return p
}

function run(plugin, from, argsLine, cmd) {
  const replies = []
  const ctx = {
    sock, db, from, sender: from, isGroup: false, cmd: cmd ?? plugin.name,
    msg: { message: {} },
    player: db.data.users[from],
    args: String(argsLine ?? '').split(' ').filter(Boolean),
    reply: async t => { replies.push(String(t)); return {} },
  }
  return plugin.run(ctx).then(() => replies.join('\n'))
}

const A = '111000@s.whatsapp.net'
const B = '222000@s.whatsapp.net'
const C = '333000@s.whatsapp.net'
const D = '444000@s.whatsapp.net'
const E = '555000@s.whatsapp.net'
const F = '666000@s.whatsapp.net'
const G = '777000@s.whatsapp.net'
const H = '888000@s.whatsapp.net'
const I = '999000@s.whatsapp.net'
const J = '101010@s.whatsapp.net'
const K = '111111@s.whatsapp.net'
// Phase 4 cast: war pair, declare/decline/peace pair, sale pair, lifecycle owners.
const L = '121212@s.whatsapp.net'
const M = '131313@s.whatsapp.net'
const N = '141414@s.whatsapp.net'
const O = '151515@s.whatsapp.net'
const P = '161616@s.whatsapp.net'
const Q = '171717@s.whatsapp.net'
const R = '181818@s.whatsapp.net'
const S = '191919@s.whatsapp.net'
const T = '202020@s.whatsapp.net'
const U = '212121@s.whatsapp.net'

// A deterministic PRNG (mulberry32) so 10,000 resolveRaid samples are
// reproducible: same seed => same sequence, no reliance on Math.random.
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

console.log('\nEmpire pillar (Phase 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8)\n')

// ── 1. Engine invariants (pure, explicit `now`) ──────────────────────────────
console.log('Engine')

check('tier ladder is contiguous from rank 0', () => {
  TIER_ORDER.forEach((t, i) => assert.strictEqual(t.rank, i, `${t.id} rank ${t.rank} at index ${i}`))
})

check('tierForFame lands in the right band at the boundary', () => {
  const village = TIER_ORDER[1]
  assert.strictEqual(tierForFame(village.fame - 1).rank, 0)
  assert.strictEqual(tierForFame(village.fame).rank, 1)
})

check('buildingCostFor rises with the target level', () => {
  const def = buildingDefMap['solar_mine']
  const c1 = buildingCostFor(def, 1)
  const c2 = buildingCostFor(def, 2)
  assert.ok(c2.solars > c1.solars, 'level 2 should cost more solars than level 1')
})

check('ensureEmpireShape backfills every field', () => {
  const r = ensureEmpireShape({ ownerId: 'x' })
  assert.strictEqual(r.treasury, 0)
  assert.deepStrictEqual(r.buildings, [])
  for (const id of MATERIAL_IDS) assert.strictEqual(r.warehouse[id], 0)
  // Phase 5: a bare record is one resident (the ruler), no townsfolk, fame 1.
  assert.strictEqual(r.citizenCount, 1)
  assert.strictEqual(r.npcs, 0)
  assert.strictEqual(r.fame, 1)
})

check('previewCollect clamps production to the offline cap', () => {
  const now = 10 * OFFLINE_CAP_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 0,
    buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now - 100 * HOUR_MS }],
  })
  const s = previewCollect(rec, now)
  const def = buildingDefMap['solar_mine']
  assert.strictEqual(s.solarsGain, Math.floor(def.baseYieldPerHour * EMPIRE_CONFIG.offlineCapHours))
})

check('previewCollect draws upkeep and floors the treasury at 0', () => {
  const now = 100 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 1000,
    buildings: [{ type: 'iron_mine', level: 1, lastCollectedAt: now - 2 * HOUR_MS }],
  })
  const s = previewCollect(rec, now)
  const def = buildingDefMap['iron_mine']
  const maint = Math.floor(def.maintPerHour * 2)
  assert.strictEqual(s.maintenance, maint)
  assert.strictEqual(s.treasuryAfter, 1000 - maint)
  assert.strictEqual(s.netSolars, -maint)
})

check('material production clamps to the warehouse cap, surplus is waste', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 0,
    buildings: [{ type: 'lumber_camp', level: 1, lastCollectedAt: now - 100 * HOUR_MS }],
  })
  const cap = warehouseCap(rec)
  const s = previewCollect(rec, now)
  assert.ok((s.matStored.wood ?? 0) <= cap, 'stored wood should never exceed the cap')
  assert.ok((s.waste.wood ?? 0) > 0, 'the surplus over cap should be reported as waste')
})

check('computeUpkeep net equals gross minus maintenance', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 9e9, treasury: 0,
    buildings: [
      { type: 'solar_mine', level: 2, lastCollectedAt: 0 },
      { type: 'iron_mine', level: 1, lastCollectedAt: 0 },
    ],
  })
  const u = computeUpkeep(rec)
  assert.strictEqual(u.netSolarsPerHour, u.grossSolarsPerHour - u.maintPerHour)
})

check('validateName rejects too-short names and slugify normalizes', () => {
  assert.strictEqual(validateName('ab').ok, false)
  assert.strictEqual(validateName('Steel Hold').ok, true)
  assert.strictEqual(slugify('Steel  Hold!!'), 'steel-hold')
})

// ── 1b. Army engine (pure, explicit inputs) ──────────────────────────────────
console.log('\nArmy engine')

check('armyCap = tier base plus every Barracks bonus per level', () => {
  const rec = ensureEmpireShape({ ownerId: 'x', fame: 0, buildings: [{ type: 'barracks', level: 3, lastCollectedAt: 0 }] })
  const base = TIER_ORDER[0].armyBase
  assert.strictEqual(armyCap(rec), base + buildingDefMap['barracks'].armyCapBonus * 3)
})

check('armyPower folds levies and officers; xp scales an officer', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0,
    army: { levies: { recruit: 10, soldier: 5 }, officers: [{ name: 'O', rank: 'veteran', xp: 200 }] },
  })
  // xp 200 => power x2 (1 + 200/200)
  assert.strictEqual(soldierPowerOf({ rank: 'veteran', xp: 200 }), rankMap.veteran.power * 2)
  const expected = 10 * rankMap.recruit.power + 5 * rankMap.soldier.power + rankMap.veteran.power * 2
  assert.strictEqual(armyPower(rec), expected)
})

check('wagePerHour sums levy and officer wages', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0,
    army: { levies: { recruit: 10, soldier: 0 }, officers: [{ name: 'O', rank: 'knight', xp: 0 }] },
  })
  assert.strictEqual(wagePerHour(rec), 10 * rankMap.recruit.wagePerHour + rankMap.knight.wagePerHour)
})

check('recruitCostSolars is linear in count', () => {
  assert.strictEqual(recruitCostSolars(7), 7 * RECRUIT_COST_SOLARS)
})

check('canRecruit rejects over-cap and too-poor requests', () => {
  const rich = ensureEmpireShape({ ownerId: 'x', fame: 0, treasury: 1e9 }) // Hamlet cap 20, no barracks
  assert.strictEqual(canRecruit(rich, 5).ok, true)
  assert.strictEqual(canRecruit(rich, 999).reason, 'cap')
  const poor = ensureEmpireShape({ ownerId: 'x', fame: 0, treasury: 10 })
  assert.strictEqual(canRecruit(poor, 5).reason, 'poor')
})

check('previewPayroll deserts everyone when the treasury cannot pay at all', () => {
  const now = 100 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 0,
    army: { levies: { recruit: 100, soldier: 0 }, officers: [], lastPaidAt: now - 10 * HOUR_MS },
  })
  const pay = previewPayroll(rec, now, 0)
  assert.strictEqual(pay.wagesDue, wagePerHour(rec) * 10)
  assert.strictEqual(pay.wagesPaid, 0)
  assert.strictEqual(pay.deserters.recruit, 100)
})

check('previewPayroll deserts proportionally on a partial shortfall', () => {
  const now = 10 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0,
    army: { levies: { recruit: 100, soldier: 0 }, officers: [], lastPaidAt: 0 },
  })
  const due = wagePerHour(rec) * 10 // 100 recruits * 1/h * 10h = 1000
  const pay = previewPayroll(rec, now, Math.floor(due / 2))
  assert.strictEqual(pay.wagesPaid, Math.floor(due / 2))
  assert.ok(pay.deserters.recruit > 0 && pay.deserters.recruit < 100, 'about half should desert')
})

check('applyPromote mints a named officer when a soldier crosses into veteran', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 1e9,
    warehouse: Object.fromEntries(MATERIAL_IDS.map(id => [id, 999])),
    army: { levies: { recruit: 0, soldier: 3 }, officers: [] },
  })
  const res = applyPromote(rec, 1, () => 'Named One')
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.fromRank, 'soldier')
  assert.strictEqual(res.toRank, 'veteran')
  assert.strictEqual(rec.army.officers.length, 1)
  assert.strictEqual(rec.army.officers[0].name, 'Named One')
  assert.strictEqual(rec.army.levies.soldier, 2)
})

check('applyPromote takes the lowest rank first (recruit to soldier stays a levy)', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 1e9,
    warehouse: Object.fromEntries(MATERIAL_IDS.map(id => [id, 999])),
    army: { levies: { recruit: 5, soldier: 0 }, officers: [] },
  })
  const res = applyPromote(rec, 2, () => 'X')
  assert.strictEqual(res.fromRank, 'recruit')
  assert.strictEqual(res.toRank, 'soldier')
  assert.strictEqual(rec.army.levies.recruit, 3)
  assert.strictEqual(rec.army.levies.soldier, 2)
  assert.strictEqual(rec.army.officers.length, 0)
})

check('applyPromote refuses to mint past the officer cap', () => {
  const officers = Array.from({ length: OFFICER_CAP }, (_, i) => ({ name: `O${i}`, rank: 'veteran', xp: 0 }))
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 1e9,
    warehouse: Object.fromEntries(MATERIAL_IDS.map(id => [id, 999])),
    army: { levies: { recruit: 0, soldier: 5 }, officers },
  })
  const res = applyPromote(rec, 1, () => 'New')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'officercap')
})

check('applyPromote on an empty army reports empty', () => {
  const rec = ensureEmpireShape({ ownerId: 'x', fame: 0 })
  assert.strictEqual(applyPromote(rec, 1, () => 'x').reason, 'empty')
})

// ── 1c. Combat engine (pure, seeded rng, read-only snapshots) ────────────────
console.log('\nCombat engine')

check('weightMatchOk shields the far-weaker, allows peers, allows punching up', () => {
  const big = { might: 100 }, peer = { might: 80 }, small = { might: 40 }
  assert.strictEqual(weightMatchOk(big, peer), true, '80 >= 50 is a legal peer')
  assert.strictEqual(weightMatchOk(big, small), false, '40 < 50 is protected')
  assert.strictEqual(weightMatchOk(small, big), true, 'punching up is always allowed')
  assert.strictEqual(weightMatchOk({ might: 0 }, small), true, 'a might-0 attacker is never blocked')
})

check('buildSnapshot keeps might and power distinct and folds the general bonus', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 2000, treasury: 5000,
    buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: 0 }],
    army: { levies: { recruit: 10, soldier: 0 }, officers: [] },
  })
  const base = buildSnapshot(rec)
  assert.strictEqual(base.might, empireScore(rec), 'might is empireScore')
  assert.strictEqual(base.power, armyPower(rec), 'power is armyPower')
  const boosted = buildSnapshot(rec, { generalBonus: 0.5 })
  assert.strictEqual(boosted.power, Math.round(base.power * 1.5), 'a general bonus folds into power only')
  assert.strictEqual(boosted.might, base.might, 'a general never changes might')
})

check('resolveRaid over 10,000 seeded samples honours every raid invariant', () => {
  const rng = makeRng(0x5eed)
  const attacker = { power: 500, treasury: 0, might: 100, producingTypes: [], levies: { recruit: 200, soldier: 50 } }
  const defender = { power: 450, treasury: 100000, might: 100, producingTypes: ['solar_mine'], levies: { recruit: 200, soldier: 50 } }
  let atkWins = 0, defWins = 0, winnerZeroLoss = 0
  for (let i = 0; i < 10000; i++) {
    const r = resolveRaid(attacker, defender, rng, 1000)
    assert.ok(r.loot <= RAID_CONFIG.lootHardCap, `loot ${r.loot} over the hard cap`)
    assert.ok(r.loot <= defender.treasury, 'loot never exceeds the defender treasury')
    assert.ok(r.loot >= 0, 'loot is never negative')
    assert.ok(r.attackerDeployedUntil > 1000, 'the attacker always commits its troops (deployed)')
    if (r.attackerWins) {
      atkWins++
      if (r.attackerLosses.recruit + r.attackerLosses.soldier === 0) winnerZeroLoss++
      assert.ok(r.damaged && r.damaged.type === 'solar_mine', 'a win knocks a producing building offline')
      assert.ok(r.defenderShieldUntil > 1000, 'a beaten defender is shielded')
    } else {
      defWins++
      assert.strictEqual(r.loot, 0, 'no loot on a repelled raid')
      assert.strictEqual(r.damaged, null, 'no building damage on a repelled raid')
      assert.strictEqual(r.defenderShieldUntil, 0, 'no shield when the attacker loses')
    }
  }
  assert.ok(atkWins > 0 && defWins > 0, `both outcomes must occur (upsets happen): ${atkWins}/${defWins}`)
  assert.strictEqual(winnerZeroLoss, 0, 'a winning attacker with levies never escapes losses')
})

check('scoutReport returns only bucketed bands and the hard status flags', () => {
  const rng = makeRng(7)
  const atk = { might: 100 }
  const def = {
    name: 'Targos', tierRank: 2, power: 300, treasury: 40000, headcount: 120,
    might: 90, shieldUntil: 5000, deployedUntil: 0,
  }
  const r = scoutReport(atk, def, rng, 1000)
  assert.ok(SCOUT_BAND_LABELS.army.includes(r.armyBand), 'army band is from the known set')
  assert.ok(SCOUT_BAND_LABELS.treasury.includes(r.treasuryBand), 'treasury band is from the known set')
  assert.ok(SCOUT_BAND_LABELS.headcount.includes(r.headcountBand), 'headcount band is from the known set')
  assert.strictEqual(r.shielded, true, 'a shield in the future reads as shielded')
  assert.strictEqual(r.weightLegal, true, '90 >= 50 is weight-legal')
  assert.ok(!('power' in r) && !('treasury' in r) && !('headcount' in r), 'a scout never leaks exact figures')
})

check('a damaged building is offline in previewCollect, with no retroactive downtime', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0, treasury: 100000,
    buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now - 10 * HOUR_MS, damagedUntil: now + 5 * HOUR_MS }],
  })
  const s = previewCollect(rec, now)
  assert.strictEqual(s.solarsGain, 0, 'a still-damaged mine yields nothing')
  assert.strictEqual(s.maintenance, 0, 'and draws no maintenance while offline')
  // 8h on: it has been back online for 3h (repaired at now+5h); only those count.
  const def = buildingDefMap['solar_mine']
  const s2 = previewCollect(rec, now + 8 * HOUR_MS)
  assert.strictEqual(s2.solarsGain, Math.floor(def.baseYieldPerHour * 3), 'only post-repair hours produce')
})

check('ensureConflictShape backfills every conflict field idempotently', () => {
  const r = ensureConflictShape({})
  assert.strictEqual(r.shieldUntil, 0)
  assert.strictEqual(r.deployedUntil, 0)
  assert.strictEqual(r.lastRaidAt, 0)
  assert.deepStrictEqual(r.raidLog, [])
  assert.deepStrictEqual(r.market.stock, [])
  assert.strictEqual(r.market.revenue, 0)
  assert.deepStrictEqual(r.assignments.workers, [])
  assert.deepStrictEqual(r.assignments.generals, [])
})

// ── 1d. Population engine (Phase 5: fame = headcount, capacity-gated) ─────────
console.log('\nPopulation engine (Phase 5)')

check('populationOf sums player citizens and NPC townsfolk, flooring fractions', () => {
  assert.strictEqual(populationOf({ citizenCount: 3, npcs: 7 }), 10)
  assert.strictEqual(populationOf({ citizenCount: 1, npcs: 0 }), 1)
  assert.strictEqual(populationOf({}), 0, 'a bare object has no residents')
  assert.strictEqual(populationOf({ citizenCount: 2.9, npcs: 4.9 }), 6, 'fractions floor before summing')
})

check('ensureEmpireShape derives fame from headcount and overwrites any stored fame', () => {
  const r = ensureEmpireShape({ ownerId: 'x', citizenCount: 1, npcs: 49 })
  assert.strictEqual(r.fame, 50, 'fame is 1 ruler + 49 townsfolk')
  assert.strictEqual(r.tierId, tierForFame(50).id, 'the tier follows the derived fame')
  const drifted = ensureEmpireShape({ ownerId: 'x', citizenCount: 1, npcs: 0, fame: 999999 })
  assert.strictEqual(drifted.fame, 1, 'a stale stored fame is ignored: headcount is the only truth')
})

check('popCap is a base plus every building\'s housing per level', () => {
  const base = POP_CONFIG.baseCap
  const bare = ensureEmpireShape({ ownerId: 'x' })
  assert.strictEqual(popCap(bare), base, 'no buildings means only the base capacity')
  const housed = ensureEmpireShape({ ownerId: 'x', buildings: [{ type: 'house', level: 3, lastCollectedAt: 0 }] })
  assert.strictEqual(popCap(housed), base + buildingDefMap['house'].housing * 3, 'a level-3 house adds housing x3')
})

check('popRoom is the housing left, floored at zero', () => {
  const rec = ensureEmpireShape({ ownerId: 'x', npcs: 0, buildings: [{ type: 'house', level: 1, lastCollectedAt: 0 }] })
  assert.strictEqual(popRoom(rec), popCap(rec) - 1, 'the lone ruler leaves cap-1 open')
  const packed = ensureEmpireShape({ ownerId: 'x', npcs: 9999 })
  assert.strictEqual(popRoom(packed), 0, 'an over-full empire never reports negative room')
})

check('previewPopulation moves in one NPC per interval when housing has room', () => {
  const per = POP_CONFIG.hoursPerArrival * HOUR_MS
  const now = 1000 * HOUR_MS
  const roomy = ensureEmpireShape({
    ownerId: 'x', citizenCount: 1, npcs: 0, lastPopAt: now - 3 * per, lastCivicAt: now,
    buildings: [{ type: 'house', level: 5, lastCollectedAt: now }], // baseCap 4 + 50 = 54
  })
  const g = previewPopulation(roomy, now)
  assert.strictEqual(g.arrivals, 3, 'three whole intervals bring three residents')
  assert.strictEqual(g.npcsAfter, 3)
  assert.strictEqual(g.nextPopAt, (now - 3 * per) + 3 * per, 'the clock advances only by the intervals consumed')
})

check('previewPopulation gates arrivals on housing room and banks the timer', () => {
  const per = POP_CONFIG.hoursPerArrival * HOUR_MS
  const now = 1000 * HOUR_MS
  // baseCap 4, one ruler, no housing building => room 3, though time offers 10.
  const tight = ensureEmpireShape({ ownerId: 'x', citizenCount: 1, npcs: 0, lastPopAt: now - 10 * per, lastCivicAt: now })
  assert.strictEqual(popRoom(tight), 3, 'baseCap 4 minus the 1 ruler leaves room for 3')
  const g = previewPopulation(tight, now)
  assert.strictEqual(g.arrivals, 3, 'only as many move in as there is room for')
  assert.strictEqual(g.nextPopAt, (now - 10 * per) + 3 * per, 'the clock advances only for those who actually arrived')
  // Zero room: nobody arrives and the arrival clock does not move at all.
  const full = ensureEmpireShape({ ownerId: 'x', citizenCount: 4, npcs: 0, lastPopAt: now - 10 * per, lastCivicAt: now })
  const g2 = previewPopulation(full, now)
  assert.strictEqual(g2.arrivals, 0, 'a full empire takes in nobody')
  assert.strictEqual(g2.nextPopAt, full.lastPopAt, 'and its arrival clock is left untouched')
})

check('previewPopulation charges NPC tax and wages on the pre-growth headcount', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({ ownerId: 'x', npcs: 10, lastCivicAt: now - 5 * HOUR_MS, lastPopAt: now })
  const g = previewPopulation(rec, now)
  assert.strictEqual(g.civicIncome, 10 * POP_CONFIG.npcIncomePerHour * 5, 'ten townsfolk pay five hours of tax')
  assert.strictEqual(g.civicWage, 10 * POP_CONFIG.npcWagePerHour * 5, 'and draw five hours of wages')
})

check('applyCollect moves NPCs in, folds civic pay, and re-seats fame and tier', () => {
  const per = POP_CONFIG.hoursPerArrival * HOUR_MS
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', citizenCount: 1, npcs: 10, treasury: 100000,
    lastPopAt: now - 2 * per, lastCivicAt: now - 5 * HOUR_MS,
    buildings: [{ type: 'house', level: 5, lastCollectedAt: now }], // room for the arrivals, 0h maint
    army: { levies: {}, officers: [], lastPaidAt: now },
  })
  const civicIncome = 10 * POP_CONFIG.npcIncomePerHour * 5
  const civicWage = 10 * POP_CONFIG.npcWagePerHour * 5
  const t0 = rec.treasury
  const s = applyCollect(rec, now)
  assert.strictEqual(s.arrivals, 2, 'two intervals, two new townsfolk')
  assert.strictEqual(rec.npcs, 12, 'the new residents are moved in')
  assert.strictEqual(rec.lastPopAt, (now - 2 * per) + 2 * per, 'the arrival clock advanced by the two intervals consumed')
  assert.strictEqual(rec.lastCivicAt, now, 'the civic clock is stamped to now')
  assert.strictEqual(rec.fame, populationOf(rec), 'fame is re-derived from the new headcount')
  assert.strictEqual(rec.fame, 13, '1 ruler + 12 townsfolk')
  assert.strictEqual(rec.tierId, tierForFame(rec.fame).id, 'the tier follows the new fame')
  assert.strictEqual(rec.treasury, t0 + civicIncome - civicWage, 'civic tax and wages settle against the treasury')
})

check('computeUpkeep folds NPC tax into gross and NPC wages into upkeep', () => {
  const withNpcs = ensureEmpireShape({ ownerId: 'x', npcs: 20, buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: 0 }] })
  const bare = ensureEmpireShape({ ownerId: 'x', npcs: 0, buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: 0 }] })
  const uN = computeUpkeep(withNpcs)
  const uB = computeUpkeep(bare)
  assert.strictEqual(uN.grossSolarsPerHour - uB.grossSolarsPerHour, 20 * POP_CONFIG.npcIncomePerHour, 'twenty townsfolk add their tax to gross income')
  assert.strictEqual(uN.maintPerHour - uB.maintPerHour, 20 * POP_CONFIG.npcWagePerHour, 'and their wages to upkeep')
  assert.strictEqual(uN.netSolarsPerHour, uN.grossSolarsPerHour - uN.maintPerHour - wagePerHour(withNpcs), 'net still folds army wages too')
})

// ── 1e. Gather + blacksmith engine (Phase 6: the stash and the forge) ────────
console.log('\nGather + blacksmith engine (Phase 6)')

check('previewCollect surfaces the crafting material an extraction building gathers', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', citizenCount: 1, npcs: 0, lastPopAt: now, lastCivicAt: now,
    buildings: [{ type: 'lumber_camp', level: 1, lastCollectedAt: now - 10 * HOUR_MS }],
  })
  const s = previewCollect(rec, now)
  // A lumber camp gathers wood_plank at 2/hr * level 1 * boost 1 over 10h = 20.
  assert.strictEqual(s.gathered.wood_plank, 20, 'ten hours of a level-1 lumber camp yields twenty planks')
  const b = s.perBuilding.find(x => x.type === 'lumber_camp')
  assert.strictEqual(b.gatheredId, 'wood_plank')
  assert.strictEqual(b.gatheredQty, 20)
})

check('gathering scales with the building level', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', citizenCount: 1, npcs: 0, lastPopAt: now, lastCivicAt: now,
    buildings: [{ type: 'iron_mine', level: 3, lastCollectedAt: now - 10 * HOUR_MS }],
  })
  const s = previewCollect(rec, now)
  // An iron mine gathers silver_ore at 1/hr * level 3 over 10h = 30.
  assert.strictEqual(s.gathered.silver_ore, 30, 'a level-3 iron mine gathers thrice as fast')
})

check('a building with no gathers line contributes nothing to the stash', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', citizenCount: 1, npcs: 0, lastPopAt: now, lastCivicAt: now,
    buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now - 10 * HOUR_MS }],
  })
  assert.deepStrictEqual(previewCollect(rec, now).gathered, {}, 'a solar mine mints money, not craft mats')
})

check('applyCollect banks gathered materials into the stash, never the capped warehouse', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({
    ownerId: 'x', citizenCount: 1, npcs: 0, treasury: 0, lastPopAt: now, lastCivicAt: now,
    buildings: [{ type: 'quarry', level: 1, lastCollectedAt: now - 5 * HOUR_MS }],
  })
  applyCollect(rec, now)
  // A quarry gathers iron_ore at 2/hr over 5h = 10, straight into the stash.
  assert.strictEqual(rec.stash.materials.iron_ore, 10, 'the gathered ore lands in the stash')
  assert.ok(!(rec.warehouse.iron_ore > 0), 'and never in the construction warehouse (which does not even track ore)')
})

check('maxForgeRank climbs the level ladder and a level-0 forge makes nothing', () => {
  assert.strictEqual(maxForgeRank(0), 0, 'no blacksmith, no forging')
  assert.strictEqual(maxForgeRank(1), BLACKSMITH_CONFIG.maxForgeRankByLevel[0])
  assert.strictEqual(maxForgeRank(10), BLACKSMITH_CONFIG.maxForgeRankByLevel[9])
  assert.strictEqual(maxForgeRank(99), BLACKSMITH_CONFIG.maxForgeRankByLevel[9], 'past the top level clamps to the last rung')
})

check('blacksmithLevel reads the built forge, 0 when there is none', () => {
  assert.strictEqual(blacksmithLevel(ensureEmpireShape({ ownerId: 'x' })), 0)
  const smith = ensureEmpireShape({ ownerId: 'x', buildings: [{ type: 'blacksmith', level: 4, lastCollectedAt: 0 }] })
  assert.strictEqual(blacksmithLevel(smith), 4)
})

check('forgeCheck gates in order: no_blacksmith, then rank, then materials, then solars', () => {
  const recipe = { materials: [{ itemId: 'iron_ore', qty: 2 }, { itemId: 'wood_plank', qty: 1 }], solarsCost: 100 }
  const bare = ensureEmpireShape({ ownerId: 'x' })
  assert.strictEqual(forgeCheck(bare, recipe, 1).reason, 'no_blacksmith')
  // A level-1 forge tops out at rank 3, so a rank-4 output is refused on rank.
  const smith = ensureEmpireShape({ ownerId: 'x', treasury: 0, buildings: [{ type: 'blacksmith', level: 1, lastCollectedAt: 0 }] })
  assert.strictEqual(forgeCheck(smith, recipe, 4).reason, 'rank')
  // Rank fine, but the stash is empty: materials block, and the shortfall is named.
  const matChk = forgeCheck(smith, recipe, 1)
  assert.strictEqual(matChk.reason, 'materials')
  assert.ok(matChk.missing.find(m => m.itemId === 'iron_ore' && m.need === 2 && m.have === 0), 'the missing ore is reported')
  // Materials in the stash but the treasury is short: solars block.
  smith.stash.materials = { iron_ore: 2, wood_plank: 1 }
  const solChk = forgeCheck(smith, recipe, 1)
  assert.strictEqual(solChk.reason, 'solars')
  assert.strictEqual(solChk.shortSolars, 100)
  // Fund it and the check finally clears.
  smith.treasury = 100
  assert.strictEqual(forgeCheck(smith, recipe, 1).ok, true)
})

check('applyForge consumes stash materials and the fee, stacks the piece, and logs the smith', () => {
  const recipe = { materials: [{ itemId: 'iron_ore', qty: 2 }, { itemId: 'wood_plank', qty: 1 }], solarsCost: 100 }
  const rec = ensureEmpireShape({ ownerId: 'x', treasury: 250, buildings: [{ type: 'blacksmith', level: 1, lastCollectedAt: 0 }] })
  rec.stash.materials = { iron_ore: 5, wood_plank: 2 }
  const entry = applyForge(rec, recipe, { id: 't_sword_1', name: 'Training Sword' }, 'Sir Test', 1000)
  assert.strictEqual(rec.stash.materials.iron_ore, 3, 'two ore consumed')
  assert.strictEqual(rec.stash.materials.wood_plank, 1, 'one plank consumed')
  assert.strictEqual(rec.treasury, 150, 'the forge fee is drawn from the treasury')
  assert.strictEqual(entry.id, 't_sword_1')
  assert.strictEqual(entry.madeBy, 'Sir Test', 'provenance lives on the stash stack, tagged with its maker')
  assert.strictEqual(entry.qty, 1)
  assert.strictEqual(rec.blacksmith.forgeLog[0].item, 'Training Sword', 'the forge log records the work')
  assert.strictEqual(rec.blacksmith.forgeLog[0].by, 'Sir Test')
  // A second identical forge by the same smith stacks onto the same pile.
  applyForge(rec, recipe, { id: 't_sword_1', name: 'Training Sword' }, 'Sir Test', 1001)
  const stack = rec.stash.items.find(it => it.id === 't_sword_1' && it.madeBy === 'Sir Test')
  assert.strictEqual(stack.qty, 2, 'a second identical forge stacks')
})

check('applyForge removes a stash material stack once it hits zero', () => {
  const recipe = { materials: [{ itemId: 'silver_ore', qty: 2 }], solarsCost: 0 }
  const rec = ensureEmpireShape({ ownerId: 'x', treasury: 0, buildings: [{ type: 'blacksmith', level: 2, lastCollectedAt: 0 }] })
  rec.stash.materials = { silver_ore: 2 }
  applyForge(rec, recipe, { id: 'x_item', name: 'X' }, 'Smith', 1000)
  assert.ok(!('silver_ore' in rec.stash.materials), 'an emptied material stack is deleted, not left at zero')
})

// ── 1h. Empire bank engine (Phase 7): accounts, maintenance tax, collect sweep ─
console.log('\nEmpire bank engine (Phase 7)')

const BANK_JID = 'acc@s.whatsapp.net'
// A record with one banked account, its clock set `agoMs` in the past.
function mkBankRec(balance, agoMs, now) {
  const rec = ensureEmpireShape({ ownerId: 'x', citizenCount: 1, npcs: 0, treasury: 0, lastPopAt: now, lastCivicAt: now })
  rec.bank.accounts[BANK_JID] = { balance, lastTaxAt: now - agoMs }
  return rec
}

check('bankBuilt sees the bank only once one is raised', () => {
  assert.strictEqual(bankBuilt(ensureEmpireShape({ ownerId: 'x' })), false)
  const withBank = ensureEmpireShape({ ownerId: 'x', buildings: [{ type: 'bank', level: 1, lastCollectedAt: 0 }] })
  assert.strictEqual(bankBuilt(withBank), true)
})

check('bankDeposit opens an account, credits it, and bankHeld sums the realm', () => {
  const now = 1000 * HOUR_MS
  const rec = ensureEmpireShape({ ownerId: 'x', treasury: 0, lastPopAt: now, lastCivicAt: now })
  const res = bankDeposit(rec, BANK_JID, 5000, now)
  assert.strictEqual(res.balance, 5000, 'a fresh deposit opens the account at the deposited amount')
  assert.strictEqual(res.taxTaken, 0, 'a brand new account owes no tax')
  assert.strictEqual(bankHeld(rec), 5000)
  bankDeposit(rec, 'other@s.whatsapp.net', 3000, now)
  assert.strictEqual(bankHeld(rec), 8000, 'bankHeld totals every account')
})

check('previewBankAccount reports the pending tax without touching the balance', () => {
  const now = 1000 * HOUR_MS
  const rate = bankTaxRatePerDay()
  const rec = mkBankRec(100000, DAY_MS / 2, now) // half a day elapsed
  const view = previewBankAccount(rec, BANK_JID, now)
  const expected = Math.floor(100000 * rate * 0.5)
  assert.strictEqual(view.balance, 100000, 'the statement never mutates the balance')
  assert.strictEqual(view.pendingTax, expected, 'half a day owes half the daily tax')
  assert.strictEqual(view.net, 100000 - expected)
  assert.strictEqual(rec.bank.accounts[BANK_JID].balance, 100000, 'previewing is read-only')
  assert.strictEqual(rec.treasury, 0, 'previewing credits the treasury not at all')
})

check('accrueBankAccount settles once: balance down, treasury up, clock reset', () => {
  const now = 1000 * HOUR_MS
  const rate = bankTaxRatePerDay()
  const rec = mkBankRec(100000, DAY_MS, now) // one full day
  const tax = accrueBankAccount(rec, BANK_JID, now)
  const expected = Math.floor(100000 * rate * 1)
  assert.strictEqual(tax, expected, 'a full day owes the full daily tax')
  assert.strictEqual(rec.bank.accounts[BANK_JID].balance, 100000 - expected, 'the tax leaves the balance')
  assert.strictEqual(rec.treasury, expected, 'and lands in the treasury')
  assert.strictEqual(rec.bank.taxCollected, expected, 'the realm tallies what it has skimmed')
  assert.strictEqual(rec.bank.accounts[BANK_JID].lastTaxAt, now, 'the clock is stamped to now')
  // A second settle in the same instant owes nothing (the clock just reset).
  assert.strictEqual(accrueBankAccount(rec, BANK_JID, now), 0, 'no double-charge')
})

check('the maintenance tax is clamped to the offline cap, so a long absence cannot wipe a balance', () => {
  const now = 1000 * HOUR_MS
  const capped = accrueBankAccount(mkBankRec(100000, OFFLINE_CAP_MS, now), BANK_JID, now)
  const overdue = accrueBankAccount(mkBankRec(100000, 100 * DAY_MS, now), BANK_JID, now)
  assert.strictEqual(overdue, capped, 'a hundred idle days still only owes one cap of tax')
})

check('bankWithdraw settles tax first, then pays partial or all', () => {
  const now = 1000 * HOUR_MS
  const rate = bankTaxRatePerDay()
  const tax = Math.floor(100000 * rate * 1)
  const rec = mkBankRec(100000, DAY_MS, now)
  const part = bankWithdraw(rec, BANK_JID, 40000, now)
  assert.strictEqual(part.ok, true)
  assert.strictEqual(part.taxTaken, tax, 'the maintenance tax is settled before the withdrawal')
  assert.strictEqual(part.paid, 40000)
  assert.strictEqual(part.balance, 100000 - tax - 40000, 'the balance reflects tax then withdrawal')
  assert.strictEqual(rec.treasury, tax, 'the settled tax reached the treasury')
  // "all" empties whatever remains (no further tax: the clock just reset).
  const rest = bankWithdraw(rec, BANK_JID, Infinity, now)
  assert.strictEqual(rest.paid, 100000 - tax - 40000, 'withdraw all takes the remainder')
  assert.strictEqual(rest.balance, 0)
})

check('bankWithdraw names the reason when there is nothing to take', () => {
  const now = 1000 * HOUR_MS
  const empty = ensureEmpireShape({ ownerId: 'x', lastPopAt: now, lastCivicAt: now })
  assert.strictEqual(bankWithdraw(empty, BANK_JID, 100, now).reason, 'noaccount')
  const zeroed = mkBankRec(0, 0, now)
  assert.strictEqual(bankWithdraw(zeroed, BANK_JID, 100, now).reason, 'empty')
  const some = mkBankRec(5000, 0, now)
  assert.strictEqual(bankWithdraw(some, BANK_JID, 0, now).reason, 'short', 'a zero-solar withdrawal is refused')
})

check('accrueBankAll sweeps every account into the treasury at once', () => {
  const now = 1000 * HOUR_MS
  const rate = bankTaxRatePerDay()
  const rec = ensureEmpireShape({ ownerId: 'x', treasury: 0, lastPopAt: now, lastCivicAt: now })
  rec.bank.accounts['a@s.whatsapp.net'] = { balance: 100000, lastTaxAt: now - DAY_MS }
  rec.bank.accounts['b@s.whatsapp.net'] = { balance: 50000, lastTaxAt: now - DAY_MS }
  const total = accrueBankAll(rec, now)
  const expected = Math.floor(100000 * rate) + Math.floor(50000 * rate)
  assert.strictEqual(total, expected, 'the sweep totals every account')
  assert.strictEqual(rec.treasury, expected, 'all of it lands in the treasury')
})

check('previewCollect reports bank tax and gates hasSomething, but folds it into treasury not at all', () => {
  const now = 1000 * HOUR_MS
  const rate = bankTaxRatePerDay()
  const rec = mkBankRec(100000, DAY_MS, now) // no buildings: the tax is the only event
  const s = previewCollect(rec, now)
  assert.strictEqual(s.bankTax, Math.floor(100000 * rate), 'the pending bank tax is reported')
  assert.strictEqual(s.hasSomething, true, 'a bank-tax-only collect still has something to do')
  assert.strictEqual(s.treasuryAfter, 0, 'preview leaves the sweep to applyCollect (no double-count)')
  // A record with no banked accounts owes nothing (regression guard for old empires).
  assert.strictEqual(previewCollect(ensureEmpireShape({ ownerId: 'x', lastPopAt: now, lastCivicAt: now }), now).bankTax, 0)
})

check('applyCollect sweeps the bank tax into the treasury and reports it', () => {
  const now = 1000 * HOUR_MS
  const rate = bankTaxRatePerDay()
  const expected = Math.floor(100000 * rate)
  const rec = mkBankRec(100000, DAY_MS, now)
  const s = applyCollect(rec, now)
  assert.strictEqual(s.bankTax, expected, 'the summary carries the swept bank tax')
  assert.strictEqual(rec.treasury, expected, 'the treasury grew by the bank tax')
  assert.strictEqual(rec.bank.accounts[BANK_JID].balance, 100000 - expected, 'the account paid it')
  assert.strictEqual(rec.bank.taxCollected, expected, 'and the realm tallied it')
  assert.strictEqual(s.treasuryAfter, rec.treasury, 'the reported treasury matches the record after the sweep')
})

// ── 2. Plugin behaviour (fake ctx, in-memory db) ─────────────────────────────
console.log('\nPlugin')

await acheck('found is rejected when the player is too poor', async () => {
  makePlayer(A, 'Ann', 10000)
  const out = await run(empire, A, 'found Steelhold')
  assert.match(out, /costs/i)
  assert.strictEqual(getOwnedEmpire(db, A), null)
})

await acheck('found debits, seeds treasury/warehouse, starts at one resident, and links the player', async () => {
  db.data.users[A].wallet.solars = 60000
  db.data.users[A].fame = 12000 // the player's own fame must NOT leak into empire fame
  const out = await run(empire, A, 'found Steelhold')
  assert.match(out, /founded/i)
  assert.strictEqual(db.data.users[A].wallet.solars, 10000)
  assert.strictEqual(db.data.users[A].empireId, 'steelhold')
  assert.strictEqual(db.data.users[A].empireRole, 'owner')
  const rec = getOwnedEmpire(db, A)
  assert.ok(rec, 'empire record should exist')
  assert.strictEqual(rec.treasury, EMPIRE_CONFIG.starterTreasury)
  assert.strictEqual(rec.citizenCount, 1, 'the ruler is the first and only sworn resident')
  assert.strictEqual(rec.npcs, 0, 'no townsfolk have moved in yet')
  assert.strictEqual(rec.fame, 1, 'fame is the headcount: one resident, not the founder\'s 12000')
  assert.strictEqual(rec.warehouse.wood, EMPIRE_CONFIG.starterWarehouse.wood)
})

await acheck('a player cannot found a second empire', async () => {
  db.data.users[A].wallet.solars += 100000
  const out = await run(empire, A, 'found Ironreach')
  assert.match(out, /already rule/i)
})

await acheck('empire names are unique bot-wide (case-insensitive)', async () => {
  makePlayer(B, 'Ben', 60000)
  const out = await run(empire, B, 'found steelhold')
  assert.match(out, /taken/i)
  assert.strictEqual(getOwnedEmpire(db, B), null)
})

await acheck('a locked building is rejected below its tier', async () => {
  // A sits at Hamlet (fame 1 < Village 20), and iron_mine needs rank 1.
  const out = await run(empire, A, 'build iron_mine')
  assert.match(out, /unlocks at/i)
})

await acheck('building a solar mine consumes solars and materials', async () => {
  const before = getOwnedEmpire(db, A)
  const t0 = before.treasury
  const w0 = before.warehouse.wood
  const out = await run(empire, A, 'build solar_mine')
  assert.match(out, /built/i)
  const rec = getOwnedEmpire(db, A)
  const cost = buildingCostFor(buildingDefMap['solar_mine'], 1)
  assert.strictEqual(rec.treasury, t0 - cost.solars)
  assert.strictEqual(rec.warehouse.wood, w0 - (cost.materials.wood ?? 0))
  assert.ok(rec.buildings.find(b => b.type === 'solar_mine'), 'the building should be recorded')
})

await acheck('the same building cannot be built twice', async () => {
  const out = await run(empire, A, 'build solar_mine')
  assert.match(out, /already have/i)
})

await acheck('collect produces solars, pays upkeep, and resets the timer', async () => {
  const rec = db.data.empires['steelhold']
  const b = rec.buildings.find(x => x.type === 'solar_mine')
  const now = Date.now()
  b.lastCollectedAt = now - 3 * HOUR_MS
  const tBefore = rec.treasury
  await run(empire, A, 'collect')
  const def = buildingDefMap['solar_mine']
  const gross = Math.floor(def.baseYieldPerHour * 3)
  const maint = Math.floor(def.maintPerHour * 3)
  assert.strictEqual(rec.treasury, tBefore + gross - maint)
  assert.ok(b.lastCollectedAt >= now, 'the building timer should reset to now')
})

await acheck('upgrade settles at the old level (no retroactive boost)', async () => {
  const rec = db.data.empires['steelhold']
  rec.treasury += 100000
  rec.warehouse.wood += 1000
  rec.warehouse.stone += 1000
  const b = rec.buildings.find(x => x.type === 'solar_mine')
  const now = Date.now()
  b.lastCollectedAt = now - 5 * HOUR_MS
  const def = buildingDefMap['solar_mine']
  const before = rec.treasury
  const cost = buildingCostFor(def, 2)
  const out = await run(empire, A, 'upgrade solar_mine')
  assert.match(out, /upgraded/i)
  const settledGross = Math.floor(def.baseYieldPerHour * 5)
  const settledMaint = Math.floor(def.maintPerHour * 5)
  assert.strictEqual(rec.treasury, before + settledGross - settledMaint - cost.solars)
  assert.strictEqual(b.level, 2)
  // Collecting immediately after must not pay out 5h at the new level.
  const t2 = rec.treasury
  await run(empire, A, 'collect')
  assert.ok(rec.treasury - t2 < def.baseYieldPerHour, 'there should be no post-upgrade windfall')
})

await acheck('shop buy is rejected when the treasury is too low', async () => {
  makePlayer(C, 'Cid', 60000)
  await run(empire, C, 'found Ashmark')
  const rec = db.data.empires['ashmark']
  rec.treasury = 100
  const out = await run(empire, C, 'shop buy wood 999')
  assert.match(out, /treasury/i)
})

await acheck('shop buy is rejected when it would exceed warehouse room', async () => {
  const rec = db.data.empires['ashmark']
  rec.treasury = 10000000
  const room = warehouseRoom(rec)
  const out = await run(empire, C, `shop buy wood ${room + 100}`)
  assert.match(out, /room/i)
})

await acheck('shop buy succeeds within treasury and room', async () => {
  const rec = db.data.empires['ashmark']
  const w0 = rec.warehouse.wood
  const t0 = rec.treasury
  const out = await run(empire, C, 'shop buy wood 10')
  assert.match(out, /bought/i)
  assert.strictEqual(rec.warehouse.wood, w0 + 10)
  assert.strictEqual(rec.treasury, t0 - 10 * SHOP_PRICES.wood)
})

// ── 2b. Army plugin (recruit, train, delegation, leaderboards) ────────────────
console.log('\nArmy plugin')

await acheck('.recruit alias adds troops and debits the treasury', async () => {
  const rec = db.data.empires['steelhold']
  rec.treasury = 100000
  const out = await run(army, A, '10', 'recruit')
  assert.match(out, /recruited/i)
  const rec2 = db.data.empires['steelhold']
  assert.strictEqual(rec2.army.levies.recruit, 10)
  assert.strictEqual(armyHeadcount(rec2), 10)
})

await acheck('.recruit is rejected past the army cap', async () => {
  const rec = db.data.empires['steelhold']
  rec.treasury = 100000
  const out = await run(army, A, '999', 'recruit')
  assert.match(out, /field/i)
})

await acheck('.army renders the roster', async () => {
  const out = await run(army, A, '')
  assert.match(out, /Army of Steelhold/i)
  assert.match(out, /Headcount/i)
})

await acheck('.army train soldier promotes the lowest rank up one step', async () => {
  const rec = db.data.empires['steelhold']
  rec.treasury = 1000000
  for (const id of MATERIAL_IDS) rec.warehouse[id] = 999
  rec.army.levies.recruit = 10
  rec.army.levies.soldier = 0
  const out = await run(army, A, 'train soldier 4', 'army')
  assert.match(out, /Promoted/i)
  const rec2 = db.data.empires['steelhold']
  assert.strictEqual(rec2.army.levies.recruit, 6)
  assert.strictEqual(rec2.army.levies.soldier, 4)
})

await acheck('.train soldier delegates through the train plugin guard', async () => {
  const rec = db.data.empires['steelhold']
  rec.treasury = 1000000
  for (const id of MATERIAL_IDS) rec.warehouse[id] = 999
  const beforeRecruit = rec.army.levies.recruit // 6, still the lowest rank
  const out = await run(train, A, 'soldier 2', 'train')
  assert.match(out, /Promoted/i)
  const rec2 = db.data.empires['steelhold']
  assert.strictEqual(rec2.army.levies.recruit, beforeRecruit - 2)
})

await acheck('a numeric .train does not promote the army (guard is narrow)', async () => {
  const rec = db.data.empires['steelhold']
  const before = { ...rec.army.levies }
  // A numeric arg falls through to the real stat-point path, which throws on
  // this minimal fake player (no class). That is fine: the claim under test is
  // only that it never reached the army promote path, so the army is untouched.
  try { await run(train, A, '3', 'train') } catch { /* stat engine needs a fuller fixture */ }
  const rec2 = db.data.empires['steelhold']
  assert.deepStrictEqual(rec2.army.levies, before)
})

await acheck('.empire collect charges wages and deserts on a shortfall', async () => {
  const rec = db.data.empires['steelhold']
  const now = Date.now()
  rec.army.levies.recruit = 50
  rec.army.levies.soldier = 0
  rec.army.officers = []
  rec.treasury = 0
  for (const b of rec.buildings) b.lastCollectedAt = now // no fresh production
  rec.army.lastPaidAt = now - 10 * HOUR_MS
  const out = await run(empire, A, 'collect')
  assert.match(out, /payroll/i)
  const rec2 = db.data.empires['steelhold']
  assert.ok(rec2.army.levies.recruit < 50, 'unpaid recruits should desert')
})

// ── 2c. Leaderboards (read-only) ─────────────────────────────────────────────
console.log('\nLeaderboards')

await acheck('.empire-top lists founded empires', async () => {
  const out = await run(empireTop, A, '', 'empire-top')
  assert.match(out, /Strongest Empires/i)
  assert.match(out, /Steelhold/i)
})

await acheck('.army-top lists named officers bot-wide', async () => {
  const rec = db.data.empires['steelhold']
  rec.treasury = 1e9
  for (const id of MATERIAL_IDS) rec.warehouse[id] = 999
  rec.army.levies.recruit = 0
  rec.army.levies.soldier = 3
  applyPromote(rec, 1, () => 'Sir Test') // mint a veteran directly via the engine
  const out = await run(empireTop, A, '', 'army-top')
  assert.match(out, /Strongest Soldiers/i)
  assert.match(out, /Sir Test/i)
})

// ── 2d. Raid plugin (scout, gates, two-party writes, one notification) ────────
console.log('\nRaid plugin')

// Two comparable Town-tier empires, injected directly (bypassing `.empire found`
// keeps founding costs out of this slice) with freshly-settled books so a raid's
// applyCollect nets ~0 and treasury deltas are purely loot.
{
  const now = Date.now()
  makePlayer(D, 'Del', 0)
  makePlayer(E, 'Eve', 0)
  makePlayer(F, 'Fen', 0)
  const mk = (id, name, ownerId, over = {}) => {
    const rec = ensureEmpireShape({
      id, name, ownerId, fame: 100000, treasury: 50000, foundedAt: now, lastActiveAt: now,
      buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now }],
      army: { levies: { recruit: 100, soldier: 20 }, officers: [], lastPaidAt: now },
      ...over,
    })
    db.data.empires[id] = rec
    db.data.users[ownerId].empireId = id
    db.data.users[ownerId].empireRole = 'owner'
    return rec
  }
  mk('raidus', 'Raidus', D)
  mk('targos', 'Targos', E)
  // A genuine minnow: no treasury, no army, just its lone ruler => might 3, far
  // below the weight floor, so it is protected.
  mk('pebble', 'Pebble', F, {
    fame: 0, treasury: 0, buildings: [],
    army: { levies: { recruit: 0, soldier: 0 }, officers: [], lastPaidAt: now },
  })
}

await acheck('.raid scout returns noised intel and never writes or sends', async () => {
  const sends0 = sockSends
  const before = JSON.stringify(db.data.empires['targos'])
  const out = await run(raid, D, 'scout Targos', 'raid')
  assert.match(out, /Scouting Targos/i)
  assert.match(out, /Tier:/i)
  assert.strictEqual(sockSends, sends0, 'scouting never touches the socket')
  assert.strictEqual(JSON.stringify(db.data.empires['targos']), before, 'scouting never mutates the target')
})

await acheck('.spy is a straight alias for raid scout', async () => {
  const out = await run(raid, D, 'Targos', 'spy')
  assert.match(out, /Scouting Targos/i)
})

await acheck('raid refuses your own empire', async () => {
  const out = await run(raid, D, 'Raidus', 'raid')
  assert.match(out, /your own empire/i)
})

await acheck('raid refuses a shielded target (before any write)', async () => {
  const t = db.data.empires['targos']
  t.shieldUntil = Date.now() + 100 * HOUR_MS
  const out = await run(raid, D, 'Targos', 'raid')
  assert.match(out, /shield/i)
  t.shieldUntil = 0
})

await acheck('raid refuses a far-weaker (low-might) target, no stomp', async () => {
  const out = await run(raid, D, 'Pebble', 'raid')
  assert.match(out, /far weaker|weight/i)
  assert.strictEqual(db.data.empires['pebble'].treasury, 0, 'the minnow is untouched')
})

await acheck('raid refuses when you field no army', async () => {
  const r = db.data.empires['raidus']
  const saved = { ...r.army.levies }
  r.army.levies.recruit = 0
  r.army.levies.soldier = 0
  const out = await run(raid, D, 'Targos', 'raid')
  assert.match(out, /no army/i)
  r.army.levies.recruit = saved.recruit
  r.army.levies.soldier = saved.soldier
})

await acheck('a raid moves loot defender->attacker, bloods both, fires ONE notification, sends nothing', async () => {
  const now = Date.now()
  const atk = db.data.empires['raidus']
  const def = db.data.empires['targos']
  atk.deployedUntil = 0; atk.lastRaidAt = 0; atk.shieldUntil = 0
  def.shieldUntil = 0; def.deployedUntil = 0
  for (const b of atk.buildings) b.lastCollectedAt = now
  for (const b of def.buildings) b.lastCollectedAt = now
  atk.army.lastPaidAt = now; def.army.lastPaidAt = now
  atk.treasury = 50000; def.treasury = 50000
  const atkT0 = atk.treasury, defT0 = def.treasury
  const atkHead0 = armyHeadcount(atk), defHead0 = armyHeadcount(def)
  const notes0 = listNotifications(db, E).length
  const sends0 = sockSends

  const out = await run(raid, D, 'Targos', 'raid')
  assert.match(out, /RAID (SUCCESSFUL|REPELLED)/i)

  const atk2 = db.data.empires['raidus'], def2 = db.data.empires['targos']
  assert.strictEqual(atk2.treasury - atkT0, defT0 - def2.treasury, 'every looted solar leaves the defender')
  assert.ok(atk2.treasury - atkT0 >= 0, 'loot is never negative')
  assert.ok(atk2.deployedUntil > now, 'the attacker is left deployed')
  assert.ok(atk2.lastRaidAt > 0, 'the raid cooldown clock is stamped')
  assert.ok(atk2.raidLog.length === 1 && def2.raidLog.length === 1, 'both sides log the raid')
  assert.ok(armyHeadcount(atk2) <= atkHead0 && armyHeadcount(def2) <= defHead0, 'no one gains troops in a raid')
  assert.ok(armyHeadcount(atk2) < atkHead0 || armyHeadcount(def2) < defHead0, 'a raid always costs someone troops')
  assert.strictEqual(listNotifications(db, E).length, notes0 + 1, 'exactly one defender notification')
  assert.strictEqual(sockSends, sends0, 'a raid never calls sock.sendMessage')
})

await acheck('raid refuses again immediately: troops are still deployed', async () => {
  const out = await run(raid, D, 'Targos', 'raid')
  assert.match(out, /deployed|regroup/i)
})

await acheck('.raid log shows the attacker\'s just-fought raid', async () => {
  const out = await run(raid, D, 'log', 'raid')
  assert.match(out, /Raid log: Raidus/i)
  assert.match(out, /Targos/i)
})

await acheck('.raid shield reports the deployed standing', async () => {
  const out = await run(raid, D, 'shield', 'raid')
  assert.match(out, /Standing of Raidus/i)
  assert.match(out, /deployed/i)
})

// ── 2e. Citizens, character posts & the storefront (Phase 3b/3c/3d) ───────────
console.log('\nCitizens, posts & market')

// Havenreach: a City-tier empire (130 townsfolk plus its ruler push the
// headcount past City's 120) so it is big enough to visit (mapMinRank) and has
// citizen seats. Its housing (baseCap 4 + one solar_mine's 2 = 6) is far below
// that headcount, so popRoom is 0 and nobody new moves in during the run; the
// two population clocks start at now so no civic tax or wages accrue either,
// keeping the settle-first worker test's treasury math pure production. G rules
// it and owns a small roster; H will become a citizen and lend a character.
{
  const now = Date.now()
  makePlayer(G, 'Gia', 500000)
  makePlayer(H, 'Hal', 500000)
  makePlayer(I, 'Ivy', 60000)
  db.data.users[G].ownedCharacters = ['gojo', 'willow', 'mei']
  db.data.users[H].ownedCharacters = ['circe']
  const rec = ensureEmpireShape({
    id: 'havenreach', name: 'Havenreach', ownerId: G,
    npcs: 130, treasury: 50000, foundedAt: now, lastActiveAt: now,
    lastPopAt: now, lastCivicAt: now,
    warehouse: { wood: 500, stone: 0, iron: 0 },
    buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now }],
    army: { levies: { recruit: 100, soldier: 0 }, officers: [], lastPaidAt: now },
  })
  db.data.empires['havenreach'] = rec
  db.data.users[G].empireId = 'havenreach'
  db.data.users[G].empireRole = 'owner'
}

await acheck('a traveler joins an empire as a citizen', async () => {
  const out = await run(empire, H, 'join Havenreach')
  assert.match(out, /citizen of Havenreach/i)
  assert.strictEqual(db.data.users[H].empireId, 'havenreach')
  assert.strictEqual(db.data.users[H].empireRole, 'citizen')
})

await acheck('a ruler cannot walk away from their own empire', async () => {
  const out = await run(empire, G, 'leave')
  assert.match(out, /rule/i)
  assert.strictEqual(db.data.users[G].empireId, 'havenreach', 'the ruler stays put')
})

await acheck('a citizen cannot swear to a second empire', async () => {
  const out = await run(empire, H, 'join Steelhold')
  assert.match(out, /already sworn/i)
  assert.strictEqual(db.data.users[H].empireId, 'havenreach')
})

await acheck('the citizen cap blocks the last seat', async () => {
  const now = Date.now()
  makePlayer(J, 'Jax', 60000)
  const tiny = ensureEmpireShape({ id: 'tinyhold', name: 'Tinyhold', ownerId: J, fame: 0, treasury: 1000, foundedAt: now, lastActiveAt: now })
  db.data.empires['tinyhold'] = tiny
  db.data.users[J].empireId = 'tinyhold'; db.data.users[J].empireRole = 'owner'
  // Hamlet seats 2 citizens; fill both, then a third must be turned away.
  assert.strictEqual(citizenCap(tiny), 2, 'a hamlet seats two citizens')
  db.data.users['seat1@w'] = { id: 'seat1@w', name: 'S1', empireId: 'tinyhold', empireRole: 'citizen' }
  db.data.users['seat2@w'] = { id: 'seat2@w', name: 'S2', empireId: 'tinyhold', empireRole: 'citizen' }
  makePlayer(K, 'Kim', 60000)
  const out = await run(empire, K, 'join Tinyhold')
  assert.match(out, /full/i)
  assert.strictEqual(db.data.users[K].empireId, null, 'the turned-away joiner stays unsworn')
})

await acheck('posting a worker settles at the old rate, then boosts output', async () => {
  const rec = db.data.empires['havenreach']
  const now = Date.now()
  const b = rec.buildings.find(x => x.type === 'solar_mine')
  b.lastCollectedAt = now - 5 * HOUR_MS
  rec.army.lastPaidAt = now // freshly paid, so the settle is pure production
  rec.lastCivicAt = now; rec.lastPopAt = now // civic window 0: no townsfolk tax/wages/arrivals fold in
  const T0 = rec.treasury
  const out = await run(empire, G, 'assign worker willow solar_mine')
  assert.match(out, /work/i)
  const def = buildingDefMap['solar_mine']
  // Settled at level 1 with NO worker boost: the boost only applies going forward.
  assert.strictEqual(rec.treasury, T0 + Math.floor(def.baseYieldPerHour * 5) - Math.floor(def.maintPerHour * 5))
  assert.ok(workerOnBuilding(rec, 'solar_mine'), 'the worker is posted to the mine')
  assert.ok(Math.abs(workerMultFor(rec, 'solar_mine') - 1.04) < 1e-9, 'willow is 1 star: +4% output')
})

await acheck('posting a general lifts army power but never might', async () => {
  const rec = db.data.empires['havenreach']
  const power0 = armyPower(rec)
  const might0 = empireScore(rec)
  const out = await run(empire, G, 'assign general gojo')
  assert.match(out, /command/i)
  assert.ok(Math.abs(generalBonusOf(rec) - 0.25) < 1e-9, 'gojo is 5 stars: +25% power')
  assert.strictEqual(armyPower(rec, generalBonusOf(rec)), Math.round(power0 * 1.25), 'the bonus folds into power')
  assert.strictEqual(empireScore(rec), might0, 'a general never changes the empire might that weight matching reads')
})

await acheck('a player cannot exceed their personal post cap', async () => {
  // G now holds two posts (willow + gojo) = PER_PLAYER_CAP, so a third is refused.
  const out = await run(empire, G, 'assign worker mei solar_mine')
  assert.match(out, /posted here|already have/i)
})

await acheck('you cannot post a character you do not own', async () => {
  const out = await run(empire, G, 'assign general circe') // circe belongs to H
  assert.match(out, /don't own|not own/i)
})

await acheck('the single general slot turns away a second commander', async () => {
  // H is a citizen (membership, not ownership, is the gate) and owns circe, but
  // gojo already commands, so the general slot is full.
  const out = await run(empire, H, 'assign general circe')
  assert.match(out, /general/i)
  assert.strictEqual((db.data.empires['havenreach'].assignments.generals ?? []).length, 1)
})

await acheck('unassigning recalls a worker and settles first', async () => {
  const rec = db.data.empires['havenreach']
  const out = await run(empire, G, 'unassign willow')
  assert.match(out, /recall/i)
  assert.strictEqual(workerOnBuilding(rec, 'solar_mine'), null, 'the mine is worked by no one again')
})

await acheck('a citizen can lend a character to raise a building', async () => {
  const rec = db.data.empires['havenreach']
  const out = await run(empire, H, 'assign worker circe solar_mine')
  assert.match(out, /work/i)
  assert.ok(Math.abs(workerMultFor(rec, 'solar_mine') - 1.20) < 1e-9, 'circe is 5 stars: +20% output')
  const posted = workerOnBuilding(rec, 'solar_mine')
  assert.strictEqual(posted.ownerJid, H, 'the post is credited to the citizen who lent the character')
})

await acheck('the ruler stocks the market by moving warehouse goods', async () => {
  const rec = db.data.empires['havenreach']
  const w0 = rec.warehouse.wood
  const out = await run(empire, G, 'market set wood 20 100')
  assert.match(out, /listed/i)
  assert.strictEqual(rec.warehouse.wood, w0 - 100, 'stock leaves the warehouse for the shelf')
  const line = rec.market.stock.find(s => s.itemId === 'wood')
  assert.ok(line && line.qty === 100 && line.price === 20, 'the listing carries the moved stock')
})

await acheck('a price outside the fair band is refused', async () => {
  const rec = db.data.empires['havenreach']
  const before = rec.warehouse.wood
  const out = await run(empire, G, 'market set wood 100 10') // ceil is 2x base = 24
  assert.match(out, /band/i)
  assert.strictEqual(rec.warehouse.wood, before, 'a rejected listing moves nothing')
})

await acheck('.empire citizens lists the ruler and citizens', async () => {
  const out = await run(empire, G, 'citizens')
  assert.match(out, /Citizens of Havenreach/i)
  assert.match(out, /Hal/, 'the citizen is listed by name')
})

await acheck('a citizen buys at a discount; the sale funds the treasury and fires ONE notification', async () => {
  const rec = db.data.empires['havenreach']
  const tBefore = rec.treasury
  const wBefore = db.data.users[H].wallet.solars
  const notes0 = listNotifications(db, G).length
  const sends0 = sockSends
  const unit = Math.round(20 * (1 - MARKET_CONFIG.citizenDiscountPct)) // 20 * 0.9 = 18
  const out = await run(empire, H, 'buy wood 5')
  assert.match(out, /bought/i)
  assert.match(out, /citizen price/i)
  assert.strictEqual(db.data.users[H].wallet.solars, wBefore - unit * 5, 'the buyer pays the discounted price from their wallet')
  assert.strictEqual(rec.treasury, tBefore + unit * 5, 'every solar paid lands in the seller treasury')
  assert.strictEqual(db.data.users[H].inventory.filter(x => x === 'wood').length, 5, 'the goods go into the buyer bag')
  assert.strictEqual(listNotifications(db, G).length, notes0 + 1, 'exactly one sale notification to the ruler')
  assert.strictEqual(sockSends, sends0, 'a market sale never calls sock.sendMessage')
})

await acheck('a visitor travels in, pays full price, and never overpays into the treasury', async () => {
  const rec = db.data.empires['havenreach']
  const travel = MARKET_CONFIG.travelCostSolars
  const vBefore = db.data.users[I].wallet.solars
  const visit = await run(empire, I, 'visit Havenreach')
  assert.match(visit, /arrive/i)
  assert.strictEqual(db.data.users[I].visitingEmpire, 'havenreach', 'the visitor is now shopping here')
  assert.strictEqual(db.data.users[I].wallet.solars, vBefore - travel, 'the road charges the travel cost')

  const tBefore = rec.treasury
  const wBefore = db.data.users[I].wallet.solars
  const out = await run(empire, I, 'buy wood 3')
  assert.match(out, /bought/i)
  assert.ok(!/citizen price/i.test(out), 'a non-citizen gets no discount')
  assert.strictEqual(db.data.users[I].wallet.solars, wBefore - 20 * 3, 'the visitor pays the full listed price')
  assert.strictEqual(rec.treasury, tBefore + 20 * 3, 'the sale funds the treasury')
  assert.strictEqual(db.data.users[I].inventory.filter(x => x === 'wood').length, 3)
})

await acheck('an empire below the map rank cannot be visited', async () => {
  const out = await run(empire, I, 'visit Tinyhold') // hamlet, rank 0 < mapMinRank
  assert.match(out, /too small/i)
})

await acheck('leaving an empire strips the citizen\'s posts', async () => {
  const rec = db.data.empires['havenreach']
  assert.ok(workerOnBuilding(rec, 'solar_mine'), 'circe is posted before the leave')
  const out = await run(empire, H, 'leave')
  assert.match(out, /no longer a citizen/i)
  assert.strictEqual(db.data.users[H].empireId, null, 'membership is cleared')
  assert.strictEqual(workerOnBuilding(rec, 'solar_mine'), null, 'the lent character comes home, so no post outlives the citizenship')
})

// ── 2f. War engine (pure, scripted rng) ──────────────────────────────────────
console.log('\nWar engine')

// A scripted rng: returns the given values in order, then repeats the last.
// resolveWarRound draws exactly three times (aRoll, dRoll, officerRoll).
const rngOf = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)] }

check('weightMatchOk honours an explicit war floor', () => {
  assert.strictEqual(weightMatchOk({ might: 100 }, { might: 50 }, 0.5), true, 'exactly at the floor is legal')
  assert.strictEqual(weightMatchOk({ might: 100 }, { might: 49 }, 0.5), false, 'below the floor is protected')
  assert.strictEqual(weightMatchOk({ might: 100 }, { might: 50 }, 0.9), false, 'a stricter floor protects more')
  assert.strictEqual(weightMatchOk({ might: 100 }, { might: 90 }, 0.9), true)
})

check('resolveWarRound is deterministic for a given rng sequence', () => {
  const a = { power: 500, levies: { recruit: 100, soldier: 20 }, officerCount: 2 }
  const d = { power: 480, levies: { recruit: 90, soldier: 25 }, officerCount: 1 }
  const r1 = resolveWarRound(a, d, makeRng(99), 1000)
  const r2 = resolveWarRound(a, d, makeRng(99), 1000)
  assert.deepStrictEqual(r1, r2, 'same seed must give an identical plan')
})

check('a war round bleeds the loser far harder than the winner', () => {
  // aRoll 1.0, dRoll 1.0 => equal rolls, tie goes to the attacker who pressed.
  const a = { power: 500, levies: { recruit: 1000, soldier: 0 }, officerCount: 0 }
  const d = { power: 500, levies: { recruit: 1000, soldier: 0 }, officerCount: 0 }
  const r = resolveWarRound(a, d, rngOf(0.5, 0.5, 0.99), 1000)
  assert.strictEqual(r.attackerWins, true, 'a tie goes to the attacker')
  assert.ok(r.defenderLosses.recruit > r.attackerLosses.recruit, 'the round loser bleeds more')
  assert.ok(r.attackerLosses.recruit > 0, 'even the winner bleeds')
  // A war round must be heavier than a whole raid at the same margin.
  const raidPlan = resolveRaid(a, d, rngOf(0.5, 0.5, 0.5), 1000)
  assert.ok(r.defenderLosses.recruit > raidPlan.defenderLosses.recruit, 'war rounds cost more than raids')
})

check('only the round LOSER can forfeit an officer, and never both sides', () => {
  const a = { power: 0, levies: { recruit: 10, soldier: 0 }, officerCount: 3 }
  const d = { power: 100, levies: { recruit: 10, soldier: 0 }, officerCount: 3 }
  // Attacker rolls to 0 power, so the attacker loses the round; officerRoll 0 hits.
  const lost = resolveWarRound(a, d, rngOf(0.5, 0.5, 0.0), 1000)
  assert.strictEqual(lost.attackerWins, false)
  assert.strictEqual(lost.attackerOfficerLost, true, 'the round loser forfeits an officer')
  assert.strictEqual(lost.defenderOfficerLost, false, 'the round winner never does')
  // A high officer roll spares even the loser.
  const spared = resolveWarRound(a, d, rngOf(0.5, 0.5, 0.99), 1000)
  assert.strictEqual(spared.attackerOfficerLost, false, 'a high roll spares the loser')
  // An empty corps cannot lose an officer it does not have.
  const bare = resolveWarRound({ ...a, officerCount: 0 }, d, rngOf(0.5, 0.5, 0.0), 1000)
  assert.strictEqual(bare.attackerOfficerLost, false)
})

check('resolveWarSpoils caps tribute and only razes what actually produces', () => {
  const victor = { power: 100 }
  const rich = { treasury: 10000000, producingTypes: ['solar_mine', 'iron_mine'] }
  const s = resolveWarSpoils(victor, rich, rngOf(0))
  assert.strictEqual(s.tribute, WAR_CONFIG.tributeHardCap, 'a vast treasury is capped, not drained')
  assert.ok(rich.producingTypes.includes(s.razed), 'the razed building is one the loser actually had')
  const poor = { treasury: 1000, producingTypes: [] }
  const s2 = resolveWarSpoils(victor, poor, rngOf(0))
  assert.strictEqual(s2.tribute, Math.floor(1000 * WAR_CONFIG.tributePct), 'a small treasury pays the plain pct')
  assert.strictEqual(s2.razed, null, 'nothing to raze means nothing razed')
  const broke = resolveWarSpoils(victor, { treasury: 0, producingTypes: [] }, rngOf(0))
  assert.strictEqual(broke.tribute, 0, 'tribute is never negative or invented')
  assert.strictEqual(rich.treasury, 10000000, 'resolveWarSpoils never mutates a snapshot')
})

check('ensureWarShape drops a malformed war, listing and vassalage to safe nulls', () => {
  assert.strictEqual(ensureWarShape({ war: { opponentId: 'x', status: 'bogus' } }).war, null, 'an unknown status is dropped')
  assert.strictEqual(ensureWarShape({ war: { status: 'active' } }).war, null, 'a war with no opponent is dropped')
  const kept = ensureWarShape({ war: { opponentId: 'x', status: 'active' } })
  assert.strictEqual(kept.war.opponentName, 'a rival', 'a nameless opponent gets a placeholder')
  assert.strictEqual(kept.war.role, 'aggressor')
  assert.strictEqual(kept.war.myWins, 0)
  assert.strictEqual(ensureWarShape({ sellListing: { price: 0 } }).sellListing, null, 'a zero price is not a listing')
  assert.strictEqual(ensureWarShape({ sellListing: { price: -5 } }).sellListing, null, 'a negative price is not a listing')
  assert.strictEqual(ensureWarShape({ sellListing: { price: '2500.7' } }).sellListing.price, 2500, 'a price is floored to an integer')
  assert.strictEqual(ensureWarShape({ dormant: 'yes' }).dormant, false, 'dormant is strictly boolean')
  assert.deepStrictEqual(ensureWarShape({ warLog: 'nope' }).warLog, [], 'the war log is always an array')
  assert.strictEqual(ensureWarShape({}).lastWarAt, 0)
})

check('vassalage expires lazily and isVassal reads the clock', () => {
  const now = 1000000
  const freed = { vassalOf: 'lord', vassalOfName: 'Lord', vassalUntil: now - 1 }
  assert.strictEqual(isVassal(freed, now), false, 'an elapsed vassalage is not vassalage')
  assert.strictEqual(expireVassalage(freed, now), true, 'expiring it reports the change')
  assert.strictEqual(freed.vassalOf, null)
  assert.strictEqual(freed.vassalUntil, 0)
  assert.strictEqual(expireVassalage(freed, now), false, 'expiring twice is a no-op')
  const bound = { vassalOf: 'lord', vassalOfName: 'Lord', vassalUntil: now + DAY_MS }
  assert.strictEqual(isVassal(bound, now), true)
  assert.strictEqual(expireVassalage(bound, now), false, 'a live vassalage is left alone')
})

check('applySeasonDecay trims the NPC population (never sworn players) and re-seats the tier', () => {
  // Fame is derived headcount, so the season valve sheds townsfolk; the ruler and
  // any sworn citizens stay, and fame follows the smaller population.
  const rec = ensureEmpireShape({ ownerId: 'x', citizenCount: 1, npcs: 100, treasury: 50000 })
  const npcsBefore = rec.npcs
  const d = applySeasonDecay(rec)
  assert.strictEqual(d.fameLost, Math.floor(100 * LIFECYCLE_CONFIG.decayFamePct), 'the reported loss is the townsfolk who drifted away')
  assert.strictEqual(d.treasuryLost, Math.floor(50000 * LIFECYCLE_CONFIG.decayTreasuryPct))
  assert.strictEqual(rec.npcs, npcsBefore - d.fameLost, 'the townsfolk are actually gone')
  assert.strictEqual(rec.fame, populationOf(rec), 'fame follows the trimmed headcount')
  assert.strictEqual(rec.fame, 1 + rec.npcs, 'the lone ruler plus the survivors')
  assert.strictEqual(rec.treasury, 50000 - d.treasuryLost)
  assert.strictEqual(rec.tierId, tierForFame(rec.fame).id, 'the tier is recomputed from the trimmed fame')
  const empty = ensureEmpireShape({ ownerId: 'x', npcs: 0, treasury: 0 })
  assert.deepStrictEqual(applySeasonDecay(empty), { fameLost: 0, treasuryLost: 0 }, 'nothing to decay, nothing lost')
  assert.ok(empty.fame >= 0 && empty.treasury >= 0, 'decay never goes negative')
})

check('removeLowestOfficer takes exactly one officer, or reports an empty corps', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', fame: 0,
    army: { levies: { recruit: 0, soldier: 0 }, officers: [{ name: 'A', rank: 'veteran', xp: 0 }, { name: 'B', rank: 'knight', xp: 50 }] },
  })
  const gone = removeLowestOfficer(rec)
  assert.ok(gone && gone.name, 'an officer walks')
  assert.strictEqual(rec.army.officers.length, 1, 'exactly one leaves')
  assert.ok(removeLowestOfficer(rec), 'the last officer can walk too')
  assert.strictEqual(removeLowestOfficer(rec), null, 'an empty corps returns null')
})

// ── 2g. War plugin (declare, accept/decline, rounds, spoils, peace) ──────────
console.log('\nWar plugin')

// Ironwall vs Stonevale: matched on MIGHT (identical fame and treasury, so the
// weight gate passes) but Stonevale fields no army at all, so its power is 0 and
// every round resolves for the attacker. That makes a multi-round war fully
// deterministic without having to inject an rng into the plugin.
{
  const now = Date.now()
  makePlayer(L, 'Lyr', 0)
  makePlayer(M, 'Mor', 0)
  makePlayer(N, 'Nix', 0)
  makePlayer(O, 'Ode', 0)
  const mkWar = (id, name, ownerId, over = {}) => {
    const rec = ensureEmpireShape({
      id, name, ownerId, fame: 400000, treasury: 200000, foundedAt: now, lastActiveAt: now,
      buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now }],
      army: { levies: { recruit: 60, soldier: 10 }, officers: [], lastPaidAt: now },
      ...over,
    })
    db.data.empires[id] = rec
    db.data.users[ownerId].empireId = id
    db.data.users[ownerId].empireRole = 'owner'
    return rec
  }
  mkWar('ironwall', 'Ironwall', L)
  mkWar('stonevale', 'Stonevale', M, {
    army: { levies: { recruit: 0, soldier: 0 }, officers: [], lastPaidAt: now },
  })
  mkWar('westmarch', 'Westmarch', N)
  mkWar('eastmere', 'Eastmere', O)
}

await acheck('declaring war is single-sided: only the aggressor holds a mirror', async () => {
  const atk = db.data.empires['ironwall']
  const t0 = atk.treasury
  const notes0 = listNotifications(db, M).length
  const sends0 = sockSends
  const out = await run(war, L, 'declare Stonevale', 'war')
  assert.match(out, /WAR DECLARED/i)
  assert.strictEqual(atk.war.status, 'declared')
  assert.strictEqual(atk.war.role, 'aggressor')
  assert.strictEqual(atk.war.opponentId, 'stonevale')
  assert.strictEqual(db.data.empires['stonevale'].war, null, 'the defender holds NO mirror while merely declared')
  assert.strictEqual(atk.treasury, t0 - WAR_CONFIG.declareCostSolars, 'the muster is paid from the treasury')
  assert.strictEqual(listNotifications(db, M).length, notes0 + 1, 'exactly one notification to the target')
  assert.strictEqual(sockSends, sends0, 'declaring never calls sock.sendMessage')
})

await acheck('one war at a time: a second declaration is refused', async () => {
  const out = await run(war, L, 'declare Westmarch', 'war')
  assert.match(out, /already have a declaration/i)
  assert.strictEqual(db.data.empires['ironwall'].war.opponentId, 'stonevale', 'the first declaration stands')
})

await acheck('a declaration cannot target your own empire or a dormant one', async () => {
  const self = await run(war, M, 'declare Stonevale', 'war')
  assert.match(self, /your own empire/i)
  const sleeper = db.data.empires['eastmere']
  sleeper.dormant = true
  const out = await run(war, M, 'declare Eastmere', 'war')
  assert.match(out, /dormant/i)
  sleeper.dormant = false
})

await acheck('accepting turns BOTH mirrors active in one pass', async () => {
  const notes0 = listNotifications(db, L).length
  const out = await run(war, M, 'accept', 'war')
  assert.match(out, /WAR BEGUN/i)
  const atk = db.data.empires['ironwall'], def = db.data.empires['stonevale']
  assert.strictEqual(atk.war.status, 'active')
  assert.strictEqual(def.war.status, 'active', 'the defender mirror lands only now')
  assert.strictEqual(def.war.role, 'defender')
  assert.strictEqual(def.war.opponentId, 'ironwall')
  assert.strictEqual(listNotifications(db, L).length, notes0 + 1, 'exactly one notification to the aggressor')
})

// Freshly settle both sides so applyCollect nets ~0 and treasury deltas are pure spoils.
const freshen = (rec, t) => {
  for (const b of rec.buildings) b.lastCollectedAt = t
  rec.army.lastPaidAt = t
}

await acheck('a war round tallies on both mirrors, bleeds troops, fires ONE notification', async () => {
  const atk = db.data.empires['ironwall'], def = db.data.empires['stonevale']
  const t = Date.now()
  freshen(atk, t); freshen(def, t)
  atk.war.lastAttackAt = 0
  const head0 = armyHeadcount(atk)
  const notes0 = listNotifications(db, M).length
  const sends0 = sockSends
  const out = await run(war, L, 'attack', 'war')
  assert.match(out, /ROUND WON/i)
  assert.strictEqual(atk.war.myWins, 1)
  assert.strictEqual(atk.war.theirWins, 0)
  assert.strictEqual(def.war.theirWins, 1, 'the defender mirror sees the same round from the other side')
  assert.strictEqual(def.war.myWins, 0)
  assert.ok(armyHeadcount(atk) < head0, 'even the round winner bleeds troops')
  assert.strictEqual(listNotifications(db, M).length, notes0 + 1, 'exactly one notification to the opponent')
  assert.strictEqual(sockSends, sends0, 'a war round never calls sock.sendMessage')
})

await acheck('an attack on cooldown is refused', async () => {
  const out = await run(war, L, 'attack', 'war')
  assert.match(out, /regrouping/i)
  assert.strictEqual(db.data.empires['ironwall'].war.myWins, 1, 'the refused strike changed nothing')
})

await acheck('winning the war extracts capped tribute, razes a building, and vassalizes the loser', async () => {
  const atk = db.data.empires['ironwall'], def = db.data.empires['stonevale']
  const need = WAR_CONFIG.roundsToWin ?? 3
  let out = ''
  let atkT0 = 0, defT0 = 0, notes0 = 0
  const sends0 = sockSends
  for (let i = atk.war.myWins + 1; i <= need; i++) {
    const t = Date.now()
    freshen(atk, t); freshen(def, t)
    if (atk.war) atk.war.lastAttackAt = 0
    if (i === need) {
      atk.treasury = 100000
      def.treasury = 200000
      atkT0 = atk.treasury
      defT0 = def.treasury
      notes0 = listNotifications(db, M).length
    }
    out = await run(war, L, 'attack', 'war')
  }
  assert.match(out, /WAR WON/i)
  const now = Date.now()
  // Tribute is capped, moves defender -> attacker, and conserves exactly.
  const gained = atk.treasury - atkT0
  const paid = defT0 - def.treasury
  assert.strictEqual(gained, paid, 'every tribute solar taken left the loser')
  assert.strictEqual(gained, WAR_CONFIG.tributeHardCap, 'a fat treasury pays the capped tribute, not a share of everything')
  assert.strictEqual(def.buildings.find(b => b.type === 'solar_mine'), undefined, 'the razed building is gone for good')
  assert.strictEqual(atk.war, null, 'the war is over on the victor side')
  assert.strictEqual(def.war, null, 'and on the loser side')
  assert.strictEqual(def.vassalOf, 'ironwall', 'the loser is vassalized to the victor')
  assert.strictEqual(def.vassalOfName, 'Ironwall')
  assert.ok(isVassal(def, now), 'the vassalage is live')
  assert.ok(def.shieldUntil > now, 'the beaten loser is shielded while it rebuilds')
  assert.ok(atk.shieldUntil > now, 'the battered victor gets a short shield too')
  assert.strictEqual(atk.warLog[0].role, 'win')
  assert.strictEqual(def.warLog[0].role, 'loss')
  assert.strictEqual(def.warLog[0].tribute, gained, 'both logs record the same tribute')
  assert.strictEqual(listNotifications(db, M).length, notes0 + 1, 'the final round fires exactly one notification')
  assert.strictEqual(sockSends, sends0, 'ending a war never calls sock.sendMessage')
})

await acheck('a vassal cannot declare war until it is freed', async () => {
  const out = await run(war, M, 'declare Westmarch', 'war')
  assert.match(out, /vassal/i)
  assert.strictEqual(db.data.empires['stonevale'].war, null, 'no declaration was opened')
})

await acheck('a vassal empire is shown as subjugated on its dashboard', async () => {
  const out = await run(empire, M, '')
  assert.match(out, /Vassal/i)
})

await acheck('declining withdraws the aggressor\'s declaration, single-sided', async () => {
  const dec = await run(war, N, 'declare Eastmere', 'war')
  assert.match(dec, /WAR DECLARED/i)
  const notes0 = listNotifications(db, N).length
  const out = await run(war, O, 'decline', 'war')
  assert.match(out, /declines the war/i)
  assert.strictEqual(db.data.empires['westmarch'].war, null, 'the aggressor declaration is cleared')
  assert.strictEqual(db.data.empires['eastmere'].war, null, 'the decliner never held a mirror to clear')
  assert.strictEqual(listNotifications(db, N).length, notes0 + 1, 'exactly one notification to the aggressor')
})

await acheck('suing for peace clears both mirrors and BURNS the reparation', async () => {
  await run(war, N, 'declare Eastmere', 'war')
  await run(war, O, 'accept', 'war')
  const atk = db.data.empires['westmarch'], def = db.data.empires['eastmere']
  const t = Date.now()
  freshen(atk, t); freshen(def, t)
  atk.treasury = 100000
  def.treasury = 100000
  const atkT0 = atk.treasury, defT0 = def.treasury
  const notes0 = listNotifications(db, O).length
  const sends0 = sockSends
  const out = await run(war, N, 'peace', 'war')
  assert.match(out, /PEACE/i)
  assert.strictEqual(atk.war, null)
  assert.strictEqual(def.war, null)
  assert.strictEqual(atkT0 - atk.treasury, WAR_CONFIG.peaceCostSolars, 'the suer pays the reparation')
  assert.strictEqual(def.treasury, defT0, 'the reparation is burned, never transferred to the foe')
  const now = Date.now()
  assert.ok(atk.shieldUntil > now && def.shieldUntil > now, 'both sides stand down under a shield')
  assert.strictEqual(listNotifications(db, O).length, notes0 + 1, 'exactly one notification to the other party')
  assert.strictEqual(sockSends, sends0, 'peace never calls sock.sendMessage')
})

await acheck('.war status self-clears a lapsed declaration', async () => {
  const now = Date.now()
  const rec = db.data.empires['westmarch']
  rec.war = {
    opponentId: 'eastmere', opponentName: 'Eastmere', status: 'declared', role: 'aggressor',
    myWins: 0, theirWins: 0,
    declaredAt: now - 2 * DAY_MS, acceptWindowUntil: now - DAY_MS,
    startedAt: null, lastAttackAt: null,
  }
  const out = await run(war, N, 'status', 'war')
  assert.match(out, /lapsed/i)
  assert.strictEqual(db.data.empires['westmarch'].war, null, 'the stale single-sided declaration is cleared')
})

// ── 2h. Selling and buying an empire ─────────────────────────────────────────
console.log('\nSale & buyout')

{
  const now = Date.now()
  makePlayer(P, 'Pia', 0)
  makePlayer(Q, 'Quin', 5000000)
  const rec = ensureEmpireShape({
    id: 'goldkeep', name: 'Goldkeep', ownerId: P,
    fame: 400000, treasury: 80000, foundedAt: now, lastActiveAt: now,
    buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now }],
    army: { levies: { recruit: 20, soldier: 0 }, officers: [], lastPaidAt: now },
  })
  db.data.empires['goldkeep'] = rec
  db.data.users[P].empireId = 'goldkeep'
  db.data.users[P].empireRole = 'owner'
}

await acheck('a price outside the allowed band is refused', async () => {
  const out = await run(empire, P, `sell ${(SELL_CONFIG.minPrice ?? 1000) - 1}`)
  assert.match(out, /between/i)
  assert.strictEqual(db.data.empires['goldkeep'].sellListing, null, 'a rejected price lists nothing')
})

await acheck('listing an empire records the asking price and shows it on the dashboard', async () => {
  const out = await run(empire, P, 'sell 40000')
  assert.match(out, /for sale/i)
  const listing = db.data.empires['goldkeep'].sellListing
  assert.strictEqual(listing.price, 40000)
  const info = await run(empire, P, '')
  assert.match(info, /For sale/i, 'the dashboard advertises the listing')
})

await acheck('a buyout moves ownership, debits the buyer, pays the seller net of the burn', async () => {
  const rec = db.data.empires['goldkeep']
  const price = rec.sellListing.price
  const burnPct = SELL_CONFIG.burnPct ?? 0
  const proceeds = Math.floor(price * (1 - burnPct))
  const buyer0 = db.data.users[Q].wallet.solars
  const seller0 = db.data.users[P].wallet.solars
  const treasury0 = rec.treasury
  const notes0 = listNotifications(db, P).length
  const sends0 = sockSends

  const out = await run(empire, Q, 'buyout Goldkeep')
  assert.match(out, /ruler of Goldkeep/i)
  // Ownership: exactly one owner, and the seller is left with nothing sworn.
  assert.strictEqual(db.data.empires['goldkeep'].ownerId, Q, 'the record changes hands')
  assert.strictEqual(db.data.users[Q].empireId, 'goldkeep')
  assert.strictEqual(db.data.users[Q].empireRole, 'owner')
  assert.strictEqual(db.data.users[P].empireId, null, 'the seller no longer belongs to it')
  assert.strictEqual(db.data.users[P].empireRole, null)
  assert.strictEqual(getOwnedEmpire(db, P), null, 'the seller rules nothing now')
  // Money: the buyer's wallet paid the full price, the seller banked the net,
  // and the difference is exactly the burn (never silently pocketed anywhere).
  assert.strictEqual(buyer0 - db.data.users[Q].wallet.solars, price, 'the buyer pays the full asking price')
  assert.strictEqual(db.data.users[P].wallet.solars - seller0, proceeds, 'the seller banks the price minus the cut')
  assert.strictEqual(price - proceeds, price - Math.floor(price * (1 - burnPct)), 'the shortfall is exactly the burn')
  assert.strictEqual(db.data.empires['goldkeep'].treasury, treasury0, 'the treasury travels with the empire, untouched')
  assert.strictEqual(db.data.empires['goldkeep'].sellListing, null, 'the listing is consumed')
  assert.strictEqual(listNotifications(db, P).length, notes0 + 1, 'exactly one notification to the seller')
  assert.strictEqual(sockSends, sends0, 'a buyout never calls sock.sendMessage')
})

await acheck('a player who already rules cannot buy a second empire', async () => {
  await run(empire, Q, 'sell 40000')
  const out = await run(empire, L, 'buyout Goldkeep') // L rules Ironwall
  assert.match(out, /already rule/i)
  assert.strictEqual(db.data.empires['goldkeep'].ownerId, Q, 'ownership is unchanged')
  await run(empire, Q, 'sell cancel')
  assert.strictEqual(db.data.empires['goldkeep'].sellListing, null)
})

await acheck('an unlisted empire cannot be bought', async () => {
  makePlayer(R, 'Rae', 5000000)
  const out = await run(empire, R, 'buyout Goldkeep')
  assert.match(out, /not for sale/i)
  assert.ok(!db.data.users[R].empireId, 'the would-be buyer of an unlisted empire gains nothing')
})

await acheck('an empire at war cannot be listed for sale', async () => {
  const rec = db.data.empires['goldkeep']
  rec.war = {
    opponentId: 'ironwall', opponentName: 'Ironwall', status: 'active', role: 'defender',
    myWins: 0, theirWins: 0, declaredAt: Date.now(), acceptWindowUntil: null,
    startedAt: Date.now(), lastAttackAt: null,
  }
  const out = await run(empire, Q, 'sell 40000')
  assert.match(out, /at war/i)
  assert.strictEqual(rec.sellListing, null, 'a contested empire is never listed')
  rec.war = null
})

// ── 2i. Lifecycle: dormancy, succession, dissolution ─────────────────────────
console.log('\nLifecycle')

{
  const now = Date.now()
  makePlayer(S, 'Sol', 0)
  makePlayer(T, 'Tam', 0)
  makePlayer(U, 'Uma', 0)
  const mkOld = (id, name, ownerId, idleDays, over = {}) => {
    const rec = ensureEmpireShape({
      id, name, ownerId, fame: 500000, treasury: 10000,
      foundedAt: now - 400 * DAY_MS, lastActiveAt: now - idleDays * DAY_MS,
      buildings: [{ type: 'solar_mine', level: 1, lastCollectedAt: now }],
      ...over,
    })
    db.data.empires[id] = rec
    if (db.data.users[ownerId]) {
      db.data.users[ownerId].empireId = id
      db.data.users[ownerId].empireRole = 'owner'
    }
    return rec
  }
  // Just past dormancy, nowhere near succession.
  mkOld('sleepyhold', 'Sleepyhold', S, (LIFECYCLE_CONFIG.dormancyDays ?? 21) + 1)
  // Long abandoned, with two citizens waiting: the senior one inherits.
  mkOld('oldreign', 'Oldreign', T, (LIFECYCLE_CONFIG.successionDays ?? 45) + 1)
  db.data.users['heir@w'] = { id: 'heir@w', name: 'Heir', empireId: 'oldreign', empireRole: 'citizen', empireJoinedAt: now - 300 * DAY_MS }
  db.data.users['junior@w'] = { id: 'junior@w', name: 'Junior', empireId: 'oldreign', empireRole: 'citizen', empireJoinedAt: now - 10 * DAY_MS }
  // Long abandoned with nobody left: it dissolves.
  mkOld('lastlight', 'Lastlight', U, (LIFECYCLE_CONFIG.successionDays ?? 45) + 1)
  // Long idle but actively being fought over: never aged.
  mkOld('warhold', 'Warhold', null, (LIFECYCLE_CONFIG.successionDays ?? 45) + 1, {
    ownerId: 'absent@w',
    war: {
      opponentId: 'ironwall', opponentName: 'Ironwall', status: 'active', role: 'defender',
      myWins: 0, theirWins: 0, declaredAt: now, acceptWindowUntil: null, startedAt: now, lastAttackAt: null,
    },
  })
  db.data.users['absent@w'] = { id: 'absent@w', name: 'Absent', empireId: 'warhold', empireRole: 'owner' }
}

check('empireNeedsSweep spots stale empires but spares the caller\'s own', () => {
  const now = Date.now()
  assert.strictEqual(empireNeedsSweep(db, now), true, 'there are stale empires to age')
  // With only the stale owners excepted one at a time, the others still trigger.
  assert.strictEqual(empireNeedsSweep(db, now, T), true, 'excepting one owner does not hide the others')
  const solo = { data: { users: {}, empires: { a: ensureEmpireShape({ id: 'a', ownerId: 'z', lastActiveAt: now - 100 * DAY_MS }) } } }
  assert.strictEqual(empireNeedsSweep(solo, now), true)
  assert.strictEqual(empireNeedsSweep(solo, now, 'z'), false, 'the caller\'s own empire is never swept by their own command')
})

check('empireNeedsSweep stays false once everything stale has been aged', () => {
  const now = Date.now()
  const settled = {
    data: {
      users: {},
      empires: {
        fresh: ensureEmpireShape({ id: 'fresh', ownerId: 'a', lastActiveAt: now }),
        // Already flagged, and not yet at succession: nothing left to change.
        napping: ensureEmpireShape({ id: 'napping', ownerId: 'b', lastActiveAt: now - 30 * DAY_MS, dormant: true }),
      },
    },
  }
  assert.strictEqual(empireNeedsSweep(settled, now), false, 'an already-dormant empire does not re-trigger the sweep')
})

await acheck('the sweep flags dormancy, hands down succession, and dissolves the heirless', async () => {
  const summary = await sweepEmpireLifecycle(db, Date.now())
  assert.ok(summary.dormant >= 1, `at least one empire went dormant, saw ${summary.dormant}`)
  assert.ok(summary.succeeded >= 1, `at least one throne passed, saw ${summary.succeeded}`)
  assert.ok(summary.dissolved >= 1, `at least one empire dissolved, saw ${summary.dissolved}`)
})

check('a merely dormant empire is flagged but otherwise untouched', () => {
  const rec = db.data.empires['sleepyhold']
  assert.ok(rec, 'a dormant empire is not deleted')
  assert.strictEqual(rec.dormant, true, 'it is flagged as sleeping')
  assert.strictEqual(rec.ownerId, S, 'its ruler keeps the throne')
  assert.strictEqual(db.data.users[S].empireId, 'sleepyhold', 'and their membership stands')
})

check('succession passes the throne to the most senior citizen', () => {
  const rec = db.data.empires['oldreign']
  assert.ok(rec, 'a succeeded empire survives')
  assert.strictEqual(rec.ownerId, 'heir@w', 'the longest-serving citizen inherits')
  assert.strictEqual(db.data.users['heir@w'].empireRole, 'owner')
  assert.strictEqual(db.data.users['junior@w'].empireRole, 'citizen', 'the junior citizen keeps their seat')
  assert.strictEqual(db.data.users[T].empireId, null, 'the absent ruler is released')
  assert.strictEqual(db.data.users[T].empireRole, null)
  assert.strictEqual(rec.dormant, false, 'a fresh reign is not born asleep')
  assert.ok(rec.lastActiveAt > Date.now() - 5 * 60 * 1000, 'the new reign is stamped so it is not aged again at once')
})

check('an heirless abandoned empire dissolves and frees its members', () => {
  assert.strictEqual(db.data.empires['lastlight'], undefined, 'the record is gone')
  assert.strictEqual(db.data.users[U].empireId, null, 'its ruler is released')
  assert.strictEqual(db.data.users[U].empireRole, null)
})

check('an empire in an active war is never aged out from under the fight', () => {
  const rec = db.data.empires['warhold']
  assert.ok(rec, 'a contested empire survives the sweep')
  assert.strictEqual(rec.dormant, false, 'and is not even flagged dormant')
  assert.strictEqual(rec.ownerId, 'absent@w', 'its owner is untouched mid-war')
})

await acheck('a dormant empire drops off the travel map', async () => {
  const out = await run(travel, I, '', 'travel')
  assert.ok(!/Sleepyhold/.test(out), 'a sleeping empire is not advertised to travelers')
  assert.match(out, /Havenreach/, 'a live empire still is')
})

await acheck('acting on a dormant empire wakes it back up', async () => {
  const out = await run(empire, S, 'sell cancel')
  assert.match(out, /Sleepyhold/)
  assert.strictEqual(db.data.empires['sleepyhold'].dormant, false, 'the ruler acting clears the flag')
})

// ── 2j. Season roll decays empire prestige ───────────────────────────────────
console.log('\nSeason decay')

await acheck('ending a season trims every empire\'s fame and treasury', async () => {
  const rec = db.data.empires['ironwall']
  const fame0 = rec.fame, treasury0 = rec.treasury
  const expectedFameLost = Math.floor(fame0 * LIFECYCLE_CONFIG.decayFamePct)
  const expectedTreasuryLost = Math.floor(treasury0 * LIFECYCLE_CONFIG.decayTreasuryPct)
  db.data.seasonRuntime = { activeSeasonId: seasons[0].id }
  const sends0 = sockSends

  const res = await endSeason(db, Date.now())
  assert.strictEqual(res.ended, true, 'the season closed')
  assert.strictEqual(rec.fame, fame0 - expectedFameLost, 'empire prestige decays on the roll')
  assert.strictEqual(rec.treasury, treasury0 - expectedTreasuryLost, 'and so does the hoard')
  assert.strictEqual(rec.tierId, tierForFame(rec.fame).id, 'the tier is re-seated from the trimmed fame')
  assert.ok(res.empiresDecayed >= 1, 'the roll reports how many empires it trimmed')
  assert.strictEqual(res.fameDecayed >= expectedFameLost, true, 'the reported fame loss covers this empire')
  const entry = db.data.seasonHistory[db.data.seasonHistory.length - 1]
  assert.strictEqual(entry.empiresDecayed, res.empiresDecayed, 'the history entry records the decay')
  assert.ok('fameDecayed' in entry && 'treasuryDecayed' in entry, 'with both totals')
  assert.strictEqual(sockSends, sends0, 'a season roll never calls sock.sendMessage')
})

// ── 2b. Treasury sharing, stash, and single-officer promotion ────────────────
console.log('\nTreasury / stash / officer promote')

check('applyPromoteOfficer advances one officer and charges the reported unit cost', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', treasury: 100000,
    warehouse: { iron: 100, steel: 100 },
    army: { levies: {}, officers: [{ name: 'Rurik', rank: 'veteran', xp: 0 }] },
  })
  const t0 = rec.treasury
  const iron0 = rec.warehouse.iron
  const res = applyPromoteOfficer(rec, 1)
  assert.ok(res.ok, 'the promotion should succeed')
  assert.strictEqual(res.toRank, 'knight')
  assert.strictEqual(rec.army.officers[0].rank, 'knight', 'the officer is now a knight')
  assert.ok(res.unitCost.solars > 0, 'a unit cost is reported')
  assert.strictEqual(rec.treasury, t0 - res.unitCost.solars, 'treasury drops by exactly the reported solars')
  assert.strictEqual(rec.warehouse.iron, iron0 - (res.unitCost.materials?.iron ?? 0), 'materials come out of the warehouse')
})

check('applyPromoteOfficer refuses a warlord (already at the top rank)', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', treasury: 1e9, warehouse: { steel: 1000 },
    army: { levies: {}, officers: [{ name: 'Kael', rank: 'warlord', xp: 0 }] },
  })
  const res = applyPromoteOfficer(rec, 1)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'maxed')
})

check('applyPromoteOfficer rejects an out-of-range officer number', () => {
  const rec = ensureEmpireShape({ ownerId: 'x', treasury: 1e9, army: { levies: {}, officers: [] } })
  assert.strictEqual(applyPromoteOfficer(rec, 1).reason, 'nooff')
  const rec2 = ensureEmpireShape({ ownerId: 'x', treasury: 1e9, army: { levies: {}, officers: [{ name: 'Solo', rank: 'veteran', xp: 0 }] } })
  assert.strictEqual(applyPromoteOfficer(rec2, 9).reason, 'nooff')
})

check('applyPromoteOfficer refuses when the empire cannot afford it', () => {
  const rec = ensureEmpireShape({
    ownerId: 'x', treasury: 0, warehouse: {},
    army: { levies: {}, officers: [{ name: 'Poorvik', rank: 'veteran', xp: 0 }] },
  })
  const res = applyPromoteOfficer(rec, 1)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'poor')
  assert.strictEqual(rec.army.officers[0].rank, 'veteran', 'a refused promotion leaves the rank untouched')
})

check('ensureConflictShape shapes and sanitizes the stash', () => {
  const r = ensureConflictShape({
    stash: {
      materials: { wood: 5, stone: -3, iron: 0 },
      items: [
        { id: 'iron_helm', name: 'Iron Helm', qty: 2, madeBy: 'Bjorn' },
        { id: 'ghost', qty: 0 },   // dropped: non-positive qty
        { name: 'nameless' },      // dropped: no id
      ],
    },
  })
  assert.strictEqual(r.stash.materials.wood, 5)
  assert.ok(!('stone' in r.stash.materials), 'a negative material qty is dropped')
  assert.ok(!('iron' in r.stash.materials), 'a zero material qty is dropped')
  assert.strictEqual(r.stash.items.length, 1, 'only the valid item survives')
  assert.strictEqual(r.stash.items[0].madeBy, 'Bjorn')
  const empty = ensureConflictShape({})
  assert.deepStrictEqual(empty.stash.materials, {})
  assert.deepStrictEqual(empty.stash.items, [])
})

// A fresh ruler with deterministic books, isolated from the A..U cast above.
const DEP = '313131@s.whatsapp.net'
const NOMAD = '323232@s.whatsapp.net'

await acheck('deposit moves solars from the wallet into the treasury', async () => {
  makePlayer(DEP, 'Vaultkeeper', 120000)
  await run(empire, DEP, 'found Vaultspire')
  const t0 = getOwnedEmpire(db, DEP).treasury
  const w0 = db.data.users[DEP].wallet.solars   // 120000 - foundCost
  const out = await run(empire, DEP, 'deposit 20000')
  assert.match(out, /Deposited/i)
  assert.strictEqual(db.data.users[DEP].wallet.solars, w0 - 20000)
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, t0 + 20000)
})

await acheck('deposit all empties the wallet into the treasury', async () => {
  const w = db.data.users[DEP].wallet.solars
  const t = getOwnedEmpire(db, DEP).treasury
  const out = await run(empire, DEP, 'deposit all')
  assert.match(out, /Deposited/i)
  assert.strictEqual(db.data.users[DEP].wallet.solars, 0)
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, t + w)
})

await acheck('deposit is rejected when the wallet cannot cover it', async () => {
  const out = await run(empire, DEP, 'deposit 5000')   // wallet is 0 now
  assert.match(out, /only have/i)
})

await acheck('withdraw returns treasury solars to the wallet, clamped to what is banked', async () => {
  const t = getOwnedEmpire(db, DEP).treasury
  const out = await run(empire, DEP, 'withdraw 999999999')
  assert.match(out, /Withdrew/i)
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, 0, 'over-withdraw empties, never overdraws')
  assert.strictEqual(db.data.users[DEP].wallet.solars, t, 'the whole banked treasury lands in the wallet')
})

await acheck('a player who rules no empire cannot deposit', async () => {
  makePlayer(NOMAD, 'Nomad', 5000)
  const out = await run(empire, NOMAD, 'deposit 100')
  assert.match(out, /rule an empire/i)
  assert.strictEqual(db.data.users[NOMAD].wallet.solars, 5000, 'a rejected deposit takes nothing')
})

await acheck('stash reads empty for a fresh empire and never touches the socket', async () => {
  const sends0 = sockSends
  const out = await run(empire, DEP, 'stash')
  assert.match(out, /STASH/i)
  assert.match(out, /empty for now/i)
  assert.strictEqual(sockSends, sends0, 'viewing the stash never calls sock.sendMessage')
})

await acheck('the .stash plugin lands on the same empire stash screen', async () => {
  const out = await run(stash, DEP, '')
  assert.match(out, /STASH · Vaultspire/i)
})

await acheck('.empire online shows who lives here: the ruler, sworn players, and townsfolk', async () => {
  const sends0 = sockSends
  const rec = getOwnedEmpire(db, DEP)
  rec.npcs = 0 // a fresh capital: nobody has moved in yet
  const out = await run(empire, DEP, 'online')
  assert.match(out, /WHO LIVES IN Vaultspire/i, 'the roster is headed by the empire name')
  assert.match(out, /People:/i, 'it shows the population against the cap')
  assert.match(out, /sworn/i, 'and splits the headcount into sworn players and townsfolk')
  assert.match(out, /No townsfolk yet/i, 'an empty capital invites you to build homes so folk can move in')
  assert.strictEqual(sockSends, sends0, 'the roster view never calls sock.sendMessage')
})

await acheck('.empire online counts the townsfolk once they have moved in', async () => {
  getOwnedEmpire(db, DEP).npcs = 40
  const out = await run(empire, DEP, 'online')
  assert.match(out, /40 townsfolk/i, 'the townsfolk headcount is shown')
  assert.match(out, /live and work here/i, 'and reads as living residents, not the empty-capital prompt')
})

await acheck('the .em-online plugin lands on the same roster view', async () => {
  const out = await run(emOnline, DEP, '')
  assert.match(out, /WHO LIVES IN Vaultspire/i)
})

// ── 2k. Stash + blacksmith plugin (forge, drop, take, and sharing via .tp) ───
console.log('\nStash + blacksmith plugin')

// DEP still rules Vaultspire: drained treasury, empty stash, no buildings. Seed
// a working forge and stash materials directly, then drive the real commands.
await acheck('forging is refused before any blacksmith is built', async () => {
  const out = await run(empire, DEP, 'forge t_sword_1')
  assert.match(out, /no blacksmith/i)
})

await acheck('the forge browser lists what the smith can make and hides work above its rank', async () => {
  const rec = getOwnedEmpire(db, DEP)
  rec.buildings.push({ type: 'blacksmith', level: 1, lastCollectedAt: Date.now() })
  rec.treasury = 5000
  rec.stash.materials = { iron_ore: 6, wood_plank: 6 }
  const out = await run(empire, DEP, 'forge')
  assert.match(out, /FORGE · Vaultspire/i)
  assert.match(out, /Training Sword/, 'a common recipe is on the list')
  assert.ok(!/Titanium Blade/.test(out), 'epic work is above a level-1 forge and is hidden')
})

await acheck('forging draws stash materials and the treasury fee, and tags the piece with its smith', async () => {
  const rec = getOwnedEmpire(db, DEP)
  const ore0 = rec.stash.materials.iron_ore
  const plank0 = rec.stash.materials.wood_plank
  const t0 = rec.treasury
  const sends0 = sockSends
  const out = await run(empire, DEP, 'forge t_sword_1')
  assert.match(out, /forged/i)
  assert.match(out, /Training Sword/)
  const rec2 = getOwnedEmpire(db, DEP)
  assert.strictEqual(rec2.stash.materials.iron_ore, ore0 - 1, 'the recipe ore is spent from the stash')
  assert.strictEqual(rec2.stash.materials.wood_plank, plank0 - 1, 'the recipe plank is spent from the stash')
  assert.strictEqual(rec2.treasury, t0 - 30, 'the forge fee leaves the treasury')
  const stack = rec2.stash.items.find(it => it.id === 't_sword_1')
  assert.ok(stack && stack.qty === 1, 'the finished piece rests in the stash')
  assert.ok(stack.madeBy && typeof stack.madeBy === 'string', 'it carries the name of the smith who made it')
  assert.strictEqual(rec2.blacksmith.smithName, stack.madeBy, 'the resident smith was hired and named on the first forge')
  assert.strictEqual(sockSends, sends0, 'forging never calls sock.sendMessage')
})

await acheck('forge refuses gear above the forge rank, in plain words, and makes nothing', async () => {
  const rec = getOwnedEmpire(db, DEP)
  const items0 = JSON.stringify(rec.stash.items)
  const out = await run(empire, DEP, 'forge t_sword_4') // Titanium Blade, epic
  assert.match(out, /cannot make|cannot forge/i)
  assert.match(out, /epic/i, 'it names the rarity that is out of reach')
  assert.strictEqual(JSON.stringify(getOwnedEmpire(db, DEP).stash.items), items0, 'a refused forge changes the stash not at all')
})

await acheck('forge refuses a recipe the stash cannot supply, and names the shortfall', async () => {
  const rec = getOwnedEmpire(db, DEP)
  rec.stash.materials = {} // strip the stash bare
  const out = await run(empire, DEP, 'forge t_sword_1')
  assert.match(out, /missing/i)
  assert.match(out, /iron/i, 'the missing material is named')
})

await acheck('drop moves a material from the bag into the stash', async () => {
  db.data.users[DEP].inventory = ['iron_ore', 'iron_ore', 'iron_ore']
  const stash0 = getOwnedEmpire(db, DEP).stash.materials.iron_ore ?? 0
  const out = await run(empire, DEP, 'drop iron_ore 2')
  assert.match(out, /Dropped/i)
  assert.strictEqual(getOwnedEmpire(db, DEP).stash.materials.iron_ore, stash0 + 2, 'two ore land in the stash')
  assert.strictEqual(db.data.users[DEP].inventory.filter(x => x === 'iron_ore').length, 1, 'and leave the bag')
})

await acheck('dropping gear stacks it untagged (no maker), unlike forged work', async () => {
  db.data.users[DEP].inventory.push('t_sword_2')
  const out = await run(empire, DEP, 'drop t_sword_2')
  assert.match(out, /Dropped/i)
  const entry = getOwnedEmpire(db, DEP).stash.items.find(it => it.id === 't_sword_2')
  assert.ok(entry, 'the dropped gear is on the stash pile')
  assert.strictEqual(entry.madeBy, null, 'dropped loot has no maker')
})

await acheck('take moves a stash material back into the bag', async () => {
  const stash0 = getOwnedEmpire(db, DEP).stash.materials.iron_ore
  db.data.users[DEP].inventory = []
  const out = await run(empire, DEP, 'take iron_ore 1')
  assert.match(out, /Took/i)
  assert.strictEqual(getOwnedEmpire(db, DEP).stash.materials.iron_ore, stash0 - 1)
  assert.strictEqual(db.data.users[DEP].inventory.filter(x => x === 'iron_ore').length, 1, 'the ore is in the bag')
})

await acheck('taking a forged piece deposits the bare id and points at equip', async () => {
  db.data.users[DEP].inventory = []
  const out = await run(empire, DEP, 'take t_sword_1')
  assert.match(out, /Took/i)
  assert.match(out, /equip t_sword_1/i, 'gear taken from the stash can be equipped')
  assert.ok(db.data.users[DEP].inventory.includes('t_sword_1'), 'the bare id lands in the bag')
})

await acheck('the .stash plugin drops through the very same handlers', async () => {
  db.data.users[DEP].inventory = ['wood_plank', 'wood_plank']
  const plank0 = getOwnedEmpire(db, DEP).stash.materials.wood_plank ?? 0
  const out = await run(stash, DEP, 'drop wood_plank 2')
  assert.match(out, /Dropped/i)
  assert.strictEqual(getOwnedEmpire(db, DEP).stash.materials.wood_plank, plank0 + 2)
})

await acheck('a ruler invites a guest to the stash via .tp, no broadcast', async () => {
  const sends0 = sockSends
  const out = await run(empire, DEP, 'tp 323232') // NOMAD's number
  assert.match(out, /may now use/i)
  assert.ok(getOwnedEmpire(db, DEP).stash.invited.includes(NOMAD), 'the guest is on the invite list')
  assert.strictEqual(sockSends, sends0, 'inviting never calls sock.sendMessage')
})

await acheck('an invited guest may both drop into and take from the shared stash', async () => {
  db.data.users[NOMAD].inventory = ['iron_ore']
  const drop = await run(stash, NOMAD, 'drop iron_ore')
  assert.match(drop, /Dropped/i, 'the guest can contribute')
  const take = await run(stash, NOMAD, 'take iron_ore 1')
  assert.match(take, /Took/i, 'and the guest can take, like a shared chest')
})

await acheck('.tp remove revokes a guest, who then has no stash to reach', async () => {
  const out = await run(tp, DEP, 'remove 323232')
  assert.match(out, /Revoked/i)
  assert.ok(!getOwnedEmpire(db, DEP).stash.invited.includes(NOMAD), 'the guest is off the list')
  const denied = await run(stash, NOMAD, 'take iron_ore')
  assert.match(denied, /no stash to take from/i, 'a revoked guest is a stranger to the stash again')
})

await acheck('only a ruler may command the forge or share the stash', async () => {
  const forge = await run(empire, NOMAD, 'forge t_sword_1') // NOMAD rules nothing
  assert.match(forge, /rule an empire/i, 'no empire, no forge')
  const invite = await run(empire, NOMAD, 'tp 313131')
  assert.match(invite, /Only a ruler/i, 'no empire, no invites')
})

await acheck('a sworn citizen may drop into the stash but is barred from taking', async () => {
  db.data.users[NOMAD].empireId = 'vaultspire'
  db.data.users[NOMAD].empireRole = 'citizen'
  db.data.users[NOMAD].inventory = ['wood_plank']
  const drop = await run(stash, NOMAD, 'drop wood_plank')
  assert.match(drop, /Dropped/i, 'a citizen can stock the shared store')
  const take = await run(stash, NOMAD, 'take wood_plank')
  assert.match(take, /Only the ruler and invited guests/i, 'but cannot quietly drain it')
  db.data.users[NOMAD].empireId = null
  db.data.users[NOMAD].empireRole = null
})

// ── 2l. Empire bank plugin (Phase 7): .empire bank deposit / withdraw ─────────
console.log('\nEmpire bank plugin')

const dayTax = Math.floor(100000 * bankTaxRatePerDay()) // one clamped day on 100k

await acheck('the bank is refused until a bank building is raised', async () => {
  // DEP rules Vaultspire but has only a blacksmith so far, no bank.
  const out = await run(empire, DEP, 'bank')
  assert.match(out, /no bank yet/i)
})

await acheck('a bare .empire bank prints a statement and never broadcasts', async () => {
  const rec = getOwnedEmpire(db, DEP)
  rec.buildings.push({ type: 'bank', level: 1, lastCollectedAt: Date.now() })
  rec.treasury = 0
  rec.bank = { accounts: {}, taxCollected: 0 }
  db.data.users[DEP].wallet.solars = 100000
  const sends0 = sockSends
  const out = await run(empire, DEP, 'bank')
  assert.match(out, /Bank of Vaultspire/i)
  assert.match(out, /balance/i)
  assert.strictEqual(sockSends, sends0, 'reading the bank never calls sock.sendMessage')
})

await acheck('depositing moves wallet solars into a personal account, untaxed while fresh', async () => {
  const out = await run(empire, DEP, 'bank deposit 40000')
  assert.match(out, /Banked/i)
  assert.strictEqual(db.data.users[DEP].wallet.solars, 60000, 'the wallet is debited')
  const rec = getOwnedEmpire(db, DEP)
  assert.strictEqual(rec.bank.accounts[DEP].balance, 40000, 'the account holds the deposit')
  assert.strictEqual(bankHeld(rec), 40000)
  assert.strictEqual(rec.treasury, 0, 'a brand new deposit is taxed nothing')
})

await acheck('deposit all sweeps the rest of the wallet into the account', async () => {
  const out = await run(empire, DEP, 'bank deposit all')
  assert.match(out, /Banked/i)
  assert.strictEqual(db.data.users[DEP].wallet.solars, 0, 'the wallet is emptied')
  assert.strictEqual(getOwnedEmpire(db, DEP).bank.accounts[DEP].balance, 100000)
})

await acheck('the statement shows the pending maintenance tax without charging it', async () => {
  getOwnedEmpire(db, DEP).bank.accounts[DEP].lastTaxAt = Date.now() - 2 * DAY_MS
  const out = await run(empire, DEP, 'bank')
  assert.match(out, /Maintenance tax due/i)
  const rec = getOwnedEmpire(db, DEP)
  assert.strictEqual(rec.bank.accounts[DEP].balance, 100000, 'the statement settled nothing')
  assert.strictEqual(rec.treasury, 0, 'and credited the treasury nothing')
})

await acheck('withdrawing settles the maintenance tax first, then pays out', async () => {
  const out = await run(empire, DEP, 'bank withdraw 50000')
  assert.match(out, /Withdrew/i)
  assert.match(out, /Maintenance tax settled first/i, 'the tax note is surfaced')
  const rec = getOwnedEmpire(db, DEP)
  assert.strictEqual(rec.treasury, dayTax, 'the clamped daily tax reached the treasury')
  assert.strictEqual(rec.bank.accounts[DEP].balance, 100000 - dayTax - 50000, 'tax then withdrawal leave the balance')
  assert.strictEqual(db.data.users[DEP].wallet.solars, 50000, 'the withdrawal reached the wallet')
})

await acheck('withdraw all empties the account back into the wallet', async () => {
  const rec0 = getOwnedEmpire(db, DEP)
  const bal = rec0.bank.accounts[DEP].balance
  const w0 = db.data.users[DEP].wallet.solars
  const out = await run(empire, DEP, 'bank withdraw all')
  assert.match(out, /Withdrew/i)
  assert.strictEqual(db.data.users[DEP].wallet.solars, w0 + bal, 'the whole balance came home')
  assert.strictEqual(previewBankAccount(getOwnedEmpire(db, DEP), DEP).balance, 0)
})

await acheck('withdrawing from an empty account says so plainly', async () => {
  const out = await run(empire, DEP, 'bank withdraw 100')
  assert.match(out, /nothing banked/i)
})

await acheck('a sworn citizen keeps their own account in the realm bank', async () => {
  db.data.users[NOMAD].empireId = 'vaultspire'
  db.data.users[NOMAD].empireRole = 'citizen'
  db.data.users[NOMAD].wallet.solars = 5000
  const sends0 = sockSends
  const out = await run(empire, NOMAD, 'bank deposit 1000')
  assert.match(out, /Banked/i)
  assert.strictEqual(db.data.users[NOMAD].wallet.solars, 4000, 'the citizen wallet is debited')
  const rec = getOwnedEmpire(db, DEP)
  assert.strictEqual(rec.bank.accounts[NOMAD].balance, 1000, 'a citizen banks under their own jid')
  assert.strictEqual(sockSends, sends0, 'banking never calls sock.sendMessage')
  db.data.users[NOMAD].empireId = null
  db.data.users[NOMAD].empireRole = null
})

await acheck('someone with no realm and no citizenship has no bank to use', async () => {
  const out = await run(empire, NOMAD, 'bank')
  assert.match(out, /no realm to bank with/i)
})

await acheck('collect surfaces the bank maintenance tax and sweeps it into the treasury', async () => {
  const rec = getOwnedEmpire(db, DEP)
  rec.bank = { accounts: {}, taxCollected: 0 }
  rec.treasury = 0
  db.data.users[DEP].wallet.solars = 200000
  await run(empire, DEP, 'bank deposit 100000')
  // Freeze buildings and population so the bank tax is the only event this collect sees.
  const t = Date.now()
  for (const b of rec.buildings) b.lastCollectedAt = t
  rec.lastPopAt = t; rec.lastCivicAt = t; rec.npcs = 0
  rec.bank.accounts[DEP].lastTaxAt = t - 2 * DAY_MS
  const out = await run(empire, DEP, 'collect')
  assert.match(out, /bank maintenance tax/i, 'the collect reply calls out the swept tax')
  const rec2 = getOwnedEmpire(db, DEP)
  assert.strictEqual(rec2.bank.accounts[DEP].balance, 100000 - dayTax, 'the account paid the maintenance tax')
  assert.strictEqual(rec2.treasury, dayTax, 'and the treasury holds exactly that tax')
})

// ── Coffee house engine (Phase 8: walkable locations) ────────────────────────
console.log('\nCoffee house engine (Phase 8)')

check('the coffee menu loads and is sanitized', () => {
  const menu = coffeeMenu()
  assert.ok(menu.length >= 1, 'the board carries at least one drink')
  for (const d of menu) {
    assert.strictEqual(d.id, d.id.toLowerCase(), `${d.id} id is lowercased`)
    assert.ok(Number.isInteger(d.price) && d.price >= 0, `${d.id} price is a non-negative integer`)
    assert.ok(typeof d.name === 'string' && d.name.length > 0, `${d.id} has a name`)
  }
})

check('coffeeDrink resolves by id, name and partial, and misses cleanly', () => {
  const first = coffeeMenu()[0]
  assert.strictEqual(coffeeDrink(first.id)?.id, first.id, 'exact id')
  assert.strictEqual(coffeeDrink(first.name)?.id, first.id, 'exact name')
  assert.strictEqual(coffeeDrink(first.id.slice(0, -1))?.id, first.id, 'partial id')
  assert.strictEqual(coffeeDrink('definitely-not-a-drink'), null, 'unknown misses')
  assert.strictEqual(coffeeDrink(''), null, 'empty misses')
})

check('coffeeHouseBuilt tracks the building', () => {
  const bare = ensureEmpireShape({ ownerId: 'x', buildings: [] })
  assert.strictEqual(coffeeHouseBuilt(bare), false)
  const withCafe = ensureEmpireShape({ ownerId: 'x', buildings: [{ type: 'coffee_house', level: 1, lastCollectedAt: 0 }] })
  assert.strictEqual(coffeeHouseBuilt(withCafe), true)
})

console.log('\nCoffee house plugin (Phase 8)')

const WANDERER = '343434@s.whatsapp.net'
makePlayer(WANDERER, 'Wanderer', 0)

await acheck('order is refused until a coffee house is raised', async () => {
  // DEP rules Vaultspire (a blacksmith and a bank so far, no coffee house yet).
  const out = await run(coffee, DEP, '')
  assert.match(out, /no coffee house/i)
  assert.match(out, /empire build coffee_house/i, 'the owner is told how to raise one')
})

await acheck('goto lists the walkable places and starts you at the square', async () => {
  const sends0 = sockSends
  const out = await run(gotoPlugin, DEP, '')
  assert.match(out, /you're at the town square/i, 'you begin at the square')
  assert.match(out, /the market/i, 'the market is always walkable')
  assert.match(out, /the bank/i, 'the raised bank is listed')
  assert.ok(!/coffee house/i.test(out), 'no coffee house is listed before it is built')
  assert.strictEqual(sockSends, sends0, 'looking around never calls sock.sendMessage')
})

await acheck('goto to a place the realm lacks points the ruler at building it', async () => {
  const out = await run(gotoPlugin, DEP, 'barracks')
  assert.match(out, /has no barracks yet/i)
  assert.match(out, /empire build barracks/i, 'the owner is told how to raise it')
})

await acheck('goto walks you to a built place and records where you stand', async () => {
  const out = await run(gotoPlugin, DEP, 'forge')
  assert.match(out, /walk to the blacksmith/i)
  assert.match(out, /empire forge/i, 'the owner gets the forge command')
  assert.strictEqual(db.data.users[DEP].empireSpot, 'forge', 'your position is saved')
})

await acheck('a bare .order prints the drinks board once the coffee house is built', async () => {
  const rec = getOwnedEmpire(db, DEP)
  rec.buildings.push({ type: 'coffee_house', level: 1, lastCollectedAt: Date.now() })
  rec.treasury = 0
  db.data.users[DEP].wallet.solars = 10000
  const sends0 = sockSends
  const out = await run(coffee, DEP, '')
  assert.match(out, /Coffee House of Vaultspire/i)
  assert.match(out, /solars/i, 'prices are shown')
  assert.strictEqual(sockSends, sends0, 'reading the board never calls sock.sendMessage')
})

await acheck('goto coffee now walks you to the counter', async () => {
  const out = await run(gotoPlugin, DEP, 'coffee')
  assert.match(out, /walk to the coffee house/i)
  assert.strictEqual(db.data.users[DEP].empireSpot, 'coffee')
})

await acheck('ordering a drink moves the price from the wallet into the treasury', async () => {
  const t0 = getOwnedEmpire(db, DEP).treasury
  const w0 = db.data.users[DEP].wallet.solars
  const drink = coffeeDrink('espresso')
  const sends0 = sockSends
  const out = await run(coffee, DEP, 'espresso')
  assert.match(out, /coming up/i, 'the order is served with flavor')
  assert.strictEqual(db.data.users[DEP].wallet.solars, w0 - drink.price, 'the wallet paid the price')
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, t0 + drink.price, 'the coin reached the treasury')
  assert.strictEqual(db.data.users[DEP].empireSpot, 'coffee', 'ordering keeps you at the counter')
  assert.strictEqual(sockSends, sends0, 'ordering never calls sock.sendMessage')
})

await acheck('an order you cannot afford is refused and moves nothing', async () => {
  db.data.users[DEP].wallet.solars = 10
  const t0 = getOwnedEmpire(db, DEP).treasury
  const out = await run(coffee, DEP, 'coldbrew')
  assert.match(out, /costs/i)
  assert.strictEqual(db.data.users[DEP].wallet.solars, 10, 'the wallet is untouched')
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, t0, 'the treasury is untouched')
})

await acheck('a drink that is not on the board is turned away', async () => {
  const out = await run(coffee, DEP, 'mocha')
  assert.match(out, /isn't on the board/i)
})

await acheck('a sworn citizen can order, funding the ruler treasury', async () => {
  db.data.users[NOMAD].empireId = 'vaultspire'
  db.data.users[NOMAD].empireRole = 'citizen'
  db.data.users[NOMAD].wallet.solars = 1000
  const t0 = getOwnedEmpire(db, DEP).treasury
  const drink = coffeeDrink('chai')
  const out = await run(coffee, NOMAD, 'chai')
  assert.match(out, /coming up/i)
  assert.strictEqual(db.data.users[NOMAD].wallet.solars, 1000 - drink.price, 'the citizen paid')
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, t0 + drink.price, 'the owner treasury grew')
  db.data.users[NOMAD].empireId = null
  db.data.users[NOMAD].empireRole = null
})

await acheck('a visitor can order too, and the coin funds the host', async () => {
  db.data.users[NOMAD].visitingEmpire = 'vaultspire'
  db.data.users[NOMAD].wallet.solars = 1000
  const t0 = getOwnedEmpire(db, DEP).treasury
  const drink = coffeeDrink('latte')
  const out = await run(coffee, NOMAD, 'latte')
  assert.match(out, /coming up/i)
  assert.strictEqual(db.data.users[NOMAD].wallet.solars, 1000 - drink.price, 'the visitor paid')
  assert.strictEqual(getOwnedEmpire(db, DEP).treasury, t0 + drink.price, 'the host treasury grew')
  db.data.users[NOMAD].visitingEmpire = null
})

await acheck('with no realm there is nowhere to walk and no counter to order at', async () => {
  const g = await run(gotoPlugin, WANDERER, '')
  assert.match(g, /not standing in any empire/i)
  const o = await run(coffee, WANDERER, '')
  assert.match(o, /not standing in any empire/i)
})

await acheck('build accepts a loose building name, but refuses an ambiguous one', async () => {
  // Both "coffee" and "coffee house" must resolve to the coffee_house def: the
  // reply names that building instead of rejecting the word. (Which gate it then
  // hits, tier or already-built, is not what this check is about.)
  const a = await run(empire, DEP, 'build coffee')
  assert.match(a, /Coffee House/i, 'a loose one-word name resolves')
  assert.ok(!/Unknown building/i.test(a), 'and is not rejected as unknown')
  const b = await run(empire, DEP, 'build coffee house')
  assert.match(b, /Coffee House/i, 'a spaced name resolves')
  assert.ok(!/Unknown building/i.test(b), 'and is not rejected as unknown')
  const c = await run(empire, DEP, 'build mine')
  assert.match(c, /Unknown building/i, 'an ambiguous name is refused, not guessed')
})

// ── Townsfolk engine (Phase 9: named residents, favor, heirlooms) ────────────
console.log('\nTownsfolk engine (Phase 9)')

const mkFolkRec = (npcs, foundedAgo, now) => ensureEmpireShape({
  id: 'folkrealm', name: 'Folkrealm', ownerId: 'ff@s.whatsapp.net',
  foundedAt: now - foundedAgo, lastActiveAt: now, treasury: 0,
  npcs, citizenCount: 1, buildings: [],
})

check('the folk config and its ten trades load, each with a real heirloom', () => {
  assert.ok(folkCap() > 0, 'a named-resident cap is configured')
  assert.ok(folkGiftFavor() > 0, 'a gift threshold is configured')
  assert.strictEqual(FOLK_TRADES.length, 10, 'ten trades ship')
  const itemById = Object.fromEntries(allItems.map(i => [i.id, i]))
  const seenIds = new Set(), seenItems = new Set()
  for (const t of FOLK_TRADES) {
    assert.ok(!seenIds.has(t.id), `${t.id} appears once`)
    seenIds.add(t.id)
    assert.ok(t.name && t.emoji && t.work, `${t.id} has a name, an emoji and a line of work`)
    assert.ok(Array.isArray(t.weapons) && t.weapons.length >= 3, `${t.id} carries at least three weapons`)
    assert.ok(Array.isArray(t.armors) && t.armors.length >= 3, `${t.id} has at least three armor designs`)
    for (const a of t.armors) assert.ok(a.name && a.look, `${t.id} armor "${a.name}" has a name and a look`)
    const item = itemById[t.heirloom]
    assert.ok(item, `${t.id}'s heirloom ${t.heirloom} exists in allItems`)
    assert.strictEqual(item.type, 'armor', `${t.heirloom} is armor`)
    assert.ok(item.named && item.passiveId, `${t.heirloom} is a named item with a passive`)
    assert.ok(!seenItems.has(t.heirloom), `${t.heirloom} belongs to one trade only`)
    seenItems.add(t.heirloom)
    assert.strictEqual(heirloomForTrade(t.id), t.heirloom, 'heirloomForTrade agrees')
  }
})

check('the ten heirlooms are named armor the passive scanner can see in every slot', () => {
  assert.strictEqual(heirlooms.length, 10, 'ten heirlooms ship')
  const passiveIds = new Set()
  for (const it of heirlooms) {
    assert.ok(!passiveIds.has(it.passiveId), `${it.passiveId} is used by one heirloom only`)
    passiveIds.add(it.passiveId)
    assert.ok(['helmet', 'chestplate', 'boots', 'offhand'].includes(it.slot), `${it.id} sits in an armor slot`)
    const wearer = { equipped: { [it.slot]: it.id } }
    assert.strictEqual(getEquippedNamedItems(wearer)[0]?.id, it.id, `${it.id} is seen by the scanner in its own slot`)
    assert.ok(!it.maxDurability, 'a gift from the folk never wears out')
    assert.ok(!it.image, 'and carries no image path to break a renderer')
  }
})

// Each heirloom passive is driven through the real dispatcher with the exact
// preconditions it cares about, so this asserts BEHAVIOUR (and that no two of
// the ten do the same thing) rather than mere presence in a table.
const mkWearer = (item, hp = 1000, maxHp = 1000, mp = 0, maxMp = 500) => ({
  name: 'Wearer', level: 60, hp, maxHp, mp, maxMp,
  equipped: { [item.slot]: item.id },
  baseStats: { str: 100, agi: 100, int: 100, def: 100, lck: 100 },
})
const mkFoe = () => ({ name: 'Dummy', hp: 5000, maxHp: 5000, stats: { atk: 200, def: 50 }, activeEffects: [] })
const itemById = Object.fromEntries(allItems.map(i => [i.id, i]))
const fire = (wearer, ev, ctx) => applyAllNamedPassives(wearer, ev, ctx)

check("Thresher's Coif catches your breath once, and only when you are nearly out", () => {
  const w = mkWearer(itemById.threshers_coif, 500)
  const bs = {}, foe = mkFoe()
  fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(w.hp, 500, 'at half HP nothing happens')
  w.hp = 200
  fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(w.hp, 450, 'under 30% it heals 25% of max')
  w.hp = 100
  fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(w.hp, 100, 'and never a second time in one fight')
})

check("Fisher's Netted Cowl tangles attackers about one hit in five, and never a void", () => {
  const w = mkWearer(itemById.netted_cowl)
  let snared = 0, sample = null
  for (let i = 0; i < 400; i++) {
    const foe = mkFoe()
    fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs: {}, damage: 500 })
    if (foe.activeEffects.length) { snared++; sample = sample ?? foe.activeEffects[0] }
  }
  assert.ok(snared > 30 && snared < 130, `the snare fires sometimes, not always or never (saw ${snared}/400)`)
  assert.strictEqual(sample.type, 'weaken')
  assert.strictEqual(sample.meta.stat, 'atk')
  assert.strictEqual(sample.value, 40, '20% of a 200 ATK attacker')
  assert.strictEqual(sample.remaining, 2, 'for two turns')
  const voidFoe = mkFoe(); voidFoe.statusImmune = true
  for (let i = 0; i < 120; i++) fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: voidFoe, bs: {}, damage: 500 })
  assert.strictEqual(voidFoe.activeEffects.length, 0, 'a status-immune enemy has nothing to tangle')
})

check("Tanner's Layered Jerkin learns from every blow, up to 30 percent", () => {
  const w = mkWearer(itemById.layered_jerkin)
  const bs = {}, foe = mkFoe()
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 300 }).damage, 300, 'the first hit lands in full')
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 300 }).damage, 291, 'then 3% less')
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 300 }).damage, 282, 'then 6% less')
  for (let i = 0; i < 30; i++) fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 300 })
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 300 }).damage, 210, 'and stops at 30% off')
})

check("Miner's Ironback Plate soaks a tenth of every hit into MP", () => {
  const w = mkWearer(itemById.ironback_plate, 1000, 1000, 0, 500)
  const r = fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: mkFoe(), bs: {}, damage: 500 })
  assert.strictEqual(r.damage, 450, 'a tenth never reaches you')
  assert.strictEqual(w.mp, 50, 'it becomes MP instead')
  w.mp = w.maxMp
  fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: mkFoe(), bs: {}, damage: 500 })
  assert.strictEqual(w.mp, w.maxMp, 'and never overfills the pool')
})

check("Herbalist's Greenstep Boots give back 3 percent a turn, and waste nothing at full", () => {
  const w = mkWearer(itemById.greenstep_boots, 400)
  const bs = {}, foe = mkFoe()
  fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(w.hp, 430)
  w.hp = w.maxHp
  const r = fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(w.hp, w.maxHp, 'no overheal')
  assert.strictEqual(r.lines.length, 0, 'and no line for a heal that did nothing')
})

check("Courier's Longstride Boots reward a turn nothing touched you", () => {
  const w = mkWearer(itemById.longstride_boots)
  const bs = {}, foe = mkFoe()
  assert.strictEqual(fire(w, NP_EVENT.PRE_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 1000, 'turn one is not clean, nothing has happened yet')
  fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(fire(w, NP_EVENT.PRE_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 1250, 'after an untouched turn, 25% harder')
  fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 100 })
  fire(w, NP_EVENT.TURN_END, { enemy: foe, bs })
  assert.strictEqual(fire(w, NP_EVENT.PRE_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 1000, 'take a hit and the momentum is gone')
})

check("Mason's Keystone Boots pay for defending, up to 40 percent, then go quiet", () => {
  const w = mkWearer(itemById.keystone_boots)
  const bs = {}, foe = mkFoe()
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 1000, 'no reduction before you have planted your feet')
  const lines = []
  for (let i = 0; i < 8; i++) lines.push(...fire(w, NP_EVENT.PLAYER_DEFEND, { enemy: foe, bs }).lines)
  assert.strictEqual(lines.length, 5, 'five stacks are announced, and the cap stops repeating itself')
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 600, 'five defends is 40% off')
})

check("Glassblower's Lantern Shield eats the first blow of the fight, whatever it is", () => {
  const w = mkWearer(itemById.lantern_shield)
  const bs = {}, foe = mkFoe()
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 99_999 }).damage, 0, 'even a boss nuke goes into the glass')
  assert.strictEqual(fire(w, NP_EVENT.ENEMY_DEAL_DAMAGE, { enemy: foe, bs, damage: 300 }).damage, 300, 'and then the glass is gone')
})

check("Watchman's Bell Buckler only rings while you are behind", () => {
  const w = mkWearer(itemById.bell_buckler, 100)
  const bs = {}, foe = mkFoe()
  assert.strictEqual(fire(w, NP_EVENT.PRE_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 1120, 'behind on HP, 12% harder')
  w.hp = 999_999
  assert.strictEqual(fire(w, NP_EVENT.PRE_DAMAGE, { enemy: foe, bs, damage: 1000 }).damage, 1000, 'ahead on HP, nothing')
})

check("Chandler's Waxlight Buckler burns the enemy as the fight opens, once", () => {
  const w = mkWearer(itemById.waxlight_buckler)
  const bs = {}, foe = mkFoe()
  fire(w, NP_EVENT.FIGHT_INIT, { enemy: foe, bs })
  assert.strictEqual(foe.hp, 4750, '5% of the target max HP, so it scales with the target')
  fire(w, NP_EVENT.FIGHT_INIT, { enemy: foe, bs })
  assert.strictEqual(foe.hp, 4750, 'and it cannot flare twice in one fight')
})

check('none of the ten heirloom passives touch a locked player stat', () => {
  for (const it of heirlooms) {
    const w = mkWearer(it, 400, 1000, 10, 500)
    const before = JSON.stringify(w.baseStats)
    const bs = {}, foe = mkFoe()
    for (const ev of Object.values(NP_EVENT)) {
      fire(w, ev, { enemy: foe, bs, damage: 250, isHit: true, isCrit: true, rawDmg: 250, finalDmg: 250 })
    }
    assert.strictEqual(JSON.stringify(w.baseStats), before, `${it.id} never writes baseStats`)
  }
})

check('a fresh record backfills an empty folk roster without inventing residents', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(0, 100 * HOUR_MS, now)
  assert.deepStrictEqual(rec.folk, [], 'no townsfolk without residents')
  assert.strictEqual(rec.lastFolkAt, rec.foundedAt, 'the favor clock starts at founding')
  const again = ensureFolkShape(rec)
  assert.strictEqual(again.folk.length, 0, 'the backfill is idempotent')
})

check('residents are named up to min(npcs, cap), each with a distinct trade and kit', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(6, 100 * HOUR_MS, now)
  const { newFolk } = accrueFolk(rec, now)
  assert.strictEqual(newFolk.length, 6, 'six residents earn names')
  assert.strictEqual(rec.folk.length, 6)
  assert.strictEqual(new Set(rec.folk.map(f => f.trade)).size, 6, 'trades do not repeat while any are unrepresented')
  assert.strictEqual(new Set(rec.folk.map(f => f.name)).size, 6, 'no two residents share a name')
  for (const f of rec.folk) {
    const trade = folkTradeMap[f.trade]
    assert.ok(trade.weapons.includes(f.weapon), `${f.name} carries one of the ${f.trade} weapons`)
    assert.ok(trade.armors.some(a => a.name === f.armor.name), `${f.name} wears one of the ${f.trade} designs`)
    assert.strictEqual(f.favor, 0, 'a newcomer starts at zero favor')
    assert.strictEqual(f.gifted, false)
  }
  // The cap holds even when the headcount runs far past it.
  rec.npcs = 500
  accrueFolk(rec, now + HOUR_MS)
  assert.strictEqual(rec.folk.length, folkCap(), 'the roster stops at the cap')
  const before = rec.folk.length
  accrueFolk(rec, now + 2 * HOUR_MS)
  assert.strictEqual(rec.folk.length, before, 'and stays there')
})

// Every folk command takes a loose query (".folk greet bram"), so a village with
// two Brams would quietly send the ruler to the wrong one. 50 given names against
// a cap of 10 makes a clean draw easy; this proves the roller actually insists.
check('no two residents of one realm share a given name, over many draws', () => {
  const now = 1_700_000_000_000
  for (let trial = 0; trial < 300; trial++) {
    const rec = mkFolkRec(folkCap(), 100 * HOUR_MS, now)
    accrueFolk(rec, now)
    assert.strictEqual(rec.folk.length, folkCap(), `trial ${trial}: the village filled up`)
    const given = rec.folk.map(f => f.name.split(' ')[0].toLowerCase())
    assert.strictEqual(new Set(given).size, given.length, `trial ${trial}: ${given.join(', ')}`)
    // and a loose query lands on the person it names, every time
    for (const f of rec.folk) {
      const hit = findFolkMember(rec, f.name.split(' ')[0])
      assert.strictEqual(hit?.name, f.name, `trial ${trial}: "${f.name.split(' ')[0]}" is unambiguous`)
    }
  }
})

check('residence favor accrues per hour and is clamped to the offline cap', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(3, 0, now)
  accrueFolk(rec, now)
  const perHour = FOLK_CONFIG.favorPerHour
  const ten = accrueFolk(rec, now + 10 * HOUR_MS)
  assert.strictEqual(ten.favorGain, 10 * perHour, 'ten hours pay ten hours')
  assert.strictEqual(rec.folk[0].favor, 10 * perHour, 'and it lands on the resident')
  const forever = accrueFolk(rec, now + 10 * HOUR_MS + 500 * HOUR_MS)
  assert.strictEqual(forever.favorGain, (OFFLINE_CAP_MS / HOUR_MS) * perHour, 'a month away pays the cap, not the month')
  const none = accrueFolk(rec, now)   // a clock that went backwards
  assert.strictEqual(none.favorGain, 0, 'time never runs backwards into favor')
})

check('previewFolk shows the truth without writing it', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(2, 0, now)
  accrueFolk(rec, now)
  const stored = rec.folk[0].favor
  const view = previewFolk(rec, now + 5 * HOUR_MS)
  assert.strictEqual(view.length, 2)
  assert.ok(view[0].favor > stored, 'the projection includes unbanked time')
  assert.strictEqual(rec.folk[0].favor, stored, 'and the record is untouched')
  assert.ok(view[0].tradeDef && view[0].heirloom, 'the view carries the trade and the heirloom for rendering')
  assert.strictEqual(view[0].target, folkGiftFavor(), 'the target is spelled out')
})

check('greeting lifts favor once per cooldown, and only for someone who lives there', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(2, 0, now)
  accrueFolk(rec, now)
  const who = rec.folk[0].name
  const first = greetFolkMember(rec, who.split(' ')[0], now)
  assert.strictEqual(first.ok, true, 'a given name is enough to find someone')
  assert.strictEqual(first.gained, FOLK_CONFIG.greetFavor)
  const again = greetFolkMember(rec, who, now + 60_000)
  assert.strictEqual(again.ok, false)
  assert.strictEqual(again.reason, 'cooldown')
  assert.ok(again.waitMs > 0, 'and it says how long to wait')
  const later = greetFolkMember(rec, who, now + (FOLK_CONFIG.greetCooldownHours + 1) * HOUR_MS)
  assert.strictEqual(later.ok, true, 'once the cooldown is up, they will talk again')
  assert.strictEqual(greetFolkMember(rec, 'Nobody Atall', now).reason, 'missing', 'a stranger is not greeted')
  assert.strictEqual(greetFolkMember(rec, '', now).reason, 'missing', 'an empty name finds nobody')
})

check('a round at the coffee house lifts every resident, and favor never passes the target', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(4, 0, now)
  accrueFolk(rec, now)
  const lifted = cupFavorForFolk(rec, now)
  assert.strictEqual(lifted, 4, 'the whole room is lifted')
  for (const f of rec.folk) assert.strictEqual(f.favor, FOLK_CONFIG.cupFavor)
  for (let i = 0; i < 200; i++) cupFavorForFolk(rec, now + i * HOUR_MS)
  for (const f of rec.folk) assert.strictEqual(f.favor, folkGiftFavor(), 'favor tops out at the gift threshold')
})

check('the heirloom is offered only at full favor, and only once', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(1, 0, now)
  accrueFolk(rec, now)
  const who = rec.folk[0]
  const early = claimFolkGift(rec, who.name, now)
  assert.strictEqual(early.ok, false)
  assert.strictEqual(early.reason, 'notyet')
  assert.strictEqual(early.need, folkGiftFavor() - who.favor, 'the shortfall is reported')
  assert.strictEqual(pendingFolkGifts(rec, now).length, 0, 'nothing is pending yet')

  who.favor = folkGiftFavor()
  assert.strictEqual(pendingFolkGifts(rec, now).length, 1, 'now one gift waits')
  const claim = claimFolkGift(rec, who.name, now)
  assert.strictEqual(claim.ok, true)
  assert.strictEqual(claim.itemId, heirloomForTrade(who.trade), 'the trade decides the armor')
  assert.strictEqual(claim.folk.gifted, false, 'the engine leaves the marking to the caller')
  claim.folk.gifted = true
  assert.strictEqual(claimFolkGift(rec, who.name, now).reason, 'already', 'a person only has the one')
  assert.strictEqual(pendingFolkGifts(rec, now).length, 0, 'and it stops being pending')
  assert.strictEqual(previewFolk(rec, now + 900 * HOUR_MS)[0].favor, folkGiftFavor(), 'a gifted resident sits at full, not climbing')
})

check('findFolkMember resolves a name, a given name and a trade, and misses cleanly', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(5, 0, now)
  accrueFolk(rec, now)
  const f = rec.folk[2]
  assert.strictEqual(findFolkMember(rec, f.name)?.name, f.name, 'full name')
  assert.strictEqual(findFolkMember(rec, f.name.toUpperCase())?.name, f.name, 'case does not matter')
  assert.strictEqual(findFolkMember(rec, f.name.split(' ')[0])?.name, f.name, 'given name')
  assert.strictEqual(findFolkMember(rec, f.trade)?.trade, f.trade, 'trade')
  assert.strictEqual(findFolkMember(rec, 'zzzznope'), null, 'a miss is null, never a wrong person')
})

check('a corrupt roster is repaired instead of crashing a read', () => {
  const now = 1_700_000_000_000
  const rec = mkFolkRec(3, 0, now)
  rec.folk = [
    null,
    { name: 'Ghost Nameless', trade: 'not_a_real_trade' },
    { name: 'Half Written', trade: FOLK_TRADES[0].id, favor: -50, gifted: 'yes' },
  ]
  ensureFolkShape(rec)
  assert.strictEqual(rec.folk.length, 1, 'nulls and unknown trades are dropped')
  const f = rec.folk[0]
  assert.strictEqual(f.favor, 0, 'negative favor is floored')
  assert.strictEqual(f.gifted, true, 'gifted is coerced to a boolean')
  assert.ok(f.weapon && f.armor?.name, 'a missing weapon and armor are backfilled from the trade')
  assert.doesNotThrow(() => previewFolk(rec, now), 'and the roster reads clean afterwards')
})

check('collecting names the newcomers and reports the gifts that are waiting', () => {
  const now = 1_700_000_000_000
  const rec = ensureEmpireShape({
    id: 'collectfolk', name: 'Collectfolk', ownerId: 'cf@s.whatsapp.net',
    foundedAt: now - 60 * HOUR_MS, lastActiveAt: now, treasury: 100_000, npcs: 4, citizenCount: 1,
    buildings: [{ type: 'house', level: 3, lastCollectedAt: now - 10 * HOUR_MS }],
  })
  const summary = applyCollect(rec, now)
  assert.ok(Array.isArray(summary.newFolk), 'the collect reports its town news')
  assert.strictEqual(summary.newFolk.length, rec.folk.length, 'the newcomers are the ones just named')
  assert.strictEqual(summary.folkGiftsReady, 0, 'nobody is ready on day one')
  for (const f of rec.folk) f.favor = folkGiftFavor()
  const later = applyCollect(rec, now + 5 * HOUR_MS)
  assert.strictEqual(later.folkGiftsReady, rec.folk.length, 'once they are ready, the collect says so')
  assert.strictEqual(later.newFolk.length, 0, 'and nobody is named twice')
})

console.log('\nTownsfolk plugin (Phase 9)')

const FOLKLORD = '353535@s.whatsapp.net'
const PASSERBY = '363636@s.whatsapp.net'
makePlayer(FOLKLORD, 'Folklord', 500_000)
makePlayer(PASSERBY, 'Passerby', 1000)

await acheck('with no realm there is nobody to meet', async () => {
  const out = await run(folkPlugin, PASSERBY, '')
  assert.match(out, /not standing in any empire/i)
})

await acheck('a ruler with no residents is told how folk arrive', async () => {
  await run(empire, FOLKLORD, 'found Hearthmoor')
  const rec = getOwnedEmpire(db, FOLKLORD)
  assert.ok(rec, 'the realm was founded')
  const sends0 = sockSends
  const out = await run(folkPlugin, FOLKLORD, '')
  assert.match(out, /Folk of Hearthmoor/i)
  assert.match(out, /Nobody has settled here by name yet/i)
  assert.match(out, /empire collect/i, 'the owner learns what brings them in')
  assert.strictEqual(sockSends, sends0, 'looking at your people never calls sock.sendMessage')
})

await acheck('the roster lists every resident with a trade, a kit and a favor bar', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  rec.npcs = 5
  accrueFolk(rec, Date.now())
  const out = await run(folkPlugin, FOLKLORD, '')
  assert.strictEqual(rec.folk.length, 5, 'five residents have names')
  for (const f of rec.folk) assert.ok(out.includes(f.name), `${f.name} is on the roster`)
  assert.match(out, /favor/i, 'favor is shown')
  assert.match(out, /named residents/i, 'the count against the cap is shown')
})

await acheck('looking closer shows the weapon, the armor design and the trade work', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  const f = rec.folk[0]
  const out = await run(folkPlugin, FOLKLORD, f.name.split(' ')[0])
  assert.ok(out.includes(f.name), 'the right resident')
  assert.ok(out.includes(f.weapon), 'their weapon is named')
  assert.ok(out.includes(f.armor.name), 'their armor design is named')
  assert.ok(out.includes(f.armor.look), 'and how it looks')
  assert.match(out, /Carries:/i)
  assert.match(out, /Wears:/i)
})

await acheck('a resident who is not there is a clean miss, not a wrong person', async () => {
  const out = await run(folkPlugin, FOLKLORD, 'Nobodyatall')
  assert.match(out, /Nobody named/i)
  assert.match(out, /folk/i, 'and the roster command is offered')
})

await acheck('greeting a resident lifts their favor and then holds a cooldown', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  const f = rec.folk[0]
  const before = f.favor
  const sends0 = sockSends
  const out = await run(folkPlugin, FOLKLORD, `greet ${f.name.split(' ')[0]}`)
  assert.match(out, /You stop and talk with/i)
  assert.match(out, /favor/i)
  assert.ok(rec.folk[0].favor > before, 'favor rose')
  assert.strictEqual(db.data.users[FOLKLORD].empireSpot, 'square', 'holding court puts you in the square')
  const twice = await run(folkPlugin, FOLKLORD, `greet ${f.name.split(' ')[0]}`)
  assert.match(twice, /already had their word/i)
  assert.strictEqual(sockSends, sends0, 'greeting never calls sock.sendMessage')
})

await acheck('a visitor may look, but may not greet or take gifts', async () => {
  db.data.users[PASSERBY].visitingEmpire = 'hearthmoor'
  const rec = getOwnedEmpire(db, FOLKLORD)
  const f = rec.folk[0]
  const look = await run(folkPlugin, PASSERBY, '')
  assert.ok(look.includes(f.name), 'a guest can see who lives here')
  const greet = await run(folkPlugin, PASSERBY, `greet ${f.name.split(' ')[0]}`)
  assert.match(greet, /answer to their own ruler/i)
  const gift = await run(folkPlugin, PASSERBY, `gift ${f.name.split(' ')[0]}`)
  assert.match(gift, /keep for their own ruler/i)
  const closeUp = await run(folkPlugin, PASSERBY, f.name.split(' ')[0])
  assert.ok(!/folk greet/i.test(closeUp), 'and is not offered the ruler commands')
  db.data.users[PASSERBY].visitingEmpire = null
})

await acheck('a gift asked for too early is refused, and nothing is spent', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  const f = rec.folk[1]
  const bag = db.data.users[FOLKLORD].inventory.length
  const out = await run(folkPlugin, FOLKLORD, `gift ${f.name.split(' ')[0]}`)
  assert.match(out, /not ready to part with anything/i)
  assert.match(out, /to go/i, 'the shortfall is shown')
  assert.strictEqual(db.data.users[FOLKLORD].inventory.length, bag, 'the bag is untouched')
  assert.strictEqual(rec.folk[1].gifted, false, 'and the heirloom stays with its owner')
})

await acheck('at full favor the heirloom lands in the bag, once and only once', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  const f = rec.folk[1]
  f.favor = folkGiftFavor()
  const expected = heirloomForTrade(f.trade)
  const bag = db.data.users[FOLKLORD].inventory.length
  const sends0 = sockSends
  const out = await run(folkPlugin, FOLKLORD, `gift ${f.name.split(' ')[0]}`)
  assert.match(out, /presses it into your hands/i)
  assert.strictEqual(db.data.users[FOLKLORD].inventory.length, bag + 1, 'exactly one item was added')
  assert.ok(db.data.users[FOLKLORD].inventory.includes(expected), `the ${expected} is in the bag`)
  assert.strictEqual(rec.folk[1].gifted, true, 'the resident is marked as having given it')
  assert.match(out, /equip/i, 'and the ruler is told how to wear it')
  const twice = await run(folkPlugin, FOLKLORD, `gift ${f.name.split(' ')[0]}`)
  assert.match(twice, /already gave you/i)
  assert.strictEqual(db.data.users[FOLKLORD].inventory.filter(i => i === expected).length, 1, 'never duplicated')
  assert.strictEqual(sockSends, sends0, 'taking a gift never calls sock.sendMessage')
})

await acheck('a full bag leaves the heirloom with its owner instead of burning it', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  const f = rec.folk[2]
  f.favor = folkGiftFavor()
  const saved = db.data.users[FOLKLORD].inventory
  db.data.users[FOLKLORD].inventory = Array.from({ length: 500 }, () => 'wood')
  const out = await run(folkPlugin, FOLKLORD, `gift ${f.name.split(' ')[0]}`)
  assert.match(out, /room/i, 'the ruler is told the bag is full')
  assert.strictEqual(rec.folk[2].gifted, false, 'the heirloom is still theirs to give')
  assert.ok(!db.data.users[FOLKLORD].inventory.includes(heirloomForTrade(f.trade)), 'and it did not land anywhere')
  db.data.users[FOLKLORD].inventory = saved
  const retry = await run(folkPlugin, FOLKLORD, `gift ${f.name.split(' ')[0]}`)
  assert.match(retry, /presses it into your hands/i, 'and it can be taken after tidying up')
})

await acheck('a round bought by the ruler warms the whole room', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  rec.buildings.push({ type: 'coffee_house', level: 1, lastCollectedAt: Date.now() })
  for (const f of rec.folk) { f.favor = 0; f.gifted = false }
  db.data.users[FOLKLORD].wallet.solars = 50_000
  const out = await run(coffee, FOLKLORD, 'espresso')
  assert.match(out, /coming up/i)
  assert.match(out, /warm to you/i, 'the room is mentioned')
  for (const f of rec.folk) assert.ok(f.favor >= FOLK_CONFIG.cupFavor, `${f.name} warmed to the ruler`)
})

await acheck('a guest buying their own cup funds the treasury and nothing more', async () => {
  const rec = getOwnedEmpire(db, FOLKLORD)
  const favors = rec.folk.map(f => f.favor)
  db.data.users[PASSERBY].visitingEmpire = 'hearthmoor'
  db.data.users[PASSERBY].wallet.solars = 50_000
  const t0 = rec.treasury
  const out = await run(coffee, PASSERBY, 'espresso')
  assert.match(out, /coming up/i)
  assert.ok(rec.treasury > t0, 'the coin still reached the treasury')
  assert.ok(!/warm to you/i.test(out), 'but no round was stood for the house')
  assert.deepStrictEqual(rec.folk.map(f => f.favor), favors, 'and nobody gained favor')
  db.data.users[PASSERBY].visitingEmpire = null
})

await acheck('who-lives-here names the residents and points at the folk command', async () => {
  const out = await run(emOnline, FOLKLORD, '')
  const rec = getOwnedEmpire(db, FOLKLORD)
  assert.ok(out.includes(rec.folk[0].name), 'a resident is named')
  assert.match(out, /folk/i, 'and the command to meet them is offered')
})

// ── Ready-made presets (owner restoration tool) ──────────────────────────────
console.log('\nPresets')

check('the preset ladder loads, ids are unique, and headcount climbs', () => {
  assert.ok(PRESET_ORDER.length >= 8, `expected at least 8 presets, saw ${PRESET_ORDER.length}`)
  const ids = PRESET_ORDER.map(x => x.id)
  assert.strictEqual(new Set(ids).size, ids.length, 'preset ids are unique')
  const names = PRESET_ORDER.map(x => x.name.toLowerCase())
  assert.strictEqual(new Set(names).size, names.length, 'preset names are unique')
  for (let i = 1; i < PRESET_ORDER.length; i++) {
    assert.ok(PRESET_ORDER[i].citizens > PRESET_ORDER[i - 1].citizens,
      `${PRESET_ORDER[i].id} must hold more residents than ${PRESET_ORDER[i - 1].id}`)
  }
  assert.ok(PRESET_ORDER[0].citizens >= 1000, 'the smallest preset covers the 1,000 floor')
  assert.ok(PRESET_ORDER.at(-1).citizens >= 10_000, 'the largest preset reaches the 10,000 ceiling')
})

check('every preset passes its own audit: caps, ranks, regions and a positive margin', () => {
  for (const preset of PRESET_ORDER) {
    const audit = auditPreset(preset)
    assert.ok(audit.ok, `${preset.id}: ${audit.problems.join('; ')}`)
  }
})

check('presets are genuinely varied, not one build repeated', () => {
  const shapes = PRESET_ORDER.map(x => JSON.stringify(
    [...x.buildings].map(b => `${b.type}:${b.level}`).sort()))
  assert.strictEqual(new Set(shapes).size, shapes.length, 'no two presets share a building list')
  const focus = PRESET_ORDER.map(x => x.specialisation.toLowerCase())
  assert.ok(new Set(focus).size >= 6, `expected 6+ distinct specialisations, saw ${new Set(focus).size}`)
  // Every preset must lean somewhere. Houses and warehouses are infrastructure
  // every realm needs, so the lean is measured over the SPECIALISING buildings:
  // what this empire is actually for.
  const generic = new Set(['house', 'warehouse'])
  const leans = PRESET_ORDER.map(x => {
    const tally = {}
    for (const b of x.buildings) {
      if (generic.has(b.type)) continue
      tally[b.type] = (tally[b.type] ?? 0) + b.level
    }
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]
  })
  assert.ok(new Set(leans).size >= 4, `expected 4+ different dominant buildings, saw ${[...new Set(leans)].join(',')}`)
})

check('the soiler ladder is ranked per preset and scales with its size', () => {
  let last = -1
  for (const preset of PRESET_ORDER) {
    const top = rankMap[preset.soilerRank]
    assert.ok(top?.named, `${preset.id} names a real officer rank`)
    const officerRanks = new Set((preset.army.officers ?? []).map(o => o.rank))
    assert.ok(officerRanks.has(preset.soilerRank), `${preset.id} actually fields its stated top rank`)
    // Tiered means the whole ladder, levies included: rank and file under
    // named officers, never one flat rank.
    const tiers = new Set(officerRanks)
    for (const levy of ['recruit', 'soldier']) {
      if ((preset.army.levies?.[levy] ?? 0) > 0) tiers.add(levy)
    }
    assert.ok(tiers.size >= 3, `${preset.id} fields ${tiers.size} rank(s), expected a tiered corps of 3+`)
    const idx = RANK_ORDER.indexOf(preset.soilerRank)
    assert.ok(idx >= last - 1, `${preset.id} does not fall two rungs below the preset beneath it`)
    last = Math.max(last, idx)
    // The producer levels rise with the ladder too, so both readings of a
    // "ranked scale" hold: the officers AND the buildings.
    const topLevel = Math.max(...preset.buildings.map(b => b.level))
    assert.ok(topLevel >= 4, `${preset.id} runs buildings worth the rank`)
  }
  assert.strictEqual(RANK_ORDER[last], 'warlord', 'the ladder tops out at warlord')
})

check('a preset preview never writes to the preset data', () => {
  const before = JSON.stringify(PRESET_ORDER)
  for (const preset of PRESET_ORDER) presetPreview(preset)
  assert.strictEqual(JSON.stringify(PRESET_ORDER), before, 'presetPreview left the data untouched')
})

check('findPreset resolves an id, a partial name and a focus, and misses cleanly', () => {
  const first = PRESET_ORDER[0]
  assert.strictEqual(findPreset(first.id)?.id, first.id)
  assert.strictEqual(findPreset(first.name.split(' ')[0].toLowerCase())?.id, first.id)
  assert.ok(findPreset('nothing-like-this') === null)
  assert.ok(findPreset('') === null)
})

check('suggestPreset climbs with level and nudges up for a fat purse', () => {
  const low = suggestPreset({ level: 5, wallet: { solars: 0 } })
  const mid = suggestPreset({ level: 60, wallet: { solars: 0 } })
  const high = suggestPreset({ level: 100, wallet: { solars: 0 } })
  assert.strictEqual(low.id, PRESET_ORDER[0].id, 'a new player gets the smallest')
  assert.ok(mid.citizens > low.citizens, 'mid level moves up the ladder')
  assert.ok(high.citizens >= mid.citizens, 'high level does not move back down')
  const rich = suggestPreset({ level: 5, wallet: { solars: 600_000 } })
  assert.ok(rich.citizens > low.citizens, 'a visibly rich player is nudged up')
  const capped = suggestPreset({ level: 150, wallet: { solars: 9_000_000 } })
  assert.strictEqual(capped.id, PRESET_ORDER.at(-1).id, 'and the nudge cannot run off the end')
})

check('buildPresetRecord puts headcount in npcs, derives fame and tier, and backdates nothing', () => {
  const now = 1_800_000_000_000
  const preset = PRESET_ORDER.at(-1)
  const rec = buildPresetRecord(preset, { id: 'test-hold', name: 'Test Hold', ownerId: 'p1', now })
  assert.strictEqual(rec.npcs, preset.citizens, 'headcount landed in npcs')
  assert.strictEqual(rec.citizenCount, 1, 'the new ruler is the only player member')
  assert.strictEqual(rec.fame, preset.citizens + 1, 'fame is the derived headcount')
  assert.strictEqual(rec.tierId, tierForFame(rec.fame).id, 'tier follows fame')
  assert.strictEqual(rec.treasury, preset.treasury)
  assert.strictEqual(rec.buildings.length, preset.buildings.length)
  assert.strictEqual(rec.presetId, preset.id, 'the record remembers which preset it came from')
  for (const b of rec.buildings) {
    assert.strictEqual(b.lastCollectedAt, now, 'no backdated production')
    assert.strictEqual(b.damagedUntil, 0, 'and nothing arrives damaged')
  }
  assert.strictEqual(rec.lastPopAt, now)
  assert.strictEqual(rec.lastCivicAt, now)
  assert.strictEqual(rec.army.lastPaidAt, now, 'the army is treated as just paid')
  // The very first collect can therefore only pay for time the new owner waits.
  const preview = previewCollect(rec, now + 60_000)
  assert.ok(preview.solarsGain < 400, `a minute in, the payout is small, saw ${preview.solarsGain}`)
})

check('an assigned preset still turns a profit after a full offline cap', () => {
  const now = 1_800_000_000_000
  for (const preset of PRESET_ORDER) {
    const rec = buildPresetRecord(preset, { id: `t-${preset.id}`, name: preset.name, ownerId: 'p1', now })
    const before = rec.treasury
    const out = applyCollect(rec, now + 48 * 3600 * 1000)
    assert.ok(rec.treasury > before,
      `${preset.id} treasury fell from ${before} to ${rec.treasury} over a long absence`)
    assert.ok(out.netSolars > 0, `${preset.id} netted ${out.netSolars} over a long absence`)
    assert.strictEqual(armyHeadcount(rec) > 0, true, `${preset.id} lost its whole army to payroll`)
  }
})

await acheck('.empire preset is refused to anyone who is not the bot owner', async () => {
  const out = await run(empire, A, 'preset')
  assert.match(out, /restricted to the bot owner/i)
})

// The owner gate reads config, so the end-to-end assign runs as the configured
// owner. The number is never printed, only used to build the jid.
const OWNER = `${String(config.ownerNumbers?.[0] ?? '').replace(/\D/g, '')}@s.whatsapp.net`
const LOSTONE = '373737@s.whatsapp.net'
const LOSTTWO = '383838@s.whatsapp.net'

await acheck('the owner sees the ladder, then one preset in full', async () => {
  makePlayer(OWNER, 'Owner', 0)
  const list = await run(empire, OWNER, 'preset')
  assert.match(list, /READY-MADE EMPIRES/i)
  for (const preset of PRESET_ORDER) assert.ok(list.includes(preset.id), `${preset.id} is listed`)
  const one = await run(empire, OWNER, `preset ${PRESET_ORDER[2].id}`)
  assert.ok(one.includes(PRESET_ORDER[2].name.toUpperCase()), 'the detail view names it')
  assert.match(one, /Economy per hour/i)
  assert.ok(!/⚠️/.test(one), 'and it carries no audit warning')
})

await acheck('a preset nobody has heard of is a clean miss', async () => {
  const out = await run(empire, OWNER, 'preset chocolate-town')
  assert.match(out, /No preset matches/i)
})

await acheck('suggest fits a preset to the player who lost one', async () => {
  makePlayer(LOSTONE, 'Lost One', 250_000)
  db.data.users[LOSTONE].level = 68
  const out = await run(empire, OWNER, `preset suggest ${LOSTONE}`)
  assert.match(out, /Suggested for Lost One/i)
  assert.ok(PRESET_ORDER.some(x => out.includes(x.id)), 'it names a preset')
})

await acheck('assigning hands over a whole realm in one write, and notifies the player', async () => {
  const before = listNotifications(db, LOSTONE).length
  const preset = PRESET_ORDER[3]
  const out = await run(empire, OWNER, `preset assign ${LOSTONE} ${preset.id} Lost Dominion`)
  assert.match(out, /assigned to/i)
  const rec = getOwnedEmpire(db, LOSTONE)
  assert.ok(rec, 'the record exists and is owned by the player')
  assert.strictEqual(rec.name, 'Lost Dominion', 'the custom name stuck')
  assert.strictEqual(rec.npcs, preset.citizens, 'the residents came with it')
  assert.strictEqual(rec.presetId, preset.id)
  assert.strictEqual(db.data.users[LOSTONE].empireId, rec.id)
  assert.strictEqual(db.data.users[LOSTONE].empireRole, 'owner')
  assert.strictEqual(listNotifications(db, LOSTONE).length, before + 1, 'exactly one notification')
})

await acheck('a player who already rules is refused a second empire', async () => {
  const out = await run(empire, OWNER, `preset assign ${LOSTONE} ${PRESET_ORDER[0].id}`)
  assert.match(out, /already rules/i)
})

await acheck('a name already on the map is refused before anything is written', async () => {
  makePlayer(LOSTTWO, 'Lost Two', 0)
  const out = await run(empire, OWNER, `preset assign ${LOSTTWO} ${PRESET_ORDER[1].id} Lost Dominion`)
  assert.match(out, /already taken/i)
  assert.ok(!getOwnedEmpire(db, LOSTTWO), 'and no record was left behind')
})

await acheck('a stranger cannot be handed an empire', async () => {
  const out = await run(empire, OWNER, `preset assign 999999999@s.whatsapp.net ${PRESET_ORDER[0].id}`)
  assert.match(out, /not a registered player|Point at a player/i)
})

await acheck('assign without a preset id says which ones exist', async () => {
  const out = await run(empire, OWNER, `preset assign ${LOSTTWO}`)
  assert.match(out, /Name a preset/i)
  assert.ok(out.includes(PRESET_ORDER[0].id))
})

// ── Rename ───────────────────────────────────────────────────────────────
// `.empire rename <name>` for EMPIRE_CONFIG.renameCost solars. The interesting
// part is that the record's KEY is an immutable primary key (users point at it
// via empireId, wars and sale listings quote it), so only the display name may
// move. That makes the old name reusable, which is what the last few checks are
// really about.
console.log('\nRename')

const REN = '424242@s.whatsapp.net'
const RIVAL = '434343@s.whatsapp.net'
const RENAME_COST = EMPIRE_CONFIG.renameCost ?? 50000

await acheck('renaming is refused to someone with no empire', async () => {
  makePlayer(REN, 'Renamer', EMPIRE_CONFIG.foundCost + RENAME_COST * 3)
  const out = await run(empire, REN, 'rename Anything')
  assert.match(out, /Only a ruler/i)
})

await acheck('the bare command quotes the current name and the price', async () => {
  await run(empire, REN, 'found Copper Reach')
  const out = await run(empire, REN, 'rename')
  assert.ok(out.includes('Copper Reach'), 'it does not show the current name')
  assert.ok(out.includes(RENAME_COST.toLocaleString()), 'it does not show the cost')
  assert.strictEqual(getOwnedEmpire(db, REN).name, 'Copper Reach', 'a bare rename changed something')
})

await acheck(`renaming costs ${RENAME_COST.toLocaleString()} solars and only moves the name`, async () => {
  const rec = getOwnedEmpire(db, REN)
  const before = {
    id: rec.id, solars: db.data.users[REN].wallet.solars,
    treasury: rec.treasury, buildings: rec.buildings.length, npcs: rec.npcs, fame: rec.fame,
  }
  const out = await run(empire, REN, 'rename Copper Ascendancy')
  assert.match(out, /is now/i)
  const after = getOwnedEmpire(db, REN)
  assert.strictEqual(after.name, 'Copper Ascendancy')
  assert.strictEqual(db.data.users[REN].wallet.solars, before.solars - RENAME_COST, 'the cost was not charged')
  assert.strictEqual(after.id, before.id, 'the primary key moved, which would orphan every reference to it')
  assert.strictEqual(db.data.users[REN].empireId, before.id, 'the player now points at nothing')
  assert.strictEqual(after.treasury, before.treasury)
  assert.strictEqual(after.buildings.length, before.buildings)
  assert.strictEqual(after.npcs, before.npcs)
  assert.strictEqual(after.fame, before.fame)
})

await acheck('the new name is what .empire info answers to', async () => {
  assert.ok(findEmpireByQuery(db, 'Copper Ascendancy'), 'the new name does not resolve')
  const stale = findEmpireByQuery(db, 'Copper Reach')
  // The id keeps the original slug, so the old name still resolves as an alias.
  // What matters is that it resolves to THIS empire and not to a ghost.
  assert.strictEqual(stale?.name, 'Copper Ascendancy')
})

await acheck('renaming to the name it already has is a no-op, not a charge', async () => {
  const solars = db.data.users[REN].wallet.solars
  const out = await run(empire, REN, 'rename copper ASCENDANCY')
  assert.match(out, /already its name/i)
  assert.strictEqual(db.data.users[REN].wallet.solars, solars, 'a no-op rename still charged')
})

await acheck('a name another empire holds is refused, and nothing is charged', async () => {
  makePlayer(RIVAL, 'Rival', EMPIRE_CONFIG.foundCost)
  await run(empire, RIVAL, 'found Tinwatch')
  const solars = db.data.users[REN].wallet.solars
  const out = await run(empire, REN, 'rename Tinwatch')
  assert.match(out, /already taken/i)
  assert.strictEqual(db.data.users[REN].wallet.solars, solars, 'a refused rename still charged')
  assert.strictEqual(getOwnedEmpire(db, REN).name, 'Copper Ascendancy')
})

await acheck('a rename nobody can afford is refused', async () => {
  db.data.users[REN].wallet.solars = RENAME_COST - 1
  const out = await run(empire, REN, 'rename Broke Banner')
  assert.match(out, /costs/i)
  assert.strictEqual(getOwnedEmpire(db, REN).name, 'Copper Ascendancy', 'it renamed on credit')
  db.data.users[REN].wallet.solars = RENAME_COST * 2
})

await acheck('a junk name is refused by the same validator as .empire found', async () => {
  const out = await run(empire, REN, 'rename x')
  assert.ok(!/is now/i.test(out), 'a one-character name was accepted')
  assert.strictEqual(getOwnedEmpire(db, REN).name, 'Copper Ascendancy')
})

await acheck('the name a renamed empire gave up is free for the next founder', async () => {
  // The whole reason empireNameTaken matches live names and not record ids: the
  // renamed empire's id is still `copper-reach`, and a founder asking for
  // "Copper Reach" must not be blocked by a name nobody answers to any more.
  const NEWCOMER = '454545@s.whatsapp.net'
  makePlayer(NEWCOMER, 'Newcomer', EMPIRE_CONFIG.foundCost)
  const out = await run(empire, NEWCOMER, 'found Copper Reach')
  assert.match(out, /founded|risen|raised|born/i, `founding on a freed name failed: ${out}`)
  const fresh = getOwnedEmpire(db, NEWCOMER)
  assert.strictEqual(fresh.name, 'Copper Reach')
  assert.notStrictEqual(fresh.id, getOwnedEmpire(db, REN).id, 'the newcomer overwrote the renamed empire')
  assert.strictEqual(getOwnedEmpire(db, REN).name, 'Copper Ascendancy', 'the older empire was clobbered')
  assert.strictEqual(db.data.users[REN].empireId, 'copper-reach', 'the older empire kept its key')
})

check('freeEmpireId walks past a taken key instead of overwriting it', () => {
  assert.strictEqual(freeEmpireId(db, 'nothing-owns-this'), 'nothing-owns-this')
  const taken = Object.keys(db.data.empires)[0]
  assert.strictEqual(freeEmpireId(db, taken), `${taken}-2`)
})

check('an empire does not hold its own name against itself', () => {
  const rec = getOwnedEmpire(db, REN)
  assert.strictEqual(empireNameTaken(db, rec.name), true, 'a live name reads as free')
  assert.strictEqual(empireNameTaken(db, rec.name, rec.id), false, 'exceptId does not exempt the holder')
})

// ── 3. No broadcasts ─────────────────────────────────────────────────────
console.log('\nSafety')

check('Phase 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 never call sock.sendMessage (no broadcasts)', () => {
  assert.strictEqual(sockSends, 0, `expected 0 socket sends, saw ${sockSends}`)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
