/**
 * rarity.js — shared rarity display helpers.
 *
 * Before this, ~12 files each had their own local rarity→emoji dict, and
 * they didn't even agree with each other: inventory.js/shop.js/roam.js used
 * ⬜🟩🟦🟪🟨, while ability.js/craft.js/pet.js/profile.js/spin.js/summon.js/
 * table.js used ⚪🟢🔵🟣🟡 — the *same five tiers* rendered as different
 * colored squares depending which command showed them. Flat color squares
 * are also hard to tell apart at a glance (worse for colorblind players)
 * and don't read as "rarity" so much as "a colored square."
 *
 * This replaces all of that with one star-rating badge (1★ common through
 * 5★ legendary) — the scale itself communicates value, not just a color
 * you have to memorize, and it's the same everywhere in the bot.
 */

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary']

const RARITY_RANK = Object.fromEntries(RARITY_ORDER.map((r, i) => [r, i + 1]))

const FILLED = '★'
const EMPTY = '☆'

/**
 * The tier above legendary is spelled BOTH ways in the data, and for a long
 * time only one of them worked here:
 *   "mythic"   — data/characters.json (Mei), all 14 data/auction.json
 *                weapons, data/season-01-content.json's mythic_box, and
 *                data/skill-tiers.json (where it sits above legendary at a
 *                3.8x multiplier vs legendary's 3.0x). 16 uses.
 *   "mythical" — data/beasts.json only. 2 uses.
 * They mean the same tier. Until this set existed, rarityLabel('mythic')
 * returned "Unknown" and rarityStars('mythic') returned an all-empty bar, so
 * every auction weapon and Mei herself rendered as an unrecognized rarity.
 *
 * Treating them as aliases here (rather than rewriting the JSON) keeps both
 * spellings valid forever, so neither existing data nor future authoring can
 * reintroduce the bug. Note this is unrelated to plugins/skillpack.js's local
 * TIER_ORDER, where "mythic" is the 5th of 5 *pack* tiers and legendary is
 * absent entirely — that ladder is its own thing and is left alone.
 */
const MYTHIC_SPELLINGS = new Set(['mythic', 'mythical'])

/** Lowercased/trimmed rarity key, or '' for null/non-string input. */
function canon(rarity) {
  return typeof rarity === 'string' ? rarity.trim().toLowerCase() : ''
}

/**
 * Full 5-star bar for a rarity, e.g. "★★★☆☆" for rare.
 * "mythic"/"mythical" sits above legendary: all 5 stars filled plus a sparkle
 * accent, since it's rarer than max-tier. "boundless" sits above even that —
 * the ceiling tier, reserved for one-of-one globally-locked characters
 * (data/characters.json's Demon Lord Anastasia and Circe, the Jester), so it
 * gets the full bar plus a distinct cosmos accent rather than a sixth star,
 * keeping every bar exactly 5 stars wide.
 * Unrecognized rarity → all-empty.
 */
export function rarityStars(rarity) {
  const r = canon(rarity)
  if (r === 'boundless') return `${FILLED.repeat(5)}🌌`
  if (MYTHIC_SPELLINGS.has(r)) return `${FILLED.repeat(5)}✨`
  const filled = RARITY_RANK[r] ?? 0
  return FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, 5 - filled))
}

/**
 * Capitalized display label, e.g. "Legendary". Unknown → "Unknown".
 * The two mythic spellings are deliberately NOT normalized to one word here:
 * each is echoed back as authored ("Mythic" for auction weapons and Mei,
 * "Mythical" for beasts), matching what those parts of the bot already print
 * elsewhere (e.g. plugins/mei-spin.js uppercases the raw value to "MYTHIC").
 */
export function rarityLabel(rarity) {
  const r = canon(rarity)
  if (r === 'boundless') return 'Boundless'
  if (!r || (!RARITY_RANK[r] && !MYTHIC_SPELLINGS.has(r))) return 'Unknown'
  return r.charAt(0).toUpperCase() + r.slice(1)
}

/** "★★★★★ Legendary" — stars + name together, for detail views / headers. */
export function rarityBadge(rarity) {
  return `${rarityStars(rarity)} ${rarityLabel(rarity)}`
}

/**
 * Character star rating (1-5) -> a plain five-slot star bar, e.g. "★★★★☆".
 *
 * Characters are rated on their own explicit 1-5 star scale (the `stars` field
 * in data/characters.json), independent of the item `rarity` ladder above.
 * Only Circe, Gojo and Yato sit at the full five stars. This is what every
 * character screen shows now, in place of a tier WORD like "Boundless" or
 * "Mythic". A missing or out-of-range value is clamped into [0,5].
 */
export function characterStars(stars) {
  const n = Math.max(0, Math.min(5, Math.round(Number(stars) || 0)))
  return FILLED.repeat(n) + EMPTY.repeat(5 - n)
}

/** Numeric rank (1-5, common→legendary; 6 mythic/mythical, 7 boundless), 0 if unrecognized. For sorting. */
export function rarityRank(rarity) {
  const r = canon(rarity)
  if (r === 'boundless') return 7
  if (MYTHIC_SPELLINGS.has(r)) return 6
  return RARITY_RANK[r] ?? 0
}

/** Sort comparator: highest rarity first. */
export function byRarityDesc(a, b) {
  return rarityRank(b?.rarity) - rarityRank(a?.rarity)
}
