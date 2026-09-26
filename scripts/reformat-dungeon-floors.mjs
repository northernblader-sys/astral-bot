/**
 * reformat-dungeon-floors.mjs — one shot migration, 1000 floor dungeons to 100.
 *
 * Every main dungeon becomes a bounded 100 floor climb with a boss every 10
 * floors and the location's true master on floor 100. Nothing is thrown away:
 * the ten existing bosses per dungeon keep their ids and their stats, they just
 * move from floors 100..1000 to 10..100, which is the same relative depth.
 *
 * Three files hold floor numbers and all three must move together:
 *   data/locations.json        floors, bossFloors, checkpointInterval
 *   data/monsters.json         regular floorRange + per floor scaling, boss floor
 *   data/anime-boss-slots.json the real anime boss assigned to each boss slot
 *
 * Monster stats are preserved by curve, not by value. A monster's power is
 * base + perFloor * floor, so compressing the floor axis by 10 means the per
 * floor scaling is multiplied by 10. A monster that was worth fighting on old
 * floor 700 is worth exactly the same on new floor 70.
 *
 * Idempotent: a location is only migrated when it still reads floors: 1000.
 *
 *   node scripts/reformat-dungeon-floors.mjs          dry run, prints the plan
 *   node scripts/reformat-dungeon-floors.mjs --write  writes the files
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA   = join(ROOT, 'data')
const WRITE  = process.argv.includes('--write')

const SQUEEZE       = 10   // old floors per new floor
const TARGET_FLOORS = 100  // every main dungeon ends here
const BOSS_EVERY    = 10   // one boss per ten floors, tenth boss is the master

const read  = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'))
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const r2    = (n) => Math.round(n * 100) / 100

/**
 * Stringify in the repo's style: 2 space indent, then escape every non ASCII
 * character back to \uXXXX so the file keeps the exact byte shape it had
 * before this migration touched it.
 */
const NON_ASCII = new RegExp("[\u0080-\uFFFF]", "g")
const HEX = (c) => c.charCodeAt(0).toString(16).padStart(4, "0")
function serialize(value) {
  const body = JSON.stringify(value, null, 2)
    .replace(NON_ASCII, (c) => String.fromCharCode(92) + "u" + HEX(c))
  return body + String.fromCharCode(10)
}

const locations  = read('locations.json')
const monsters   = read('monsters.json')
const animeSlots = read('anime-boss-slots.json')

/* ── which locations move ─────────────────────────────────────────────────── */

const moving = new Set(
  locations
    .filter((l) => l.type === 'dungeon' && l.floors === SQUEEZE * TARGET_FLOORS)
    .map((l) => l.id),
)

if (moving.size === 0) {
  console.log('Nothing to do. No dungeon still reads floors: ' + SQUEEZE * TARGET_FLOORS + '.')
  console.log('Already migrated dungeons are left untouched, this script is idempotent.')
}

console.log('\n=== DUNGEONS TO COMPRESS ===')
for (const id of moving) console.log('  ' + id)

/* ── locations ────────────────────────────────────────────────────────────── */

const bossFloorsFor = () =>
  Array.from({ length: TARGET_FLOORS / BOSS_EVERY }, (_, i) => (i + 1) * BOSS_EVERY)

console.log('\n=== locations.json ===')
for (const loc of locations) {
  if (moving.has(loc.id)) {
    const before = `floors ${loc.floors}, bosses at ${loc.bossFloors.join('/')}`
    loc.floors             = TARGET_FLOORS
    loc.bossFloors         = bossFloorsFor()
    loc.checkpointInterval = BOSS_EVERY
    console.log(`  ${loc.id.padEnd(20)} ${before}`)
    console.log(`  ${''.padEnd(20)}   -> floors ${loc.floors}, bosses at ${loc.bossFloors.join('/')}, checkpoint every ${BOSS_EVERY}`)
  } else if (loc.type === 'dungeon' && loc.floors === TARGET_FLOORS && loc.checkpointInterval > BOSS_EVERY) {
    // entry_tower is already a 100 floor climb, only its checkpoint text is stale.
    console.log(`  ${loc.id.padEnd(20)} checkpointInterval ${loc.checkpointInterval} -> ${BOSS_EVERY}`)
    loc.checkpointInterval = BOSS_EVERY
  }
}

/* ── regular monsters ─────────────────────────────────────────────────────── */

let touchedRegular = 0
const parityChecks = []

