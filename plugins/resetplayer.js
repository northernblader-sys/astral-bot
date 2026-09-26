/**
 * resetplayer.js — .resetplayer [@mention | reply]
 * Standalone top-level alias for ".admin resetplayer" — owner-only. Wipes a
 * target player's save entirely. Shares the exact same logic as admin.js so
 * behavior never drifts between the two entry points.
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { resetPlayer } from './admin.js'

export default {
  name:        'resetplayer',
  aliases:     ['wipeplayer'],
  category:    'admin',
  requiresPlayer: false,
  description: "Owner-only: wipe a player's save",

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    // resetPlayer only uses resolveTargetId(ctx) — no args[1] to shift, but
    // we pass ctx straight through unchanged for consistency with the other
    // standalone aliases.
    return resetPlayer(ctx)
  },
}
