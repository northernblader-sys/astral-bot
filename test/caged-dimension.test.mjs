/**
 * caged-dimension.test.mjs — pins The Caged Dimension as the wall it claims to be.
 *
 * WHY. data/locations.json sells the zone as "sealed away because nothing else
 * could contain them", "even the strongest titled hunters struggle to survive",
 * and pays the roster's highest rewards for it (10x XP / 8x Solars, see
 * LOCATION_REWARD_MULT in lib/xp-regulator.js). The numbers did not agree:
 * measured with scripts/check-monster-power.mjs, a floor-level player died in
 * 3 monster attacks and needed 6 of their own, which is eternal_dungeon's
 * shape, two tiers below. And it could not be fixed in data/monsters.json: the
 * eight caged monsters' own hp/atk/def are read only for ARCHETYPE and the
 * global curve then re-pins them to clearTurnsDeep 6 / survivalTurnsDeep 3.5,
 * so the pool was capped by design at "moderate". The dials that could move it
 * are LOCATION_DIFFICULTY in lib/combat-engine.js.
 *
 * What "godly" means as of 2026-09-22, and what this file holds the line on:
 *
 *   a best-in-slot player of the level the floor expects dies in 2 attacks
 *   one monster costs ~13 to ~22 of that player's own attacks
 *   their armour removes ~half the damage landed on it
 *   Ruin Shade shows up on about 45% of floors instead of 15%
 *   an over-levelled player drags the enemy up with them at hpExp 1.0 rather
 *     than the global squishy 0.85, so the zone stops shrinking for whales
 *   and a 21-turn kill there still pays full speed-band XP, because the band
 *     is anchored to the location's own clear target (LOCATION_KILL_XP_BAND)
 *
 * Section 4 is the half that matters most to everyone else: the four main
 * dungeons and the entry tower balance off the untouched globals, and the
 * numbers pinned there are measured from before the change. If one of them
 * moves, somebody edited REGULAR_MONSTER_BALANCE itself instead of the
 * per-location override, and every dungeon in the bot just moved with it.
 *
 * Run:  node test/caged-dimension.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  allItems, getTotalStats, regularByLoc, locationsMap,
} from '../lib/game-data.js'
import {
  monsterStatsAtFloor, pickMonsterForFloor, applyDefense,
  enemyPowerRatio, scaleEnemyToPlayer, LOCATION_DIFFICULTY,
} from '../lib/combat-engine.js'
import {
  expectedLevelAtFloor, speedKillXp, DUNGEON_KILL_XP,
  LOCATION_KILL_XP_BAND, LOCATION_REWARD_MULT,
} from '../lib/xp-regulator.js'

const require = createRequire(import.meta.url)
const monsters = require('../data/monsters.json')

const CAGED = 'caged_dimension'
const CLASS = 'warrior'   // str primary, the median case, as in check-monster-power.mjs
const RACE  = 'human'

let passed = 0
const failures = []
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push(name); console.log(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`) }
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Every *regular* monster the floor can roll, balanced, with no player-power
 * scaling applied. Elites are deliberately out: they are a flat multiplier on
 * these same numbers, so mixing them in would move the medians on spawn rate
 * and make the regression pins in section 4 lie.
 */
function floorPool(locId, floor) {
  return monsters.regular
    .filter(m => m.locationId === locId && m.tier === 'regular'
      && floor >= m.floorRange[0] && floor <= m.floorRange[1])
    .map(m => ({ ...m, ...monsterStatsAtFloor(m, floor) }))
}

/**
 * Best-in-slot loadout, computed the same way scripts/check-monster-power.mjs
 * does it, so this suite and that readout can never disagree about what a
 * geared player is: sum the best level-gated item in each of the four slots.
 */
const wearable = allItems.filter(
  i => i.statBonuses && ['weapon', 'armor', 'accessory', 'offhand'].includes(i.type),
)
function bestGear(level) {
  const t = { str: 0, def: 0, maxHp: 0 }
  for (const slot of ['weapon', 'armor', 'accessory', 'offhand']) {
    const avail = wearable.filter(i => i.type === slot && (i.levelRequirement ?? 1) <= level)
    if (!avail.length) continue
    const best = avail.reduce((a, b) =>
      ((b.statBonuses.str ?? 0) + (b.statBonuses.def ?? 0) + (b.statBonuses.maxHp ?? 0)) >
      ((a.statBonuses.str ?? 0) + (a.statBonuses.def ?? 0) + (a.statBonuses.maxHp ?? 0)) ? b : a)
    t.str += best.statBonuses.str ?? 0
    t.def += best.statBonuses.def ?? 0
    t.maxHp += best.statBonuses.maxHp ?? 0
  }
  return t
}

