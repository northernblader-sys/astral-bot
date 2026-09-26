/**
 * pokegame-data.js — data + math for the in-app Pokémon game.
 *
 * The app's battles run on Pokémon Showdown's real battle engine (the
 * `pokemon-showdown` npm package). This file is everything around it that is
 * NOT the battle loop itself:
 *
 *   - species / moves / learnsets, read from Showdown's own dex
 *   - turning a saved bot Pokémon (player.pokemon[]) into a Showdown "set"
 *   - catch odds, EXP, and what each Pokémon item does inside a battle
 *   - image URLs for items and sprites (GitHub PokeAPI/sprites, no hosting)
 *
 * NAMING WARNING. The bot names its stats hp/atk/def/spAtk/spDef/spd where
 * `spd` means SPEED. Showdown (and the app JSON this API returns) uses
 * hp/atk/def/spa/spd/spe where `spd` means SPECIAL DEFENSE. Every crossing
 * between the two goes through botToPsStats() below — never map by hand.
 */
import { createRequire } from 'module'
import { toOwnedPokemon } from './pokemon-engine.js'
import { BALL_MULT, spriteChain } from './pokegame-items.js'

export * from './pokegame-items.js'

const require = createRequire(import.meta.url)
const { Dex, Teams, toID } = require('pokemon-showdown')

export { Dex, toID }

/* ── tunables (game balance lives here, not scattered through routes) ──────── */

export const CONST = {
  PARTY_MAX: 6,
  MAX_LEVEL: 100,
  SHINY_CHANCE: 0.01,
  HUNT_LEVEL_BAND: [-3, 2],       // wild level = your lead's level + a roll in this range
  WILD_PAYOUT_PER_LEVEL: 3,       // Solars for beating a wild Pokémon
  TRAINER_PAYOUT_PER_LEVEL: 5,    // Solars for re-beating an already-cleared tower rung
  EXP_PER_FOE_LEVEL: 8,
  TRAINER_EXP_MULT: 1.5,
  FEED_COST: 50,                  // same as `.p-poke feed`
  FEED_HEAL_PCT: 10,
  TRAIN_COST_PER_LEVEL: 200,      // same as `.p-poke train`
  TRAIN_EV_GAIN: 12,              // EVs added to the chosen stat per training
  EV_PER_STAT: 252,
  EV_TOTAL: 510,
  LEGEND_WEIGHT: 0.15,            // how rarely legendaries show up in hunts
  ULTRA_WEIGHT: 0.5,
  BAG_STACK_MAX: 999,
  SESSION_IDLE_MS: 30 * 60_000,
}

export const REGIONS = {
  kanto: [1, 151], johto: [152, 251], hoenn: [252, 386], sinnoh: [387, 493],
  unova: [494, 649], kalos: [650, 721], alola: [722, 809], galar: [810, 905], paldea: [906, 1025],
}

/* ── species ───────────────────────────────────────────────────────────────── */

const BASE_BY_NUM = new Map()
for (const sp of Dex.species.all()) {
  if (sp.num > 0 && sp.num <= 1025 && !sp.forme && !BASE_BY_NUM.has(sp.num)) BASE_BY_NUM.set(sp.num, sp)
}

export const speciesByNum = num => BASE_BY_NUM.get(num) ?? null

/** PokeAPI gives each Mega its own sprite id; the base dex number would show the un-evolved form. */
const FORM_SPRITE = {
  'Charizard-Mega-X': 10034, 'Charizard-Mega-Y': 10035, 'Gengar-Mega': 10038, 'Kangaskhan-Mega': 10039,
  'Gyarados-Mega': 10041, 'Mewtwo-Mega-X': 10043, 'Mewtwo-Mega-Y': 10044, 'Blaziken-Mega': 10050,
  'Absol-Mega': 10057, 'Garchomp-Mega': 10058, 'Lucario-Mega': 10059, 'Metagross-Mega': 10076,
  'Salamence-Mega': 10089,
}
export const spriteDexFor = (speciesName, num) => FORM_SPRITE[speciesName] ?? num

