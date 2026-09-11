/**
 * pokemon-stats.js — real Pokémon stat formula (overhaul addendum §9.4),
 * replacing the flat `baseAtk + trainedAtk` battle-time computation with
 * the standard Gen 3+ IV/EV/nature formula.
 *
 * `trainedAtk`/`trainedDef`/`trainedSpAtk`/`trainedSpDef` (from `.p-poke
 * train`, base prompt scope) stay a SEPARATE, additive system — they are
 * NOT folded into this formula's `ev` term. Historically distinct
 * mechanics in real Pokémon games (training items vs EVs); this bot
 * already has `trainedXxx` working, so it's kept as a flat bonus applied
 * on top of the real-formula result, not replaced by it.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const NATURES = require('../data/natures.json')

const NATURES_BY_ID = new Map(NATURES.map(n => [n.id, n]))

/** Looks up a nature definition by id. Returns null if unknown (shouldn't happen post-backfill). */
export function getNatureById(id) {
  return NATURES_BY_ID.get(id) ?? null
}

/**
 * Nature multiplier for a given stat key: 1.1 if this nature boosts that
 * stat, 0.9 if it lowers that stat, 1.0 otherwise (including all 5 neutral
 * natures, where boost === lower and the two cancel out).
 */
export function natureMultiplierFor(natureId, statKey) {
  const nature = getNatureById(natureId)
  if (!nature || nature.boost === nature.lower) return 1
  if (nature.boost === statKey) return 1.1
  if (nature.lower === statKey) return 0.9
  return 1
}

/**
 * computeStat — standard Gen 3+ stat formula.
 * @param {number} base  - species base stat (baseHp/baseAtk/etc.)
 * @param {number} iv     - 0–31
 * @param {number} ev     - 0–252
 * @param {number} level
 * @param {number} natureMultiplier - 1.1 / 0.9 / 1.0 (ignored for HP)
 * @param {boolean} isHp
 */
export function computeStat(base, iv, ev, level, natureMultiplier, isHp) {
  if (isHp) {
    return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10
  }
  const raw = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5
  return Math.floor(raw * natureMultiplier)
}

/**
 * computeAllStats — convenience wrapper: given an owned Pokémon (with
 * baseHp/baseAtk/.../ivs/evs/nature/level already present — callers should
 * run lib/pokemon-engine.js's ensurePokemonExtendedFields()/
 * ensurePokemonBreedingFields() first so these are never undefined),
 * returns the real hp/atk/def/spAtk/spDef/spd stat block.
 *
 * `trainedAtk`/`trainedDef`/`trainedSpAtk`/`trainedSpDef` are added on top
 * afterward as a flat bonus — see the file header note. maxHp is NOT
 * recomputed here; lib/pokemon-engine.js's basePokemonHp()/evolution logic
 * own maxHp/currentHp scaling on level-up/evolve, this function only
 * covers the battle-stat block (atk/def/spAtk/spDef/spd) consumed by
 * plugins/pokebattle.js's statsOf().
 */
export function computeBattleStats(mon) {
  const level = mon.level ?? 5
  const ivs = mon.ivs ?? {}
  const evs = mon.evs ?? {}
  const nature = mon.nature ?? 'hardy'

  const atk   = computeStat(mon.baseAtk,   ivs.atk   ?? 0, evs.atk   ?? 0, level, natureMultiplierFor(nature, 'atk'),   false)
  const def   = computeStat(mon.baseDef,   ivs.def   ?? 0, evs.def   ?? 0, level, natureMultiplierFor(nature, 'def'),   false)
  const spAtk = computeStat(mon.baseSpAtk, ivs.spAtk ?? 0, evs.spAtk ?? 0, level, natureMultiplierFor(nature, 'spAtk'), false)
  const spDef = computeStat(mon.baseSpDef, ivs.spDef ?? 0, evs.spDef ?? 0, level, natureMultiplierFor(nature, 'spDef'), false)
  const spd   = computeStat(mon.baseSpd,   ivs.spd   ?? 0, evs.spd   ?? 0, level, natureMultiplierFor(nature, 'spd'),   false)

  return {
    atk:   atk   + (mon.trainedAtk   ?? 0),
    def:   def   + (mon.trainedDef   ?? 0),
    spAtk: spAtk + (mon.trainedSpAtk ?? 0),
    spDef: spDef + (mon.trainedSpDef ?? 0),
    spd,
  }
}

/**
 * computeMaxHp — real-formula HP, for callers that want it (e.g. .p-poke
 * info's stat display). lib/pokemon-engine.js's basePokemonHp() remains
 * the source of truth for the simplified level-up HP scaling that's been
 * live since the base prompt (feed/train/evolve all call it) — this export
 * exists so IV/EV-aware HP can be shown/used without silently diverging
 * from that existing behavior; callers decide which one they need.
 */
export function computeMaxHp(mon) {
  const level = mon.level ?? 5
  const iv = mon.ivs?.hp ?? 0
  const ev = mon.evs?.hp ?? 0
  return computeStat(mon.baseHp, iv, ev, level, 1, true)
}
