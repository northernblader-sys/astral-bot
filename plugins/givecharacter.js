/**
 * givecharacter.js — .givecharacter <character> [@mention | reply]
 * Standalone top-level alias for ".admin givecharacter" — owner-only. Grants a
 * character outright, bypassing the spin/season/gem routes, and for a one-of-one
 * exclusive it also moves the bot-wide claim so the roster reads "claimed by
 * <them>". Defaults to yourself when no @mention or reply is given.
 *
 * Shares the exact same logic as admin.js so the two entry points cannot drift.
 *
 * Example: .givecharacter gojo @player
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { giveCharacter } from './admin.js'

export default {
  name:        'givecharacter',
  aliases:     ['givechar', 'gchar'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: grant a character to a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }
    // giveCharacter reads the character from args[1] onward (args[0] is the
    // subcommand name in admin.js's flow) — shift by one to line up the same way.
    return giveCharacter({ ...ctx, args: [null, ...ctx.args] })
  },
}