/** The Showdown species for one of the bot's owned/foe Pokémon. Never null for real dex ids. */
export function speciesForMon(mon) {
  const byName = Dex.species.get(String(mon.name ?? ''))
  if (byName.exists && byName.num === mon.dexId) return byName
  return BASE_BY_NUM.get(mon.dexId) ?? (byName.exists ? byName : Dex.species.get('rattata'))
}

const bstOf = sp => Object.values(sp.baseStats).reduce((a, b) => a + b, 0)
export const speciesBst = bstOf

function spawnWeight(sp) {
  const t = sp.tags ?? []
  if (t.includes('Restricted Legendary') || t.includes('Mythical') || t.includes('Sub-Legendary')) return CONST.LEGEND_WEIGHT
  if (t.includes('Ultra Beast') || t.includes('Paradox')) return CONST.ULTRA_WEIGHT
  return 1
}

/** Weighted-random species, optionally limited to one region's dex range. */
export function pickWildSpecies(region = null) {
  const [lo, hi] = REGIONS[String(region ?? '').toLowerCase()] ?? [1, 1025]
  const pool = []
  let total = 0
  for (let n = lo; n <= hi; n++) {
    const sp = BASE_BY_NUM.get(n)
    if (!sp) continue
    const w = spawnWeight(sp)
    pool.push([sp, w]); total += w
  }
  let roll = Math.random() * total
  for (const [sp, w] of pool) { roll -= w; if (roll <= 0) return sp }
  return pool[pool.length - 1][0]
}

/* ── moves ─────────────────────────────────────────────────────────────────── */

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function moveInfo(id) {
  const m = Dex.moves.get(id)
  if (!m.exists) return null
  return {
    id: m.id, name: m.name, type: m.type, category: m.category,
    power: m.basePower || null, accuracy: m.accuracy === true ? null : m.accuracy,
    pp: m.pp, priority: m.priority, desc: m.shortDesc,
  }
}

/** Level-up moves a species knows by `level` in Gen 9, newest last. */
function levelUpList(sp) {
  const ld = Dex.species.getLearnsetData(sp.id)
  const out = []
  for (const [id, sources] of Object.entries(ld?.learnset ?? {})) {
    const lv = sources.filter(s => /^9L\d+$/.test(s)).map(s => Number(s.slice(2)))
    if (lv.length) out.push({ id, level: Math.min(...lv) })
  }
  return out.sort((a, b) => a.level - b.level)
}

/** A sensible 4-move set: up to 3 recent attacks plus 1 recent status move. */
export function defaultMoves(sp, level) {
  const known = levelUpList(sp).filter(m => m.level <= level).map(m => m.id)
  const usable = [...new Set(known)].filter(id => Dex.moves.get(id).exists && !Dex.moves.get(id).isNonstandard)
  const isDmg = id => Dex.moves.get(id).basePower > 0
  const dmgs = usable.filter(isDmg)
  const status = usable.filter(id => !isDmg(id))
  if (!dmgs.length) {
    // Nothing offensive learned yet: fall back to the best same-type move the species can ever learn.
    const anyDmg = Object.keys(Dex.species.getLearnsetData(sp.id)?.learnset ?? {})
      .filter(id => Dex.moves.get(id).exists && !Dex.moves.get(id).isNonstandard && isDmg(id) && sp.types.includes(Dex.moves.get(id).type))
      .sort((a, b) => Dex.moves.get(a).basePower - Dex.moves.get(b).basePower)
    dmgs.push(anyDmg.find(id => Dex.moves.get(id).basePower >= 40) ?? anyDmg[0] ?? 'tackle')
  }
  const picked = [...dmgs.slice(-3)]
  const extra = status.length ? status[status.length - 1] : dmgs.slice(-4, -3)[0]
  if (extra && !picked.includes(extra)) picked.unshift(extra)
  return [...new Set(picked)].slice(0, 4)
}

