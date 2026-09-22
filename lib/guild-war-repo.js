/**
 * guild-war-repo.js — the REAL Guild War: one war = a series of paired 1v1
 * duels between champions picked by the two guild LEADERS, fought by the
 * players themselves through the ordinary `.pvp` engine.
 *
 * WHY THIS SHAPE (replacing the old createWarSession() skirmish):
 * the previous implementation assembled two AI-ish teams at accept time —
 * "highest active teammates" plus literal shadow clones when a guild was a
 * player short — and resolved combat on `.guild war attack`. The war was
 * between proxies, not people. This module throws that out. A war is now:
 *
 *   1. The attacking guild LEADER declares: rival guild, size (1v1…4v4),
 *      format, stakes mode (normal | wager), kit tier (1..5), and names the
 *      N champions who will represent the guild. Everyone in both guilds is
 *      tagged so the rest can rally in support.
 *   2. The DEFENDING guild's LEADER accepts and names their own N champions.
 *   3. Pairings lock 1:1 (A1 vs B1, A2 vs B2 …). EACH pairing is a normal,
 *      turn-based `.pvp` duel between two real registered players — same
 *      combat math, same abilities, same turn gate. The pairing decides WHO
 *      may fight; plugins/pvp.js detects it via findActiveWarMatchFor() and,
 *      on conclusion, hands the result straight back here.
 *   4. Every 1v1 win adds a point to its guild. Highest total after the
 *      pairings are played wins the war.
 *   5. The PRIZE POOL IS STAMPED BY THE BOT at declaration — 500,000 for a
 *      1v1/2v2, 1,000,000 for a 3v3/4v4. Players never fund it, can never
 *      be asked to, and it is split on performance at the end (MVP takes the
 *      single biggest cut).
 *   6. Winners gain massive XP, DOMINANCE SCORE (player ladder with its own
 *      tiers), and the guild gains WAR TIER standing — a completely separate
 *      ladder from the donation treasury, so combat reputation can never be
 *      bought.
 *
 * LOADOUT "PRESET 5": each pairing isolates both fighters behind
 * lib/war-kit.js — their real inventory/equipped move to `player.warStash`,
 * the war preset (their `.loadout save war` + the bot's tier kit) fills them,
 * and the moment the duel ends the preset vanishes and their belongings come
 * back. See war-kit.js for why the isolation is a snapshot+reversal rather
 * than a whole-record restore.
 *
 * WAGER WARS: `stakes: 'wager'` makes every pairing ALSO carry a personal
 * solar stake (war.stakeSolars) escrowed by the normal wager machinery at
 * accept — the winner takes the pot on top of the war point. The war branch
 * in plugins/pvp.js's pvpConclude() sits BEFORE the plain-wager branch so a
 * wagered war pairing settles exactly once, stake and war bookkeeping
 * together.
 *
 * STATE LIVES IN db.data.guildWars (keyed by warId) — same persistence model
 * as lib/tourney-repo.js: a war can run across restarts and hours of real
 * duels, so it cannot live in module memory.
 *
 * v2 records only. Legacy (pre-rework) wars carry no `v` field and no
 * pairings; ensureWarState() retires them on read so an old pending
 * challenge can never be "accepted" into a broken session.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from './player-repo.js'
import { pushNotificationToMany } from './notification-repo.js'
import { ensurePvp, ratingOf, ratingDelta, recordWin, recordLoss } from './pvp-engine.js'
import { applyLevelUps } from './combat-engine.js'
import { levelsData, classes, races, getTotalStats } from './game-data.js'
import { getGuildDef, getGuildRecord } from './guild-repo.js'
import { WAR_FORMATS } from './guild-war-engine.js'
import {
  applyWarKit, removeWarKit, hasWarKit, normalizeKitTier, warKitLabel, WAR_KIT_TIERS,
} from './war-kit.js'
import { clearWagerState, payWagerPot, isWagerState } from './pvp-wager.js'

/* ─────────────────────────── constants ─────────────────────────── */

/** How many champions each side fields. 4v4 is the ceiling. */
export const MATCH_TYPES = { '1v1': 1, '2v2': 2, '3v3': 3, '4v4': 4 }
export const MATCH_TYPE_IDS = ['1v1', '2v2', '3v3', '4v4']

/** Record version. Anything older is retired on read (ensureWarState). */
export const WAR_RECORD_VERSION = 2

/** Prize pools the BOT stamps. Players contribute nothing, ever. */
export const PRIZE_POOL_SMALL = 500_000
export const PRIZE_POOL_LARGE = 1_000_000

/** Allowed personal stakes for a wager war (0 = normal war). */
export const WAR_STAKE_OPTIONS = [0, 50_000, 100_000, 250_000]

/** How long a pairing waits for its duel to be started before it is claimable. */
export const WAR_MATCH_CLAIM_MS = 15 * 60 * 1000
/** …before the pairing voids itself on sweep so a war can never wedge. */
export const WAR_MATCH_VOID_MS = 60 * 60 * 1000
/** A whole war left untouched this long concludes on read (by score, or draw). */
export const WAR_STALE_MS = 24 * 60 * 60 * 1000
/** Challenge must be answered within this window. */
export const WAR_ACCEPT_WINDOW_MS = 24 * 60 * 60 * 1000
/** Auto-created pairing challenges live this long (players get more slack
 *  than the 2-minute `.pvp @them` window — a war pairing is announced). */
export const WAR_PAIRING_CHALLENGE_MS = 15 * 60 * 1000

/* ─────────────────────────── XP & dominance ─────────────────────────── */

/** Per-pairing XP — a war duel is worth several ordinary duels. */
export const WAR_MATCH_WIN_XP = 400
export const WAR_MATCH_LOSS_XP = 120
/** "Massive XP for winning their guild war" — paid at the war's conclusion. */
export const WAR_VICTORY_XP = 3000
export const WAR_VICTORY_XP_PER_SLOT = 750
export const WAR_DEFEAT_XP = 600
export const WAR_MVP_XP = 1500
export const WAR_SUPPORT_WIN_XP = 800
export const WAR_SUPPORT_LOSS_XP = 300

/** Player dominance tiers. Money cannot touch this — war results only. */
export const DOMINANCE_TIERS = [
  { id: 'recruit',   name: 'Recruit',   emoji: '🔰', min: 0 },
  { id: 'soldier',   name: 'Soldier',   emoji: '🪖', min: 250 },
  { id: 'champion',  name: 'Champion',  emoji: '⚔️', min: 750 },
  { id: 'warlord',   name: 'Warlord',   emoji: '👑', min: 2_000 },
  { id: 'legend',    name: 'Legend',    emoji: '🌟', min: 5_000 },
  { id: 'dominant',  name: 'DOMINANT',  emoji: '💀', min: 12_000 },
]

/** Guild WAR tiers — a combat ladder, deliberately NOT the treasury ladder. */
export const GUILD_WAR_TIERS = [
  { id: 'unrated',   name: 'Unrated',            emoji: '🏳️', min: 0 },
  { id: 'bronze',    name: 'Bronze Banner',      emoji: '🥉', min: 500 },
  { id: 'silver',    name: 'War-Blooded',        emoji: '🥈', min: 1_500 },
  { id: 'gold',      name: 'Seasoned Legions',   emoji: '🥇', min: 4_000 },
  { id: 'crystal',   name: 'Dominators',         emoji: '💎', min: 10_000 },
  { id: 'astral',    name: 'Astral Sovereigns',  emoji: '🌌', min: 25_000 },
]

