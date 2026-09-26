/**
 * antispam.js — .antispam on|off [count] [seconds]
 *
 * Rapid-fire and duplicate message detection. The sliding window lives in
 * lib/message-cache.js and the scan runs in handler.js; this configures it.
 */
import { saveGroupSettings, saveFailedMessage, getGroupSettings, isGroupOrBotOwnerOrMod } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { config } from '../config.js'
import { RATE_BAN_COUNT, RATE_BAN_WINDOW_SEC, RATE_BAN_MS } from '../lib/moderation-scan.js'

const MIN_COUNT = 3, MAX_COUNT = 30
const MIN_WINDOW = 3, MAX_WINDOW = 120

export default {
  name:        'antispam',
  // WhatsApp-only: Discord has native slowmode, Telegram has native
  // permission throttling — see the per-platform plugin dirs.
  platforms:   ['whatsapp'],
  aliases:     ['antiflood'],
  category:    'utility',
  description: 'Auto-delete rapid/duplicate message floods (.antispam on|off)',
  subcommands: [
    { cmd: 'on|off [count] [secs]', desc: 'toggle, optionally setting the threshold' },
    { cmd: 'kick on|off',           desc: 'also remove repeat offenders' },
    { cmd: 'status',                desc: 'show the current thresholds' },
  ],

  async run(ctx) {
    const { args, reply, sender, isGroup } = ctx
    const p = config.prefix
    const banMins = Math.round(RATE_BAN_MS / 60000)
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    const sub = args[0]?.toLowerCase()

    if (!sub || sub === 'status') {
      const s = await getGroupSettings(sender)
      return reply(
        `🚨 *ANTISPAM*\n─────────────────────\n` +
        `Status: *${s.antispam ? 'ON' : 'OFF'}*\n` +
        `Flood trigger: *${s.antispamCount}* messages in *${s.antispamWindow}s* _(deleted)_\n` +
        `Command-spam ban: *${RATE_BAN_COUNT}* commands in *${RATE_BAN_WINDOW_SEC}s* → *${banMins}min* ban\n` +
        `Kick repeat offenders: *${s.antispamKick ? 'ON' : 'OFF'}*\n\n` +
        `_${p}antispam on 5 10_ — 5 messages per 10 seconds\n` +
        `_${p}antispam kick on_ — remove after 3 strikes`,
      )
    }

    if (sub === 'kick') {
      const k = args[1]?.toLowerCase()
      if (k !== 'on' && k !== 'off') return reply(`❌ *Usage:* ${p}antispam kick on|off`)
      const res = await saveGroupSettings(sender, s => { s.antispamKick = (k === 'on'); return s })
      if (!res.ok) return reply(saveFailedMessage('antispam kick', res.error))
      return reply(
        res.settings.antispamKick
          ? `🚨 Antispam will now *remove* anyone who trips it 3 times in 10 minutes.`
          : `🚨 Antispam will now only *delete* — nobody gets removed.`,
      )
    }

    if (sub !== 'on' && sub !== 'off') {
      return reply(`❌ *Usage:* ${p}antispam on|off [count] [seconds]`)
    }

    // Optional threshold on the same line: `.antispam on 5 10`.
    let count = null, windowSec = null
    if (args[1] != null) {
      count = parseInt(args[1], 10)
      if (!Number.isFinite(count) || count < MIN_COUNT || count > MAX_COUNT) {
        return reply(`❌ Message count must be between *${MIN_COUNT}* and *${MAX_COUNT}*.`)
      }
    }
    if (args[2] != null) {
      windowSec = parseInt(args[2], 10)
      if (!Number.isFinite(windowSec) || windowSec < MIN_WINDOW || windowSec > MAX_WINDOW) {
        return reply(`❌ Window must be between *${MIN_WINDOW}* and *${MAX_WINDOW}* seconds.`)
      }
    }

    // Thresholds go in the same write as the toggle, so a partial save can't
    // leave antispam on with the old window. Report from what landed on disk —
    // a bare throw here would be swallowed by dispatch() and reply nothing.
    const res = await saveGroupSettings(sender, s => {
      s.antispam = (sub === 'on')
      if (count != null) s.antispamCount = count
      if (windowSec != null) s.antispamWindow = windowSec
      return s
    })
    if (!res.ok) return reply(saveFailedMessage('antispam', res.error))
    const saved = res.settings

    return reply(
      saved.antispam
        ? `🚨 Antispam is now *ON* — *${saved.antispamCount}* messages in *${saved.antispamWindow}s* trips it.\n` +
          `_Offending messages are deleted. Admins and the bot owner are exempt._\n\n` +
          `⛔ *Command-spam auto-ban:* *${RATE_BAN_COUNT}* commands (messages starting with *${p}*) in *${RATE_BAN_WINDOW_SEC}s* → an automatic *${banMins}-minute* ban across the whole bot. Only the owner or a mod can lift it early.`
        : `🚨 Antispam is now *OFF*.`,
    )
  },
}
