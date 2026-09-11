/**
 * setbanner.js — .setbanner
 * Sets your custom profile banner, shown on the .me / .profile card.
 *
 * Usage:
 *   Send an image with the caption ".setbanner"       — direct attach
 *   Reply ".setbanner" to a message that has an image  — quoted/reply
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { findImageMessage, saveProfileBanner } from '../lib/banner.js'

export default {
  name:           'setbanner',
  aliases:        ['setprofilebanner'],
  category:       'account',
  requiresPlayer: true,
  description:    'Set your profile banner (attach or reply to an image)',

  async run(ctx) {
    const { msg, sock, db, from, reply } = ctx

    const imageMsg = findImageMessage(msg)
    if (!imageMsg) {
      return reply(
        `❌ *Usage:* send an image with caption *${config.prefix}setbanner*, ` +
        `or reply *${config.prefix}setbanner* to an existing image.`,
      )
    }

    let filePath
    try {
      filePath = await saveProfileBanner(sock, imageMsg, from)
    } catch (err) {
      return reply(`❌ Couldn't read that image — please try again.\n_Error: ${err.message}_`)
    }

    await updatePlayer(db, from, (p) => { p.banner = filePath })

    return reply(`✅ Banner updated! Check it with *${config.prefix}me* or *${config.prefix}profile*.`)
  },
}
