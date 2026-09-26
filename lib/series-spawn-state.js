/**
 * series-spawn-state.js — tracks the currently-unclaimed spawned anime series
 * per group chat (jid -> series). In-memory only, mirroring
 * lib/card-spawn-state.js exactly — a spawn still live when the bot restarts
 * is simply gone, which is fine for a spawn/claim minigame.
 */
const activeSeriesSpawns = new Map()

export function setActiveSeriesSpawn(jid, series) {
  activeSeriesSpawns.set(jid, series)
}

export function getActiveSeriesSpawn(jid) {
  return activeSeriesSpawns.get(jid) ?? null
}

export function clearActiveSeriesSpawn(jid) {
  activeSeriesSpawns.delete(jid)
}
