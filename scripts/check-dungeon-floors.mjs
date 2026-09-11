/**
 * check-dungeon-floors.mjs — permanent guard on dungeon shape.
 *
 * Every main dungeon is a bounded 100 floor climb: a boss every 10 floors, the
 * tenth of them being that location's master on floor 100. This script asserts
 * the three data files that encode floor numbers still agree with each other,
 * because a silent disagreement means either a floor with nothing to fight or a
 * boss slot the player can never reach.
 *
 *   node scripts/check-dungeon-floors.mjs
 *
 * Exits non zero on the first real failure so it can gate a deploy.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'))

const locations  = read('locations.json')
const monsters   = read('monsters.json')
const animeSlots = read('anime-boss-slots.json')

const MAIN_FLOORS = 100
const BOSS_EVERY  = 10
// Dungeons that are deliberately not the standard 100 floor climb. The only one
// left is The End, a single bespoke rift. Every other dungeon, the season one
// included, is 100 floors and none may go past it.
const EXEMPT = new Set(['the_end'])
// The End is a single bespoke rift: plugins/dungeon.js builds its fight straight
// from bosses/the_end.js via initBossFight, so it has no monsters.json boss and
// no anime boss slot by design. Checking it for either would report a fake bug.
const BESPOKE_BOSS = new Set(['the_end'])

const fails = []
const notes = []
const fail = (msg) => fails.push(msg)

const dungeons = locations.filter((l) => l.type === 'dungeon' && l.floors)
const locIds   = new Set(locations.map((l) => l.id))

console.log('DUNGEON FLOOR SHAPE\n')

for (const loc of dungeons) {
  const label = loc.id.padEnd(20)
  const regulars = monsters.regular.filter((m) => m.locationId === loc.id)
  const bosses   = monsters.bosses.filter((b) => b.locationId === loc.id)
  const slots    = animeSlots.filter((s) => s.locationId === loc.id)
  const bossFloors = loc.bossFloors ?? []

  /* shape */
  // The ceiling is absolute and applies even to the exempt bespoke rift: no
  // dungeon anywhere may go past floor 100.
  if (loc.floors > MAIN_FLOORS) {
    fail(`${loc.id}: floors is ${loc.floors}, no dungeon may go past ${MAIN_FLOORS}`)
  }
  if (!EXEMPT.has(loc.id)) {
    if (loc.floors !== MAIN_FLOORS) {
      fail(`${loc.id}: floors is ${loc.floors}, every main dungeon must be ${MAIN_FLOORS}`)
    }
    const wantBosses = Array.from({ length: MAIN_FLOORS / BOSS_EVERY }, (_, i) => (i + 1) * BOSS_EVERY)
    const isEntry = bossFloors.length === 1 && bossFloors[0] === MAIN_FLOORS
    if (!isEntry && bossFloors.join(',') !== wantBosses.join(',')) {
      fail(`${loc.id}: bossFloors is ${bossFloors.join('/')}, expected ${wantBosses.join('/')} or just ${MAIN_FLOORS}`)
    }
    if (bossFloors.length && bossFloors[bossFloors.length - 1] !== loc.floors) {
      fail(`${loc.id}: the master must sit on the last floor, ${loc.floors}, not ${bossFloors[bossFloors.length - 1]}`)
    }
  }

  /* every floor has something to fight */
  const gaps = []
  for (let f = 1; f <= loc.floors; f++) {
    if (bossFloors.includes(f)) continue
    const here = regulars.filter((m) => m.tier === 'regular' && f >= m.floorRange[0] && f <= m.floorRange[1])
    if (!here.length) gaps.push(f)
  }
  if (gaps.length) {
    const shown = gaps.length > 12 ? `${gaps.slice(0, 12).join(', ')} and ${gaps.length - 12} more` : gaps.join(', ')
    fail(`${loc.id}: no regular monster on floor(s) ${shown}`)
  }

  /* floorRange sanity */
  for (const m of regulars) {
    const [lo, hi] = m.floorRange ?? []
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) fail(`${m.id}: floorRange is not a pair of integers`)
    else if (lo < 1 || hi < lo) fail(`${m.id}: floorRange ${lo}-${hi} is inverted or starts below floor 1`)
    else if (hi > loc.floors) fail(`${m.id}: floorRange ends on floor ${hi}, past ${loc.id}'s last floor ${loc.floors}`)
  }

  /* bosses and anime bosses line up with the boss floors */
  if (!BESPOKE_BOSS.has(loc.id)) {
    for (const bf of bossFloors) {
      if (!bosses.some((b) => b.floor === bf)) fail(`${loc.id}: boss floor ${bf} has no boss in monsters.json`)
      if (!slots.some((s) => s.floor === bf))  fail(`${loc.id}: boss floor ${bf} has no anime boss slot`)
    }
  }
  for (const b of bosses) {
    if (!bossFloors.includes(b.floor)) fail(`${loc.id}: boss ${b.id} sits on floor ${b.floor}, which is not a boss floor`)
  }
  for (const s of slots) {
    if (!bossFloors.includes(s.floor)) fail(`${loc.id}: anime slot ${s.bossId} sits on floor ${s.floor}, which is not a boss floor`)
  }
  const dupes = bosses.map((b) => b.floor).filter((f, i, a) => a.indexOf(f) !== i)
  if (dupes.length) fail(`${loc.id}: two bosses share floor(s) ${[...new Set(dupes)].join(', ')}`)

  const elites = regulars.filter((m) => m.tier === 'elite').length
  const eliteless = []
  for (let f = 1; f <= loc.floors; f++) {
    if (bossFloors.includes(f)) continue
    if (!regulars.some((m) => m.tier === 'elite' && f >= m.floorRange[0] && f <= m.floorRange[1])) eliteless.push(f)
  }
  if (eliteless.length) notes.push(`${loc.id}: ${eliteless.length} floor(s) can never roll an elite`)

  console.log(
    `  ${label} floors ${String(loc.floors).padStart(3)}  bosses ${String(bossFloors.length).padStart(2)}` +
    `  regulars ${String(regulars.filter((m) => m.tier === 'regular').length).padStart(3)}` +
    `  elites ${String(elites).padStart(3)}` +
    `  anime slots ${String(slots.length).padStart(2)}`,
  )
}

/* orphans */
for (const m of [...monsters.regular, ...monsters.bosses]) {
  if (!locIds.has(m.locationId)) fail(`${m.id}: locationId "${m.locationId}" is not in locations.json`)
}
for (const s of animeSlots) {
  if (!locIds.has(s.locationId)) fail(`anime slot ${s.bossId}: locationId "${s.locationId}" is not in locations.json`)
}

console.log('')
for (const n of notes) console.log('  NOTE  ' + n)
if (fails.length) {
  console.log('')
  for (const f of fails) console.log('  FAIL  ' + f)
  console.log(`\n${fails.length} failure(s).`)
  process.exit(1)
}
console.log('\n  OK  every dungeon is a bounded climb, every floor has something on it,')
console.log('      and every boss floor has both a boss and an anime boss behind it.')