function gearedPlayer(level) {
  const base = getTotalStats(CLASS, RACE, level)
  const gear = bestGear(level)
  return {
    hp:  base.maxHp + gear.maxHp,
    dmg: base.str + gear.str,
    def: base.def + gear.def,
  }
}

/** hits to die / hits to clear, for the best-in-slot player the floor expects. */
function exchange(locId, floor) {
  const pool = floorPool(locId, floor)
  const p = gearedPlayer(expectedLevelAtFloor(locId, floor))
  const taken = Math.max(1, applyDefense(median(pool.map(m => m.atk)), p.def))
  const dealt = Math.max(1, applyDefense(p.dmg, median(pool.map(m => m.def))))
  return {
    diesIn:   Math.ceil(p.hp / taken),
    clearsIn: Math.ceil(median(pool.map(m => m.hp)) / dealt),
    mitigation: median(pool.map(m => m.def)) / (median(pool.map(m => m.def)) + 500),
  }
}

console.log('── 1. the override exists, and only for the Caged Dimension ────')
ok('LOCATION_DIFFICULTY covers caged_dimension and nothing else', () => {
  assert.deepEqual(Object.keys(LOCATION_DIFFICULTY), [CAGED],
    'every key here is a dungeon-wide difficulty change, so adding one is a decision, not a tweak')
})
ok('the location is still the endless, boss-less grind its data says it is', () => {
  const loc = locationsMap[CAGED]
  assert.equal(loc.floors, 9999)
  assert.equal(loc.levelRange[0], 152)
  assert.deepEqual(loc.bossFloors, [], 'boss floors would outrun the regular balance this suite pins')
  assert.equal(loc.prerequisite, 'eternal_dungeon')
})
ok('its eight-monster roster carries no per-floor scaling of its own', () => {
  // The pool authors hp 350-1200 / atk 700-1600 / def 30-150 with scaling at
  // zero, which is exactly why the difficulty had to arrive as a balance dial
  // rather than as bigger numbers in the JSON.
  const pool = monsters.regular.filter(m => m.locationId === CAGED)
  assert.equal(pool.length, 8)
  for (const m of pool) {
    assert.deepEqual(m.scaling, { hpPerFloor: 0, defPerFloor: 0, atkPerFloor: 0 }, m.id)
  }
  assert.equal(pool.filter(m => m.tier === 'elite').length, 1, 'Ruin Shade is the elite of the pool')
})

console.log('\n── 2. what a fight in there is now like ────────────────────────')
for (const floor of [1, 500, 5000, 9999]) {
  const x = exchange(CAGED, floor)
  ok(`floor ${floor}: a geared floor-level player dies in <= 2 attacks`, () => {
    assert.ok(x.diesIn <= 2, `dies in ${x.diesIn}`)
  })
  ok(`floor ${floor}: and pays 12+ attacks per monster (was 4 to 6)`, () => {
    assert.ok(x.clearsIn >= 12, `clears in ${x.clearsIn}`)
  })
  ok(`floor ${floor}: armour is real, not decorative (>= 35% cut)`, () => {
    assert.ok(x.mitigation >= 0.35, `mitigation ${(x.mitigation * 100).toFixed(0)}%`)
  })
}
ok('the deep end is not gentler than the door', () => {
  // caged_dimension's depth is pinned to 0.7 minimum (LOCATION_MIN_DEPTH), so
  // floor 1 already sits in the deep end. The old bug in every other zone was
  // depth meaning nothing; here depth still cannot make floor 1 the soft one.
  assert.ok(exchange(CAGED, 9999).diesIn <= exchange(CAGED, 1).diesIn)
  assert.ok(exchange(CAGED, 9999).clearsIn >= exchange(CAGED, 1).clearsIn)
})

