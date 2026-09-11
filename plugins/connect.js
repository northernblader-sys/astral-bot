/**
 * connect.js — link this Discord/Telegram account to an existing Astral
 * character, so you play ONE character everywhere.
 *
 *   .connect                 — explain everything, show current status
 *   .connect <username>      — send a 6-digit code to that account's site bell
 *   .connect <code>          — enter the code to finish linking
 *   .connect remove          — unlink this account
 *
 * `.link` is an alias, because that's the other word people reach for.
 *
 * WHY THE CODE GOES TO THE SITE, NOT A DM: proving you can read the
 * notification bell on playastral for that character is what proves the
 * character is yours. It also needs no WhatsApp socket, so linking works from
 * a Discord-only or Telegram-only process where no Baileys connection exists.
 *
 * requiresPlayer is FALSE by necessity — someone linking has no character on
 * this platform yet, which is the entire point.
 */
import { config } from '../config.js'
import { getPlayer } from '../lib/player-repo.js'
import { pushNotification } from '../lib/notification-repo.js'
import {
  findPlayerByUsername, linkAccount, unlinkAccount, getLink,
  listLinksFor, isMasterId, isSeparateRoster,
} from '../lib/account-link.js'
import { checkRateLimit, issue, verify, discard, peek, hasPending } from '../lib/link-otp.js'

const SITE = config.siteUrl

/** A 4–8 digit run is a code attempt; anything else is treated as a username. */
const CODE_RE = /^\d{4,8}$/

const PLATFORM_LABEL = { discord: 'Discord', telegram: 'Telegram' }

/**
 * The prefix a player on this platform actually types. Telegram accepts both
 * `/` and `.` (see the adapter's parseCommand call), but `/` is what its UI
 * autocompletes, so showing `.` there would teach the wrong thing.
 */
function prefixFor(platform) {
  return platform === 'telegram' ? config.telegramPrefix : config.prefix
}

function minutes(ms) {
  return Math.max(1, Math.round(ms / 60_000))
}

/** The full explainer — shown for bare `.connect` and whenever input is wrong. */
function helpText(ctx, pr) {
  const label = PLATFORM_LABEL[ctx.platform] ?? 'this app'
  return (
    `🔗 *Connect your Astral account*\n\n` +
    `Link this ${label} account to your existing character so your level, ` +
    `Solars, inventory and waifus are the *same* here as on WhatsApp and the site.\n\n` +

    `*━━ If you already have a character ━━*\n\n` +
    `*1.* ${pr}connect <your username>\n` +
    `_Example: ${pr}connect epicpse_\n\n` +
    `*2.* We send a 6-digit code to your notification bell 🔔. Read it either ` +
    `by DMing the bot *${config.prefix}code* on WhatsApp, or by logging in at ` +
    `${SITE} and tapping the bell.\n\n` +
    `*3.* ${pr}connect <the code>\n` +
    `_Example: ${pr}connect 481920_\n\n` +

    `*━━ If you DON'T have a character yet ━━*\n\n` +
    `Create one first — you can't link to an account that doesn't exist:\n\n` +
    `*1.* Go to ${SITE} and sign up.\n` +
    `*2.* Pick a username on the site (or with *${pr}username add <name>* on WhatsApp).\n` +
    `*3.* Come back here and run *${pr}connect <your username>*.\n\n` +

    `*━━ Other ━━*\n\n` +
    `*${pr}connect* — show this message and your status\n` +
    `*${pr}connect remove* — unlink this ${label} account\n\n` +
    `_Don't know your username? Run *${pr}username* on WhatsApp, or check your profile on the site._`
  )
}

