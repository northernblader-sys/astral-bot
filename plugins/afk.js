/**
 * afk.js — .afk [reason] / .unafk
 *
 * Marks you away. When someone tags you or replies to you, the bot answers
 * on your behalf with the reason and how long you've been gone. Your own
 * next message clears it automatically — that check lives in handler.js,
 * since it has to run on every message rather than only on a command.
 *
 * AFK is per-person, not per-group: being away is a property of you, so a
 * mention in any group gets the same answer.
 */
import { setAfk, getAfk, clearAfk } from '../lib/moderation-state.js'
import { config } from '../config.js'

/** "2h 14m" / "45s" — compact, no library. */
export function humanDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export default {
  name:        'afk',
  aliases:     ['brb', 'unafk', 'back'],
  category:    'utility',
  description: 'Mark yourself away — the bot answers anyone who tags you (.afk [reason])',

  async run(ctx) {
    const { args, reply, from, cmd } = ctx
    const p = config.prefix

    if (cmd === 'unafk' || cmd === 'back') {
      const was = await clearAfk(from)
      return reply(
        was
          ? `👋 Welcome back — you were AFK for *${humanDuration(Date.now() - was.since)}*.`
          : `_You weren't marked AFK._`,
      )
    }

    const existing = await getAfk(from)
    const reason = args.join(' ').trim().slice(0, 200)

    await setAfk(from, reason)

    return reply(
      `😴 *You're now AFK.*${reason ? `\n📝 Reason: _${reason}_` : ''}\n\n` +
      `_Anyone who tags or replies to you gets told. Send any message to come back` +
      (existing ? `` : `, or use *${p}unafk*`) + `._`,
    )
  },
}
