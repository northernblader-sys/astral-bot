/**
 * pokemon-abilities.js — battle-relevant ability application (overhaul
 * addendum §12).
 *
 * Same pattern as lib/pokemon-held-items.js — a curated list, not every
 * real ability. If a species' actual PokéAPI ability (stored as
 * mon.abilities: string[], see lib/pokemon-engine.js) isn't in
 * data/pokemon-abilities.json, getActiveAbility() returns null and every
 * function below is a no-op for that Pokémon — battles never block on an
 * unmapped ability, per §12.1.
 *
 * Kept as its OWN file, separate from lib/pokemon-held-items.js, per the
 * addendum's explicit instruction: "keep held-item effects and ability
 * effects as two separate small functions each handling their own list of
 * item/ability ids" so the two systems don't get tangled into one giant
 * if-chain. plugins/pokebattle.js's turn resolution calls into both this
 * file and pokemon-held-items.js as distinct, clearly-commented steps.
 *
 * A Pokémon can have more than one real ability slot (PokéAPI returns all
 * of them); this bot doesn't model ability-slot selection, so
 * getActiveAbility() just takes the first of mon.abilities that has a
 * curated entry. Mega Evolution (lib/mega-evolution.js) can override which
 * ability is "active" for the duration of a battle — callers that already
 * resolved a mega overlay pass its ability id in via the `abilityIdOverride`
 * param instead of re-deriving it from mon.abilities.
 */
import { createRequire } from 'module'
import { addStatusEffect } from '../lib/effects.js'
const require = createRequire(import.meta.url)
const ABILITIES = require('../data/pokemon-abilities.json')

const ABILITIES_BY_ID = new Map(ABILITIES.map(a => [a.id, a]))

const LOW_HP_THRESHOLD = 1 / 3 // standard Pokémon "low HP" trigger point

/**
 * getActiveAbility(mon, abilityIdOverride?) — resolves which curated
 * ability (if any) is in effect for this Pokémon right now. Pass
 * abilityIdOverride when a mega form (§10) is active and swaps the
 * Pokémon's ability for the battle; omit it otherwise.
 */
export function getActiveAbility(mon, abilityIdOverride = null) {
  if (abilityIdOverride) return ABILITIES_BY_ID.get(abilityIdOverride) ?? null
  for (const name of mon?.abilities ?? []) {
    const found = ABILITIES_BY_ID.get(name)
    if (found) return found
  }
  return null
}

/**
 * abilityMovePowerMultiplier(attackerMon, moveType, abilityIdOverride?) —
 * Blaze/Torrent/Overgrow-style low-HP same-type power boost. Standard
 * Pokémon "low HP" threshold: current HP ≤ 1/3 max HP (checked each turn
 * before damage calc, per §12.2). Returns 1 (no-op) otherwise.
 */
export function abilityMovePowerMultiplier(attackerMon, moveType, abilityIdOverride = null) {
  const ability = getActiveAbility(attackerMon, abilityIdOverride)
  if (ability?.trigger !== 'low-hp') return 1
  if (ability.effect.type !== 'boost-type-power') return 1
  if (ability.effect.moveType !== moveType) return 1
  const hpFrac = (attackerMon.currentHp ?? 0) / Math.max(1, attackerMon.maxHp ?? 1)
  return hpFrac <= LOW_HP_THRESHOLD ? ability.effect.multiplier : 1
}

/**
 * abilityDefensiveResult(defenderMon, moveType, baseMultiplier, abilityIdOverride?)
 * — passive type-interaction abilities, checked "during type-effectiveness
 * lookup itself" per §12.2 (Levitate zeroes ground regardless of what
 * lib/type-chart.js's chart says; Water/Volt Absorb and Flash Fire go
 * further and turn the hit into a heal/no-op instead of 0 damage; Thick Fat
 * halves fire/ice power on top of whatever the type chart already gives).
 *
 * Returns { multiplier, absorb: boolean, healFraction } — callers should
 * treat `absorb: true` as "this hit doesn't just do 0 damage, it also heals
 * the defender (or is fully absorbed with no effect for Flash Fire, whose
 * real-game payoff is passive fire-move-boost for the *rest* of the battle
 * — that longer-lived boost isn't modeled here to keep this a same-turn,
 * single-hit check like every other ability in this v1 curated set)".
 */
