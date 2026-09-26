/**
 * moderation-scan.js — the per-message half of the moderation features.
 *
 * handler.js calls runModerationScans() once per inbound message, before the
 * prefix check, because none of this comes prefixed with a command: spam,
 * Channel forwards and status mentions are ordinary messages.
 *
 * It returns TRUE when the message was consumed (deleted / acted on), and the
 * handler must then stop processing it. Returning false means "nothing here,
 * carry on".
 *
 * The scans are ordered cheapest-first and share one groupMetadata() call,
 * because this runs on every single message in every group the bot is in.
 * Fetching metadata per scan would mean up to five round-trips per message.
 */
import { logger, config } from '../config.js'
import { normalizeMessageContent } from '@whiskeysockets/baileys'
import { getGroupSettings } from './group-settings.js'
import { isOwnerJid, checkBotAdmin, isGroupAdmin, containsLink } from './group-helpers.js'
import { getMute } from './moderation-state.js'
import { banUser } from './ban-repo.js'
import { isMod } from './mod-repo.js'
import {
  rememberMessage, takeMessage, findMessagesFrom, recordForSpam, resetSpamWindow,
  recordForRateBan, resetRateBan,
  addStrike, clearStrikes,
} from './message-cache.js'

const KICK_STRIKES = 3

// Antispam rate-limit auto-ban: sending RATE_BAN_COUNT COMMANDS (messages that
// begin with the command prefix) within RATE_BAN_WINDOW_SEC seconds triggers an
// account-wide TIMED ban of RATE_BAN_MS. Only prefixed commands count — ordinary
// chatter, stickers and images never trip it, so this rule targets people
// hammering the BOT, not people talking fast. It's stricter and more decisive
// than the delete+kick flood rule below: it locks the spammer out of the whole
// bot (every group + DM) for the duration, and only the bot owner or a mod can
// lift it early (see plugins/unban.js). The knobs are exported so
// plugins/antispam.js can describe the rule when it's switched on, keeping the
// on-message and the real threshold from drifting apart.
export const RATE_BAN_COUNT = 2
export const RATE_BAN_WINDOW_SEC = 3
export const RATE_BAN_MS = 30 * 60 * 1000        // 30 minutes
const RATE_BAN_REASON = `Auto-ban: spamming (${RATE_BAN_COUNT}+ commands in ${RATE_BAN_WINDOW_SEC}s)`

/**
 * Metadata failures are logged once per group per window, with a count of what
 * was swallowed, instead of once per message.
 *
 * This ran on every inbound group message, so a single rate-limited group could
 * fill the log with hundreds of identical warnings in a minute and bury the real
 * errors (a failed send, a plugin throwing) underneath them. The condition is
 * worth knowing about once; it is not worth knowing about per message.
 */
const META_WARN_EVERY_MS = 5 * 60 * 1000
const metaWarnState = new Map()

function warnMetaFailure(jid, err) {
  const now = Date.now()
  const seen = metaWarnState.get(jid)
  if (seen && now - seen.at < META_WARN_EVERY_MS) {
    seen.suppressed++
    return
  }
  metaWarnState.set(jid, { at: now, suppressed: 0 })
  logger.warn(
    { err: err.message, jid, ...(seen?.suppressed ? { alsoSuppressed: seen.suppressed } : {}) },
    'Moderation: metadata fetch failed, rules are off for this group until it recovers',
  )
}

/**
 * The real content of a message, with WhatsApp's wrapper layers peeled off.
 *
 * Channel forwards routinely arrive wrapped — a group with disappearing
 * messages turned on delivers EVERY message as
 * `ephemeralMessage.message.extendedTextMessage`, and view-once/edited
 * messages nest the same way. Reading `msg.message` directly finds only
 * `ephemeralMessage` at the top level, whose own contextInfo is empty, so the
 * forward went undetected. Baileys' own normalizer unwraps ephemeral,
 * viewOnce (+V2/V2Extension), documentWithCaption and edited messages, up to
 * 5 levels deep — using it means the shapes stay correct as WhatsApp adds new
 * wrappers.
 */
function innerContent(msg) {
  return normalizeMessageContent(msg?.message) ?? msg?.message ?? {}
}

/**
 * Every contextInfo reachable in a message, including the one on a quoted
 * message. Forwarding a Channel post *as a reply* puts the newsletter marker
 * on the quoted content, not the top-level message.
 */
