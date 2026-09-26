/**
 * Shared stat-point rules.
 *
 * Level 100 is the hard cap and the complete level-derived pool is 1,500
 * points, so every level contributes 15 points to the lifetime ceiling.
 * Existing saves are rebased onto the new automatic level growth while their
 * old base-stat investment is preserved as explicit allocations.
 *
 * A player who has completed the Reborn ritual (plugins/reborn.js) carries a
 * higher personal ceiling: level 200 and 3,000 points. Pass the player object
 * alongside the level wherever one is available so the reborn ceiling is
 * used instead of the global one; the level-only call shape still works and
 * still answers for a normal player.
 */
import { getTotalStats, levelsData } from './game-data.js'
import { playerLevelCap, playerMaxStatPoints, rebornStatBonus } from './reborn-engine.js'
import { statPackBonus } from './stat-packs.js'

export const STAT_KEYS = ['str', 'agi', 'int', 'def', 'lck']
export const STAT_POINT_VERSION = 2

export function statPointCap(level, player = null) {
  const max = player ? playerMaxStatPoints(player) : (levelsData.maxStatPoints ?? 1500)
  const perLevel = levelsData.statPointsPerLevel ?? 15
  return Math.min(max, Math.max(0, Math.floor(Number(level) || 0) * perLevel))
}

export function emptyAllocations() {
  return Object.fromEntries(STAT_KEYS.map((key) => [key, 0]))
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

/**
 * Backfills a player's point state without changing their current power.
 * This is also safe to call lazily for a save that missed startup migration.
 */
export function ensureStatPoints(player) {
  if (
    player.statPoints?.version === STAT_POINT_VERSION &&
    player.statPoints &&
    Number.isFinite(player.statPoints.unallocated)
  ) {
    return player.statPoints
  }

  const level = Math.min(playerLevelCap(player), Math.max(1, Number(player.level) || 1))
  const canonical = getTotalStats(player.classId, player.raceId, level)
  const oldBase = player.baseStats ?? player.stats ?? {}
  const allocations = emptyAllocations()
  // The reborn reward is a flat bonus baked into baseStats that no formula
  // can reproduce, so it has to be lifted out before the difference below is
  // read as "points the player allocated" and put back when baseStats is
  // rebuilt. Without this, a reborn player's migration would mistake the
  // +100s for 500 spent stat points.
  const rb = rebornStatBonus(player)
  // Stat Pack Boosts (lib/stat-packs.js) are the same kind of unformulaic flat
  // bonus as the reborn reward, so they get the same treatment: lifted out of
  // the difference below so a bought pack is never mistaken for spent points,
  // and put back when baseStats is rebuilt.
  const sp = statPackBonus(player)

  for (const key of STAT_KEYS) {
    allocations[key] = Math.max(
      0,
      Math.floor(numberOrZero(oldBase[key]) - numberOrZero(canonical[key]) - rb.stat - sp[key]),
    )
  }

  const cap = statPointCap(level, player)
  let remaining = cap
  for (const key of STAT_KEYS) {
    allocations[key] = Math.min(allocations[key], remaining)
    remaining -= allocations[key]
  }
  const spent = cap - remaining
  const state = {
    version: STAT_POINT_VERSION,
    earned: cap,
    spent,
    unallocated: cap - spent,
    allocations,
  }
  player.statPoints = state

  // Preserve equipment bonuses by applying them as the difference between
  // the live stats and the old base stats. The reborn bonus lifted out above
  // goes back in here, so a reborn player comes out of migration with the
  // same power they went in with.
  player.baseStats = {
    ...canonical,
    ...Object.fromEntries(
      STAT_KEYS.map((key) => [key, canonical[key] + allocations[key] + rb.stat + sp[key]]),
    ),
    maxHp: canonical.maxHp + rb.maxHp,
  }
  for (const key of STAT_KEYS) {
    const gearDelta = numberOrZero(player.stats?.[key]) - numberOrZero(oldBase[key])
    player.stats[key] = canonical[key] + allocations[key] + rb.stat + sp[key] + gearDelta
  }
  const hpGearDelta = numberOrZero(player.maxHp) - numberOrZero(oldBase.maxHp)
  const mpGearDelta = numberOrZero(player.maxMp) - numberOrZero(oldBase.maxMp)
  player.maxHp = canonical.maxHp + rb.maxHp + hpGearDelta
  player.maxMp = canonical.maxMp + mpGearDelta
  player.hp = Math.min(numberOrZero(player.hp), player.maxHp)
  player.mp = Math.min(numberOrZero(player.mp), player.maxMp)
  return state
}

export function grantLevelStatPoints(player, previousLevel, nextLevel) {
  const state = ensureStatPoints(player)
  const added = Math.max(
    0,
    statPointCap(nextLevel, player) - statPointCap(previousLevel, player),
  )
  const room = Math.max(0, statPointCap(nextLevel, player) - state.earned)
  const granted = Math.min(added, room)
  state.earned += granted
  state.unallocated += granted
  return granted
}

export function addAllocation(player, stat, amount) {
  const state = ensureStatPoints(player)
  const key = String(stat).toLowerCase()
  const points = Math.floor(Number(amount))
  if (!STAT_KEYS.includes(key) || !Number.isFinite(points) || points <= 0) {
    return { ok: false, error: 'invalid' }
  }
  if (points > state.unallocated) {
    return { ok: false, error: 'not_enough', available: state.unallocated }
  }

  state.unallocated -= points
  state.spent += points
  state.allocations[key] += points
  player.baseStats[key] = (player.baseStats[key] ?? 0) + points
  player.stats[key] = (player.stats[key] ?? 0) + points
  return { ok: true, points, stat: key, remaining: state.unallocated }
}

export function trainCostPerPoint(level) {
  const training = levelsData.statTraining ?? {}
  return Math.max(
    1,
    Math.floor(
      (training.baseCostPerPoint ?? 100) +
      (Math.max(1, Number(level) || 1) * (training.costPerLevel ?? 25)),
    ),
  )
}

export function trainPlayer(player, amount) {
  const state = ensureStatPoints(player)
  const cap = statPointCap(player.level, player)
  const room = Math.max(0, cap - state.earned)
  const points = Math.floor(Number(amount))
  if (!Number.isFinite(points) || points <= 0) {
    return { ok: false, error: 'invalid' }
  }
  if (room <= 0) return { ok: false, error: 'full', cap }

  const granted = Math.min(points, room)
  const cost = granted * trainCostPerPoint(player.level)
  const wallet = player.wallet ?? (player.wallet = {})
  if ((wallet.solars ?? 0) < cost) {
    return {
      ok: false,
      error: 'poor',
      cost,
      have: wallet.solars ?? 0,
      points: granted,
    }
  }

  wallet.solars -= cost
  state.earned += granted
  state.unallocated += granted
  return { ok: true, points: granted, cost, remaining: state.unallocated }
}

export function migrateAllPlayers(users) {
  let changed = false
  for (const player of Object.values(users ?? {})) {
    if (player?.statPoints?.version === STAT_POINT_VERSION) continue
    ensureStatPoints(player)
    changed = true
  }
  return changed
}