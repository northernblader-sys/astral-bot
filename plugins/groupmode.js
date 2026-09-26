/**
 * groupmode.js — .close / .open / .lockinfo / .unlockinfo
 *
 * The two native WhatsApp group switches, which are NOT the same thing as
 * plugins/grouplock.js:
 *
 *   .close / .open       who may SEND messages (WhatsApp's "announcement"
 *                        mode). Enforced by WhatsApp itself — non-admins
 *                        physically can't type.
 *   .lockinfo/.unlockinfo who may EDIT the group's name, icon and description
 *                        (WhatsApp's "locked" mode).
 *
 * grouplock.js does something different and worth not confusing with these:
 * it leaves the group open and has the BOT delete non-admin messages after the
 * fact. That one works without WhatsApp's cooperation but needs the bot to be
 * an admin and always lets the message appear briefly. These four flip the real
 * setting, so they're the better tool when the bot is an admin.
 */
import { isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED, checkBotAdmin } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'

/** cmd → { setting, headline, detail, undo } */
const MODES = {
  close:      { setting: 'announcement',     headline: '🔒 Group closed',        detail: 'Only *admins* can send messages now.',                              undo: 'open' },
  closegc:    { setting: 'announcement',     headline: '🔒 Group closed',        detail: 'Only *admins* can send messages now.',                              undo: 'open' },
  mutegc:     { setting: 'announcement',     headline: '🔒 Group closed',        detail: 'Only *admins* can send messages now.',                              undo: 'open' },
  open:       { setting: 'not_announcement', headline: '🔓 Group opened',        detail: 'Every member can send messages again.',                             undo: 'close' },
  opengc:     { setting: 'not_announcement', headline: '🔓 Group opened',        detail: 'Every member can send messages again.',                             undo: 'close' },
  lockinfo:   { setting: 'locked',           headline: '🔐 Group info locked',   detail: 'Only *admins* can change the group name, icon and description.',    undo: 'unlockinfo' },
  unlockinfo: { setting: 'unlocked',         headline: '🔓 Group info unlocked', detail: 'Any member can change the group name, icon and description.',       undo: 'lockinfo' },
}

export default {
  name:        'close',
  aliases:     ['closegc', 'mutegc', 'open', 'opengc', 'lockinfo', 'unlockinfo'],
  category:    'utility',
  platforms:   ['whatsapp'],   // sock.groupSettingUpdate — Baileys-only
  description: 'Close/open the group to members (.close / .open), or lock group info (.lockinfo)',
  subcommands: [
    { cmd: '',  desc: 'close — only admins can send messages' },
  ],

  async run(ctx) {
    const { reply, sender, isGroup, sock, cmd } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const mode = MODES[String(cmd).toLowerCase()]
    if (!mode) {
      return reply(`❌ *Usage:* ${p}close · ${p}open · ${p}lockinfo · ${p}unlockinfo`)
    }

    const { isAdmin } = await checkBotAdmin(sock, sender).catch(() => ({ isAdmin: false }))
    if (!isAdmin) {
      return reply(`⚠️ I need to be a *group admin* to change that. Use *${p}botadmin* to check my status.`)
    }

    try {
      await sock.groupSettingUpdate(sender, mode.setting)
    } catch (err) {
      logger.warn({ err: err.message, jid: sender, setting: mode.setting }, 'groupSettingUpdate failed')
      return reply(`❌ Couldn't apply that: _${err.message}_`)
    }

    return reply(`${mode.headline}\n─────────────────────\n${mode.detail}\n\n_Undo with ${p}${mode.undo}._`)
  },
}
