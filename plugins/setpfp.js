/**
 * setpfp.js — .setpfp
 * Sets your custom profile picture, shown on .me / .profile and on the
 * short public .profile @mention view.
 *
 * Usage:
 *   Send an image with the caption ".setpfp"        — direct attach
 *   Reply ".setpfp" to a message that has an image   — quoted/reply
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { findImageMessage, saveProfilePicture } from '../lib/pfp.js'

export default {
  name:           'setpfp',
  aliases:        ['setprofilepic', 'setavatar'],
  category:       'account',
  requiresPlayer: true,
  description:    'Set your profile picture (attach or reply to an image)',

  async run(ctx) {
    const { msg, sock, db, from, reply } = ctx

    const imageMsg = findImageMessage(msg)
    if (!imageMsg) {
      return reply(
        `❌ *Usage:* send an image with caption *${config.prefix}setpfp*, ` +
        `or reply *${config.prefix}setpfp* to an existing image.`,
      )
    }

    let filePath
    try {
      filePath = await saveProfilePicture(sock, imageMsg, from)
    } catch (err) {
      return reply(`❌ Couldn't read that image — please try again.\n_Error: ${err.message}_`)
    }

    await updatePlayer(db, from, (p) => { p.pfp = filePath })

    return reply(`✅ Profile picture updated! Check it with *${config.prefix}me* or *${config.prefix}profile*.`)
  },
}
