/**
 * afk-scan.js — the per-message half of AFK.
 *
 * Two behaviours, both of which have to run on EVERY message rather than on
 * a command, which is why they live here and not in plugins/afk.js:
 *
 *   1. Any message you send clears your own AFK.
 *   2. Tagging or replying to someone who is AFK gets an automatic answer.
 *
 * Neither consumes the message — an AFK person's command still runs, and a
 * message that happens to tag an AFK member is still an ordinary message.
 */
import { getAfk, clearAfk } from './moderation-state.js'
import { humanDuration } from '../plugins/afk.js'

/** Everyone this message tags or replies to. */
function mentionedJids(msg) {
  const out = new Set()
  const inner = msg.message ?? {}
  for (const value of Object.values(inner)) {
    if (!value || typeof value !== 'object') continue
    const ci = value.contextInfo
    if (!ci) continue
    if (ci.participant) out.add(ci.participant)
    for (const jid of ci.mentionedJid ?? []) out.add(jid)
  }
  return [...out]
}

/**
 * Clears the sender's own AFK if they had one, and answers on behalf of any
 * AFK person they tagged. Never blocks the message — returns nothing.
 */
export async function runAfkScan({ sock, msg, sender, from, body }) {
  // 1. Coming back. Skipped for `.afk` itself so setting it doesn't
  //    immediately clear it.
  const isAfkCommand = /^[^\w\s]?\s*(afk|brb)\b/i.test(String(body ?? '').trim().slice(1))
  if (!isAfkCommand) {
    const was = await clearAfk(from).catch(() => null)
    if (was) {
      await sock.sendMessage(sender, {
        text: `👋 Welcome back @${from.replace(/@.*$/, '')} — you were AFK for *${humanDuration(Date.now() - was.since)}*.`,
        mentions: [from],
      }, { quoted: msg }).catch(() => {})
    }
  }

  // 2. Tagging someone who's away.
  const targets = mentionedJids(msg).filter(j => j !== from)
  if (!targets.length) return

  const notices = []
  for (const jid of targets) {
    const rec = await getAfk(jid).catch(() => null)
    if (!rec) continue
    notices.push(
      `😴 @${jid.replace(/@.*$/, '')} is AFK — away for *${humanDuration(Date.now() - rec.since)}*` +
      (rec.reason ? `\n📝 _${rec.reason}_` : ''),
    )
  }
  if (!notices.length) return

  await sock.sendMessage(sender, {
    text: notices.join('\n\n'),
    mentions: targets,
  }, { quoted: msg }).catch(() => {})
}
