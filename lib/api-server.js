/**
 * api-server.js — the bridge between the WhatsApp bot and the website.
 *
 * Runs INSIDE the bot process, on purpose. lib/player-repo.js documents a
 * hard single-writer invariant on db.json: lowdb rewrites the whole file on
 * every write, so a second process doing its own read→mutate→write cycle can
 * silently clobber an in-flight purchase. Hosting this as a separate service
 * would reintroduce exactly that bug. Sharing the process means sharing the
 * one in-memory write queue, which is the whole point.
 *
 * It also means OTP delivery is free: `instances` is the live array of
 * Baileys sockets from main.js, so a login code is DM'd straight from
 * whichever bot number is currently connected — the same
 * `instances.map(i => i.activeSock).find(Boolean)` pattern every sweep in
 * main.js already uses.
 *
 * Auth model:
 *   1. POST /api/auth/request-otp  { phone }        → bot DMs a 6-digit code
 *   2. POST /api/auth/verify-otp   { phone, code }  → JWT (cookie + bearer)
 *   3. POST /api/auth/register     { name, class, race }  → for new players
 *
 * PRIVACY: a player's id IS their phone number (WhatsApp JID). None of the
 * public endpoints may ever emit one. Everything public is keyed by an
 * opaque HMAC of the JID instead — see publicId() below.
 */
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import { createHmac } from 'crypto'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { config, logger } from '../config.js'
import { uploadToImgbb } from './imgbb.js'
import { getPlayer, playerExists, createPlayer, updatePlayer, flushPendingWrites } from './player-repo.js'
import { buildNewPlayer, validateRegistration, listClasses, listRaces } from './player-factory.js'
import {
  listNotifications, markRead, markAllRead,
  deleteNotification, clearNotifications, pushNotification,
  listDerivedAcks, derivedSignature, ackDerived, KINDS,
  dismissDerived, listDerivedDismissals,
} from './notification-repo.js'
import { buildSelfAlerts, buildPublicAlerts } from './alerts.js'
import {
  renamePlayer, formatRemaining, canRename, nextRenameAt,
  RENAME_COOLDOWN_DAYS, MIN_LENGTH, MAX_LENGTH,
} from './rename-rules.js'
import {
  initOtpStore, normalizePhone, checkRateLimit, issue, verify, discard,
} from './otp-store.js'
import { getRankForLevel, getNextRank, getXpProgress } from './rank-engine.js'
import { playerLevelCap } from './reborn-engine.js'
import { getFameTier, getNextFameTier, formatFame } from './fame-engine.js'
import { isPremiumActive } from './premium.js'
import {
  getActiveSeason, getSeasonRuntime, seasonProgressPercent,
  getSeasonReward, getSeasonCatalog, getSeasonShopPages, describeSeasonEntry,
  seasonRewards, rewardLabel, getExclusiveSpinWinner,
} from './season-engine.js'
import { getSpinBanner, runSpinBatch, SPIN_BANNERS } from './spin-banners.js'
import { isSpinLocked } from './spin-locks.js'
import { roundGems, fmtGems } from './format.js'
import { mondPriceFor } from './monds.js'
import {
  characters, characterMap, locationsMap, ranks,
  premiumPlans, topupPackages, allItems, petMap, beastMap,
} from './game-data.js'
import { hasInventoryRoom, getInventoryCap } from './inventory-limits.js'
import { getModValue } from './mods.js'
import {
  shopWeapons, shopItems, shopTools, findInCatalog,
  groupByRarity, groupBySlot, groupPotions, potionBlurb,
  ABILITY_SLOT_GEM_PRICE,
} from './shop-catalog.js'
import {
  fetchCardOfTier, addCardToPlayer, cardBuyPrice, tierStars, getCardTierCounts,
  fetchCardCatalogPage,
} from './card-engine.js'
import { getCommandsToday } from './server-stats.js'
import { itemArtBuffer, itemIdFromAssetUrl } from './item-art-cache.mjs'