/** The tier a dominance score sits in. Never null. */
export function dominanceTierFor(score) {
  let t = DOMINANCE_TIERS[0]
  for (const d of DOMINANCE_TIERS) if ((score ?? 0) >= d.min) t = d
  return t
}

/** The tier a guild's war dominance sits in. Never null. */
export function guildWarTierFor(dominance) {
  let t = GUILD_WAR_TIERS[0]
  for (const g of GUILD_WAR_TIERS) if ((dominance ?? 0) >= g.min) t = g
  return t
}

/** Backfill player.dominance — shape only, no invented history. */
export function ensureDominance(player) {
  const d = player.dominance ?? (player.dominance = {})
  if (typeof d.score !== 'number') d.score = 0
  if (typeof d.wars !== 'number') d.wars = 0
  if (typeof d.wins !== 'number') d.wins = 0
  if (typeof d.losses !== 'number') d.losses = 0
  if (typeof d.mvp !== 'number') d.mvp = 0
  if (typeof d.duelsWon !== 'number') d.duelsWon = 0
  if (typeof d.duelsLost !== 'number') d.duelsLost = 0
  if (typeof d.peak !== 'number') d.peak = d.score
  return d
}

/** Backfill a guild's war block on its progression record. */
export function ensureGuildWarStats(db, guildId) {
  const rec = getGuildRecord(db, guildId)
  const w = rec.war ?? (rec.war = {})
  if (typeof w.wins !== 'number') w.wins = 0
  if (typeof w.losses !== 'number') w.losses = 0
  if (typeof w.draws !== 'number') w.draws = 0
  if (typeof w.dominance !== 'number') w.dominance = 0
  if (typeof w.trophies !== 'number') w.trophies = 0
  if (typeof w.streak !== 'number') w.streak = 0
  if (typeof w.bestStreak !== 'number') w.bestStreak = 0
  if (typeof w.mvpAwards !== 'number') w.mvpAwards = 0
  if (typeof w.duelsWon !== 'number') w.duelsWon = 0
  if (typeof w.peakDominance !== 'number') w.peakDominance = w.dominance
  if (!Array.isArray(w.history)) w.history = []
  return { rec, war: w }
}

/* ─────────────────────────── record access ─────────────────────────── */

function ensureContainer(db) {
  if (!db.data.guildWars || typeof db.data.guildWars !== 'object') db.data.guildWars = {}
  return db.data.guildWars
}

/**
 * Retire legacy wars and shape the container. Safe to call on every read:
 * it writes only when something actually changed.
 */
export async function ensureWarState(db) {
  const all = ensureContainer(db)
  let changed = false
  for (const [id, w] of Object.entries(all)) {
    if (!w || typeof w !== 'object' || (w.v ?? 0) < WAR_RECORD_VERSION) {
      delete all[id]
      changed = true
      continue
    }
    if (!Array.isArray(w.matches)) { w.matches = []; changed = true }
    if (!w.score || typeof w.score.a !== 'number') { w.score = { a: 0, b: 0 }; changed = true }
    if (!w.stats || typeof w.stats !== 'object') { w.stats = {}; changed = true }
    if (typeof w.currentMatch !== 'number') { w.currentMatch = 0; changed = true }
  }
  if (changed) {
    try { await db.write() } catch { /* shape lives in RAM either way */ }
  }
  return all
}

/** One war by id, or null. */
export function getWar(db, warId) {
  return db.data.guildWars?.[warId] ?? null
}