export default {
  name: 'connect',
  aliases: ['link'],
  category: 'account',
  // Must stay false: the whole point is being used before you have a
  // character on this platform.
  requiresPlayer: false,
  // 'whatsapp' is listed even though there is nothing to link FROM there: the
  // run() below opens with a WhatsApp-specific branch that explains where to
  // run this instead. Now that dispatch() enforces this list per-command
  // (lib/plugin-manager.js), omitting 'whatsapp' would turn that explainer into
  // "Unknown command .connect" for the exact people who need it.
  platforms: ['whatsapp', 'discord', 'telegram'],
  description: 'Link this account to your Astral character from the website',

  async run(ctx) {
    const { args, reply, db } = ctx
    const pr = prefixFor(ctx.platform)
    const platformId = ctx.platformId
    const label = PLATFORM_LABEL[ctx.platform] ?? 'this app'
    const input = (args[0] ?? '').trim()
    const sub = input.toLowerCase()

    // In `start:all` the registry is shared across platforms, so a WhatsApp
    // player can reach this command (see the note in main-all.js). They're
    // already the master account — there's nothing to link *from* — so point
    // them at the platform where it belongs instead of failing blankly.
    if (!platformId || isMasterId(platformId)) {
      return reply(
        `🔗 *Connect is for Discord & Telegram.*\n\n` +
        `Your WhatsApp account is already your main Astral character — ` +
        `it's the one other platforms link *to*.\n\n` +
        `*To play the same character on Discord or Telegram:*\n` +
        `1. Make sure you have a username here — run *${config.prefix}username*.\n` +
        `2. Open the bot on Discord or Telegram.\n` +
        `3. Run *${config.prefix}connect <your username>* over there.\n` +
        `4. Come back here and run *${config.prefix}code* to read the 6-digit code ` +
        `(or read it from your 🔔 bell on ${SITE}).\n` +
        `5. Enter it back on Discord/Telegram with *${config.prefix}connect <code>*.`,
      )
    }

    const existing = getLink(db, platformId)

    // ── .connect ── explainer + status ──────────────────────────────────────
    if (!input) {
      let status = ''

      if (existing) {
        const linked = getPlayer(db, existing.masterId)
        const name = linked?.username ? `@${linked.username}` : (linked?.name ?? 'your character')
        status =
          `\n\n*━━ Current status ━━*\n\n` +
          `✅ This ${label} account is linked to *${name}*.\n` +
          `_Everything you do here affects that one character._\n` +
          `Unlink with *${pr}connect remove*.`
      } else if (hasPending(platformId)) {
        const open = peek(platformId)
        status =
          `\n\n*━━ Current status ━━*\n\n` +
          `⏳ A code is waiting for *@${open.username}*.\n` +
          `Read it by DMing the bot *${config.prefix}code* on WhatsApp, or from ` +
          `your 🔔 bell on ${SITE} — then run *${pr}connect <code>*.`
      } else {
        status =
          `\n\n*━━ Current status ━━*\n\n` +
          `❌ Not linked yet — you're playing a separate ${label} character.`
      }

      return reply(helpText(ctx, pr) + status)
    }

    // ── .connect remove ─────────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'unlink' || sub === 'disconnect') {
      discard(platformId)
      if (!existing) {
        return reply(
          `⚠️ This ${label} account isn't linked to anything.\n\n` +
          `Link it with *${pr}connect <your username>*.`,
        )
      }
      const linked = getPlayer(db, existing.masterId)
      const name = linked?.username ? `@${linked.username}` : 'your character'
      await unlinkAccount(db, platformId)
      return reply(
        `🔓 *Unlinked from ${name}.*\n\n` +
        `This ${label} account is now on its own separate character again. ` +
        `Your ${name} progress is untouched — relink any time with ` +
        `*${pr}connect <your username>*.`,
      )
    }

    // ── .connect <code> ── finish an open challenge ─────────────────────────
    if (CODE_RE.test(input)) {
      if (!hasPending(platformId)) {
        return reply(
          `⚠️ *No code is waiting.*\n\n` +
          `Start with *${pr}connect <your username>* and we'll send one to ` +
          `your 🔔 bell on ${SITE}.`,
        )
      }

      const result = verify(platformId, input)

      if (!result.ok) {
        if (result.reason === 'expired') {
          return reply(
            `⏰ *That code expired.*\n\n` +
            `Run *${pr}connect <your username>* again for a fresh one.`,
          )
        }
        if (result.reason === 'too_many_attempts') {
          return reply(
            `🚫 *Too many wrong tries.*\n\n` +
            `That code is dead. Request a new one with ` +
            `*${pr}connect <your username>* — wait a minute first.`,
          )
        }
        if (result.reason === 'not_found') {
          return reply(`⚠️ No code is waiting. Start with *${pr}connect <your username>*.`)
        }
        return reply(
          `❌ *Wrong code.* ${result.attemptsLeft} ` +
          `${result.attemptsLeft === 1 ? 'try' : 'tries'} left.\n\n` +
          `Check the 🔔 bell on ${SITE} for the latest one.`,
        )
      }

      // Re-check the target still exists — it could have been deleted in the
      // minutes between issuing the code and this call.
      const target = getPlayer(db, result.masterId)
      if (!target) {
        return reply(`⚠️ That character no longer exists. Start again with *${pr}connect <username>*.`)
      }

      await linkAccount(db, platformId, result.masterId)

      await pushNotification(db, result.masterId, {
        kind: 'security',
        title: `${label} account linked`,
        body: `A ${label} account was connected to your character. If this wasn't you, run "${pr}connect remove" there, or contact support.`,
      }).catch(() => {})

      const name = target.username ? `@${target.username}` : (target.name ?? 'your character')
      return reply(
        `✅ *Connected!*\n\n` +
        `This ${label} account now plays as *${name}*.\n\n` +
        `Level, Solars, inventory, waifus and season progress are shared with ` +
        `WhatsApp and the site — one character, everywhere.\n\n` +
        `Try *${pr}profile* to see it.`,
      )
    }

    // ── .connect <username> ── issue a challenge ────────────────────────────
    const username = input.replace(/^@/, '')

    if (existing) {
      const linked = getPlayer(db, existing.masterId)
      const name = linked?.username ? `@${linked.username}` : 'a character'
      return reply(
        `⚠️ *Already linked to ${name}.*\n\n` +
        `Unlink first with *${pr}connect remove*, then connect to a different account.`,
      )
    }

    // A separate-roster deploy can't see WhatsApp characters at all — say so
    // plainly instead of reporting "no such username", which sends people off
    // to re-check a username that is perfectly correct.
    if (isSeparateRoster(db)) {
      return reply(
        `⚠️ *Linking isn't available on this bot.*\n\n` +
        `This ${label} bot runs its own separate roster, so there are no ` +
        `WhatsApp characters here to link to. Your ${label} character stands alone.\n\n` +
        `_Bot owner: run the bot with_ *npm run start:all* _to share one ` +
        `character across all platforms._`,
      )
    }

    const target = findPlayerByUsername(db, username)
    if (!target) {
      return reply(
        `❌ *No character found with the username @${username}.*\n\n` +
        `*Check:*\n` +
        `• Spelling — usernames are exact (but not case-sensitive).\n` +
        `• That you actually reserved one. On WhatsApp run *${pr}username* to see yours.\n\n` +
        `*No character yet?* Create one at ${SITE} first, pick a username, ` +
        `then come back and run *${pr}connect <username>*.`,
      )
    }

    // Someone else's account can't be hijacked here — the code lands in THEIR
    // bell, so an attacker gets nothing. But refuse loudly anyway rather than
    // spamming a stranger's notifications on demand.
    const already = listLinksFor(db, target.id).filter(l => l.platform === ctx.platform)
    if (already.length) {
      return reply(
        `⚠️ *@${target.username} already has a ${label} account linked.*\n\n` +
        `If that's you, run *${pr}connect remove* from that account first. ` +
        `If it isn't, contact support — someone else may be using your character.`,
      )
    }

    const gate = checkRateLimit(platformId)
    if (!gate.ok) {
      const wait = gate.reason === 'cooldown'
        ? `Wait ${Math.ceil(gate.retryAfterMs / 1000)}s and try again.`
        : `Try again in about ${minutes(gate.retryAfterMs)} minutes.`
      return reply(`⏳ *Slow down.* ${wait}`)
    }

    const { code, ttlMs } = issue(platformId, { masterId: target.id, username: target.username })

    const delivered = await pushNotification(db, target.id, {
      kind: 'security',
      title: `Your ${label} connect code: ${code}`,
      body: `Enter this code in ${label} with "${pr}connect ${code}" to link that account to your character. It expires in ${minutes(ttlMs)} minutes. If you didn't request this, ignore it — nothing has changed.`,
    }).catch(() => null)

    if (!delivered) {
      // Never leave a live code behind that the player can't see.
      discard(platformId)
      return reply(`⚠️ Couldn't send the code right now. Please try again in a moment.`)
    }

    return reply(
      `📨 *Code sent to @${target.username}.*\n\n` +
      `*Where to find it — pick either:*\n\n` +
      `🅐 *In WhatsApp (fastest)*\n` +
      `DM the bot *${config.prefix}code* — it reads the code straight out of ` +
      `your bell for you.\n\n` +
      `🅑 *On the site*\n` +
      `Open ${SITE}, log in as *@${target.username}*, tap the 🔔 bell (top-right) — ` +
      `your 6-digit code is the newest notification.\n\n` +
      `*Then come back here and run:*\n` +
      `*${pr}connect <the code>*   _e.g. ${pr}connect 481920_\n\n` +
      `⏰ Expires in ${minutes(ttlMs)} minutes • 5 tries\n` +
      `_Didn't request this? Ignore it — nothing changes until the code is entered._`,
    )
  },
}
