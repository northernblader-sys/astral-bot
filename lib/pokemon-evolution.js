/**
 * pokemon-evolution.js — evolution application logic (overhaul addendum §8).
 *
 * Two entry points:
 *   checkEvolution(mon)              — level-up check, §8.2. Called after
 *                                       any level increase (feed/train, or
 *                                       post-battle XP once that lands).
 *   evolveWithItem(mon, itemName)    — item-trigger check, §8.3. Called by
 *                                       .p-poke evolve <n> <item>.
 *   applyEvolution(mon, target)      — shared mutation step both of the
 *                                       above funnel into once a match is
 *                                       found; re-fetches the new species
 *                                       and rewrites mon in place.
 *
 * Preserves per addendum §8.2: nickname, happiness, EVs, IVs, nature,
 * trainedAtk/trainedDef/trainedSpAtk/trainedSpDef, held item, caughtAt,
 * protected flag, id.
 * Replaces: dexId, name, types, abilities, base stats, image/sprite, maxHp
 * (recomputed), currentHp (scaled proportionally to prior HP%, not full-healed).
 * Moveset: re-run pickDefaultMoveset() against the NEW species' movepool,
 * but keep any of the old 4 moves the new species can still learn instead
 * of wiping the whole set.
 */
import { fetchPokemonById, fetchEvolutionChain, basePokemonHp } from './pokemon-engine.js'
import { pickDefaultMoveset, resolveLearnableMoves } from './move-pool.js'

/**
 * checkEvolution(mon) — overhaul addendum §8.2. Returns the matching
 * evolution target ({ dexId, name, trigger, minLevel, item }) if `mon`'s
 * current level clears a level-up trigger in its species' evolution chain,
 * or null if there's no match (already final stage, level too low, or the
 * species' only trigger(s) are unsupported — trade/friendship/etc.).
 */
export async function checkEvolution(mon) {
  if (!mon?.dexId) return null
  const chain = await fetchEvolutionChain(mon.dexId)
  if (!chain?.evolvesTo?.length) return null
  return chain.evolvesTo.find(e =>
    e.trigger === 'level-up' && mon.level >= (e.minLevel ?? Infinity)
  ) ?? null
}

/**
 * findItemEvolution(mon, apiItemName) — overhaul addendum §8.3. Checks
 * whether `apiItemName` (PokéAPI's item-name convention, e.g. "fire-stone")
 * matches this species' use-item evolution trigger. Returns the matching
 * target or null (species doesn't evolve via any item, or the item doesn't
 * match the one this species actually needs).
 */
export async function findItemEvolution(mon, apiItemName) {
  if (!mon?.dexId || !apiItemName) return null
  const chain = await fetchEvolutionChain(mon.dexId)
  if (!chain?.evolvesTo?.length) return null
  return chain.evolvesTo.find(e => e.trigger === 'use-item' && e.item === apiItemName) ?? null
}

/**
 * applyEvolution(mon, target) — mutates `mon` in place into its evolved
 * form. `target` is a { dexId, name, ... } evolution-chain entry from either
 * checkEvolution() or findItemEvolution(). Returns { oldName, newName } for
 * the caller's announcement message, or null if the new species couldn't be
 * fetched (network failure — evolution is aborted, mon is left untouched).
 */
export async function applyEvolution(mon, target) {
  const fresh = await fetchPokemonById(target.dexId)
  if (!fresh) return null

  const oldName = mon.nickname ?? mon.name
  const newSpeciesName = fresh.name

  // HP scales proportionally to the % it had before evolving, not a full
  // heal — a half-dead Pokémon evolving stays half-dead (relative to its
  // new, higher max), matching addendum §8.2's explicit instruction.
  const hpPercent = mon.maxHp > 0 ? mon.currentHp / mon.maxHp : 1
  const newMaxHp = basePokemonHp(fresh.hp, mon.level)

  // Replace species-level fields.
  mon.dexId = fresh.dexId
  mon.name = newSpeciesName.charAt(0).toUpperCase() + newSpeciesName.slice(1)
  mon.types = fresh.types
  mon.abilities = fresh.abilities
  mon.baseHp = fresh.hp
  mon.baseAtk = fresh.atk
  mon.baseDef = fresh.def
  mon.baseSpd = fresh.spd
  mon.baseSpAtk = fresh.spAtk ?? 50
  mon.baseSpDef = fresh.spDef ?? 50
  mon.image = fresh.image
  mon.sprite = fresh.sprite
  mon.maxHp = newMaxHp
  mon.currentHp = Math.max(1, Math.min(newMaxHp, Math.round(newMaxHp * hpPercent)))

  // Moveset: keep any of the old 4 that the NEW species can still learn,
  // fill remaining slots from the new species' own movepool overlap —
  // never just wipe the set (addendum §8.2's explicit instruction).
  const newLearnable = resolveLearnableMoves(fresh.apiMoveNames ?? [], fresh.types ?? [])
  const newLearnableIds = new Set(newLearnable.map(m => m.id))
  const keptMoves = (mon.moves ?? []).filter(id => newLearnableIds.has(id))

  if (keptMoves.length < 4) {
    const filler = pickDefaultMoveset(fresh.apiMoveNames ?? [], fresh.types ?? [])
    for (const id of filler) {
      if (keptMoves.length >= 4) break
      if (!keptMoves.includes(id)) keptMoves.push(id)
    }
  }
  mon.moves = keptMoves.slice(0, 4)

  // Everything else — nickname, happiness, evs, ivs, nature, trainedAtk/
  // trainedDef/trainedSpAtk/trainedSpDef, heldItem, caughtAt, protected,
  // id — is simply left untouched, per addendum §8.2's preserve list.

  return { oldName, newName: mon.name }
}

/**
 * runLevelUpEvolutionCheck(mon) — convenience wrapper combining checkEvolution
 * + applyEvolution for the common feed/train call site. Returns the same
 * { oldName, newName } shape as applyEvolution, or null if no evolution
 * happened (either no match, or the re-fetch failed).
 */
export async function runLevelUpEvolutionCheck(mon) {
  const target = await checkEvolution(mon)
  if (!target) return null
  return applyEvolution(mon, target)
}
