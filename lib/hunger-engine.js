/**
 * hunger-engine.js — the player hunger bar.
 *
 * Design mirror: this is to hunger what lib/housing-engine.js is to homes and
 * lib/sleep-engine.js is to sleep — the single source of truth for the shape
 * of `player.hunger` and every mutation to it. No plugin pokes player.hunger
 * fields directly; they call the helpers here.
 *
 * The bar drains by REAL wall-clock time, computed lazily on each command
 * (see the tick in handler.js) rather than by a background timer — exactly the
 * same "bake elapsed time into state on read" trick home crops use with
 * readyAt. `hunger.lastTick` records when decay was last applied; the next
 * tick drains `(now - lastTick)` worth and moves lastTick forward.
 *
 * When the bar hits empty the player is STARVING. Starvation NEVER kills and
 * never touches HP — it bleeds STAMINA, fast. Once the bar is empty and
 * stamina has been drained to 0 the player is COLLAPSED: too weak to act at
 * all (see isCollapsed() and the collapse gate in handler.js) until they eat.
 *
 * That is a deliberate design choice. Death used to be the starvation
 * penalty, and because any death costs the player progress, "I starved while
 * afk and lost stats" was the single most common complaint. A collapse is
 * recoverable — it costs the player TIME and the ability to act, not their
 * character sheet. There is no path from hunger to a stat loss any more: HP is
 * never reduced, so hunger can't leave a player at 1 HP to be finished off by
 * the next monster either.
 *
 * The Golden Apple (data/food.json) sets `immune = true`: the bar is pinned
 * full and never drains — "you cannot get hungry" — until the player next dies
 * by ANY means, at which point resetHunger() clears the flag.
 */
import { config } from '../config.js'

export const HUNGER_MAX = 100

/**
 * Full → empty over this many minutes of real time. Tuned so a player only
 * "gets hungry after about an hour of playing": ~33/100 left at the 60-minute
 * mark, fully empty at 90. Bump this up to make hunger even more forgiving.
 */
export const MINUTES_TO_EMPTY = 90

/**
 * Once the bar is empty, stamina drain per minute of continued starvation.
 * Steep on purpose: stamina is now the ONLY starvation penalty, so it has to
 * actually bite. A full-ish stamina pool empties in a couple of minutes of
 * starving, at which point the player is collapsed.
 */
export const STARVE_STAM_PER_MIN = 25

/**
 * Starvation does NOT drain HP and can NOT kill — see the file header. This is
 * kept as an explicit zero (rather than deleted) so the intent is visible: it
 * is not an oversight that no HP math runs below.
 */
export const STARVE_HP_PER_MIN = 0

/** Don't nag more than once per this window while starving. */
const WARN_COOLDOWN_MS = 10 * 60 * 1000

/** Points of hunger lost per millisecond. */
const DECAY_PER_MS = HUNGER_MAX / (MINUTES_TO_EMPTY * 60 * 1000)

/**
 * Backfills player.hunger to the expected shape (idempotent). Accounts that
 * predate this feature come out FULL rather than instantly starving — a fresh
 * lastTick means their first tick drains ~nothing.
 *
 * hpDebt / stamDebt carry fractional starvation damage between ticks so rapid
 * command spam still drains the correct amount over time instead of rounding
 * every sub-1 tick down to zero.
 */
export function ensureHunger(player, now = Date.now()) {
  const h = player.hunger ?? (player.hunger = {})
  if (typeof h.max !== 'number' || h.max <= 0) h.max = HUNGER_MAX
  if (typeof h.current !== 'number') h.current = h.max
  if (h.current > h.max) h.current = h.max
  if (h.current < 0) h.current = 0
  if (typeof h.lastTick !== 'number') h.lastTick = now
  if (typeof h.immune !== 'boolean') h.immune = false
  if (typeof h.hpDebt !== 'number') h.hpDebt = 0
  if (typeof h.stamDebt !== 'number') h.stamDebt = 0
  if (h.lastWarnAt === undefined) h.lastWarnAt = null
  return h
}

/**
 * The core lazy update. Call once per command with the current time.
 *
 * Returns a small descriptor the caller (handler.js) uses to decide whether to
 * message the player — silent by default, so a merely-hungry player is never
 * spammed:
 *   {}                                  — nothing worth reporting
 *   { immune: true }                    — Golden Apple active, bar pinned full
 *   { starving, hpLost, stamLost }      — draining; plus warn/warnMessage when due
 *   { died: true, message }             — gentle starvation death happened
 */
