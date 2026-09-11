/**
 * delpfp.js — .delpfp
 * Removes your custom profile picture (set via .setpfp), reverting .me /
 * .profile back to the plain text-only display.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { deleteProfilePicture } from '../lib/pfp.js'

export default {
  name:           'delpfp',
  aliases:        ['removepfp', 'clearpfp', 'delavatar'],
  category:       'account',
  requiresPlayer: true,
  description:    'Remove your profile picture',

  async run(ctx) {
    const { player, db, from, reply } = ctx

    if (!player.pfp) {
      return reply(`❌ You don't have a profile picture set. Use *${config.prefix}setpfp* to add one.`)
    }

    await deleteProfilePicture(player.pfp)
    await updatePlayer(db, from, (p) => { p.pfp = null })

    return reply(`✅ Profile picture removed. Check *${config.prefix}me* — back to the default look.`)
  },
}
