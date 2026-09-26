/**
 * pokemon-engine.js — Pokémon catch/collection system.
 *
 * Pulls live Pokémon data (name, types, base stats, sprites) from PokéAPI
 * (https://pokeapi.co, no key required). Sprite images are served from
 * PokéAPI's companion sprites repo at stable, predictable URLs.
 *
 * Random selection: PokéAPI's national dex currently runs to genuinely
 * released Pokémon only (id 1–1025 as of Gen 9) — we pick a uniformly
 * random id in that range per spawn, same "random page/id + fetch" shape
 * as lib/series-engine.js's AniList approach and lib/card-engine.js's
 * Cards API approach, so all three collection systems stay easy to reason
 * about side-by-side.
 *
 * Mirrors lib/card-engine.js's toOwnedCard() / findOwnedCard() naming and
 * shape directly — a "card" here is a caught Pokémon.
 */

import { pickDefaultMoveset } from './move-pool.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const NATURES = require('../data/natures.json')

const API_BASE     = 'https://pokeapi.co/api/v2'
const SPRITE_BASE  = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'

// Claim-code charset: strips visually confusable glyphs (0/O, 1/I/l).
// Same convention as lib/card-engine.js's CODE_CHARS / lib/series-engine.js's.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generatePokemonClaimCode() {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

// National dex range PokéAPI currently has fully populated (Gen 1–9).
// Kept as a constant rather than queried live — this range only grows with
// new game releases, so a hardcoded cap is fine and avoids an extra request
// on every single spawn.
const MAX_DEX_ID = 1025

// Shiny odds — matches the reference bot's 1% rate.
const SHINY_CHANCE = 0.01

function rollShiny() {
  return Math.random() < SHINY_CHANCE
}

// ── Sprite URL helpers ───────────────────────────────────────────────────

/** Static front sprite (classic pixel-art style, small icon). */
export function spriteUrl(dexId, shiny = false) {
  return shiny ? `${SPRITE_BASE}/shiny/${dexId}.png` : `${SPRITE_BASE}/${dexId}.png`
}

/** Larger official artwork — used for catch/info/dex display. */
export function artworkUrl(dexId, shiny = false) {
  return shiny
    ? `${SPRITE_BASE}/other/official-artwork/shiny/${dexId}.png`
    : `${SPRITE_BASE}/other/official-artwork/${dexId}.png`
}

/** Animated "showdown"-style GIF sprite, when available for this dex id. */
export function animatedSpriteUrl(dexId, shiny = false) {
  return shiny ? `${SPRITE_BASE}/versions/generation-v/black-white/animated/shiny/${dexId}.gif`
               : `${SPRITE_BASE}/versions/generation-v/black-white/animated/${dexId}.gif`
}

// ── Live fetch (one in-flight guard, same rationale as series-engine.js) ──

let fetchInFlight = null

/**
 * Fetches one random Pokémon species from PokéAPI.
 * Returns null on any network failure, non-200 response, or empty result.
 * Shape: { dexId, name, types, abilities, hp, atk, def, spd, spAtk, spDef,
 *          apiMoveNames, image, isShiny }
 * (spAtk/spDef/apiMoveNames are additive — see §1.4 of the Pokémon system
 * overhaul; `spd` still means Speed everywhere, matching the existing
 * convention exactly, never Special Defense.)
 */
export async function fetchRandomPokemon() {
  if (fetchInFlight) return fetchInFlight
  fetchInFlight = _fetchOnce(/* retry= */ true).finally(() => { fetchInFlight = null })
  return fetchInFlight
}

/** Fetches a specific Pokémon by dex id or lowercase name — used by pokeinfo-style lookups. */
export async function fetchPokemonById(idOrName) {
  return _doFetch(idOrName)
}

async function _fetchOnce(retry = true) {
  const dexId = Math.floor(Math.random() * MAX_DEX_ID) + 1
  const first = await _doFetch(dexId)
  if (first) return first
  // Retry once with a fresh random id — a single failed request (timeout,
  // transient 5xx, or a dex id PokéAPI hasn't backfilled yet) shouldn't
  // silently kill a spawn sweep.
  if (retry) return _doFetch(Math.floor(Math.random() * MAX_DEX_ID) + 1)
  return null
}

// ── Evolution chain fetch (overhaul addendum §8.1) ──────────────────────────
// In-memory cache keyed by dexId — evolution chains never change, so once a
// species' chain has been fetched once for the process lifetime, every later
// level-up/evolve check for that species is free.
const evolutionChainCache = new Map()

