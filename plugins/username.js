/**
 * username.js — Reserve a unique username tied to your account.
 *
 * Commands:
 *   .username                  — show your current username
 *   .username add <name>       — reserve / change your username
 *   .username remove           — clear your username
 *
 * Rules:
 *   • 3–20 characters, letters / numbers / underscores only.
 *   • Case-insensitive uniqueness — "Ash" and "ash" cannot coexist.
 *   • Once another player holds a username you can't take it; yours
 *     is yours until you remove it.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'

const MIN_LEN = 3
const MAX_LEN = 20
const VALID_RE = /^[a-zA-Z0-9_]+$/

export default {
  name: 'username',
  aliases: ['uname'],
  category: 'account',
  requiresPlayer: true,
  description: 'Reserve a unique username connected to your account',

  async run(ctx) {
    const { args, reply, player, db } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── .username ── show current ──────────────────────────────────────────
    if (!sub) {
      if (!player.username) {
        return reply(
          `🏷️ *Username*\n\n` +
          `You haven't reserved a username yet.\n\n` +
          `*${pr}username add <name>*\n` +
          `_3–20 chars • letters, numbers & underscores only • unique_`,
        )
      }
      return reply(`🏷️ *Your username:* @${player.username}`)
    }

    // ── .username add <name> ───────────────────────────────────────────────
    if (sub === 'add' || sub === 'set') {
      const desired = args[1]?.trim() ?? ''
      if (!desired) {
        return reply(`❓ Usage: *${pr}username add <name>*\n\nExample: *${pr}username add AshKetchum*`)
      }
      if (desired.length < MIN_LEN) {
        return reply(`❌ Username must be at least ${MIN_LEN} characters long.`)
      }
      if (desired.length > MAX_LEN) {
        return reply(`❌ Username must be ${MAX_LEN} characters or fewer.`)
      }
      if (!VALID_RE.test(desired)) {
        return reply(`❌ Username can only contain letters, numbers, and underscores ( _ ).`)
      }
      if (player.username?.toLowerCase() === desired.toLowerCase()) {
        return reply(`⚠️ You already have this username: *@${player.username}*`)
      }

      // Uniqueness check — scan all registered players
      const taken = Object.values(db.data.users ?? {}).some(
        p => p.id !== ctx.from && p.username?.toLowerCase() === desired.toLowerCase(),
      )
      if (taken) {
        return reply(`❌ *@${desired}* is already taken. Please choose a different username.`)
      }

      await updatePlayer(db, ctx.from, async p => { p.username = desired; return p })
      return reply(`✅ *Username reserved!*\n\n🏷️ Your username is now *@${desired}*`)
    }

    // ── .username remove ───────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'clear' || sub === 'delete') {
      if (!player.username) return reply(`⚠️ You don't have a username to remove.`)
      const old = player.username
      await updatePlayer(db, ctx.from, async p => { p.username = null; return p })
      return reply(`🗑️ Username *@${old}* removed.`)
    }

    // ── help fallthrough ───────────────────────────────────────────────────
    return reply(
      `🏷️ *Username Commands*\n\n` +
      `▹ *${pr}username* — view your current username\n` +
      `▹ *${pr}username add <name>* — reserve a username\n` +
      `▹ *${pr}username remove* — clear your username`,
    )
  },
}
