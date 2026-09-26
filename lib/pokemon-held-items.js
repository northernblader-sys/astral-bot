/**
 * pokemon-held-items.js — held-item passive application in battle
 * (overhaul addendum §11.2).
 *
 * Kept as its own small file, separate from ability effects (§12), per the
 * addendum's explicit instruction: "keep held-item effects and ability
 * effects as two separate small functions each handling their own list of
 * item/ability ids" so the two systems don't get tangled in one giant
 * if-chain. plugins/pokebattle.js's turn resolution calls into this file
 * for the held-item step; a future ability step (§12) gets its own sibling
 * file and its own call, not folded into this one.
 *
 * Every function here takes a plain "mon-like" object with at minimum
 * { heldItem, currentHp, maxHp } (an owned Pokémon works directly) and
 * mutates it in place. None of these know about the opposing side except
 * where explicitly passed in (e.g. the attacker's Life Orb recoil needs
 * only itself; the resist-berry check needs the incoming hit's
 * effectiveness, passed in as an argument rather than looked up here).
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const POKEMON_ITEMS = require('../data/pokemon-items.json')

const HELD_ITEMS_BY_ID = new Map(POKEMON_ITEMS.map(i => [i.id, i]))

/** Looks up a held-item definition by id. Returns null if unheld or unknown. */
export function getHeldItem(mon) {
  if (!mon?.heldItem) return null
  return HELD_ITEMS_BY_ID.get(mon.heldItem) ?? null
}

/**
 * choiceBoostFor(mon, statKey) — Choice Band/Specs-style flat multiplier for
 * the ONE stat the item boosts. Returns 1 (no-op) if the holder doesn't have
 * a matching choice item. Called from damageFor()'s stat lookup, additively
 * stacked with STAB/type-eff/weather — same "order: base → STAB → type-eff →
 * weather → crit → random" pipeline the base prompt already documents, this
 * slots in as an atk/spAtk stat-level multiplier before that pipeline runs.
 */
export function choiceBoostFor(mon, statKey) {
  const item = getHeldItem(mon)
  if (item?.effect?.type === 'choice-lock' && item.effect.boostStat === statKey) {
    return item.effect.boostMultiplier ?? 1
  }
  return 1
}

/**
 * lifeOrbDamageMultiplier(mon) — Life Orb's flat damage boost. Returns 1 if
 * not holding one.
 */
export function lifeOrbDamageMultiplier(mon) {
  const item = getHeldItem(mon)
  if (item?.effect?.type === 'life-orb') return item.effect.damageMultiplier ?? 1
  return 1
}

/**
 * applyChoiceLockOnMoveUse(battleStateSide, moveId) — Choice Band/Specs'
 * drawback half: the FIRST move used while holding a choice item locks the
 * holder into using only that move for the rest of the battle. Mutates the
 * per-side pokemonBattleState (not the owned Pokémon itself — the lock only
 * lasts for this one battle, same lifetime as other battle-only state like
 * weather §13). Returns a log line if a NEW lock was just set, else null.
 *
 * `stateSide` is expected to carry `.mon` (the owned Pokémon) and `.state`
 * (the mutable pokemonBattleState object) — see pokebattle.js's `order[]`
 * entries, which already have this exact shape.
 */
export function applyChoiceLockOnMoveUse(stateSide, moveId) {
  const item = getHeldItem(stateSide.mon)
  if (item?.effect?.type !== 'choice-lock') return null
  if (stateSide.state.choiceLockedMove) return null // already locked from an earlier turn

  stateSide.state.choiceLockedMove = moveId
  return `🔒 *${stateSide.mon.nickname ?? stateSide.mon.name}* is locked into *${moveId}* by its held item!`
}

/**
 * applyLifeOrbRecoil(mon) — Life Orb's drawback half: after landing a
 * damaging hit, the holder takes recoil equal to a fraction of ITS OWN max
 * HP (not the damage dealt — that's the real games' Life Orb formula).
 * Mutates mon.currentHp in place. Returns a log line, or null if not
 * holding a Life Orb or the attack didn't actually deal damage (recoil
 * only applies on a successful hit, not a miss/status move).
 */
