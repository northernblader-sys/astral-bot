/**
 * lib/pfp.js — shared helper for saving a player's custom profile picture.
 * Used by plugins/setpfp.js. Images are uploaded to ImgBB (see
 * lib/imgbb.js) rather than written to local disk — nothing is saved
 * under media/pfp anymore. The ImgBB URL is saved on player.pfp —
 * consumed by plugins/profile.js (`.me`) and the short `.profile
 * @player` view, and fetched directly by lib/profile-card-render.mjs.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { logger } from '../config.js'
import { uploadToImgbb } from './imgbb.js'

/**
 * Finds the actual image message to download, whether it was attached
 * directly to the command message (caption = ".setpfp") or is the message
 * being replied/quoted to (contextInfo.quotedMessage).
 * Returns the image message object + a fabricated wrapper msg Baileys'
 * downloadMediaMessage can consume, or null if no image is present.
 */
export function findImageMessage(msg) {
  // Case 1: image sent directly with .setpfp as the caption.
  if (msg.message?.imageMessage) {
    return msg
  }

  // Case 2: .setpfp sent as a reply to an earlier image message.
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
  const quoted  = ctxInfo?.quotedMessage
  if (quoted?.imageMessage) {
    // downloadMediaMessage needs a message-shaped object with .message and
    // .key — participant/remoteJid matter for E2E session lookups on some
    // media, so carry over what we can from the quoting message.
    return {
      key: {
        remoteJid:   msg.key.remoteJid,
        id:          ctxInfo.stanzaId ?? msg.key.id,
        participant: ctxInfo.participant,
        fromMe:      false,
      },
      message: quoted,
    }
  }

  return null
}

/**
 * Downloads the image found by findImageMessage() and uploads it to
 * ImgBB for player `jid`. Returns the hosted URL (to store on
 * player.pfp), or throws.
 */
export async function saveProfilePicture(sock, imageMsg, jid) {
  const buffer = await downloadMediaMessage(imageMsg, 'buffer', {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage,
  })

  const fileName = `pfp-${jid.replace(/\D/g, '')}`
  return uploadToImgbb(buffer, fileName)
}

/**
 * "Deletes" a player's saved profile picture (see plugins/delpfp.js).
 * ImgBB's free-tier API key doesn't support deleting an uploaded image
 * remotely, so there's nothing to clean up on ImgBB's side — this just
 * exists so plugins/delpfp.js's call site doesn't need to change. The
 * actual removal is plugins/delpfp.js clearing player.pfp in the DB,
 * which is what every consumer (profile.js, me.js, profile-card-render.mjs)
 * actually checks. Kept async/no-throw to match the old local-disk
 * signature exactly.
 */
export async function deleteProfilePicture(_url) {
  // no-op — see doc comment above
}
