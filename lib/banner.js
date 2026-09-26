/**
 * lib/banner.js — shared helper for saving a player's custom profile
 * banner. Used by plugins/setbanner.js. Images are uploaded to ImgBB
 * (see lib/imgbb.js) rather than written to local disk — nothing is
 * saved under media/banner anymore. The ImgBB URL is saved on
 * player.banner — consumed by lib/profile-card-render.mjs for the
 * `.me` / `.profile` card.
 *
 * Mirrors lib/pfp.js exactly; kept as a separate file (rather than a
 * shared generic helper) so each stays simple and either can change
 * independently later — e.g. if banners ever get a different aspect
 * ratio requirement or size cap that pfp shouldn't inherit.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { logger } from '../config.js'
import { findImageMessage } from './pfp.js'
import { uploadToImgbb } from './imgbb.js'

// Re-exported so plugins/setbanner.js only needs one import for both
// "find the image in the message" and "save it" — same shape as setpfp.js.
export { findImageMessage }

/**
 * Downloads the image found by findImageMessage() and uploads it to
 * ImgBB for player `jid`. Returns the hosted URL (to store on
 * player.banner), or throws.
 */
export async function saveProfileBanner(sock, imageMsg, jid) {
  const buffer = await downloadMediaMessage(imageMsg, 'buffer', {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage,
  })

  const fileName = `banner-${jid.replace(/\D/g, '')}`
  return uploadToImgbb(buffer, fileName)
}

/**
 * "Deletes" a player's saved banner (see plugins/delbanner.js). Same
 * reasoning as deleteProfilePicture() in lib/pfp.js — ImgBB's free-tier
 * API key can't delete a remote upload, so this is a no-op and the real
 * removal is plugins/delbanner.js clearing player.banner in the DB.
 */
export async function deleteProfileBanner(_url) {
  // no-op — see doc comment above
}
