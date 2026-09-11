/**
 * guild-repo.js — guild membership, dynamic leadership, and banner/pfp storage.
 *
 * Guilds are fixed (see data/guilds.json) — nobody "owns" them. Leadership is
 * computed on the fly: whichever member has conquered the most dungeon
 * floors *since joining that guild* is the leader. A player's raw conquest
 * score is the sum of highestFloor across every dungeon they've touched;
 * their guild score is that total minus the baseline snapshot taken the
 * moment they joined.
 */
import { guilds as guildDefs } from './game-data.js'
import { ensureGuildProgress } from './guild-engine.js'

/** Sum of highestFloor across every dungeon a player has touched, ever. */
export function totalFloorsConquered(player) {
  return Object.values(player.dungeonProgress ?? {})
    .reduce((sum, prog) => sum + (prog.highestFloor ?? 0), 0)
}

/** Floors conquered specifically since joining their current guild. */
export function conquestSinceJoining(player) {
  if (!player.guildId) return 0
  return Math.max(0, totalFloorsConquered(player) - (player.guildJoinBaseline ?? 0))
}

/** All players currently belonging to `guildId`. */
export function getGuildMembers(guildId, allUsers) {
  return allUsers.filter(u => u.guildId === guildId)
}

/**
 * The current leader of a guild — highest conquest-since-joining, tied
 * broken by earliest join date (seniority). Returns null if empty.
 */
export function getGuildLeader(guildId, allUsers) {
  const members = getGuildMembers(guildId, allUsers)
  if (!members.length) return null
  return members.slice().sort((a, b) => {
    const diff = conquestSinceJoining(b) - conquestSinceJoining(a)
    if (diff !== 0) return diff
    return (a.guildJoinedAt ?? 0) - (b.guildJoinedAt ?? 0)
  })[0]
}

export function isGuildLeader(player, allUsers) {
  if (!player.guildId) return false
  const leader = getGuildLeader(player.guildId, allUsers)
  return leader?.id === player.id
}

export function findGuildByQuery(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  return guildDefs.find(g => g.id === q)
    ?? guildDefs.find(g => g.name.toLowerCase() === q)
    ?? guildDefs.find(g => g.name.toLowerCase().includes(q))
    ?? null
}

export function getGuildDef(guildId) {
  return guildDefs.find(g => g.id === guildId) ?? null
}

/**
 * Ensures db.data.guilds has a full record for every guild — banner/pfp
 * storage plus the treasury/contribution/motd progression fields owned by
 * lib/guild-engine.js. Both halves are backfilled here rather than at each
 * call site so a guild record is never half-shaped: ensureGuildProgress()
 * is idempotent, so running it over already-initialised guilds is free.
 */
export async function ensureGuildsInitialized(db) {
  if (!db.data.guilds) db.data.guilds = {}
  let changed = false
  for (const g of guildDefs) {
    if (!db.data.guilds[g.id]) {
      db.data.guilds[g.id] = { bannerPath: null, pfpPath: null, updatedAt: null, updatedBy: null }
      changed = true
    }
    const before = JSON.stringify(db.data.guilds[g.id])
    ensureGuildProgress(db.data.guilds[g.id])
    if (JSON.stringify(db.data.guilds[g.id]) !== before) changed = true
  }
  if (changed) await db.write()
  return db.data.guilds
}

/** The progression record for one guild, shape guaranteed. */
export function getGuildRecord(db, guildId) {
  if (!db.data.guilds) db.data.guilds = {}
  if (!db.data.guilds[guildId]) {
    db.data.guilds[guildId] = { bannerPath: null, pfpPath: null, updatedAt: null, updatedBy: null }
  }
  return ensureGuildProgress(db.data.guilds[guildId])
}

export { guildDefs }
