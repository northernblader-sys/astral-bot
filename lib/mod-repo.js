/**
 * mod-repo.js — bot-level "mod" role, stored independently of the player
 * record (db.data.mods, a flat array of JIDs). Mirrors ban-repo.js's
 * storage pattern (flat db.data.* field, direct db.write()).
 *
 * A mod is global: once granted, the same JID is a mod in every group the
 * bot is in — not scoped to a single group. Only the bot owner can grant
 * or revoke it (see plugins/mod.js / plugins/unmod.js). A mod is NOT the
 * bot owner and NOT necessarily a WhatsApp group admin — this is a
 * separate bot-level role that grants exactly the permission set wired up
 * in lib/group-settings.js's isGroupOrBotOwnerOrMod(): ban/unban plus the
 * classic group-management commands (kick, add, antilink, welcome/goodbye
 * toggles + text). Anything else gated by isGroupOrBotOwner() alone
 * (game-feature toggles like .pvp on, .waifu on, etc.) is deliberately left
 * untouched.
 */

/** Returns the full array of mod JIDs (empty array if none). */
export function getMods(db) {
  return db.data.mods ?? []
}

/** True if `jid` is currently a mod. */
export function isMod(db, jid) {
  return getMods(db).includes(jid)
}

/** Adds `jid` as a mod. Returns false if they already were one. */
export async function addMod(db, jid) {
  if (!db.data.mods) db.data.mods = []

  if (db.data.mods.includes(jid)) return false

  db.data.mods.push(jid)
  await db.write()
  return true
}

/** Removes `jid` as a mod. Returns false if they weren't one. */
export async function removeMod(db, jid) {
  const list = db.data.mods
  if (!list || !list.includes(jid)) return false

  db.data.mods = list.filter(id => id !== jid)
  await db.write()
  return true
}
