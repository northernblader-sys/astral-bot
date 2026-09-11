/**
 * serverstats.js — bot health snapshot.
 *
 * Shows four live metrics:
 *   • Uptime          — process.uptime() (survives restarts, shows live session)
 *   • Total players    — Object.keys(db.data.users).length, same source top.js/
 *                        leaderboard.js read from
 *   • Active groups    — sock.groupFetchAllParticipating() key count
 *   • Commands today    — in-memory counter from lib/server-stats.js, reset at midnight
 *
 * The group count is a network call (may lag ~1s). If the bot lacks group
 * metadata permission it falls back to "—" rather than crashing.
 */
import { getCommandsToday } from '../lib/server-stats.js'

export default {
  name:           'serverstats',
  aliases:        ['botstats', 'hoststats'],
  category:       'utility',
  requiresPlayer: false,
  description:    'Bot health: uptime, total players, active groups, commands today',

  async run(ctx) {
    const { db } = ctx
    const uptimeSec = Math.floor(process.uptime())
    const h   = Math.floor(uptimeSec / 3600)
    const m   = Math.floor((uptimeSec % 3600) / 60)
    const s   = uptimeSec % 60
    const uptime = `${h}h ${m}m ${s}s`

    await db.read()
    const totalPlayers = Object.keys(db.data.users ?? {}).length

    let groupCount = '—'
    try {
      const groups = await ctx.sock.groupFetchAllParticipating()
      groupCount   = Object.keys(groups).length
    } catch { /* no group metadata permission — show dash */ }

    const cmds = getCommandsToday()

    return ctx.reply(
      `🖥️ *Bot Status*\n\n` +
      `⏱️ Uptime:          *${uptime}*\n` +
      `🧍 Total players:   *${totalPlayers.toLocaleString()}*\n` +
      `💬 Active groups:   *${groupCount}*\n` +
      `⚡ Commands today:  *${cmds}*\n\n` +
      `_Command counter resets at midnight (RAM only — resets on restart too)._`,
    )
  },
}
