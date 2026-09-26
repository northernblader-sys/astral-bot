/**
 * pokemon-spawn-state.js — tracks the currently-unclaimed wild Pokémon per
 * group chat (jid -> pokemon), plus a per-catch expiry timer handle.
 * In-memory only, matching lib/card-spawn-state.js's pattern — a spawn
 * still live when the bot restarts is simply gone, which is fine for a
 * spawn/catch minigame.
 */
const activeSpawns = new Map()

export function setActiveSpawn(jid, pokemon) {
  activeSpawns.set(jid, pokemon)
}

export function getActiveSpawn(jid) {
  return activeSpawns.get(jid) ?? null
}

export function clearActiveSpawn(jid) {
  activeSpawns.delete(jid)
}
