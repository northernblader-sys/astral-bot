/**
 * lib/empire-abilities.js — characters put to work inside an empire.
 *
 * This is the fourth parallel ability hook, alongside applyBossSpecial
 * (lib/boss-specials.js), applyAllNamedPassives (lib/named-passives.js) and
 * beastIntervention (lib/beast-engine.js), and it returns the same plain
 * result object those do: { modified, lines, ...overrides }. The caller folds
 * the overrides into whatever it was computing and prints the lines.
 *
 * Two roles, deliberately non-overlapping:
 *   worker  → sits on ONE producing building and scales its yield (never its
 *             upkeep), so a worker always widens the margin.
 *   general → adds to army POWER, which decides who wins a raid, and never to
 *             MIGHT (empireScore), which is what weight matching reads. A
 *             general makes you harder to beat without making you a legal
 *             target for bigger empires, or an illegal one for your peers.
 *
 * Assignment is a DISTINCT slot: it never touches player.equippedCharacter, so
 * a character can hold an empire post and still be equipped in combat. The
 * opportunity cost is the caps (a few slots per empire, fewer per player) and
 * the one-post-per-character rule, so you choose which building gets the good
 * character rather than blanketing everything.
 *
 * The single source of truth is record.assignments on the empire; there is no
 * mirrored field on the player to drift out of sync. A player belongs to
 * exactly one empire, so scanning that empire's assignments for their jid is a
 * complete reverse index. Star ratings are copied onto the assignment at assign
 * time (see ensureConflictShape) so lib/empire-engine.js can do the production
 * and army math without importing character data.
 *
 * Nothing here mutates a player, touches baseStats, or mints anything.
 */
import { characterMap } from './game-data.js'
import {
  ASSIGN_CONFIG, buildingDefMap, findBuilding, workerOnBuilding, workerMultFor, generalBonusOf,
} from './empire-engine.js'

export const ROLES = ['worker', 'general']
export const WORKER_CAP = ASSIGN_CONFIG?.workerCap ?? 3
export const GENERAL_CAP = ASSIGN_CONFIG?.generalCap ?? 1
export const PER_PLAYER_CAP = ASSIGN_CONFIG?.perPlayerCap ?? 2

// ── Character lookups ────────────────────────────────────────────────────────

/**
 * A character's numeric star rating (1 to 6), or 0 if the id is unknown. Read
 * straight off the def: characterStars() in lib/rarity.js renders a display
 * star BAR, which is not a number and cannot be multiplied.
 */
export function starsOfCharacter(charId) {
  const stars = Number(characterMap[charId]?.stars)
  return Number.isFinite(stars) ? Math.min(6, Math.max(0, Math.floor(stars))) : 0
}

/** "emoji Name" for a character id, falling back to the raw id. */
export function characterLabel(charId) {
  const def = characterMap[charId]
  if (!def) return charId
  return `${def.emoji ? `${def.emoji} ` : ''}${def.name ?? charId}`
}

/** Resolves free text to an owned character id: exact id, then a name match. */
export function findOwnedCharacter(player, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const owned = Array.isArray(player?.ownedCharacters) ? player.ownedCharacters : []
  if (owned.includes(q)) return q
  const byName = owned.find(id => (characterMap[id]?.name ?? '').toLowerCase() === q)
  if (byName) return byName
  return owned.find(id => (characterMap[id]?.name ?? '').toLowerCase().includes(q)) ?? null
}

// ── Assignment reads ─────────────────────────────────────────────────────────

/** Every assignment on the record, flattened with its role. */
export function allAssignments(record) {
  const w = (record?.assignments?.workers ?? []).map(a => ({ ...a, role: 'worker' }))
  const g = (record?.assignments?.generals ?? []).map(a => ({ ...a, role: 'general' }))
  return [...w, ...g]
}

/** The post a character currently holds in this empire, or null. */
export function assignmentOf(record, charId) {
  return allAssignments(record).find(a => a.charId === charId) ?? null
}

/** How many posts one player is currently filling in this empire. */
export function playerAssignmentCount(record, ownerJid) {
  return allAssignments(record).filter(a => a.ownerJid === ownerJid).length
}

// ── Assignment validation ────────────────────────────────────────────────────

/**
 * Decides whether `player` may put `charId` into `role` at this empire. Pure:
 * returns { ok: true, ... } or { ok: false, reason }, and the caller turns the
 * reason into copy. Membership is the gate, not ownership, so a citizen can
 * lend their roster to the empire they joined.
 */
