/**
 * lib/server-stats.js — lightweight in-memory bot health counters.
 *
 * commandsToday: incremented by handler.js on every command that reaches
 * the plugin dispatcher. Resets at local midnight (lazy check on every
 * increment/read). NOT persisted to disk — survives process restarts as 0,
 * which is the documented trade-off (cheap > durable for a health counter).
 *
 * Exports:
 *   incrementCommandCount()  — call once per dispatched command in handler.js
 *   getCommandsToday()       — read the current counter (e.g. in .serverstats)
 */

let commandsToday = 0
let dayStart      = todayMidnight()

function todayMidnight() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function maybeRollover() {
  if (Date.now() >= dayStart + 86_400_000) {
    commandsToday = 0
    dayStart      = todayMidnight()
  }
}

export function incrementCommandCount() {
  maybeRollover()
  commandsToday++
}

export function getCommandsToday() {
  maybeRollover()
  return commandsToday
}