for (const m of monsters.regular) {
  if (!moving.has(m.locationId)) continue

  const [oldLo, oldHi] = m.floorRange
  const newLo = clamp(Math.ceil(oldLo / SQUEEZE), 1, TARGET_FLOORS)
  const newHi = clamp(Math.max(newLo, Math.ceil(oldHi / SQUEEZE)), newLo, TARGET_FLOORS)

  // Parity is a statement about the curve, not about one floor. Because the new
  // per floor scaling is the old one times SQUEEZE, power at new floor F must
  // equal power at old floor F * SQUEEZE exactly. Sample at the deep end of the
  // monster's new band and compare against its old world equivalent.
  const newSample = newHi
  const oldEquiv  = newHi * SQUEEZE
  const oldPower = {
    hp:  Math.round(m.baseStats.hp  + m.scaling.hpPerFloor  * oldEquiv),
    def: Math.round(m.baseStats.def + m.scaling.defPerFloor * oldEquiv),
    atk: Math.round(m.baseStats.atk + m.scaling.atkPerFloor * oldEquiv),
  }

  m.floorRange = [newLo, newHi]
  m.scaling = {
    hpPerFloor:  r2(m.scaling.hpPerFloor  * SQUEEZE),
    defPerFloor: r2(m.scaling.defPerFloor * SQUEEZE),
    atkPerFloor: r2(m.scaling.atkPerFloor * SQUEEZE),
  }
  if (m.rewards) {
    // Ignored by the engine (lib/xp-regulator.js is the source of truth for
    // rewards) but kept coherent so the file does not lie to the next reader.
    m.rewards.xpPerFloor     = r2((m.rewards.xpPerFloor     ?? 0) * SQUEEZE)
    m.rewards.solarsPerFloor = r2((m.rewards.solarsPerFloor ?? 0) * SQUEEZE)
  }

  const newPower = {
    hp:  Math.round(m.baseStats.hp  + m.scaling.hpPerFloor  * newSample),
    def: Math.round(m.baseStats.def + m.scaling.defPerFloor * newSample),
    atk: Math.round(m.baseStats.atk + m.scaling.atkPerFloor * newSample),
  }
  parityChecks.push({ id: m.id, oldEquiv, newSample, oldBand: [oldLo, oldHi], newBand: [newLo, newHi], oldPower, newPower })
  touchedRegular += 1
}

console.log(`\n=== monsters.json regular ===\n  ${touchedRegular} monsters remapped`)

/* ── bosses ───────────────────────────────────────────────────────────────── */

console.log('\n=== monsters.json bosses ===')
let touchedBosses = 0
for (const b of monsters.bosses) {
  if (!moving.has(b.locationId)) continue
  const oldFloor = b.floor
  b.floor = clamp(Math.round(oldFloor / SQUEEZE), BOSS_EVERY, TARGET_FLOORS)
  const master = b.floor === TARGET_FLOORS ? '   <- MASTER' : ''
  console.log(`  ${b.locationId.padEnd(19)} ${String(oldFloor).padStart(4)} -> ${String(b.floor).padStart(3)}  ${b.name}${master}`)
  touchedBosses += 1
}
console.log(`  ids left unchanged on purpose, player trophies and conquest records key off them`)

/* ── anime boss slots ─────────────────────────────────────────────────────── */

console.log('\n=== anime-boss-slots.json ===')
let touchedSlots = 0
for (const s of animeSlots) {
  if (!moving.has(s.locationId)) continue
  const oldFloor = s.floor
  s.floor = clamp(Math.round(oldFloor / SQUEEZE), BOSS_EVERY, TARGET_FLOORS)
  console.log(`  ${s.locationId.padEnd(19)} ${String(oldFloor).padStart(4)} -> ${String(s.floor).padStart(3)}  ${s.bossId}`)
  touchedSlots += 1
}

/* ── verification ─────────────────────────────────────────────────────────── */

const problems = []
const warnings = []

