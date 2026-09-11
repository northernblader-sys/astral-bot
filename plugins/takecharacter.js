/**
 * takecharacter.js — .takecharacter <character> [@mention | reply]
 * Standalone top-level alias for ".admin takecharacter" — owner-only. The undo
 * for .givecharacter: removes the character, strips its stat bonuses if it was
 * equipped, and frees a one-of-one claim so it can be granted to someone else.
 *
 * Shares the exact same logic as admin.js so the two entry points cannot drift.
 *
 * Example: .takecharacter gojo @player
 */
import { isOwnerJid } from '../lib/group-helpers.js'
import { takeCharacter } from './admin.js'

export default {
  name:        'takecharacter',
  aliases:     ['takechar', 'tchar'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: revoke a character from a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }
    return takeCharacter({ ...ctx, args: [null, ...ctx.args] })
  },
}
