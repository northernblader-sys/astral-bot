/**
 * Platform-aware permission checks.
 *
 * The game's admin gate (`isGroupOrBotOwner` in lib/group-settings.js) was
 * written against exactly one platform: it called `ctx.sock.groupMetadata()`
 * and treated any throw as "not an admin". On Discord and Telegram `ctx.sock`
 * doesn't exist, so that call threw, the catch swallowed it, and the gate
 * returned false for everyone — permanently denying all ~30 admin-gated
 * commands (.waifu on, .pvp setup, .series, .dungeon, .tourney, .poll …) with
 * "Only group admins or the bot owner can use this".
 *
 * Rather than teach the shared lib about discord.js and grammy, adapters
 * install a `ctx.isChatAdmin()` hook that answers the question natively. This
 * module only dispatches, so lib/ stays free of platform SDK imports.
 */

import { isOwnerJid, getGroupMetadata } from '../group-helpers.js'
import { config } from '../../config.js'
import { platformOf, toNativeId } from './identity.js'

/**
 * Owner check that works for every platform.
 *
 * isOwnerJid() alone can't do this: it strips `@...` then splits on `:` to
 * drop WhatsApp's device suffix, so the player id `dc:123456789` reduces to
 * the literal string `dc` — which never matches an owner number. The Discord
 * and Telegram owners were therefore invisible to their own bot.
 */
export function isPlatformOwner(playerId) {
  if (!playerId) return false

  const platform = platformOf(playerId)
  if (platform === 'whatsapp') return isOwnerJid(playerId)

  const native = String(toNativeId(playerId))
  const owners = platform === 'discord'
    ? config.discordOwnerIds
    : config.telegramOwnerIds

  return (owners ?? []).some(id => String(id).trim() === native)
}

/**
 * True when ctx.from may run group-management commands in the current chat.
 *
 * Either credential is sufficient — bot owner, or admin of this chat.
 * Outside a group (a DM / private chat) there is no admin concept, so only
 * the owner passes, matching the original WhatsApp behaviour.
 */
export async function resolveChatAdmin(ctx) {
  if (isPlatformOwner(ctx.from)) return true
  if (!ctx.isGroup) return false

  // Discord / Telegram: adapter-supplied native check.
  if (typeof ctx.isChatAdmin === 'function') {
    try {
      return Boolean(await ctx.isChatAdmin())
    } catch {
      // A failed permission lookup must not grant access.
      return false
    }
  }

  // WhatsApp: the original path, now behind the shared metadata cache so an
  // admin-gated command in a busy group isn't a fresh rate-limited round trip
  // every time. Same result, same fail-closed catch.
  if (!ctx.sock?.groupMetadata) return false
  try {
    const meta = await getGroupMetadata(ctx.sock, ctx.sender)
    const me = meta.participants.find(p => p.id === ctx.from)
    return me?.admin === 'admin' || me?.admin === 'superadmin'
  } catch {
    return false
  }
}
