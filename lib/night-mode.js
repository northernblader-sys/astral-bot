/**
 * night-mode.js — bot-wide "closed for the night" switch.
 *
 * While night mode is ON:
 *   • every command from everyone except the bot owner and bot mods
 *     (lib/mod-repo.js) is refused at the handler.js lockout chokepoint, with
 *     a "go to sleep, back tomorrow" notice; and
 *   • the hourly/2-hourly auto-spawn sweeps in main.js (cards, series,
 *     Pokémon) skip their runs entirely, so nobody wakes up to a wall of
 *     unclaimed spawns. They resume on their normal cadence the moment it's
 *     switched off — nothing is queued up or replayed.
 *
 * Toggled with `.night on` / `.night off` (plugins/night.js).
 *
 * STORAGE — deliberately NOT db.data.*, unlike mod-repo.js/ban-repo.js: the
 * main.js spawn sweeps are module-level functions that only receive the socket
 * instances, not a db handle, so a db-backed flag couldn't be read from there
 * without threading db through three sweep signatures. Instead this is a
 * standalone data/night-mode.json (the same pattern as
 * lib/card-spawn-groups.js), with the on/off flag ALSO cached in memory so
 * isNightMode() is synchronous and free to call on every single message.
 *
 * The file is read once, synchronously, at import. main.js and handler.js run
 * in the same process, so they share this module instance and therefore this
 * cache — a toggle is visible to both immediately, and the file only exists so
 * the setting survives a restart.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const STATE_PATH = fileURLToPath(new URL('../data/night-mode.json', import.meta.url))

const DEFAULT_STATE = { on: false, since: null, by: null }

/** In-memory cache — the source of truth at runtime; the file is just durability. */
let state = loadInitial()

function loadInitial() {
  try {
    if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE }
    const raw = readFileSync(STATE_PATH, 'utf8')
    if (!raw.trim()) return { ...DEFAULT_STATE }
    const parsed = JSON.parse(raw)
    return {
      on:    parsed.on === true,
      since: typeof parsed.since === 'number' ? parsed.since : null,
      by:    typeof parsed.by === 'string' ? parsed.by : null,
    }
  } catch {
    // A corrupt/unreadable state file must never take the bot down, and
    // failing OPEN (not locked) is the safe direction: worst case the owner
    // re-runs `.night on`.
    return { ...DEFAULT_STATE }
  }
}

function persist() {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8')
    return true
  } catch {
    // In-memory state still applies for this process even if the write failed.
    return false
  }
}

/** Synchronous, allocation-free hot path — safe to call on every message. */
export function isNightMode() {
  return state.on === true
}

/** Full state: { on, since, by } — `since` is an epoch ms, `by` a JID. */
export function getNightState() {
  return { ...state }
}

/**
 * Turn night mode on/off. Returns { changed, state } — `changed` is false if
 * it was already in the requested position, so the caller can say
 * "already on" instead of pretending it did something.
 *
 * On an OFF transition, every listener registered via onNightModeOff() fires
 * synchronously, AFTER state is flipped and persisted — see that function's
 * doc for why this exists.
 */
export function setNightMode(on, byJid = null) {
  const want = on === true
  if (state.on === want) return { changed: false, state: { ...state } }

  const wasOn = state.on

  state = {
    on:    want,
    since: want ? Date.now() : null,
    by:    want ? byJid : null,
  }
  // Clear the notice throttle so the very first person to type a command after
  // a toggle always gets told, rather than being silently dropped because they
  // happened to be notified during a previous night.
  notifiedAt.clear()
  persist()

  if (wasOn && !want) {
    for (const fn of wakeListeners) {
      try { fn() } catch { /* a broken listener must never break the toggle itself */ }
    }
  }

  return { changed: true, state: { ...state } }
}

// ── Wake listeners ───────────────────────────────────────────────────────
// The auto-spawn setInterval timers in main.js run on a fixed clock from
// process boot — they don't know or care when night mode ends, so up to a
// full interval (an hour, for cards) can pass with zero spawns after
// `.night off`, and a restart while night mode was on can leave the bot
// silently "asleep" with no error at all (see main.js's night-mode-aware
// wrapper for the restart case). Rather than have night-mode.js import
// main.js's sweep functions directly (a lib reaching into the app's
// scheduling, and a circular import risk since main.js already imports
// this file), main.js registers itself here instead: it hands over a
// zero-arg callback once at startup, and this module calls it the instant
// night mode flips off. night.js (the plugin) never needs to know any of
// this exists — it just calls setNightMode() exactly as before.
const wakeListeners = []

/**
 * Registers a callback to run the instant night mode transitions ON -> OFF,
 * whether that happens via `.night off` or by any future caller of
 * setNightMode(false, ...). Multiple listeners are supported (main.js
 * currently registers one that re-fires all three spawn sweeps immediately
 * and resets their intervals — see main.js) but nothing here assumes only
 * one. A listener throwing never stops the others or breaks the toggle.
 */
export function onNightModeOff(fn) {
  if (typeof fn === 'function') wakeListeners.push(fn)
}

// ── Notice throttle ────────────────────────────────────────────────────────
// Without this, a group of 50 people spamming commands overnight would each
// get a reply per command — the bot would be louder asleep than awake. Each
// JID is told once, then silently ignored for the cooldown window.
const NOTICE_COOLDOWN_MS = 30 * 60 * 1000
const notifiedAt = new Map()

/**
 * True if this JID should be sent the "we're closed" notice now. Records the
 * send as a side effect, so call it exactly once per blocked command.
 */
export function shouldNotifyNight(jid, now = Date.now()) {
  const last = notifiedAt.get(jid)
  if (last && now - last < NOTICE_COOLDOWN_MS) return false
  notifiedAt.set(jid, now)
  return true
}

/** The player-facing "bot is asleep" notice. */
export function nightNotice(prefix = '.') {
  return (
    `🌙💤 *It's night time — the bot is asleep.*\n\n` +
    `_The Astral Realm is closed for the night. Go get some rest — ` +
    `the bot will be back online later tomorrow._\n\n` +
    `✅ Everything is saved exactly where you left it. ` +
    `Your hunger, cooldowns and battles will all be waiting.\n` +
    `🌅 _See you in the morning._`
  ).replace(/\{prefix\}/g, prefix)
}
