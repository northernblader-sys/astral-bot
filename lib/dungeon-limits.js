/**
 * dungeon-limits.js — daily cap on dungeon runs.
 *
 * Why: stamina potions made stamina effectively infinite, and with ~50 players
 * sharing three dungeon groups a handful of people could hold a dungeon all
 * day. Stamina limits how long one run lasts; nothing limited how many runs
 * one person could start. This does.
 *
 * A "run" is counted once per `.enter` that actually puts you in a dungeon —
 * not per floor, so a long clear costs the same as a short one, and re-entering
 * after `.dungeon leave` costs another run. That's deliberate: the scarce thing
 * is occupying a dungeon, and leaving/re-entering to reset is exactly the
 * hogging behaviour being reported.
 *
 * Resets at local midnight, same clock stamina already uses, so players only
 * have one reset time to remember.
 *
 * Tunable without a code change:
 *   DUNGEON_RUNS_PER_DAY          (default 7)
 *   DUNGEON_RUNS_PER_DAY_PREMIUM  (default 20)
 */
import { isPremiumActive } from './premium.js'

function envInt(name, fallback) {
  const raw = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const DUNGEON_RUNS_FREE    = envInt('DUNGEON_RUNS_PER_DAY', 7)
export const DUNGEON_RUNS_PREMIUM = envInt('DUNGEON_RUNS_PER_DAY_PREMIUM', 20)

/** Midnight tonight, local time — the same boundary stamina resets on. */
export function nextResetAt(now = Date.now()) {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export function dailyRunCap(player) {
  return isPremiumActive(player) ? DUNGEON_RUNS_PREMIUM : DUNGEON_RUNS_FREE
}

/**
 * Returns the player's run counter, rolling it over if the reset time has
 * passed. Mutates in place (call inside an updatePlayer mutator) and is safe
 * on accounts that predate the field.
 */
export function refreshDungeonRuns(player, now = Date.now()) {
  const runs = player.dungeonRuns ?? { used: 0, resetAt: 0 }
  if (!runs.resetAt || now >= runs.resetAt) {
    runs.used = 0
    runs.resetAt = nextResetAt(now)
  }
  player.dungeonRuns = runs
  return runs
}

export function runsRemaining(player, now = Date.now()) {
  const runs = refreshDungeonRuns(player, now)
  return Math.max(0, dailyRunCap(player) - runs.used)
}

/** Call once a dungeon entry has actually been granted. */
export function consumeDungeonRun(player, now = Date.now()) {
  const runs = refreshDungeonRuns(player, now)
  runs.used += 1
  return runs
}

function formatResetIn(resetAt, now = Date.now()) {
  const ms = Math.max(0, resetAt - now)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** The message shown when someone has used every run for the day. */
export function runLimitMessage(player, prefix = '.', now = Date.now()) {
  const runs = refreshDungeonRuns(player, now)
  const cap = dailyRunCap(player)
  const premium = isPremiumActive(player)
  return (
    `🚪 *Daily dungeon limit reached* — *${runs.used}/${cap}* runs used today.\n` +
    `─────────────────────\n` +
    `⏳ Resets in *${formatResetIn(runs.resetAt, now)}* _(midnight)_.\n\n` +
    `_Dungeon groups are shared. The cap is there so the same few players ` +
    `can't hold every room all day._\n\n` +
    (premium
      ? `👑 You're on the premium allowance already (*${DUNGEON_RUNS_PREMIUM}/day*).`
      : `👑 *Premium gets ${DUNGEON_RUNS_PREMIUM} runs a day* instead of ${DUNGEON_RUNS_FREE} — *${prefix}premium*.`) +
    `\n\n_Meanwhile: *${prefix}quest*, *${prefix}work*, *${prefix}raid* and *${prefix}pvp* don't use dungeon runs._`
  )
}

/** Short status line appended to the entry reply so the count is never a surprise. */
export function runsLine(player, prefix = '.', now = Date.now()) {
  const runs = refreshDungeonRuns(player, now)
  const cap = dailyRunCap(player)
  const left = Math.max(0, cap - runs.used)
  const upsell = !isPremiumActive(player) && left <= 1
    ? ` _(👑 premium: ${DUNGEON_RUNS_PREMIUM}/day — ${prefix}premium)_`
    : ''
  return `🚪 Dungeon runs today: *${runs.used}/${cap}* · *${left}* left${upsell}`
}