export function abilityDefensiveResult(defenderMon, moveType, baseMultiplier, abilityIdOverride = null) {
  const ability = getActiveAbility(defenderMon, abilityIdOverride)
  if (ability?.trigger !== 'passive') return { multiplier: baseMultiplier, absorb: false, healFraction: 0 }

  const eff = ability.effect
  if (eff.type === 'immune-type' && eff.moveType === moveType) {
    return { multiplier: 0, absorb: false, healFraction: 0 }
  }
  if (eff.type === 'absorb-type' && eff.moveType === moveType) {
    return { multiplier: 0, absorb: true, healFraction: eff.healFraction ?? 0 }
  }
  if (eff.type === 'resist-type' && (eff.moveTypes ?? []).includes(moveType)) {
    return { multiplier: baseMultiplier * (eff.multiplier ?? 1), absorb: false, healFraction: 0 }
  }
  return { multiplier: baseMultiplier, absorb: false, healFraction: 0 }
}

/**
 * rollOnHitTakenAbility(defenderMon, attackerMonLike, abilityIdOverride?) —
 * Static/Poison Point/Flame Body-style "attacker who lands a hit on me has
 * a chance of getting statused" and Rough Skin-style "attacker takes chip
 * damage for hitting me". Rolled once per landed hit, after damage is
 * applied (§12.2: "on-hit-taken rolls its chance after the attacker's hit
 * lands"). `attackerMonLike` needs at minimum { currentHp, maxHp,
 * activeEffects } — same working-state shape lib/effects.js's
 * addStatusEffect()/tickEffects() already use elsewhere in
 * plugins/pokebattle.js. Returns a log line, or null if nothing procced.
 */
export function rollOnHitTakenAbility(defenderMon, attackerMonLike, abilityIdOverride = null) {
  const ability = getActiveAbility(defenderMon, abilityIdOverride)
  if (ability?.trigger !== 'on-hit-taken') return null
  const eff = ability.effect
  const defName = defenderMon.nickname ?? defenderMon.name

  if (eff.type === 'chance-status') {
    if (Math.random() >= (eff.chance ?? 0)) return null
    addStatusEffect(attackerMonLike, { type: eff.status, duration: eff.status === 'stun' ? 1 : 3 })
    const labels = { stun: 'paralyzed', poison: 'poisoned', burn: 'burned' }
    return `⚡ *${defName}*'s ability left *${attackerMonLike.name}* ${labels[eff.status] ?? eff.status}!`
  }
  return null
}

/**
 * roughSkinRecoil(defenderMon, attackerMonLike, dealtDamage, abilityIdOverride?)
 * — separate from rollOnHitTakenAbility() above because Rough Skin's
 * payoff is flat chip damage rather than a status roll; kept as its own
 * small function so the "chance-status" branch above stays a pure
 * probability check with no HP mutation mixed in.
 */
export function roughSkinRecoil(defenderMon, attackerMonLike, dealtDamage, abilityIdOverride = null) {
  const ability = getActiveAbility(defenderMon, abilityIdOverride)
  if (ability?.trigger !== 'on-hit-taken') return null
  if (ability.effect.type !== 'recoil-to-attacker') return null
  if (!dealtDamage) return null

  const recoil = Math.max(1, Math.floor((attackerMonLike.maxHp ?? 0) * (ability.effect.fraction ?? 0.125)))
  attackerMonLike.currentHp = Math.max(0, (attackerMonLike.currentHp ?? 0) - recoil)
  return `🩸 *${attackerMonLike.name}* is hurt by *${defenderMon.nickname ?? defenderMon.name}*'s rough skin! (-${recoil} HP)`
}

/**
 * checkSturdy(sideState, defenderMon, incomingDamage) — Sturdy-equivalent
 * of lib/pokemon-held-items.js's checkFocusSash(): a full-HP holder that
 * would otherwise be KO'd survives with 1 HP instead. Unlike Focus Sash
 * this isn't a consumable item, so "used up" is tracked per-battle on
 * `sideState.sturdyUsed` (mutated on the in-memory battle-state copy
 * plugins/pokebattle.js already threads through resolvePokeBattleTurn's
 * `order[]` entries, same lifetime as `choiceLockedMove`). Returns
 * { adjustedDamage, line }.
 */
export function checkSturdy(sideState, defenderMon, incomingDamage, abilityIdOverride = null) {
  const ability = getActiveAbility(defenderMon, abilityIdOverride)
  if (ability?.trigger !== 'on-lethal-hit' || ability.effect.type !== 'survive-ko') {
    return { adjustedDamage: incomingDamage, line: null }
  }
  if (sideState.sturdyUsed) return { adjustedDamage: incomingDamage, line: null }

  const wasFullHp = defenderMon.currentHp >= defenderMon.maxHp
  const wouldFaint = defenderMon.currentHp - incomingDamage <= 0
  if (!wasFullHp || !wouldFaint) return { adjustedDamage: incomingDamage, line: null }

  sideState.sturdyUsed = true
  const adjustedDamage = defenderMon.currentHp - 1
  return {
    adjustedDamage,
    line: `🛡️ *${defenderMon.nickname ?? defenderMon.name}* endured the hit with its ability!`,
  }
}

