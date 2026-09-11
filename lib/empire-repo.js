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
import { ensureEmpireShape, ensureEmpirePlayer, slugify, LIFECYCLE_CONFIG, DAY_MS } from './empire-engine.js'
import { updateAllPlayers } from './player-repo.js'

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