function* contextInfos(inner) {
  for (const value of Object.values(inner)) {
    if (!value || typeof value !== 'object') continue
    const ci = value.contextInfo
    if (!ci) continue
    yield ci
    const quoted = ci.quotedMessage
    if (quoted && typeof quoted === 'object') {
      for (const qv of Object.values(quoted)) {
        if (qv && typeof qv === 'object' && qv.contextInfo) yield qv.contextInfo
      }
    }
  }
}

/**
 * Every scrap of sender-authored text a message carries, joined with newlines,
 * for the antilink scan to search.
 *
 * `body` alone is not enough. handler.js reads text off the RAW message, so:
 *   - in a disappearing-messages group every message arrives wrapped in
 *     ephemeralMessage and `body` comes through empty,
 *   - an image/video/document posted WITH a caption carries its link in
 *     `imageMessage.caption`, which `body` never sees,
 *   - a button/list/template reply carries it in its own field.
 * Each of those is the obvious way to post a link past a body-only check, so
 * all of them are collected here.
 *
 * A quoted message is deliberately NOT included: quoting someone else's link
 * would otherwise get the person REPLYING kicked for text they didn't write.
 */
function linkText(msg, body) {
  const inner = innerContent(msg)
  const parts = [
    body,
    inner.conversation,
    inner.extendedTextMessage?.text,
    inner.imageMessage?.caption,
    inner.videoMessage?.caption,
    inner.documentMessage?.caption,
    inner.documentMessage?.fileName,
    inner.audioMessage?.caption,
    inner.buttonsMessage?.contentText,
    inner.buttonsResponseMessage?.selectedDisplayText,
    inner.templateButtonReplyMessage?.selectedDisplayText,
    inner.listResponseMessage?.title,
    inner.interactiveResponseMessage?.body?.text,
    inner.productMessage?.product?.title,
    inner.locationMessage?.name,
    inner.contactMessage?.vcard,
  ]
  return parts.filter(Boolean).join('\n')
}

/** Deletes a message. Best-effort — needs the bot to be a group admin. */
async function deleteMessage(sock, sender, msg, from, label) {
  return sock.sendMessage(sender, {
    delete: { remoteJid: sender, fromMe: false, id: msg.key.id, participant: from },
  }).then(() => true).catch(err => {
    logger.warn({ err: err.message, label, jid: sender }, 'Moderation: delete failed')
    return false
  })
}

/**
 * Same delete as deleteMessage, but by a bare message id instead of a full
 * msg object — for cleaning up OTHER cached messages from a sender (see
 * findMessagesFrom in message-cache.js), where all that's on hand is the
 * id, not the original message.
 */
async function deleteMessageById(sock, sender, id, from, label) {
  return sock.sendMessage(sender, {
    delete: { remoteJid: sender, fromMe: false, id, participant: from },
  }).then(() => true).catch(err => {
    logger.warn({ err: err.message, label, jid: sender, id }, 'Moderation: delete-by-id failed')
    return false
  })
}

async function kickMember(sock, sender, from, label) {
  return sock.groupParticipantsUpdate(sender, [from], 'remove')
    .then(() => true).catch(err => {
      logger.warn({ err: err.message, label, jid: sender }, 'Moderation: kick failed')
      return false
    })
}

/** True when the message body/context looks like a WhatsApp Channel forward. */
export function isChannelForward(msg) {
  const inner = innerContent(msg)

  // forwardedNewsletterMessageInfo is set only on Channel-origin content —
  // an ordinary forward has forwardingScore instead, which is why that field
  // is deliberately NOT checked here (it would catch every normal forward).
  for (const ci of contextInfos(inner)) {
    if (ci.forwardedNewsletterMessageInfo) return true
  }

  // A Channel invite is Channel content too, and carries no contextInfo.
  if (inner.newsletterAdminInviteMessage) return true

  // Some clients relay a Channel post with the newsletter jid on the key
  // instead of a newsletter marker in contextInfo. `@newsletter` is the
  // server for Channels, the way `@g.us` is for groups.
  const origin = msg?.key?.remoteJid ?? ''
  if (typeof origin === 'string' && origin.endsWith('@newsletter')) return true

  return false
}

/**
 * True when the message is a status-mention notification.
 *
 * Two shapes reach a group: content relayed from status@broadcast, and a
 * groupMentions entry (WhatsApp's "mentioned this group in a status").
 */
export function isStatusMention(msg, sender) {
  if (msg.key?.remoteJid === 'status@broadcast') return true
  const inner = innerContent(msg)
  for (const ci of contextInfos(inner)) {
    if (ci.remoteJid === 'status@broadcast') return true
    if (Array.isArray(ci.groupMentions) && ci.groupMentions.length > 0) return true
  }
  return false
}