const COOKIE_NAME = 'astral_session'
const SESSION_TTL = '30d'
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] 🌐 API ${args.join(' ')}\n`)
}

/* ─────────────────────────── identity helpers ─────────────────────────── */

/**
 * Opaque, stable, non-reversible public id for a player. The leaderboard is
 * world-readable and a raw JID is a phone number, so every public payload is
 * keyed by this instead. Derived from the JWT secret, so it's consistent for
 * the life of the deployment but useless to anyone who doesn't hold it.
 */
function publicId(jid) {
  return createHmac('sha256', config.jwtSecret).update(String(jid)).digest('hex').slice(0, 16)
}

/** Reverse lookup for /api/players/:uid. Linear, but n is small. */
function findByPublicId(db, uid) {
  for (const jid of Object.keys(db.data.users ?? {})) {
    if (publicId(jid) === uid) return db.data.users[jid]
  }
  return null
}

/**
 * Bare digits of a JID, for phone matching. `2348…@s.whatsapp.net` → `2348…`
 * Exported for scripts/check-web-login.mjs, which must reason about the exact
 * same digits this file matches on.
 */
export function jidDigits(jid) {
  return String(jid).split('@')[0].split(':')[0].replace(/\D+/g, '')
}

/**
 * Finds an existing player from a normalized phone number.
 *
 * Four shots, cheapest first: the canonical JID, the account's LID, a `phone`
 * field we stamped on a previous web login, then a scan. Both the LID lookup
 * and the scan exist because some accounts register under a LID rather than a
 * phone JID (see config.ownerLid) — WhatsApp tells us the LID for a number via
 * onWhatsApp(), so we can match those directly instead of orphaning them into
 * a duplicate character at login.
 *
 * Exported so scripts/check-web-login.mjs can audit real accounts through this
 * exact function rather than a copy of it that could drift.
 */
export function findPlayerByPhone(db, phone, resolvedJid = null, lid = null) {
  const users = db.data.users ?? {}
  if (resolvedJid && users[resolvedJid]) return users[resolvedJid]
  if (lid && users[lid]) return users[lid]
  const direct = users[`${phone}@s.whatsapp.net`]
  if (direct) return direct
  const lidDigits = lid ? jidDigits(lid) : null
  for (const p of Object.values(users)) {
    if (p?.phone && String(p.phone) === phone) return p
    if (jidDigits(p?.id ?? '') === phone) return p
    // A LID JID (`NNN@lid`) matched by its digits — covers a stored id whose
    // suffix differs from what onWhatsApp handed back this time.
    if (lidDigits && jidDigits(p?.id ?? '') === lidDigits && String(p?.id ?? '').includes('@lid')) return p
  }
  return null
}

/** Whichever bot number is connected right now, or null if none are. */
function liveSocket(instances) {
  return (instances ?? []).map(i => i.activeSock).find(Boolean) ?? null
}

/**
 * Stores a notification AND mirrors it to the player's DMs, subject to their
 * `dmNotifications` setting (Settings → Notifications on the site).
 *
 * The bell is the source of truth and always gets the entry; the DM is the
 * best-effort copy, because a security alert nobody opens the site to read is
 * no alert at all. Both are fire-and-forget: a dead socket or a full disk must
 * never fail the request that triggered the notification.
 *
 * `dmNotifications` defaults to ON when unset, so existing players keep
 * getting security DMs without having to opt in.
 */
async function notifyPlayer(db, instances, jid, { kind = 'system', title, body = '', meta = null } = {}) {
  const entry = await pushNotification(db, jid, { kind, title, body, meta }).catch(() => null)

  const player = getPlayer(db, jid)
  if (player?.webPrefs?.dmNotifications === false) return entry
  if (player?.webPrefs?.mutedNotificationKinds?.includes(kind)) return entry

  const sock = liveSocket(instances)
  if (sock) {
    const heading = kind === 'security' ? '🔐' : kind === 'premium' ? '👑' : '📣'
    sock.sendMessage(jid, {
      text: `${heading} *${title}*${body ? `\n\n${body}` : ''}`,
    }).catch(() => {})
  }

  return entry
}

/**
 * Confirms a number actually has WhatsApp and returns its canonical JID.
 * Falls back to the plain phone JID if the lookup isn't available — we'd
 * rather attempt the DM than block a real login on a flaky check.
 *
 * Also returns the account's LID (Linked ID) when WhatsApp reports one. Modern
 * accounts — including the owner's (see config.ownerLid) — are keyed in the DB
 * by their LID (`NNN@lid`), NOT their phone JID, so a login that only knows the
 * phone JID can never find them and wrongly looks like a brand-new player. The
 * LID is what lets findPlayerByPhone connect the code to the real character.
 * `jid` (phone JID preferred) stays the DM target; `lid` is only for matching.
 */
async function resolveWhatsAppJid(sock, phone) {
  const fallback = `${phone}@s.whatsapp.net`
  try {
    if (typeof sock.onWhatsApp !== 'function') return { jid: fallback, lid: null, verified: false }
    const [hit] = (await sock.onWhatsApp(phone)) ?? []
    if (!hit) return { jid: null, lid: null, verified: true }
    if (hit.exists === false) return { jid: null, lid: null, verified: true }
    return { jid: hit.jid ?? hit.lid ?? fallback, lid: hit.lid ?? null, verified: true }
  } catch {
    return { jid: fallback, lid: null, verified: false }
  }
}

/* ──────────────────────── origin / deployment helpers ─────────────────── */

/**
 * Project names pulled out of whatever *.vercel.app origins are allow-listed,
 * so preview deploys of the SAME project are accepted without opening the
 * door to every site on vercel.app. "https://astral-play.vercel.app" yields
 * "astral-play", which then matches astral-play-git-main-xyz.vercel.app and
 * astral-play-a1b2c3.vercel.app but nothing else.
 */
const VERCEL_PROJECTS = config.allowedOrigins
  .map(o => /^https:\/\/([a-z0-9-]+)\.vercel\.app$/i.exec(o)?.[1])
  .filter(Boolean)

function isAllowedPreviewOrigin(origin) {
  if (!config.allowVercelPreviews || !VERCEL_PROJECTS.length) return false
  const host = /^https:\/\/([a-z0-9.-]+)$/i.exec(origin)?.[1]
  if (!host || !host.endsWith('.vercel.app')) return false
  const sub = host.slice(0, -'.vercel.app'.length)
  return VERCEL_PROJECTS.some(p => sub === p || sub.startsWith(`${p}-`))
}

/**
 * Cookie flags depend on how the browser got here.
 *
 * Same site as the API (the Vercel-rewrite setup, or local dev): SameSite=Lax
 * is a genuine first-party cookie that no browser is planning to kill.
 * Cross-origin (the site calling the Railway domain directly): SameSite=None
 * is the only thing that can work at all, and Chrome's third-party cookie
 * phase-out may still drop it — which is exactly why the bearer token, not
 * this cookie, is the primary credential.
 */
function sessionCookieOptions(req) {
  const origin = req?.get?.('origin')
  const host = req?.get?.('host')
  let crossSite = false
  if (origin && host) {
    try { crossSite = new URL(origin).host !== host } catch { crossSite = true }
  }
  return {
    httpOnly: true,
    secure: true,
    sameSite: crossSite ? 'none' : 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  }
}

/* ─────────────────────────── session helpers ──────────────────────────── */

function issueSession(res, player, req = null) {
  const token = jwt.sign(
    // `epoch` is what makes "sign out everywhere" possible without a session
    // table: bumping player.sessionEpoch leaves every token ever minted with
    // a stale epoch, and attachSession rejects those. Tokens predating this
    // field carry no epoch, which compares equal to the default 0 — so
    // existing sessions keep working until the player revokes them.
    { sub: player.id, uid: publicId(player.id), epoch: player.sessionEpoch ?? 0 },
    config.jwtSecret,
    { expiresIn: SESSION_TTL },
  )
  // The bearer token in the body is the primary credential; this cookie is
  // the fallback. Its flags adapt to how the request arrived — see
  // sessionCookieOptions.
  res.cookie(COOKIE_NAME, token, sessionCookieOptions(req))
  return token
}

function readToken(req) {
  const header = req.get('authorization') ?? ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return req.cookies?.[COOKIE_NAME] ?? null
}

/** Attaches req.jid / req.player when a valid session is present. */
function attachSession(db) {
  return (req, _res, next) => {
    const token = readToken(req)
    if (!token) return next()
    try {
      const payload = jwt.verify(token, config.jwtSecret)
      const player = getPlayer(db, payload.sub)
      // Revoked by "sign out everywhere" — see issueSession.
      if (player && (payload.epoch ?? 0) < (player.sessionEpoch ?? 0)) return next()
      req.jid = payload.sub
      req.player = player
    } catch {
      // Expired or forged — treat as anonymous rather than erroring, so a
      // stale tab just shows the signed-out state instead of a hard failure.
    }
    return next()
  }
}

/** 401s anonymous callers. */
function requireSession(req, res, next) {
  if (!req.jid) return res.status(401).json({ ok: false, error: 'Sign in to continue.' })
  return next()
}

/** 401s anonymous callers AND verified-but-unregistered ones. */
function requirePlayer(req, res, next) {
  if (!req.jid) return res.status(401).json({ ok: false, error: 'Sign in to continue.' })
  if (!req.player) {
    return res.status(403).json({ ok: false, error: 'No character yet.', needsRegistration: true })
  }
  return next()
}

/* ───────────────────────────── serializers ───────────────────────────── */

/** Only ever emit an http(s) image URL — never a local disk path. */
function safeImageUrl(value) {
  const s = String(value ?? '')
  return /^https?:\/\//i.test(s) ? s : null
}

/* ── profile art parity with the chat card ───────────────────────────────
   The website and `.me` have to show the same face. Both read player.pfp /
   player.banner (ImgBB URLs since lib/pfp.js moved uploads off local disk),
   so a player who has set one already matched. What didn't match was the
   fallback: lib/profile-card-render.mjs draws assets/profile/default-pfp.png
   and default-banner.png when a player hasn't set their own, while the site
   fell back to drawn initials and a flat CSS panel. Same player, two
   different profiles.

   These serve the render card's own asset files over HTTP so the site can
   use the identical images. existsSync is checked once at module load: if
   the files aren't deployed we keep returning null and the site falls back
   to initials as before, rather than showing a broken-image box — which
   would be a worse regression than the mismatch we're fixing. */
const PROFILE_ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'profile')
/**
 * Item artwork generated by scripts/generate-item-art.mjs. Self-hosted on
 * purpose: data/*.json used to point at play.astral.qzz.io, which stopped
 * resolving and took ~100 items' art with it. Serving from the same process
 * that serves the API means the art can't outlive the bot or vice versa.
 */
const ITEM_ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'items')

const DEFAULT_PROFILE_ART = {
  pfp: existsSync(join(PROFILE_ASSET_DIR, 'default-pfp.png')) ? 'default-pfp.png' : null,
  banner: existsSync(join(PROFILE_ASSET_DIR, 'default-banner.png')) ? 'default-banner.png' : null,
}

function defaultProfileArt(which) {
  const file = DEFAULT_PROFILE_ART[which]
  if (!file) return null
  return `${String(config.publicApiUrl ?? '').replace(/\/+$/, '')}/assets/profile/${file}`
}

/**
 * Image hosts that actually serve. play.astral.qzz.io — which backs all 185
 * weapon/item/relic/material artwork URLs in data/ — is currently down, so
 * those entries render as a broken-image box on the website. The chat renders
 * cope fine (they fall back to a drawn emblem), but a web grid of grey squares
 * doesn't, so the site hides anything it can't actually show.
 *
 * When that host is back, add it here and every hidden entry reappears — no
 * other change needed.
 */
const LIVE_IMAGE_HOSTS = new Set([
  'i.ibb.co',                 // characters, pets, beasts
  'raw.githubusercontent.com', // PokéAPI mega-stone sprites
])

/* This process IS the host for every weapon/item/relic/material plate — all
   185 of those URLs in data/ point at config.publicApiUrl/assets/items/<id>.png,
   which is served by the route at ~line 683 from lib/item-art-cache.mjs. The
   art is rendered on demand from vendor/game-icons, so it is available exactly
   whenever this endpoint is, and the "host is down" reasoning above can never
   apply to it. Derived from config rather than hardcoded so a domain change in
   .env doesn't silently blank the item grids again. */
try {
  const ownHost = new URL(String(config.publicApiUrl ?? '')).hostname
  if (ownHost) LIVE_IMAGE_HOSTS.add(ownHost)
} catch {
  log('⚠️ PUBLIC_API_URL is not a valid URL — item artwork will be hidden on the site.')
}

function hasLiveImage(url) {
  if (!url) return false
  try {
    return LIVE_IMAGE_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

function itemSummary(id) {
  const it = itemMap[id]
  return {
    id,
    name: it?.name ?? id,
    emoji: it?.emoji ?? null,
    rarity: it?.rarity ?? null,
    type: it?.type ?? null,
    // The site drew a generic glyph for every inventory slot because this
    // never shipped the artwork. Every entry in data/ carries an `image`
    // pointing at our own /assets/items/<id>.png.
    image: safeImageUrl(it?.image),
    description: it?.description ?? null,
  }
}

/** Collapses ["potion","potion","sword"] into stacked rows with counts. */
function stackInventory(list) {
  const counts = new Map()
  for (const id of list ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts.entries()].map(([id, qty]) => ({ ...itemSummary(id), qty }))
}

function characterSummary(id) {
  const c = characterMap[id]
  if (!c) return null
  return {
    id: c.id,
    name: c.name,
    emoji: c.emoji ?? null,
    rarity: c.rarity ?? null,
    /* Display-only badge, independent of `rarity` — rarity feeds gem pricing
       and drop tables, so it can't be repurposed as a marketing label. */
    tag: c.tag ?? null,
    image: safeImageUrl(c.image),
    description: c.description ?? null,
    ability: c.ability ?? null,
    /* Vestigial. Every row in data/characters.json carries gemPrice 0 or null,
       because gems stopped buying characters when Monds took that over, and
       nothing in the bot reads this to charge anybody. Kept only so an older
       deploy of the site doesn't crash on a missing key - price off mondPrice. */
    gemPrice: c.gemPrice ?? 0,
    /* What the character actually costs: Monds, flat 5 unless the row overrides
       it, and null when Monds can't buy it at all (season characters, and stubs
       with no route in yet). Same helper plugins/character.js charges from, so
       the site and the chat command can never quote different prices. */
    mondPrice: mondPriceFor(c),
    seasonId: c.seasonId ?? null,
    characterTier: c.characterTier ?? null,
    abilityTier: c.abilityTier ?? null,
    statBonuses: c.statBonuses ?? null,
    /* 1-5 star rating, independent of `rarity` and of the card tier ladder.
       The spin banner draws a star row from this. */
    stars: c.stars ?? null,
    /* Ownership model, so the site can badge a one-of-one as such rather than
       guessing from the missing gemPrice: `exclusive` is one holder bot-wide,
       `spinOnly` is unbuyable but everyone can win their own copy. */
    exclusive: c.exclusive === true,
    spinOnly: c.spinOnly === true,
  }
}

/**
 * The season's featured characters, as one flat ordered list.
 *
 * The site used to derive this by filtering the `shop` payload against a
 * hardcoded list of names, which could never work: `season.characters`
 * (major/peak/minor — mei, urahara, willow) and the shop catalog's
 * `rewardType: 'character'` rows (urahara, wither) are two different sets, and
 * only their intersection was ever reachable from `shop`. Merging them here is
 * the fix — the featured roster is season data, so the API is what should know
 * it.
 *
 * Order: the narrative tiers first (major → peak → minor, as declared in
 * seasons.json), then any shop-only character. Deduped by id, so urahara
 * appears once with its price attached.
 */
function buildSeasonRoster(season, catalog) {
  const shopEntries = new Map(
    (catalog ?? [])
      .filter(e => e.rewardType === 'character' && e.id)
      .map(e => [e.id, e]),
  )

  const ids = [
    ...Object.values(season?.characters ?? {}).filter(Boolean),
    ...shopEntries.keys(),
  ]

  const roster = []
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const summary = characterSummary(id)
    if (!summary) continue

    const shopEntry = shopEntries.get(id)
    const tier = Object.entries(season?.characters ?? {})
      .find(([, cid]) => cid === id)?.[0] ?? null

    roster.push({
      ...summary,
      // Which narrative slot this character fills this season, when it fills
      // one. `characterTier` on the summary is the character's own static
      // tier from characters.json and is not always the same thing.
      seasonTier: tier,
      price: shopEntry?.price ?? null,
      currency: shopEntry ? (season?.shop?.currency ?? 'seasonPoints') : null,
      purchasable: !!shopEntry,
    })
  }

  return roster
}

/** Shared core of the public and private player payloads. */
function playerCore(db, p) {
  const rank = getRankForLevel(p.level ?? 1)
  const nextRank = getNextRank(p.level ?? 1)
  const xp = getXpProgress(p.level ?? 1, p.xp ?? 0, playerLevelCap(p))
  const fame = p.fame ?? 0
  const fameTier = getFameTier(fame)
  const nextFameTier = getNextFameTier(fame)

  let deepestFloor = 0
  let deepestDungeon = null
  let conquered = 0
  for (const [locId, prog] of Object.entries(p.dungeonProgress ?? {})) {
    if ((prog?.highestFloor ?? 0) > deepestFloor) {
      deepestFloor = prog.highestFloor
      deepestDungeon = locationsMap[locId]?.name ?? locId
    }
    if (prog?.conquered) conquered++
  }

  return {
    uid: publicId(p.id),
    name: p.name,
    title: p.title ?? null,
    bio: p.bio ?? null,
    avatarUrl: safeImageUrl(p.pfp) ?? defaultProfileArt('pfp'),
    bannerUrl: safeImageUrl(p.banner) ?? defaultProfileArt('banner'),
    /* avatarUrl/bannerUrl fall back to the default art, so they're truthy even
       for a player who has never uploaded anything. The settings page needs to
       tell the two apart — otherwise it offers "Remove" on a default image. */
    hasCustomPfp: !!safeImageUrl(p.pfp),
    hasCustomBanner: !!safeImageUrl(p.banner),
    classId: p.classId ?? null,
    raceId: p.raceId ?? null,
    level: p.level ?? 1,
    xp: p.xp ?? 0,
    xpProgress: {
      pct: Math.round((xp.pct ?? 0) * 100),
      intoLevel: xp.intoLevel ?? 0,
      forLevel: xp.forLevel ?? 0,
      xpToNext: xp.xpToNext ?? 0,
      maxed: !!xp.maxed,
    },
    rank: { title: rank.title, epithet: rank.epithet, emoji: rank.emoji, min: rank.min, max: rank.max },
    nextRank: nextRank ? { title: nextRank.title, emoji: nextRank.emoji, min: nextRank.min } : null,
    hp: p.hp ?? 0,
    maxHp: p.maxHp ?? 0,
    mp: p.mp ?? 0,
    maxMp: p.maxMp ?? 0,
    stats: {
      str: p.stats?.str ?? 0,
      agi: p.stats?.agi ?? 0,
      int: p.stats?.int ?? 0,
      def: p.stats?.def ?? 0,
      lck: p.stats?.lck ?? 0,
    },
    /* Same correction as BOARDS.wins: the duel record lives on player.pvp, so
       reading p.stats?.wins reported 0W 0L on every profile and in every
       player modal. `pve` is the separate dungeon/boss tally from
       lib/combat-handlers.js — kept distinct because a PvP ladder record and
       a monster-kill record are not the same number. */
    record: {
      wins: p.pvp?.wins ?? 0,
      losses: p.pvp?.losses ?? 0,
      rating: p.pvp?.rating ?? null,
      streak: p.pvp?.streak ?? 0,
      bestStreak: p.pvp?.bestStreak ?? 0,
      pve: { wins: p.battleRecord?.wins ?? 0, losses: p.battleRecord?.losses ?? 0 },
    },
    fame: { value: fame, formatted: formatFame(fame), tier: fameTier, next: nextFameTier },
    location: { id: p.location ?? null, name: locationsMap[p.location]?.name ?? p.location ?? null },
    dungeon: { deepestFloor, deepestDungeon, conquered },
    premium: { active: isPremiumActive(p), plan: isPremiumActive(p) ? (p.premium?.plan ?? null) : null },
    equippedCharacter: p.equippedCharacter ? characterSummary(p.equippedCharacter) : null,
    counts: {
      inventory: (p.inventory ?? []).length,
      skills: (p.skills ?? []).length,
      pets: (p.pets ?? []).length,
      beasts: (p.summonedBeasts ?? []).length,
      characters: (p.ownedCharacters ?? []).length,
    },
    registeredAt: p.registeredAt ?? null,
    guildId: p.guildId ?? null,
  }
}

/** Public view — leaderboard rows and the character-detail drawer. */
function serializePublicPlayer(db, p, { withAlerts = false } = {}) {
  const core = playerCore(db, p)
  const season = getActiveSeason(db)
  return {
    ...core,
    season: season && p.seasonProgress?.seasonId === season.id
      ? {
          tier: p.seasonProgress.battlePassTier ?? 0,
          tierCount: season.battlePass?.tierCount ?? 50,
          premiumPass: !!p.seasonProgress.premiumPass,
          progressPercent: seasonProgressPercent(p, season),
        }
      : null,
    alerts: withAlerts ? buildPublicAlerts(db, p) : undefined,
  }
}

/** Private view — everything the signed-in player is allowed to see. */
function serializeSelf(db, p) {
  const core = playerCore(db, p)
  const season = getActiveSeason(db)
  const equipped = {}
  for (const [slot, id] of Object.entries(p.equipped ?? {})) {
    equipped[slot] = id ? itemSummary(id) : null
  }

  return {
    ...core,
    wallet: {
      solars: p.wallet?.solars ?? 0,
      gems: p.wallet?.gems ?? 0,
      bankGold: p.wallet?.bankGold ?? 0,
      vault: p.wallet?.vault ?? 0,
      loan: p.wallet?.loan ?? 0,
    },
    statPoints: p.statPoints ?? null,
    stamina: p.stamina ?? null,
    equipped,
    inventory: stackInventory(p.inventory),
    chest: { unlocked: !!p.chest?.unlocked, items: stackInventory(p.chest?.items) },
    skills: (p.skills ?? []).map(id => ({ id })),
    equippedSkills: p.equippedSkills ?? [],
    pets: (p.pets ?? []).map(id => ({ id, name: petMap[id]?.name ?? id, emoji: petMap[id]?.emoji ?? null })),
    beasts: (p.summonedBeasts ?? []).map(b => ({
      id: b.beastId,
      name: beastMap[b.beastId]?.name ?? b.beastId,
      cp: b.cp ?? null,
      active: p.activeBeast === b.beastId,
    })),
    ownedCharacters: (p.ownedCharacters ?? []).map(characterSummary).filter(Boolean),
    seasonOwned: p.seasonOwned ?? null,
    seasonPoints: p.seasonPoints ?? 0,
    season: season
      ? {
          id: season.id,
          name: season.name,
          tier: p.seasonProgress?.battlePassTier ?? 0,
          tierCount: season.battlePass?.tierCount ?? 50,
          seasonLevel: p.seasonProgress?.seasonLevel ?? 0,
          premiumPass: !!p.seasonProgress?.premiumPass,
          claimedTiers: p.seasonProgress?.claimedTiers ?? [],
          progressPercent: seasonProgressPercent(p, season),
        }
      : null,
    premiumDetail: {
      active: isPremiumActive(p),
      plan: p.premium?.plan ?? null,
      expiresAt: p.premium?.expiresAt ?? null,
      grantedAt: p.premium?.grantedAt ?? null,
    },
    pending: {
      premium: p.premiumPending ?? null,
      topup: p.topupPending ?? null,
    },
    dailyStreak: p.dailyStreak ?? 0,
    lastDailyClaim: p.lastDailyClaim ?? null,
    state: { inDungeon: !!p.inDungeon, inBattle: !!p.inBattle, floor: p.dungeonFloor ?? 0 },
    alerts: buildSelfAlerts(db, p),
    settings: serializeSettings(p),
  }
}

/**
 * Everything the settings page needs to render current state, including when
 * the next rename unlocks — the client shouldn't have to recompute the
 * cooldown from lastRenameAt and risk disagreeing with the server about it.
 */
function serializeSettings(p) {
  return {
    hiddenFromLeaderboard: !!p.hiddenFromLeaderboard,
    mutedNotificationKinds: p.webPrefs?.mutedNotificationKinds ?? [],
    dmNotifications: p.webPrefs?.dmNotifications !== false,
    rename: {
      lastRenameAt: p.lastRenameAt || null,
      nextRenameAt: nextRenameAt(p),
      canRename: canRename(p),
      cooldownDays: RENAME_COOLDOWN_DAYS,
      minLength: MIN_LENGTH,
      maxLength: MAX_LENGTH,
    },
    notificationKinds: KINDS,
  }
}

/* ───────────────────────────── leaderboards ──────────────────────────── */

/**
 * Board definitions. `metric` produces the number the row is ranked and
 * labelled by; rows scoring 0 on a board that requires progress are dropped
 * so an empty board reads as empty instead of as ten people tied on nothing.
 *
 * `hiddenFromLeaderboard` is honoured exactly as plugins/leaderboard.js does
 * — it's how an owner/admin test account opts out of every ranking view.
 */
const BOARDS = {
  level: {
    label: 'Level',
    unit: 'Lv',
    requirePositive: false,
    metric: p => p.level ?? 1,
    tiebreak: p => p.xp ?? 0,
    format: p => `Lv ${p.level ?? 1}`,
  },
  floor: {
    label: 'Deepest Floor',
    unit: 'Floor',
    requirePositive: true,
    metric: p => Math.max(0, ...Object.values(p.dungeonProgress ?? {}).map(d => d?.highestFloor ?? 0), 0),
    tiebreak: p => p.level ?? 1,
    format: p => `Floor ${Math.max(0, ...Object.values(p.dungeonProgress ?? {}).map(d => d?.highestFloor ?? 0), 0)}`,
  },
  season: {
    label: 'Battle Pass',
    unit: 'Tier',
    requirePositive: true,
    metric: p => p.seasonProgress?.battlePassTier ?? 0,
    tiebreak: p => p.seasonPoints ?? 0,
    format: p => `Tier ${p.seasonProgress?.battlePassTier ?? 0}`,
  },
  fame: {
    label: 'Fame',
    unit: 'Fame',
    requirePositive: true,
    metric: p => p.fame ?? 0,
    tiebreak: p => p.level ?? 1,
    format: p => `${formatFame(p.fame ?? 0)} fame`,
  },
  wealth: {
    label: 'Wealth',
    unit: 'Solars',
    requirePositive: true,
    // Vault and bank count: hoarding somewhere safe is still wealth. This is
    // a ranking only — nothing here can move a balance.
    metric: p => (p.wallet?.solars ?? 0) + (p.wallet?.bankGold ?? 0) + (p.wallet?.vault ?? 0),
    tiebreak: p => p.level ?? 1,
    format: p => `${((p.wallet?.solars ?? 0) + (p.wallet?.bankGold ?? 0) + (p.wallet?.vault ?? 0)).toLocaleString()} ☀️`,
  },
  wins: {
    label: 'PvP Wins',
    unit: 'Wins',
    requirePositive: true,
    /* player.pvp, not player.stats. There is no `stats.wins` anywhere in the
       codebase — lib/pvp-engine.js ensurePvp() owns player.pvp.{wins,losses}
       and lib/combat-handlers.js owns player.battleRecord for PvE. This board
       read p.stats?.wins, so metric() returned 0 for every account, and with
       requirePositive:true that filtered out all of them: the tab rendered
       from /api/meta and then showed an empty list forever. */
    metric: p => p.pvp?.wins ?? 0,
    tiebreak: p => -(p.pvp?.losses ?? 0),
    format: p => `${p.pvp?.wins ?? 0}W – ${p.pvp?.losses ?? 0}L`,
  },
}

function eligiblePlayers(db) {
  return Object.values(db.data.users ?? {}).filter(u => u && u.name && !u.hiddenFromLeaderboard)
}

function buildBoard(db, boardKey, limit) {
  const board = BOARDS[boardKey] ?? BOARDS.level
  const rows = eligiblePlayers(db)
    .map(p => ({ p, score: board.metric(p), tb: board.tiebreak(p) }))
    .filter(r => (board.requirePositive ? r.score > 0 : true))
    .sort((a, b) => b.score - a.score || b.tb - a.tb)

  return {
    board: boardKey,
    label: board.label,
    unit: board.unit,
    total: rows.length,
    rows: rows.slice(0, limit).map((r, i) => ({
      position: i + 1,
      score: r.score,
      display: board.format(r.p),
      uid: publicId(r.p.id),
      name: r.p.name,
      title: r.p.title ?? null,
      avatarUrl: safeImageUrl(r.p.pfp),
      level: r.p.level ?? 1,
      classId: r.p.classId ?? null,
      raceId: r.p.raceId ?? null,
      rank: (() => { const k = getRankForLevel(r.p.level ?? 1); return { title: k.title, emoji: k.emoji } })(),
      premium: isPremiumActive(r.p),
      character: r.p.equippedCharacter
        ? { id: r.p.equippedCharacter, emoji: characterMap[r.p.equippedCharacter]?.emoji ?? null }
        : null,
    })),
  }
}

/** Where a specific player sits on a board, even if outside the top N. */
function positionOf(db, boardKey, jid) {
  const board = BOARDS[boardKey] ?? BOARDS.level
  const rows = eligiblePlayers(db)
    .map(p => ({ id: p.id, score: board.metric(p), tb: board.tiebreak(p) }))
    .filter(r => (board.requirePositive ? r.score > 0 : true))
    .sort((a, b) => b.score - a.score || b.tb - a.tb)
  const idx = rows.findIndex(r => r.id === jid)
  return idx === -1 ? null : { position: idx + 1, of: rows.length, score: rows[idx].score }
}

/* ─────────────────────────── general store ──────────────────────────── */

/**
 * One shop row, in the shape the website's Shop grid renders.
 *
 * `image` runs through safeImageUrl, not hasLiveImage: item plates are served
 * by this very process (see /assets/items/:file), so unlike the season shop
 * there's no dead-host case to filter for. The site falls back to its own
 * glyph on a broken <img>, which is the right behaviour for the rare unmapped
 * id rather than hiding the item — you can still buy it.
 */
function shopRow(entry) {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type ?? null,
    slot: entry.slot ?? null,
    rarity: entry.rarity ?? 'common',
    levelReq: entry.levelReq ?? 1,
    buyPrice: entry.buyPrice ?? null,
    sellPrice: entry.sellPrice ?? null,
    statBonuses: entry.statBonuses ?? null,
    damage: entry.damage ?? null,
    description: entry.description ?? null,
    effectSummary: potionBlurb(entry) || null,
    image: safeImageUrl(entry.image),
    emoji: entry.emoji ?? null,
  }
}

/**
 * The whole buyable catalog, on the same shelves `.shop` uses — weapons by
 * rarity, armor by slot, potions by effect group, relics and tools flat.
 * Grouping comes from lib/shop-catalog.js, so a shelf can't differ between
 * chat and web.
 */
function buildWebShop() {
  const armor = shopItems.filter(i => i.type === 'armor')
  const potions = shopItems.filter(i => i.type === 'consumable')
  const relics = shopItems.filter(i => i.type === 'relic')
  const byLevel = (a, b) => (a.levelReq ?? 1) - (b.levelReq ?? 1)

  const shelf = (key, label, emoji, groups) => ({
    key, label, emoji,
    groups: groups.filter(g => g.rows.length),
    count: groups.reduce((n, g) => n + g.rows.length, 0),
  })

  return [
    shelf('weapons', 'Weapons', '⚔️',
      groupByRarity(shopWeapons).map(g => ({
        key: g.key,
        label: g.key.charAt(0).toUpperCase() + g.key.slice(1),
        rows: [...g.items].sort(byLevel).map(shopRow),
      }))),
    shelf('armor', 'Armor', '🛡️',
      groupBySlot(armor).map(g => ({
        key: g.key,
        label: ARMOR_SLOT_LABELS[g.key] ?? g.key,
        rows: [...g.items].sort(byLevel).map(shopRow),
      }))),
    shelf('potions', 'Potions', '🧪',
      groupPotions(potions).map(g => ({
        key: g.key,
        label: POTION_GROUP_LABELS[g.key] ?? g.key,
        rows: [...g.items].sort(byLevel).map(shopRow),
      }))),
    shelf('relics', 'Relics', '🔮',
      [{ key: 'relics', label: 'Relics', rows: [...relics].sort(byLevel).map(shopRow) }]),
    shelf('tools', 'Tools', '⛏️',
      [{ key: 'tools', label: 'Pickaxes', rows: [...shopTools].sort(byLevel).map(shopRow) }]),
  ].filter(s => s.count)
}

/** Web-side display names for the shared shelf keys. */
const ARMOR_SLOT_LABELS = {
  helmet: 'Helmets', chestplate: 'Chestplates', boots: 'Boots',
  offhand: 'Offhand', other: 'Other',
}
const POTION_GROUP_LABELS = {
  healing: 'Healing', mana: 'Mana Restore', stamina: 'Stamina Restore',
  elixirs: 'Elixirs & Revival', cures: 'Status Cures', buffs: 'Buffs & Shields',
  other: 'Other',
}

/**
 * Tiers a player may buy outright, cheapest first.
 *
 * Tier 5 and tier S are in here now: the whole ladder the Cards API can return
 * is purchasable, priced off TIER_BUY_PRICE in lib/card-engine.js at roughly
 * 2.4x the sell value so buy-then-sell is never a profitable loop. 'S' is last
 * because tierRank() puts it above numeric 6.
 */
const BUYABLE_CARD_TIERS = ['1', '2', '3', '4', '5', '6', 'S']

/* ──────────────────────────────── routes ─────────────────────────────── */

/** Wraps an async handler so a throw becomes a 500 instead of a dead socket. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

function buildApp(db, instances) {
  const app = express()

  // Behind Cloudflare, so req.ip must come from X-Forwarded-For or every
  // request looks like it came from the same proxy address and the OTP
  // per-IP rate limit becomes a global one.
  app.set('trust proxy', true)
  app.disable('x-powered-by')

  /* ── TEMPORARY: one-time data restore upload ─────────────────────────
   * Added to push a local db.json backup onto the Railway volume after
   * the volume was found empty. Remove this whole block once used.
   * Protected by JWT_SECRET so it isn't a public write endpoint.
   *
   * MUST stay above the global express.json({ limit: '32kb' }) below: that
   * global cap would 413 a full db.json before this handler ever ran.
   * Registering the route first lets its own 20mb parser claim the body,
   * while every non-matching request still falls through to the 32kb parser.
   */
  app.post('/api/restore-db', express.json({ limit: '20mb' }), async (req, res) => {
    const token = req.headers['x-restore-key']
    if (!token || token !== config.jwtSecret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' })
    }
    const incoming = req.body
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ ok: false, error: 'expected a JSON object body' })
    }
    try {
      // Land anything the debounced player writer is still holding BEFORE the
      // swap. Without this the restore replaces db.data while a mutation is
      // mid-flush, and the pending write then persists the pre-restore object
      // over the freshly restored one — a restore that silently undoes itself.
      await flushPendingWrites(db)
      db.data = incoming
      await db.write()
      return res.json({
        ok: true,
        users: Object.keys(db.data.users ?? {}).length,
        wroteTo: config.dbPath,
      })
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message })
    }
  })
  /* ── end temporary restore route ──────────────────────────────────── */

  // Railway (like any PaaS) terminates TLS at its edge and forwards over
  // plain HTTP. Without this, req.protocol is 'http', `secure: true` cookies
  // are dropped, and every client looks like it comes from the proxy's IP.
  app.set('trust proxy', 1)

  app.use(express.json({ limit: '32kb' }))
  app.use(cookieParser())

  app.use(cors({
    origin(origin, cb) {
      // No Origin header = same-origin, curl, or a health probe. Allowed:
      // those requests can't carry a browser's ambient credentials anyway.
      // This also covers the recommended Vercel setup, where the site calls
      // /api/* on its own domain and Vercel rewrites it here — those arrive
      // server-to-server with no Origin at all, so CORS never enters into it.
      if (!origin) return cb(null, true)
      if (config.allowedOrigins.includes(origin)) return cb(null, true)
      if (isAllowedPreviewOrigin(origin)) return cb(null, true)
      // Logged, not silent: a blocked origin is the single most common reason
      // for "the site loads but nothing loads on it" after a domain change.
      log(`⚠️ CORS: refused origin ${origin} — add it to ALLOWED_ORIGINS`)
      return cb(new Error(`Origin ${origin} is not allowed`))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }))

  app.use(attachSession(db))

  // Serve the render card's profile-art defaults so the site can use the
  // identical images as a fallback when a player hasn't set their own.
  app.use('/assets/profile', express.static(PROFILE_ASSET_DIR, { maxAge: '7d' }))

  // Item artwork. Nothing is stored on disk any more — each plate is rendered
  // from vendor/game-icons on first request and cached in memory
  // (lib/item-art-cache.mjs). The static mount is kept ahead of it so a manual
  // `node scripts/generate-item-art.mjs` run still wins if someone materialises
  // the folder again; fallthrough hands anything missing to the renderer.
  app.use('/assets/items', express.static(ITEM_ASSET_DIR, {
    maxAge: '365d',
    immutable: true,
    fallthrough: true,
  }))

  app.get('/assets/items/:file', async (req, res) => {
    const id = itemIdFromAssetUrl(`/assets/items/${req.params.file}`)
    if (!id) return res.status(404).json({ error: 'Not found' })
    let plate = null
    try {
      plate = await itemArtBuffer(id)
    } catch {
      return res.status(500).json({ error: 'Render failed' })
    }
    // No plate means an unmapped id, which is the site's cue to draw its own
    // placeholder — same contract as when these were files and 404'd.
    if (!plate) return res.status(404).json({ error: 'No artwork for this item' })
    // Deterministic output for a given id + icon, so it caches as hard as the
    // files did. Immutable is dropped: a re-render after an icon remap should
    // reach clients without a cache-busting query.
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(plate)
  })

  /* ── health & meta ───────────────────────────────────────────────────── */

  app.get('/api/health', (_req, res) => {
    const connected = (instances ?? []).filter(i => i.activeSock).length
    res.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      bots: { total: (instances ?? []).length, connected },
      players: Object.keys(db.data.users ?? {}).length,
      commandsToday: getCommandsToday(),
    })
  })

  /* ── NOTE: /api/restore-db is registered ONCE, above ──────────────────
   * This block used to hold a second, byte-identical registration of the
   * same route. Express only ever runs the first match, so the copy was
   * dead code — but it made the endpoint look like two features, and
   * anyone editing "the restore route" without noticing the duplicate
   * could change a block that never runs. One registration, one place.
   */

  /** Everything the site needs to render forms and labels without hardcoding. */
  app.get('/api/meta', (_req, res) => {
    const season = getActiveSeason(db)
    res.json({
      ok: true,
      botName: config.botName,
      prefix: config.prefix,
      // Public by design — people already DM this number to play.
      botNumber: config.botPublicNumber ?? null,
      supportGroupLink: config.supportGroupLink ?? null,
      classes: listClasses(),
      races: listRaces(),
      ranks,
      boards: Object.entries(BOARDS).map(([id, b]) => ({ id, label: b.label, unit: b.unit })),
      season: season ? { id: season.id, name: season.name, number: season.number } : null,
    })
  })

  /** Numbers for the landing page's live counters. */
  app.get('/api/stats', (_req, res) => {
    const users = Object.values(db.data.users ?? {})
    const now = Date.now()
    const season = getActiveSeason(db)
    const runtime = getSeasonRuntime(db)
    res.json({
      ok: true,
      players: users.length,
      newThisWeek: users.filter(u => now - (u.registeredAt ?? 0) < 7 * 86_400_000).length,
      premiumMembers: users.filter(u => isPremiumActive(u)).length,
      commandsToday: getCommandsToday(),
      highestLevel: users.reduce((m, u) => Math.max(m, u.level ?? 0), 0),
      deepestFloor: users.reduce(
        (m, u) => Math.max(m, ...Object.values(u.dungeonProgress ?? {}).map(d => d?.highestFloor ?? 0), 0),
        0,
      ),
      dungeonsConquered: users.reduce(
        (m, u) => m + Object.values(u.dungeonProgress ?? {}).filter(d => d?.conquered).length,
        0,
      ),
      charactersAvailable: characters.length,
      season: season
        ? { name: season.name, number: season.number, endsAt: runtime.endsAt ?? null }
        : null,
      botsOnline: (instances ?? []).filter(i => i.activeSock).length,
    })
  })

  /* ── auth ────────────────────────────────────────────────────────────── */

  /**
   * Sign-in by character name, step 1: resolve a name (or @handle) to an
   * account WITHOUT sending anything to WhatsApp.
   *
   * PRIVACY: the browser must never learn the account's real phone number, so
   * the response carries only a MASKED number plus an opaque `handle` — a
   * short-lived signed token that stands in for the account (and its real
   * number) in request-otp / verify-otp. This is why the login path exists at
   * all: typing a stranger's name should reveal a confirmation card, never make
   * their phone buzz with a code.
   *
   * Matching is exact on the reserved `@handle` (leading @ optional) first, then
   * exact on the character name, both case-insensitively. Substring matching is
   * deliberately NOT done here: a code is one step away, and "closest name wins"
   * is how you send it to the wrong person. A miss is a flat 404 { found:false }.
   */
  app.post('/api/auth/lookup', wrap(async (req, res) => {
    const typed = String(req.body?.username ?? '').trim().replace(/^@+/, '')
    if (typed.length < 2) {
      return res.status(400).json({ ok: false, found: false, error: 'Enter your username or character name.' })
    }

    const target = typed.toLowerCase()
    let match = null
    for (const p of Object.values(db.data.users ?? {})) {
      if (!p) continue
      // A `handle`/`username` field is optional; the character name is the
      // reliable key every account has, so match on both.
      const uname = String(p.username ?? p.handle ?? '').toLowerCase()
      const pname = String(p.name ?? '').toLowerCase()
      if (uname === target || pname === target) { match = p; break }
    }

    if (!match) {
      return res.status(404).json({ ok: false, found: false, error: `No character goes by "${typed}".` })
    }

    // The handle carries everything request-otp/verify-otp need to reach and
    // key this account, signed so the browser can't forge or alter it and
    // short-lived so a resolved name can't be sat on. `phone` may be absent for
    // a LID-keyed account whose number was never stamped — request-otp falls
    // back to re-resolving it from the JID/LID via onWhatsApp() in that case.
    const handlePhone = match.phone ? normalizePhone(match.phone, config.defaultCountryCode) : null
    const handle = jwt.sign(
      { kind: 'otp_handle', jid: match.id, phone: handlePhone },
      config.jwtSecret,
      { expiresIn: '10m' },
    )

    const rank = getRankForLevel(match.level ?? 1)
    const maskedPhone = handlePhone
      ? `+${handlePhone.slice(0, 3)} ••• ••• ${handlePhone.slice(-3)}`
      : null

    return res.json({
      ok: true,
      found: true,
      handle,
      name: match.name ?? typed,
      username: match.username ?? match.handle ?? null,
      level: match.level ?? 1,
      rank: { title: rank.title, epithet: rank.epithet, emoji: rank.emoji },
      avatarUrl: safeImageUrl(match.pfp) ?? null,
      maskedPhone,
    })
  }))

  /**
   * Decodes the opaque login handle minted by /auth/lookup back into the
   * account it stands for. Returns { jid, phone } on success, or null when the
   * token is missing, forged, expired, or not an otp handle — the caller turns
   * a null into the `handle_expired` response the frontend watches for, which
   * sends the player back to step 1 to look their name up again.
   */
  function decodeOtpHandle(raw) {
    if (!raw || typeof raw !== 'string') return null
    try {
      const payload = jwt.verify(raw, config.jwtSecret)
      if (payload?.kind !== 'otp_handle' || !payload.jid) return null
      return { jid: String(payload.jid), phone: payload.phone ? String(payload.phone) : null }
    } catch {
      return null
    }
  }

  app.post('/api/auth/request-otp', wrap(async (req, res) => {
    // Two ways in. LOGIN passes the opaque `handle` from /auth/lookup — the
    // account is already resolved and the browser never held the number.
    // SIGN-UP passes a typed `phone`, because a new player has no name to look
    // up yet. The handle path takes precedence when both are somehow present.
    const handle = req.body?.handle ? decodeOtpHandle(req.body.handle) : null
    if (req.body?.handle && !handle) {
      // Minted by lookup but no longer valid: expired or tampered. The frontend
      // watches for this exact code and sends the player back to step 1.
      return res.status(401).json({
        ok: false, code: 'handle_expired',
        error: 'That sign-in attempt expired. Search for your name again.',
      })
    }

    // otpKey is what the in-memory store is keyed by (it just needs to match
    // between request and verify). It's the phone when we have one, else the
    // resolved JID — a LID-keyed account often has no stamped number at all.
    let phone, otpKey, dmJid, lid, existing

    if (handle) {
      // Login: trust the signed handle for who this is; only re-resolve what
      // we must. The DM target is the account's own JID.
      dmJid = handle.jid
      phone = handle.phone ? normalizePhone(handle.phone, config.defaultCountryCode) : null
      otpKey = phone ?? `jid:${handle.jid}`
      existing = getPlayer(db, handle.jid) ?? (phone ? findPlayerByPhone(db, phone, handle.jid, null) : null)
      if (!existing) {
        return res.status(404).json({ ok: false, code: 'handle_expired', error: 'That account no longer exists. Search again.' })
      }
    } else {
      // Sign-up: a typed number, normalized and confirmed on WhatsApp.
      const raw = String(req.body?.phone ?? '')
      phone = normalizePhone(raw, config.defaultCountryCode)
      if (!phone) {
        return res.status(400).json({ ok: false, error: 'That does not look like a valid phone number.' })
      }
      log(`otp requested for +${phone.slice(0, 3)}•••${phone.slice(-3)} (typed "${raw.replace(/\d(?=\d{3})/g, '•')}")`)
      otpKey = phone
    }

    // Logged because "I asked for a code and nothing arrived" is otherwise
    // undebuggable. Masked, so a log dump can't be turned into a list of numbers.
    const masked = phone ? `+${phone.slice(0, 3)}•••${phone.slice(-3)}` : `jid ${String(dmJid).slice(0, 6)}•••`

    const gate = checkRateLimit(otpKey, req.ip)
    if (!gate.ok) {
      const secs = Math.ceil(gate.retryAfterMs / 1000)
      return res.status(429).json({
        ok: false,
        error: gate.reason === 'cooldown'
          ? `Hold on — you can request another code in ${secs}s.`
          : 'Too many code requests. Try again later.',
        retryAfterMs: gate.retryAfterMs,
      })
    }

    const sock = liveSocket(instances)
    if (!sock) {
      log('⚠️ otp aborted — no bot socket is connected')
      return res.status(503).json({
        ok: false,
        error: 'The bot is reconnecting right now. Try again in a minute.',
      })
    }

    // Sign-up must confirm the number is on WhatsApp and find its JID/LID.
    // Login already has both from the handle, so it skips the extra round trip.
    if (!handle) {
      const resolved = await resolveWhatsAppJid(sock, phone)
      if (!resolved.jid && resolved.verified) {
        log(`otp aborted — ${masked} is not on WhatsApp`)
        return res.status(404).json({ ok: false, error: 'That number is not on WhatsApp.' })
      }
      dmJid = resolved.jid
      lid = resolved.lid
      existing = findPlayerByPhone(db, phone, dmJid, lid)
    }

    const { code, expiresAt, ttlMs } = issue(otpKey, { ttlMs: config.otpTtlMs, ip: req.ip, jid: dmJid, lid })
    const jid = dmJid

    // Same synthetic-send pattern main.js's sweeps use for non-command sends.
    try {
      await sock.sendMessage(jid, {
        text:
          `🔐 *Astral — sign-in code*\n\n` +
          `Your code is *${code}*\n\n` +
          `It expires in ${Math.round(ttlMs / 60_000)} minutes and can only be used once.\n\n` +
          `_If you didn't try to sign in on the website, ignore this message — and never share this code with anyone, including staff._`,
      })
      log(`otp DM sent → ${jid} (${masked})`)
    } catch (err) {
      discard(otpKey)
      // Log the real reason — the user-facing string below is deliberately
      // vague, so this is the only place the actual cause is recorded.
      log(`⚠️ OTP DM failed → ${jid} (${masked}):`, err?.message ?? err)
      return res.status(502).json({
        ok: false,
        // This used to say "Make sure you've messaged the bot at least once",
        // which sent people chasing a problem on their end that wasn't there.
        // A send failure here is almost always the bot's connection, not the
        // recipient — WhatsApp does not require prior contact to receive a DM.
        error: "Couldn't deliver the code right now. Please try again in a moment.",
      })
    }

    return res.json({
      ok: true,
      message: 'OTP has been sent to your DM',
      // Never the full number — just enough for "…is that the right phone?".
      // A LID-keyed login has no number to show, so it comes back null and the
      // frontend keeps the mask it already had from lookup (or says "your DM").
      maskedPhone: phone ? `+${phone.slice(0, 3)} ••• ••• ${phone.slice(-3)}` : null,
      registered: !!existing,
      expiresAt,
      ttlMs,
      // Local testing only. config.js is explicit that DEV_MODE must be
      // false in production, or anyone could sign in as anyone else.
      ...(config.devMode ? { devCode: code } : {}),
    })
  }))

  app.post('/api/auth/verify-otp', wrap(async (req, res) => {
    // Must normalize with the SAME country code request-otp used, or the
    // pending code (keyed by the normalized phone) is never found.
    //
    // Two paths, mirroring request-otp: LOGIN presents the same signed `handle`
    // (the code was issued under that account's key), SIGN-UP presents the typed
    // `phone`. The key MUST match what request-otp issued under, or the pending
    // code is never found.
    const handle = req.body?.handle ? decodeOtpHandle(req.body.handle) : null
    if (req.body?.handle && !handle) {
      return res.status(401).json({
        ok: false, code: 'handle_expired',
        error: 'That sign-in attempt expired. Search for your name again.',
      })
    }

    let phone = null
    let otpKey
    if (handle) {
      phone = handle.phone ? normalizePhone(handle.phone, config.defaultCountryCode) : null
      otpKey = phone ?? `jid:${handle.jid}`
    } else {
      phone = normalizePhone(req.body?.phone, config.defaultCountryCode)
      if (!phone) return res.status(400).json({ ok: false, error: 'Invalid phone number.' })
      otpKey = phone
    }

    const result = verify(otpKey, req.body?.code)
    if (!result.ok) {
      const messages = {
        not_found: 'No pending code for that number. Request a new one.',
        expired: 'That code expired. Request a new one.',
        too_many_attempts: 'Too many wrong attempts. Request a new code.',
        mismatch: `Incorrect code.${result.attemptsLeft ? ` ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.` : ''}`,
      }
      return res.status(401).json({
        ok: false,
        error: messages[result.reason] ?? 'Verification failed.',
        attemptsLeft: result.attemptsLeft,
      })
    }

    // The login handle names the account directly, so trust it: the LID-retry
    // dance below exists only to disambiguate "is this a brand-new number?" on
    // sign-up, which cannot arise when we already resolved the character.
    if (handle) {
      const existing = getPlayer(db, handle.jid)
        ?? (phone ? findPlayerByPhone(db, phone, handle.jid, null) : null)
      if (!existing) {
        return res.status(404).json({ ok: false, code: 'handle_expired', error: 'That account no longer exists. Search again.' })
      }
      if (phone && existing.phone !== phone) {
        await updatePlayer(db, existing.id, p => { p.phone = phone }).catch(() => {})
      }
      const token = issueSession(res, existing, req)
      await notifyPlayer(db, instances, existing.id, {
        kind: 'security',
        title: 'New sign-in to your account',
        body: `Someone signed in to the Astral website with a code sent to this number. If that wasn't you, reply here right away.`,
      }).catch(() => {})
      return res.json({
        ok: true,
        token,
        needsRegistration: false,
        player: serializeSelf(db, existing),
      })
    }

    const jid = result.jid ?? `${phone}@s.whatsapp.net`
    let lid = result.lid ?? null
    let existing = findPlayerByPhone(db, phone, jid, lid)

    // Retry the LID lookup before ever concluding "this number is new".
    //
    // Nearly every account is keyed by `@lid`, and an id like
    // `170823868481696@lid` shares no digits with the owner's phone number, so
    // for any of them that has not had `phone` stamped yet the LID handed back
    // by onWhatsApp() is the ONLY thing that can connect a code to a character.
    // resolveWhatsAppJid swallows a failed lookup and returns lid: null, which
    // silently turned "WhatsApp is throttling us" into "you have no character"
    // and then offered to mint a duplicate on top of a live account.
    //
    // A genuinely new number still comes back WITH a LID (it is on WhatsApp, it
    // just has no character), so a null LID means the lookup failed rather than
    // that the number is unknown. That is what makes this safe to distinguish.
    if (!existing && !lid) {
      const sock = liveSocket(instances)
      if (sock) {
        const retry = await resolveWhatsAppJid(sock, phone)
        lid = retry.lid ?? null
        if (lid) existing = findPlayerByPhone(db, phone, jid, lid)
      }
      if (!existing && !lid) {
        log(`⚠️ verify-otp: LID lookup unavailable for ${phone.slice(0, 3)}•••${phone.slice(-3)}, refusing to treat as a new player`)
        return res.status(503).json({
          ok: false,
          error: "WhatsApp didn't confirm your account just now, so we can't tell whether you already have a character. Nothing was changed, please try again in a minute.",
        })
      }
    }

    if (!existing) {
      // Verified, no character, and the lookup itself worked, so this really is
      // a new player. Hand back a session anyway so the sign-up page can
      // complete registration without a second OTP round.
      const token = issueSession(res, { id: jid }, req)
      return res.json({ ok: true, token, needsRegistration: true, player: null })
    }

    // Remember the phone so future logins skip the JID guessing entirely.
    // Matters for LID-based accounts, whose id never contains their number.
    if (existing.phone !== phone) {
      await updatePlayer(db, existing.id, p => { p.phone = phone }).catch(() => {})
    }

    const token = issueSession(res, existing, req)

    await notifyPlayer(db, instances, existing.id, {
      kind: 'security',
      title: 'New sign-in to your account',
      body: `Someone signed in to the Astral website with a code sent to this number. If that wasn't you, reply here right away.`,
    }).catch(() => {})

    return res.json({
      ok: true,
      token,
      needsRegistration: false,
      player: serializeSelf(db, existing),
    })
  }))

  /** Sign-up: completes a character for an OTP-verified number. */
  app.post('/api/auth/register', requireSession, wrap(async (req, res) => {
    if (playerExists(db, req.jid)) {
      return res.status(409).json({ ok: false, error: 'This number already has a character.' })
    }

    const check = validateRegistration({
      name: req.body?.name,
      classId: req.body?.classId,
      raceId: req.body?.raceId,
    })
    if (!check.ok) return res.status(400).json({ ok: false, error: check.error })

    const taken = Object.values(db.data.users ?? {})
      .some(u => String(u?.name ?? '').toLowerCase() === check.name.toLowerCase())
    if (taken) return res.status(409).json({ ok: false, error: 'That name is already taken.' })

    const player = buildNewPlayer({
      id: req.jid,
      name: check.name,
      classId: check.classId,
      raceId: check.raceId,
    })
    player.phone = normalizePhone(jidDigits(req.jid))
    await createPlayer(db, req.jid, player)

    await pushNotification(db, req.jid, {
      kind: 'system',
      title: `Welcome to Astral, ${player.name}`,
      body: `Your ${check.classId} was created on the website. Type ${config.prefix}profile in chat to see it.`,
    }).catch(() => {})

    const sock = liveSocket(instances)
    if (sock) {
      sock.sendMessage(req.jid, {
        text:
          `✅ *Welcome, ${player.name}!* Your character was created on the website.\n\n` +
          `⚔️ Class: *${check.classId}*\n🧬 Race: *${check.raceId}*\n` +
          `❤️ HP: ${player.maxHp}  💧 MP: ${player.maxMp}\n\n` +
          `_Type *${config.prefix}profile* to view your stats.\n` +
          `Type *${config.prefix}enter entry_tower* to begin your first dungeon._`,
      }).catch(() => {})
    }

    return res.status(201).json({ ok: true, player: serializeSelf(db, player) })
  }))

  app.get('/api/auth/session', (req, res) => {
    if (!req.jid) return res.json({ ok: true, signedIn: false, player: null })
    res.json({
      ok: true,
      signedIn: true,
      needsRegistration: !req.player,
      player: req.player ? serializeSelf(db, req.player) : null,
    })
  })

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'none', path: '/' })
    res.json({ ok: true })
  })

  /* ── me ──────────────────────────────────────────────────────────────── */

  app.get('/api/me', requirePlayer, (req, res) => {
    res.json({ ok: true, player: serializeSelf(db, req.player) })
  })

  /* ── settings ────────────────────────────────────────────────────────────
     Preference toggles, separate from PATCH /api/me because they're a
     different shape of write: no validation gates, no cooldowns, and each one
     is independently optional so the client can send a single toggle without
     restating the rest. Everything here is stored on the player record so the
     bot sees the same values — hiddenFromLeaderboard in particular is an
     existing bot-side field that plugins/leaderboard.js and plugins/top.js
     already honour; this just gives players a way to set it themselves. */
  app.patch('/api/me/settings', requirePlayer, wrap(async (req, res) => {
    const body = req.body ?? {}
    const touched = []

    const updated = await updatePlayer(db, req.jid, (p) => {
      if (typeof body.hiddenFromLeaderboard === 'boolean') {
        p.hiddenFromLeaderboard = body.hiddenFromLeaderboard
        touched.push('hiddenFromLeaderboard')
      }

      if (Array.isArray(body.mutedNotificationKinds)) {
        const prefs = (p.webPrefs && typeof p.webPrefs === 'object') ? p.webPrefs : {}
        prefs.mutedNotificationKinds = body.mutedNotificationKinds
          .filter(k => KINDS.includes(k))
        p.webPrefs = prefs
        touched.push('mutedNotificationKinds')
      }

      if (typeof body.dmNotifications === 'boolean') {
        const prefs = (p.webPrefs && typeof p.webPrefs === 'object') ? p.webPrefs : {}
        prefs.dmNotifications = body.dmNotifications
        p.webPrefs = prefs
        touched.push('dmNotifications')
      }

      return p
    })

    if (!touched.length) {
      return res.status(400).json({ ok: false, error: 'No recognized setting to update.' })
    }
    res.json({ ok: true, updated: touched, player: serializeSelf(db, updated) })
  }))

  /**
   * Invalidates every session for this player, including the caller's. Bumps
   * player.sessionEpoch, which strands all previously-minted tokens (see
   * issueSession), then clears the local cookie so this tab is signed out too.
   */
  app.post('/api/me/sessions/revoke', requirePlayer, wrap(async (req, res) => {
    await updatePlayer(db, req.jid, (p) => {
      p.sessionEpoch = Date.now()
      return p
    })
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'none', path: '/' })
    await notifyPlayer(db, instances, req.jid, {
      kind: 'security',
      title: 'Signed out everywhere',
      body: 'Every device signed in to your account was signed out from settings.',
    }).catch(() => {})
    res.json({ ok: true })
  }))

  /** Board standings for the signed-in player, for the profile page. */
  app.get('/api/me/rankings', requirePlayer, (req, res) => {
    const out = {}
    for (const key of Object.keys(BOARDS)) out[key] = positionOf(db, key, req.jid)
    res.json({ ok: true, rankings: out })
  })

  app.patch('/api/me', requirePlayer, wrap(async (req, res) => {
    const payload = req.body ?? {}

    // Bio
    if (typeof payload.bio === 'string') {
      const raw = payload.bio.trim()
      const words = raw.split(/\s+/).filter(Boolean)
      if (words.length > 9) {
        return res.status(400).json({ ok: false, error: 'Bio must be 9 words or fewer.' })
      }
      if (raw.length > 120) {
        return res.status(400).json({ ok: false, error: 'Bio must be 120 characters or fewer.' })
      }
      const updated = await updatePlayer(db, req.jid, p => { p.bio = raw || null })
      return res.json({ ok: true, player: serializeSelf(db, updated) })
    }

    // Name — same rules and same cooldown as the bot's .rename, because both
    // go through lib/rename-rules.js.
    if (typeof payload.name === 'string') {
      const outcome = await renamePlayer(db, req.jid, payload.name)

      if (!outcome.ok) {
        const message = {
          empty: 'Name cannot be empty.',
          length: `Name must be ${MIN_LENGTH}-${MAX_LENGTH} characters.`,
          charset: `Name can only contain letters, numbers, spaces, and -_.'`,
          same: 'That is already your name.',
          cooldown: `You can rename again in ${formatRemaining(outcome.remainingMs ?? 0)}.`,
        }[outcome.reason] ?? 'Could not change your name.'

        return res.status(400).json({
          ok: false,
          error: message,
          onCooldown: outcome.reason === 'cooldown',
          nextRenameAt: outcome.nextAllowedAt ?? null,
        })
      }

      return res.json({ ok: true, player: serializeSelf(db, getPlayer(db, req.jid)) })
    }

    return res.status(400).json({ ok: false, error: 'No recognized field to update.' })
  }))

  /* ── profile picture / banner upload ──────────────────────────────────── */

  // Images are POSTed as a base64 data URL in JSON. The global body limit is
  // 32kb — deliberately tight for the rest of the API — so this one route
  // gets its own parser with a larger ceiling rather than raising the limit
  // for every endpoint. base64 inflates by ~4/3, hence the headroom over
  // MAX_IMAGE_BYTES.
  const uploadJson = express.json({ limit: '8mb' })

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

  // Magic-number check. The declared mime type in a data URL is attacker-
  // controlled — it's just a string in the request body — so the bytes are
  // what's actually trusted here.
  const MAGIC = [
    { type: 'image/png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
    { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { type: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  ]

  function sniffImageType(buf) {
    for (const { type, bytes } of MAGIC) {
      if (bytes.every((b, i) => buf[i] === b)) return type
    }
    // WebP is "RIFF....WEBP" — the size field sits between the two markers.
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
        buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    return null
  }

  /**
   * Decodes a `data:image/png;base64,...` payload into a Buffer, rejecting
   * anything that isn't actually an image. Returns { buffer } or { error }.
   */
  function decodeImagePayload(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return { error: 'Expected a base64 data URL.' }
    }
    const match = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/s)
    if (!match) return { error: 'Malformed data URL.' }

    const [, declaredType, b64] = match
    if (!ALLOWED_IMAGE_TYPES.has(declaredType)) {
      return { error: 'Only PNG, JPEG, WebP and GIF images are allowed.' }
    }

    let buffer
    try {
      buffer = Buffer.from(b64, 'base64')
    } catch {
      return { error: 'Could not decode that image.' }
    }
    if (!buffer.length) return { error: 'That image is empty.' }
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { error: `Image must be under ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB.` }
    }

    const actualType = sniffImageType(buffer)
    if (!actualType) return { error: "That file isn't a valid image." }

    return { buffer, type: actualType }
  }

  /**
   * Hosts the site's frontend allows uploading in two shapes, and both have to
   * work:
   *
   *   { image: 'data:image/png;base64,...' }  — raw bytes, we upload to ImgBB
   *   { url:   'https://i.ibb.co/xxxx.png' }  — already hosted, we just store it
   *
   * The second is what assets/js/app.js actually sends: it pushes the file
   * through its own Vercel ImgBB proxy first (so the key never reaches the
   * browser) and hands us back the finished URL. Accepting only `image` was
   * the bug — every upload from the site 400'd on "Expected a base64 data URL"
   * because that field was never present.
   *
   * A caller-supplied URL is not trusted blind: it has to be https and it has
   * to be on an ImgBB host. Otherwise player.pfp becomes an arbitrary-URL sink
   * that gets rendered into every profile card and leaderboard row, which is
   * both an SSRF vector (lib/profile-card-render.mjs fetches it server-side)
   * and a way to point the whole site at anything.
   */
  const IMAGE_URL_HOSTS = new Set(['i.ibb.co', 'ibb.co', 'image.ibb.co'])

  function validateHostedUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { error: 'No image URL supplied.' }
    let parsed
    try {
      parsed = new URL(raw.trim())
    } catch {
      return { error: 'That image URL is malformed.' }
    }
    if (parsed.protocol !== 'https:') return { error: 'The image URL must be https.' }
    if (!IMAGE_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
      return { error: 'Images have to be hosted on ImgBB.' }
    }
    return { url: parsed.toString() }
  }

  // A slow, expensive, outbound-network route — rate-limited per player so a
  // single account can't be used to hammer ImgBB (or run up its quota).
  const UPLOAD_COOLDOWN_MS = 30 * 1000
  const lastUpload = new Map()

  app.post('/api/me/:kind(pfp|banner)', requirePlayer, uploadJson, wrap(async (req, res) => {
    const kind = req.params.kind

    const last = lastUpload.get(req.jid)
    if (last && Date.now() - last < UPLOAD_COOLDOWN_MS) {
      const secs = Math.ceil((UPLOAD_COOLDOWN_MS - (Date.now() - last)) / 1000)
      return res.status(429).json({ ok: false, error: `Please wait ${secs}s before uploading again.` })
    }

    const hasUrl = typeof req.body?.url === 'string' && req.body.url.trim()
    const hasImage = typeof req.body?.image === 'string' && req.body.image.trim()
    if (!hasUrl && !hasImage) {
      return res.status(400).json({ ok: false, error: 'Send either an image or a hosted url.' })
    }

    let url
    if (hasUrl) {
      // Already hosted by the site's own ImgBB proxy — nothing to upload, we
      // only have to decide whether to trust the URL.
      const checked = validateHostedUrl(req.body.url)
      if (checked.error) return res.status(400).json({ ok: false, error: checked.error })
      url = checked.url
    } else {
      const { buffer, error } = decodeImagePayload(req.body.image)
      if (error) return res.status(400).json({ ok: false, error })

      try {
        url = await uploadToImgbb(buffer, `${kind}-${req.jid.replace(/\D/g, '')}-${Date.now()}`)
      } catch (err) {
        // Surfaced rather than swallowed: "upload failed" with no reason is the
        // single most common thing a user reports and the hardest to diagnose.
        logger.warn({ err: err.message, jid: req.jid, kind }, 'Site image upload failed')
        return res.status(502).json({ ok: false, error: err.message })
      }
    }

    lastUpload.set(req.jid, Date.now())
    const updated = await updatePlayer(db, req.jid, p => {
      if (kind === 'pfp') p.pfp = url
      else p.banner = url
    })

    return res.json({ ok: true, url, player: serializeSelf(db, updated) })
  }))

  // Removing one is just clearing the field — the ImgBB copy is left alone
  // (there's no delete token stored, and orphaned images cost nothing).
  app.delete('/api/me/:kind(pfp|banner)', requirePlayer, wrap(async (req, res) => {
    const kind = req.params.kind
    const updated = await updatePlayer(db, req.jid, p => {
      if (kind === 'pfp') p.pfp = null
      else p.banner = null
    })
    return res.json({ ok: true, player: serializeSelf(db, updated) })
  }))

  /* ── notifications ───────────────────────────────────────────────────── */

  app.get('/api/notifications', requireSession, (req, res) => {
    // Muted kinds are filtered on read rather than at push time — the history
    // stays intact, so unmuting a kind brings its past entries back instead of
    // leaving a hole in the timeline.
    const muted = new Set(req.player?.webPrefs?.mutedNotificationKinds ?? [])
    const visible = n => !muted.has(n.kind)

    const stored = listNotifications(db, req.jid).filter(visible)
    const acked = listDerivedAcks(db, req.jid)
    const dismissed = listDerivedDismissals(db, req.jid)
    const derived = (req.player
      ? buildSelfAlerts(db, req.player)
          // Dismissed alerts stay gone until the underlying state changes their
          // signature, which is what makes "Clear" work on a bell that holds
          // nothing but derived alerts.
          .filter(a => !dismissed.has(derivedSignature(a)))
          .map((a, i) => ({
            id: `d_${i}_${a.kind}`,
            kind: a.kind,
            title: a.title,
            body: a.body,
            meta: a.meta,
            at: Date.now(),
            // Derived alerts used to be hardcoded unread, which made "Mark read"
            // silently useless for them — see the ack block in
            // lib/notification-repo.js.
            read: acked.has(derivedSignature(a)),
            derived: true,
            severity: a.severity,
          }))
      : []).filter(visible)

    const storedUnread = stored.filter(n => !n.read).length

    res.json({
      ok: true,
      // Stored notifications first, newest first. Derived alerts used to be
      // floated above them on the grounds that they're "the things that still
      // need doing" — but they are recomputed on every 30s poll and all carry
      // at: Date.now(), so they formed a permanent wall of "Daily reward
      // available" / "2 stat points unspent" sitting on top of real, dated,
      // one-shot events. That buried the .connect code, which lives for five
      // minutes and which plugins/connect.js explicitly tells the player is
      // "the newest notification".
      //
      // Real history is what a notification bell is for; the derived nags are
      // standing state and read fine underneath it.
      items: [...stored, ...derived],
      unread: storedUnread
        + derived.filter(d => !d.read && d.severity !== 'info').length,
      storedUnread,
    })
  })

  app.post('/api/notifications/read-all', requireSession, wrap(async (req, res) => {
    const changed = await markAllRead(db, req.jid)
    // "Mark read" has to cover what the user can actually see, and derived
    // alerts are most of that list. Acking them here is what makes the bell
    // stay clear instead of relighting on the next 30s poll.
    const ackedNow = req.player
      ? await ackDerived(db, req.jid, buildSelfAlerts(db, req.player))
      : 0
    res.json({ ok: true, changed, ackedDerived: ackedNow })
  }))

  app.post('/api/notifications/:id/read', requireSession, wrap(async (req, res) => {
    const changed = await markRead(db, req.jid, req.params.id)
    res.json({ ok: true, changed })
  }))

  app.delete('/api/notifications/:id', requireSession, wrap(async (req, res) => {
    // Derived ids look like `d_<index>_<kind>` and have no stored row to
    // delete — dismissing them by signature is what actually removes them.
    if (String(req.params.id).startsWith('d_') && req.player) {
      const target = buildSelfAlerts(db, req.player)
        .find((a, i) => `d_${i}_${a.kind}` === req.params.id)
      const changed = target ? await dismissDerived(db, req.jid, [target]) : 0
      return res.json({ ok: true, changed: changed > 0 })
    }
    const changed = await deleteNotification(db, req.jid, req.params.id)
    res.json({ ok: true, changed })
  }))

  app.delete('/api/notifications', requireSession, wrap(async (req, res) => {
    const cleared = await clearNotifications(db, req.jid)
    // Clear has to cover the whole visible list. Without this, a bell holding
    // only derived alerts cleared to exactly the same list it started with.
    const hidden = req.player
      ? await dismissDerived(db, req.jid, buildSelfAlerts(db, req.player))
      : 0
    res.json({ ok: true, cleared, dismissedDerived: hidden })
  }))

  /* ── leaderboard ─────────────────────────────────────────────────────── */

  app.get('/api/leaderboard', (req, res) => {
    const boardKey = Object.prototype.hasOwnProperty.call(BOARDS, req.query.board)
      ? String(req.query.board)
      : 'level'
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25))
    const payload = buildBoard(db, boardKey, limit)
    res.json({
      ok: true,
      ...payload,
      you: req.jid ? positionOf(db, boardKey, req.jid) : null,
    })
  })

  /** Tapping a leaderboard row: that player's stats + their public alerts. */
  app.get('/api/players/:uid', (req, res) => {
    const p = findByPublicId(db, req.params.uid)
    if (!p) return res.status(404).json({ ok: false, error: 'Player not found.' })
    if (p.hiddenFromLeaderboard) {
      return res.status(404).json({ ok: false, error: 'Player not found.' })
    }
    const rankings = {}
    for (const key of Object.keys(BOARDS)) rankings[key] = positionOf(db, key, p.id)
    res.json({
      ok: true,
      player: serializePublicPlayer(db, p, { withAlerts: true }),
      rankings,
      isSelf: req.jid === p.id,
    })
  })

  /* ── characters ──────────────────────────────────────────────────────── */

  app.get('/api/characters', (req, res) => {
    const owned = new Set(req.player?.ownedCharacters ?? [])
    res.json({
      ok: true,
      characters: characters.map(c => ({
        ...characterSummary(c.id),
        owned: owned.has(c.id),
        equipped: req.player?.equippedCharacter === c.id,
      })),
    })
  })

  app.get('/api/characters/:id', (req, res) => {
    const c = characterSummary(req.params.id)
    if (!c) return res.status(404).json({ ok: false, error: 'Character not found.' })

    // Who's using this character right now — a nice social proof signal, and
    // it stays public-safe because it goes through the same serializer the
    // leaderboard uses.
    const users = eligiblePlayers(db)
      .filter(p => p.equippedCharacter === c.id)
      .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
      .slice(0, 8)
      .map(p => ({
        uid: publicId(p.id),
        name: p.name,
        level: p.level ?? 1,
        avatarUrl: safeImageUrl(p.pfp),
      }))

    res.json({
      ok: true,
      character: c,
      owned: !!req.player?.ownedCharacters?.includes(c.id),
      equipped: req.player?.equippedCharacter === c.id,
      wielders: users,
      wielderCount: eligiblePlayers(db).filter(p => p.equippedCharacter === c.id).length,
    })
  })

  /* ── character spin banners ──────────────────────────────────────────────
     The website's half of the spin banners the bot runs in chat. The odds, the
     caps and the pull loop are NOT reimplemented here: both entry points call
     runSpinBatch() from lib/spin-banners.js, so a tune to the curve moves chat
     and web together. Only characters registered there are spinnable from the
     site; everything else 404s, which is the right default for a chat-only
     banner.

     What is never emitted: deadZoneUntil and plateauChance. The site shows the
     same pity bar chat does (progress toward the lifetime cap) and nothing
     more, matching every banner in the bot. */

  /** Shared shape for both spin routes, so a status poll and a pull agree.
   *  Takes the player record and jid explicitly rather than the request, so the
   *  POST can report the state as of AFTER its own write. */
  function spinBannerState(player, jid, banner) {
    const winner = banner.exclusive ? getExclusiveSpinWinner(db, banner.id) : null
    const holder = winner ? db.data.users?.[winner] : null
    const used = player?.[banner.spinField] ?? 0
    return {
      cost: banner.costPerSpin,
      currency: banner.currency,
      exclusive: !!banner.exclusive,
      maxSpins: banner.maxSpinsPerPlayer,
      maxPerPull: banner.maxSpinsPerCommand,
      spinsUsed: used,
      spinsLeft: Math.max(0, banner.maxSpinsPerPlayer - used),
      // Owner freeze — the ctx-free half of lib/spin-locks.js's gate.
      locked: isSpinLocked(banner.id),
      claimed: !!winner,
      claimedByYou: !!winner && winner === jid,
      // Never the JID: a player id is a phone number. Name only.
      claimedBy: winner && winner !== jid ? (holder?.name ?? null) : null,
      owned: !!player?.ownedCharacters?.includes(banner.id),
      equipped: player?.equippedCharacter === banner.id,
      gems: player ? roundGems(player.wallet?.gems ?? 0) : null,
    }
  }

  /**
   * Every registered banner at once, which is what the website's banner
   * section actually renders. Listing them here rather than hardcoding ids in
   * the frontend means a new banner appears on the site the moment it is added
   * to SPIN_BANNERS, with no site deploy.
   */
  app.get('/api/spins', (req, res) => {
    const banners = Object.values(SPIN_BANNERS).map(banner => {
      const character = characterSummary(banner.id)
      if (!character) return null
      const state = spinBannerState(req.player, req.jid, banner)
      return {
        character,
        ...state,
        canSpin: !!req.player && !state.locked && !state.claimed && state.spinsLeft > 0,
      }
    }).filter(Boolean)

    res.json({ ok: true, banners })
  })

  /**
   * Banner status. Session-optional: signed out callers get everything except
   * their own spin count and balance, so the banner renders for visitors.
   */
  app.get('/api/characters/:id/spin', (req, res) => {
    const banner = getSpinBanner(req.params.id)
    if (!banner) return res.status(404).json({ ok: false, error: 'That character has no spin banner.' })

    const character = characterSummary(banner.id)
    if (!character) return res.status(404).json({ ok: false, error: 'Character not found.' })

    const state = spinBannerState(req.player, req.jid, banner)
    res.json({
      ok: true,
      character,
      ...state,
      // The one thing the site can act on. Every other refusal is the API's.
      canSpin: !!req.player && !state.locked && !state.claimed && state.spinsLeft > 0,
    })
  })

  /**
   * Spin the banner. Same gates as the chat plugin and in the same order:
   * banner exists → not frozen by the owner → not already claimed → run the
   * batch on the serialized write queue. Nothing is charged before the last
   * step, so every refusal above costs the player nothing.
   */
  app.post('/api/characters/:id/spin', requirePlayer, wrap(async (req, res) => {
    const banner = getSpinBanner(req.params.id)
    if (!banner) return res.status(404).json({ ok: false, error: 'That character has no spin banner.' })

    const character = characterSummary(banner.id)
    if (!character) return res.status(404).json({ ok: false, error: 'Character not found.' })

    if (isSpinLocked(banner.id)) {
      return res.status(423).json({
        ok: false,
        error: `${character.name}'s banner is closed right now. Nothing was charged.`,
      })
    }

    let outcome = null
    const updated = await updatePlayer(db, req.jid, player => {
      outcome = runSpinBatch(db, player, banner, req.jid, req.body?.count)
      return player
    })

    if (outcome?.reason === 'owned') {
      return res.status(409).json({ ok: false, error: `${character.name} is already yours.`, owned: true })
    }
    if (outcome?.reason === 'claimed') {
      return res.status(409).json({
        ok: false,
        error: `${character.name} has been claimed by another player. Nothing was charged.`,
        claimed: true,
      })
    }
    if (outcome?.reason === 'gems') {
      return res.status(402).json({
        ok: false,
        error: `Not enough gems — one spin costs ${outcome.cost}, and you hold ${fmtGems(outcome.gems)}.`,
      })
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return res.status(409).json({
        ok: false,
        error: `You have used all ${banner.maxSpinsPerPlayer} of your spins for ${character.name}.`,
      })
    }

    const last = outcome.results[outcome.results.length - 1]

    // Same bell a card pull rings, so a win on the site is visible from chat.
    if (outcome.reason === 'won') {
      await pushNotification(db, req.jid, {
        kind: 'reward',
        title: `${character.name} obtained`,
        body: `Won on spin ${last.spin}${banner.exclusive ? ' — one-of-one, locked bot-wide.' : '.'}`,
        meta: { characterId: banner.id, spin: last.spin },
      }).catch(() => {})
    }

    res.json({
      ok: true,
      // Spread first, then the per-pull fields, so the two `spinsUsed`
      // meanings can't collide: the state helper's is the LIFETIME total (what
      // the pity bar reads), and this pull's own count is spinsThisPull. They
      // are different numbers and the site shows both in the same modal.
      ...spinBannerState(updated, req.jid, banner),
      won: outcome.reason === 'won',
      character,
      results: outcome.results,
      spinsThisPull: outcome.spinsUsed,
      requested: outcome.count,
      lastSpin: last.spin,
      spent: roundGems(outcome.spinsUsed * banner.costPerSpin),
      balance: outcome.remaining,
      player: serializeSelf(db, updated),
    })
  }))

  /* ── season ──────────────────────────────────────────────────────────── */

  app.get('/api/season', (req, res) => {
    const season = getActiveSeason(db)
    const runtime = getSeasonRuntime(db)
    if (!season) {
      return res.json({ ok: true, active: false, season: null, runtime, player: null })
    }

    const now = Date.now()
    const tierCount = season.battlePass?.tierCount ?? 50
    const playerTier = req.player?.seasonProgress?.seasonId === season.id
      ? (req.player.seasonProgress.battlePassTier ?? 0)
      : 0
    const claimed = new Set(req.player?.seasonProgress?.claimedTiers ?? [])

    const catalog = getSeasonCatalog(season)
    const shopForWeb = catalog.reduce((out, entry) => {
      const info = describeSeasonEntry(entry)
      const image = safeImageUrl(info.image)
      if (!hasLiveImage(image)) return out
      out.push({
        id: entry.id,
        rewardType: entry.rewardType,
        category: entry.category ?? 'other',
        price: entry.price,
        purchaseLimit: entry.purchaseLimit ?? null,
        amount: entry.amount ?? null,
        name: info.name,
        emoji: info.emoji,
        image,
        rarity: info.rarity,
        kind: info.kind,
        description: info.description || null,
      })
      return out
    }, [])
    const shownIds = new Set(shopForWeb.map(e => e.id))

    res.json({
      ok: true,
      active: true,
      season: {
        id: season.id,
        name: season.name,
        number: season.number,
        description: season.description,
        durationDays: season.durationDays,
        tierCount,
        premiumCost: season.battlePass?.premiumCost ?? null,
        premiumCurrency: season.battlePass?.premiumCurrency ?? null,
        floorCount: season.floorCount ?? null,
        dungeonBoostPercent: season.dungeonBoostPercent ?? null,
        bonuses: season.bonuses ?? null,
        characters: Object.fromEntries(
          Object.entries(season.characters ?? {}).map(([tier, id]) => [tier, characterSummary(id)]),
        ),
        // Flat, ordered, deduped version of the above merged with the shop's
        // own character rows — this is what the site's roster grid renders.
        // See buildSeasonRoster() for why `characters` alone isn't enough.
        roster: buildSeasonRoster(season, catalog),
        // Story text for each featured character, plus the season guide.
        // Already in data/seasons.json; simply never shipped before.
        lore: season.lore ?? null,
        // { keepUnlockedContent, seasonPointsToSolars } — what happens to
        // leftover season points when the season closes.
        endOfSeason: season.endOfSeason ?? null,
      },
      runtime: {
        startedAt: runtime.startedAt ?? null,
        endsAt: runtime.endsAt ?? null,
        remainingMs: Math.max(0, (runtime.endsAt ?? now) - now),
        meiClaimed: !!runtime.meiWonBy,
      },
      // The full 50-tier ladder, with claim state layered on for the viewer.
      // rewardLabel() is the same formatter the chat `.season` view uses, so
      // a tier reads identically on the site and in WhatsApp.
      tiers: seasonRewards.map(r => ({
        tier: r.tier,
        free: r.free ? { ...r.free, label: rewardLabel(r.free) } : null,
        premium: r.premium ? { ...r.premium, label: rewardLabel(r.premium) } : null,
        reached: r.tier <= playerTier,
        claimed: claimed.has(r.tier),
      })),
      // describeSeasonEntry() is the single formatter the chat views and the
      // canvas renders already use, so it resolves name/emoji/artwork/rarity
      // for EVERY rewardType — pet, beast, relic, mega stone, legendary
      // Pokémon, title. Hand-rolling the lookups here is what previously left
      // pets and beasts (Emberpaw, Tide Slimeling) with a null image on the
      // site while they showed up fine in WhatsApp.
      //
      // Entries whose artwork host is down are dropped rather than shipped as
      // broken tiles — see hasLiveImage(). In practice that leaves characters,
      // pets, beasts, mega stones and legendaries; the weapon/relic/supply
      // shelves stay hidden until play.astral.qzz.io is back.
      shop: shopForWeb,
      // Same 7 shelves the `.season shop` pages use, so the site can group the
      // catalog identically instead of dumping every card in one grid. Ids are
      // narrowed to what `shop` actually shipped, and a shelf left with nothing
      // showable is dropped entirely rather than rendering as an empty heading.
      shopPages: getSeasonShopPages(catalog)
        .map(page => ({
          category: page.category,
          label: page.label,
          emoji: page.emoji,
          ids: page.entries.map(e => e.id).filter(id => shownIds.has(id)),
        }))
        .filter(page => page.ids.length),
      currency: season.shop?.currency ?? 'seasonPoints',
      player: req.player
        ? {
            tier: playerTier,
            seasonLevel: req.player.seasonProgress?.seasonLevel ?? 0,
            points: req.player.seasonPoints ?? 0,
            premiumPass: !!req.player.seasonProgress?.premiumPass,
            claimedTiers: [...claimed],
            progressPercent: seasonProgressPercent(req.player, season),
            spins: req.player.seasonProgress?.spins ?? 0,
          }
        : null,
    })
  })

  app.get('/api/season/tier/:tier', (req, res) => {
    const season = getActiveSeason(db)
    if (!season) return res.status(404).json({ ok: false, error: 'No active season.' })
    const reward = getSeasonReward(season.id, req.params.tier)
    if (!reward) return res.status(404).json({ ok: false, error: 'Tier not found.' })
    res.json({ ok: true, tier: reward })
  })

  /* ── general store ───────────────────────────────────────────────────── */

  /**
   * The buyable catalog. Public — browsing the shop signed out is fine, it's
   * the same information `.shop` prints to anyone in a group chat. Only the
   * purchase below needs a session.
   */
  app.get('/api/shop', (req, res) => {
    const discount = req.player ? (getModValue(req.player, 'shop_discount') ?? 0) : 0
    res.json({
      ok: true,
      currency: 'solars',
      shelves: buildWebShop(),
      // Gem-only, not part of the item catalog — it increments
      // player.abilitySlots directly. Surfaced so the site can offer it the
      // same way `.shop` does rather than pretending it doesn't exist.
      abilitySlot: { gemPrice: ABILITY_SLOT_GEM_PRICE },
      you: req.player
        ? {
            solars: req.player.wallet?.solars ?? 0,
            gems: req.player.wallet?.gems ?? 0,
            level: req.player.level ?? 1,
            inventory: (req.player.inventory ?? []).length,
            inventoryCap: getInventoryCap(req.player),
            // A percentage off list price from the Merchant's Favor cheat mod.
            // Shipped so the site shows the price the player will actually pay.
            discount,
            inBattle: !!req.player.inBattle,
          }
        : null,
    })
  })

  /**
   * Buy `qty` of one item.
   *
   * Same rules, in the same order, as plugins/shop.js's handleBuy() — that is
   * the point of routing both through lib/shop-catalog.js. Everything that
   * touches the player happens inside ONE updatePlayer() mutator, and the
   * response is sent only after that write resolves; see the long comment at
   * plugins/shop.js's handleBuy for why replying early is unsafe.
   */
  app.post('/api/shop/buy', requirePlayer, wrap(async (req, res) => {
    const rawId = String(req.body?.id ?? '').trim()
    if (!rawId) return res.status(400).json({ ok: false, error: 'Which item?' })

    const qty = Math.max(1, Math.min(99, Math.floor(Number(req.body?.qty ?? 1)) || 1))

    // Exact id only. The chat command accepts a fuzzy name because a human is
    // typing it; the site sends an id it got from GET /api/shop, so a partial
    // match here could only ever be a bug silently buying the wrong item.
    const entry = findInCatalog(rawId)
    if (!entry || entry.id !== rawId) {
      return res.status(404).json({ ok: false, error: 'That item is not in the shop.' })
    }

    if (entry.buyPrice == null) {
      return res.status(400).json({
        ok: false,
        error: `${entry.name} isn't sold in the shop — gather it with ${config.prefix}mine instead.`,
      })
    }

    if (req.player.inBattle && entry.type !== 'consumable') {
      return res.status(409).json({
        ok: false,
        error: "You're mid-battle — only potions can be bought right now.",
      })
    }

    const discount = getModValue(req.player, 'shop_discount') ?? 0
    const totalCost = Math.max(0, Math.round(entry.buyPrice * qty * (1 - discount)))
    let outcome = null

    const updated = await updatePlayer(db, req.jid, player => {
      if ((player.level ?? 1) < (entry.levelReq ?? 1)) {
        outcome = { ok: false, status: 403, error: `${entry.name} requires level ${entry.levelReq}.` }
        return player
      }

      const solars = player.wallet?.solars ?? 0
      if (solars < totalCost) {
        outcome = {
          ok: false, status: 402,
          error: `Not enough Solars — ${entry.name} × ${qty} costs ${totalCost}, you have ${solars}.`,
        }
        return player
      }

      if (!hasInventoryRoom(player, qty)) {
        outcome = {
          ok: false, status: 409,
          error: `Inventory full (${player.inventory?.length ?? 0}/${getInventoryCap(player)}). Sell or discard items to make room.`,
        }
        return player
      }

      player.wallet.solars -= totalCost
      for (let i = 0; i < qty; i++) player.inventory.push(entry.id)

      outcome = { ok: true, remaining: player.wallet.solars }
      return player
    })

    if (!outcome?.ok) {
      return res.status(outcome?.status ?? 400).json({ ok: false, error: outcome?.error ?? 'Purchase failed.' })
    }

    res.json({
      ok: true,
      bought: { ...shopRow(entry), qty },
      paid: totalCost,
      balance: outcome.remaining,
      // Returned so the site repaints the wallet and the inventory grid
      // without a second round trip.
      player: serializeSelf(db, updated),
    })
  }))

  /* ── cards ───────────────────────────────────────────────────────────── */

  /**
   * What a guaranteed-tier card costs. Public.
   *
   * Every tier in BUYABLE_CARD_TIERS is listed, cheapest first, including 5 and
   * S at the top of the ladder. `poolSize` is null when the upstream vault has
   * never answered, so the site omits it rather than showing a wrong count.
   */
  app.get('/api/cards/prices', wrap(async (req, res) => {
    // null when the upstream has never answered — the site just omits the
    // pool size rather than showing a wrong one.
    const counts = await getCardTierCounts().catch(() => null)

    res.json({
      ok: true,
      currency: 'solars',
      tiers: BUYABLE_CARD_TIERS.map(tier => ({
        tier,
        price: cardBuyPrice(tier),
        stars: tierStars(tier),
        poolSize: counts?.[tier] ?? counts?.[Number(tier)] ?? null,
      })),
      you: req.player ? { solars: req.player.wallet?.solars ?? 0 } : null,
    })
  }))

  /**
   * Buy one random card of a guaranteed tier.
   *
   * Order matters: the card is fetched from the Cards API BEFORE anything is
   * debited, so an upstream outage costs the player nothing. The balance check
   * then runs again inside the mutator, because the fetch takes a second or two
   * and the player may have spent their Solars elsewhere in the meantime.
   */
  app.post('/api/cards/buy-tier', requirePlayer, wrap(async (req, res) => {
    const tier = String(req.body?.tier ?? '').trim()
    if (!BUYABLE_CARD_TIERS.includes(tier)) {
      return res.status(400).json({
        ok: false,
        error: `Tier ${tier || '?'} isn't for sale. Buyable: ${BUYABLE_CARD_TIERS.join(', ')}.`,
      })
    }

    const price = cardBuyPrice(tier)
    if ((req.player.wallet?.solars ?? 0) < price) {
      return res.status(402).json({
        ok: false,
        error: `Not enough Solars — a tier ${tier} card costs ${price}.`,
      })
    }

    // card-engine returns null on upstream failure rather than throwing.
    const card = await fetchCardOfTier(tier)
    if (!card) {
      return res.status(503).json({
        ok: false,
        error: "The card vault isn't responding right now. Nothing was charged — try again shortly.",
      })
    }

    let outcome = null
    const updated = await updatePlayer(db, req.jid, player => {
      const solars = player.wallet?.solars ?? 0
      if (solars < price) {
        outcome = { ok: false, status: 402, error: `Not enough Solars — a tier ${tier} card costs ${price}.` }
        return player
      }
      player.wallet.solars -= price
      addCardToPlayer(player, card)
      outcome = { ok: true, remaining: player.wallet.solars, card: player.cards[player.cards.length - 1] }
      return player
    })

    if (!outcome?.ok) {
      return res.status(outcome?.status ?? 400).json({ ok: false, error: outcome?.error ?? 'Purchase failed.' })
    }

    // Same bell every other reward lands in, so a card bought on the site is
    // visible from the bot too.
    await pushNotification(db, req.jid, {
      kind: 'reward',
      title: `Card pulled: ${outcome.card.title}`,
      body: `Tier ${tier} ${tierStars(tier)} · ${outcome.card.series} — cost ${price} Solars.`,
      meta: { cardId: outcome.card.id, tier },
    }).catch(() => {})

    res.json({
      ok: true,
      card: { ...outcome.card, stars: tierStars(tier) },
      price,
      balance: outcome.remaining,
      player: serializeSelf(db, updated),
    })
  }))

  /**
   * Browse the card catalog.
   *
   * This proxies cards-api-seven.vercel.app rather than letting the browser
   * call it directly, which was the original plan. That upstream sends no
   * Access-Control-Allow-Origin header on either the GET or the preflight
   * (verified against the live host), so a direct fetch from the site is
   * fetched and then discarded by the browser — the response never reaches JS.
   *
   * Public and read-only: no session is required to look at cards, and nothing
   * here can mutate a player. `fetchCardCatalogPage` already normalises
   * imageUrl/series and swallows upstream failure into an empty page, so a
   * dead vault renders as "no cards" instead of a 500.
   */
  app.get('/api/cards/catalog', wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    // Capped so this can't be turned into a bulk-scrape of 22k rows through
    // our own host, which would also blow the upstream's rate limit.
    const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 24))
    const tier = req.query.tier ? String(req.query.tier) : undefined

    const { cards, total } = await fetchCardCatalogPage({ page, limit, tier })

    res.json({
      ok: true,
      page,
      limit,
      total,
      // The upstream reports totalPages for the *unfiltered* set, so derive it
      // from the count we actually paged over.
      hasMore: cards.length === limit,
      cards: cards.map(c => ({ ...c, stars: tierStars(c.tier) })),
    })
  }))

  /* ── premium ─────────────────────────────────────────────────────────── */

  app.get('/api/premium', (req, res) => {
    const plans = Object.entries(premiumPlans.plans ?? {}).map(([id, plan]) => ({
      id,
      label: plan.label,
      priceNaira: plan.priceNaira,
      durationDays: plan.durationDays,
      // Cost per day makes "which plan is actually better value" obvious
      // without the site hardcoding a discount percentage that drifts the
      // moment data/premium-plans.json changes.
      perDayNaira: Math.round(plan.priceNaira / plan.durationDays),
      command: `${config.prefix}premium buy ${id}`,
    }))

    res.json({
      ok: true,
      plans,
      gemPackages: (topupPackages.gemPackages ?? []).map(pkg => ({
        ...pkg,
        perGemNaira: Math.round(pkg.priceNaira / pkg.gems),
        command: `${config.prefix}topup buy ${pkg.id}`,
      })),
      botNumber: config.botPublicNumber ?? null,
      // Naira per dollar, for the site's price labels only. Every `command`
      // above still buys in naira and the prices here are naira, so this is a
      // second way to read the same charge, not a second way to pay. Null when
      // the owner hasn't set a rate, which the site reads as "naira only"
      // rather than rendering a dollar figure it had to invent.
      nairaPerUsd: config.nairaPerUsd > 0 ? config.nairaPerUsd : null,
      // Bank details are deliberately NOT in this payload. This endpoint is
      // public and unauthenticated, so anything returned here is effectively
      // published — `curl /api/premium` was handing the account number to
      // anyone who asked, with no need to even load the site. The account
      // number now goes out over exactly one channel: the bot's own DM reply
      // to `.premium buy` / `.topup buy` (plugins/premium.js, plugins/topup.js),
      // where the recipient is a real WhatsApp number the bot chose to answer.
      you: req.player
        ? {
            active: isPremiumActive(req.player),
            plan: req.player.premium?.plan ?? null,
            expiresAt: req.player.premium?.expiresAt ?? null,
            pending: req.player.premiumPending ?? null,
          }
        : null,
    })
  })

  /* ── errors ──────────────────────────────────────────────────────────── */

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }))

  app.use((err, _req, res, _next) => {
    if (/is not allowed/.test(err?.message ?? '')) {
      return res.status(403).json({ ok: false, error: 'Origin not allowed.' })
    }
    log('⚠️ Unhandled error:', err?.stack ?? err?.message ?? err)
    return res.status(500).json({ ok: false, error: 'Something went wrong on our side.' })
  })

  return app
}

