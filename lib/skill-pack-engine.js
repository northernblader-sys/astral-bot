/**
 * skill-pack-engine.js — pull logic for Skill Packs (data/skill-packs.json).
 *
 * A pack purchase is `pullsPerPurchase` (currently 3) independent weighted
 * rolls against the pack's own `odds` (per-tier percentages), each roll
 * picking uniformly among that tier's skills within the shared pool
 * (every data/skills.json entry with `source: 'skill_pack'`).
 *
 * Duplicate pulls (a skill the player already owns) are skipped, not
 * replaced — per spec, a purchase can net fewer than `pullsPerPurchase`
 * new skills if unlucky. This module only computes the roll; the caller
 * (plugins/skillpack.js) is responsible for actually granting the result
 * via updatePlayer, same as every other purchase in this codebase.
 */
import { skills, skillPacks } from './game-data.js'

/** All pack-exclusive skills, grouped by tier. Computed once at import. */
const POOL_BY_TIER = (() => {
  const byTier = {}
  for (const s of skills) {
    if (s.source !== 'skill_pack') continue
    ;(byTier[s.tier] ??= []).push(s)
  }
  return byTier
})()

/** Find a pack definition by id or any of its aliases (case-insensitive). */
export function findPack(query) {
  const q = String(query ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  return skillPacks.packs.find(p =>
    p.id === q || (p.aliases ?? []).some(a => a.replace(/\s+/g, '_') === q),
  ) ?? null
}

export function allPacks() {
  return skillPacks.packs
}

/** Weighted-random tier pick from a pack's odds table. */
function rollTier(odds) {
  const entries = Object.entries(odds)
  const total = entries.reduce((sum, [, w]) => sum + w, 0)
  let roll = Math.random() * total
  for (const [tier, weight] of entries) {
    roll -= weight
    if (roll <= 0) return tier
  }
  return entries[entries.length - 1][0]
}

/**
 * Performs `pack.pullsPerPurchase` rolls. `ownedSkillIds` is the player's
 * current player.skills array (checked fresh against each successive pull,
 * so two pulls landing on the same new skill within one purchase also only
 * grants it once).
 *
 * Returns { hits, wasted } — hits: array of skill objects newly granted
 * (in pull order); wasted: count of pulls that landed on an already-owned
 * skill and were skipped.
 */
export function pullPack(pack, ownedSkillIds) {
  const owned = new Set(ownedSkillIds ?? [])
  const hits = []
  let wasted = 0

  for (let i = 0; i < pack.pullsPerPurchase; i++) {
    const tier = rollTier(pack.odds)
    const pool = POOL_BY_TIER[tier] ?? []
    if (!pool.length) { wasted++; continue }

    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (owned.has(pick.id)) {
      wasted++
      continue
    }
    owned.add(pick.id) // so a second pull this same purchase can't double-grant it
    hits.push(pick)
  }

  return { hits, wasted }
}
