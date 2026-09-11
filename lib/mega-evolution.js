/**
 * mega-evolution.js — Mega Evolution (overhaul addendum §10).
 *
 * Mega Evolution is battle-only and non-destructive: it never mutates the
 * stored owned Pokémon. Instead, plugins/pokebattle.js reads
 * `pokemonBattleState.megaActive` each turn and asks this file for an
 * "overlay" (name/types/ability/stat multipliers) to apply on top of the
 * already-computed §9.4 stats, mega multiplier LAST per §10.3's explicit
 * order (base → IV/EV/nature → trained bonus → mega multiplier). Setting
 * `pokemonBattleState = null` at pokebattleConclude() (which already
 * happens for every battle end) is what "reverts" Mega Evolution — there's
 * nothing else to undo since the mon object itself was never touched.
 *
 * Per §10.3's correction: the mega stone is a HELD item, not a consumable
 * pulled from inventory — Mega Evolving requires the stone to be the
 * Pokémon's currently-equipped `heldItem` (§11), and using it does not
 * remove it. It also does not consume the turn's move slot: `.megaevolve`
 * is a free action alongside `.move`, once per battle.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const MEGA_FORMS = require('../data/mega-forms.json')
const POKEMON_ITEMS = require('../data/pokemon-items.json')

const ITEMS_BY_ID = new Map(POKEMON_ITEMS.map(i => [i.id, i]))

/**
 * getHeldMegaStone(mon) — the item def for mon's currently-held item, if
 * it's a mega stone (`megaStone: true` in data/pokemon-items.json, per the
 * addendum §11.1 correction folding mega stones into the held-item
 * category rather than a separate "mega-stone" category). Returns null if
 * not holding one.
 */
export function getHeldMegaStone(mon) {
  if (!mon?.heldItem) return null
  const item = ITEMS_BY_ID.get(mon.heldItem)
  return item?.megaStone ? item : null
}

/**
 * getMatchingMegaForm(mon) — the specific data/mega-forms.json entry that
 * matches BOTH mon's species (dexId) AND the specific stone it's holding
 * (species like Mewtwo/Charizard have two mega forms gated by two
 * different stones, so dexId alone isn't enough to disambiguate).
 */
export function getMatchingMegaForm(mon) {
  const stone = getHeldMegaStone(mon)
  if (!stone) return null
  return MEGA_FORMS.find(f => f.dexId === mon.dexId && f.megaStoneItemId === stone.megaStoneId) ?? null
}

/** canMegaEvolve(mon) — true if mon is holding the stone matching its own species' mega form. */
export function canMegaEvolve(mon) {
  return !!getMatchingMegaForm(mon)
}

/**
 * applyMegaOverlay(mon, stats, form) — takes the already-computed §9.4
 * battle stats (atk/def/spAtk/spDef/spd, trained bonuses already folded
 * in) and applies the mega form's multipliers LAST, per §10.3. Also
 * returns the overlay's display name/types/ability so callers can swap
 * what's shown/used for STAB, type-effectiveness, and ability lookups for
 * the rest of this battle. HP is never affected by Mega Evolution in the
 * real games (every curated entry's implicit hp multiplier is 1.0).
 */
export function applyMegaOverlay(stats, form) {
  const m = form.statMultipliers ?? {}
  return {
    atk:   Math.floor(stats.atk   * (m.atk   ?? 1)),
    def:   Math.floor(stats.def   * (m.def   ?? 1)),
    spAtk: Math.floor(stats.spAtk * (m.spAtk ?? 1)),
    spDef: Math.floor(stats.spDef * (m.spDef ?? 1)),
    spd:   Math.floor(stats.spd   * (m.spd   ?? 1)),
  }
}

/**
 * effectiveMonView(mon, state) — returns { types, ability, displayName }
 * reflecting the mega overlay if `state.megaActive` is set and mon still
 * qualifies (still holding the matching stone — re-checked every call in
 * case the item was somehow unequipped mid-battle), else mon's real
 * types/ability/name. Used anywhere battle logic needs "what type/ability
 * is this Pokémon RIGHT NOW" — STAB, type-effectiveness, ability triggers.
 */
export function effectiveMonView(mon, state) {
  if (state?.megaActive) {
    const form = getMatchingMegaForm(mon)
    if (form) {
      return { types: form.type, ability: form.ability, displayName: form.megaName, megaForm: form }
    }
  }
  return { types: mon.types ?? [], ability: null, displayName: mon.nickname ?? mon.name, megaForm: null }
}
