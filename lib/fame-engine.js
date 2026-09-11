/**
 * fame-engine.js — Astral Town's word-of-mouth system.
 *
 * Concept: every kill, floor cleared, boss felled, or level gained gets
 * talked about back in town. That talk becomes Fame. Fame is purely a
 * clout stat — it doesn't affect combat — but higher tiers pay a small
 * Solars trickle per victory and unlock Live Streaming (see stream.js).
 *
 * Payout is a random 20-40 Solars per dungeon win, scaled by fame tier —
 * higher tiers land toward the top of that range, low-paying tiers toward
 * the bottom. Tiers with payout: 0 still pay nothing.
 *
 * Player fields used (all optional / lazily initialised):
 *   fame           number   — total accumulated fame
 *   fameHistory    Array    — last 5 { event, value, gained, targetName, at }
 *   fameStatus     string   — headline shown on `.fame <player>`
 *   fameLastAction number   — Date.now() of last status update
 */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

// ── Tiers — label, emoji, and payout RANK (0-4) per win ─────────────────────
// `payout` here is a rank, not a currency amount: applyFamePayout() scales
// it into a random 20-40 Solars range (rank 0 = no payout at all, rank 4 =
// the top tier lands near 40, lower paying ranks land nearer 20).
export const FAME_TIERS = [
  { min: 250_000, label: "Realm's Chosen",   emoji: '🌌', payout: 4 },
  { min: 75_000,  label: 'Living Legend',    emoji: '👑', payout: 3 },
  { min: 20_000,  label: 'Astral Talebearer',emoji: '🌟', payout: 2 },
  { min: 5_000,   label: 'Rising Name',      emoji: '💫', payout: 1 },
  { min: 1_000,   label: 'Talk of the Town', emoji: '🔥', payout: 1 },
  { min: 250,     label: 'Known Face',       emoji: '⭐', payout: 0 },
  { min: 50,      label: 'Local Face',       emoji: '✨', payout: 0 },
  { min: 0,       label: 'Unknown',          emoji: '🌫️', payout: 0 },
]

export function getFameTier(fame) {
  return FAME_TIERS.find(t => (fame || 0) >= t.min) || FAME_TIERS[FAME_TIERS.length - 1]
}

export function getNextFameTier(fame) {
  return FAME_TIERS.slice().reverse().find(t => t.min > (fame || 0)) || null
}

// ── Number formatting — 63.7K, 4.2M, 1.2B ───────────────────────────────────
export function formatFame(n) {
  n = Math.floor(n || 0)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) {
    const v = n / 1_000
    return (v % 1 === 0 ? `${v}` : v.toFixed(1)) + 'K'
  }
  if (n < 1_000_000_000) {
    const v = n / 1_000_000
    return (v % 1 === 0 ? `${v}` : v.toFixed(1)) + 'M'
  }
  const v = n / 1_000_000_000
  return (v % 1 === 0 ? `${v}` : v.toFixed(1)) + 'B'
}

// ── Gain amounts per event — small and level/floor scaled ───────────────────
const GAIN_FN = {
  // A combat victory is a major fame event. Keep every kill at 100+ Fame so
  // winning feels meaningful even against a regular dungeon enemy.
  kill:        v => 100 + clamp(Math.floor(1 + Math.random() * 3 + Math.min(v || 1, 50) * 0.02), 1, 6),
  boss_kill:   v => 100 + clamp(Math.floor(8 + Math.random() * 10 + Math.min(v || 1, 100) * 0.04), 8, 22),
  floor_clear: v => clamp(Math.floor(2 + Math.random() * 3 + Math.min(v || 1, 100) * 0.03), 2, 8),
  level_up:    v => clamp(Math.floor(2 + Math.min(v || 1, 100) * 0.03), 2, 6),
}

const STATUS_FN = {
  kill:        (v, n) => `Put down *${n || 'a monster'}* without much trouble`,
  boss_kill:   (v, n) => `Felled the mighty *${n || 'a Boss'}*`,
  floor_clear: (v, n) => `Cleared Floor *${v}* of a dungeon`,
  level_up:    (v, n) => `Reached *Level ${v}*`,
}

function historyLabel(entry) {
  const n = entry.targetName ? ` (${entry.targetName})` : ''
  switch (entry.event) {
    case 'kill':        return `🗡️ Kill${n}`
    case 'boss_kill':   return `👑 Boss defeated${n}`
    case 'floor_clear': return `🗺️ Floor ${entry.value} cleared`
    case 'level_up':    return `📈 Reached Level ${entry.value}`
    case 'gift_out':    return `🎁 Gifted ${entry.value} fame${n}`
    case 'gift_in':     return `🎁 Received ${entry.value} fame${n}`
    default:            return entry.event
  }
}
export { historyLabel }

/**
 * Award fame for a gameplay event. Mutates the player in place — caller
 * (already inside updatePlayer's mutator) is responsible for persisting it.
 * Returns { gained, total, tierChanged, newTier }.
 */
export function awardFame(player, event, value = 1, targetName = null) {
  if (!player) return { gained: 0, total: 0, tierChanged: false }
  const gainFn = GAIN_FN[event]
  if (!gainFn) return { gained: 0, total: player.fame || 0, tierChanged: false }

  const gained   = gainFn(value)
  const prevTier = getFameTier(player.fame || 0)
  player.fame    = (player.fame || 0) + gained

  if (!Array.isArray(player.fameHistory)) player.fameHistory = []
  player.fameHistory.unshift({ event, value, gained, targetName, at: Date.now() })
  if (player.fameHistory.length > 5) player.fameHistory.length = 5

  const statusFn = STATUS_FN[event]
  if (statusFn) {
    player.fameStatus     = statusFn(value, targetName)
    player.fameLastAction = Date.now()
  }

  const newTier     = getFameTier(player.fame)
  const tierChanged = newTier.min !== prevTier.min && newTier.min > prevTier.min

  return { gained, total: player.fame, tierChanged, newTier }
}

/**
 * Applies the tier's Solars payout on a dungeon win. Mutates
 * player.wallet.solars. Returns the number of Solars added (0 if the
 * player's current fame tier doesn't pay out — see FAME_TIERS' `payout`
 * rank, 0 = no payout).
 *
 * Payout is a random 20-40 Solars, scaled by tier rank (0-4): rank 0 pays
 * nothing, rank 1 lands near the bottom of the range, rank 4 (top tier)
 * lands near the top.
 */
const PAYOUT_MIN = 20
const PAYOUT_MAX = 40
const MAX_RANK   = 4

export function applyFamePayout(player) {
  if (!player) return 0
  const tier = getFameTier(player.fame || 0)
  if (!tier.payout) return 0

  // Scale the 20-40 range by rank: each rank step gets its own sub-range
  // within [PAYOUT_MIN, PAYOUT_MAX] so higher tiers reliably pay more,
  // not just "more on average."
  const step     = (PAYOUT_MAX - PAYOUT_MIN) / MAX_RANK
  const rangeLo  = Math.round(PAYOUT_MIN + step * (tier.payout - 1))
  const rangeHi  = Math.round(PAYOUT_MIN + step * tier.payout)
  const solars   = rangeLo + Math.floor(Math.random() * (rangeHi - rangeLo + 1))

  player.wallet = player.wallet ?? {}
  player.wallet.solars = (player.wallet.solars ?? 0) + solars
  return solars
}
