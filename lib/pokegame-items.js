/**
 * pokegame-items.js — the LIGHT half of the Pokémon game data: item catalog, item effects and
 * image URLs. No Showdown import, so lib/api-server.js can use it at boot (to label Pokémon
 * items in /api/me) without loading the ~140 MB battle engine. pokegame-data.js re-exports it.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const POKE_ITEMS = require('../data/pokemon-items.json')

/* ── image URLs (mirrors the app's PokeArt.kt so either side can build them) ── */

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites'

export const ITEM_NO_ART = new Set([
  'poke_battle_crown', 'poke_ribbon_basic', 'poke_ribbon_champ', 'poke_spotlight_charm',
  'poke_trainer_title_ace', 'poke_trainer_title_champion', 'poke_prestige_aura', 'poke_rayquazite',
])
const ITEM_SLUG = { poke_x_defend: 'x-defense', poke_resist_berry: 'enigma-berry', poke_ball: 'poke-ball' }

/** PNG icon URL for a Pokémon item id, or null when the item has no sprite. */
export function itemIconUrl(id) {
  if (ITEM_NO_ART.has(id)) return null
  const slug = ITEM_SLUG[id] ?? String(id).replace(/^poke_/, '').replace(/_/g, '-')
  return `${SPRITES}/items/${slug}.png`
}

/** Best-first fallback chain of sprite URLs (animated GIF → artwork → static). */
export function spriteChain(dexId, { shiny = false, back = false } = {}) {
  const s = shiny ? 'shiny/' : ''
  const front = [
    `${SPRITES}/pokemon/other/showdown/${s}${dexId}.gif`,
    `${SPRITES}/pokemon/other/official-artwork/${s}${dexId}.png`,
    `${SPRITES}/pokemon/${s}${dexId}.png`,
  ]
  return back ? [`${SPRITES}/pokemon/other/showdown/back/${s}${dexId}.gif`, ...front.slice(1)] : front
}

/* ── item catalog ──────────────────────────────────────────────────────────── */

const itemList = Array.isArray(POKE_ITEMS) ? POKE_ITEMS : Object.values(POKE_ITEMS.items ?? POKE_ITEMS)
export const POKE_ITEM_MAP = new Map(itemList.map(i => [i.id, i]))
export const isPokeItem = id => POKE_ITEM_MAP.has(id)
export const allPokeItems = () => itemList

export const BALL_MULT = { poke_ball: 1, poke_great_ball: 1.5, poke_ultra_ball: 2, poke_master_ball: Infinity }

/**
 * What an item does INSIDE a battle. Amounts are Showdown-scale (a level-50
 * mon has ~100-150 HP), NOT the bot's chat-battle scale — that is why these are
 * not read from pokemon-items.json's `effect` field.
 */
export const ITEM_FX = {
  poke_oran_berry:     { heal: 10 },
  poke_sitrus_berry:   { healPct: 25 },
  poke_pecha_berry:    { cure: ['psn', 'tox'] },
  poke_super_potion:   { heal: 60 },
  poke_hyper_potion:   { heal: 120 },
  poke_max_potion:     { healPct: 100 },
  poke_antidote:       { cure: ['psn', 'tox'] },
  poke_burn_heal:      { cure: ['brn'] },
  poke_ice_heal:       { cure: ['frz'] },
  poke_paralyze_heal:  { cure: ['par'] },
  poke_full_heal:      { cure: 'all' },
  poke_x_attack:       { boost: { atk: 1 } },
  poke_x_defend:       { boost: { def: 1 } },
  poke_x_sp_atk:       { boost: { spa: 1 } },
  poke_x_speed:        { boost: { spe: 1 } },
  poke_power_herb:     { boost: { atk: 2 } },
  poke_battle_crown:   { boost: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 } },
  poke_revive:         { revivePct: 50 },
  poke_max_revive:     { revivePct: 100 },
}

/** Items you can use in a fight (a turn is spent), and out of one. */
export const inBattleUsable = id => !!ITEM_FX[id] && !ITEM_FX[id].revivePct
export const outOfBattleUsable = id => !!(ITEM_FX[id]?.heal || ITEM_FX[id]?.healPct || ITEM_FX[id]?.revivePct)

