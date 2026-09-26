/**
 * effectiveness-engine.js — Season System Spec §14, "The Effectiveness
 * System". A general combat-balance layer: given an enemy and a move
 * category, returns a numeric grade (multiplier) for how effective that
 * move is against that enemy's type — used by Willow's advisor
 * (plugins/willow.js) to recommend the best available move.
 *
 * ADVISORY ONLY (open question #36, resolved): nothing in this file
 * mutates damage. combat-engine.js / ability-engine.js / attack.js are all
 * untouched by this module — it is a pure read-only lookup, called only
 * from plugins/willow.js.
 *
 * SCOPE (open question #38, resolved): data/effectiveness.json documents
 * the 8 monster `type` values that exist across the 41 anime bosses today
 * plus the Season 1 dungeon roster — not a retroactive grading pass over
 * every regular monster in data/monsters.json (most of which have no
 * `type` field at all; see data/effectiveness.json's header comment).
 * gradeMove() degrades gracefully to a neutral 1x grade for anything
 * without type data rather than throwing, so it's always safe to call.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const effectivenessData = require('../data/effectiveness.json')

const { moveCategories, matchups, overrides, season01Enemies } = effectivenessData

const overrideMap = Object.fromEntries((overrides ?? []).map((o) => [`${o.monsterId}:${o.category}`, o.grade]))

/** Resolve type/weakTo/resistTo for an enemy — anime bosses carry these natively (bosses/*.js); Season 1 dungeon regulars are backfilled from data/effectiveness.json's season01Enemies table. */
function resolveMonsterTypeInfo(enemy) {
  if (enemy?.type) {
    return {
      type: enemy.type,
      weakTo: enemy.weakTo ?? [],
      resistTo: enemy.resistTo ?? [],
    }
  }
  const fallback = season01Enemies?.[enemy?.id]
  if (fallback) return fallback
  return null
}

/**
 * gradeMove(enemy, category) -> { grade: number, label: string, tier: string }
 *
 * category is one of moveCategories' keys ('physical' | 'magic' | 'holy' | 'severing').
 * Falls back to a neutral 1x grade ("Untested") if the enemy has no type
 * data or the category is unrecognized — this keeps Willow safe to call
 * against any enemy in the game, not just Season 1 content.
 */
export function gradeMove(enemy, category) {
  if (!moveCategories[category]) {
    return { grade: 1, label: 'Unknown move', tier: 'neutral' }
  }

  const perOverride = overrideMap[`${enemy?.id}:${category}`]
  if (perOverride !== undefined) {
    return { grade: perOverride, label: moveCategories[category].label, tier: tierFor(perOverride) }
  }

  const info = resolveMonsterTypeInfo(enemy)
  if (!info) {
    return { grade: 1, label: moveCategories[category].label, tier: 'neutral' }
  }

  let grade = matchups[category]?.[info.type] ?? 1

  // A boss's own authored weakTo/resistTo (bosses/*.js) pushes the base
  // type grade one further step in that direction — see
  // data/effectiveness.json's _matchup_notes.
  if (info.weakTo?.includes(category)) grade = Math.min(2, grade * 1.34)
  if (info.resistTo?.includes(category)) grade = Math.max(0.5, grade * 0.67)

  grade = Math.round(grade * 100) / 100

  return { grade, label: moveCategories[category].label, tier: tierFor(grade) }
}

function tierFor(grade) {
  if (grade >= 1.75) return 'super-effective'
  if (grade >= 1.15) return 'effective'
  if (grade <= 0.6) return 'weak'
  if (grade < 0.9) return 'resisted'
  return 'neutral'
}

const TIER_EMOJI = {
  'super-effective': '🌟',
  effective: '✅',
  neutral: '➖',
  resisted: '🛡️',
  weak: '❌',
}

/**
 * buildMoveOptions(player, enemy) -> array of { key, name, category, grade, tier, emoji }
 *
 * Enumerates the moves actually available to `player` right now — basic
 * attack (always available), equipped skills, the equipped character's
 * ability (if it has a combat category), and an equipped weapon's named
 * passive (if it carries a category tag) — grades each against `enemy`,
 * and returns them sorted best-to-worst. This is the list
 * plugins/willow.js reads to pick and display the top recommendation.
 */
export function buildMoveOptions(player, enemy, { skills = [], namedWeaponCategory = null, characterCategory = null, characterName = null } = {}) {
  const options = []

  options.push({ key: 'attack', name: 'Basic Attack', category: 'physical' })

  for (const skill of skills) {
    const category = skill.category ?? (skill.effects?.some((e) => e.stat === 'int') ? 'magic' : 'physical')
    options.push({ key: `skill:${skill.id}`, name: skill.name, category })
  }

  if (characterCategory) {
    options.push({ key: 'ability', name: characterName ?? 'Character Ability', category: characterCategory })
  }

  if (namedWeaponCategory) {
    options.push({ key: 'weapon', name: 'Equipped Weapon Effect', category: namedWeaponCategory })
  }

  return options
    .map((opt) => {
      const { grade, tier } = gradeMove(enemy, opt.category)
      return { ...opt, grade, tier, emoji: TIER_EMOJI[tier] ?? '➖' }
    })
    .sort((a, b) => b.grade - a.grade)
}

export { moveCategories }