/**
 * Antidelete capture. Called for every group message so a later revoke has
 * something to repost. Text-only by design: re-uploading media would mean
 * downloading and buffering every image in every group, which is a lot of
 * disk and bandwidth for a moderation nicety.
 */
export function cacheForAntidelete(msg, sender, from, body) {
  if (!msg.key?.id) return
  const inner = innerContent(msg)
  const mediaKind =
    inner.imageMessage ? 'an image'
    : inner.videoMessage ? 'a video'
    : inner.audioMessage ? 'a voice note'
    : inner.stickerMessage ? 'a sticker'
    : inner.documentMessage ? 'a document'
    : null

  // handler.js reads text off the raw message, so a disappearing-message group
  // hands us an empty body for what is really a normal text message. Recover
  // it from the unwrapped content rather than dropping the message from the
  // cache entirely.
  const text = body || inner.conversation || inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption || inner.videoMessage?.caption || ''

  if (!text && !mediaKind) return
  rememberMessage(msg.key.id, { sender, from, body: text, media: mediaKind })
}

/**
 * Handles a message-revoke event. `msg` here is the protocolMessage wrapper,
 * not the deleted message — the original comes out of the cache.
 * Returns true when a repost was sent.
 */
export async function handleRevocation(sock, msg) {
  const revoke = msg.message?.protocolMessage
  if (revoke?.type !== 0 && revoke?.type !== 'REVOKE') return false

  const sender = msg.key?.remoteJid
  if (!sender?.endsWith('@g.us')) return false

  const settings = await getGroupSettings(sender).catch(() => null)
  if (!settings?.antidelete) return false

  const original = takeMessage(revoke.key?.id)
  if (!original) return false

  // Don't repost the bot's own deletions — antilink/antispam/mute all delete
  // messages, and reposting what moderation just removed defeats both.
  const deleter = msg.key.participant ?? sender
  if (original.from !== deleter && !isOwnerJid(deleter)) {
    // An admin deleting someone else's message is a moderation action; only
    // self-deletes are the "they took it back" case antidelete is for.
    return false
  }

  const tag = `@${String(original.from).replace(/@.*$/, '')}`
  const text =
    `♻️ *DELETED MESSAGE*\n─────────────────────\n` +
    `${tag} deleted this:\n\n` +
    (original.body ? `_${original.body.slice(0, 900)}_` : `_(${original.media})_`) +
    (original.media && original.body ? `\n\n_(with ${original.media})_` : '')

  await sock.sendMessage(sender, { text, mentions: [original.from] })
    .catch(err => logger.warn({ err: err.message }, 'Antidelete: repost failed'))
  return true
}
// ── The main scan ────────────────────────────────────────────────────────

/**
 * Runs every enabled per-message moderation rule for one group message.
 *
 * Returns true when the message was consumed and the handler must stop.
 *
 * Order matters: identity checks (owner/admin) happen ONCE and gate all the
 * destructive rules, then rules run cheapest-first. Group metadata is fetched
 * lazily and at most once — most messages in most groups trip nothing, and
 * this runs on all of them.
 */
