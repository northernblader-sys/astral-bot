/**
 * lib/empire-repo.js — empire record access and membership, the read/write
 * seam between plugins and db.data.empires.
 *
 * Empires are player-CREATED and player-OWNED, unlike guilds (which are fixed
 * defs nobody owns). So there is nothing to seed: ensureEmpiresInitialized
 * only guarantees the container exists and every existing record is shaped.
 * Ownership is a field (record.ownerId), and membership is computed from the
 * player side (u.empireId === id), exactly like getGuildMembers — never a
 * member list stored on the record, which would drift.
 *
 * The actual create/debit for `.empire found` is NOT done here: it happens
 * inside an updatePlayer mutator in plugins/empire.js so the solar debit, the
 * name claim, and the record creation all land in one serialized write (the
 * db.data.seasonRuntime in-mutator idiom from the spin plugins). The read and
 * query helpers below stay free of write-queue calls so they can be exercised
 * from a plain object in scripts/empire-check.mjs; the one exception is
 * sweepEmpireLifecycle, which ages abandoned empires through updateAllPlayers.
 */
import {
  ensureEmpireShape, ensureEmpirePlayer, slugify, LIFECYCLE_CONFIG, DAY_MS, HOUR_MS,
  applyCollect, armyPower, conflictPowerBonus, buildingDefMap, removeLowestOfficer,
  lootableTreasury, razeEmpireToFounding, RAID_CONFIG, WAR_CONFIG,
} from './empire-engine.js'
import { updateAllPlayers } from './player-repo.js'
import { buildSnapshot, resolveSiegeTick, resolveWarRound, resolveWarSpoils } from './empire-combat.js'
import { pushNotification } from './notification-repo.js'

/**
 * Recomputes every empire's citizenCount straight from the player side, the
 * same way getEmpireMembers derives membership: one pass over db.data.users,
 * tallying each empireId. Owner and citizens both carry empireId, so the tally
 * is the true headcount of PLAYERS sworn to the empire (npcs are counted
 * separately, on the record). This is the AUTHORITATIVE source for
 * citizenCount, and since fame is now derived from headcount, it must run
 * BEFORE ensureEmpireShape (which only defaults a missing citizenCount, never
 * overwrites a live one) so the derived fame lands on the right number.
 * Mutates records in place; returns true if any count moved.
 */
export function reconcileCitizenCount(db) {
  const empires = db.data?.empires ?? {}
  const users = db.data?.users ?? {}
  const tally = {}
  for (const u of Object.values(users)) {
    const id = u?.empireId
    if (id && empires[id]) tally[id] = (tally[id] ?? 0) + 1
  }
  let changed = false
  for (const id of Object.keys(empires)) {
    const rec = empires[id]
    if (!rec) continue
    const next = tally[id] ?? 0
    if (rec.citizenCount !== next) { rec.citizenCount = next; changed = true }
  }
  return changed
}

/** Guarantees db.data.empires exists and every record is shaped. Idempotent. */
export async function ensureEmpiresInitialized(db) {
  if (!db.data.empires) db.data.empires = {}
  // Reconcile player headcount FIRST: fame is derived from citizenCount + npcs,
  // and ensureEmpireShape reads citizenCount to compute it, so the true count
  // must be in place before shaping.
  let changed = reconcileCitizenCount(db)
  for (const id of Object.keys(db.data.empires)) {
    const before = JSON.stringify(db.data.empires[id])
    ensureEmpireShape(db.data.empires[id])
    if (JSON.stringify(db.data.empires[id]) !== before) changed = true
  }
  if (changed) await db.write()
  return db.data.empires
}

/** The shaped record for one empire id, or null if none exists. */
export function getEmpireRecord(db, empireId) {
  const rec = db.data.empires?.[empireId]
  return rec ? ensureEmpireShape(rec) : null
}

/** The empire a given jid owns, or null. Ownership is record.ownerId. */
export function getOwnedEmpire(db, ownerJid) {
  const empires = db.data.empires ?? {}
  for (const id of Object.keys(empires)) {
    if (empires[id]?.ownerId === ownerJid) return ensureEmpireShape(empires[id])
  }
  return null
}

