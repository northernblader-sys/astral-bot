/**
 * rank-engine.js — Solo-Leveling-style hunter rank tiers.
 *
 * Ranks are purely cosmetic/derived from level — no data is stored on the
 * player. Tiers are defined in data/ranks.json, 10 levels apart, from
 * E-Rank Hunter (Lv 1) up to Shadow Sovereign (Lv 100).
 */
import { ranks, levelsData } from './game-data.js'

/** Slug used for rank tier thumbnail filenames: rank_<slug>.jpg */
export function rankSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** The rank tier a given level currently falls in. */
export function getRankForLevel(level) {
  return ranks.find(r => level >= r.min && level <= r.max) ?? ranks[ranks.length - 1]
}

/** The next rank tier above the given level, or null if already at the top. */
export function getNextRank(level) {
  const idx = ranks.findIndex(r => level >= r.min && level <= r.max)
  if (idx === -1 || idx === ranks.length - 1) return null
  return ranks[idx + 1]
}

/** Full Lv 1–100 rank table, formatted for display. */
export function formatRankTable() {
  return ranks
    .map(r => `${r.emoji} *${r.title}* _(${r.epithet})_ — Lv ${r.min}–${r.max}`)
    .join('\n')
}

/**
 * getXpProgress(level, xp) — how far into the current level a player is,
 * for drawing an XP progress bar (see plugins/rank.js).
 *
 * IMPORTANT: data/levels.json's xpTable is NOT a "cumulative total earned"
 * curve starting from 0 — it's read directly against player.xp (raw XP
 * earned since registration, starting at 0) by lib/combat-engine.js's
 * applyLevelUps(): a player hits level N the moment player.xp >= xpTable[N].
 * So xpTable[level] is really "the xp value at which the CURRENT level was
 * reached" for every level except level 1, whose floor is xp 0 (not
 * xpTable["1"], which is only the threshold for reaching level 1 from
 * level 0 — a state no registered player is ever in, since .register starts
 * everyone at level 1 already).
 *
 * Returns:
 *   pct        — 0–1 fraction of the way through the current level
 *   intoLevel  — xp earned since hitting the current level
 *   forLevel   — total xp needed to go from current level to the next
 *   xpToNext   — xp still needed to hit the next level
 *   maxed      — true if there's no further level (at/above levelCap)
 *
 * `capOverride` exists for reborn players, whose personal ceiling is 150
 * rather than the global 100 (see lib/reborn-engine.js's playerLevelCap()).
 * Without it a reborn player at Lv 100 would read as "maxed" and their XP
 * bar would sit pinned at 100% for fifty levels. Callers that have the
 * player object should pass playerLevelCap(player).
 */
export function getXpProgress(level, xp, capOverride = null) {
  const cap = capOverride ?? levelsData.levelCap ?? 100
  if (level >= cap) {
    return { pct: 1, intoLevel: 0, forLevel: 0, xpToNext: 0, maxed: true }
  }

  const currThreshold = level <= 1 ? 0 : (levelsData.xpTable[String(level)] ?? 0)
  const nextThreshold  = levelsData.xpTable[String(level + 1)] ?? currThreshold

  const forLevel  = Math.max(1, nextThreshold - currThreshold)
  const intoLevel = Math.max(0, Math.min(forLevel, xp - currThreshold))
  const xpToNext  = Math.max(0, nextThreshold - xp)
  const pct       = intoLevel / forLevel

  return { pct, intoLevel, forLevel, xpToNext, maxed: false }
}
