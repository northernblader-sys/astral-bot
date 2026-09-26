/**
 * guild-engine.js — the progression layer on top of lib/guild-repo.js.
 *
 * guild-repo.js answers "who is in this guild and who leads it". This module
 * answers "what has the guild built, and what does that get its members".
 * It is deliberately pure — every function takes a plain guild record and/or
 * player objects and returns numbers or descriptions, no db access — so the
 * whole thing is testable without a socket (see scripts/guild-pvp-check.mjs).
 *
 * TWO SEPARATE LADDERS, ON PURPOSE:
 *
 *   Leadership  — conquest since joining. Unchanged, still decided live by
 *                 getGuildLeader(). Money cannot buy the crown.
 *   Guild tier  — the treasury. Funded by member donations, and it is what
 *                 unlocks guild-wide perks.
 *
 * Keeping those apart is the whole design: a rich guild is a *comfortable*
 * guild, not a guild with a bought leader. Donating raises your standing
 * inside the guild (your role) and the guild's tier for everyone, but never
 * your claim to lead it.
 *
 * PERKS ARE PAID OUT AT THE POINT OF THE ACTION, NOT SWEPT. There is no cron
 * recalculating buffs — plugins/pvp.js reads spoilsPct when a duel settles
 * and duelSlots when a challenge is issued, so a guild that levels up mid-day
 * takes effect on the very next duel and a guild that a player just left
 * stops applying immediately. Nothing to expire, nothing to lose on restart.
 */
import { conquestSinceJoining } from './guild-repo.js'

/**
 * Treasury thresholds and what each unlocks. Perks are intentionally all
 * *outside* the combat formulas in lib/combat-engine.js — a guild can make
 * duels more rewarding and more frequent, but it can never make its members
 * hit harder, so guild tier can't turn PvP into a pay-to-win ladder.
 */
export const GUILD_TIERS = [
  { rank: 0, id: 'outpost',  name: 'Outpost',  treasury: 0,       spoilsPct: 0,   duelSlots: 0, restPct: 0,   blurb: 'A banner in the dirt and nothing else yet.' },
  { rank: 1, id: 'hall',     name: 'Guild Hall', treasury: 250_000, spoilsPct: 10,  duelSlots: 2, restPct: 5,   blurb: 'Four walls, a hearth, and somewhere to hang the banner.' },
  { rank: 2, id: 'bastion',  name: 'Bastion',  treasury: 1_500_000, spoilsPct: 20, duelSlots: 3, restPct: 10,  blurb: 'Stone, a training yard, and a quartermaster who knows your name.' },
  { rank: 3, id: 'citadel',  name: 'Citadel',  treasury: 6_000_000, spoilsPct: 30, duelSlots: 4, restPct: 15,  blurb: 'A seat of power. People come to Astral Town just to see it.' },
]

export const TIER_ORDER = [...GUILD_TIERS].sort((a, b) => a.rank - b.rank)

/** Roles inside a guild, earned by contribution. Cosmetic + a sort key. */
export const GUILD_ROLES = [
  { id: 'recruit',  name: 'Recruit',  emoji: '🔹', min: 0 },
  { id: 'soldier',  name: 'Soldier',  emoji: '🔸', min: 25_000 },
  { id: 'veteran',  name: 'Veteran',  emoji: '🎖️', min: 150_000 },
  { id: 'elite',    name: 'Elite',    emoji: '⭐', min: 600_000 },
  { id: 'champion', name: 'Champion', emoji: '💫', min: 2_000_000 },
]

/** Floors conquered are worth this much contribution each — so a broke
 *  player who actually climbs still outranks a wallet that never leaves town. */
export const MERIT_PER_FLOOR = 2_500

/** Smallest donation worth processing. Stops 1-solar spam from churning writes. */
export const MIN_DONATION = 100

/**
 * Ensures a guild's record has the progression fields. Mirrors ensureHome()'s
 * contract in lib/housing-engine.js: backfills shape onto records written
 * before this module existed without inventing history — treasury starts at
 * 0, founded stays null until something actually happens.
 */
