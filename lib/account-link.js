/**
 * account-link.js — binds a Discord/Telegram account to an existing Astral
 * character so one person has ONE character everywhere.
 *
 * The problem this solves: player records are keyed by WhatsApp JID, and the
 * adapters mint `dc:<id>` / `tg:<id>` ids (see lib/platform/identity.js). Left
 * alone, the same human gets three unrelated characters. A link makes the
 * platform id an *alias* of the WhatsApp id.
 *
 * Stored at db.data.accountLinks as:
 *   { 'dc:123456789': { masterId: '2347...@s.whatsapp.net', at, platform } }
 *
 * The alias is resolved once, in each adapter's buildContext(), so every one
 * of the ~150 game plugins reads the linked character with no change to any
 * of them. Nothing else in the codebase needs to know links exist.
 *
 * CONCURRENCY: accountLinks is not db.data.users, so updatePlayer() can't be
 * used. Mutations go through updateAllPlayers()'s mutator — the same shared
 * write queue every other db mutation uses. This mirrors notification-repo.js.
 *
 * DELIVERY: the verification code is pushed to the player's site notification
 * bell (lib/notification-repo.js), NOT DM'd. That's deliberate — proving you
 * can read that account's notifications on playastral is what proves the
 * account is yours, and it needs no WhatsApp socket, so it works from a
 * Discord-only or Telegram-only process.
 */
import { updateAllPlayers } from './player-repo.js'
import { platformOf } from './platform/identity.js'

function ensureStore(db) {
  if (!db.data.accountLinks || typeof db.data.accountLinks !== 'object') {
    db.data.accountLinks = {}
  }
  return db.data.accountLinks
}

/**
 * A WhatsApp id is a JID and always contains '@'; platform ids never do.
 * Used to tell a master id from an alias without consulting the store.
 */
export function isMasterId(id) {
  return String(id ?? '').includes('@')
}

/**
 * The character id `platformId` should act as. Returns `platformId` itself
 * when there's no link, so this is safe to call unconditionally.
 *
 * Never throws — a corrupt store must not take the bot down on every message.
 */
export function resolveLinkedId(db, platformId) {
  const raw = String(platformId ?? '')
  if (!raw || isMasterId(raw)) return raw
  const entry = db?.data?.accountLinks?.[raw]
  const masterId = entry?.masterId
  return typeof masterId === 'string' && masterId ? masterId : raw
}

/** The link record for a platform id, or null. */
export function getLink(db, platformId) {
  return db?.data?.accountLinks?.[String(platformId ?? '')] ?? null
}

/**
 * Every platform id currently pointing at `masterId`, as
 * [{ platformId, platform, at }] — powers `.connect status`.
 */
export function listLinksFor(db, masterId) {
  const store = db?.data?.accountLinks
  if (!store || !masterId) return []
  return Object.entries(store)
    .filter(([, v]) => v?.masterId === masterId)
    .map(([platformId, v]) => ({
      platformId,
      platform: v?.platform ?? platformOf(platformId),
      at: v?.at ?? 0,
    }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

/**
 * Case-insensitive username lookup across registered players. Returns the
 * player record or null.
 *
 * Only ever matches a master (WhatsApp) record. Matching an aliased record
 * would let someone link a Discord account to another Discord account and
 * build a chain that resolveLinkedId() — deliberately single-hop — can't
 * follow.
 */
export function findPlayerByUsername(db, username) {
  const wanted = String(username ?? '').trim().toLowerCase().replace(/^@/, '')
  if (!wanted) return null
  const users = db?.data?.users ?? {}
  for (const player of Object.values(users)) {
    if (!player?.username) continue
    if (String(player.username).toLowerCase() !== wanted) continue
    if (!isMasterId(player.id)) continue
    return player
  }
  return null
}

/**
 * True when this db holds no WhatsApp characters at all, which means the
 * process was started in separate-roster mode (`npm run start:discord`
 * against db-discord.json). Linking is impossible there — the account being
 * linked to lives in a different file — so callers explain that rather than
 * reporting a bogus "no such username".
 */
export function isSeparateRoster(db) {
  const users = db?.data?.users ?? {}
  for (const id of Object.keys(users)) {
    if (isMasterId(id)) return false
  }
  return true
}

/**
 * Points `platformId` at `masterId`. Overwrites any existing link for that
 * platform id — re-linking to a different character is a legitimate action
 * and is gated by the OTP, not by this function.
 */
export async function linkAccount(db, platformId, masterId) {
  const alias = String(platformId ?? '')
  if (!alias || isMasterId(alias)) throw new Error(`account-link: "${alias}" is not a platform id`)
  if (!isMasterId(String(masterId ?? ''))) throw new Error('account-link: masterId must be a WhatsApp id')

  const entry = { masterId, platform: platformOf(alias), at: Date.now() }
  await updateAllPlayers(db, () => {
    ensureStore(db)[alias] = entry
    return true
  })
  return entry
}

/** Removes the link for `platformId`. Returns the removed record, or null. */
export async function unlinkAccount(db, platformId) {
  const alias = String(platformId ?? '')
  let removed = null
  await updateAllPlayers(db, () => {
    const store = ensureStore(db)
    if (!store[alias]) return false
    removed = store[alias]
    delete store[alias]
    return true
  })
  return removed
}
