/**
 * test/stat-loss-guards.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression suite for the "player stats keep dropping" investigation. Three
 * distinct ways the sheet could silently lose permanently-earned value, each
 * one reproduced against the REAL modules (no mocks of the code under test):
 *
 *  1. RAW db.read() REWINDS THE WORLD (lib/player-repo.js → installReadGuard).
 *     updatePlayer() hands the caller their result as soon as the mutation is
 *     applied in RAM and only then schedules the whole-file flush (debounced,
 *     lib/player-repo.js's FLUSH_DEBOUNCE_MS). lowdb's read() replaces db.data
 *     wholesale with the FILE, so a raw `await db.read()` — every ranking
 *     command in the bot does one (.top, .leaderboard, .card top, .fame …) —
 *     that lands inside that window throws the mutation away, and the pending
 *     flush then persists the rollback. The test drives the real adapter, the
 *     real updatePlayer and a real Low instance and asserts the stat change
 *     survives both the read and the flush.
 *
 *  2. .admin setlevel DESTROYED PERMANENT BONUSES (plugins/admin.js).
 *     It rebuilt the sheet from class/race/level + allocations alone, so the
 *     reborn reward (+100 a stat), Game Shop Stat Pack Boosts, job perks and
 *     the contribution of still-equipped gear all vanished. Now it carries
 *     them across, exactly like applyLevelUps()/applyRebornFailure() do.
 *
 *  3. LOADOUT-EQUIPPED GEAR NEVER TOOK DURABILITY DAMAGE (plugins/loadout.js).
 *     initDurability() takes an item ID and looks it up; the loadout path
 *     passed the item OBJECT, so the lookup missed and nothing was tracked.
 *
 * Run:  node test/stat-loss-guards.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Low } from 'lowdb'

import { FastJSONFile } from '../lib/fast-json-adapter.js'
import { updatePlayer, installReadGuard, flushPendingWrites } from '../lib/player-repo.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import { getTotalStats, levelsData, classes, races, allItems } from '../lib/game-data.js'
import { ensureStatPoints, addAllocation } from '../lib/stat-progression.js'
import { applyStatPack, statPacks, rollStatPack } from '../lib/stat-packs.js'
import { applyRebornSuccess } from '../lib/reborn-engine.js'
import { setLevel } from '../plugins/admin.js'
import loadoutPlugin from '../plugins/loadout.js'

console.log('🧪 Stat-loss guards — db.read() rewind, setlevel retune, loadout durability')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) {
    failures.push({ name, err })
    console.log(`FAIL  ${name}\n      ${err.stack?.split('\n').slice(0, 5).join('\n      ')}`)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Deterministic-but-varying PRNG — a CONSTANT rand cannot fill splitTotal's
 *  distinct-cut set, and applyStatPack must never be handed one. */
function prng(seed) {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
}
const JID = '234700000009@s.whatsapp.net'

function makePlayer(overrides = {}) {
  return {
    id: JID,
    name: 'Guarded',
    level: 30,
    xp: 1000,
    classId: 'warrior',
    raceId: 'human',
    stats: { str: 100, agi: 50, int: 20, def: 40, lck: 10 },
    baseStats: { str: 100, agi: 50, int: 20, def: 40, lck: 10, maxHp: 440, maxMp: 175 },
    maxHp: 440, maxMp: 175, hp: 440, mp: 175,
    statPoints: {
      version: 2, earned: 450, spent: 0, unallocated: 450,
      allocations: { str: 0, agi: 0, int: 0, def: 0, lck: 0 },
    },
    wallet: { solars: 0, gems: 0 },
    equipped: { weapon: null, offhand: null, helmet: null, chestplate: null, boots: null, relic: null, pet: null, tool: null },
    equippedDurability: {},
    inventory: [],
    ...overrides,
  }
}

/** A real Low + the real atomic adapter over a scratch db.json. */
async function makeRealDb(player) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-stat-guard-'))
  const file = join(dir, 'db.json')
  await writeFile(file, JSON.stringify({ users: { [player.id]: player } }), 'utf-8')
  const db = new Low(new FastJSONFile(file), { users: {} })
  installReadGuard(db) // the fix under test
  await db.read()
  return {
    db,
    dir,
    onDisk: async () => JSON.parse(await readFile(file, 'utf-8')),
    // Drain the debounced writer before the scratch dir disappears, so a test
    // never ends on a trailing "db.write() failed (ENOENT)" line.
    cleanup: async () => { try { await flushPendingWrites(db) } catch {} ; await sleep(60); await rm(dir, { recursive: true, force: true }) },
  }
}

// ── 1. a raw db.read() must not rewind a just-applied stat change ───────────

await test('db.read() inside the flush window keeps the applied stat change (RAM + disk)', async () => {
  const p = makePlayer()
  const { db, onDisk, cleanup } = await makeRealDb(p)
  try {
    // A player allocates 10 points into STR — the real write path.
    await updatePlayer(db, JID, (pl) => {
      addAllocation(pl, 'str', 10)
    })
    assert.strictEqual(db.data.users[JID].stats.str, 110, 'mutation should be in RAM immediately')

    // Another group's `.top` lands here, well inside the 150ms debounce.
    await sleep(50)
    await db.read()
    assert.strictEqual(db.data.users[JID].stats.str, 110, 'raw db.read() must not rewind RAM')

    // …and the pending flush must persist the change, not the rollback.
    await sleep(400)
    const disk = await onDisk()
    assert.strictEqual(disk.users[JID].stats.str, 110, 'flush must persist the applied change')
    assert.strictEqual(disk.users[JID].statPoints.unallocated, 440, 'spent points stay spent')
    assert.strictEqual(disk.users[JID].statPoints.allocations.str, 10)
  } finally { await cleanup() }
})

