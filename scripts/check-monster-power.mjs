/**
 * check-monster-power.mjs — is a regular monster actually a threat?
 *
 * The dungeon's whole promise is that deeper is more dangerous. That promise is
 * a claim about two numbers and nothing else:
 *
 *   hits to kill   how many monster attacks an on level player can absorb
 *   hits to clear  how many player attacks one monster costs
 *
 * A climb works when the first number falls with depth (danger) and the second
 * stays roughly flat (pace). This script prints both, at real depths, for three
 * reference players of the level each floor expects: naked, average gear, and
 * best in slot. The naked column is the one lib/combat-engine.js tunes against,
 * so the gap between it and the geared columns is exactly how much of the
 * difficulty curve equipment erases.
 *
 *   node scripts/check-monster-power.mjs
 *
 * Read only. Prints a table and never fails a build, because "balanced" is a
 * judgement and not an assertion.
 */
import { locations, allItems, getTotalStats } from '../lib/game-data.js'
import { monsterStatsAtFloor, applyDefense } from '../lib/combat-engine.js'
import { expectedLevelAtFloor } from '../lib/xp-regulator.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const monsters = require('../data/monsters.json')

const CLASS = 'warrior'   // str primary, the median case
const RACE  = 'human'

/* ── gear ──────────────────────────────────────────────────────────────────────
 * Player damage is the primary stat alone (see calcPlayerDamage), and equipment
 * reaches it by folding statBonuses into player.stats on equip. So a reference
 * loadout is just the sum of the str and maxHp and def bonuses of the best items
 * a player of that level could be holding. levelRequirement gates availability.
 */
const wearable = allItems.filter(
  (i) => i.statBonuses && ['weapon', 'armor', 'accessory', 'offhand'].includes(i.type),
)

function loadout(level, pick) {
  const totals = { str: 0, def: 0, maxHp: 0 }
  for (const slot of ['weapon', 'armor', 'accessory', 'offhand']) {
    const avail = wearable
      .filter((i) => i.type === slot && (i.levelRequirement ?? 1) <= level)
      .map((i) => ({
        item: i,
        str:   i.statBonuses.str   ?? 0,
        def:   i.statBonuses.def   ?? 0,
        maxHp: i.statBonuses.maxHp ?? 0,
      }))
    if (!avail.length) continue
    avail.sort((a, b) => (a.str + a.def + a.maxHp) - (b.str + b.def + b.maxHp))
    const chosen = pick === 'best' ? avail[avail.length - 1] : avail[Math.floor(avail.length / 2)]
    totals.str   += chosen.str
    totals.def   += chosen.def
    totals.maxHp += chosen.maxHp
  }
  return totals
}

function reference(level, pick) {
  const base = getTotalStats(CLASS, RACE, level)
  const gear = pick === 'naked' ? { str: 0, def: 0, maxHp: 0 } : loadout(level, pick)
  return {
    hp:  Math.round(base.maxHp + gear.maxHp),
    dmg: Math.round(base.str + gear.str),   // basic attack, no crit
    def: Math.round(base.def + gear.def),
  }
}

/* ── the player's own mitigation ───────────────────────────────────────────────
 * Monster damage against a player runs through the same percentage curve, so a
 * geared player's DEF cuts incoming damage as well as raising HP. Both effects
 * have to be in the readout or the geared columns lie in the player's favour.
 */
const incoming = (monsterAtk, playerDef) => applyDefense(monsterAtk, playerDef)

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const dungeons = locations.filter((l) => l.type === 'dungeon' && l.floors > 1)

console.log('\nMONSTER POWER vs THE PLAYER THE FLOOR EXPECTS')
console.log('hits to kill  = monster attacks the player can absorb   (want this to FALL with depth)')
console.log('hits to clear = player attacks one monster costs        (want this roughly FLAT)\n')

for (const loc of dungeons) {
  console.log(`── ${loc.name}  (levels ${loc.levelRange[0]} to ${loc.levelRange[1]}, ${loc.floors} floors)`)
  console.log('   floor  lv  |        naked        |     average gear    |      best gear')
  console.log('              |  kill / clear  hp   |  kill / clear  hp   |  kill / clear  hp')

  // Sample by depth fraction rather than off bossFloors, so a dungeon with a
  // single guardian on its last floor still shows its whole curve. A sample that
  // lands on a boss floor steps back one, since boss floors hold no regulars.
  const bossSet = new Set(loc.bossFloors ?? [])
  const probe = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99]
    .map((t) => Math.max(1, Math.round(1 + t * (loc.floors - 1))))
    .map((f) => (bossSet.has(f) ? Math.max(1, f - 1) : f))
  const seen = new Set()

  for (const floor of probe) {
    if (seen.has(floor)) continue
    seen.add(floor)
    const pool = monsters.regular.filter(
      (m) => m.locationId === loc.id && m.tier === 'regular' &&
             floor >= m.floorRange[0] && floor <= m.floorRange[1],
    )
    if (!pool.length) continue

    const rolled = pool.map((m) => monsterStatsAtFloor(m, floor))
    const mHp  = median(rolled.map((r) => r.hp))
    const mAtk = median(rolled.map((r) => r.atk))
    const mDef = median(rolled.map((r) => r.def))
    const level = expectedLevelAtFloor(loc.id, floor)

    const cells = ['naked', 'avg', 'best'].map((pick) => {
      const p = reference(level, pick)
      const taken = Math.max(1, incoming(mAtk, p.def))
      const dealt = Math.max(1, applyDefense(p.dmg, mDef))
      const kill  = Math.ceil(p.hp / taken)
      const clear = Math.ceil(mHp / dealt)
      return `${String(kill).padStart(4)} /${String(clear).padStart(5)} ${String(p.hp).padStart(6)}`
    })

    console.log(
      `   ${String(floor).padStart(5)} ${String(level).padStart(3)}  | ` +
      cells.join(' | '),
    )
  }
  console.log(`          monster on the last probed floor: hp ${median(monsters.regular
    .filter((m) => m.locationId === loc.id && m.tier === 'regular')
    .map((m) => monsterStatsAtFloor(m, loc.floors - 1).hp))}\n`)
}

console.log('A monster that needs more than about a dozen hits to kill an on level player')
console.log('cannot threaten a geared one, and a fight that costs more than a handful of')
console.log('attacks per monster cannot be repeated four times on one floor.')