export function applyLifeOrbRecoil(mon, dealtDamage) {
  const item = getHeldItem(mon)
  if (item?.effect?.type !== 'life-orb') return null
  if (!dealtDamage) return null

  const recoil = Math.max(1, Math.floor(mon.maxHp * (item.effect.recoilFraction ?? 0.1)))
  mon.currentHp = Math.max(0, mon.currentHp - recoil)
  return `💢 *${mon.nickname ?? mon.name}* is hurt by its Life Orb! (-${recoil} HP)`
}

/**
 * applyResistBerry(defenderMon, effectivenessMultiplier) — auto-triggers the
 * FIRST time the holder is hit by a super-effective move, healing a
 * fraction of its max HP and consuming the berry (heldItem cleared).
 * Returns a log line, or null if not applicable (no berry held, already
 * consumed this battle — tracked by the item simply being cleared — or the
 * hit wasn't actually super-effective).
 */
export function applyResistBerry(defenderMon, effectivenessMultiplier) {
  const item = getHeldItem(defenderMon)
  if (item?.effect?.type !== 'resist-berry') return null
  if (effectivenessMultiplier < 2) return null // only triggers on a super-effective hit

  const healAmount = Math.max(1, Math.floor(defenderMon.maxHp * (item.effect.healFraction ?? 0.25)))
  defenderMon.currentHp = Math.min(defenderMon.maxHp, defenderMon.currentHp + healAmount)
  defenderMon.heldItem = null // consumed — one-shot per addendum §11.1
  return `🍇 *${defenderMon.nickname ?? defenderMon.name}*'s berry cushions the blow and restores ${healAmount} HP!`
}

/**
 * checkFocusSash(defenderMon, incomingDamage) — if the holder is at full HP
 * and `incomingDamage` would otherwise reduce it to 0, clamps the damage so
 * it survives with exactly 1 HP instead, and consumes the sash. Returns
 * { adjustedDamage, line } — line is null if the sash didn't trigger.
 * Caller applies `adjustedDamage` instead of the original value.
 */
export function checkFocusSash(defenderMon, incomingDamage) {
  const item = getHeldItem(defenderMon)
  if (item?.effect?.type !== 'survive-ko') return { adjustedDamage: incomingDamage, line: null }

  const wasFullHp = defenderMon.currentHp >= defenderMon.maxHp
  const wouldFaint = defenderMon.currentHp - incomingDamage <= 0
  if (!wasFullHp || !wouldFaint) return { adjustedDamage: incomingDamage, line: null }

  defenderMon.heldItem = null // consumed
  const adjustedDamage = defenderMon.currentHp - 1 // leaves exactly 1 HP
  return {
    adjustedDamage,
    line: `🛡️ *${defenderMon.nickname ?? defenderMon.name}* held on with its Focus Sash!`,
  }
}

/**
 * applyEndOfTurnHeldItems(monLike) — Leftovers-style passive regen. Called
 * from the same end-of-turn status-tick step the base prompt's §3.3 step 4
 * already runs for burn/poison DoT (see pokebattle.js's tickEffects() call
 * site) — this is a SEPARATE step right alongside it, not folded into
 * effects.js's engine, since it's item-driven rather than status-driven.
 * Returns a log line, or null if not holding a matching item or already at
 * full HP.
 */
export function applyEndOfTurnHeldItems(monLike, mon) {
  const item = getHeldItem(mon)
  if (item?.effect?.type !== 'end-of-turn-heal') return null
  if (monLike.hp >= monLike.maxHp) return null

  const healAmount = Math.max(1, Math.floor(monLike.maxHp * (item.effect.fraction ?? 0.0625)))
  monLike.hp = Math.min(monLike.maxHp, monLike.hp + healAmount)
  return `🍃 *${monLike.name}* restored a little HP with its held item! (+${healAmount})`
}