/**
 * True if any empire already uses this name (case-insensitively, or by slug
 * collision so "Iron Hold" and "iron-hold" can't both exist).
 *
 * Checks live NAMES only, never record ids. Ids are immutable primary keys, so
 * after `.empire rename` a record keeps the slug of whatever it was first
 * called; matching on ids here would keep every previous name reserved forever
 * and block a legitimate founder. The flip side is that a new record's key can
 * now collide with an old id, so every create path (foundEmpire, preset assign)
 * de-collides its key before assigning.
 */
export function empireNameTaken(db, name, exceptId = null) {
  const slug = slugify(name)
  const lower = String(name ?? '').trim().toLowerCase()
  if (!lower) return false
  for (const [id, rec] of Object.entries(db.data.empires ?? {})) {
    if (!rec || id === exceptId) continue
    if ((rec.name ?? '').toLowerCase() === lower) return true
    if (slugify(rec.name ?? '') === slug) return true
  }
  return false
}

/** An unused key for `db.data.empires`, derived from `slug`. */
export function freeEmpireId(db, slug) {
  const empires = db.data.empires ?? {}
  if (!empires[slug]) return slug
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`
    if (!empires[candidate]) return candidate
  }
}

/**
 * Resolves a free-text query to an empire record: exact name, then exact id,
 * then a name substring. Mirrors findGuildByQuery so `.empire info steel`
 * behaves like `.guild info`.
 *
 * Live names are tried BEFORE ids: a renamed empire keeps its original slug as
 * its id, so an id-first lookup would let a stale name shadow the empire that
 * legitimately holds that name today.
 */
export function findEmpireByQuery(db, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const empires = Object.values(db.data.empires ?? {})
  const exact = empires.find(e => (e.name ?? '').toLowerCase() === q)
  if (exact) return ensureEmpireShape(exact)
  const byId = db.data.empires?.[slugify(q)]
  if (byId) return ensureEmpireShape(byId)
  const partial = empires.find(e => (e.name ?? '').toLowerCase().includes(q))
  return partial ? ensureEmpireShape(partial) : null
}

/** All players who belong to `empireId` (owner and, later, citizens). */
export function getEmpireMembers(empireId, allUsers) {
  return allUsers.filter(u => u.empireId === empireId)
}

/**
 * Builds a fresh, fully-shaped empire record. The caller assigns it onto
 * db.data.empires[id] INSIDE an updatePlayer mutator, alongside the owner's
 * solar debit and empireId assignment, so the whole founding is one atomic
 * serialized write. A newly founded empire is one person (the ruler), so it
 * starts with citizenCount 1 and no npcs; fame is derived from that headcount
 * by ensureEmpireShape, landing it at 1 (Hamlet). The two population clocks are
 * stamped to now so nobody arrives and no civic income accrues retroactively.
 */
export function newEmpireRecord({ id, name, ownerId, now }) {
  const record = {
    id,
    name,
    ownerId,
    foundedAt: now,
    lastActiveAt: now,
    citizenCount: 1,
    npcs: 0,
    lastPopAt: now,
    lastCivicAt: now,
    fame: 1,
    tierId: null,
    treasury: 0,
    warehouse: {},
    buildings: [],
  }
  return ensureEmpireShape(record)
}

export { ensureEmpirePlayer }

/**
 * Builds a fully-shaped empire record from a data/empire.json preset, for
 * `.empire preset assign` (owner-only restoration). Same contract as
 * newEmpireRecord: the caller assigns it onto db.data.empires[id] INSIDE an
 * updatePlayer mutator so the record, the name claim and the player's empireId
 * all land in one serialized write.
 *
 * The preset's headcount goes to `npcs`, never citizenCount: citizenCount is
 * the PLAYER tally and is recomputed from the player side on every boot, so a
 * number stored there would vanish. citizenCount starts at 1 (the new ruler)
 * and ensureEmpireShape derives fame and tier from the two together.
 *
 * Every clock is stamped to `now` so nothing accrues retroactively: the new
 * owner does not walk into a windfall of offline production, and the army is
 * treated as just paid rather than owed hours of back wages.
 */
export function buildPresetRecord(preset, { id, name, ownerId, now }) {
  const record = {
    id,
    name,
    ownerId,
    foundedAt: now,
    lastActiveAt: now,
    citizenCount: 1,
    npcs: Math.max(0, Math.floor(preset?.citizens ?? 0)),
    lastPopAt: now,
    lastCivicAt: now,
    fame: 1,
    tierId: null,
    treasury: Math.max(0, Math.floor(preset?.treasury ?? 0)),
    warehouse: { ...(preset?.warehouse ?? {}) },
    buildings: (preset?.buildings ?? []).map(b => ({
      type: b.type,
      level: b.level,
      region: b.region,
      lastCollectedAt: now,
      damagedUntil: 0,
    })),
    army: {
      levies: {
        recruit: Math.max(0, Math.floor(preset?.army?.levies?.recruit ?? 0)),
        soldier: Math.max(0, Math.floor(preset?.army?.levies?.soldier ?? 0)),
      },
      officers: (preset?.army?.officers ?? []).map(o => ({ name: o.name, rank: o.rank, xp: o.xp ?? 0 })),
      lastPaidAt: now,
    },
    presetId: preset?.id ?? null,
  }
  return ensureEmpireShape(record)
}

// ── Lifecycle: dormancy and succession ───────────────────────────────────────

/**
 * Cheap pre-check for the sweep below, so the hot path (every `.empire` /
 * `.war` command) only pays for a full updateAllPlayers pass when there is
 * actually state to change. Returns true only when some empire has crossed a
 * lifecycle threshold it has not yet been aged for. An empire currently in an
 * active war is never aged: being fought over is not being abandoned.
 */
export function empireNeedsSweep(db, now = Date.now(), exceptOwnerId = null) {
  const dormancyMs = (LIFECYCLE_CONFIG?.dormancyDays ?? 21) * DAY_MS
  const successionMs = (LIFECYCLE_CONFIG?.successionDays ?? 45) * DAY_MS
  for (const rec of Object.values(db.data?.empires ?? {})) {
    if (!rec || rec.war?.status === 'active') continue
    if (exceptOwnerId && rec.ownerId === exceptOwnerId) continue
    const idle = now - (rec.lastActiveAt ?? rec.foundedAt ?? now)
    if (idle >= successionMs) return true            // needs succession/dissolution
    if (idle >= dormancyMs && !rec.dormant) return true // needs the dormant flag
  }
  return false
}

/**
 * Ages abandoned empires in ONE atomic updateAllPlayers pass (the only
 * write-queue user in this module), so it never nests inside another mutator.
 * Called OUTSIDE any mutator from the top of the empire/war command paths,
 * gated by empireNeedsSweep so it stays free on the common path.
 *
 *   - After dormancyDays of inactivity an empire is flagged dormant: it drops
 *     off the travel map and reads as sleeping, but is otherwise untouched and
 *     the moment its ruler acts the flag clears.
 *   - After successionDays the throne passes to the most senior citizen, or,
 *     if there are none, the empire dissolves entirely and every member is
 *     freed. lastActiveAt is stamped on succession so a fresh reign is not
 *     immediately re-aged.
 *
 * The caller's own empire (exceptOwnerId) is never aged, so a ruler returning
 * after a long absence cannot have the empire they came back to dissolved by
 * their very own command: only empires abandoned by SOMEONE ELSE are swept on
 * a given player's turn. Any economic action the returning ruler takes then
 * refreshes lastActiveAt normally.
 *
 * Never broadcasts and never touches a socket. Returns a small tally.
 */
export async function sweepEmpireLifecycle(db, now = Date.now(), exceptOwnerId = null) {
  if (!db.data.empires) db.data.empires = {}
  const dormancyMs = (LIFECYCLE_CONFIG?.dormancyDays ?? 21) * DAY_MS
  const successionMs = (LIFECYCLE_CONFIG?.successionDays ?? 45) * DAY_MS
  const summary = { dormant: 0, succeeded: 0, dissolved: 0 }
  await updateAllPlayers(db, (users) => {
    let changed = false
    // Object.keys snapshots the ids, so deleting a record mid-loop is safe.
    for (const id of Object.keys(db.data.empires)) {
      const rec = db.data.empires[id]
      if (!rec || rec.war?.status === 'active') continue
      if (exceptOwnerId && rec.ownerId === exceptOwnerId) continue
      const idle = now - (rec.lastActiveAt ?? rec.foundedAt ?? now)
      if (idle >= successionMs) {
        const citizens = Object.values(users)
          .filter(u => u && u.empireId === id && u.empireRole === 'citizen')
          .sort((a, b) => (a.empireJoinedAt ?? 0) - (b.empireJoinedAt ?? 0)
            || String(a.id ?? '').localeCompare(String(b.id ?? '')))
        if (citizens.length) {
          const heir = citizens[0]
          const oldOwner = users[rec.ownerId]
          if (oldOwner) {
            oldOwner.empireId = null
            oldOwner.empireRole = null
            oldOwner.empireJoinedAt = null
          }
          heir.empireRole = 'owner'
          rec.ownerId = heir.id
          rec.dormant = false
          rec.lastActiveAt = now
          summary.succeeded++
        } else {
          // No heir: free anyone still sworn to it (the owner, and any straggler
          // whose membership somehow outlived a citizen), then delete the record.
          for (const u of Object.values(users)) {
            if (u && u.empireId === id) {
              u.empireId = null
              u.empireRole = null
              u.empireJoinedAt = null
            }
          }
          delete db.data.empires[id]
          summary.dissolved++
        }
        changed = true
      } else if (idle >= dormancyMs && !rec.dormant) {
        rec.dormant = true
        summary.dormant++
        changed = true
      }
    }
    return changed
  })
  return summary
}

// ── Timed conflicts: sieges and wars (settle-on-read) ────────────────────────
//
// There is no scheduler in this bot: every timer is an absolute-ms stamp
// compared to Date.now() on read, and conflicts advance the same way. A siege
// or a timed war stores its next-event stamp (nextTickAt / nextRoundAt) and its
// hard deadline (endsAt). Whenever ANY player runs a conflict command the hot
// path calls conflictsNeedSettle, and if true settleEmpireConflicts walks every
// empire and plays out any ticks or rounds now due, applying casualties LIVE
// and concluding anything past its deadline. Notifications fire ONLY on
// conclusion (never per tick or round) and are pushed to each affected owner's
// inbox individually, never as a group broadcast.

/** Newest-first raid/siege log entry, capped by RAID_CONFIG.raidLogCap. */
function appendRaidLogEntry(record, entry) {
  if (!record || typeof record !== 'object') return
  if (!Array.isArray(record.raidLog)) record.raidLog = []
  const cap = Math.max(1, Math.floor(Number(RAID_CONFIG?.raidLogCap) || 8))
  record.raidLog.unshift(entry)
  record.raidLog = record.raidLog.slice(0, cap)
}

/** Newest-first war log entry, capped by WAR_CONFIG.warLogCap. */
function appendWarLogEntry(record, entry) {
  if (!record || typeof record !== 'object') return
  if (!Array.isArray(record.warLog)) record.warLog = []
  const cap = Math.max(1, Math.floor(Number(WAR_CONFIG?.warLogCap) || 8))
  record.warLog.unshift(entry)
  record.warLog = record.warLog.slice(0, cap)
}

/** Subtract levy casualties from a live record's army, floored at zero. */
function applyLevyCasualties(record, losses) {
  const lv = record?.army?.levies
  if (!lv) return
  lv.recruit = Math.max(0, Math.floor((lv.recruit ?? 0) - (losses?.recruit ?? 0)))
  lv.soldier = Math.max(0, Math.floor((lv.soldier ?? 0) - (losses?.soldier ?? 0)))
}

/** Accumulate a {recruit,soldier} losses delta into a running tally. */
function addLosses(acc, add) {
  acc.recruit = Math.max(0, Math.floor((acc.recruit ?? 0) + (add?.recruit ?? 0)))
  acc.soldier = Math.max(0, Math.floor((acc.soldier ?? 0) + (add?.soldier ?? 0)))
}

/** Total head of a {recruit,soldier} losses object. */
function totalLevies(losses) {
  return Math.max(0, Math.floor((losses?.recruit ?? 0) + (losses?.soldier ?? 0)))
}

/**
 * The active siege currently pressing a given target, or null. A siege lives
 * ONLY on the attacker's record (record.siege), so a defender learns it is
 * besieged by scanning for an attacker whose siege targets it: the defender-side
 * read, exactly like pendingAgainst for wars, with no second mirror to drift.
 * Returns the LIVE attacker record (not shaped) so callers can read the siege.
 */
export function siegeAgainst(db, targetId, now = Date.now()) {
  if (!targetId) return null
  for (const rec of Object.values(db.data?.empires ?? {})) {
    if (rec?.siege?.status === 'active' && rec.siege.targetId === targetId) return rec
  }
  return null
}

/**
 * True if any empire has a conflict event now due: a siege past its next tick
 * or its deadline, or an aggressor's war past its next round or its deadline.
 * A cheap read-only scan, run on the hot path so settleEmpireConflicts (which
 * takes the write queue) only fires when there is genuine work to do.
 */
export function conflictsNeedSettle(db, now = Date.now()) {
  for (const rec of Object.values(db.data?.empires ?? {})) {
    if (!rec) continue
    const sg = rec.siege
    if (sg?.status === 'active') {
      if ((sg.endsAt ?? 0) <= now) return true
      if ((sg.nextTickAt ?? 0) <= now && (sg.ticksDone ?? 0) < (sg.ticksTotal ?? 0)) return true
    }
    const w = rec.war
    if (w?.status === 'active' && w.role === 'aggressor'
        && ((w.nextRoundAt ?? 0) <= now || (w.endsAt ?? 0) <= now)) return true
  }
  return false
}

/**
 * Plays out every siege tick now due on the attacker record, applying levy
 * casualties LIVE to both armies each tick, then concludes the siege if all
 * ticks are spent or the deadline has passed. Returns true if it changed state.
 */
function advanceSiege(db, rec, now, notes) {
  const sg = rec.siege
  if (!sg || sg.status !== 'active') return false
  const target = db.data.empires?.[sg.targetId]
  if (!target) {
    // Target vanished (dissolved or razed by another conflict): lift the siege
    // and free the attacker's committed army.
    rec.siege = null
    rec.deployedUntil = now
    return true
  }
  let changed = false
  let guard = 0
  while (sg.ticksDone < sg.ticksTotal && sg.nextTickAt <= now && guard++ < 1000) {
    applyCollect(rec, now)
    applyCollect(target, now)
    const aSnap = buildSnapshot(rec, { generalBonus: conflictPowerBonus(rec, { defending: false }) })
    const dSnap = buildSnapshot(target, { generalBonus: conflictPowerBonus(target, { defending: true }) })
    const res = resolveSiegeTick(aSnap, dSnap, Math.random, sg.nextTickAt)
    applyLevyCasualties(rec, res.attackerLosses)
    applyLevyCasualties(target, res.defenderLosses)
    if (!sg.attackerLosses) sg.attackerLosses = { recruit: 0, soldier: 0 }
    if (!sg.defenderLosses) sg.defenderLosses = { recruit: 0, soldier: 0 }
    addLosses(sg.attackerLosses, res.attackerLosses)
    addLosses(sg.defenderLosses, res.defenderLosses)
    if (res.attackerWins) { sg.attackerTickWins++; sg.loot += sg.lootPerTick }
    else sg.defenderTickWins++
    sg.ticksDone++
    if (!Array.isArray(sg.log)) sg.log = []
    sg.log.unshift({
      at: sg.nextTickAt,
      tick: sg.ticksDone,
      attackerWon: res.attackerWins,
      aLoss: totalLevies(res.attackerLosses),
      dLoss: totalLevies(res.defenderLosses),
    })
    const logCap = Math.max(1, Math.floor(Number(RAID_CONFIG?.siegeLogCap) || 10))
    sg.log = sg.log.slice(0, logCap)
    sg.nextTickAt += Math.max(1, sg.tickMs)
    changed = true
  }
  if (sg.ticksDone >= sg.ticksTotal || sg.endsAt <= now) {
    concludeSiege(db, rec, target, now, notes)
    changed = true
  }
  return changed
}

/**
 * Resolves a finished siege ONCE: the side with more tick wins takes it. On an
 * attacker win the attacker seizes the accrued loot (clamped to the defender's
 * lootable treasury, so the vault's protected share is untouchable), knocks one
 * random producing building offline, and shields the beaten defender against
 * farming. Logs both sides and queues one inbox note per owner. Clears the
 * siege and frees the attacker's army either way.
 */
function concludeSiege(db, rec, target, now, notes) {
  const sg = rec.siege
  if (!sg) { rec.deployedUntil = Math.min(rec.deployedUntil ?? now, now); return }
  applyCollect(rec, now)
  if (target) applyCollect(target, now)
  const attackerWon = sg.attackerTickWins > sg.defenderTickWins
  const attackerName = rec.name ?? 'an empire'
  const defenderName = target?.name ?? sg.targetName ?? 'an empire'
  let seized = 0
  let damagedName = null
  if (attackerWon && target) {
    seized = Math.max(0, Math.min(Math.floor(sg.loot), lootableTreasury(target)))
    if (seized > 0) {
      target.treasury = Math.max(0, Math.floor((target.treasury ?? 0) - seized))
      rec.treasury = Math.max(0, Math.floor((rec.treasury ?? 0) + seized))
    }
    const producers = (target.buildings ?? []).filter(b => buildingDefMap[b.type]?.produces)
    if (producers.length) {
      const pick = producers[Math.floor(Math.random() * producers.length)]
      pick.damagedUntil = now + (RAID_CONFIG.buildingDamageHours ?? 6) * HOUR_MS
      damagedName = buildingDefMap[pick.type]?.name ?? pick.type
    }
    target.shieldUntil = Math.max(target.shieldUntil ?? 0, now + (RAID_CONFIG.shieldHours ?? 12) * HOUR_MS)
  }
  const aTotal = totalLevies(sg.attackerLosses)
  const dTotal = totalLevies(sg.defenderLosses)
  appendRaidLogEntry(rec, {
    at: now, kind: 'siege', role: 'attacker', won: attackerWon, opponent: defenderName,
    loot: attackerWon ? seized : 0, myLosses: aTotal, theirLosses: dTotal,
    tickWins: sg.attackerTickWins, tickLosses: sg.defenderTickWins,
  })
  if (target) {
    appendRaidLogEntry(target, {
      at: now, kind: 'siege', role: 'defender', won: !attackerWon, opponent: attackerName,
      loot: attackerWon ? -seized : 0, myLosses: dTotal, theirLosses: aTotal,
      tickWins: sg.defenderTickWins, tickLosses: sg.attackerTickWins,
    })
  }
  rec.deployedUntil = now
  rec.lastRaidAt = now
  rec.lastActiveAt = now
  const assaults = sg.ticksDone
  if (target?.ownerId) {
    notes.push({ ownerId: target.ownerId, note: {
      kind: 'empire',
      title: attackerWon ? '🏰 Your walls have fallen' : '🛡️ Siege repelled',
      body: attackerWon
        ? `The siege by *${attackerName}* broke through after ${assaults} assaults. They carried off 💰${seized.toLocaleString()}${damagedName ? ` and left your ${damagedName} in ruins` : ''}. You held ${sg.defenderTickWins} of ${assaults} assaults. Your losses: ${dTotal} troops.`
        : `*${attackerName}* besieged you for ${assaults} assaults and was thrown back. You won ${sg.defenderTickWins} of ${assaults}. Your losses: ${dTotal} troops, theirs: ${aTotal}.`,
    } })
  }
  if (rec.ownerId) {
    notes.push({ ownerId: rec.ownerId, note: {
      kind: 'empire',
      title: attackerWon ? '🏰 Siege won' : '🏳️ Siege broken',
      body: attackerWon
        ? `Your siege of *${defenderName}* broke their walls after ${assaults} assaults. Plunder: 💰${seized.toLocaleString()}${damagedName ? `, and their ${damagedName} lies in ruins` : ''}. Your losses: ${aTotal} troops.`
        : `Your siege of *${defenderName}* was thrown back after ${assaults} assaults. You took ${sg.attackerTickWins} of ${assaults}. Your losses: ${aTotal} troops.`,
    } })
  }
  rec.siege = null
}

/**
 * Resolves ONE war round against the live records: settles both economies,
 * builds power snapshots (with conflict-power bonuses, defender gets its walls),
 * rolls the round, applies casualties LIVE, walks a losing officer if the roll
 * says so, and updates BOTH war mirrors (wins and cumulative losses) as a pair.
 */
function resolveWarRoundLive(aggressor, defender, now) {
  applyCollect(aggressor, now)
  applyCollect(defender, now)
  const aSnap = buildSnapshot(aggressor, { generalBonus: conflictPowerBonus(aggressor, { defending: false }) })
  const dSnap = buildSnapshot(defender, { generalBonus: conflictPowerBonus(defender, { defending: true }) })
  const res = resolveWarRound(aSnap, dSnap, Math.random, now)
  applyLevyCasualties(aggressor, res.attackerLosses)
  applyLevyCasualties(defender, res.defenderLosses)
  if (res.attackerOfficerLost) removeLowestOfficer(aggressor)
  if (res.defenderOfficerLost) removeLowestOfficer(defender)
  const aw = aggressor.war
  const dw = defender.war
  if (aw) {
    if (res.attackerWins) aw.myWins = (aw.myWins ?? 0) + 1; else aw.theirWins = (aw.theirWins ?? 0) + 1
    aw.roundsFought = (aw.roundsFought ?? 0) + 1
    if (!aw.myLosses) aw.myLosses = { recruit: 0, soldier: 0 }
    if (!aw.theirLosses) aw.theirLosses = { recruit: 0, soldier: 0 }
    addLosses(aw.myLosses, res.attackerLosses)
    addLosses(aw.theirLosses, res.defenderLosses)
  }
  if (dw) {
    if (res.attackerWins) dw.theirWins = (dw.theirWins ?? 0) + 1; else dw.myWins = (dw.myWins ?? 0) + 1
    dw.roundsFought = (dw.roundsFought ?? 0) + 1
    if (!dw.myLosses) dw.myLosses = { recruit: 0, soldier: 0 }
    if (!dw.theirLosses) dw.theirLosses = { recruit: 0, soldier: 0 }
    addLosses(dw.myLosses, res.defenderLosses)
    addLosses(dw.theirLosses, res.attackerLosses)
  }
  return res
}

/**
 * Plays out every war round now due, driven from the AGGRESSOR's mirror only
 * (the defender's mirror is advanced in lock step so the two never drift), then
 * concludes the war if the deadline has passed or either army is wiped out.
 * Returns true if it changed state. Clears a desynced or orphaned war mirror.
 */
function advanceWar(db, rec, now, notes) {
  const w = rec.war
  if (!w || w.status !== 'active' || w.role !== 'aggressor') return false
  const foe = db.data.empires?.[w.opponentId]
  if (!foe || foe.war?.status !== 'active' || foe.war.opponentId !== rec.id) {
    // The foe was razed, dissolved, or its mirror no longer points back: clear
    // this stale war so it cannot wedge the empire, and clear the foe's if it
    // still points here.
    rec.war = null
    if (foe && foe.war && foe.war.opponentId === rec.id) foe.war = null
    return true
  }
  const intervalMs = Math.max(1, Math.floor((WAR_CONFIG.roundIntervalMinutes ?? 15) * 60 * 1000))
  let changed = false
  let guard = 0
  while ((w.nextRoundAt ?? 0) <= now && (w.nextRoundAt ?? 0) <= (w.endsAt ?? 0) && guard++ < 1000) {
    resolveWarRoundLive(rec, foe, w.nextRoundAt)
    const next = (w.nextRoundAt ?? now) + intervalMs
    w.nextRoundAt = next
    if (foe.war) foe.war.nextRoundAt = next
    changed = true
    if (armyPower(rec) <= 0 || armyPower(foe) <= 0) break
  }
  if ((w.endsAt ?? 0) <= now || armyPower(rec) <= 0 || armyPower(foe) <= 0) {
    concludeWar(db, rec, foe, now, notes)
    changed = true
  }
  return changed
}

/**
 * Resolves a finished war ONCE. The victor is whoever still has an army when the
 * other is wiped; failing that, whoever holds the higher round score, with a tie
 * held by the defender. The victor takes a capped tribute (clamped to the
 * loser's lootable treasury, so the vault's protected share survives) and a
 * short shield; the LOSER is razed back to its founding: the empire, its id,
 * owner and sworn citizens all survive, but everything built is gone, and a long
 * raze shield guards it while it rebuilds. Logs and notifies both owners.
 */
function concludeWar(db, aggressor, defender, now, notes) {
  applyCollect(aggressor, now)
  applyCollect(defender, now)
  const aw = aggressor.war
  const myWins = aw?.myWins ?? 0
  const theirWins = aw?.theirWins ?? 0
  const roundsFought = aw?.roundsFought ?? 0
  const aPow = armyPower(aggressor)
  const dPow = armyPower(defender)
  let aggressorWon
  if (aPow <= 0 && dPow <= 0) aggressorWon = myWins > theirWins
  else if (dPow <= 0) aggressorWon = true
  else if (aPow <= 0) aggressorWon = false
  else aggressorWon = myWins > theirWins            // tie holds for the defender
  const victor = aggressorWon ? aggressor : defender
  const loser = aggressorWon ? defender : aggressor
  // Capture identity BEFORE the raze wipes the loser's fields.
  const victorName = victor.name ?? 'an empire'
  const loserName = loser.name ?? 'an empire'
  const victorOwnerId = victor.ownerId
  const loserOwnerId = loser.ownerId
  const victorWins = aggressorWon ? myWins : theirWins
  const loserWins = aggressorWon ? theirWins : myWins
  // Tribute: capped slice of the loser's LOOTABLE treasury, taken before raze.
  const spoils = resolveWarSpoils(buildSnapshot(victor), buildSnapshot(loser), Math.random)
  const tribute = Math.max(0, Math.min(Math.floor(spoils.tribute), lootableTreasury(loser)))
  if (tribute > 0) loser.treasury = Math.max(0, Math.floor((loser.treasury ?? 0) - tribute))
  appendWarLogEntry(loser, {
    at: now, role: 'razed', opponent: victorName, roundsFought,
    myWins: loserWins, theirWins: victorWins, tributeLost: tribute,
  })
  razeEmpireToFounding(loser, now)
  loser.lastWarAt = now
  victor.treasury = Math.max(0, Math.floor((victor.treasury ?? 0) + tribute))
  victor.war = null
  victor.lastWarAt = now
  victor.lastActiveAt = now
  victor.shieldUntil = Math.max(victor.shieldUntil ?? 0, now + (WAR_CONFIG.victorShieldHours ?? 6) * HOUR_MS)
  appendWarLogEntry(victor, {
    at: now, role: 'win', opponent: loserName, roundsFought,
    myWins: victorWins, theirWins: loserWins, tribute,
  })
  const razeShieldH = WAR_CONFIG.razeShieldHours ?? 72
  if (victorOwnerId) {
    notes.push({ ownerId: victorOwnerId, note: {
      kind: 'empire',
      title: '⚔️ War won',
      body: `Your war against *${loserName}* is won after ${roundsFought} rounds (${victorWins} to ${loserWins}). Their empire is razed to its foundations and you take 💰${tribute.toLocaleString()} in tribute. A victor's shield guards you for ${WAR_CONFIG.victorShieldHours ?? 6}h.`,
    } })
  }
  if (loserOwnerId) {
    notes.push({ ownerId: loserOwnerId, note: {
      kind: 'empire',
      title: '💀 Your empire has fallen',
      body: `The war against *${victorName}* is lost after ${roundsFought} rounds (${loserWins} to ${victorWins}). *${loserName}* is razed to its founding: every building, your army, your stash and your market are gone, and 💰${tribute.toLocaleString()} was taken in tribute. Your people remain sworn to you, and a ${razeShieldH}h shield protects you while you rebuild.`,
    } })
  }
}

