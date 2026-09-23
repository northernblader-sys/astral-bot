/**
 * lib/town.js — Astral Town's walkable streets and the people on them.
 *
 * This is a soft position, player.townSpot. It never gates .shop, .inn, or
 * travel. A player in a dungeon is not on a street; everyone else can walk.
 * Copy is player-facing: no em or en dashes.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const DATA = require('../data/town.json')

export const TOWN_SPOTS = DATA.spots
export const TOWN_NPCS = DATA.npcs

export const spotMap = Object.fromEntries(TOWN_SPOTS.map(s => [s.id, s]))
export const npcMap = Object.fromEntries(TOWN_NPCS.map(n => [n.id, n]))

export function spotOf(id) {
  return spotMap[id] ?? null
}

export function npcOf(id) {
  return npcMap[id] ?? null
}

export function npcsAt(spotId) {
  const spot = spotMap[spotId]
  if (!spot) return []
  return (spot.npcs ?? []).map(id => npcMap[id]).filter(Boolean)
}

/** Free-text place -> spot, or null. */
export function findSpot(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const compact = q.replace(/[^a-z0-9]+/g, '')
  return TOWN_SPOTS.find(s =>
    s.id === q ||
    s.id === compact ||
    s.name.toLowerCase() === q ||
    s.words.some(w => w === q || w === compact) ||
    s.name.toLowerCase().includes(q)
  ) ?? null
}

/** Free-text name -> npc, optionally limited to one street. */
export function findNpc(query, spotId = null) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const pool = spotId ? npcsAt(spotId) : TOWN_NPCS
  return pool.find(n =>
    n.id === q ||
    n.name.toLowerCase() === q ||
    n.words.some(w => w === q) ||
    n.name.toLowerCase().includes(q)
  ) ?? null
}

/**
 * Can this player walk a town street right now?
 * In a dungeon or a live fight, no. Soft townSpot does not care what
 * player.location still says after a leave.
 */
export function townWalkBlock(player) {
  if (!player) return 'register'
  if (player.inBattle) return 'battle'
  if (player.inDungeon) return 'dungeon'
  return null
}
