/**
 * sleep-engine.js — inn sleep mechanic.
 *
 * A player can sleep at the inn once per calendar day to fully restore
 * stamina, HP, MP, and hunger. While asleep, ALL commands are locked out
 * (enforced in handler.js) until the sleep duration elapses (SLEEP_MINUTES) —
 * waking is automatic, triggered by the next message they send after
 * `sleepUntil` has passed.
 */
import { feed, HUNGER_MAX } from './hunger-engine.js'

export const SLEEP_MINUTES = 45

export function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** True if the player is currently asleep (sleepUntil is set and in the future). */
export function isAsleep(player) {
  return !!(player?.sleepUntil && Date.now() < player.sleepUntil)
}

/** True if the player has already slept today (blocks a second sleep same day). */
export function hasSleptToday(player) {
  if (!player?.lastSleepDate) return false
  return player.lastSleepDate === startOfDay(Date.now())
}

/**
 * If the player's sleep has elapsed, wakes them (clears sleepUntil) and
 * fully restores stamina/HP/MP/hunger in place. Returns true if a wake just
 * happened (caller is responsible for persisting + notifying).
 */
export function wakeIfDue(player) {
  if (!player?.sleepUntil || Date.now() < player.sleepUntil) return false

  player.sleepUntil = null
  player.hp = player.maxHp
  player.mp = player.maxMp
  if (player.stamina) player.stamina.current = player.stamina.max
  // A full night's rest also fully feeds you. Use feed() (not resetHunger) so
  // an active Golden Apple keeps its immunity — that only ends on death.
  feed(player, HUNGER_MAX)

  return true
}

/** Puts the player to sleep starting now. Caller must persist afterward. */
export function beginSleep(player) {
  const now = Date.now()
  player.sleepUntil    = now + SLEEP_MINUTES * 60 * 1000
  player.lastSleepDate = startOfDay(now)
}
