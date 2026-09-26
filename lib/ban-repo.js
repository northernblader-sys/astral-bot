/**
 * ban-repo.js — account-level bans, stored independently of the player
 * record (db.data.bans, keyed by JID) so that:
 *   - a ban survives .admin resetplayer (which wipes db.data.users[id])
 *   - a user can be banned even if they've never registered
 *   - unban always works even if the player record is gone
 *
 * Record shape:
 *   {
 *     bannedAt:  number,          // epoch ms
 *     bannedBy:  string|null,     // JID of the banner, or null for a system ban
 *     reason:    string|null,
 *     expiresAt: number|null,     // epoch ms; null = permanent (a manual .ban)
 *     auto:      boolean,         // true = system auto-ban (e.g. antispam rate-limit)
 *   }
 *
 * A timed ban (expiresAt set) self-expires exactly like a jail sentence
 * (see lib/jail-repo.js): isBanned() returns false once expiresAt passes, and
 * the handler cleans up the stale record on the first command after expiry.
 * `auto` marks a system-issued ban so the unban command can restrict who may
 * lift it early (antispam bans are owner/mod-only — see plugins/unban.js).
 */

/**
 * Returns the raw ban record for `id`, or null if none is stored.
 *
 * Note: this returns an EXPIRED timed ban's record too (it only checks for
 * existence), so callers that care about "is this ban still in force" should
 * use isBanned() or check banExpired() — the handler does this to auto-clean
 * served timed bans, mirroring how jail-repo's handler path works.
 */
export function getBan(db, id) {
  return db.data.bans?.[id] ?? null
}

/** True when a ban record represents a timed ban whose time is up. */
export function banExpired(rec) {
  return !!rec && rec.expiresAt != null && Date.now() >= rec.expiresAt
}

/** True if `id` is currently banned AND (for timed bans) not yet expired. */
export function isBanned(db, id) {
  const rec = getBan(db, id)
  return !!rec && !banExpired(rec)
}

/**
 * Bans `id`. Overwrites any existing ban record (re-banning refreshes it).
 *
 * @param {object}      db
 * @param {string}      id        — JID to ban
 * @param {string|null} bannedBy  — JID of the banner, or null for a system ban
 * @param {string|null} reason
 * @param {object}      [opts]
 * @param {number|null} [opts.expiresAt] — epoch ms; omit/null for a permanent ban
 * @param {boolean}     [opts.auto]      — mark as a system auto-ban (owner/mod-only unban)
 */
export async function banUser(db, id, bannedBy, reason = null, opts = {}) {
  if (!db.data.bans) db.data.bans = {}
  const { expiresAt = null, auto = false } = opts
  db.data.bans[id] = { bannedAt: Date.now(), bannedBy, reason, expiresAt, auto }
  await db.write()
  return db.data.bans[id]
}

/** Unbans `id`. Returns true if a ban existed and was removed, false if they weren't banned. */
export async function unbanUser(db, id) {
  if (!db.data.bans?.[id]) return false
  delete db.data.bans[id]
  await db.write()
  return true
}
