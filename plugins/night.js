/**
 * night.js — .night on | .night off | .night
 *
 * Bot-wide "closed for the night" switch. While it's on, every command from
 * everyone except the bot owner and bot mods is refused at handler.js's lockout
 * chokepoint (right alongside the ban and jail lockouts) with a "go to sleep,
 * back tomorrow" notice, and the card/series/Pokémon auto-spawn sweeps in
 * main.js stop running so nobody wakes up to a wall of unclaimed spawns.
 *
 * Two things stay reachable for everyone: ban appeals (as they do from every
 * other lockout) and spawn claims — `.claim <code>` / `.collect <code>`. A card
 * or series that spawned just before the realm closed is still live in the
 * group with its code posted, so the claim must not be locked out with it.
 * See SPAWN_CLAIM_COMMANDS / isNightModeAllowed in handler.js.
 *
 * Permission: owner OR bot mod (lib/mod-repo.js) — the same set that stays
 * able to use the bot while night mode is on, so whoever can work through the
 * night can also end it. WhatsApp group admins deliberately cannot: this is a
 * bot-wide switch, not a per-group one, so a single group's admin must not be
 * able to shut the bot down for everyone.
 *
 * The switch is durable (data/night-mode.json) — it survives a restart, so a
 * crash overnight doesn't silently reopen the bot. See lib/night-mode.js.
 */
import { config } from '../config.js'
import { isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { isMod } from '../lib/mod-repo.js'
import { isNightMode, getNightState, setNightMode } from '../lib/night-mode.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'

/** "3h 12m" / "12m" / "just now" */
function since(ts) {
  if (!ts) return 'unknown'
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m}m ago`
  return `${h}h${m ? ` ${m}m` : ''} ago`
}

export default {
  name: 'night',
  aliases: ['nightmode', 'sleepmode', 'closed'],
  category: 'admin',
  description: `${config.prefix}night on|off — lock the bot for the night (owner/mods only)`,

  async run(ctx) {
    const { reply, from, db } = ctx
    const p = config.prefix

    if (!isOwnerJid(from) && !isMod(db, from)) return reply(NOT_ALLOWED)

    const arg = (ctx.args[0] ?? '').toLowerCase()

    // Bare `.night` — status only, so it can't be a footgun.
    if (!arg) {
      const st = getNightState()
      return reply(
        st.on
          ? `🌙 *Night mode is ON.*\n${RULE}\n` +
            `Turned on *${since(st.since)}*` +
            (st.by ? ` by @${st.by.replace(/@.*$/, '')}` : '') + `.\n\n` +
            `_Only you and the other mods can use commands. Auto-spawns are paused, ` +
            `but a card or series already spawned can still be claimed with ` +
            `*${p}claim <code>*._\n\n` +
            `Wake the bot up with *${p}night off*.`
          : `☀️ *Night mode is OFF* — the bot is open to everyone.\n${RULE}\n` +
            `Close it for the night with *${p}night on*.`,
      )
    }

    if (arg === 'on' || arg === 'start' || arg === 'sleep') {
      const { changed } = setNightMode(true, from)
      if (!changed) return reply(`🌙 Night mode is *already on*. Use *${p}night off* to reopen.`)
      return reply(
        `🌙💤 *NIGHT MODE ON*\n${RULE}\n` +
        `The bot is now closed to everyone except *you and the mods*.\n\n` +
        `• Everyone else gets a "go to sleep, back tomorrow" notice\n` +
        `• Card, series and Pokémon auto-spawns are *paused*\n` +
        `• Nothing is lost — spawns just resume on their normal cadence\n` +
        `• A card or series *already spawned* can still be claimed overnight ` +
        `with *${p}claim <code>* or *${p}collect <code>*\n\n` +
        `_Reopen with_ *${p}night off*.`,
      )
    }

    if (arg === 'off' || arg === 'stop' || arg === 'wake' || arg === 'open') {
      // Read the duration BEFORE flipping — setNightMode(false) clears `since`.
      const wasClosedFor = since(getNightState().since)
      const { changed } = setNightMode(false, from)
      if (!changed) return reply(`☀️ Night mode is *already off* — the bot is open.`)
      return reply(
        `☀️ *GOOD MORNING — NIGHT MODE OFF*\n${RULE}\n` +
        `The bot is open to everyone again.\n\n` +
        `• Auto-spawns have resumed on their normal schedule\n` +
        `• The realm was closed since *${wasClosedFor}*\n\n` +
        `_Close it again with_ *${p}night on*.`,
      )
    }

    return reply(
      `🌙 *Usage:*\n` +
      `*${p}night on* — close the bot for the night\n` +
      `*${p}night off* — reopen it\n` +
      `*${p}night* — check the current state`,
    )
  },
}
