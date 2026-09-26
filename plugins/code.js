/**
 * code.js — read your pending connect code from chat instead of the website.
 *
 *   .code    — show the newest link code sitting in your notification bell
 *
 * WHY THIS EXISTS: `.connect <username>` on Discord/Telegram sends a 6-digit
 * code to the *master* account's notification bell (see plugins/connect.js for
 * why the bell and not a DM). Reading it meant opening the site and logging in,
 * which is a lot of friction for someone who is already sitting in WhatsApp
 * talking to the bot. This surfaces the same bell entry in chat.
 *
 * It does NOT read lib/link-otp.js — codes are stored HMAC-hashed there and the
 * plaintext is deliberately unrecoverable. The source here is the notification
 * that `.connect` pushed, which is the same thing the site's bell renders. That
 * also means this command can't invent a code that was never delivered: no
 * notification, nothing to show.
 *
 * DM ONLY. The whole point of the code is that only the account owner can read
 * it — printing it into a group would hand anyone watching the ability to link
 * their own Discord to this character.
 */
import { config } from '../config.js'
import { listNotifications, markRead } from '../lib/notification-repo.js'
import { stats as otpStats } from '../lib/link-otp.js'

/**
 * Matches what plugins/connect.js writes:
 *   title: `Your Discord connect code: 481920`
 * The body repeats it, so the body is checked as a fallback in case the title
 * is ever reworded.
 */
const CODE_RE = /connect code:?\s*(\d{4,8})/i
const BODY_CODE_RE = /connect\s+(\d{4,8})/i

/** Telegram autocompletes `/`, so showing `.` there teaches the wrong thing. */
function prefixFor(platform) {
  return platform === 'telegram' ? config.telegramPrefix : config.prefix
}

function minutes(ms) {
  return Math.max(1, Math.round(ms / 60_000))
}

/** "just now" / "3 minutes ago" — codes never live long enough to need days. */
function ago(ms) {
  if (ms < 45_000) return 'just now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Pulls the code out of a notification, or null if it isn't a code alert. */
function extractCode(note) {
  const fromTitle = CODE_RE.exec(note?.title ?? '')
  if (fromTitle) return fromTitle[1]
  const fromBody = CODE_RE.exec(note?.body ?? '') ?? BODY_CODE_RE.exec(note?.body ?? '')
  return fromBody ? fromBody[1] : null
}

/** 'Your Discord connect code: …' → 'Discord'. Used only for wording. */
function platformFromTitle(title) {
  const hit = /your\s+(\w+)\s+connect code/i.exec(title ?? '')
  return hit ? hit[1] : null
}

export default {
  name: 'code',
  aliases: ['mycode', 'linkcode', 'connectcode'],
  category: 'account',
  // You need a character to have a bell to read.
  requiresPlayer: true,
  platforms: ['whatsapp', 'discord', 'telegram'],
  description: 'Show the connect code that was sent to your notification bell',

  async run(ctx) {
    const { reply, db } = ctx
    const pr = prefixFor(ctx.platform)

    // Never in a group — see the file header.
    if (ctx.isGroup) {
      return reply(
        `🔒 *Not in a group.*\n\n` +
        `Your connect code is private — anyone reading this chat could use it ` +
        `to link their own account to your character.\n\n` +
        `DM me *${pr}code* instead.`,
      )
    }

    // ctx.from is already link-resolved by the adapters, so a linked Discord
    // account reads the master character's bell — which is the same bell the
    // code was delivered to. That is exactly the desired behaviour.
    const notes = listNotifications(db, ctx.from)
    const hit = notes.find(n => extractCode(n))

    if (!hit) {
      return reply(
        `🔍 *No connect code waiting.*\n\n` +
        `Codes only appear after you ask for one:\n\n` +
        `*1.* Open the bot on *Discord* or *Telegram*.\n` +
        `*2.* Run *${pr}connect <your username>* there.\n` +
        `*3.* Come back here and run *${pr}code* — the code will be waiting.\n\n` +
        `_Already ran it? Give it a few seconds, then try ${pr}code again._`,
      )
    }

    const code = extractCode(hit)
    const label = platformFromTitle(hit.title) ?? 'that app'
    const age = Date.now() - (hit.at ?? 0)
    const ttl = otpStats().ttlMs
    const expired = age >= ttl

    // Reading it here counts as reading it — same as opening the bell on the
    // site — so the bell dot doesn't keep nagging about a code already used.
    await markRead(db, ctx.from, hit.id).catch(() => {})

    if (expired) {
      return reply(
        `⏰ *That code has expired.*\n\n` +
        `\`${code}\` was sent ${ago(age)} and codes only last ` +
        `${minutes(ttl)} minutes.\n\n` +
        `Go back to *${label}* and run *${pr}connect <your username>* again ` +
        `for a fresh one, then run *${pr}code* here.`,
      )
    }

    const leftMs = ttl - age
    return reply(
      `🔑 *Your connect code*\n\n` +
      `┌──────────────┐\n` +
      `   *${code}*\n` +
      `└──────────────┘\n\n` +
      `Sent to your bell ${ago(age)} • expires in about ${minutes(leftMs)} minute${minutes(leftMs) === 1 ? '' : 's'}.\n\n` +
      `*Next:* go back to *${label}* and run\n` +
      `*${pr}connect ${code}*\n\n` +
      `_Didn't request this? Ignore it — nothing links until the code is entered._`,
    )
  },
}