export function canAssign({ record, player, ownerJid, charId, role, buildingType }) {
  if (!ROLES.includes(role)) return { ok: false, reason: 'norole' }
  if (!record) return { ok: false, reason: 'noempire' }
  if (player?.empireId !== record.id) return { ok: false, reason: 'notmember' }

  if (!characterMap[charId]) return { ok: false, reason: 'unknownchar' }
  const stars = starsOfCharacter(charId)
  const owned = Array.isArray(player?.ownedCharacters) ? player.ownedCharacters : []
  if (!owned.includes(charId)) return { ok: false, reason: 'notowned' }

  const jid = ownerJid ?? player?.id ?? null
  const held = assignmentOf(record, charId)
  if (held) return { ok: false, reason: 'already', held }
  if (playerAssignmentCount(record, jid) >= PER_PLAYER_CAP) {
    return { ok: false, reason: 'playercap', cap: PER_PLAYER_CAP }
  }

  if (role === 'general') {
    if ((record.assignments?.generals?.length ?? 0) >= GENERAL_CAP) {
      return { ok: false, reason: 'generalcap', cap: GENERAL_CAP }
    }
    return { ok: true, role, stars, bonus: (ASSIGN_CONFIG?.generalPctPerStar ?? 0) * stars }
  }

  if ((record.assignments?.workers?.length ?? 0) >= WORKER_CAP) {
    return { ok: false, reason: 'workercap', cap: WORKER_CAP }
  }
  const def = buildingDefMap[buildingType]
  if (!def) return { ok: false, reason: 'nosuchbuilding' }
  if (!findBuilding(record, buildingType)) return { ok: false, reason: 'notbuilt', def }
  if (!def.produces) return { ok: false, reason: 'notproducer', def }
  const sitting = workerOnBuilding(record, buildingType)
  if (sitting) return { ok: false, reason: 'occupied', sitting, def }
  return { ok: true, role, stars, def, bonus: (ASSIGN_CONFIG?.workerPctPerStar ?? 0) * stars }
}

// ── Assignment writes (record only, caller settles production first) ──────────

/**
 * Adds the post to the record in place. The CALLER must applyCollect first:
 * a worker changes a building's yield rate, and settling after would apply the
 * new rate to hours that accrued before the character ever showed up (the same
 * discipline `.empire upgrade` follows).
 */
export function applyAssign(record, { charId, ownerJid, role, buildingType, now = Date.now() }) {
  const stars = Math.max(1, starsOfCharacter(charId))
  const entry = { charId, ownerJid: ownerJid ?? null, stars, at: now }
  if (role === 'general') {
    record.assignments.generals.push(entry)
  } else {
    record.assignments.workers.push({ ...entry, buildingType })
  }
  return { ...entry, role, buildingType: role === 'worker' ? buildingType : null }
}

/**
 * Removes a character's post. Returns what was removed so the caller can name
 * it. Same settle-first rule as applyAssign.
 */
export function applyUnassign(record, charId) {
  const workers = record.assignments?.workers ?? []
  const wi = workers.findIndex(a => a.charId === charId)
  if (wi >= 0) {
    const [entry] = workers.splice(wi, 1)
    return { ok: true, role: 'worker', entry }
  }
  const generals = record.assignments?.generals ?? []
  const gi = generals.findIndex(a => a.charId === charId)
  if (gi >= 0) {
    const [entry] = generals.splice(gi, 1)
    return { ok: true, role: 'general', entry }
  }
  return { ok: false, reason: 'notassigned' }
}

/**
 * Pulls every post held by one player, used when they leave the empire: an
 * assignment must never outlive the membership that justified it, or a
 * departed citizen would keep boosting the empire forever.
 */
export function stripPlayerAssignments(record, ownerJid) {
  const removed = allAssignments(record).filter(a => a.ownerJid === ownerJid)
  if (!removed.length) return removed
  record.assignments.workers = (record.assignments.workers ?? []).filter(a => a.ownerJid !== ownerJid)
  record.assignments.generals = (record.assignments.generals ?? []).filter(a => a.ownerJid !== ownerJid)
  return removed
}

// ── The hook ─────────────────────────────────────────────────────────────────

/**
 * The parallel-hook entry point. Returns the production multipliers and the
 * army-power bonus the empire's assigned characters currently provide, plus
 * display lines, in the { modified, lines, ...overrides } shape the other three
 * hooks use. Read-only.
 *
 *   const emp = applyEmpireAbilities(record)
 *   if (emp.modified) lines.push(...emp.lines)
 *   const snap = buildSnapshot(record, { generalBonus: emp.generalBonus })
 */
export function applyEmpireAbilities(record) {
  const lines = []
  const productionBoosts = {}
  for (const a of record?.assignments?.workers ?? []) {
    const mult = workerMultFor(record, a.buildingType)
    productionBoosts[a.buildingType] = mult
    const def = buildingDefMap[a.buildingType]
    lines.push(
      `👷 ${characterLabel(a.charId)} works the ${def?.name ?? a.buildingType}: `
      + `*+${Math.round((mult - 1) * 100)}%* output`
    )
  }
  const generalBonus = generalBonusOf(record)
  for (const a of record?.assignments?.generals ?? []) {
    lines.push(
      `🎖️ ${characterLabel(a.charId)} commands your army: `
      + `*+${Math.round((ASSIGN_CONFIG?.generalPctPerStar ?? 0) * (a.stars ?? 1) * 100)}%* army power`
    )
  }
  return {
    modified: lines.length > 0,
    lines,
    productionBoosts,
    generalBonus,
  }
}

/** Compact display lines for `.empire info`, empty when nobody is posted. */
export function assignmentLines(record) {
  return applyEmpireAbilities(record).lines
}
