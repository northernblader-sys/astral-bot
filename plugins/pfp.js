/**
 * lib/pfp.js — shared helper for saving a player's custom profile picture.
 * Used by plugins/setpfp.js. Images are stored on disk under
 * media/pfp/<jid-digits>.jpg (one file per player, overwritten on re-set)
 * and the path is saved on player.pfp — consumed by plugins/profile.js
 * (`.me`) and the short `.profile @player` view.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { mkdir, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { logger } from '../config.js'

const PFP_DIR = join('media', 'pfp')

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
 * Downloads and saves the image found by findImageMessage() for player
 * `jid`. Returns the saved file path (to store on player.pfp), or throws.
 */
export async function saveProfilePicture(sock, imageMsg, jid) {
  const buffer = await downloadMediaMessage(imageMsg, 'buffer', {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage,
  })

  await mkdir(PFP_DIR, { recursive: true })
  const fileName = `${jid.replace(/\D/g, '')}.jpg`
  const filePath = join(PFP_DIR, fileName)
  await writeFile(filePath, buffer)

  return filePath
}

/**
 * Deletes the on-disk profile picture file for `filePath` (the value stored
 * on player.pfp), if it exists. Used by plugins/delpfp.js. Best-effort —
 * a missing file (already deleted, path changed, etc.) is not an error;
 * the caller only cares that player.pfp gets cleared afterward regardless.
 */
export async function deleteProfilePicture(filePath) {
  if (!filePath) return
  try {
    await unlink(filePath)
  } catch (err) {
    // ENOENT (already gone) is fine and expected; anything else just gets
    // logged since a failed delete here should never block clearing pfp.
    if (err.code !== 'ENOENT') {
      logger.warn({ filePath, err: err.message }, 'deleteProfilePicture: unlink failed')
    }
  }
}
