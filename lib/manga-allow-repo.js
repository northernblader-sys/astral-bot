/**
 * manga-allow-repo.js — allowlist of users (besides the bot owner) permitted
 * to use the manga/manhwa downloader tools (.pill*, .manhwa*, .dload),
 * stored independently of the player record (db.data.mangaAllowed, keyed by
 * JID) so it survives .admin resetplayer and works even for unregistered
 * users. Managed exclusively via .allow / .disallow (owner-only — see
 * plugins/allow.js).
 *
 * Record shape: { allowedAt: number, allowedBy: string (JID) }
 */

/** Returns the allow record for `id`, or null if not allowed. */
export function getMangaAllow(db, id) {
  return db.data.mangaAllowed?.[id] ?? null
}

/** True if `id` has been granted manga/manhwa tool access. */
export function isMangaAllowed(db, id) {
  return !!getMangaAllow(db, id)
}

/** Grants `id` access. Overwrites any existing record (re-allowing refreshes it). */
export async function allowManga(db, id, allowedBy) {
  if (!db.data.mangaAllowed) db.data.mangaAllowed = {}
  db.data.mangaAllowed[id] = { allowedAt: Date.now(), allowedBy }
  await db.write()
  return db.data.mangaAllowed[id]
}

/** Revokes `id`'s access. Returns true if a record existed and was removed. */
export async function disallowManga(db, id) {
  if (!db.data.mangaAllowed?.[id]) return false
  delete db.data.mangaAllowed[id]
  await db.write()
  return true
}

/** Returns all currently-allowed JIDs. */
export function listMangaAllowed(db) {
  return Object.keys(db.data.mangaAllowed ?? {})
}