/**
 * Advances every due siege and war across ALL empires in ONE atomic
 * updateAllPlayers pass. This is the second (and only other) write-queue user in
 * this module besides sweepEmpireLifecycle, so it never nests inside another
 * mutator. Casualties are applied live inside the pass; the sole outward effect,
 * one inbox notification per affected owner, is collected during the pass and
 * pushed AFTER it, individually, never as a group broadcast. Idempotent: with
 * nothing due it makes no change and flushes nothing.
 */
export async function settleEmpireConflicts(db, now = Date.now()) {
  if (!db.data.empires) db.data.empires = {}
  const notes = []
  await updateAllPlayers(db, () => {
    // Reset the accumulator at the top so a cluster-mode retry of this mutator
    // cannot double-count notifications (mirrors the single-writer contract).
    notes.length = 0
    let changed = false
    // Sieges first, then wars. Object.keys snapshots the ids so a war conclusion
    // that razes an empire mid-pass cannot disturb the iteration; a siege that
    // finds its target already razed is handled defensively in advanceSiege.
    for (const id of Object.keys(db.data.empires)) {
      const rec = db.data.empires[id]
      if (rec?.siege?.status === 'active') { if (advanceSiege(db, rec, now, notes)) changed = true }
    }
    for (const id of Object.keys(db.data.empires)) {
      const rec = db.data.empires[id]
      if (rec?.war?.status === 'active' && rec.war.role === 'aggressor') {
        if (advanceWar(db, rec, now, notes)) changed = true
      }
    }
    return changed
  })
  for (const n of notes) {
    if (n?.ownerId) await pushNotification(db, n.ownerId, n.note).catch(() => {})
  }
  return notes.length
}
