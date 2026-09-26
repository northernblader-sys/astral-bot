/**
 * lib/xp-regulator.js
 * ─────────────────────────────────────────────────────────────────────────
 * Centralizes ALL monster/boss XP into one tunable formula, replacing the
 * per-monster xpBase/xpPerFloor values baked into data/monsters.json.
 *
 * WHY: with 917 regular monsters hand-tuning individual xpBase/xpPerFloor
 * values is unmaintainable, and any of them can silently break the
 * intended pacing. This module derives XP purely from:
 *   1) the fixed level curve in data/levels.json (xpTable),
 *   2) the player's "expected level" at the current floor (interpolated
 *      from that dungeon's levelRange in data/locations.json),
 *   3) a monster tier multiplier (weak / medium / strong / elite / boss)
 *      derived from floor position relative to the dungeon's boss floors.
 *
 * This is intentionally a HARD game: killing a single weak monster should
 * never meaningfully dent a level requirement. See TIER_PCT below to retune.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { locationsMap } from './game-data.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const levelsData = require('../data/levels.json')

// % of "xp needed to reach the next level" that a single kill should award,
// at the player's expected level for that floor. Tune these to change pacing.
//
// Doubled from the original 0.005/0.0125/0.025 (weak/medium/strong) after
// player feedback that leveling felt too slow — roughly halved kills-needed
// per level at that time (weak: ~200 -> ~100, medium: ~80 -> ~40,
// strong: ~40 -> ~20 at any given level, since this is a % of that level's
// requirement).
//
// Bumped again ~1.5x (2026-08) — new/low-level players were taking about a
// month to clear a single level, which is way outside the intended pace.
// This cuts kills-needed-per-level by roughly a third across the board
// (weak: ~100 -> ~67, medium: ~40 -> ~29, strong: ~20 -> ~13). Boss is
// intentionally left untouched — it's meant to stay a fixed milestone, not
// scale with the regular-monster grind rate.
const TIER_PCT = {
  weak:   0.015,  // 1.5%  — ~67 kills per level if grinding weak mobs only
  medium: 0.0375, // 3.75% — ~27 kills per level
  strong: 0.075,  // 7.5%  — ~13 kills per level
  boss:   0.20,   // 20%   — a real milestone, not a full level in one kill
}
const ELITE_MULT = 2.5 // elites (any tier) multiply their base tier's XP

// Solars scale at a flat fraction of XP per tier — separate from item drops,
// which remain the primary gold source (rollDrops in combat-engine.js).
const SOLARS_PER_XP = 0.35

/**
 * xpForLevel(level) — XP required to go from `level` to `level+1`.
 * Reads the smooth xpTable (xp(L) = round(100 * L^1.8)) in data/levels.json.
 *
 * At the level cap there is no next row, and the naive `next - curr` was
 * therefore zero, so every reward derived from it collapsed to its clamp floor.
 * That was invisible while only floor 1000 of one dungeon expected level 100.
 * Once every dungeon became 100 floors, the Eternal Dungeon's top floors all
 * expect level 100, and they were paying the 50 XP minimum while floor 50 paid
 * 496. Its master paid 1. The final step is extrapolated from the last real gap
 * in the table instead, which is the right size on a 100 * L^1.8 curve.
 */
export function xpForLevel(level) {
  const cap    = levelsData.levelCap ?? 100
  const capped = Math.max(1, Math.min(level, cap))
  const at = (L) => levelsData.xpTable[String(L)] ?? null
  const curr = at(capped) ?? 100
  const next = at(capped + 1)
  if (next == null) {
    const prev = at(capped - 1)
    return Math.max(1, prev == null ? curr : curr - prev)
  }
  return Math.max(1, next - curr)
}

/**
 * expectedLevelAtFloor(locationId, floor) — interpolates the dungeon's
 * levelRange linearly across its floor count to estimate what level a
 * player "should" be at a given floor.
 */
export function expectedLevelAtFloor(locationId, floor) {
  const loc = locationsMap[locationId]
  if (!loc?.levelRange) return 1
  const [lo, hi] = loc.levelRange
  const totalFloors = loc.floors ?? 1
  if (totalFloors <= 1) return lo
  const pct = Math.max(0, Math.min(1, (floor - 1) / (totalFloors - 1)))
  return Math.round(lo + (hi - lo) * pct)
}

/**
 * monsterTierAtFloor(locationId, floor) — bands depth through the WHOLE dungeon
 * into weak (first 40%) / medium (next 35%) / strong (last 25%).
 *
 * This used to band between consecutive boss floors instead, so the tier reset
 * from strong back to weak at every boss. With 100 floor bands that was a slow
 * arc and read as a breather after each boss. With the ten floor bands a 100
 * floor dungeon has, it made reward saw tooth every ten floors: Gambit paid 191
 * on floor 50, 115 on floor 75 and 261 on floor 99, so the floors just before a
 * boss paid several times the floors just after it for no difference in
 * difficulty. Monster stats scale smoothly with depth
 * (balanceRegularMonsterStats in combat-engine.js), so reward has to as well or
 * the two curves openly disagree.
 */