export function ensureGuildProgress(record) {
  if (!record || typeof record !== 'object') return record
  if (typeof record.treasury !== 'number' || !Number.isFinite(record.treasury)) record.treasury = 0
  if (!record.contributions || typeof record.contributions !== 'object') record.contributions = {}
  if (typeof record.motd !== 'string') record.motd = null
  if (typeof record.motdBy !== 'string') record.motdBy = null
  if (typeof record.motdAt !== 'number') record.motdAt = null
  if (typeof record.donations !== 'number') record.donations = 0
  return record
}

/** The tier a treasury balance currently affords. Never returns null. */
export function guildTier(record) {
  const treasury = Math.max(0, record?.treasury ?? 0)
  let current = TIER_ORDER[0]
  for (const tier of TIER_ORDER) if (treasury >= tier.treasury) current = tier
  return current
}

/** The next tier up, or null once a guild is a Citadel. */
export function nextGuildTier(record) {
  const cur = guildTier(record)
  return TIER_ORDER.find(t => t.rank === cur.rank + 1) ?? null
}

/** Solars still needed to reach the next tier, or 0 at the top. */
export function treasuryToNextTier(record) {
  const next = nextGuildTier(record)
  if (!next) return 0
  return Math.max(0, next.treasury - Math.max(0, record?.treasury ?? 0))
}

/**
 * A member's contribution score: solars donated plus credit for the floors
 * they've cleared since joining. Both halves matter — see MERIT_PER_FLOOR.
 */
export function contributionOf(record, player) {
  const donated = record?.contributions?.[player?.id] ?? 0
  return Math.max(0, donated) + conquestSinceJoining(player ?? {}) * MERIT_PER_FLOOR
}

/** The role a contribution score earns. Never returns null. */
export function roleFor(score) {
  let role = GUILD_ROLES[0]
  for (const r of GUILD_ROLES) if (score >= r.min) role = r
  return role
}

/**
 * A guild's standing score, used to rank the five against each other.
 * Weighted so an active guild beats a rich-but-idle one: treasury is divided
 * down hard, while floors and member count carry real weight.
 */
export function guildPower(record, members) {
  const treasuryPoints = Math.floor(Math.max(0, record?.treasury ?? 0) / 10_000)
  const floorPoints = members.reduce((sum, m) => sum + conquestSinceJoining(m) * 10, 0)
  const levelPoints = members.reduce((sum, m) => sum + (m.level ?? 1), 0)
  const duelPoints = members.reduce((sum, m) => sum + (m.pvp?.wins ?? 0) * 5, 0)
  return treasuryPoints + floorPoints + levelPoints + duelPoints
}

/**
 * The perks a player's guild currently grants them. Returns the Outpost
 * baseline (all zeroes) for the guildless, so every caller can use the
 * numbers unconditionally without a null check.
 */
export function guildPerksFor(player, record) {
  if (!player?.guildId || !record) {
    return { tier: TIER_ORDER[0], spoilsPct: 0, duelSlots: 0, restPct: 0 }
  }
  const tier = guildTier(record)
  return { tier, spoilsPct: tier.spoilsPct, duelSlots: tier.duelSlots, restPct: tier.restPct }
}

/** Members sorted by contribution, each tagged with its score and role. */
export function rankMembers(record, members) {
  return members
    .map(m => {
      const score = contributionOf(record, m)
      return { player: m, score, role: roleFor(score), donated: record?.contributions?.[m.id] ?? 0 }
    })
    .sort((a, b) => b.score - a.score || (a.player.guildJoinedAt ?? 0) - (b.player.guildJoinedAt ?? 0))
}

/** "1.5M" / "250K" / "900" — treasury figures get long fast. */
export function shortSolars(n) {
  const v = Math.max(0, Math.floor(n ?? 0))
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`
  return String(v)
}

