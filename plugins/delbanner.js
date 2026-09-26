/**
 * delbanner.js — .delbanner
 * Removes your custom profile banner (set via .setbanner), reverting the
 * .me / .profile card back to the shared default banner.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { deleteProfileBanner } from '../lib/banner.js'

export default {
  name:           'delbanner',
  aliases:        ['removebanner', 'clearbanner'],
  category:       'account',
  requiresPlayer: true,
  description:    'Remove your profile banner',

  async run(ctx) {
    const { player, db, from, reply } = ctx

    if (!player.banner) {
      return reply(`❌ You don't have a banner set. Use *${config.prefix}setbanner* to add one.`)
    }

    await deleteProfileBanner(player.banner)
    await updatePlayer(db, from, (p) => { p.banner = null })

    return reply(`✅ Banner removed. Check *${config.prefix}me* — back to the default look.`)
  },
}
