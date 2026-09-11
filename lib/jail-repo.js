/**
 * jail-repo.js — timed full-lockout punishment, stored independently of the
 * player record (db.data.jail, keyed by JID) so that:
 *   - a jail sentence survives .admin resetplayer (which wipes db.data.users[id])
 *   - a player can be jailed even if they've never registered
 *   - release always works even if the player record is gone
 *
 * Record shape: { jailedAt: number, releaseAt: number, crime: string|null, reason: string|null }
 *
 * Design mirrors lib/ban-repo.js exactly, but with a time-based expiry instead
 * of a permanent flag. isJailed() returns false once releaseAt has passed, so
 * the handler never needs to explicitly clear records — they self-expire. The
 * releasePlayer() function is still provided for early release (admin pardon,
 * future .bail command) and to clean up expired records on first post-release
 * command.
 *
 * jailPlayer(db, id, durationMs, crime, reason) is intentionally generic —
 * any plugin can call it. rob.js is the first caller, but pvp griefing, repeat
 * heist failures, admin .jail overrides, etc. can all use the same function
 * without touching the storage layer.
 */

/** Returns the raw jail record for `id`, or null if none exists. */
export function getJailRecord(db, id) {
  return db.data.jail?.[id] ?? null
}

/**
 * True only if `id` is currently jailed AND the sentence has not yet expired.
 * Returns false for missing records AND for expired (past releaseAt) records.
 */
export function isJailed(db, id) {
  const rec = getJailRecord(db, id)
  return !!rec && Date.now() < rec.releaseAt
}

/**
 * Jail `id` for `durationMs` milliseconds.
 *
 * @param {object} db          — lowdb instance
 * @param {string} id          — JID of the player to jail
 * @param {number} durationMs  — sentence length in milliseconds
 * @param {string|null} crime  — short label shown in the lockout message (e.g. 'robbery')
 * @param {string|null} reason — optional longer note (for admin overrides)
 */
export async function jailPlayer(db, id, durationMs, crime = null, reason = null) {
  if (!db.data.jail) db.data.jail = {}
  const now = Date.now()
  db.data.jail[id] = { jailedAt: now, releaseAt: now + durationMs, crime, reason }
  await db.write()
  return db.data.jail[id]
}

/**
 * Release `id` immediately — used for early release (admin pardon, future
 * .bail command) and to clean up expired records after they self-expire.
 * Returns true if a record existed and was removed, false if already clear.
 */
export async function releasePlayer(db, id) {
  if (!db.data.jail?.[id]) return false
  delete db.data.jail[id]
  await db.write()
  return true
}
