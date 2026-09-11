/**
 * move-pool.js — resolves which of our curated data/moves.json entries a
 * caught Pokémon can actually use, from the raw move-name list PokéAPI
 * already returns on every /pokemon/{id} fetch (raw.moves[].move.name).
 *
 * Deliberately does NOT fetch move data from PokéAPI live — that's a
 * separate network call per move name and far too slow for turn
 * resolution. Everything here works off the static data/moves.json list
 * plus the species' own PokéAPI move-name list, both already in memory.
 *
 * PokéAPI move names are lowercase-hyphenated (e.g. "thunder-punch",
 * "vine-whip"); our curated move ids are lowercase-underscored (e.g.
 * "thunder_punch", "vine_whip") to match this bot's existing id
 * convention elsewhere (items, weapons, etc.) — normalize by swapping
 * hyphens for underscores before comparing.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const MOVES = require('../data/moves.json')

const MOVES_BY_ID = new Map(MOVES.map(m => [m.id, m]))

/** "thunder-punch" → "thunder_punch" so it can be looked up against MOVES_BY_ID. */
function normalizeApiMoveName(name) {
  return String(name ?? '').toLowerCase().trim().replace(/-/g, '_')
}

/** Generic type-matching filler so no Pokémon ever ends up with 0 moves. */
function fallbackMoveForType(type) {
  return MOVES.find(m => m.type === type && m.category !== 'status')
    ?? MOVES_BY_ID.get('tackle')
}

/**
 * Given a caught Pokémon's PokéAPI move-name list, returns every curated
 * move it could plausibly know, sorted by suitability: same-type (STAB)
 * damaging moves first (favoring higher power), then other damaging moves
 * by power, then status moves last. Does NOT attempt to replicate
 * PokéAPI's per-version-group level-up learnset timing — that requires
 * parsing move_learn_method/version_group_details and is overkill for a
 * "does this species know this move at all" check.
 *
 * @param {string[]} apiMoveNames - raw.moves[].move.name from PokéAPI
 * @param {string[]} pokemonTypes - the species' own types, for STAB sorting
 */
export function resolveLearnableMoves(apiMoveNames, pokemonTypes = []) {
  const known = new Set((apiMoveNames ?? []).map(normalizeApiMoveName))
  const candidates = MOVES.filter(m => known.has(m.id))

  return candidates.sort((a, b) => {
    const aStab = pokemonTypes.includes(a.type) ? 1 : 0
    const bStab = pokemonTypes.includes(b.type) ? 1 : 0
    if (aStab !== bStab) return bStab - aStab

    const aStatus = a.category === 'status' ? 1 : 0
    const bStatus = b.category === 'status' ? 1 : 0
    if (aStatus !== bStatus) return aStatus - bStatus

    return (b.power ?? 0) - (a.power ?? 0)
  })
}

/**
 * Picks exactly 4 move ids for a newly caught Pokémon. Falls back to
 * 'tackle' or a type-matching generic move as filler so no Pokémon ever
 * has fewer than 4 moves, even if the species' PokéAPI movepool barely
 * overlaps with our curated list.
 *
 * @param {string[]} apiMoveNames - raw.moves[].move.name from PokéAPI
 * @param {string[]} pokemonTypes - the species' own types
 * @returns {string[]} exactly 4 move ids
 */
export function pickDefaultMoveset(apiMoveNames, pokemonTypes = []) {
  const ranked = resolveLearnableMoves(apiMoveNames, pokemonTypes)
  const chosen = []
  const used = new Set()

  for (const m of ranked) {
    if (chosen.length >= 4) break
    if (used.has(m.id)) continue
    chosen.push(m.id)
    used.add(m.id)
  }

  // Filler: type-matching generic move(s) first, then any remaining
  // non-status move from the full curated list, until we hit 4 or the
  // curated list itself is exhausted (guards against an infinite loop on
  // a tiny/edge-case moves.json).
  const types = pokemonTypes.length ? pokemonTypes : ['normal']
  for (const type of types) {
    if (chosen.length >= 4) break
    const filler = fallbackMoveForType(type)
    if (filler && !used.has(filler.id)) {
      chosen.push(filler.id)
      used.add(filler.id)
    }
  }
  if (chosen.length < 4) {
    for (const m of MOVES) {
      if (chosen.length >= 4) break
      if (used.has(m.id)) continue
      chosen.push(m.id)
      used.add(m.id)
    }
  }

  return chosen
}

/** Looks up a move object from data/moves.json by id. Returns null if unknown. */
export function getMoveById(id) {
  return MOVES_BY_ID.get(id) ?? null
}

/** Resolves an array of move ids to move objects. Missing ids are silently dropped. */
export function getMovesForIds(ids) {
  return (ids ?? []).map(id => MOVES_BY_ID.get(id)).filter(Boolean)
}

export { MOVES as ALL_MOVES }
