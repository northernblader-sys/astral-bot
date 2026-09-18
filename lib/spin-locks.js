/**
 * spin-locks.js — owner-controlled "this spin is frozen" switch, per character.
 *
 * The bot owner can freeze any character's spin with `.lockspin <character>`
 * (plugins/lockspin.js). While a character is locked, EVERY spin plugin refuses
 * to run for everyone (owner included, on purpose — a lock is a lock), until the
 * owner runs `.unlockspin <character>`. The point is staged reveals: a new
 * character can ship with its spin plugin live but frozen, so nobody can pull it
 * until the owner flips it open.
 *
 * WHY A STANDALONE FILE, NOT db.data.* — the spin plugins call the gate on their
 * hot path, and want a synchronous, allocation-free "is this locked" check that
 * does not depend on a db handle being threaded in. Same reasoning and same
 * shape as lib/night-mode.js: a standalone data/spin-locks.json whose contents
 * are ALSO cached in memory, read once synchronously at import, and re-cached on
 * every write. handler.js and every plugin share this one module instance in the
 * same process, so a `.lockspin`/`.unlockspin` toggle is visible everywhere the
 * moment it happens; the file only exists so the setting survives a restart.
 *
 * STATE SHAPE — a plain object keyed by character id:
 *   { "gojo": { at: <epoch ms>, by: "<owner jid>" }, ... }
 * Presence of a key means locked. There is no per-key "on" flag; unlocking
 * deletes the key. Character ids are lowercased on the way in so lookups are
 * case-insensitive against characterMap ids.
 */
import { runtimePath } from './runtime-paths.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { characterMap } from './game-data.js'

const STATE_PATH = runtimePath('spin-locks.json')

/** In-memory cache — the source of truth at runtime; the file is just durability. */
let locks = loadInitial()

function loadInitial() {
  try {
    if (!existsSync(STATE_PATH)) return {}
    const raw = readFileSync(STATE_PATH, 'utf8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Normalise: keep only well-formed entries, lowercase the keys.
    const clean = {}
    for (const [id, rec] of Object.entries(parsed)) {
      if (!id) continue
      const key = String(id).toLowerCase()
      clean[key] = {
        at: typeof rec?.at === 'number' ? rec.at : null,
        by: typeof rec?.by === 'string' ? rec.by : null,
      }
    }
    return clean
  } catch {
    // A corrupt/unreadable lock file must never take the bot down, and failing
    // OPEN (nothing locked) is the safe direction: worst case the owner re-runs
    // `.lockspin`. This matches lib/night-mode.js's fail-open stance.
    return {}
  }
}

function persist() {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(locks, null, 2) + '\n', 'utf8')
    return true
  } catch {
    // In-memory state still applies for this process even if the write failed.
    return false
  }
}

/** Synchronous, allocation-free hot path — safe to call on every spin attempt. */
export function isSpinLocked(characterId) {
  if (!characterId) return false
  return Object.prototype.hasOwnProperty.call(locks, String(characterId).toLowerCase())
}

/** Full lock record { at, by } for a character, or null if it is not locked. */
export function getSpinLock(characterId) {
  if (!characterId) return null
  const rec = locks[String(characterId).toLowerCase()]
  return rec ? { ...rec } : null
}

/** Every currently locked character as [{ id, at, by }], for `.lockspin` with no args. */
export function listSpinLocks() {
  return Object.entries(locks).map(([id, rec]) => ({ id, at: rec.at, by: rec.by }))
}

/**
 * Freeze a character's spin. Returns { changed } — false if it was already
 * locked, so the caller can say "already locked" instead of re-stamping it.
 */
export function lockSpin(characterId, byJid = null) {
  if (!characterId) return { changed: false }
  const key = String(characterId).toLowerCase()
  if (Object.prototype.hasOwnProperty.call(locks, key)) return { changed: false }
  locks[key] = { at: Date.now(), by: typeof byJid === 'string' ? byJid : null }
  persist()
  return { changed: true }
}

/**
 * Unfreeze a character's spin. Returns { changed } — false if it was not locked
 * to begin with.
 */
export function unlockSpin(characterId) {
  if (!characterId) return { changed: false }
  const key = String(characterId).toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(locks, key)) return { changed: false }
  delete locks[key]
  persist()
  return { changed: true }
}

/**
 * Pretty name for a character id, for the refusal copy. Falls back to the raw
 * id so a lock placed on something not in data/characters.json still explains
 * itself instead of rendering blank.
 */
export function spinLockDisplayName(characterId) {
  if (!characterId) return null
  const key = String(characterId).toLowerCase()
  const def = characterMap[key]
  return def?.name || characterId
}

/**
 * spinLockGate(ctx, characterId, displayName) — the one line every spin plugin
 * runs before letting a pull through. If the character is locked it sends the
 * refusal reply and returns TRUE (meaning: stop, the spin is frozen). If it is
 * open it returns FALSE and the plugin proceeds as normal.
 *
 * `displayName` is optional: left off, the name is looked up from characterMap,
 * which is why the call in each *-spin.js is a single argument. Pass one only
 * for a character that is not in data/characters.json.
 *
 * Kept here rather than duplicated in each *-spin.js so the refusal copy stays
 * identical everywhere and a future change is one edit. Call it BEFORE any gems
 * are deducted: a locked spin must cost nothing.
 */
export function spinLockGate(ctx, characterId, displayName) {
  if (!isSpinLocked(characterId)) return false
  const who = displayName || spinLockDisplayName(characterId) || 'This character'
  ctx.reply(
    `🔒 *${who}'s spin is locked.*\n\n` +
    `_This banner is closed right now. Nobody can pull ${who} until the owner opens it back up._\n` +
    `⏳ Hang tight, it will go live soon.`,
  )
  return true
}