export async function runModerationScans({ sock, db, msg, sender, from, body, isGroup }) {
  if (!isGroup) return false

  let settings
  try {
    settings = await getGroupSettings(sender)
  } catch (err) {
    logger.warn({ err: err.message, jid: sender }, 'Moderation: settings read failed')
    return false
  }

  // Cache the message for antidelete before anything can delete it.
  if (settings.antidelete) cacheForAntidelete(msg, sender, from, body)

  const anyEnabled = settings.grouplock || settings.antilink || settings.antispam ||
    settings.antichannel || settings.antistatus
  const muted = await getMute(sender, from).catch(() => null)
  if (!anyEnabled && !muted) return false

  // The bot owner is exempt from all of it, always.
  if (isOwnerJid(from)) return false

  // One metadata fetch, shared by every rule below.
  let senderIsAdmin = false
  let botIsAdmin = false
  try {
    const { isAdmin, meta } = await checkBotAdmin(sock, sender)
    botIsAdmin = isAdmin
    // isGroupAdmin() rather than a direct `pt.id === from` comparison: a group
    // may address participants by lid while `from` arrives as a phone number (or
    // vice versa), and either side may carry a `:device` suffix. A plain equality
    // check misses the match whenever the two formats differ, and for antilink
    // that means deleting a real admin's message and removing them from their
    // own group.
    senderIsAdmin = isGroupAdmin(meta, from)
  } catch (err) {
    warnMetaFailure(sender, err)
    return false
  }

  // Group admins are exempt from every rule here. Mute is the one exception
  // in spirit but not in practice — mute.js already refuses to mute an admin.
  if (senderIsAdmin) return false

  // Nothing below can act without admin rights. Warn once per rule rather
  // than silently doing nothing, which is indistinguishable from "off".
  const warnNoAdmin = async (label) => {
    await sock.sendMessage(sender, {
      text: `⚠️ ${label} caught something but I'm not an admin here, so I can't delete it. Please make me a group admin.`,
    }).catch(() => {})
  }

  // ── Mute ────────────────────────────────────────────────────────────────
  // Silent by design: a muted person's messages vanish with no announcement.
  if (muted) {
    if (!botIsAdmin) return false
    await deleteMessage(sock, sender, msg, from, 'mute')
    return true
  }

  // ── Group lock ──────────────────────────────────────────────────────────
  if (settings.grouplock) {
    if (!botIsAdmin) { await warnNoAdmin('Group lock'); return true }
    await deleteMessage(sock, sender, msg, from, 'grouplock')
    return true
  }

  // ── Antilink ────────────────────────────────────────────────────────────
  // Delete the link, clean up the sender's other recent messages, kick.
  //
  // This lives here, alongside the other destructive rules, rather than inline
  // in handler.js where it used to. Three things came with the move: the
  // owner/admin exemptions above are now shared instead of re-implemented (the
  // inline version compared `pt.id === from` only, so it kicked admins in any
  // group using a different addressing mode than the incoming jid), captions and
  // ephemeral wrappers are scanned via linkText(), and the whole rule now
  // respects the same "bot isn't an admin" reporting as everything else.
  if (settings.antilink && containsLink(linkText(msg, body))) {
    if (!botIsAdmin) { await warnNoAdmin('Antilink'); return true }

    const deleted = await deleteMessage(sock, sender, msg, from, 'antilink')
    const kicked  = await kickMember(sock, sender, from, 'antilink')

    // Same recent-message cleanup as antichannel below, for the same reason: a
    // link spammer rarely posts exactly one. This only reaches ids still inside
    // message-cache.js's own recency window — it is not a history purge.
    const otherIds = findMessagesFrom(sender, from).filter(id => id !== msg.key.id)
    let extraDeleted = 0
    for (const id of otherIds) {
      const ok = await deleteMessageById(sock, sender, id, from, 'antilink')
      if (ok) { extraDeleted++; takeMessage(id) }
    }

    // Delete and kick are reported separately: "it half-worked" is a real and
    // common outcome (bot demoted mid-action, member already left).
    const tag = `@${from.replace(/@.*$/, '')}`
    const extraNote = extraDeleted > 0 ? ` (+${extraDeleted} more of their recent messages cleaned up)` : ''
    await sock.sendMessage(sender, {
      text: deleted && kicked
        ? `🔗 Link removed and ${tag} was kicked.${extraNote}`
        : `⚠️ Antilink triggered on ${tag} but ` +
          (!deleted && !kicked ? 'both the delete and the kick failed'
           : !deleted ? 'the delete failed (kick succeeded)'
           : 'the kick failed (delete succeeded)') + `. Check my admin permissions.${extraNote}`,
      mentions: [from],
    }).catch(() => {})
    return true
  }

  // ── Antichannel ─────────────────────────────────────────────────────────
  if (settings.antichannel && isChannelForward(msg)) {
    if (!botIsAdmin) { await warnNoAdmin('Antichannel'); return true }

    const deleted = await deleteMessage(sock, sender, msg, from, 'antichannel')
    const kicked  = await kickMember(sock, sender, from, 'antichannel')

    // Beyond the single triggering forward, clean up whatever else this
    // sender has posted in this group recently — a Channel-forward spammer
    // rarely sends just one. Pulls from the same cache antidelete already
    // maintains (see message-cache.js's findMessagesFrom), so this only
    // reaches messages still inside that cache's own recency window, not a
    // full account history. msg.key.id is excluded since deleteMessage
    // above already handled that one — no point trying it twice.
    const otherIds = findMessagesFrom(sender, from).filter(id => id !== msg.key.id)
    let extraDeleted = 0
    for (const id of otherIds) {
      const ok = await deleteMessageById(sock, sender, id, from, 'antichannel')
      if (ok) { extraDeleted++; takeMessage(id) }
    }

    // Delete and kick are reported separately — "it half-worked" is a real
    // and common outcome (bot demoted mid-action, participant already gone).
    const extraNote = extraDeleted > 0 ? ` (+${extraDeleted} more of their recent messages cleaned up)` : ''
    await sock.sendMessage(sender, {
      text: deleted && kicked
        ? `📢 Channel forward removed and @${from.replace(/@.*$/, '')} was kicked.${extraNote}`
        : `⚠️ Antichannel triggered on @${from.replace(/@.*$/, '')} but ` +
          (!deleted && !kicked ? 'both the delete and the kick failed'
           : !deleted ? 'the delete failed (kick succeeded)'
           : 'the kick failed (delete succeeded)') + `. Check my admin permissions.${extraNote}`,
      mentions: [from],
    }).catch(() => {})
    return true
  }

  // ── Antistatus ──────────────────────────────────────────────────────────
  // Delete only. No kick — see plugins/antistatus.js for why.
  if (settings.antistatus && isStatusMention(msg, sender)) {
    if (!botIsAdmin) { await warnNoAdmin('Antistatus'); return true }
    const deleted = await deleteMessage(sock, sender, msg, from, 'antistatus')
    if (!deleted) {
      await sock.sendMessage(sender, {
        text: `⚠️ Antistatus caught a status mention from @${from.replace(/@.*$/, '')} but the delete failed. Check my admin permissions.`,
        mentions: [from],
      }).catch(() => {})
    }
    return true
  }

  // ── Antispam rate-limit auto-ban ─────────────────────────────────────────
  // Hard burst rule, separate from the tunable flood rule below: too many
  // COMMANDS too fast → an account-wide timed ban. Only messages that begin
  // with the command prefix count (the same test the handler uses to decide a
  // message is a command) — ordinary chatter, stickers and images are ignored,
  // so this targets people spamming the bot rather than fast talkers. Mods are
  // exempt — they're trusted (owner + group admins already returned above), and
  // auto-banning someone who can unban others is silly. The ban itself needs no
  // group-admin rights (it's enforced at the command gate in handler.js, not by
  // WhatsApp); only the tidy-up delete does.
  if (settings.antispam && !isMod(db, from) && body && body.startsWith(config.prefix)) {
    const tripped = recordForRateBan(sender, from, {
      count: RATE_BAN_COUNT, windowSec: RATE_BAN_WINDOW_SEC,
    })
    if (tripped) {
      await banUser(db, from, null, RATE_BAN_REASON, {
        expiresAt: Date.now() + RATE_BAN_MS, auto: true,
      })
      resetRateBan(sender, from)
      if (botIsAdmin) await deleteMessage(sock, sender, msg, from, 'antispam-rateban')

      const mins = Math.round(RATE_BAN_MS / 60000)
      await sock.sendMessage(sender, {
        text:
          `🚫 @${from.replace(/@.*$/, '')} is *banned for ${mins} minutes* for command spam ` +
          `(${RATE_BAN_COUNT} commands in ${RATE_BAN_WINDOW_SEC}s).\n` +
          `_It lifts on its own when the time's up — only the bot owner or a mod can undo it sooner._`,
        mentions: [from],
      }).catch(() => {})
      return true
    }
  }

  // ── Antispam ────────────────────────────────────────────────────────────
  if (settings.antispam && body) {
    const verdict = recordForSpam(sender, from, body, {
      count: settings.antispamCount,
      windowSec: settings.antispamWindow,
    })
    if (!verdict.spam) return false

    if (!botIsAdmin) { await warnNoAdmin('Antispam'); return true }

    await deleteMessage(sock, sender, msg, from, 'antispam')
    resetSpamWindow(sender, from)

    const strikes = addStrike(sender, from)

    if (settings.antispamKick && strikes >= KICK_STRIKES) {
      const kicked = await kickMember(sock, sender, from, 'antispam')
      clearStrikes(sender, from)
      await sock.sendMessage(sender, {
        text: kicked
          ? `🚨 @${from.replace(/@.*$/, '')} was removed for spamming (${strikes} strikes).`
          : `⚠️ @${from.replace(/@.*$/, '')} hit ${strikes} spam strikes but the kick failed. Check my admin permissions.`,
        mentions: [from],
      }).catch(() => {})
    } else {
      await sock.sendMessage(sender, {
        text:
          `🚨 @${from.replace(/@.*$/, '')} — slow down. ` +
          `${verdict.kind === 'duplicate' ? 'Repeated message' : 'Too many messages'} deleted.` +
          (settings.antispamKick ? ` _Strike ${strikes}/${KICK_STRIKES}._` : ''),
        mentions: [from],
      }).catch(() => {})
    }
    return true
  }

  return false
}

