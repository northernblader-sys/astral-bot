/**
 * plugins/tp.js — the .tp command: invite a player to share your empire stash.
 *
 * Named for the classic "teleport a friend to your base" of block games: a
 * ruler grants a guest the run of the stash, and the guest can then drop into
 * and take from it like a shared chest. The real logic lives in plugins/empire.js
 * (inviteCmd) so there is exactly one implementation; this plugin just gives it
 * a short top-level name.
 *   .tp <player>          → invite (reply, @mention, or their number)
 *   .tp remove <player>   → revoke access
 * Owner-only, enforced inside inviteCmd. Never broadcasts.
 */
import { inviteCmd } from './empire.js'

export default {
  name:           'tp',
  category:       'empire',
  requiresPlayer: true,
  description:    'Invite a player to share your empire stash (.tp remove to revoke)',

  async run(ctx) {
    return (ctx.args[0]?.toLowerCase() === 'remove')
      ? inviteCmd(ctx, ctx.args[1], 'remove')
      : inviteCmd(ctx, ctx.args[0], 'add')
  },
}