/** Every war involving `guildId`, newest first. */
export function warsForGuild(db, guildId) {
  return Object.values(db.data.guildWars ?? {})
    .filter(w => w.guildAId === guildId || w.guildBId === guildId)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** The newest war in a given state for a guild, or null. */
export function findWarByStatus(db, guildId, statuses) {
  const want = Array.isArray(statuses) ? statuses : [statuses]
  return warsForGuild(db, guildId).find(w => want.includes(w.status)) ?? null
}

/** Any war anywhere in `pending`/`active` that involves either guild. */
export function findLiveWarBetween(db, guildAId, guildBId) {
  return Object.values(db.data.guildWars ?? {}).find(w =>
    (w.status === 'pending' || w.status === 'active')
    && ((w.guildAId === guildAId && w.guildBId === guildBId)
      || (w.guildAId === guildBId && w.guildBId === guildAId))) ?? null
}

/** True when either guild already has a pending or active war with anyone. */
export function guildBusy(db, guildId) {
  return warsForGuild(db, guildId).some(w => w.status === 'pending' || w.status === 'active')
}

/* ─────────────────────────── declaration ─────────────────────────── */

/**
 * The BOT stamps the prize pool. 1v1/2v2 fights for 500k, 3v3/4v4 for 1M —
 * never a figure a player typed, so a war can never be funded (or refused)
 * by wallet.
 */
export function generatePrizePool(matchType) {
  return MATCH_TYPES[matchType] >= 3 ? PRIZE_POOL_LARGE : PRIZE_POOL_SMALL
}

/**
 * createWarChallenge(db, opts) — the attacking leader's declaration.
 * Caller (plugins/guild.js) has already validated: both guilds, distinct,
 * no other live war, leader status, champion membership/count, format,
 * stakes and kit tier. Returns the war record.
 */
export async function createWarChallenge(db, opts) {
  await ensureWarState(db)
  const all = ensureContainer(db)

  const warId = `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const size = MATCH_TYPES[opts.matchType] ?? 1
  const now = Date.now()

  const war = {
    v: WAR_RECORD_VERSION,
    id: warId,
    status: 'pending',
    guildAId: opts.guildAId,
    guildBId: opts.guildBId,
    challengerId: opts.challengerId,
    matchType: opts.matchType,
    size,
    formatId: opts.formatId,
    stakes: opts.stakes === 'wager' ? 'wager' : 'normal',
    stakeSolars: opts.stakes === 'wager' ? Math.max(0, Math.floor(opts.stakeSolars ?? 0)) : 0,
    kitTier: normalizeKitTier(opts.kitTier),
    prizePool: generatePrizePool(opts.matchType),
    groupJid: opts.groupJid ?? null,
    // Named champions, in slot order — pairings are built from these.
    teamA: (opts.teamA ?? []).slice(0, size).map(p => ({ jid: p.id ?? p.jid, name: p.name, role: 'champion' })),
    teamB: [],
    supportsA: (opts.supportsA ?? []).slice(0, 60).map(p => ({ jid: p.id ?? p.jid, name: p.name, role: 'support' })),
    supportsB: [],
    matches: [],
    currentMatch: 0,
    score: { a: 0, b: 0 },
    stats: {},
    results: [],
    mvpJid: null,
    winnerGuildId: null,
    runnerUpGuildId: null,
    createdAt: now,
    updatedAt: now,
    acceptUntil: now + WAR_ACCEPT_WINDOW_MS,
    startedAt: null,
    finishedAt: null,
    lastActivityAt: now,
  }
  for (const c of war.teamA) war.stats[c.jid] = emptyStats()

  all[warId] = war
  await db.write()
  return war
}

function emptyStats() {
  return { perf: 0, dmgOut: 0, matches: 0, wins: 0, losses: 0, hpPctSum: 0, xp: 0, dominance: 0, solars: 0 }
}

/**
 * acceptWarChallenge(db, warId, teamB) — the defending leader's champions.
 * Builds the 1:1 pairings, flips the war to `active`, and is the point after
 * which the roster is locked. Returns { war } or { error }.
 */
export async function acceptWarChallenge(db, warId, teamB) {
  const war = getWar(db, warId)
  if (!war) return { error: 'gone' }
  if (war.status !== 'pending') return { error: 'not_pending' }

  const size = war.size
  const b = (teamB ?? []).slice(0, size).map(p => ({ jid: p.id ?? p.jid, name: p.name, role: 'champion' }))
  if (b.length !== size || war.teamA.length !== size) return { error: 'roster_mismatch' }

  war.teamB = b
  for (const c of b) war.stats[c.jid] = emptyStats()

  war.matches = war.teamA.map((a, i) => ({
    i,
    aJid: a.jid,
    bJid: b[i].jid,
    status: 'pending',
    winnerJid: null,
    loserJid: null,
    startedAt: null,
    finishedAt: null,
    liveAt: null,
    walkover: false,
    voided: false,
  }))
  war.status = 'active'
  war.startedAt = Date.now()
  war.lastActivityAt = Date.now()
  war.currentMatch = 0

  // The defender's supporters ride along too — they get tagged and paid.
  war.supportsB = (teamB.supports ?? []).slice(0, 60)

  await db.write()
  return { war }
}

/** Cancel/withdraw a pending war (either side: decline or withdraw). */
export async function cancelWar(db, warId, { stripKits = true } = {}) {
  const war = getWar(db, warId)
  if (!war || war.status === 'finished' || war.status === 'cancelled') return null
  war.status = 'cancelled'
  war.finishedAt = Date.now()

  if (stripKits) {
    for (const jid of allCombatants(war)) {
      if (!playerExists(db, jid)) continue
      await updatePlayer(db, jid, p => { removeWarKit(p); p.pvpChallenge = null })
    }
  }
  await db.write()
  return war
}

/** Every champion + supporter jid on both sides. */
export function allCombatants(war) {
  return [
    ...war.teamA.map(c => c.jid),
    ...war.teamB.map(c => c.jid),
    ...(war.supportsA ?? []).map(c => c.jid),
    ...(war.supportsB ?? []).map(c => c.jid),
  ]
}

/* ───────────────────── pairing lookup (the pvp hook) ───────────────────── */

/**
 * findActiveWarMatchFor(db, jidA, jidB) — what plugins/pvp.js's pvpConclude()
 * calls on EVERY duel conclusion: "was this actually the live pairing of an
 * active Guild War?" Returns { war, match, matchIdx } or null.
 *
 * Only the CURRENT unresolved pairing matches, so once a pairing is settled
 * those two players can duel normally (including a rematch) without
 * double-counting into the war.
 */
export function findActiveWarMatchFor(db, jidA, jidB) {
  if (!jidA || !jidB || jidA === jidB) return null
  for (const war of Object.values(db.data.guildWars ?? {})) {
    if (war.status !== 'active') continue
    const idx = war.currentMatch
    const match = war.matches?.[idx]
    if (!match || match.winnerJid || match.status === 'done') continue
    if ((match.aJid === jidA && match.bJid === jidB) || (match.aJid === jidB && match.bJid === jidA)) {
      return { war, match, matchIdx: idx }
    }
  }
  return null
}

/**
 * beginWarDuel(db, jidA, jidB) — called by plugins/pvp.js at the moment a
 * war pairing's duel is ACCEPTED (both battleStates exist). Stamps the
 * battleStates with warId, marks the pairing live, and isolates BOTH fighters
 * behind the war preset. Returns { war, match, matchIdx, kits } or null.
 */
export async function beginWarDuel(db, jidA, jidB) {
  const found = findActiveWarMatchFor(db, jidA, jidB)
  if (!found) return null
  const { war, match, matchIdx } = found

  const totemAllowed = (WAR_FORMATS[war.formatId] ?? WAR_FORMATS.standard).totemAllowed !== false

  match.status = 'live'
  match.liveAt = match.startedAt = Date.now()
  war.lastActivityAt = Date.now()
  war.currentMatch = matchIdx
  await db.write()

  const kits = {}
  for (const jid of [jidA, jidB]) {
    if (!playerExists(db, jid)) continue
    await updatePlayer(db, jid, p => {
      if (p.battleState) p.battleState.warId = war.id
      kits[jid] = applyWarKit(p, { tier: war.kitTier, totemAllowed, warId: war.id })
    })
  }
  return { war, match, matchIdx, kits }
}

/* ─────────────────────────── settlement ─────────────────────────── */

/** Performance for one fighter in one pairing: real damage out + the win. */
function perfFor({ won, dmgOut, hpLeftPct, level }) {
  return Math.round(
    Math.max(0, dmgOut ?? 0)
    + (won ? 600 : 0)
    + Math.round(Math.max(0, Math.min(1, hpLeftPct ?? 0)) * 40)
    + (level ?? 1),
  )
}

/**
 * pvpConcludeWar(db, winnerJid, loserJid, ctx, reasonLine, found) —
 * THE war pairing conclusion, called from plugins/pvp.js's pvpConclude()
 * ahead of every other branch (hypnosis, wager, tournament) so a war pairing
 * is recorded exactly once.
 *
 * Does, in order:
 *   1. snapshot both fighters for performance (damage out is the opponent's
 *      HP they removed — measurable at settle time with no combat hook),
 *   2. settle any wager stake escrowed at accept,
 *   3. strip the war preset from both and restore their real belongings,
 *   4. heal/clear/ladder/XP exactly like a tourney bracket match,
 *   5. record the pairing's point for the winner's guild,
 *   6. announce, then start the next pairing — or finish the war and pay the
 *      bot-stamped pool.
 *
 * Returns true when the war handled the conclusion (the caller must not send
 * its own victory text), false when there was nothing to do.
 */
export async function pvpConcludeWar(db, winnerJid, loserJid, ctx, reasonLine, found) {
  const { war, matchIdx } = found
  const match = war.matches?.[matchIdx]
  if (!match || match.winnerJid || war.status !== 'active') return false

  const winnerSnap = getPlayer(db, winnerJid)
  const loserSnap = getPlayer(db, loserJid)
  const wagerWar = war.stakes === 'wager' && war.stakeSolars > 0
  const stake = wagerWar
    ? (isWagerState(winnerSnap?.battleState) || isWagerState(loserSnap?.battleState)
        ? (winnerSnap?.battleState?.wagerAmount ?? loserSnap?.battleState?.wagerAmount ?? war.stakeSolars)
        : 0)
    : 0

  // Performance must be read BEFORE anything heals or strips.
  const winnerPerf = perfFor({
    won: true,
    dmgOut: (loserSnap?.maxHp ?? 100) - (loserSnap?.hp ?? 0),
    hpLeftPct: (winnerSnap?.hp ?? 0) / Math.max(1, winnerSnap?.maxHp ?? 1),
    level: winnerSnap?.level ?? 1,
  })
  const loserPerf = perfFor({
    won: false,
    dmgOut: (winnerSnap?.maxHp ?? 100) - (winnerSnap?.hp ?? 0),
    hpLeftPct: (loserSnap?.hp ?? 0) / Math.max(1, loserSnap?.maxHp ?? 1),
    level: loserSnap?.level ?? 1,
  })

  ensurePvp(winnerSnap ?? {})
  ensurePvp(loserSnap ?? {})
  const delta = ratingDelta(ratingOf(winnerSnap), ratingOf(loserSnap))

  const slotXpWin = slotXp(war)
  const slotXpLoss = WAR_MATCH_LOSS_XP

  let winnerName = winnerSnap?.name ?? 'Champion'
  let loserName = loserSnap?.name ?? 'Champion'
  let winnerXp = 0
  let loserXp = 0
  let wagerLine = ''

  // ── Loser: preset out, real belongings back, ladder loss, consolation XP ──
  await updatePlayer(db, loserJid, p => {
    loserName = p.name
    removeWarKit(p)
    if (stake > 0) clearWagerState(p)
    else {
      p.hp = p.maxHp
      p.mp = p.maxMp
      p.inBattle = false
      p.battleState = null
      p.activeEffects = []
    }
    recordLoss(p, winnerSnap?.name ?? null, delta, stake)
    p.pvp.lastOpponentJid = winnerJid
    const d = ensureDominance(p)
    d.duelsLost += 1
    d.score += 12
    d.peak = Math.max(d.peak, d.score)
    loserXp = slotXpLoss
    p.xp = (p.xp ?? 0) + loserXp
    applyLevelUps(p, levelsData, classes, races, getTotalStats)
  })

  // ── Winner: preset out, belongings back, ladder win, war XP ──
  await updatePlayer(db, winnerJid, p => {
    winnerName = p.name
    removeWarKit(p)
    if (stake > 0) {
      // Pot settlement: their own escrow is already out of the wallet, so
      // payWagerPot credits back both halves in one move.
      payWagerPot(p, stake)
      clearWagerState(p)
      wagerLine = `💰 *${p.name}* sweeps the ☀️ ${(stake * 2).toLocaleString()} solar pot on top of the war point!`
    } else {
      p.hp = p.maxHp
      p.mp = p.maxMp
      p.inBattle = false
      p.battleState = null
      p.activeEffects = []
    }
    recordWin(p, loserSnap?.name ?? null, delta, stake)
    p.pvp.lastOpponentJid = loserJid
    const d = ensureDominance(p)
    d.duelsWon += 1
    d.score += 60
    d.peak = Math.max(d.peak, d.score)
    winnerXp = slotXpWin
    p.xp = (p.xp ?? 0) + winnerXp
    applyLevelUps(p, levelsData, classes, races, getTotalStats)
  })

  // ── Record the pairing ──────────────────────────────────────────────
  const winnerIsA = match.aJid === winnerJid
  war.score[winnerIsA ? 'a' : 'b'] += 1
  war.matches[matchIdx] = {
    ...match,
    status: 'done',
    winnerJid,
    loserJid,
    finishedAt: Date.now(),
    perfWinner: winnerPerf,
    perfLoser: loserPerf,
  }
  war.results.push({
    i: matchIdx,
    winnerJid,
    loserJid,
    winnerName,
    loserName,
    guildId: winnerIsA ? war.guildAId : war.guildBId,
    perf: winnerPerf,
    at: Date.now(),
  })
  war.lastActivityAt = Date.now()

  const wStats = (war.stats[winnerJid] ??= emptyStats())
  const lStats = (war.stats[loserJid] ??= emptyStats())
  wStats.perf += winnerPerf
  wStats.dmgOut += Math.max(0, (loserSnap?.maxHp ?? 0) - (loserSnap?.hp ?? 0))
  wStats.matches += 1; wStats.wins += 1; wStats.xp += winnerXp
  lStats.perf += loserPerf
  lStats.dmgOut += Math.max(0, (winnerSnap?.maxHp ?? 0) - (winnerSnap?.hp ?? 0))
  lStats.matches += 1; lStats.losses += 1; lStats.xp += loserXp
  if (stake > 0) { wStats.solars += stake; lStats.solars -= stake }

  noteWar(war, `⚔️ ${winnerName} def. ${loserName} (${war.score.a}—${war.score.b})`)
  await db.write()

  // ── Announce first, THEN open the next pairing ───────────────────────
  const finished = warScoreComplete(war)
  const tail = wagerLine || `❤️‍🩹 Both champions are healed. Preset 5 lifted — your own gear is back.`

  if (finished) {
    const fin = await finishWar(db, war, reasonLine, ctx)
    await ctx.reply([
      `⚔️ *${winnerName.toUpperCase()} WINS THE PAIRING!* ⚔️`,
      ``,
      reasonLine,
      ``,
      scoreBoard(war),
      ``,
      tail,
      ``,
      fin.banner,
    ].filter(x => x !== null && x !== undefined).join('\n'))
    if (fin.rankUpLines?.length) await ctx.reply(fin.rankUpLines.join('\n\n'))
    return true
  }

  await ctx.reply([
    `⚔️ *${winnerName.toUpperCase()} TAKES THE PAIRING!* ⚔️`,
    ``,
    reasonLine,
    ``,
    scoreBoard(war),
    ``,
    tail,
  ].join('\n'))

  await startNextPairing(db, war, ctx)
  return true
}

/** True once every pairing has a winner. */
export function warScoreComplete(war) {
  if (!Array.isArray(war.matches) || war.matches.length === 0) return true
  return war.matches.every(m => m && m.winnerJid)
}

/** "⚔️ Vanguard: 2 — 1 Emberwake ⚔️ · pairing 3 of 4" — one line pair. */
export function scoreBoard(war) {
  const a = getGuildDef(war.guildAId)
  const b = getGuildDef(war.guildBId)
  const total = war.matches?.length ?? war.size
  return (
    `${a?.emoji} *${a?.name}:* ${war.score.a}  —  ${war.score.b} *${b?.name}* ${b?.emoji}\n` +
    `_Pairing ${Math.min((war.currentMatch ?? 0) + 1, total)} of ${total}_`
  )
}

/* ─────────────────────────── progression ─────────────────────────── */

/**
 * startNextPairing(db, war, ctx) — issue the announced `.pvp` challenge for
 * the next slot so the two champions can simply `.pvp accept`.
 *
 * The challenge carries `warId` so plugins/pvp.js can waive the group's
 * PvP-off gate for it (a declared war must never be blocked by a toggle) and,
 * on a wager war, carries the escrowed stake amount.
 *
 * Pairings do NOT depend on this challenge existing: findActiveWarMatchFor()
 * keys off the war record, so the two can also just `.pvp @each other` and
 * everything resolves the same.
 */
export async function startNextPairing(db, war, ctx) {
  while (war.currentMatch < war.matches.length && war.matches[war.currentMatch]?.winnerJid) {
    war.currentMatch += 1
  }
  if (war.currentMatch >= war.matches.length) return null

  const match = war.matches[war.currentMatch]
  const aExists = playerExists(db, match.aJid)
  const bExists = playerExists(db, match.bJid)

  // A champion who no longer exists forfeits their pairing outright.
  if (!aExists || !bExists) {
    const winnerJid = aExists ? match.aJid : match.bJid
    return settleWalkover(db, war, match.i, winnerJid, ctx,
      `_Their opponent is gone from the roster — walkover awarded._`)
  }

  const aPlayer = getPlayer(db, match.aJid)
  const bPlayer = getPlayer(db, match.bJid)

  // Hand the defending champion a ready-to-accept challenge. Never clobber a
  // personal duel challenge they are already holding — if one is live they
  // can still open THIS pairing themselves with `.pvp @<opponent>`, which the
  // war record pairs up either way.
  const held = getPlayer(db, match.bJid)?.pvpChallenge
  const heldLive = held && (held.expiresAt ?? 0) > Date.now() && !held.warId
  if (!heldLive) {
    await updatePlayer(db, match.bJid, p => {
      p.pvpChallenge = {
        fromJid: match.aJid,
        expiresAt: Date.now() + WAR_PAIRING_CHALLENGE_MS,
        wagerAmount: war.stakes === 'wager' ? war.stakeSolars : 0,
        warId: war.id,
      }
    })
  }

  const stakeNote = war.stakes === 'wager'
    ? `💰 Wager war — each champion stakes *☀️ ${war.stakeSolars.toLocaleString()}* on top.`
    : `☀️ Prize pool: *${war.prizePool.toLocaleString()} solars* — stamped by the bot, nobody paid a coin.`

  const body = [
    `🔔 *PAIRING ${match.i + 1} — CALL THEM OUT!* 🔔`,
    ``,
    `⚔️ *${aPlayer.name}*  VS  *${bPlayer.name}*`,
    ``,
    `📏 War: *${war.matchType}*  ·  📜 ${formatName(war.formatId)}  ·  ${warKitLabel(war.kitTier)}`,
    `The preset loads the moment you accept — your real inventory is set aside, and comes straight back after.`,
    stakeNote,
    ``,
    `*${bPlayer.name}* — answer with *${config.prefix}pvp accept*, or swing first with *${config.prefix}pvp @${aPlayer.name}*.`,
    `_The pairings decide who may fight; any other duel you take does not count for the war._`,
  ].join('\n')

  await ctx.reply(body)
  await tagPeople(ctx, [match.aJid, match.bJid]).catch(() => {})
  await pushNotificationToMany(db, [match.aJid, match.bJid], {
    kind: 'battle',
    title: `⚔️ Your Guild War pairing is up!`,
    body: `Pairing ${match.i + 1}/${war.matches.length}: ${aPlayer.name} vs ${bPlayer.name}. ${config.prefix}pvp accept to fight for ${getGuildDef(winnerSideGuild(war))?.name ?? 'your guild'}.`,
  }).catch(() => {})

  return match
}

function winnerSideGuild(war) {
  return war.guildBId
}

export function formatName(formatId) {
  const f = WAR_FORMATS[formatId] ?? WAR_FORMATS.standard
  return `${f.emoji} ${f.name}`
}

/**
 * settleWalkover(db, war, matchIdx, winnerJid, ctx, reasonLine) — award a
 * pairing without a duel (claim, forfeit, opponent gone). Strips any kit the
 * absent fighter may still be wearing, scores it, then advances or finishes
 * exactly like a fought result.
 */
export async function settleWalkover(db, war, matchIdx, winnerJid, ctx, reasonLine) {
  const match = war.matches?.[matchIdx]
  if (!match || match.winnerJid || war.status !== 'active') return false

  const loserJid = match.aJid === winnerJid ? match.bJid : match.aJid
  const winnerName = playerExists(db, winnerJid) ? getPlayer(db, winnerJid).name : 'Champion'
  const loserName = playerExists(db, loserJid) ? getPlayer(db, loserJid).name : 'Champion'

  // Both fighters go back to normal, kit or no kit.
  for (const jid of [winnerJid, loserJid]) {
    if (!playerExists(db, jid)) continue
    await updatePlayer(db, jid, p => {
      removeWarKit(p)
      p.inBattle = false
      p.battleState = null
      p.activeEffects = []
      p.pvpChallenge = null
      p.hp = p.maxHp
      p.mp = p.maxMp
      const d = ensureDominance(p)
      if (jid === winnerJid) {
        d.duelsWon += 1; d.score += 45; d.peak = Math.max(d.peak, d.score)
        p.xp = (p.xp ?? 0) + slotXp(war)
      } else {
        d.duelsLost += 1; d.score += 8; d.peak = Math.max(d.peak, d.score)
        p.xp = (p.xp ?? 0) + WAR_MATCH_LOSS_XP
      }
      applyLevelUps(p, levelsData, classes, races, getTotalStats)
    })
  }

  const winnerIsA = match.aJid === winnerJid
  war.score[winnerIsA ? 'a' : 'b'] += 1
  war.matches[matchIdx] = { ...match, status: 'done', winnerJid, loserJid, walkover: true, finishedAt: Date.now() }
  war.results.push({
    i: matchIdx, winnerJid, loserJid, winnerName, loserName,
    guildId: winnerIsA ? war.guildAId : war.guildBId, perf: 0, walkover: true, at: Date.now(),
  })
  const wStats = (war.stats[winnerJid] ??= emptyStats())
  wStats.matches += 1; wStats.wins += 1; wStats.xp += slotXp(war)
  const lStats = (war.stats[loserJid] ??= emptyStats())
  lStats.matches += 1; lStats.losses += 1; lStats.xp += WAR_MATCH_LOSS_XP
  war.lastActivityAt = Date.now()
  noteWar(war, `🚶 ${winnerName} took pairing ${match.i + 1} by walkover`)
  await db.write()

  const head = `🚶 *WALKOVER — ${winnerName.toUpperCase()} TAKES IT!* 🚶\n\n${reasonLine}\n\n${scoreBoard(war)}`

  if (warScoreComplete(war)) {
    const fin = await finishWar(db, war, reasonLine, ctx)
    if (ctx?.reply) await ctx.reply(`${head}\n\n${fin.banner}`)
    if (ctx?.reply && fin.rankUpLines?.length) await ctx.reply(fin.rankUpLines.join('\n\n'))
    return true
  }

  if (ctx?.reply) await ctx.reply(head)
  await startNextPairing(db, war, ctx)
  return true
}

function slotXp(war) {
  return WAR_MATCH_WIN_XP + 100 * (war.size ?? 1)
}

/* ─────────────────────────── finishing & payout ─────────────────────────── */

/**
 * finishWar(db, war, reasonLine, ctx) — close the war and pay out.
 *
 * SPLIT of the bot-stamped pool (percentages, floored):
 *   20%  MVP — the single highest performance across BOTH guilds
 *   45%  winning champions, weighted by performance
 *   10%  winning guild's supporters (rallied in chat)
 *   20%  losing champions, weighted by performance
 *    5%  winning guild treasury (small — the treasury ladder stays a
 *        donation ladder, war spoils are seasoning, not a shortcut)
 *
 * Draw (equal scores): 90% of the pool splits evenly across ALL champions,
 * 5% to each treasury, no MVP bonus.
 *
 * Returns { banner, rankUpLines, payouts, mvpJid, winnerGuildId }.
 */
export async function finishWar(db, war, reasonLine, ctx) {
  const rankUpLines = []
  if (war.status === 'finished') {
    return { banner: `📜 This war has already concluded.`, rankUpLines, payouts: new Map(), mvpJid: war.mvpJid, winnerGuildId: war.winnerGuildId }
  }

  war.status = 'finished'
  war.finishedAt = Date.now()
  war.lastActivityAt = Date.now()

  const pool = Math.max(0, Math.floor(war.prizePool ?? 0))
  const draw = war.score.a === war.score.b
  const winnerIsA = war.score.a > war.score.b
  const winnerGuildId = draw ? null : (winnerIsA ? war.guildAId : war.guildBId)
  war.winnerGuildId = winnerGuildId
  war.runnerUpGuildId = draw ? null : (winnerIsA ? war.guildBId : war.guildAId)

  // EVERY champion, both guilds — always paid XP, win lose or draw.
  const allChamps = [
    ...war.teamA.map(c => ({ ...c, guildId: war.guildAId })),
    ...war.teamB.map(c => ({ ...c, guildId: war.guildBId })),
  ]

  // MVP: highest cumulative performance among champions (either guild).
  let mvp = null
  for (const c of allChamps) {
    const perf = war.stats[c.jid]?.perf ?? 0
    if (!mvp || perf > mvp.perf) mvp = { ...c, perf }
  }
  war.mvpJid = mvp?.jid ?? null

  const payouts = new Map()
  const add = (jid, amt) => {
    if (!jid || !(amt > 0)) return
    payouts.set(jid, (payouts.get(jid) ?? 0) + Math.floor(amt))
  }

  if (draw) {
    const share = (pool * 0.9) / Math.max(1, allChamps.length)
    for (const c of allChamps) add(c.jid, share)
    treasuryCredit(db, war.guildAId, Math.floor(pool * 0.05))
    treasuryCredit(db, war.guildBId, pool - Math.floor(pool * 0.05) - Math.floor(share) * allChamps.length)
  } else {
    const winChamps = allChamps.filter(c => c.guildId === winnerGuildId)
    const loseChamps = allChamps.filter(c => c.guildId !== winnerGuildId)

    const mvpBonus = Math.floor(pool * 0.20)
    const supporterShareTotal = Math.floor(pool * 0.10)
    const loseTotal = Math.floor(pool * 0.20)
    const treasuryTotal = Math.floor(pool * 0.05)
    const winTotal = pool - mvpBonus - supporterShareTotal - loseTotal - treasuryTotal

    add(mvp?.jid, mvpBonus)
    distributeWeighted(payouts, winChamps, war, winTotal)
    distributeWeighted(payouts, loseChamps, war, loseTotal)

    const winSupporters = (winnerGuildId === war.guildAId ? war.supportsA : war.supportsB) ?? []
    const supportShare = supporterShareTotal / Math.max(1, winSupporters.length || 1)
    for (const s of winSupporters) add(s.jid, supportShare)

    treasuryCredit(db, winnerGuildId, treasuryTotal)
  }

  // ── Pay the players: solars, dominance, massive XP, war counts ────────
  const size = war.size ?? 1
  const victoryXp = WAR_VICTORY_XP + WAR_VICTORY_XP_PER_SLOT * size
  const mvpJid = war.mvpJid

  for (const c of allChamps) {
    if (!playerExists(db, c.jid)) continue
    const isWinner = !!winnerGuildId && c.guildId === winnerGuildId
    const isMvp = mvpJid === c.jid
    const perf = war.stats[c.jid]?.perf ?? 0
    await updatePlayer(db, c.jid, p => {
      const d = ensureDominance(p)
      d.wars += 1
      if (isWinner) d.wins += 1
      else if (!draw) d.losses += 1

      const baseGain = isWinner
        ? 90 + Math.round(perf / 40)
        : draw ? 40 + Math.round(perf / 80)
        : 15 + Math.round(perf / 120)
      const domGain = isMvp ? baseGain + 75 : baseGain
      const beforeTier = dominanceTierFor(d.score)
      d.score += domGain
      if (isMvp) d.mvp += 1
      d.peak = Math.max(d.peak, d.score)

      const xpGain = (isWinner ? victoryXp : draw ? Math.floor(victoryXp / 3) : WAR_DEFEAT_XP + 150 * size)
        + (isMvp ? WAR_MVP_XP : 0)
      p.xp = (p.xp ?? 0) + xpGain
      applyLevelUps(p, levelsData, classes, races, getTotalStats)

      const prize = payouts.get(c.jid) ?? 0
      if (prize > 0) {
        p.wallet = p.wallet ?? {}
        p.wallet.solars = (p.wallet.solars ?? 0) + prize
        const st = war.stats[c.jid] ?? (war.stats[c.jid] = emptyStats())
        st.solars = (st.solars ?? 0) + prize
      }

      if (isWinner) {
        p.warTitles = p.warTitles ?? []
        p.warTitles.push({
          warId: war.id,
          vs: getGuildDef(c.guildId === war.guildAId ? war.guildBId : war.guildAId)?.name ?? 'rival',
          score: `${war.score.a}-${war.score.b}`,
          at: Date.now(),
        })
      }

      const afterTier = dominanceTierFor(d.score)
      if (afterTier.id !== beforeTier.id) {
        rankUpLines.push(
          `${afterTier.emoji} *DOMINANCE RANK UP!* *${p.name}* rises to *${afterTier.name}* — score *${d.score.toLocaleString()}*!`
        )
      }
    })
  }

  // Supporters rally points + XP.
  const supporterPairs = [
    ...(war.supportsA ?? []).map(s => ({ ...s, guildId: war.guildAId })),
    ...(war.supportsB ?? []).map(s => ({ ...s, guildId: war.guildBId })),
  ]
  for (const s of supporterPairs) {
    if (!playerExists(db, s.jid)) continue
    const sideWon = !!winnerGuildId && s.guildId === winnerGuildId
    const stillInGuild = getPlayer(db, s.jid)?.guildId === s.guildId
    await updatePlayer(db, s.jid, p => {
      const d = ensureDominance(p)
      const beforeTier = dominanceTierFor(d.score)
      if (stillInGuild) {
        d.wars += 1
        if (sideWon) d.wins += 1
        else if (!draw) d.losses += 1
        d.score += sideWon ? 35 : draw ? 20 : 10
        d.peak = Math.max(d.peak, d.score)
      }
      p.xp = (p.xp ?? 0) + (sideWon ? WAR_SUPPORT_WIN_XP : draw ? 400 : WAR_SUPPORT_LOSS_XP)
      applyLevelUps(p, levelsData, classes, races, getTotalStats)
      const prize = payouts.get(s.jid) ?? 0
      if (prize > 0) {
        p.wallet = p.wallet ?? {}
        p.wallet.solars = (p.wallet.solars ?? 0) + prize
      }
      const afterTier = dominanceTierFor(d.score)
      if (afterTier.id !== beforeTier.id) {
        rankUpLines.push(`${afterTier.emoji} *DOMINANCE RANK UP!* *${p.name}* rises to *${afterTier.name}*!`)
      }
    })
  }

  // ── Guild standing: wins/losses, streaks, war tier ───────────────────
  const guildDominanceGain = (won, sz) => won ? 400 + 100 * sz : 100 + 25 * sz
  for (const guildId of [war.guildAId, war.guildBId]) {
    const won = winnerGuildId === guildId
    const { rec, war: gw } = ensureGuildWarStats(db, guildId)
    const tierBefore = guildWarTierFor(gw.dominance)

    if (draw) { gw.draws += 1; gw.streak = 0 }
    else if (won) {
      gw.wins += 1
      gw.streak = gw.streak > 0 ? gw.streak + 1 : 1
      gw.bestStreak = Math.max(gw.bestStreak, gw.streak)
      gw.trophies += 1
    } else { gw.losses += 1; gw.streak = Math.min(0, gw.streak - 1) }

    gw.dominance += draw ? 60 : guildDominanceGain(won, size)
    gw.peakDominance = Math.max(gw.peakDominance, gw.dominance)
    if (mvpJid && getPlayer(db, mvpJid)?.guildId === guildId) gw.mvpAwards += 1
    gw.lastWarAt = Date.now()
    gw.history.unshift({
      warId: war.id,
      vs: guildId === war.guildAId ? war.guildBId : war.guildAId,
      result: draw ? 'draw' : won ? 'win' : 'loss',
      score: guildId === war.guildAId ? `${war.score.a}-${war.score.b}` : `${war.score.b}-${war.score.a}`,
      pool,
      at: Date.now(),
    })
    if (gw.history.length > 8) gw.history.length = 8
    rec.updatedAt = Date.now()

    const tierAfter = guildWarTierFor(gw.dominance)
    if (tierAfter.id !== tierBefore.id) {
      const def = getGuildDef(guildId)
      rankUpLines.push(
        `${tierAfter.emoji} *GUILD WAR RANK UP!*\n` +
        `${def?.emoji ?? ''} *${def?.name ?? guildId}* ascends to *${tierAfter.name}*!\n` +
        `_War dominance: ${gw.dominance.toLocaleString()}_`
      )
    }
  }

  await db.write()

  // ── Banner ───────────────────────────────────────────────────────────
  const aDef = getGuildDef(war.guildAId)
  const bDef = getGuildDef(war.guildBId)
  const mvpName = mvpJid && playerExists(db, mvpJid) ? getPlayer(db, mvpJid).name : null
  const mvpPrize = mvpJid ? (payouts.get(mvpJid) ?? 0) : 0

  const lines = []
  lines.push(`🏆🔥 *THE GUILD WAR IS OVER!* 🔥🏆`)
  lines.push(`━━━━━━━━━━━━━━━━━━━━`)
  if (reasonLine) lines.push(reasonLine, ``)
  if (draw) {
    lines.push(`🤝 *DRAW!* ${aDef?.emoji} *${aDef?.name}* ${war.score.a} — ${war.score.b} *${bDef?.name}* ${bDef?.emoji}`)
    lines.push(`Both guilds walk away with honour and an even share of the pool.`)
  } else {
    const wDef = getGuildDef(winnerGuildId)
    lines.push(`👑 *VICTORY TO ${wDef?.emoji} ${wDef?.name?.toUpperCase()}!* 👑`)
    lines.push(`Final: *${war.score.a} — ${war.score.b}*  ·  *${war.matchType}*  ·  ${formatName(war.formatId)}`)
  }
  lines.push(``)
  lines.push(`💰 *PRIZE POOL: ☀️ ${pool.toLocaleString()} SOLARS* — generated by the bot, paid by no one.`)
  if (mvpName) {
    lines.push(``)
    lines.push(`🥇 *MVP — ${mvpName.toUpperCase()}*`)
    lines.push(`   Performance *${(war.stats[mvpJid]?.perf ?? 0).toLocaleString()}* · takes the biggest cut: *+${mvpPrize.toLocaleString()} ☀️* and *+${WAR_MVP_XP.toLocaleString()} XP*`)
  }
  lines.push(``)
  lines.push(`📊 *DOMINANCE & SCORE*`)
  for (const c of allChamps) {
    const st = war.stats[c.jid] ?? {}
    const dTier = playerExists(db, c.jid) ? dominanceTierFor(getPlayer(db, c.jid).dominance?.score ?? 0) : DOMINANCE_TIERS[0]
    const prize = payouts.get(c.jid) ?? 0
    lines.push(
      `  ${c.jid === mvpJid ? '🥇' : '•'} *${c.name}* — ${dTier.emoji} ${dTier.name}` +
      `  ·  perf *${(st.perf ?? 0).toLocaleString()}*` +
      `  ·  ${st.wins ?? 0}W/${st.losses ?? 0}L` +
      (prize > 0 ? `  ·  ☀️ +${Math.floor(prize).toLocaleString()}` : '')
    )
  }
  const supportCount = supporterPairs.length
  if (supportCount) lines.push(`📣 ${supportCount} guildmate(s) rallied in support and were paid for it.`)
  lines.push(``)
  lines.push(`🎁 *WINNERS' BOUNTY* — every champion on the winning side banks *${victoryXp.toLocaleString()} XP* (+ MVP bonus).`)
  lines.push(`🎖️ Climb the ladder: *${config.prefix}guild war leaderboard* · *${config.prefix}guild war top*.`)

  return { banner: lines.join('\n'), rankUpLines, payouts, mvpJid, winnerGuildId }
}

/** Split `total` across `entries` weighted by their performance. */
function distributeWeighted(payouts, entries, war, total) {
  if (!entries.length || total <= 0) return
  const weights = entries.map(e => Math.max(1, war.stats?.[e.jid]?.perf ?? 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  let assigned = 0
  entries.forEach((e, i) => {
    const share = i === entries.length - 1
      ? total - assigned
      : Math.floor(total * (weights[i] / sum))
    assigned += Math.max(0, Math.floor(share))
    if (share > 0) payouts.set(e.jid, (payouts.get(e.jid) ?? 0) + Math.floor(share))
  })
}

function treasuryCredit(db, guildId, amount) {
  if (!guildId || !(amount > 0)) return
  const rec = getGuildRecord(db, guildId)
  rec.treasury = (rec.treasury ?? 0) + Math.floor(amount)
}

/* ─────────────────────── claim / forfeit / sweep ─────────────────────── */

/**
 * canClaimPairing(war, match, now) — the ready champion may take a walkover
 * once the pairing has sat idle past WAR_MATCH_CLAIM_MS.
 */
export function canClaimPairing(war, match, now = Date.now()) {
  if (!match || match.winnerJid) return { ok: false, why: 'done' }
  const started = match.liveAt ?? match.startedAt ?? war.lastActivityAt ?? war.createdAt ?? now
  const idle = now - started
  if (idle < WAR_MATCH_CLAIM_MS) return { ok: false, why: 'too_early', ms: WAR_MATCH_CLAIM_MS - idle }
  if (idle >= WAR_MATCH_VOID_MS) return { ok: false, why: 'void' }
  return { ok: true, ms: idle }
}

/**
 * sweepGuildWars(db, now, ctx) — read-path hygiene, no scheduler (same
 * reasoning as pvp-engine's TURN_TIMEOUT_MS):
 *   • expired pending challenges lapse,
 *   • pairings idle past the void window score 0-0 and the war moves on,
 *   • an entire war idle past WAR_STALE_MS concludes on its current score.
 * Returns a human line when something happened, else null.
 */
export async function sweepGuildWars(db, now = Date.now(), ctx = null) {
  await ensureWarState(db)
  const all = db.data.guildWars ?? {}
  const notes = []

  // Stranded Preset 5 first: a player still wearing a war kit while their war
  // is finished/cancelled/missing gets their real inventory back before any
  // other bookkeeping runs. A LIVE pairing's kit is deliberately spared.
  for (const [jid, pl] of Object.entries(db.data.users ?? {})) {
    if (!hasWarKit(pl)) continue
    const warId = pl.warStash?.warId
    const war = warId ? all[warId] : null
    const livePairing = war && war.status === 'active'
      && (war.matches?.[war.currentMatch]?.status === 'live')
      && !war.matches[war.currentMatch].winnerJid
      && (war.matches[war.currentMatch].aJid === jid || war.matches[war.currentMatch].bJid === jid)
    if (livePairing) continue
    await updatePlayer(db, jid, p => { if (hasWarKit(p)) removeWarKit(p) })
    notes.push(`🎒 Preset 5 lifted from *${pl.name}* — your inventory and gear are back.`)
  }

  for (const war of Object.values(all)) {
    if (war.status === 'pending' && (war.acceptUntil ?? 0) <= now) {
      war.status = 'cancelled'
      war.finishedAt = now
      notes.push(`⌛ The Guild War challenge from *${getGuildDef(war.guildAId)?.name ?? 'a rival'}* lapsed unanswered.`)
      try { await db.write() } catch { /* RAM still correct */ }
      continue
    }

    if (war.status !== 'active') continue

    const match = war.matches?.[war.currentMatch]
    if (match && !match.winnerJid) {
      const began = match.liveAt ?? match.startedAt ?? war.lastActivityAt ?? war.createdAt ?? now
      if (now - began >= WAR_MATCH_VOID_MS) {
        war.matches[war.currentMatch] = { ...match, status: 'done', voided: true, finishedAt: now }
        war.lastActivityAt = now
        try { await db.write() } catch { /* RAM still correct */ }

        if (warScoreComplete(war)) {
          const fin = await finishWar(db, war, `_Pairing ${match.i + 1} timed out unplayed — the war concludes on the score._`, ctx)
          notes.push(fin.banner)
          if (fin.rankUpLines?.length) notes.push(fin.rankUpLines.join('\n\n'))
        } else {
          notes.push(`⏳ Pairing ${match.i + 1} expired unplayed (0—0).`)
          await startNextPairing(db, war, ctx)
        }
        continue
      }
    }

    if (now - (war.lastActivityAt ?? war.createdAt ?? 0) >= WAR_STALE_MS) {
      const fin = await finishWar(db, war, `_The war went quiet for a day — it concludes on the current score._`, ctx)
      notes.push(fin.banner)
      if (fin.rankUpLines?.length) notes.push(fin.rankUpLines.join('\n\n'))
    }
  }

  return notes.length ? notes.join('\n\n') : null
}

/**
 * emergencyStripKits(db, jid) — belt-and-braces: if a player still wears a
 * war preset, hand their belongings back. Never destructive, idempotent.
 */
export async function emergencyStripKits(db, jid) {
  if (!playerExists(db, jid)) return false
  let stripped = false
  await updatePlayer(db, jid, p => {
    if (hasWarKit(p)) { removeWarKit(p); stripped = true }
  })
  return stripped
}

/* ─────────────────────────── display helpers ─────────────────────────── */

/** The full war board — used by `.guild war status`. */
export function warBoard(war, db) {
  const aDef = getGuildDef(war.guildAId)
  const bDef = getGuildDef(war.guildBId)
  const lines = []

  const statusEmoji = { pending: '📩', active: '⚔️', finished: '🏆', cancelled: '🏳️' }[war.status] ?? '⚔️'
  lines.push(`${statusEmoji} *GUILD WAR — ${war.matchType}*`)
  lines.push(`${aDef?.emoji} *${aDef?.name}*  ⚔️  ${bDef?.emoji} *${bDef?.name}*`)
  lines.push(`📜 ${formatName(war.formatId)}  ·  ${warKitLabel(war.kitTier)}  ·  ${war.stakes === 'wager' ? `💰 wager ☀️ ${war.stakeSolars.toLocaleString()}` : '⚖️ normal stakes'}`)
  lines.push(`💰 Prize pool: *☀️ ${war.prizePool.toLocaleString()}* _(bot-stamped, nobody paid)_`)

  if (war.status === 'pending') {
    lines.push(``)
    const hrs = Math.max(0, Math.ceil(((war.acceptUntil ?? 0) - Date.now()) / 3600000))
    lines.push(`📩 Awaiting *${bDef?.name}* — their leader has *${hrs}h* to answer.`)
    lines.push(`*Champions named by ${aDef?.name}:*`)
    lines.push(`  ${war.teamA.map(c => `⚔️ *${c.name}*`).join('\n  ') || '  _none_'}`)
    lines.push(`_Answer with:_ *${config.prefix}guild war accept @champ1 [@champ2 …]*`)
    return lines.join('\n')
  }

  if (war.status === 'cancelled') {
    lines.push(``)
    lines.push(`🏳️ This war was withdrawn before it was decided.`)
    return lines.join('\n')
  }

  lines.push(``)
  lines.push(`📊 *${aDef?.name}:* ${war.score.a}  —  ${war.score.b} *${bDef?.name}*`)
  lines.push(``)

  const teamLine = (team, guildDef) => {
    const rows = team.map((c, i) => {
      const st = war.stats[c.jid] ?? {}
      const m = war.matches?.[i]
      let mark = '⏳'
      if (m?.winnerJid) {
        mark = m.winnerJid === c.jid ? '✅' : '❌'
        if (m.walkover) mark += ' 🚶'
        if (m.voided) mark = '🕳️'
      } else if (m?.status === 'live') mark = '🔥'
      const mvp = war.mvpJid === c.jid ? ' 🥇' : ''
      return `  ${mark} *${c.name}*${mvp} — perf ${Number(st.perf ?? 0).toLocaleString()} · ${st.wins ?? 0}W/${st.losses ?? 0}L`
    })
    return `*${guildDef?.emoji} ${guildDef?.name} champions:*\n${rows.join('\n')}`
  }

  lines.push(teamLine(war.teamA, aDef))
  lines.push(``)
  lines.push(teamLine(war.teamB, bDef))

  if (war.status === 'finished') {
    lines.push(``)
    if (war.winnerGuildId) {
      const w = getGuildDef(war.winnerGuildId)
      lines.push(`👑 *Winner:* ${w?.emoji} *${w?.name}*`)
    } else lines.push(`🤝 *Draw*`)
    if (war.mvpJid) {
      const mvpName = playerExists(db, war.mvpJid) ? getPlayer(db, war.mvpJid).name : 'MVP'
      lines.push(`🥇 *MVP:* ${mvpName}`)
    }
  } else {
    const match = war.matches?.[war.currentMatch]
    lines.push(``)
    if (match) {
      const an = playerExists(db, match.aJid) ? getPlayer(db, match.aJid).name : 'Champion'
      const bn = playerExists(db, match.bJid) ? getPlayer(db, match.bJid).name : 'Champion'
      lines.push(`🔥 *Now pairing ${match.i + 1}/${war.matches.length}:* *${an}* ⚔️ *${bn}*`)
      lines.push(`_Fight with *${config.prefix}pvp @<opponent>* or *${config.prefix}pvp accept*._`)
    }
    if (Array.isArray(war.combatLog) && war.combatLog.length) {
      lines.push(`📜 Recent:\n${war.combatLog.slice(-3).map(l => `  ${l}`).join('\n')}`)
    }
  }

  const supports = (war.supportsA?.length ?? 0) + (war.supportsB?.length ?? 0)
  if (supports) lines.push(`📣 ${supports} guildmate(s) tagged in support.`)

  return lines.join('\n')
}

/** Push a line onto the war's short in-record announcer (capped). */
export function noteWar(war, line) {
  if (!Array.isArray(war.combatLog)) war.combatLog = []
  war.combatLog.push(line)
  if (war.combatLog.length > 8) war.combatLog.shift()
}

/**
 * tagPeople(ctx, jids, text) — send `text` in the group with real @mentions
 * of everyone in `jids`. Best-effort: never throws, never required for
 * correctness (the announcement text itself is the source of truth).
 */
export async function tagPeople(ctx, jids, text = null) {
  const list = [...new Set((jids ?? []).filter(Boolean))]
  if (!list.length || !ctx?.isGroup || !ctx?.sock?.sendMessage) return null
  const body = text ?? `📣 *RALLY TO WAR!* ${list.map(() => '@1').join(' ')}`
  return ctx.sock.sendMessage(ctx.sender, { text: body, mentions: list })
}

/** Exported for plugins/guild.js's own kit help. */
export { applyWarKit, removeWarKit, hasWarKit, WAR_KIT_TIERS, warKitLabel, normalizeKitTier }
