/**
 * group-helpers.js — small shared helpers used by the individual group
 * command plugins (botadmin.js, kick.js, add.js, antilink.js, welcome.js,
 * setwelcome.js, goodbye.js, setgoodbye.js). Not a plugin itself — just
 * plumbing so those files don't duplicate the same JID logic five times.
 */
import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { toPlayerId } from './platform/identity.js'
import { resolveLinkedId } from './account-link.js'

export const NOT_GROUP   = '❌ This command only works in groups.'
export const NOT_ALLOWED = '❌ Only group admins or the bot owner can use this.'

/**
 * ── Link detection ────────────────────────────────────────────────────────
 *
 * Shared by every platform's antilink: WhatsApp's scan in lib/moderation-scan.js
 * and the Discord/Telegram equivalents, so "what counts as a link" can never
 * quietly drift between them.
 *
 * The penalty for a hit is an IRREVERSIBLE KICK, so the design goal is not
 * "match as much as possible" — it is "never fire on ordinary chat". Everything
 * below is built around that:
 *
 *   Tier 1  an explicit scheme (http://, ftp://, tg://) or a `www.` prefix.
 *           Unambiguous; nobody types these by accident.
 *   Tier 2  a known invite/shortener host (chat.whatsapp.com, t.me, discord.gg,
 *           bit.ly, youtu.be, ...). These exist as their own tier because their
 *           TLDs (.me/.ly/.gg/.to/.ee) are ordinary English words and so are NOT
 *           safe to match generically.
 *   Tier 3  a bare domain whose TLD is on SAFE_TLDS — `example.com` with no
 *           scheme and no path.
 *   Tier 4  anything shaped like `host.tld/path`. The required `/` is what makes
 *           the risky short TLDs safe to accept here, so `bit.ly/3xK` is caught
 *           while a bare `ok.so` is not.
 *
 * WHY THE TLD LIST IS SPLIT. Huge numbers of TLDs are also common English words
 * — .in .it .so .me .to .at .no .is .best .live .link .work .app .one .news
 * .today. Accepting those as bare domains means "I'm done. Best regards" or
 * "call me. In the morning" typed without a space after the full stop gets a
 * member removed from the group. So SAFE_TLDS deliberately contains only
 * domain-flavoured TLDs, and every word-like TLD is reachable only through
 * Tier 2 (a specific known host) or Tier 4 (a path is present).
 */

// Invisible characters used to break up a URL so a naive regex misses it.
const INVISIBLES_RE = /[​-‍⁠﻿­]/g

// Dot lookalikes: ideographic full stop, fullwidth/halfwidth full stop, one-dot
// leader. Deliberately NOT the middle dot (·), which people use decoratively.
const LOOKALIKE_DOTS_RE = /[。．｡․‧]/g

/**
 * Undoes deliberate obfuscation WITHOUT touching ordinary punctuation.
 *
 * The whitespace around an explicit marker like "(dot)" is consumed on purpose:
 * the writer's stated intent is a dot, so "foo (dot) com" must become "foo.com"
 * rather than "foo . com". Plain full stops are left exactly as typed — see the
 * TLD note above for why collapsing those would start kicking people.
 */