export function monsterTierAtFloor(locationId, floor) {
  const loc   = locationsMap[locationId]
  const total = loc?.floors ?? floor
  const pct   = total <= 1 ? 1 : Math.max(0, Math.min(1, (floor - 1) / (total - 1)))
  if (pct <= 0.40) return 'weak'
  if (pct <= 0.75) return 'medium'
  return 'strong'
}

/**
 * regulateMonsterXp — the single source of truth for a regular monster's
 * XP/solars reward. Ignores monsters.json's own rewards entirely.
 *
 * @param {string} locationId
 * @param {number} floor
 * @param {boolean} isElite
 * @returns {{ xp: number, solars: number, tier: string }}
 */
export function regulateMonsterXp(locationId, floor, isElite = false) {
  const level = expectedLevelAtFloor(locationId, floor)
  const need  = xpForLevel(level)
  const tier  = monsterTierAtFloor(locationId, floor)
  let xp = need * TIER_PCT[tier]
  if (isElite) xp *= ELITE_MULT
  // Clamp to player-facing range: min 50, max 700 per kill.
  xp = Math.max(50, Math.min(700, Math.round(xp)))
  const solars = Math.max(1, Math.round(xp * SOLARS_PER_XP))
  return { xp, solars, tier }
}

/**
 * regulateBossXp — XP/solars for an anime or generic boss at a given slot.
 * Bosses always sit at TIER_PCT.boss regardless of their grade; grade
 * already scales their combat stats (see boss-engine.js GRADE_MULT), so
 * XP stays a flat "milestone" reward rather than compounding twice.
 */
export function regulateBossXp(locationId, floor) {
  const level = expectedLevelAtFloor(locationId, floor)
  const need  = xpForLevel(level)
  const xp = Math.max(1, Math.round(need * TIER_PCT.boss))
  const solars = Math.max(1, Math.round(xp * SOLARS_PER_XP))
  return { xp, solars, tier: 'boss' }
}

// ── Speed-scaled kill XP (regular dungeon monsters) ───────────────────────
//
// A regular dungeon kill pays by HOW FAST you won, not by which floor you
// happened to be standing on. Killing in a couple of turns means your build
// is actually beating the encounter; grinding one down over a dozen turns is
// the same kill worth less.
//
// Regular monsters are balanced so the player a floor expects clears one in
// clearTurnsShallow to clearTurnsDeep basic attacks, which is 3 to 5 (see
// REGULAR_MONSTER_BALANCE in combat-engine.js). The band is anchored to that,
// so it has to move whenever that target does: the old 3 to 12 was written for
// the old ten turn encounter, and against a 3 to 5 turn one it paid every
// single kill the maximum. At/under FAST_TURNS pays MAX, at/over SLOW_TURNS pays
// MIN, and it slides linearly between. Bosses are deliberately NOT on this band,
// they stay the flat milestone above, or a 20-turn boss would pay less than a
// trash mob.
export const DUNGEON_KILL_XP = {
  min: 30,
  max: 60,
  fastTurns: 2,  // beat the encounter target outright → full 60
  slowTurns: 8,  // well past it, the build is not keeping up → floor of 30
}

/**
 * LOCATION_REWARD_MULT — per-location flat multipliers applied on top of
 * everything else in creditKill (Premium, speed band, cheat mods, season
 * bonuses). These override nothing; they stack multiplicatively with all of
 * those. This table exists so one extreme location can have a noticeably
 * higher reward floor without touching the global balance constants or the
 * speed-band formula that govern every other dungeon.
 *
 * caged_dimension: 10× XP, 8× Solars.
 * Why those numbers? The spec says "immense rewards, granting massive amounts
 * of XP and Solars" for killing even one monster in a zone designed to kill
 * even a level-200 titled player. At 60 XP max on the speed band, 10× brings
 * a single kill to 600 XP (12× a regular dungeon kill), which is meaningful
 * without undermining ordinary dungeon progression for players below the cap.
 * Solars scale at 8× rather than 10× to keep the economy balanced — Solars
 * have a tighter feedback loop with the shop than XP does with levelling, so
 * an 8× boost is still "immense" without flooding wallets.
 */
