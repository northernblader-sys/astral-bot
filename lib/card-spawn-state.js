/**
 * card-spawn-state.js — tracks the currently-unclaimed spawned card per
 * group chat (jid -> card). In-memory only, matching plugins/stream.js's
 * activeStreams pattern — a spawn that's still live when the bot restarts
 * is simply gone, which is fine for a spawn/claim minigame.
 */
const activeSpawns = new Map()

export function setActiveSpawn(jid, card) {
  activeSpawns.set(jid, card)
}

export function getActiveSpawn(jid) {
  return activeSpawns.get(jid) ?? null
}

export function clearActiveSpawn(jid) {
  activeSpawns.delete(jid)
}
