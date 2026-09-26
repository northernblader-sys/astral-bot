/**
 * title-engine.js — the post-level-200 prestige title ladder.
 *
 * Once a player hits the (reborn) level ceiling, ordinary levelling stops:
 * applyLevelUps() in combat-engine.js simply exits its while loop the moment
 * player.level === playerLevelCap(player), and every XP point earned after
 * that point keeps accumulating in the cumulative player.xp field but does
 * nothing (see plugins/admin.js's own note that player.xp is cumulative and
 * only ever turned into levels by applyLevelUps()).
 *
 * This module gives that "wasted" post-cap XP somewhere to go: a separate
 * counter (player.prestige.xp) that only starts filling once the player is
 * maxed, and that climbs a four-rung ladder of titles instead of levels.
 * Nothing here reads or writes player.xp/player.level — creditPrestigeXp()
 * is called by the combat reward path (lib/combat-handlers.js's
 * creditKill()) specifically when the player is already at their level cap,
 * with the same xp number that would otherwise have gone to player.xp for
 * nothing.
 *
 * Titles are drawn with lib/title-glyphs.js's DejaVu-incompatible glyphs
 * (Enclosed Alphanumeric Supplement — see lib/fonts.js's Noto Sans Symbols
 * registration), not plain text, per the design brief: "Ⓟⓡⓞ" is the string,
 * not "Pro".
 *
 * PACING
 * The brief asked for "roughly one full year of active gameplay" per rung.
 * That is deliberately NOT derived from the kill-rate formulas in
 * xp-regulator.js the way ordinary levelling is — those formulas describe
 * a smooth minutes-to-hours curve, and stretching that same formula out to
 * a one-year target would require either absurdly small per-kill numbers
 * (which would look broken next to ordinary XP) or an arbitrary extra
 * multiplier with no more real precision than picking the year-scale
 * threshold directly. So the thresholds below are large, round, hand-picked
 * numbers rather than a formula output — tune PRESTIGE_TIER_XP directly if
 * the grind needs to move faster or slower after real players start
 * climbing it.
 */

/**
 * The hierarchy, lowest to highest. `xpRequired` is the TOTAL prestige XP
 * needed to REACH that tier (i.e. cumulative, like player.xp against
 * xpTable — not "xp needed since the previous tier"). Ⓟⓡⓞ is granted the
 * instant a player dings level 200, at 0 prestige XP, same as how hitting
 * level 1 requires 0 xp.
 */
export const PRESTIGE_TIERS = [
  { id: 'pro', glyph: 'Ⓟⓡⓞ', name: 'Pro',         xpRequired: 0 },
  { id: 'am',  glyph: 'Ⓐ🅜',  name: 'Am',          xpRequired: 150_000_000 },
  { id: 'gm',  glyph: 'Ⓖ🅜',  name: 'GM',          xpRequired: 450_000_000 },
  { id: 'lm',  glyph: 'Ⓛ🅜',  name: 'LM',          xpRequired: 900_000_000 },
]

export const MAX_PRESTIGE_TIER = PRESTIGE_TIERS[PRESTIGE_TIERS.length - 1]

/** True once player.level has reached their personal (reborn) cap of 200. */
export function isTitled(player, levelCap) {
  return (player?.level ?? 0) >= levelCap
}

/** The tier a given amount of prestige XP currently falls in. */
export function getTierForXp(xp) {
  const total = Math.max(0, Number(xp) || 0)
  let current = PRESTIGE_TIERS[0]
  for (const tier of PRESTIGE_TIERS) {
    if (total >= tier.xpRequired) current = tier
  }
  return current
}

/** The tier above the given one, or null if already at Ⓛ🅜. */
export function getNextTier(tierId) {
  const idx = PRESTIGE_TIERS.findIndex((t) => t.id === tierId)
  if (idx === -1 || idx === PRESTIGE_TIERS.length - 1) return null
  return PRESTIGE_TIERS[idx + 1]
}

/**
 * getPrestigeProgress(xp) — progress within the CURRENT tier, shaped like
 * lib/rank-engine.js's getXpProgress() so callers/renderers that already
 * know that shape (pct, intoLevel/forLevel, xpToNext, maxed) don't need a
 * second mental model for this one.
 */
export function getPrestigeProgress(xp) {
  const total = Math.max(0, Number(xp) || 0)
  const tier = getTierForXp(total)
  const next = getNextTier(tier.id)

  if (!next) {
    return { tier, next: null, pct: 1, intoTier: 0, forTier: 0, xpToNext: 0, maxed: true }
  }

  const forTier = Math.max(1, next.xpRequired - tier.xpRequired)
  const intoTier = Math.max(0, Math.min(forTier, total - tier.xpRequired))
  return {
    tier,
    next,
    pct: intoTier / forTier,
    intoTier,
    forTier,
    xpToNext: Math.max(0, next.xpRequired - total),
    maxed: false,
  }
}

/**
 * ensurePrestige(player) — lazily initialises player.prestige for a player
 * who has just reached the level cap (or predates this field entirely).
 * Safe to call unconditionally; a no-op once the field already exists.
 */
export function ensurePrestige(player) {
  if (!player.prestige || typeof player.prestige.xp !== 'number') {
    player.prestige = { xp: 0 }
  }
  return player.prestige
}

/**
 * creditPrestigeXp(player, xp) -> { gained, tierChange } | null
 *
 * Adds `xp` to the player's prestige counter and reports a tier-up if one
 * occurred. Returns null (and touches nothing) if the player isn't titled
 * yet — callers that already gate on isTitled() before calling this won't
 * hit that path, but it's cheap insurance against a bad call site crediting
 * prestige XP to a sub-200 player.
 *
 * `levelCap` must be the player's OWN cap (playerLevelCap(player) from
 * lib/reborn-engine.js), not the global constant, for the same reason every
 * other cap-aware call in this codebase takes it as a parameter rather than
 * importing the global levelsData.levelCap directly.
 */
export function creditPrestigeXp(player, xp, levelCap) {
  if (!isTitled(player, levelCap)) return null
  const gained = Math.max(0, Math.floor(Number(xp) || 0))
  if (gained <= 0) return null

  const state = ensurePrestige(player)
  const before = getTierForXp(state.xp)
  state.xp += gained
  const after = getTierForXp(state.xp)

  return {
    gained,
    tierChange: after.id !== before.id ? { from: before, to: after } : null,
  }
}
