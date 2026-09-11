/**
 * rename-rules.js — the single definition of "can this player change their
 * name, and to what".
 *
 * Two front ends need this: plugins/rename.js (chat) and PATCH /api/me on the
 * website. They were separate implementations of the same 7-day cooldown and
 * the same character rules, which is exactly the kind of pair that drifts —
 * one gets a fix, the other doesn't, and a name the bot rejects becomes a name
 * the site accepts. Both now call renamePlayer() and only differ in how they
 * phrase the result.
 *
 * The cooldown is tracked on player.lastRenameAt (epoch ms), same field and
 * same meaning as before, so existing cooldowns carry over untouched.
 */
import { updatePlayer } from './player-repo.js'

export const RENAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // 1 week
export const RENAME_COOLDOWN_DAYS = 7
export const MIN_LENGTH = 2
export const MAX_LENGTH = 20

/** Letters, numbers, spaces, and a small set of common name punctuation. */
export const VALID_NAME = /^[\p{L}\p{N} _.'-]+$/u

/** "1 day 4h" / "6 hours" — how long until the next rename unlocks. */
export function formatRemaining(ms) {
  const totalHours = Math.ceil(ms / (60 * 60 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}${hours > 0 ? ` ${hours}h` : ''}`
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/** When this player may next rename, or null if they never have. */
export function nextRenameAt(player) {
  const last = player?.lastRenameAt ?? 0
  return last ? last + RENAME_COOLDOWN_MS : null
}

/** True when the cooldown has elapsed (or was never started). */
export function canRename(player, now = Date.now()) {
  const next = nextRenameAt(player)
  return !next || now >= next
}

/**
 * Shape-checks a candidate name without touching the db. Returns null when
 * it's fine, or a reason string. Callers phrase their own error around it —
 * chat wants bold markers, the API wants plain JSON.
 */
export function validateName(name) {
  const value = String(name ?? '').trim()
  if (!value) return 'empty'
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) return 'length'
  if (!VALID_NAME.test(value)) return 'charset'
  return null
}

/**
 * Applies a rename inside the db write queue, enforcing the cooldown against
 * the record as it exists at write time — not against a copy read earlier, so
 * two requests racing can't both pass the check.
 *
 * Resolves to one of:
 *   { ok: true,  oldName, newName, nextAllowedAt }
 *   { ok: false, reason: 'cooldown', remainingMs, nextAllowedAt }
 *   { ok: false, reason: 'same' | 'empty' | 'length' | 'charset' }
 */
export async function renamePlayer(db, playerId, name) {
  const newName = String(name ?? '').trim()

  const invalid = validateName(newName)
  if (invalid) return { ok: false, reason: invalid }

  let outcome = null

  await updatePlayer(db, playerId, (player) => {
    const now = Date.now()
    const last = player.lastRenameAt ?? 0
    const nextAllowedAt = last + RENAME_COOLDOWN_MS

    if (last && now - last < RENAME_COOLDOWN_MS) {
      outcome = {
        ok: false,
        reason: 'cooldown',
        remainingMs: nextAllowedAt - now,
        nextAllowedAt,
      }
      return player
    }

    if (newName === player.name) {
      outcome = { ok: false, reason: 'same' }
      return player
    }

    const oldName = player.name
    player.name = newName
    player.lastRenameAt = now
    outcome = { ok: true, oldName, newName, nextAllowedAt: now + RENAME_COOLDOWN_MS }
    return player
  })

  return outcome
}