console.log('\n── 3. the two levers that live outside the balance constants ──')
ok('elites are 45% of caged floors and still 15% everywhere else', () => {
  const N = 4000
  const roll = (loc) => {
    let e = 0
    for (let i = 0; i < N; i++) if (pickMonsterForFloor(loc, 60, regularByLoc)?.tier === 'elite') e++
    return e / N
  }
  const caged = roll(CAGED)
  const eternal = roll('eternal_dungeon')
  assert.ok(caged > 0.38 && caged < 0.52, `caged elite rate ${caged.toFixed(3)}`)
  assert.ok(eternal > 0.08 && eternal < 0.23, `eternal elite rate ${eternal.toFixed(3)}`)
})
ok('a whale drags a caged enemy up harder than an eternal one, same ratio', () => {
  const mk = (locId) => ({ locationId: locId, maxHp: 1000, hp: 1000, atk: 100, def: 100, baseAtk: 100, baseDef: 100 })
  const ratio = 4
  const caged = scaleEnemyToPlayer(mk(CAGED), ratio, { hpExp: 0.85, atkExp: 0.4, defExp: 0.2 })
  const eternal = scaleEnemyToPlayer(mk('eternal_dungeon'), ratio, { hpExp: 0.85, atkExp: 0.4, defExp: 0.2 })
  assert.ok(caged.maxHp > eternal.maxHp, `caged ${caged.maxHp} vs eternal ${eternal.maxHp}`)
  assert.ok(caged.atk > eternal.atk, `caged ${caged.atk} vs eternal ${eternal.atk}`)
  // hpExp 1.0 means the HP is exactly ratio x what the curve produced.
  assert.equal(caged.maxHp, 4000)
})
ok('an on-curve player is untouched by scaling, in either direction', () => {
  const enemy = { locationId: CAGED, maxHp: 1234, hp: 1234, atk: 100, def: 50 }
  assert.equal(scaleEnemyToPlayer(enemy, 1).maxHp, 1234, 'ratio 1 must be a no-op')
  assert.equal(enemyPowerRatio({ classId: CLASS, stats: { str: 1 }, activeEffects: [] }, CAGED, 1), 1,
    'a weaker-than-expected player must not be buffed into an easier fight')
})

console.log('\n── 4. REGRESSION PINS: every other dungeon is bit-for-bit the same ──')
// Measured on 2026-09-22 against master WITHOUT the override, by stashing
// lib/combat-engine.js and re-running this exact computation. They are the
// guard on "we moved the per-location dial, not the global one".
const BASELINE = {
  'entry_tower':        { floor: 25, hp: 161,  atk: 38,   def: 35 },
  'gambits_dungeon':    { floor: 89, hp: 802,  atk: 323,  def: 87 },
  'centurions_dungeon': { floor: 60, hp: 1355, atk: 187,  def: 82 },
  'eternal_dungeon':    { floor: 50, hp: 1255, atk: 315,  def: 80 },
}
for (const [locId, want] of Object.entries(BASELINE)) {
  ok(`${locId} floor ${want.floor} unchanged`, () => {
    const pool = floorPool(locId, want.floor)
    assert.ok(pool.length, `${locId} has no monsters on floor ${want.floor} any more`)
    assert.equal(median(pool.map(m => m.hp)), want.hp, 'hp')
    assert.equal(median(pool.map(m => m.atk)), want.atk, 'atk')
    assert.equal(median(pool.map(m => m.def)), want.def, 'def')
  })
}
ok('the four main dungeons plus the tower still balance off the global curve', () => {
  // If these targets ever move, LOCATION_DIFFICULTY is not where it happened.
  assert.equal(DUNGEON_KILL_XP.fastTurns, 2)
  assert.equal(DUNGEON_KILL_XP.slowTurns, 8)
  for (const loc of ['entry_tower', 'gambits_dungeon', 'centurions_dungeon', 'eternal_dungeon']) {
    const x = exchange(loc, loc === 'entry_tower' ? 25 : 50)
    assert.ok(x.clearsIn <= 14, `${loc} became a slog: ${x.clearsIn} attacks per monster`)
  }
})

console.log('\n── 5. rewards keep the promise the difficulty is being paid for ──')
ok('the caged speed band is re-anchored to the caged clear target', () => {
  assert.deepEqual(LOCATION_KILL_XP_BAND[CAGED], { fastTurns: 11, slowTurns: 33 })
  const tuned = exchange(CAGED, 1).clearsIn
  assert.ok(speedKillXp(tuned, CAGED) > 40,
    `a kill on the tuned pace (${tuned} turns) must not pay the floor rate`)
  assert.ok(speedKillXp(tuned, 'eternal_dungeon') < speedKillXp(tuned, CAGED),
    'the global band must still treat a 20 turn kill as slow, elsewhere')
  assert.equal(speedKillXp(2, CAGED), DUNGEON_KILL_XP.max, 'a fast caged kill still tops out')
  assert.equal(speedKillXp(999, CAGED), DUNGEON_KILL_XP.min, 'and a crawl still bottoms at the same floor')
})
ok('the location still pays its headline 10x XP / 8x Solars', () => {
  assert.deepEqual(LOCATION_REWARD_MULT[CAGED], { xp: 10, solars: 8 })
})
ok('entry is still gated behind eternal_dungeon, so nobody wanders in naked', () => {
  // The one genuine mercy in here: the zone will delete a floor-level player in
  // two hits, which is only fair because reaching it requires clearing the
  // dungeon below it (see plugins/dungeon.js's isDungeonUnlocked).
  assert.equal(locationsMap[CAGED].prerequisite, 'eternal_dungeon')
  assert.equal(locationsMap[CAGED].travelCost, 500)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
