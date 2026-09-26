/**
 * newbie-dungeon.test.mjs — the Newcomer's Hollow lane, the newcomer XP boost,
 * and the level-100+ veteran difficulty tier.
 *
 * Three reports drove this file:
 *   "new/upcoming players gain little xp and some feel weak"  → the Hollow
 *   "make monsters that show up to 100+ players harder"        → veteran tier
 *   plus the pieces that make either one work: the daily floor allowance, the
 *   level-31 graduation gate, and the rewards actually paying what the header
 *   promises.
 *
 * Run:  node --test test/newbie-dungeon.test.mjs
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  NEWBIE_LOCATION_ID, NEWBIE_MAX_LEVEL, NEWBIE_FLOORS_PER_DAY,
  isNewbieLocation, isNewbieGraduated, newbieFloorsRemaining, peekNewbieFloors,
  refreshNewbieFloors, consumeNewbieFloor, newbieFloorLimitMessage, newbieFloorsLine,
  newbieGraduatedMessage, nextResetAt,
} from '../lib/newbie-dungeon.js'
import {
  locationsMap, regularByLoc, bossByLocFloor, allItems, getTotalStats,
} from '../lib/game-data.js'
import {
  monsterStatsAtFloor, pickMonsterForFloor, veteranTier, applyVeteranScaling,
  veteranBanner, VETERAN_SCALE,
} from '../lib/combat-engine.js'
import { buildSwarmFloor } from '../lib/swarm-combat.js'
import { speedKillXp, LOCATION_REWARD_MULT, newcomerXpMult, NEWCOMER_BOOST } from '../lib/xp-regulator.js'
import { creditKill } from '../lib/combat-handlers.js'
import { ensureStatPoints } from '../lib/stat-progression.js'
import { dungeonList } from '../plugins/dungeon.js'

let failures = 0
const t = (name, fn) => test(name, async (...args) => {
  try { return await fn(...args) } catch (err) { failures++; throw err }
})
after(() => { setTimeout(() => process.exit(failures ? 1 : 0), 25).unref() })

// ─────────────────────────────────────────────────────────────────────────────
// The dungeon itself
// ─────────────────────────────────────────────────────────────────────────────

t('the Hollow is a real dungeon: 50 floors, level 1-30, free, one boss', () => {
  const loc = locationsMap[NEWBIE_LOCATION_ID]
  assert.ok(loc, 'newbie_hollow must exist in data/locations.json')
  assert.equal(loc.type, 'dungeon')
  assert.equal(loc.floors, 50)
  assert.deepEqual(loc.levelRange, [1, NEWBIE_MAX_LEVEL])
  assert.equal(loc.entryLevel, 1)
  assert.equal(loc.maxLevel, NEWBIE_MAX_LEVEL)
  assert.equal(loc.travelCost, 0, 'newcomers have no Solars — entry must be free')
  assert.equal(loc.prerequisite, null)
  assert.deepEqual(loc.bossFloors, [50], 'the last floor needs a boss, or the run never ends')
  assert.equal(loc.dailyFloorCap, NEWBIE_FLOORS_PER_DAY)
})

t('every floor 1-50 has a monster, and its boss is on floor 50', () => {
  const pool = regularByLoc[NEWBIE_LOCATION_ID] ?? []
  assert.ok(pool.length >= 6, `expected a varied roster, got ${pool.length} monsters`)
  for (let floor = 1; floor <= 50; floor++) {
    const m = pickMonsterForFloor(NEWBIE_LOCATION_ID, floor, regularByLoc)
    assert.ok(m, `floor ${floor} has no monster`)
    assert.ok(m.hp > 0 && m.atk > 0, `floor ${floor}'s ${m.name} rolled broken stats`)
  }
  const boss = bossByLocFloor[NEWBIE_LOCATION_ID]?.[50]
  assert.ok(boss, 'the Gatekeeper must be registered for floor 50')
  assert.equal(boss.tier, 'boss')
  assert.ok(boss.conquestTitle, 'clearing the Hollow must grant a title')
})

t('the Hollow scale stays gentle: nothing in it walls a newcomer', () => {
  // The roster is re-balanced against the reference player at each floor's
  // expected level, so this is a guard on the CURVE, not on authored numbers:
  // a mistake in the new location's data would show up here as a 40k-HP "rat".
  for (let floor = 1; floor <= 50; floor++) {
    const m = pickMonsterForFloor(NEWBIE_LOCATION_ID, floor, regularByLoc)
    assert.ok(m.maxHp <= 4000, `floor ${floor} ${m.name} has ${m.maxHp} HP — far past the 1-30 band`)
    assert.ok(m.atk <= 400, `floor ${floor} ${m.name} hits for ${m.atk} — that one-shots a newcomer`)
  }
  // And the floor-1 monster must be killable by the level-1 character that
  // actually walks in: naked warrior, 10 str, so basic hits land double digits.
  const first = monsterStatsAtFloor(regularByLoc[NEWBIE_LOCATION_ID][0], 1)
  assert.ok(first.hp <= 400, `the very first monster has ${first.hp} HP — a level 1 swings for ~10`)
})

t('every Hollow drop is a real item', () => {
  const ids = new Set(allItems.map(i => i.id))
  const pool = regularByLoc[NEWBIE_LOCATION_ID] ?? []
  const drops = [...pool, bossByLocFloor[NEWBIE_LOCATION_ID]?.[50]].filter(Boolean)
    .flatMap(m => m.drops ?? [])
  assert.ok(drops.length > 0, 'the Hollow must drop things')
  for (const d of drops) {
    assert.ok(ids.has(d.itemId), `drop ${d.itemId} is not a real item`)
    assert.ok(d.chance > 0 && d.chance <= 1, `drop ${d.itemId} has chance ${d.chance}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The graduation gate ("after lvl 31 they cant enter")
// ─────────────────────────────────────────────────────────────────────────────

t('level 30 may enter the Hollow, level 31 may not', () => {
  assert.equal(isNewbieGraduated({ level: 1 }), false)
  assert.equal(isNewbieGraduated({ level: NEWBIE_MAX_LEVEL }), false)
  assert.equal(isNewbieGraduated({ level: NEWBIE_MAX_LEVEL + 1 }), true)
  assert.equal(isNewbieGraduated({ level: 90 }), true)
  // A record with no level at all is treated as a brand-new character.
  assert.equal(isNewbieGraduated({}), false)
})

t('the graduation message names the dungeon they should be on instead', () => {
  const msg = newbieGraduatedMessage({ level: 34 }, '.')
  assert.match(msg, /outgrown/i)
  assert.match(msg, /Level 30/)
  const id = msg.match(/\.enter ([a-z0-9_]+)/)?.[1]
  assert.ok(id, 'it must point at a next dungeon')
  const loc = locationsMap[id]
  assert.ok(loc, `${id} is not a real location`)
  assert.notEqual(loc.id, NEWBIE_LOCATION_ID, 'it must not point back into the Hollow')
  assert.notEqual(loc.id, 'the_end', 'The End is event-gated — never the suggested next step')
  assert.ok(loc.levelRange[0] <= 34 && loc.levelRange[1] >= 34, `${id} does not cover level 34`)
})

// ─────────────────────────────────────────────────────────────────────────────
// The daily allowance ("50 floors per day")
// ─────────────────────────────────────────────────────────────────────────────

t('a fresh player has 50 Hollow floors, and spending them is per floor', () => {
  const player = { level: 3 }
  assert.equal(newbieFloorsRemaining(player), NEWBIE_FLOORS_PER_DAY)
  for (let i = 0; i < 7; i++) consumeNewbieFloor(player)
  assert.equal(newbieFloorsRemaining(player), NEWBIE_FLOORS_PER_DAY - 7)
  assert.match(newbieFloorsLine(player), /7\/50/)
})

t('50 floors is exactly one lap, and the day rolls over at midnight', () => {
  const player = { level: 3 }
  for (let i = 0; i < NEWBIE_FLOORS_PER_DAY; i++) consumeNewbieFloor(player)
  assert.equal(newbieFloorsRemaining(player), 0)
  assert.match(newbieFloorLimitMessage(player), /fifty/i)
  assert.match(newbieFloorLimitMessage(player), /50\/50/)

  // Rewind past the recorded reset: the counter refills to a full lap.
  const resetAt = player.newbieHollow.resetAt
  assert.equal(resetAt, nextResetAt(), 'the window must end at midnight')
  assert.equal(newbieFloorsRemaining(player, resetAt + 1), NEWBIE_FLOORS_PER_DAY)
})

t('reading the counter for display never writes to the player record', () => {
  // dungeonList() and .travel render outside an updatePlayer mutator, so they
  // must be able to show the number without editing the record they were given.
  const player = { level: 4 }
  newbieFloorsLine(player)
  peekNewbieFloors(player)
  assert.equal('newbieHollow' in player, false)
  // ...and an expired window reads as a fresh one rather than as "0 left".
  const stale = { level: 4, newbieHollow: { used: 50, resetAt: Date.now() - 1 } }
  assert.equal(newbieFloorsRemaining(stale), NEWBIE_FLOORS_PER_DAY)
})

t('the dungeon list shows the Hollow with its ceiling and floors left', () => {
  const fresh = dungeonList({ level: 5, dungeonProgress: {} })
  assert.match(fresh, /newbie_hollow/)
  assert.match(fresh, /50.*left|left/)
  const done = dungeonList({ level: 40, dungeonProgress: {} })
  assert.match(done, /graduated/)
})

// ─────────────────────────────────────────────────────────────────────────────
// The rewards ("gives them xp ... drops regular items and fame")
// ─────────────────────────────────────────────────────────────────────────────

function mkPlayer(level) {
  const t = getTotalStats('warrior', 'human', level)
  const p = {
    id: 'p@s.whatsapp.net', name: 'P', classId: 'warrior', raceId: 'human', level,
    xp: 0, hp: t.maxHp, maxHp: t.maxHp, mp: t.maxMp, maxMp: t.maxMp,
    stats: { str: t.str, agi: t.agi, int: t.int, def: t.def, lck: t.lck },
    baseStats: { str: t.str, agi: t.agi, int: t.int, def: t.def, lck: t.lck, maxHp: t.maxHp, maxMp: t.maxMp },
    wallet: { solars: 0, gems: 0 }, inventory: [], equipped: {}, fame: 0, skills: [],
    activeEffects: [], pets: [], beastInventory: [], summonedBeasts: [], abilityInventory: [],
    ownedCharacters: [], quests: {}, achievements: {}, location: NEWBIE_LOCATION_ID,
  }
  ensureStatPoints(p)
  return p
}
const ctx = () => ({ db: { data: { users: {}, season: null } }, from: 'p@s.whatsapp.net', isGroup: false, reply: async () => {} })

t('a Hollow kill pays several times the dungeon rate, and fame comes with it', () => {
  const far = mkPlayer(40)   // past the newcomer boost, so this is the lane itself
  const before = far.fame
  const r = creditKill(far, { name: 'Dust Rat', isBoss: false, xp: 50, solars: 17, drops: [] }, ctx(),
    { battleType: 'dungeon', killTurns: 2, locId: NEWBIE_LOCATION_ID })
  assert.ok(LOCATION_REWARD_MULT.newbie_hollow.xp >= 5, 'the Hollow must pay notably better than a normal dungeon')
  assert.equal(r.xp, speedKillXp(2) * LOCATION_REWARD_MULT.newbie_hollow.xp,
    'a full-speed Hollow kill pays the whole location multiplier')
  assert.equal(r.newcomerMult, 1, 'the newcomer boost must not apply to a level-40 player')
  assert.ok(far.fame > before, 'kills in the Hollow must still pay fame')
})

t('the newcomer boost stacks on top for anyone under level 20', () => {
  const young = mkPlayer(5)
  const r = creditKill(young, { name: 'Dust Rat', isBoss: false, xp: 50, solars: 17, drops: [] }, ctx(),
    { battleType: 'dungeon', killTurns: 2, locId: NEWBIE_LOCATION_ID })
  assert.equal(r.newcomerMult, NEWCOMER_BOOST.xpMult)
  assert.equal(r.xp, Math.floor(speedKillXp(2) * LOCATION_REWARD_MULT.newbie_hollow.xp * NEWCOMER_BOOST.xpMult))

  // ...and it also lifts ordinary dungeons, which is the point: a newcomer
  // grinding Entry Tower instead of the Hollow is not punished for it.
  const tower = mkPlayer(19)
  const r2 = creditKill(tower, { name: 'Grim Gargoyle', isBoss: false, xp: 50, solars: 17, drops: [] }, ctx(),
    { battleType: 'dungeon', killTurns: 2, locId: 'entry_tower' })
  assert.equal(r2.xp, Math.floor(speedKillXp(2) * NEWCOMER_BOOST.xpMult))
  assert.equal(newcomerXpMult({ level: 19 }), NEWCOMER_BOOST.xpMult)
  assert.equal(newcomerXpMult({ level: NEWCOMER_BOOST.untilLevel }), 1, 'it must switch off at the threshold')
  assert.equal(newcomerXpMult({ level: 100 }), 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// Veteran difficulty for level 100+ players
// ─────────────────────────────────────────────────────────────────────────────

t('the veteran tier is off below level 100 and grows with every level after', () => {
  assert.equal(veteranTier({ level: 1 }), null)
  assert.equal(veteranTier({ level: 99 }), null)
  assert.ok(veteranTier({ level: 100 }).hpMult > 1, 'level 100 is the start of the tier')

  let prev = veteranTier({ level: 100 })
  for (let level = 101; level <= 200; level += 10) {
    const cur = veteranTier({ level })
    assert.ok(cur.hpMult >= prev.hpMult, `HP scaling went backwards at level ${level}`)
    assert.ok(cur.atkMult >= prev.atkMult, `ATK scaling went backwards at level ${level}`)
    prev = cur
  }
  const maxed = veteranTier({ level: 200 })
  assert.equal(maxed.hpMult, VETERAN_SCALE.hpMax)
  assert.equal(maxed.atkMult, VETERAN_SCALE.atkMax)
  assert.equal(maxed.defMult, VETERAN_SCALE.defMax)
})

t('veteran scaling raises a monster in place and stamps it', () => {
  const enemy = { hp: 1000, maxHp: 1000, atk: 100, baseAtk: 100, def: 50, baseDef: 50 }
  const before = { ...enemy }
  applyVeteranScaling(enemy, { level: 200 })
  assert.ok(enemy.maxHp > before.maxHp && enemy.hp > before.hp)
  assert.ok(enemy.atk > before.atk)
  assert.ok(enemy.def > before.def)
  assert.equal(enemy.hp, enemy.maxHp)
  assert.equal(enemy.veteran.level, 200)
})

t('nothing below level 100 is touched at all', () => {
  const enemy = { hp: 1000, maxHp: 1000, atk: 100, baseAtk: 100, def: 50, baseDef: 50 }
  const copy = { ...enemy }
  applyVeteranScaling(enemy, { level: 99 })
  assert.deepEqual(enemy, copy, 'a level-99 player must meet exactly the authored enemy')
  assert.equal(veteranBanner({ level: 99 }), '')
  assert.match(veteranBanner({ level: 120 }), /Veteran/)
})

t('a swarm pack spends a fraction of the tier, not the whole thing', () => {
  // Packs are 2-4 monsters; a full bump on each is four walls for the price of
  // one floor. Two checks: the real spawn function stamps a PARTIAL multiplier
  // on every monster, and the same tier spent solo produces a bigger one. (The
  // pack composition itself is random, so the assertion is on the stamps — the
  // numbers the fight actually runs on — not on a raw HP total.)
  const stats = { str: 400, agi: 100, int: 100, def: 100, lck: 50 }
  const base = {
    classId: 'warrior', raceId: 'human', stats, baseStats: { ...stats, maxHp: 5000, maxMp: 500 },
    hp: 5000, maxHp: 5000, mp: 500, maxMp: 500, statPoints: { version: 2, earned: 0, spent: 0, unallocated: 0, allocations: {} },
    wallet: { solars: 0 }, inventory: [], equipped: {}, activeEffects: [],
  }
  const lvl99  = { ...base, id: 'a@s.whatsapp.net', name: 'A', level: 99 }
  const lvl101 = { ...base, id: 'b@s.whatsapp.net', name: 'B', level: 101 }

  const packA = buildSwarmFloor('eternal_dungeon', 95, lvl99)
  const packB = buildSwarmFloor('eternal_dungeon', 95, lvl101)
  assert.ok(packA?.monsters?.length && packB?.monsters?.length, 'the swarm must build')
  assert.ok(packA.monsters.every(m => !m.veteran), 'a level-99 pack must be untouched')
  assert.ok(packB.monsters.every(m => m.veteran?.level === 101), 'every monster in a veteran pack is scaled')

  const tier = veteranTier(lvl101)
  const weights = { hp: 0.5, atk: 0.6, def: 0.75 }
  for (const m of packB.monsters) {
    assert.ok(Math.abs(m.veteran.hpMult - (1 + (tier.hpMult - 1) * weights.hp)) < 1e-9,
      'the pack must spend the weighted fraction of the HP tier')
    assert.ok(m.veteran.hpMult < tier.hpMult, 'a pack monster must not take the full solo bump')
  }

  // Same tier, one enemy, full weight — the solo/1v1 profile the plugin uses.
  const solo = { hp: 1000, maxHp: 1000, atk: 100, baseAtk: 100, def: 50, baseDef: 50 }
  applyVeteranScaling(solo, lvl101)
  assert.ok(solo.maxHp / 1000 > packB.monsters[0].veteran.hpMult,
    'a solo enemy must take a bigger bump than one monster in a pack')
})
