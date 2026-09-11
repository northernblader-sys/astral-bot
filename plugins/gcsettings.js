/**
 * gcsettings.js — .gcsettings [raw]
 *
 * Shows every setting this group has, and — the actual point of the command —
 * whether each one is *saved in the file* or just showing its default.
 *
 * getGroupSettings() merges DEFAULT_SETTINGS over whatever's on disk, which is
 * right for the code that reads settings and useless for answering "did my
 * toggle save?": a `welcome: false` that was written and a `welcome: false`
 * that's just the default look identical through that lens. So this reads the
 * RAW block straight off data/group-settings.json (cache bypassed) and marks
 * each row `saved` or `default`, then prints the file path, the key the group
 * is filed under, and the file's last-modified time.
 *
 * `.gcsettings raw` dumps the exact JSON stored for this chat, for when
 * nothing short of the bytes will do.
 *
 * Read-only and open to any member — it reveals nothing a member can't learn
 * by trying the commands.
 */
import { stat } from 'fs/promises'
import {
  getGroupSettings,
  readRawGroupSettings,
  SETTINGS_DISPLAY,
  KNOWN_SETTING_KEYS,
  SETTINGS_FILE_PATH,
} from '../lib/group-settings.js'
import { NOT_GROUP } from '../lib/group-helpers.js'
import { config, logger } from '../config.js'
import { humanDuration } from './afk.js'

/** Renders one setting's value for display, by declared type. */
function fmtValue(type, value) {
  if (value === null || value === undefined) return '_not set_'
  switch (type) {
    case 'bool': return value ? 'ON' : 'OFF'
    case 'list': return Array.isArray(value) && value.length ? value.join(', ') : '_none_'
    case 'num':  return String(value)
    default: {
      const text = String(value).replace(/\n/g, ' ')
      return text.length > 60 ? `"${text.slice(0, 60)}…"` : `"${text}"`
    }
  }
}

/** Bullet for a row: ticked box for a live boolean, dot for everything else. */
function bullet(type, value) {
  if (type !== 'bool') return '•'
  return value ? '✅' : '⬜'
}

export default {
  name:           'gcsettings',
  aliases:        ['gcconfig', 'gccfg'],
  category:       'utility',
  requiresPlayer: false,
  platforms:      ['whatsapp'],   // settings are keyed by group jid; see lib/group-settings.js
  description:    'Show every saved setting for this group (.gcsettings)',
  subcommands: [
    { cmd: 'raw', desc: 'dump the exact JSON stored for this group' },
  ],

  async run(ctx) {
    const { reply, sender, isGroup, args } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)

    const raw      = await readRawGroupSettings(sender)   // null = never written
    const merged   = await getGroupSettings(sender)       // defaults filled in
    const savedKey = k => raw !== null && Object.prototype.hasOwnProperty.call(raw, k)

    // ── .gcsettings raw ────────────────────────────────────────────────────
    if (String(args[0] ?? '').toLowerCase() === 'raw') {
      return reply(
        `📄 *RAW STORED SETTINGS*\n─────────────────────\n` +
        `Key: \`${sender}\`\n\n` +
        (raw === null
          ? `_This group has no entry in data/group-settings.json yet. Flip any setting (e.g. ${p}welcome on) and it will appear._`
          : '```\n' + JSON.stringify(raw, null, 2).slice(0, 3000) + '\n```'),
      )
    }

    // ── File evidence: path + when it was last actually written ─────────────
    let fileNote
    try {
      const st  = await stat(SETTINGS_FILE_PATH)
      const age = Date.now() - st.mtimeMs
      fileNote =
        `📄 Stored in \`data/group-settings.json\`\n` +
        `🕒 File last written: *${humanDuration(age)} ago*`
    } catch (err) {
      logger.warn({ err: err.message }, 'gcsettings: could not stat the settings file')
      fileNote = `⚠️ Could not read \`data/group-settings.json\` — _${err.message}_`
    }

    const savedCount = raw === null ? 0 : Object.keys(raw).length

    const blocks = SETTINGS_DISPLAY.map(([section, fields]) => {
      const rows = fields.map(([key, label, type]) => {
        const value = merged[key]
        const mark  = savedKey(key) ? '' : '  _(default)_'
        return ` ${bullet(type, value)} ${label}: *${fmtValue(type, value)}*${mark}`
      })
      return `*${section}*\n${rows.join('\n')}`
    })

    // Anything in the file that no longer has a default — a renamed or removed
    // setting left behind by an older version. Worth showing, since it looks
    // like a live setting in the file but nothing reads it any more.
    const legacy = raw === null
      ? []
      : Object.keys(raw).filter(k => !KNOWN_SETTING_KEYS.includes(k))

    const out = [
      `⚙️ *GROUP SETTINGS*`,
      `─────────────────────`,
      raw === null
        ? `⚠️ _Nothing saved for this group yet — everything below is a default._\n`
        : `✅ *${savedCount}* setting${savedCount === 1 ? '' : 's'} saved for this group.\n`,
      blocks.join('\n\n'),
      legacy.length ? `\n*Unused keys in file*\n${legacy.map(k => ` • \`${k}\``).join('\n')}` : null,
      ``,
      fileNote,
      `🔑 Key: \`${sender}\``,
      ``,
      `_${p}gcsettings raw — see the exact JSON._`,
    ].filter(l => l !== null)

    return reply(out.join('\n'))
  },
}
