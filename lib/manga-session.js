/**
 * lib/manga-session.js — in-memory session store for manga/manhwa searches.
 *
 * Keyed by sender JID (ctx.from). Stores the last search result so that
 * .dload can reference it without the user having to re-search or paste IDs.
 *
 * Sessions are intentionally not persisted to db.json — they're ephemeral
 * lookup caches that expire when the process restarts. Nobody needs their
 * last manga search to survive a bot reboot.
 */

/**
 * @typedef {Object} MangaSession
 * @property {'manga'|'manhwa'} type
 * @property {string} title
 * @property {string} mangaId
 * @property {any}    provider      — live consumet provider instance
 * @property {string} providerName
 * @property {string|null} image
 * @property {string|null} description
 * @property {Array}  chapters      — full chapters list from fetchMangaInfo
 */

/** @type {Map<string, MangaSession>} */
const sessions = new Map()

/** Store a session for a sender. */
export function setMangaSession(senderJid, data) {
  sessions.set(senderJid, data)
}

/** Retrieve the session for a sender, or null if none. */
export function getMangaSession(senderJid) {
  return sessions.get(senderJid) ?? null
}

/** Clear the session for a sender. */
export function clearMangaSession(senderJid) {
  sessions.delete(senderJid)
}
