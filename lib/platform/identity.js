/**
 * identity.js — one player id scheme across WhatsApp, Discord and Telegram.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Player records are keyed by `ctx.from`, which on WhatsApp is a raw JID like
 * `2347062301848@s.whatsapp.net`. Discord hands us a snowflake (`483920...`)
 * and Telegram a plain integer (`847362...`). Left alone, a Telegram user
 * whose numeric id happened to collide with a WhatsApp number's digits would
 * inherit that player's inventory. So every id gets namespaced by platform.
 *
 * ── The one rule that protects live data ──────────────────────────────────
 * WhatsApp ids are deliberately NOT rewritten. `whatsapp` has `idPrefix: ''`,
 * so toPlayerId('whatsapp', jid) returns the jid unchanged, byte for byte.
 * Every existing row in db.json keeps working with no migration, no backfill,
 * and no risk of orphaning someone's account. Discord becomes `dc:483920...`
 * and Telegram `tg:847362...`, which cannot collide with a JID (those always
 * contain `@`) or with each other.
 *
 * If you ever *do* want to renamespace WhatsApp to `wa:`, that is a real data
 * migration over db.json — not a change to this constant.
 */

import { getPlatform } from './capabilities.js'

/**
 * Build the canonical player id for a raw platform-native user id.
 *
 * @param {string} platformId  'whatsapp' | 'discord' | 'telegram'
 * @param {string} nativeId    JID, snowflake, or Telegram user id
 * @returns {string}           storage key for lib/player-repo.js
 */
export function toPlayerId(platformId, nativeId) {
  const { idPrefix } = getPlatform(platformId)
  const raw = String(nativeId ?? '').trim()
  if (!raw) throw new Error(`toPlayerId: empty nativeId for platform '${platformId}'`)

  // WhatsApp: pass through untouched — see the note above.
  if (!idPrefix) return raw

  // Already namespaced (e.g. re-wrapping a stored id) — don't double-prefix.
  if (raw.startsWith(`${idPrefix}:`)) return raw

  return `${idPrefix}:${raw}`
}

/**
 * Inverse of toPlayerId — recover the platform-native id, which is what the
 * adapters need when they actually call the API (mentioning a user, kicking
 * them, opening a DM).
 */
export function toNativeId(playerId) {
  const raw = String(playerId ?? '')
  const match = raw.match(/^([a-z]{2}):(.+)$/)
  return match ? match[2] : raw
}

/**
 * Which platform a stored player id belongs to.
 * Unprefixed ids are WhatsApp by definition (the legacy format).
 */
export function platformOf(playerId) {
  const raw = String(playerId ?? '')
  const match = raw.match(/^([a-z]{2}):/)
  if (!match) return 'whatsapp'
  return match[1] === 'dc' ? 'discord'
    : match[1] === 'tg' ? 'telegram'
    : 'whatsapp'
}

/**
 * Human-readable short form for logs and error messages — never for storage.
 * `dc:483920571...` → `discord:4839205…`
 */
export function describeId(playerId) {
  const native = toNativeId(playerId)
  const bare = native.replace(/@.*$/, '').split(':')[0]
  const shown = bare.length > 8 ? `${bare.slice(0, 7)}…` : bare
  return `${platformOf(playerId)}:${shown}`
}
