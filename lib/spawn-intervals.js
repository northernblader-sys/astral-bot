/**
 * spawn-intervals.js — single source of truth for the auto-spawn sweep
 * cadences.
 *
 * These numbers are used in two places that used to be edited independently
 * and drifted apart: main.js schedules the actual setInterval sweeps, and the
 * group-toggle plugins (pokeswitch / waifu / series) tell players how often to
 * expect a spawn. When the Pokémon sweep was slowed from 5 min to 90 min, only
 * main.js was updated — so .pokeswitch kept promising "every 5 minutes" while
 * the sweep really ran every 90. Importing the same constant in both places,
 * and formatting the player-facing string from it via humanInterval(), means a
 * "spawns every X" line can never lie again.
 */

export const CARD_SPAWN_INTERVAL_MS    = 60 * 60_000      // 1 hour
export const SERIES_SPAWN_INTERVAL_MS  = 2 * 60 * 60_000   // 2 hours
export const POKEMON_SPAWN_INTERVAL_MS = 90 * 60_000       // 1 hour 30 minutes
export const POKEMON_SPAWN_FLEE_MS     = 2 * 60_000        // 2 minutes

/**
 * Compact, human-readable interval for player-facing text.
 *   humanInterval(90 * 60_000) -> "1h 30m"
 *   humanInterval(60 * 60_000) -> "1h"
 *   humanInterval(2 * 60_000)  -> "2m"
 */
export function humanInterval(ms) {
  const totalMin = Math.round(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const parts = []
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  return parts.join(' ') || '0m'
}