/** Every move this Pokémon may legally be taught right now (Gen 9). */
export function learnableMoves(sp, level) {
  const ld = Dex.species.getLearnsetData(sp.id)
  const out = []
  for (const [id, sources] of Object.entries(ld?.learnset ?? {})) {
    const m = Dex.moves.get(id)
    if (!m.exists || m.isNonstandard) continue
    let how = null
    for (const s of sources) {
      if (!s.startsWith('9')) continue
      const kind = s[1]
      if (kind === 'L') { if (Number(s.slice(2)) <= level) how = how ?? 'level' } else how = kind === 'M' ? 'tm' : kind === 'E' ? 'egg' : kind === 'T' ? 'tutor' : 'event'
    }
    if (how) out.push({ ...moveInfo(id), how })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The moves a mon will actually fight with, as Showdown ids. Migrates old saves lazily. */
export function psMovesOf(mon, sp = speciesForMon(mon)) {
  if (Array.isArray(mon.psMoves) && mon.psMoves.length) {
    const ok = mon.psMoves.map(toID).filter(id => Dex.moves.get(id).exists)
    if (ok.length) return ok.slice(0, 4)
  }
  const fromBot = (mon.moves ?? []).map(toID).filter(id => Dex.moves.get(id).exists && !Dex.moves.get(id).isNonstandard)
  return fromBot.length ? [...new Set(fromBot)].slice(0, 4) : defaultMoves(sp, mon.level ?? 5)
}

/* ── stat crossing (see the NAMING WARNING at the top) ─────────────────────── */

const BOT_TO_PS = { hp: 'hp', atk: 'atk', def: 'def', spAtk: 'spa', spDef: 'spd', spd: 'spe' }
export const PS_STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']

export function botToPsStats(obj = {}, fallback = 0) {
  const out = {}
  for (const [botKey, psKey] of Object.entries(BOT_TO_PS)) out[psKey] = Number(obj[botKey] ?? fallback) || 0
  return out
}
export function psToBotStats(obj = {}) {
  const out = {}
  for (const [botKey, psKey] of Object.entries(BOT_TO_PS)) out[botKey] = Number(obj[psKey] ?? 0) || 0
  return out
}

/** Real Gen 3+ stats for an owned Pokémon (uses Showdown's own numbers). */
export function realStats(mon) {
  const sp = speciesForMon(mon)
  const ivs = botToPsStats(mon.ivs, 31)
  const evs = botToPsStats(mon.evs, 0)
  const nat = Dex.natures.get(String(mon.nature ?? 'hardy'))
  const lv = mon.level ?? 5
  const out = {}
  for (const k of PS_STATS) {
    const base = sp.baseStats[k]
    const core = Math.floor(((2 * base + Math.min(31, ivs[k]) + Math.floor(Math.min(252, evs[k]) / 4)) * lv) / 100)
    if (k === 'hp') { out.hp = base === 1 ? 1 : core + lv + 10; continue }
    const mult = nat.plus === k ? 1.1 : nat.minus === k ? 0.9 : 1
    out[k] = Math.floor((core + 5) * mult)
  }
  return out
}

/** HP as a 0..1 fraction of the bot's stored (chat-scale) HP — the bridge between the two HP scales. */
export const hpFraction = mon => (mon.maxHp > 0 ? Math.max(0, Math.min(1, (mon.currentHp ?? mon.maxHp) / mon.maxHp)) : 1)

export function psItemFor(mon) {
  const id = mon.heldItem
  if (!id) return ''
  if (id === 'poke_resist_berry') return 'Enigma Berry'
  const guess = Dex.items.get(String(id).replace(/^poke_/, '').replace(/_/g, ' '))
  return guess.exists ? guess.name : ''
}

function psAbilityFor(mon, sp) {
  const legal = Object.values(sp.abilities).map(toID)
  for (const a of mon.abilities ?? []) if (legal.includes(toID(a))) return Dex.abilities.get(a).name
  return sp.abilities[0]
}

/** A saved/foe Pokémon → a Showdown set. `name` is a short slot tag so the app can map events back. */
export function toPsSet(mon, slotTag) {
  const sp = speciesForMon(mon)
  const ivs = botToPsStats(mon.ivs, 31)
  const evs = botToPsStats(mon.evs, 0)
  return {
    name: slotTag,
    species: sp.name,
    item: psItemFor(mon),
    ability: psAbilityFor(mon, sp),
    moves: psMovesOf(mon, sp),
    nature: Dex.natures.get(String(mon.nature ?? 'hardy')).name,
    evs, ivs,
    level: Math.max(1, Math.min(100, mon.level ?? 5)),
    gender: '',
    shiny: !!mon.shiny,
  }
}

export const packTeam = sets => Teams.pack(sets)

/* ── building foes ─────────────────────────────────────────────────────────── */

/**
 * An owned-shape Pokémon (exactly what a caught one looks like in player.pokemon[])
 * for a wild encounter or a trainer's team. Reuses the bot's own toOwnedPokemon()
 * so nature/IVs/EVs/ids come from the same code that runs on a WhatsApp catch.
 */
export function buildFoe(sp, level, { shiny = false } = {}) {
  const b = sp.baseStats
  const raw = {
    dexId: sp.num, name: sp.name, types: sp.types.map(t => t.toLowerCase()),
    abilities: Object.values(sp.abilities).map(a => a.toLowerCase().replace(/\s+/g, '-')),
    hp: b.hp, atk: b.atk, def: b.def, spd: b.spe, spAtk: b.spa, spDef: b.spd,
    apiMoveNames: [], image: spriteChain(sp.num, { shiny })[1], sprite: spriteChain(sp.num, { shiny })[2],
    isShiny: shiny,
  }
  const mon = toOwnedPokemon(raw, { level })
  mon.heldItem = null
  mon.psMoves = defaultMoves(sp, level)
  return mon
}

/* ── catching, exp, running ────────────────────────────────────────────────── */

export function catchRateFor(sp) {
  const t = sp.tags ?? []
  if (t.includes('Restricted Legendary') || t.includes('Mythical')) return 3
  if (t.includes('Sub-Legendary')) return 25
  if (t.includes('Paradox')) return 10
  if (t.includes('Ultra Beast')) return 30
  return Math.max(25, Math.min(255, Math.round(255 - Math.max(0, bstOf(sp) - 180) * 0.6)))
}

/** Gen 3/4 style catch maths. Returns per-shake odds and the overall chance. */
export function catchOdds({ sp, hp, maxhp, status, ballId }) {
  const ball = BALL_MULT[ballId] ?? 1
  if (ball === Infinity) return { a: 255, b: 65536, chance: 1 }
  const statusBonus = status === 'slp' || status === 'frz' ? 2 : status ? 1.5 : 1
  const a = Math.min(255, ((3 * maxhp - 2 * hp) * catchRateFor(sp) * ball * statusBonus) / (3 * maxhp))
  if (a >= 255) return { a, b: 65536, chance: 1 }
  const b = 1048560 / Math.sqrt(Math.sqrt(16711680 / Math.max(1, a)))
  return { a, b, chance: Math.pow(b / 65536, 4) }
}

export function rollCatch(odds) {
  for (let i = 0; i < 4; i++) if (Math.random() * 65536 >= odds.b) return { caught: false, shakes: i }
  return { caught: true, shakes: 3 }
}

/** EXP for defeating one foe (scaled to the bot's `level * 100` per-level curve). */
export function expForFoe(foeMon, { trainer = false } = {}) {
  const sp = speciesForMon(foeMon)
  const base = (foeMon.level ?? 5) * CONST.EXP_PER_FOE_LEVEL + bstOf(sp) / 10
  return Math.max(1, Math.round(base * (trainer ? CONST.TRAINER_EXP_MULT : 1)))
}

/** Classic run-away formula. `attempts` = how many times you've already tried. */
export function runSucceeds(mySpeed, foeSpeed, attempts) {
  const f = Math.floor((mySpeed * 128) / Math.max(1, foeSpeed)) + 30 * attempts
  return f > 255 || Math.floor(Math.random() * 256) < f
}

export const titleType = t => cap(String(t ?? '').toLowerCase())
export const psTypes = sp => sp.types.slice()