export const LOCATION_REWARD_MULT = {
  caged_dimension: { xp: 10, solars: 8 },
  // newbie_hollow (Newcomer's Hollow, level 1-30): the one place in the game
  // that exists to fix "I just started and I feel weak". A regular dungeon kill
  // on the speed band is 30-60 XP; at 6x a Hollow floor pays 180-360, so the
  // first levels come in one or two kills and the 20s still take a handful.
  //
  // Measured against the whole 1 -> 30 track (45,585 XP of data/levels.json):
  // 6x is two laps of the Hollow — roughly two days of its 50-floor allowance —
  // with the newcomer boost below level 20 (NEWCOMER_BOOST below) doing the
  // lifting in the first lap. That is deliberately NOT one lap: the lane is
  // meant to be a fast start, not a single evening that skips the early game,
  // and its own daily cap has to stay meaningful for more than one day. Raised
  // to 8x a perfect lap lands a fresh character at level 32 and the 50-floor
  // cap stops mattering after day one.
  //
  // Solars are 3x rather than 6x on purpose: this is the one band where a
  // player has literally no money, so it needs to fund its own potions and a
  // first weapon, but flooding a level-30 wallet would make the shop's early
  // price curve meaningless the moment they leave.
  newbie_hollow: { xp: 6, solars: 3 },
}

/**
 * ── Newcomer XP boost (2026-09) ────────────────────────────────────────────
 *
 * A standing, level-gated multiplier on every kill, on top of everything else
 * here. It exists for the players the Hollow doesn't reach: someone at level
 * 12 who is questing in town, running `.work`, or killing wild monsters rather
 * than sitting in a dungeon, and who reported that levelling felt like it had
 * stopped. Under `untilLevel` a kill is worth `xpMult` times as much, and it
 * turns itself off the moment they cross that line — no opt-in, nothing to
 * claim, and nothing to take away later because it never applied to anyone who
 * had already left the early game.
 *
 * Deliberately modest (1.5x, not 3x): the Hollow is the place built for fast
 * early levelling, and this is the smaller, everywhere-else version of it.
 * Set NEWCOMER_XP_UNTIL_LEVEL=0 to disable the boost entirely.
 */
export const NEWCOMER_BOOST = {
  untilLevel: (() => {
    const raw = parseInt(process.env.NEWCOMER_XP_UNTIL_LEVEL ?? '', 10)
    return Number.isFinite(raw) && raw >= 0 ? raw : 20
  })(),
  xpMult: (() => {
    const raw = Number(process.env.NEWCOMER_XP_MULT)
    return Number.isFinite(raw) && raw > 0 ? raw : 1.5
  })(),
}

/** The newcomer multiplier for this player: 1 for anyone past the early game. */
export function newcomerXpMult(player) {
  if (!NEWCOMER_BOOST.untilLevel) return 1
  const level = Math.floor(Number(player?.level) || 0)
  return level > 0 && level < NEWCOMER_BOOST.untilLevel ? NEWCOMER_BOOST.xpMult : 1
}

/** Short suffix for reward text, or '' when the boost isn't applying. */
export function newcomerNote(player) {
  const mult = newcomerXpMult(player)
  if (mult === 1) return ''
  return ` _(🌟 newcomer boost x${mult})_`
}

/**
 * LOCATION_KILL_XP_BAND — a location's own anchors for the speed band above.
 *
 * WHY THIS EXISTS. DUNGEON_KILL_XP's fastTurns/slowTurns are anchored to the
 * global clearTurns target (4 to 5 attacks per monster), and the file says so:
 * the band has to move whenever that target does. caged_dimension overrides
 * that target to ~19-23 attacks for a floor-level player
 * (LOCATION_DIFFICULTY in lib/combat-engine.js), so at the global anchors
 * EVERY kill in the zone, however well played, sat past slowTurns and paid the
 * floor rate. That would have quietly halved the rewards of the one location
 * whose whole promise is "immense rewards for a fight that can kill you".
 *
 * The numbers here are the global ones scaled by the same factor the location's
 * clear target moved (about 4.5x): halve the tuned clear time to bank the full
 * 60, take 1.5x of it and you are grinding, which is the exact relationship
 * DUNGEON_KILL_XP has to the global target. min/max are NOT overridden, so a
 * slow caged kill is still worth half a fast one, like anywhere else.
 */
export const LOCATION_KILL_XP_BAND = {
  caged_dimension: { fastTurns: 11, slowTurns: 33 },
}

/**
 * speedKillXp(turns) — base XP for a regular dungeon kill that took `turns`
 * turns. Reward multipliers (Premium, season bonuses, cheat mods) apply on
 * top of this in handleVictory, so a Premium player still sees their perk.
 *
 * @param {number} turns  battleState.turn at the moment the enemy died (1-based)
 * @param {string} [locationId]  selects a LOCATION_KILL_XP_BAND re-anchor when
 *   the location tunes its monsters to a different clear time than the global.
 * @returns {number} XP in [min, max]
 */
export function speedKillXp(turns, locationId = null) {
  const { min, max, fastTurns, slowTurns } =
    { ...DUNGEON_KILL_XP, ...(LOCATION_KILL_XP_BAND[locationId] ?? {}) }
  const t = Math.max(1, Math.round(Number(turns) || 1))
  if (t <= fastTurns) return max
  if (t >= slowTurns) return min
  const pct = (t - fastTurns) / (slowTurns - fastTurns)
  return Math.round(max - (max - min) * pct)
}

