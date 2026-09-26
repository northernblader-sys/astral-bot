/**
 * givesummon.js — .givesummon <character> [@mention | reply]
 * Standalone top-level alias for ".admin givecharacter" — owner-only. Grants a
 * spin character (the "summons" — gojo, anastasia, mei, …) to a target player
 * (defaults to yourself if no @mention/reply given).
 *
 * Delegates to giveCharacter() in admin.js so the one-of-one exclusive lock
 * (shared claim registry) is handled exactly the same way everywhere — no
 * second, drifting copy of the grant logic.
 *
 * Example: .givesummon gojo @player
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { giveCharacter } from './admin.js'

export default {
  name:        'givesummon',
  aliases:     ['givesummons'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: grant a spin character (summon) to a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    // giveCharacter reads the character from args[1..] (args[0] is the
    // subcommand name in admin.js's flow) — shift args by one to line up.
    const shiftedCtx = { ...ctx, args: [null, ...ctx.args] }
    return giveCharacter(shiftedCtx)
  },
}
