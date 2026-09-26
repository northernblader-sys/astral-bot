/**
 * transfer-guards.js — shared pre-flight checks for all money-moving commands.
 *
 * Extracted so plugins/astralpay.js and plugins/transfer.js can both import
 * the same guards rather than duplicating logic. Single source of truth for
 * the level gate, cooldown, and target-resolution behaviour.
 */
import { config } from '../config.js'
import { playerExists } from './player-repo.js'

export const MIN_LEVEL             = 5
export const TRANSFER_COOLDOWN_MS  = 5 * 60 * 1000  // 5 minutes
export const MAX_SOLARS_PER_TRANSFER = 5000

/**
 * Resolves a WhatsApp JID for the intended recipient, in priority order:
 *  1. Reply-to quote (contextInfo.participant)
 *  2. @mention   (contextInfo.mentionedJid[0])
 *  3. Raw phone number in args
 */
export function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant)           return contextInfo.participant
  if (contextInfo?.mentionedJid?.length)  return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

/**
 * Runs the standard pre-transfer guard suite. Returns true (and replies) if
 * any guard fires; returns false if all checks pass and the transfer may proceed.
 *
 * Checks (in order): target resolved, self-send, level gate, cooldown,
 * target registered.
 *
 * @param {object} ctx         — plugin ctx
 * @param {object} sender      — the CURRENT player record (read from the db
 *                               inside an updatePlayer callback)
 * @param {string} targetJid   — resolved recipient JID
 */
export async function runTransferGuards(ctx, sender, targetJid) {
  const p = config.prefix
  if (!targetJid) {
    await ctx.reply(`❌ Couldn't find that player. Reply to one of their messages, @mention them, or give their number.`)
    return true
  }
  if (targetJid === ctx.from) {
    await ctx.reply(`❌ You can't send things to yourself.`)
    return true
  }
  if ((sender.level ?? 1) < MIN_LEVEL) {
    await ctx.reply(`❌ You must be *Level ${MIN_LEVEL}+* to transfer. You're Level ${sender.level}.`)
    return true
  }
  if (!playerExists(ctx.db, targetJid)) {
    await ctx.reply(`❌ That player isn't registered. They need *${p}register* first.`)
    return true
  }
  const now = Date.now()
  const nextOk = (sender.lastTransferAt ?? 0) + TRANSFER_COOLDOWN_MS
  if (now < nextOk) {
    const mins = Math.ceil((nextOk - now) / 60000)
    await ctx.reply(`⏳ *Transfer cooldown.* Try again in *${mins} min*. _(5 min anti-abuse cooldown)_`)
    return true
  }
  return false
}