/**
 * fetchEvolutionChain(dexId) — resolves a species' possible evolutions.
 * Returns { dexId, evolvesTo: [{ dexId, name, trigger, minLevel, item }] }
 * or null on any fetch failure. `trigger` is 'level-up' (has minLevel) or
 * 'use-item' (has item, the PokéAPI item name e.g. "fire-stone"). Any other
 * trigger (trade, friendship, etc.) is filtered out here — per addendum
 * §8.1, species with ONLY non-level/non-item triggers simply never evolve
 * in this bot.
 */
export async function fetchEvolutionChain(dexId) {
  if (evolutionChainCache.has(dexId)) return evolutionChainCache.get(dexId)

  const result = await _fetchEvolutionChainOnce(dexId)
  // Cache the result even on failure (null) so a species that 404s (e.g. a
  // form variant PokéAPI doesn't have species data for) doesn't get
  // re-fetched on every single level-up — worst case it just never evolves,
  // consistent with the "unmapped species don't evolve" fallback elsewhere.
  evolutionChainCache.set(dexId, result)
  return result
}

async function _fetchEvolutionChainOnce(dexId) {
  try {
    const speciesRes = await fetch(`${API_BASE}/pokemon-species/${dexId}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!speciesRes.ok) return null
    const species = await speciesRes.json()
    const chainUrl = species?.evolution_chain?.url
    if (!chainUrl) return null

    const chainRes = await fetch(chainUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!chainRes.ok) return null
    const chainData = await chainRes.json()

    // The chain is a tree (chain -> evolves_to[] -> evolves_to[] ...). Find
    // the node matching THIS dexId, then read its direct evolves_to[] —
    // we only care about the one-step-ahead evolutions from here, not the
    // whole multi-stage tree (checkEvolution() re-fetches/re-walks per mon
    // as it evolves stage by stage, same as real level-up chains do).
    const node = findChainNode(chainData.chain, dexId)
    if (!node) return null

    const evolvesTo = (node.evolves_to ?? [])
      .map(parseEvolutionTarget)
      .filter(Boolean)

    return { dexId, evolvesTo }
  } catch (err) {
    console.error('[pokemon-engine] Failed to fetch evolution chain:', err.message)
    return null
  }
}

/** Walks the PokéAPI chain tree looking for the node whose species id matches dexId. */
function findChainNode(node, dexId) {
  if (!node) return null
  const nodeId = speciesUrlToId(node.species?.url)
  if (nodeId === dexId) return node
  for (const child of node.evolves_to ?? []) {
    const found = findChainNode(child, dexId)
    if (found) return found
  }
  return null
}

function speciesUrlToId(url) {
  const match = String(url ?? '').match(/\/pokemon-species\/(\d+)\//)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Reads one evolves_to[] entry's evolution_details[0] and reduces it to our
 * simplified { dexId, name, trigger, minLevel, item } shape. Returns null
 * for triggers we don't support (trade, friendship, etc. — addendum §8.1).
 */
function parseEvolutionTarget(node) {
  const details = node.evolution_details?.[0]
  if (!details) return null

  const targetDexId = speciesUrlToId(node.species?.url)
  const targetName = node.species?.name
  if (!targetDexId || !targetName) return null

  const triggerName = details.trigger?.name // 'level-up' | 'trade' | 'use-item' | ...

  if (triggerName === 'level-up' && details.min_level) {
    return { dexId: targetDexId, name: targetName, trigger: 'level-up', minLevel: details.min_level, item: null }
  }
  if (triggerName === 'use-item' && details.item?.name) {
    return { dexId: targetDexId, name: targetName, trigger: 'use-item', minLevel: null, item: details.item.name }
  }
  // Trade, friendship, and other exotic triggers — unsupported in v1, skip.
  return null
}

async function _doFetch(idOrName) {
  try {
    const res = await fetch(`${API_BASE}/pokemon/${idOrName}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const raw = await res.json()

    const statMap = Object.fromEntries((raw.stats ?? []).map(s => [s.stat.name, s.base_stat]))
    const isShiny = rollShiny()

    return {
      dexId:     raw.id,
      name:      raw.name.charAt(0).toUpperCase() + raw.name.slice(1),
      types:     (raw.types ?? []).map(t => t.type.name),
      abilities: (raw.abilities ?? []).map(a => a.ability.name),
      hp:  statMap.hp ?? 50,
      atk: statMap.attack ?? 50,
      def: statMap.defense ?? 50,
      spd: statMap.speed ?? 50,
      // Special-attack/special-defense — PokéAPI already sends these in
      // raw.stats, previously silently dropped. Named spAtk/spDef (not
      // spa/spd) so `spd` unambiguously stays Speed everywhere.
      spAtk: statMap['special-attack'] ?? 50,
      spDef: statMap['special-defense'] ?? 50,
      // Raw move-name list for movepool resolution (lib/move-pool.js) at
      // catch time — NOT the moves themselves, just names, so this stays
      // one fetch per Pokémon rather than one fetch per move.
      apiMoveNames: (raw.moves ?? []).map(m => m.move?.name).filter(Boolean),
      image:   artworkUrl(raw.id, isShiny),
      sprite:  spriteUrl(raw.id, isShiny),
      isShiny,
      // Only meaningful for wild spawns (main.js's spawn sweep); ignored
      // when this shape flows straight into toOwnedPokemon() via a
      // non-spawn lookup like fetchPokemonById().
      claim: generatePokemonClaimCode(),
    }
  } catch (err) {
    console.error('[pokemon-engine] Failed to fetch from PokeAPI:', err.message)
    return null
  }
}

// ── Owned-Pokémon shape (stored in player.pokemon[]) ───────────────────────

const OWNED_ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateOwnedId() {
  let id = ''
  for (let i = 0; i < 10; i++) {
    id += OWNED_ID_CHARS[Math.floor(Math.random() * OWNED_ID_CHARS.length)]
  }
  return id
}

/**
 * rollIvs — Individual Values, overhaul addendum §9.2. 0–31 per stat,
 * independent rolls, no hidden-power/breeding mechanics (this bot has no
 * breeding). Rolled once at catch time and immutable after.
 */
function rollIvs() {
  const roll = () => Math.floor(Math.random() * 32)
  return { hp: roll(), atk: roll(), def: roll(), spAtk: roll(), spDef: roll(), spd: roll() }
}

/** Fresh EVs — overhaul addendum §9.3. All-zero at catch, gained from battling (see pokebattle.js). */
function freshEvs() {
  return { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0 }
}

/**
 * rollNature — overhaul addendum §9.1. Uniformly random pick from the
 * standard 25-nature table. Immutable after catch in v1 (no nature-mint
 * item — real games have one, skipped here, not worth the scope).
 */
function rollNature() {
  return NATURES[Math.floor(Math.random() * NATURES.length)].id
}

/**
 * Player-facing shape stored in player.pokemon[]. Mirrors card-engine.js's
 * toOwnedCard(). Exported so the NPC/wild battle engine (lib/npc-pokemon.js)
 * can build opponents with the EXACT same shape a caught Pokémon has, so every
 * stat/move/IV path treats an NPC mon identically to an owned one.
 */
export function toOwnedPokemon(raw, { level = 5 } = {}) {
  const maxHp = basePokemonHp(raw.hp, level)
  return {
    id:        raw.id ?? generateOwnedId(),
    dexId:     raw.dexId,
    name:      raw.name,
    nickname:  null,
    types:     raw.types,
    abilities: raw.abilities,
    level,
    exp:       0,
    happiness: 50,
    shiny:     !!raw.isShiny,
    protected: false,
    // base stats from the species — level/training modify these at battle time,
    // not stored pre-baked, so re-leveling/re-training never needs a migration.
    baseHp:  raw.hp,
    baseAtk: raw.atk,
    baseDef: raw.def,
    baseSpd: raw.spd,
    // Additive (§1.4 of the Pokémon overhaul) — special-attack/special-defense.
    // `baseSpd` above stays Speed, unchanged; these are new, separate fields.
    baseSpAtk: raw.spAtk ?? 50,
    baseSpDef: raw.spDef ?? 50,
    trainedAtk: 0,
    trainedDef: 0,
    trainedSpAtk: 0,
    trainedSpDef: 0,
    // Nature/IVs/EVs — overhaul addendum §9. Nature and IVs are rolled once
    // here and immutable after; EVs start at zero and are earned by battling
    // (see plugins/pokebattle.js's EV-award step in pokebattleConclude()).
    // These feed lib/pokemon-stats.js's computeBattleStats(), which is
    // additive on top of trainedAtk/trainedDef/etc above, not a replacement
    // for them — see that file's header note on why the two stay separate.
    nature: rollNature(),
    ivs: rollIvs(),
    evs: freshEvs(),
    // 4 move ids resolved once at catch time from this species' PokéAPI
    // movepool (raw.apiMoveNames) intersected with data/moves.json — see
    // lib/move-pool.js. pickDefaultMoveset() always returns exactly 4,
    // falling back to type-matching generics/Tackle if the species'
    // overlap with our curated list is thin.
    moves: pickDefaultMoveset(raw.apiMoveNames ?? [], raw.types ?? []),
    // Held item — overhaul addendum §11.1. Null until equipped via
    // .p-poke hold <n> <item>. Stores the pokemon-items.json id (held-
    // category item, e.g. a mega stone or Leftovers-equivalent) — the item
    // itself leaves the general inventory while held, same "equipped gear
    // leaves inventory" convention plugins/equip.js already uses.
    heldItem: null,
    maxHp,
    currentHp: maxHp,
    image:   raw.image,
    sprite:  raw.sprite,
    caughtAt: Date.now(),
  }
}

/** HP scales with level, same shape as the reference bot's formula (base × level/2 + buffer). */
export function basePokemonHp(baseHp, level) {
  return Math.floor(baseHp * (level / 2) + 50)
}

/**
 * ensurePokemonExtendedFields(mon) — lazy-backfill for saves caught before
 * this overhaul (missing `moves`/`baseSpAtk`/`baseSpDef`/`nature`/`ivs`/
 * `evs`). Mutates `mon` in place and returns true if anything was actually
 * backfilled, so callers know whether to persist the change via
 * updatePlayer (same pattern plugins/pokemon.js's `feed` handler already
 * uses for other mutations). Safe to call unconditionally on every read —
 * a no-op on already-current saves.
 */
export function ensurePokemonExtendedFields(mon) {
  if (!mon) return false
  let changed = false

  if (mon.baseSpAtk == null) { mon.baseSpAtk = 50; changed = true }
  if (mon.baseSpDef == null) { mon.baseSpDef = 50; changed = true }
  if (mon.trainedSpAtk == null) { mon.trainedSpAtk = 0; changed = true }
  if (mon.trainedSpDef == null) { mon.trainedSpDef = 0; changed = true }

  if (!Array.isArray(mon.moves) || mon.moves.length === 0) {
    // Old saves never stored PokéAPI's move-name list, so there's nothing
    // to intersect against — fall back to a type-matching default moveset
    // exactly like a fresh catch with an empty apiMoveNames list would.
    mon.moves = pickDefaultMoveset([], mon.types ?? [])
    changed = true
  }

  // Addendum §9 — nature/IVs/EVs. A pre-addendum Pokémon never had these
  // rolled at catch time, so backfill them once here: a random nature and
  // random IVs (same distribution a fresh catch would get — there's no
  // "fair" way to retroactively know what an old catch's roll would have
  // been, so this is the closest equivalent), and zeroed EVs (matching a
  // fresh catch's starting state — an old Pokémon hasn't earned any EVs
  // under this system yet either way).
  if (!mon.nature) { mon.nature = rollNature(); changed = true }
  if (!mon.ivs || typeof mon.ivs !== 'object') { mon.ivs = rollIvs(); changed = true }
  if (!mon.evs || typeof mon.evs !== 'object') { mon.evs = freshEvs(); changed = true }

  // Held item — addendum §11.1. A pre-addendum Pokémon never had this field
  // at all; default to "holding nothing" rather than inventing an item.
  if (mon.heldItem === undefined) { mon.heldItem = null; changed = true }

  return changed
}

/** Adds a caught Pokémon to a player's collection (mutates in place). Returns the owned entry. */
export function addPokemonToPlayer(player, rawPokemon, opts = {}) {
  if (!Array.isArray(player.pokemon)) player.pokemon = []
  const owned = toOwnedPokemon(rawPokemon, opts)
  player.pokemon.push(owned)
  return owned
}

/** Finds a Pokémon in the player's collection by exact id, or case-insensitive name/nickname match. */
export function findOwnedPokemon(player, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const mon = player.pokemon ?? []
  const found = mon.find(m => m.id === query)
    ?? mon.find(m => m.nickname?.toLowerCase() === q)
    ?? mon.find(m => m.name.toLowerCase() === q)
    ?? mon.find(m => m.name.toLowerCase().includes(q))
    ?? null
  if (found) ensurePokemonExtendedFields(found)
  return found
}

/** Sets a player's main battle Pokémon by owned id. Returns the entry or null if not owned. */
export function setMainPokemon(player, query) {
  const mon = findOwnedPokemon(player, query)
  if (!mon) return null
  player.mainPokemonId = mon.id
  return mon
}

/** Returns the player's current main Pokémon, or null if unset / no longer owned. */
export function getMainPokemon(player) {
  if (!player.mainPokemonId) return null
  const mon = (player.pokemon ?? []).find(m => m.id === player.mainPokemonId) ?? null
  // In-memory backfill so every read sees the extended shape even before a
  // write has persisted it — callers running inside updatePlayer() get the
  // backfill persisted for free since they're mutating the live object;
  // read-only callers (outside updatePlayer) just see correct defaults for
  // this call without a wasted extra write.
  if (mon) ensurePokemonExtendedFields(mon)
  return mon
}

// ── Type emoji (display only, purely decorative) ────────────────────────────
const TYPE_EMOJI = {
  normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿',
  ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️',
  psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉',
  dark: '🌑', steel: '⚙️', fairy: '✨',
}
export function typeEmoji(type) {
  return TYPE_EMOJI[type] ?? '❔'
}

export function formatTypes(types) {
  return (types ?? []).map(t => `${typeEmoji(t)} ${t}`).join(' / ')
}