/**
 * gutsAttackMultiplier(mon, abilityIdOverride?) — Guts-style flat ATK boost
 * while afflicted with any status condition. Checked the same way
 * lib/pokemon-held-items.js's choiceBoostFor() is: a plain multiplier
 * applied to the attacker's offensive stat in damageFor(), so it composes
 * cleanly with Choice Band/Specs and Life Orb rather than needing its own
 * branch in the damage formula.
 */
export function gutsAttackMultiplier(mon, statKey, abilityIdOverride = null) {
  if (statKey !== 'atk') return 1
  const ability = getActiveAbility(mon, abilityIdOverride)
  if (ability?.trigger !== 'passive' || ability.effect.type !== 'boost-if-status') return 1
  const hasStatus = (mon.activeEffects ?? []).length > 0
  return hasStatus ? ability.effect.multiplier : 1
}

/**
 * intimidateBattleStartLines(aMon, bMon) — Intimidate, reinterpreted as an
 * on-battle-start effect per §12.1's explicit note ("since there's no
 * switching in 1v1, reinterpret as 'on battle start' instead"). Called
 * once, at accept time, for BOTH sides (either or both Pokémon might have
 * it). Returns { aAtkMult, bAtkMult, lines } — the multipliers get stored
 * on each side's pokemonBattleState (e.g. `state.intimidatedAtkMult`) since
 * this is a battle-only stat change, same lifetime as weather (§13) and
 * Choice-lock, not a permanent change to the owned Pokémon.
 */
export function intimidateBattleStartLines(aMon, bMon) {
  let aAtkMult = 1, bAtkMult = 1
  const lines = []

  const aAbility = getActiveAbility(aMon)
  if (aAbility?.trigger === 'on-battle-start' && aAbility.effect.type === 'weaken-opponent') {
    bAtkMult *= aAbility.effect.multiplier
    lines.push(`😤 *${aMon.name}*'s ability intimidates *${bMon.name}*! (ATK ↓)`)
  }
  const bAbility = getActiveAbility(bMon)
  if (bAbility?.trigger === 'on-battle-start' && bAbility.effect.type === 'weaken-opponent') {
    aAtkMult *= bAbility.effect.multiplier
    lines.push(`😤 *${bMon.name}*'s ability intimidates *${aMon.name}*! (ATK ↓)`)
  }
  return { aAtkMult, bAtkMult, lines }
}

/**
 * statusImmuneAbility(mon, statusType, abilityIdOverride?) — Immunity/
 * Limber/Magma Armor/Water Veil-style "can't be inflicted with this one
 * status". Checked by the same applyMoveEffect() step that maps a move's
 * effect def onto lib/effects.js's addStatusEffect() — a true return there
 * means "don't apply the status", not "reduce its duration" or similar.
 */
export function statusImmuneAbility(mon, statusType, abilityIdOverride = null) {
  const ability = getActiveAbility(mon, abilityIdOverride)
  if (ability?.trigger !== 'passive' || ability.effect.type !== 'status-immune') return false
  return ability.effect.status === statusType
}

/**
 * hasMagicGuard(mon, abilityIdOverride?) — blocks indirect damage this file
 * and lib/pokemon-held-items.js are responsible for: weather chip damage
 * (§13.2) and Life Orb recoil (§11). Scoped to only what those two systems
 * control — burn/poison damage-over-time lives in the base bot's
 * lib/effects.js (out of scope for this overhaul to modify), so Magic
 * Guard does NOT block status-move DoT in this v1; documented here rather
 * than silently half-implemented.
 */
export function hasMagicGuard(mon, abilityIdOverride = null) {
  const ability = getActiveAbility(mon, abilityIdOverride)
  return ability?.trigger === 'passive' && ability.effect.type === 'no-indirect-damage'
}

/**
 * abilitySpeedMultiplier(mon, weather, abilityIdOverride?) — Swift Swim/
 * Chlorophyll/Sand Rush/Slush Rush-style speed doubling while their
 * matching weather (§13) is active. Applied to the SPD stat used for
 * turn-order determination only (plugins/pokebattle.js's `statsOf()`);
 * doesn't touch the persisted owned-Pokémon stats.
 */
export function abilitySpeedMultiplier(mon, weather, abilityIdOverride = null) {
  const ability = getActiveAbility(mon, abilityIdOverride)
  if (ability?.trigger !== 'passive' || ability.effect.type !== 'boost-speed-in-weather') return 1
  return ability.effect.weather === weather ? ability.effect.multiplier : 1
}
