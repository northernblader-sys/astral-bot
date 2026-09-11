/**
 * stat-packs.js — Stat Pack Boosts, the Game Shop's one-shot stat purchases
 * (see plugins/gm.js's Stat Packs section).
 *
 * Three tiers, defined in data/game-shop.json's statPacks. Opening one rolls a
 * random point total inside the tier's band and scatters it across a random
 * handful of STR/AGI/INT/DEF/LCK — a Lesser pack rolling 50 might land as
 * +30 STR, +10 AGI, +10 LCK. Each tier is buyable exactly once per player, so
 * the three purchases are a lifetime ceiling of one pack per band.
 *
 * The gains are NOT stat points: they never touch player.statPoints, so they
 * can't be respecced and — importantly — they don't inflate `earned`, which
 * would otherwise shrink the room grantLevelStatPoints() has left and quietly
 * eat the player's next few level-up points (lib/stat-progression.js).
 *
 * They are instead a flat permanent bonus baked into baseStats/stats, which
 * means — exactly like the reborn reward — every site that rebuilds baseStats
 * from getTotalStats() has to add them back in or they silently evaporate on
 * the player's next level up. All three of those sites call statPackBonus():
 *   lib/combat-engine.js's applyLevelUps()
 *   lib/stat-progression.js's ensureStatPoints()
 *   lib/reborn-engine.js's applyRebornFailure()
 *
 * This module deliberately imports nothing else from lib/ —
 * stat-progression.js depends on it, so an import back the other way would be
 * a cycle.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const gameShop = require('../data/game-shop.json')

/** The five packable stats. Kept local rather than imported from
 *  stat-progression.js (which imports this module) to avoid a cycle. */
const STATS = ['str', 'agi', 'int', 'def', 'lck']

export const STAT_PACK_STATS = STATS

/** Display labels for a rolled result, in the same emoji vocabulary the
 *  level-up message in lib/combat-engine.js uses. */
export const STAT_PACK_LABELS = {
  str: '💪 STR',
  agi: '🏃 AGI',
  int: '🧠 INT',
  def: '🛡️ DEF',
  lck: '🍀 LCK',
}

/** How many different stats a single pack can spread its total across. */
const MIN_SPREAD = 2
const MAX_SPREAD = 5

export const statPacks = (gameShop.statPacks ?? []).map((p) => ({
  ...p,
  min: Math.max(1, Math.floor(Number(p.min) || 1)),
  max: Math.max(1, Math.floor(Number(p.max) || 1)),
  aliases: (p.aliases ?? []).map((a) => String(a).toLowerCase()),
}))

// ".gm buy stat pack boost low" and ".gm buy low" should both land on the same
// tier, so the family name is stripped off before the remainder is matched
// against the tier's aliases.
const FAMILY_PREFIX = /^(stat|stats)[\s_]*(pack|packs)?[\s_]*(boost|boosts)?[\s_]*/

/** Resolves an id, full name, tier word or alias to a pack. Null if no match. */
export function findStatPack(query) {
  const raw = String(query ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
  if (!raw) return null

  const candidates = new Set([raw, raw.replace(/ /g, '_')])
  const stripped = raw.replace(FAMILY_PREFIX, '').trim()
  if (stripped) {
    candidates.add(stripped)
    candidates.add(stripped.replace(/ /g, '_'))
  }

  for (const pack of statPacks) {
    const names = new Set([
      pack.id,
      pack.tier,
      pack.name.toLowerCase(),
      pack.name.toLowerCase().replace(/ /g, '_'),
      ...pack.aliases,
    ])
    for (const c of candidates) if (names.has(c)) return pack
  }
  return null
}

export function purchasedStatPacks(player) {
  const list = player?.statPacks?.purchased
  return Array.isArray(list) ? list : []
}

export function ownsStatPack(player, packId) {
  return purchasedStatPacks(player).includes(packId)
}

/**
 * The permanent per-stat bonus this player has bought, as a full five-key map
 * of non-negative integers. Safe to call on any player — a save that has never
 * bought a pack reads back as all zeros.
 */
export function statPackBonus(player) {
  const bonus = player?.statPacks?.bonus
  const out = {}
  for (const key of STATS) {
    out[key] = Math.max(0, Math.floor(Number(bonus?.[key]) || 0))
  }
  return out
}

/** Splits `total` into `parts` positive integers, randomly and exactly. */
function splitTotal(total, parts, rand) {
  if (parts <= 1) return [total]
  // A random composition: parts-1 distinct cut points inside [1, total-1].
  // parts is always clamped to <= total by the caller, so there are always
  // enough distinct positions for the loop to fill.
  const cuts = new Set()
  while (cuts.size < parts - 1) cuts.add(1 + Math.floor(rand() * (total - 1)))

  const sorted = [...cuts].sort((a, b) => a - b)
  const out = []
  let prev = 0
  for (const cut of sorted) { out.push(cut - prev); prev = cut }
  out.push(total - prev)
  return out
}

/**
 * Rolls a pack without applying it. Returns { total, gains } where gains is a
 * full five-key map (stats that missed out are 0) summing to exactly total.
 */
export function rollStatPack(pack, rand = Math.random) {
  const min = Math.max(1, Math.floor(Number(pack.min) || 1))
  const max = Math.max(min, Math.floor(Number(pack.max) || min))
  const total = min + Math.floor(rand() * (max - min + 1))

  const order = [...STATS]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }

  const spread = Math.min(total, MIN_SPREAD + Math.floor(rand() * (MAX_SPREAD - MIN_SPREAD + 1)))
  const parts = splitTotal(total, spread, rand)

  const gains = Object.fromEntries(STATS.map((k) => [k, 0]))
  order.slice(0, spread).forEach((key, i) => { gains[key] = parts[i] })
  return { total, gains }
}

/**
 * Rolls the pack and writes the result into the player: records the purchase,
 * banks the bonus for future baseStats rebuilds, and raises both baseStats
 * (the death/level-up anchor) and stats (the live values gear adds on top of).
 *
 * Caller must be inside updatePlayer() and must have already checked gems and
 * ownsStatPack(). Returns the roll so it can be shown to the player.
 */
export function applyStatPack(player, pack, rand = Math.random) {
  const roll = rollStatPack(pack, rand)

  const state = player.statPacks ?? (player.statPacks = {})
  state.purchased = [...purchasedStatPacks(player), pack.id]
  state.bonus = state.bonus ?? {}
  player.stats = player.stats ?? {}
  player.baseStats = player.baseStats ?? {}

  for (const key of STATS) {
    const gain = roll.gains[key]
    if (!gain) continue
    state.bonus[key] = (Number(state.bonus[key]) || 0) + gain
    player.stats[key] = (Number(player.stats[key]) || 0) + gain
    player.baseStats[key] = (Number(player.baseStats[key]) || 0) + gain
  }

  return roll
}

/** "💪 STR +30 · 🏃 AGI +10 · 🍀 LCK +10" — only the stats that actually rolled. */
export function formatStatPackGains(gains, separator = '  ·  ') {
  return STATS
    .filter((key) => (gains?.[key] ?? 0) > 0)
    .map((key) => `${STAT_PACK_LABELS[key]} *+${gains[key]}*`)
    .join(separator)
}