function deobfuscate(text) {
  return String(text ?? '')
    .replace(INVISIBLES_RE, '')
    .replace(LOOKALIKE_DOTS_RE, '.')
    // hxxp / h**p / h##p → http
    .replace(/h[x*#]{2}p/gi, 'http')
    // "foo (dot) com", "foo [dot] com", "foo{d0t}com", "foo[.]com"
    .replace(/\s*[([{<]\s*(?:dot|d0t|punto)\s*[)\]}>]\s*/gi, '.')
    .replace(/\s*[([{<]\s*\.\s*[)\]}>]\s*/gi, '.')
    // " dot " spelled out between two labels
    .replace(/([a-z0-9])\s+(?:dot|d0t)\s+([a-z0-9])/gi, '$1.$2')
    // "(slash)" / "[slash]"
    .replace(/\s*[([{<]\s*slash\s*[)\]}>]\s*/gi, '/')
    // "https : / / foo" → "https://foo"
    .replace(/:\s*\/\s*\//g, '://')
}

/**
 * Additionally removes whitespace hugging a dot. Safe ONLY for the known-host
 * tier, where the result has to match a specific multi-part hostname — no
 * English sentence accidentally spells "chat.whatsapp.com". Applying this to the
 * generic bare-domain tiers is what would turn "I'm done. Best regards" into a
 * kick, so it is used nowhere else.
 */
function collapseDots(text) {
  return deobfuscate(text).replace(/\s*\.\s*/g, '.')
}

// ── Tier 1: explicit schemes and www. ──────────────────────────────────────
const SCHEME_RE = /\b(?:https?|ftps?|sftp|tg|whatsapp|discord|magnet):(?:\/\/|\?)/i
const WWW_RE    = /\bwww\d{0,3}\.[a-z0-9-]{1,63}\.[a-z]{2,24}/i

// ── Tier 2: invite domains and URL shorteners ─────────────────────────────
// Matched against the dot-collapsed text. Every entry here is either an invite
// host or a shortener whose TLD is too word-like to accept generically.
const KNOWN_HOSTS = [
  // messaging invites
  'chat.whatsapp.com', 'wa.me', 'whatsapp.com', 'call.whatsapp.com',
  't.me', 'telegram.me', 'telegram.dog', 'telegra.ph',
  'discord.gg', 'discord.com', 'discordapp.com', 'dsc.gg',
  'signal.group', 'join.skype.com', 'line.me', 'kakao.com',
  // shorteners / link-in-bio
  'bit.ly', 'bitly.com', 'tinyurl.com', 'goo.gl', 't.co', 'is.gd', 'v.gd',
  'cutt.ly', 'rb.gy', 'rebrand.ly', 'ow.ly', 'buff.ly', 'adf.ly', 'shorte.st',
  'bc.vc', 'linktr.ee', 'lnk.bio', 'beacons.ai', 'shorturl.at', 'tiny.cc',
  's.id', 'gg.gg', 'clck.ru', 'vk.cc', 'qr.ae', 'trib.al', 'youtu.be',
  // file hosts commonly used to route around a link ban
  'mega.nz', 'gofile.io', 'anonfiles.com', 'mediafire.com', 'terabox.com',
  '1024terabox.com', 'pixeldrain.com', 'krakenfiles.com',
  // social, non-.com forms (the .com forms are caught by SAFE_TLDS anyway)
  'instagr.am', 'fb.me', 'fb.watch', 'vm.tiktok.com', 'x.com', 'reddit.app.link',
]

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// No leading boundary: the dot-collapsed text has had spacing removed, so a
// leading \b would stop "visit bit.ly/x" (now "visitbit.ly/x") from matching.
// The trailing lookahead is what keeps it honest — "rabbit.lyrics" is not a hit.
const KNOWN_HOST_RE = new RegExp(
  `(?:${KNOWN_HOSTS.map(escapeRe).join('|')})(?![a-z0-9-])`, 'i',
)

// ── Tier 3: bare domains on a domain-flavoured TLD ────────────────────────
// Nothing here is a common English word, because a bare domain needs no path
// and therefore gets no second signal. Word-like TLDs live in Tier 4 instead.
const SAFE_TLDS = [
  // generic
  'com', 'net', 'org', 'info', 'biz', 'gov', 'edu', 'int', 'mil',
  // domain-flavoured gTLDs
  'xyz', 'online', 'website', 'webcam', 'tech', 'digital', 'cloud', 'agency',
  'studio', 'ltd', 'llc', 'inc', 'corp', 'company', 'solutions', 'services',
  'network', 'systems', 'software', 'computer', 'institute', 'university',
  // TLDs that exist mostly for spam
  'icu', 'cyou', 'sbs', 'cfd', 'buzz', 'vip', 'wtf', 'ooo', 'gdn', 'wang',
  'xin', 'autos', 'lat', 'kim',
  // two-letter ccTLDs that are not English words
  'io', 'co', 'tv', 'cc', 'ru', 'su', 'cn', 'jp', 'kr', 'ua', 'uk', 'de', 'fr',
  'es', 'nl', 'pl', 'pt', 'br', 'mx', 'ar', 'cl', 'pe', 've', 'ec', 'bo', 'py',
  'uy', 'ng', 'ke', 'za', 'gh', 'tz', 'ug', 'zm', 'zw', 'bw', 'na', 'mw', 'rw',
  'et', 'sd', 'mz', 'ao', 'cm', 'ci', 'sn', 'ml', 'dz', 'tn', 'ph', 'pk', 'bd',
  'lk', 'np', 'vn', 'th', 'kh', 'mm', 'tr', 'ir', 'iq', 'sa', 'ae', 'qa', 'kw',
  'bh', 'jo', 'lb', 'sy', 'ye', 'il', 'ie', 'ch', 'se', 'dk', 'cz',
  'sk', 'hu', 'ro', 'bg', 'hr', 'rs', 'si', 'lt', 'lv', 'ee', 'gr', 'eu', 'au',
  'nz', 'ca', 'hk', 'tw', 'sg', 'kz', 'uz', 'az', 'ge', 'md',
  // free TLDs historically dominated by throwaway spam domains
  'tk', 'ga', 'cf', 'gq', 'pw',
]

/**
 * Removed from SAFE_TLDS on purpose, each because a real sentence forms it when
 * the space after a full stop is missing — and a bare domain has no second
 * signal to fall back on:
 *
 *   .at    "finished.at last"      .my   "oh.my god"
 *   .by    "stop.by later"         .fi   "the wi.fi is down"
 *   .mom   "love you.mom"          .cam  "she is on.cam"
 *   .bond  "james.bond"
 *
 * They are all still caught with a path (Tier 4), a scheme, or a `www.` prefix,
 * which is how a real link on one of them virtually always arrives.
 */

// A hostname of one or more labels, e.g. "example" or "a.b.example".
const HOST_LABELS = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+'

// The `@` in the leading exclusion is what stops an ordinary email address
// ("someone@example.com") from reading as a bare domain and getting them kicked.
const BARE_DOMAIN_RE = new RegExp(
  `(?:^|[^a-z0-9@._-])${HOST_LABELS}(?:${SAFE_TLDS.join('|')})(?![a-z0-9-])`, 'i',
)

// ── Tier 4: anything with a path ───────────────────────────────────────────
// The required "/" plus one non-space character is the second signal that makes
// the word-like TLDs safe here: "bit.ly/3xK" and "example.to/x" are hits,
// "ok.so anyway" and "1.5" are not.
const PATH_LINK_RE = new RegExp(
  `(?:^|[^a-z0-9@._-])${HOST_LABELS}[a-z]{2,24}\\/[^\\s]`, 'i',
)

/**
 * True when `text` contains a link in any of the forms above.
 *
 * Pass every piece of text a message carries — body AND media captions. See
 * lib/moderation-scan.js's linkText(), which assembles that.
 */
export function containsLink(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return false

  const plain = deobfuscate(raw)
  if (SCHEME_RE.test(plain)) return true
  if (WWW_RE.test(plain)) return true
  if (BARE_DOMAIN_RE.test(plain)) return true
  if (PATH_LINK_RE.test(plain)) return true

  // Dot-collapsed pass, known hosts only.
  return KNOWN_HOST_RE.test(collapseDots(raw))
}

/**
 * Kept only so older call sites that imported the raw regex keep resolving.
 * New code should call containsLink(), which is what the scans actually use —
 * this pattern misses bare domains, captions and every obfuscated form.
 *
 * @deprecated use containsLink()
 */
export const LINK_PATTERN = /(https?:\/\/|www\.|chat\.whatsapp\.com|t\.me\/|discord\.gg\/)/i

/**
 * True when `jid` is an admin of the group described by `meta`.
 *
 * Uses the same multi-identity comparison as checkBotAdmin() below, and for the
 * same reason: a group can address participants by phone number OR by lid, each
 * participant entry may carry .id, .jid AND .lid, and the `from` a message
 * arrives with is only ever in one of those formats. A plain `p.id === jid`
 * check silently fails to recognise an admin whenever the two formats differ —
 * which, for antilink, means the scan deletes the message of a group admin and
 * removes them from their own group.
 */
export function isGroupAdmin(meta, jid) {
  if (!meta?.participants || !jid) return false

  const wanted = new Set()
  const add = (value) => {
    if (!value) return
    const normalized = jidNormalizedUser(String(value))
    wanted.add(normalized)
    wanted.add(normalized.replace(/@.*$/, ''))
    // Companion devices arrive as "<id>:<device>@<server>" — see isOwnerJid.
    wanted.add(normalized.replace(/@.*$/, '').split(':')[0])
  }
  add(jid)

  const entry = meta.participants.find(p =>
    [p.id, p.jid, p.lid].filter(Boolean).some(candidate => {
      const normalized = jidNormalizedUser(String(candidate))
      const bare = normalized.replace(/@.*$/, '')
      return wanted.has(normalized) || wanted.has(bare) || wanted.has(bare.split(':')[0])
    }),
  )

  return entry?.admin === 'admin' || entry?.admin === 'superadmin'
}

/**
 * Short-lived group metadata cache.
 *
 * sock.groupMetadata() is a network round trip AND rate limited by WhatsApp.
 * The moderation scan needs it for every single group message, so uncached it
 * both floods the log with "rate-overlimit" and provokes the rate limit that
 * causes it: at that point metadata stops resolving, checkBotAdmin() throws,
 * and every moderation rule quietly turns itself off.
 *
 * TTL is deliberately short. The only field that matters here is who is an
 * admin, so at worst a promotion takes GROUP_META_TTL_MS to be noticed.
 */
const GROUP_META_TTL_MS = 30_000
/** After a failed fetch, don't hammer the same group. Rate limits need air. */
const GROUP_META_FAIL_BACKOFF_MS = 60_000
/** Bound the map for a bot sitting in a lot of groups. */
const GROUP_META_MAX_ENTRIES = 500

const groupMetaCache = new Map()
const groupMetaFailures = new Map()

function pruneGroupMetaCache() {
  if (groupMetaCache.size <= GROUP_META_MAX_ENTRIES) return
  const now = Date.now()
  for (const [jid, entry] of groupMetaCache) {
    if (now - entry.at > GROUP_META_TTL_MS) groupMetaCache.delete(jid)
  }
  // Still oversized means they're all fresh: drop oldest-inserted first.
  while (groupMetaCache.size > GROUP_META_MAX_ENTRIES) {
    const oldest = groupMetaCache.keys().next().value
    if (oldest === undefined) break
    groupMetaCache.delete(oldest)
  }
}

/**
 * groupMetadata() with a cache in front of it.
 *
 * On a failed fetch this returns the last known metadata if it has any, rather
 * than throwing: stale admin lists keep moderation working through a rate-limit
 * window, where throwing would switch every rule off. It only throws when there
 * is genuinely nothing cached for that group.
 *
 * `allowStale: false` opts out of that, for a caller who would rather report a
 * failure than answer from a copy it can't vouch for.
 */
export async function getGroupMetadata(sock, groupId, { maxAgeMs = GROUP_META_TTL_MS, allowStale = true } = {}) {
  const hit = groupMetaCache.get(groupId)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.meta

  const failed = groupMetaFailures.get(groupId)
  if (failed && Date.now() - failed.at < GROUP_META_FAIL_BACKOFF_MS) {
    if (hit && allowStale) return hit.meta
    throw failed.err
  }

  try {
    const meta = await sock.groupMetadata(groupId)
    groupMetaCache.set(groupId, { meta, at: Date.now() })
    groupMetaFailures.delete(groupId)
    pruneGroupMetaCache()
    return meta
  } catch (err) {
    groupMetaFailures.set(groupId, { at: Date.now(), err })
    if (hit && allowStale) return hit.meta
    throw err
  }
}

/** Forget a group's cached metadata, e.g. right after promoting someone. */
export function invalidateGroupMetadata(groupId) {
  groupMetaCache.delete(groupId)
  groupMetaFailures.delete(groupId)
}

/**
 * Resolves the bot's own JID and checks if it's an admin in `groupId`.
 *
 * Why this isn't a single string comparison: groups can use either 'pn'
 * (phone-number) or 'lid' addressing (GroupMetadata.addressingMode), and
 * each participant entry may carry .id, .jid, AND .lid at once. sock.user.id
 * is only ever in ONE of those formats. Comparing just
 * jidNormalizedUser(sock.user.id) against participant.id silently fails
 * whenever the group's addressing mode doesn't match the format sock.user.id
 * happens to be in — the bot IS actually an admin, the match just never
 * fires. So we build the full set of the bot's own known identities (id +
 * lid, if Baileys has resolved one) and check a participant against ALL of
 * that participant's own identity fields (id, jid, lid) too.
 *
 * Metadata comes from the shared short-TTL cache. Pass `{ maxAgeMs: 0 }` to
 * force a fresh lookup, which is what `.botadmin` wants: someone promoting the
 * bot by hand in WhatsApp's own group settings fires no event here, so that
 * command has to be able to see the change immediately.
 */
export async function checkBotAdmin(sock, groupId, opts = {}) {
  const meta = await getGroupMetadata(sock, groupId, opts)

  const botIdentities = new Set()
  if (sock.user?.id)  botIdentities.add(jidNormalizedUser(sock.user.id))
  if (sock.user?.lid) botIdentities.add(jidNormalizedUser(sock.user.lid))
  // Bare (no @suffix) forms too, in case one side is a bare number/lid.
  for (const full of [...botIdentities]) {
    botIdentities.add(full.replace(/@.*$/, ''))
  }

  const me = meta.participants.find(p => {
    const candidates = [p.id, p.jid, p.lid].filter(Boolean)
    return candidates.some(c => {
      const normalized = jidNormalizedUser(c)
      const bare = normalized.replace(/@.*$/, '')
      return botIdentities.has(normalized) || botIdentities.has(bare)
    })
  })

  return { isAdmin: me?.admin === 'admin' || me?.admin === 'superadmin', meta }
}

/**
 * Pulls a target player id from a reply/quote or an @mention — the thing
 * every "who did you mean?" command (mod, ban, report, id, admin, tourney,
 * profile, ...) needs before it can act on someone other than the caller.
 *
 * Accepts either:
 *   - the raw WhatsApp msg object (legacy call shape, still works exactly
 *     as before — every existing plugin passing `extractTarget(msg)` keeps
 *     working unchanged), or
 *   - a full ctx object (`extractTarget(ctx)`), which is REQUIRED to resolve
 *     a target on Discord or Telegram, since those platforms carry mention/
 *     reply info in a completely different shape than Baileys' contextInfo.
 *
 * Passing a bare WhatsApp msg from a Discord/Telegram ctx (e.g. the old
 * `extractTarget(ctx.msg)` pattern) silently returns null on those two
 * platforms, because `ctx.msg` was never set there in the first place —
 * that was the actual bug behind ".profile @player"/".id @player" not
 * resolving anyone outside WhatsApp. Passing `ctx` itself fixes it.
 */
export function extractTarget(msgOrCtx) {
  // Full ctx object: has a `platform` field, a raw msg doesn't.
  if (msgOrCtx && typeof msgOrCtx === 'object' && 'platform' in msgOrCtx) {
    return extractTargetFromCtx(msgOrCtx)
  }
  // Legacy shape: raw Baileys msg (or ctx.msg passed directly).
  return extractWhatsAppTarget(msgOrCtx)
}

function extractWhatsAppTarget(msg) {
  const ctxInfo = msg?.message?.extendedTextMessage?.contextInfo
  if (!ctxInfo) return null
  if (ctxInfo.participant) return ctxInfo.participant
  if (Array.isArray(ctxInfo.mentionedJid) && ctxInfo.mentionedJid.length > 0) {
    return ctxInfo.mentionedJid[0]
  }
  return null
}

function extractTargetFromCtx(ctx) {
  if (ctx.platform === 'whatsapp') return extractWhatsAppTarget(ctx.msg)
  if (ctx.platform === 'discord') return extractDiscordTarget(ctx)
  if (ctx.platform === 'telegram') return extractTelegramTarget(ctx)
  return null
}

/** discord.js: a reply's author, or the first @mention on the message. */
function extractDiscordTarget(ctx) {
  const message = ctx.message
  if (!message) return null

  const repliedAuthorId = message.mentions?.repliedUser?.id ?? null
  const mentionedId = repliedAuthorId ?? message.mentions?.users?.first?.()?.id ?? null
  if (!mentionedId) return null

  const nativeId = toPlayerId('discord', mentionedId)
  return resolveLinkedId(ctx.db, nativeId)
}

/** grammY: the author of a replied-to message, or the first text_mention entity. */
function extractTelegramTarget(ctx) {
  const msg = ctx.message
  if (!msg) return null

  const repliedUser = msg.reply_to_message?.from
  if (repliedUser && !repliedUser.is_bot) {
    const nativeId = toPlayerId('telegram', repliedUser.id)
    return resolveLinkedId(ctx.db, nativeId)
  }

  // A `text_mention` entity carries the full user object (works even for
  // users without a @username); a plain `mention` entity is just "@name"
  // text with no id attached, so it can't be resolved to a player.
  const entity = msg.entities?.find(e => e.type === 'text_mention' && e.user)
  if (entity?.user && !entity.user.is_bot) {
    const nativeId = toPlayerId('telegram', entity.user.id)
    return resolveLinkedId(ctx.db, nativeId)
  }

  return null
}

/** Parses a phone number out of a raw arg string ("+234...", "234 803...", etc). */
export function parseNumber(input) {
  if (!input) return null
  const cleaned = input.replace(/[^\d+]/g, '').replace(/^\+/, '')
  return cleaned.length >= 8 ? cleaned : null
}

/** True if `jid` matches the configured bot owner (LID or phone number). */
export function isOwnerJid(jid) {
  if (!jid) return false

  // The `:N` split is load-bearing. WhatsApp addresses a specific linked
  // device as `<id>:<device>@<server>` — e.g. `2347062301848:5@s.whatsapp.net`
  // or `87209327755401:12@lid` — and messages sent from a phone that has
  // companion devices linked routinely arrive with that suffix. Stripping
  // only `@...` left `2347062301848:5`, which matched neither ownerNumbers
  // nor ownerLid, so the owner silently failed their own owner check and got
  // "🔒 DMs are closed" from their own bot.
  const bareId = String(jid).replace(/@.*$/, '').split(':')[0]
  if (!bareId) return false

  if (config.ownerLid && bareId === config.ownerLid.replace(/\D/g, '')) return true
  const ownerNumbers = (config.ownerNumbers ?? []).map(n => n.replace(/\D/g, ''))
  return ownerNumbers.includes(bareId)
}
