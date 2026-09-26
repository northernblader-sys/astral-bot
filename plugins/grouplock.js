/**
 * grouplock.js — .grouplock on|off (+ .antifake, .antiinternational)
 *
 * Group lock restricts the chat to admins: any non-admin message is deleted
 * on sight. The scan itself lives in handler.js; this plugin only flips the
 * setting.
 *
 * antifake and antiinternational are bundled here because they're the same
 * idea — who is allowed to be in this room — but they act on JOIN, not on
 * message, and are enforced by the group-participants hook in main.js.
 */
import { saveGroupSettings, getGroupSettings, isGroupOrBotOwnerOrMod, saveFailedMessage } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { config } from '../config.js'

function parseState(arg) {
  const s = String(arg ?? '').toLowerCase()
  if (['on', 'enable', 'true', '1'].includes(s)) return true
  if (['off', 'disable', 'false', '0'].includes(s)) return false
  return null
}

export default {
  name:        'grouplock',
  aliases:     ['lock', 'gclock', 'antifake', 'antiinternational', 'antiintl'],
  category:    'utility',
  description: 'Restrict the group to admins only (.grouplock on|off)',
  subcommands: [
    { cmd: 'on|off',            desc: 'lock/unlock the group to admins only' },
    { cmd: 'status',            desc: 'show the current lock settings' },
  ],

  async run(ctx) {
    const { args, reply, sender, isGroup, cmd } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)
    if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

    // The aliases double as their own commands: `.antifake on` must flip
    // antiFake, not grouplock, even though both land in this run().
    const key =
      cmd === 'antifake' ? 'antiFake'
      : (cmd === 'antiinternational' || cmd === 'antiintl') ? 'antiInternational'
      : 'grouplock'

    const label = {
      grouplock:         '🔒 Group lock',
      antiFake:          '🕵️ Anti-fake-number',
      antiInternational: '🌍 Anti-international',
    }[key]

    const sub = args[0]?.toLowerCase()

    if (!sub || sub === 'status') {
      const s = await getGroupSettings(sender)
      return reply(
        `🔒 *GROUP LOCK*\n─────────────────────\n` +
        `Lock (admins only): *${s.grouplock ? 'ON' : 'OFF'}*\n` +
        `Anti-fake number: *${s.antiFake ? 'ON' : 'OFF'}*\n` +
        `Anti-international: *${s.antiInternational ? 'ON' : 'OFF'}*\n` +
        (s.localPrefixes?.length ? `Allowed prefixes: *${s.localPrefixes.join(', ')}*\n` : '') +
        `\n_${p}grouplock on_ · _${p}antifake on_ · _${p}antiintl on_\n` +
        `_${p}grouplock allow 234 44_ — set the country codes anti-international lets in_`,
      )
    }

    // `.grouplock allow <code> [code...]` — which country codes count as local.
    if (sub === 'allow' || sub === 'prefixes') {
      const codes = args.slice(1).map(a => a.replace(/\D/g, '')).filter(Boolean)
      if (!codes.length) {
        return reply(`❌ *Usage:* ${p}grouplock allow 234 44 1`)
      }
      const res = await saveGroupSettings(sender, s => { s.localPrefixes = codes; return s })
      if (!res.ok) return reply(saveFailedMessage('allowed prefixes', res.error))
      return reply(`🌍 Anti-international will now allow numbers starting with: *${res.settings.localPrefixes.join(', ')}*`)
    }

    const state = parseState(sub)
    if (state === null) return reply(`❌ *Usage:* ${p}${cmd} on|off`)

    const res = await saveGroupSettings(sender, s => { s[key] = state; return s })
    if (!res.ok) return reply(saveFailedMessage(label, res.error))

    // Report the stored value, not the requested one — see saveGroupSettings().
    const stored = res.settings[key] === true

    if (key === 'grouplock' && stored) {
      return reply(
        `${label} is now *ON*.\n\n` +
        `_Only group admins can send messages here. Everyone else's messages are deleted._\n` +
        `Turn it off with *${p}grouplock off*.`,
      )
    }
    return reply(`${label} is now *${stored ? 'ON' : 'OFF'}*.`)
  },
}