for (const loc of locations) {
  if (loc.type !== 'dungeon' || !loc.floors) continue
  const pool = monsters.regular.filter((m) => m.locationId === loc.id)
  if (!pool.length) continue
  // Only the dungeons this migration actually rewrote can block the write.
  // Anything already broken elsewhere is reported but not this script's to fix.
  const bucket = moving.has(loc.id) ? problems : warnings

  const gaps = []
  for (let f = 1; f <= loc.floors; f++) {
    if ((loc.bossFloors ?? []).includes(f)) continue // a boss owns that floor
    const here = pool.filter((m) => f >= m.floorRange[0] && f <= m.floorRange[1] && m.tier === 'regular')
    if (!here.length) gaps.push(f)
  }
  if (gaps.length) bucket.push(`${loc.id}: no regular monster on floor(s) ${gaps.join(', ')}`)

  for (const bf of loc.bossFloors ?? []) {
    const boss = monsters.bosses.find((b) => b.locationId === loc.id && b.floor === bf)
    if (!boss) bucket.push(`${loc.id}: boss floor ${bf} has no boss in monsters.json`)
    const slot = animeSlots.find((s) => s.locationId === loc.id && s.floor === bf)
    if (!slot) bucket.push(`${loc.id}: boss floor ${bf} has no anime boss slot`)
  }
  const strayBosses = monsters.bosses
    .filter((b) => b.locationId === loc.id && !(loc.bossFloors ?? []).includes(b.floor))
  for (const b of strayBosses) bucket.push(`${loc.id}: boss ${b.id} sits on floor ${b.floor}, not a boss floor`)
  const straySlots = animeSlots
    .filter((s) => s.locationId === loc.id && !(loc.bossFloors ?? []).includes(s.floor))
  for (const s of straySlots) bucket.push(`${loc.id}: anime slot ${s.bossId} sits on floor ${s.floor}, not a boss floor`)
}

const drift = parityChecks.filter((c) => {
  const d = (a, b) => Math.abs(a - b) > Math.max(2, Math.abs(a) * 0.02)
  return d(c.oldPower.hp, c.newPower.hp) || d(c.oldPower.def, c.newPower.def) || d(c.oldPower.atk, c.newPower.atk)
})

console.log('\n=== STAT PARITY (new floor F must equal old floor F x ' + SQUEEZE + ') ===')
for (const c of parityChecks.slice(0, 6)) {
  console.log(`  ${c.id.padEnd(28)} band ${c.oldBand.join('-').padEnd(9)} -> ${c.newBand.join('-')}`)
  console.log(`  ${''.padEnd(28)} old f${String(c.oldEquiv).padStart(4)}  hp ${String(c.oldPower.hp).padStart(6)} def ${String(c.oldPower.def).padStart(4)} atk ${String(c.oldPower.atk).padStart(5)}`)
  console.log(`  ${''.padEnd(28)} new f${String(c.newSample).padStart(4)}  hp ${String(c.newPower.hp).padStart(6)} def ${String(c.newPower.def).padStart(4)} atk ${String(c.newPower.atk).padStart(5)}`)
}
console.log(`  ...${parityChecks.length} monsters checked, ${drift.length} off by more than 2%`)
for (const c of drift.slice(0, 10)) {
  console.log(`  DRIFT ${c.id}: ${JSON.stringify(c.oldPower)} -> ${JSON.stringify(c.newPower)}`)
}
if (drift.length) problems.push(`${drift.length} monsters lost stat parity, the scaling multiply is wrong`)

console.log('\n=== VERIFY ===')
if (problems.length) {
  for (const p of problems) console.log('  FAIL  ' + p)
} else {
  console.log('  OK  every non boss floor has a regular monster')
  console.log('  OK  every boss floor has a boss and an anime boss')
  console.log('  OK  no boss or anime slot is stranded off a boss floor')
  console.log('  OK  stat parity held on all ' + parityChecks.length + ' remapped monsters')
}
for (const w of warnings) console.log('  WARN  ' + w + '  (pre existing, not touched by this migration)')

/* ── write ────────────────────────────────────────────────────────────────── */

if (!WRITE) {
  console.log('\nDry run. Nothing written. Re run with --write to apply.')
  process.exit(problems.length ? 1 : 0)
}
if (problems.length) {
  console.log('\nRefusing to write while verification fails.')
  process.exit(1)
}

const stamp  = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(DATA, '.backup-floors-' + stamp)
mkdirSync(backup, { recursive: true })
for (const f of ['locations.json', 'monsters.json', 'anime-boss-slots.json']) {
  copyFileSync(join(DATA, f), join(backup, f))
}
writeFileSync(join(DATA, 'locations.json'), serialize(locations))
writeFileSync(join(DATA, 'monsters.json'), serialize(monsters))
writeFileSync(join(DATA, 'anime-boss-slots.json'), serialize(animeSlots))

console.log(`\nWrote locations.json, monsters.json, anime-boss-slots.json`)
console.log(`Originals copied to data/.backup-floors-${stamp}/`)
console.log(`  ${touchedRegular} regular monsters, ${touchedBosses} bosses, ${touchedSlots} anime boss slots`)
