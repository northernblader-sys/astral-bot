/**
 * version — which build of the bot you are actually talking to.
 * Usage: <prefix>version  ·  <prefix>version log  (recent releases)
 *
 * The number, codename and notes all come from lib/version.js, which is the
 * one place they are ever edited. Nothing here is hardcoded, so a release is
 * a single edit to that file and this command follows automatically.
 *
 * No player record needed: a brand new number should be able to ask what it
 * has connected to before it registers.
 */
import { config } from '../config.js'
import { listPluginsFor } from '../lib/plugin-manager.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  CHANGELOG, BOT_VERSION, VERSION_CODENAME, VERSION_DATE, formatVersionDate,
} from '../lib/version.js'

/** How many releases `.version log` lists before it stops. */
const LOG_LIMIT = 5

export default {
  name: 'version',
  // NOT 'build': plugins/homebuild.js already owns that key, and a second
  // same-platform claim on it would shadow a command players actually use.
  aliases: ['ver', 'v'],
  category: 'utility',
  cooldown: 5,
  description: 'Show which version of the bot is running',
  subcommands: [
    { cmd: 'version', desc: 'current version, release date and what changed' },
    { cmd: 'version log', desc: 'the last few releases' },
  ],

  async run(ctx) {
    const pr = config.prefix
    const sub = (ctx.args?.[0] ?? '').toLowerCase()

    if (sub === 'log' || sub === 'history' || sub === 'changelog') {
      const lines = [`📜 *Release history*\n`]
      for (const entry of CHANGELOG.slice(0, LOG_LIMIT)) {
        const tag = entry.codename ? `v${entry.version} "${entry.codename}"` : `v${entry.version}`
        const current = entry.version === BOT_VERSION ? '  ← running now' : ''
        lines.push(`*${tag}*${current}`)
        lines.push(`_${formatVersionDate(entry.date)}_`)
        for (const note of entry.notes ?? []) lines.push(`• ${note}`)
        lines.push('')
      }
      if (CHANGELOG.length > LOG_LIMIT) {
        lines.push(`_Showing the newest ${LOG_LIMIT} of ${CHANGELOG.length} releases._`)
      } else {
        lines.push('_Anything older than the oldest entry here predates the changelog._')
      }
      return ctx.reply(lines.join('\n').trim())
    }

    // process.uptime() is the bot process, not the WhatsApp connection: a
    // reconnect after a dropped socket does not reset it, which is the honest
    // answer to "how long has this build been up".
    const uptime = formatTimeLeft(process.uptime() * 1000)
    const commands = listPluginsFor(ctx.platform).length

    const head = VERSION_CODENAME
      ? `🌌 *Astral* v${BOT_VERSION} "${VERSION_CODENAME}"`
      : `🌌 *Astral* v${BOT_VERSION}`

    const notes = (CHANGELOG[0]?.notes ?? []).map(n => `• ${n}`).join('\n')

    return ctx.reply(
      `${head}\n` +
      `_Released ${formatVersionDate(VERSION_DATE)} · up ${uptime} · ${commands} commands_\n\n` +
      (notes ? `*What changed in this one*\n${notes}\n\n` : '') +
      `_Older releases: ${pr}version log_`,
    )
  },
}