/* ──────────────────────────────── boot ───────────────────────────────── */

/**
 * Starts the API server. Called from main.js AFTER the bot instances have
 * connected, so OTP delivery has a live socket from the first request.
 *
 * Returns the http.Server, or null if it deliberately declined to start.
 * A missing JWT_SECRET is a refusal, not a crash: the bot itself must keep
 * running even if the website half is misconfigured.
 */
export function startApiServer(db, instances) {
  if (!config.jwtSecret) {
    log('⛔ JWT_SECRET is not set — API server NOT started.')
    log('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"')
    log('   then put it in .env as JWT_SECRET and restart.')
    return null
  }
  if (config.jwtSecret.length < 32) {
    log('⛔ JWT_SECRET is too short (<32 chars) — API server NOT started.')
    return null
  }
  if (config.devMode) {
    log('⚠️ DEV_MODE is ON — /api/auth/request-otp echoes the code in its response.')
    log('   This MUST be off in production or anyone can sign in as anyone.')
  }

  initOtpStore(config.jwtSecret)

  const app = buildApp(db, instances)
  // 0.0.0.0, not localhost: Railway routes to the container from outside, and
  // a server bound to the loopback interface is invisible to it.
  const server = app.listen(config.apiPort, '0.0.0.0', () => {
    log(`listening on 0.0.0.0:${config.apiPort} → ${config.publicApiUrl}`)
    log(`allowed origins: ${config.allowedOrigins.join(', ') || '(none)'}`)
    if (config.allowVercelPreviews && VERCEL_PROJECTS.length) {
      log(`vercel previews allowed for project(s): ${VERCEL_PROJECTS.join(', ')}`)
    }
  })

  server.on('error', err => {
    log(`⚠️ failed to bind :${config.apiPort} — ${err?.code ?? err?.message ?? err}`)
    if (err?.code === 'EADDRINUSE') {
      log('   Another process already owns that port. The bot keeps running without the website API.')
    }
  })

  return server
}

export default startApiServer