await test('repeated reads during a burst of stat work lose nothing', async () => {
  const p = makePlayer()
  const { db, onDisk, cleanup } = await makeRealDb(p)
  try {
    for (let i = 0; i < 12; i++) {
      await updatePlayer(db, JID, (pl) => { addAllocation(pl, 'str', 1) })
      if (i % 3 === 0) await db.read() // rankings firing constantly
    }
    await sleep(400)
    const disk = await onDisk()
    assert.strictEqual(disk.users[JID].stats.str, 112, 'all 12 allocations survived')
    assert.strictEqual(disk.users[JID].statPoints.allocations.str, 12)
  } finally { await cleanup() }
})

// ── 2. .admin setlevel must not delete non-level-derived power ─────────────

await test('setlevel keeps the reborn bonus, Stat Pack boosts, job perks and gear', async () => {
  const p = makePlayer()
  ensureStatPoints(p)
  // Permanent, non-level-derived power of every kind the sheet can carry:
  applyRebornSuccess(p)                                   // +100 a stat, +300 maxHp
  applyStatPack(p, statPacks[0], prng(7))                 // a Game Shop pack
  const packed = { ...p.stats }
  p.stats.str += 25                                       // a job perk (stats-only by design)
  const sword = allItems.find(i => i.id === 'iron_sword')
  applyEquipmentBonus(p, sword, +1)                       // equipped gear
  p.equipped.weapon = sword.id
  const before = { ...p.stats, maxHp: p.maxHp, maxMp: p.maxMp }

  const { db, cleanup } = await makeRealDb(p)
  try {
    const replies = []
    await setLevel({
      args: ['setlevel', '60'],
      db,
      from: JID,
      isOwner: true,
      reply: async (t) => { replies.push(String(t)); return true },
      sock: {},
    })

    const after = db.data.users[JID]
    assert.strictEqual(after.level, 60)

    // Reborn (+100 each) and the pack/job/gear deltas must all still be there:
    // every stat the player had must be >= what class+race+level+allocation alone
    // could explain, and specifically the perks must be intact.
    const canonical = getTotalStats('warrior', 'human', 60)
    assert.ok(after.stats.str > canonical.str, 'STR still carries its permanent bonuses')
    assert.ok(after.stats.str >= before.str, `STR dropped: ${before.str} → ${after.stats.str}`)

    // The pack's roll is banked, so a later full rebuild reproduces it.
    assert.ok(after.statPacks?.bonus && Object.values(after.statPacks.bonus).some(v => v > 0))

    // Gear delta survives: stripping the sword must remove exactly its bonus.
    const withSword = { ...after.stats }
    applyEquipmentBonus(after, sword, -1)
    for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
      const bonus = sword.statBonuses?.[k] ?? 0
      assert.strictEqual(withSword[k] - after.stats[k], bonus, `${k}: gear delta must be exact`)
    }
    // …and the job perk is above the anchor, not inside it.
    assert.ok(after.stats.str > after.baseStats.str, 'job perk survived the retune')
    void packed

    // Allocation bookkeeping stays self-consistent for the next level-up.
    const allocTotal = Object.values(after.statPoints.allocations).reduce((a, b) => a + b, 0)
    assert.strictEqual(allocTotal, after.statPoints.spent)
    assert.strictEqual(after.statPoints.unallocated, after.statPoints.earned - after.statPoints.spent)

    // A level-up right after must not re-inflate (old code left `allocations`
    // at the pre-clamp size) nor shrink anything.
    const { applyLevelUps } = await import('../lib/combat-engine.js')
    const preLevelStats = { ...after.stats }
    after.xp = levelsData.xpTable[String(after.level + 1)]
    applyLevelUps(after, levelsData, classes, races, getTotalStats)
    for (const k of ['str', 'agi', 'int', 'def', 'lck']) {
      assert.ok(after.stats[k] >= preLevelStats[k], `${k} dropped on the level-up after setlevel`)
    }
    assert.ok(replies.length >= 1)
  } finally { await cleanup() }
})

// ── 2b. a constant RNG must not hang the purchase lane ─────────────────────

await test('rollStatPack survives a non-varying rand (no infinite loop)', () => {
  const pack = statPacks[0]
  const roll = rollStatPack(pack, () => 0.5)
  assert.ok(roll.total >= pack.min && roll.total <= pack.max)
  const sum = Object.values(roll.gains).reduce((a, b) => a + b, 0)
  assert.strictEqual(sum, roll.total, 'the gains must sum to the rolled total')
  assert.ok(Object.values(roll.gains).every(v => v >= 0 && Number.isInteger(v)))
})

// ── 3. loadout-equipped gear must be durability-tracked ────────────────────

await test('gearing from a loadout starts durability tracking (id, not object)', async () => {
  const sword = allItems.find(i => i.id === 'iron_sword')
  assert.ok(sword?.maxDurability > 0, 'iron_sword is a durability item')

  const p = makePlayer({ inventory: [sword.id], loadouts: { dps: { equipped: { weapon: sword.id } } } })
  const { db, cleanup } = await makeRealDb(p)
  try {
    await loadoutPlugin.run({
      args: ['equip', 'dps'],
      player: db.data.users[JID],
      db,
      from: JID,
      reply: async () => true,
    })
    const after = db.data.users[JID]
    assert.strictEqual(after.equipped.weapon, sword.id, 'the loadout equipped the weapon')
    assert.strictEqual(
      after.equippedDurability?.weapon,
      sword.maxDurability,
      'durability tracking must start — this was the object-vs-id bug',
    )
  } finally { await cleanup() }
})

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.err.message}`)
  process.exit(1)
}
