/**
 * poke-tower.js — the Sinnoh Pokemon League ladder helpers for the NPC tower
 * (plugins/poketower.js + plugins/pstrike.js's tower branch). Pure data +
 * reward math, no I/O and no db writes: the plugins own all replies and run
 * every mutation inside updatePlayer.
 *
 * The ladder itself lives in data/pokemon-masters.json (8 Gym Leaders, the
 * Elite Four, then Champion Cynthia). `stage` is the 1-based rung. Progress is
 * stored on player.pokeTower = { highestCleared, championed }.
 *
 * Copy is player-facing: no dashes.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const MASTERS = require('../data/pokemon-masters.json').masters

/** Every master, ordered by rung (stage 1 at the bottom). */
export function allMasters() {
  return MASTERS
}

/** The master at a given 1-based stage, or null if out of range. */
export function getMaster(stage) {
  return MASTERS.find(m => m.stage === stage) ?? null
}

/** Total number of rungs on the ladder. */
export function masterCount() {
  return MASTERS.length
}

/**
 * The rung a player may challenge next: one past their highest cleared, capped
 * at the top. A fresh player (no pokeTower) starts at rung 1. Returns null only
 * if they have already championed the whole ladder.
 */
export function nextStageFor(player) {
  const cleared = player.pokeTower?.highestCleared ?? 0
  if (cleared >= masterCount()) return null
  return cleared + 1
}

/**
 * Catch chance for a defeated wild mon. Lower-HP, lower-level foes are easier;
 * a much stronger player main tips it further. Clamped to a sane 15%..92% band
 * so nothing is a guaranteed catch or a hopeless one.
 */
export function catchChanceFor(foeMaxHp, foeLevel, playerLevel) {
  // Base eases as the foe's bulk/level drops relative to a soft reference.
  const hpFactor = 1 - Math.min(0.6, (foeMaxHp ?? 100) / 600)      // bulkier = harder
  const lvlEdge = Math.max(-0.2, Math.min(0.25, ((playerLevel ?? 5) - (foeLevel ?? 5)) / 60))
  const raw = 0.35 + hpFactor * 0.4 + lvlEdge
  return Math.max(0.15, Math.min(0.92, raw))
}

/**
 * A short display line for a master's one-time rung reward, e.g.
 * "☀️ 500 Solars" or "☀️ 2200 Solars + 💎 2 Gems". Does NOT pay anything out;
 * see applyTowerReward for that.
 */
export function towerRewardLine(master) {
  const r = master?.reward ?? {}
  const parts = []
  if (r.solars) parts.push(`☀️ *${r.solars}* Solars`)
  if (r.gems) parts.push(`💎 *${r.gems}* Gems`)
  return parts.join(' + ') || '_a sense of accomplishment_'
}

/**
 * Pay a master's rung reward into the player's wallet (mutates in place) and
 * return the same display line towerRewardLine produces. The CALLER guards that
 * this is a first clear so a rung never pays twice.
 */
export function applyTowerReward(player, master) {
  const r = master?.reward ?? {}
  player.wallet = player.wallet ?? {}
  if (r.solars) player.wallet.solars = (player.wallet.solars ?? 0) + r.solars
  if (r.gems) player.wallet.gems = Math.round(((player.wallet.gems ?? 0) + r.gems) * 100) / 100
  return towerRewardLine(master)
}