export function applyHungerTick(player, now = Date.now()) {
  const h = ensureHunger(player, now)

  // Golden Apple: never hungry until death. Pin the bar full.
  if (h.immune) {
    h.current = h.max
    h.lastTick = now
    return { immune: true }
  }

  const elapsedMs = Math.max(0, now - h.lastTick)
  h.lastTick = now
  if (elapsedMs === 0) return {}

  const preCurrent = h.current
  h.current = Math.max(0, preCurrent - elapsedMs * DECAY_PER_MS)

  // Still fed → clear any leftover starvation debt and stop.
  if (h.current > 0) {
    h.hpDebt = 0
    h.stamDebt = 0
    return {}
  }

  // ── Starving ──────────────────────────────────────────────────────────
  // Only the slice of THIS window that fell after the bar actually hit empty
  // counts as starvation — otherwise a player returning after a long absence
  // (e.g. away 2h from a full bar) would eat the entire elapsed time as
  // starvation drain in one tick. `preCurrent` points of food buy
  // `preCurrent / DECAY_PER_MS` ms before the drain begins.
  const msToEmpty  = preCurrent / DECAY_PER_MS
  const starvingMs = Math.max(0, elapsedMs - msToEmpty)
  const minutes    = starvingMs / 60000

  // Stamina is the whole penalty, and it drains everywhere — mid-battle too
  // (stamina isn't tracked inside battleState, so there's nothing to desync).
  h.stamDebt += STARVE_STAM_PER_MIN * minutes
  const stamDrain = Math.floor(h.stamDebt)
  h.stamDebt -= stamDrain
  let stamLost = 0
  if (stamDrain > 0 && player.stamina && typeof player.stamina.current === 'number') {
    const before = player.stamina.current
    player.stamina.current = Math.max(0, before - stamDrain)
    stamLost = before - player.stamina.current
  }

  // HP is deliberately untouched: hunger can neither kill nor leave the player
  // on the edge of dying. Collapse — not death — is the floor.
  return {
    starving: true,
    hpLost: 0,
    stamLost,
    collapsed: isCollapsed(player),
    ...maybeWarn(h, now),
  }
}

/**
 * COLLAPSED = the bar is empty AND stamina has been drained to nothing. The
 * player can't take any action until they eat (handler.js gates on this).
 *
 * Read-only and cheap — safe to call from a gate on every command. Golden
 * Apple immunity can never be collapsed, since the bar is pinned full.
 */
export function isCollapsed(player) {
  const h = player?.hunger
  if (!h || h.immune) return false
  if ((h.current ?? 1) > 0) return false
  const stam = player?.stamina
  if (!stam || typeof stam.current !== 'number') return false
  return stam.current <= 0
}

/**
 * The lockout message shown to a collapsed player. Lives here next to the
 * rule it explains rather than in handler.js.
 */
export function collapseMessage(player) {
  const pr = config.prefix
  const stam = player?.stamina
  const stamLine = stam && typeof stam.current === 'number'
    ? `\n⚡ Stamina: *${Math.round(stam.current)}*/${Math.round(stam.max ?? 0)}`
    : ''
  return (
    `😵‍💫🍽️ *You've collapsed from hunger.*\n` +
    `_You haven't eaten in far too long. Your legs give out — you're too weak to do anything at all._${stamLine}\n\n` +
    `🍖 You did *not* die and you've lost *no* stats, levels or gear.\n` +
    `_Eat something and you're straight back up:_\n` +
    `*${pr}eat <food>*  ·  *${pr}cook* a dish  ·  *${pr}cookshop* for ingredients`
  )
}

/** Warn at most once per WARN_COOLDOWN_MS while starving. */
function maybeWarn(h, now) {
  if (h.lastWarnAt && now - h.lastWarnAt < WARN_COOLDOWN_MS) return {}
  h.lastWarnAt = now
  const pr = config.prefix
  return {
    warn: true,
    warnMessage:
      `🍽️ *You're starving!* Your hunger bar is empty.\n` +
      `Your *stamina* is draining fast — if it hits 0 you'll collapse and won't be able to do anything. ` +
      `_You won't die and you won't lose any stats._\n` +
      `*${pr}eat <food>* now, or buy ingredients at the *${pr}cookshop*.`,
  }
}

/**
 * Refill + clear immunity + wipe starvation debt. Called on ANY death (combat,
 * starvation) and on a full inn sleep, so a fresh life always starts fed.
 */
export function resetHunger(player, now = Date.now()) {
  const h = ensureHunger(player, now)
  h.current    = h.max
  h.immune     = false
  h.lastTick   = now
  h.hpDebt     = 0
  h.stamDebt   = 0
  h.lastWarnAt = null
  return h
}

/**
 * Eat: add `amount` hunger (clamped to max) and reset the decay clock so the
 * player doesn't immediately lose part of what they just ate. `opts.immune`
 * (Golden Apple) also flips on permanent immunity. `opts.now` overrides the
 * clock, matching every other function here — callers normally omit it.
 */
export function feed(player, amount, opts = {}) {
  const now = opts.now ?? Date.now()
  const h = ensureHunger(player, now)
  h.current    = Math.min(h.max, h.current + Math.max(0, Number(amount) || 0))
  h.lastTick   = now
  h.hpDebt     = 0
  h.stamDebt   = 0
  h.lastWarnAt = null
  if (opts.immune) h.immune = true
  return h.current
}

/**
 * 10-segment display bar, matching hpBar (lib/combat-engine.js) and the slot
 * bar in plugins/inventory.js. e.g. "🍖 Hunger: ▰▰▰▰▰▰▱▱▱▱ 63/100".
 */
export function hungerBar(player) {
  const h = ensureHunger(player)
  const cur = Math.round(h.current)
  const segments = 10
  const filled = h.max > 0 ? Math.round((cur / h.max) * segments) : 0
  const clamped = Math.max(0, Math.min(segments, filled))
  const bar = '▰'.repeat(clamped) + '▱'.repeat(segments - clamped)
  const tag = h.immune
    ? '  ✨ _immune_'
    : (isCollapsed(player) ? '  😵‍💫 _collapsed_' : (cur === 0 ? '  ⚠️ _starving_' : ''))
  return `🍖 Hunger: ${bar} ${cur}/${h.max}${tag}`
}
