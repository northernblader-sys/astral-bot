/**
 * plugins/war.js — declare and wage TIMED war on rival empires.
 *
 *   .war declare <empire> [<time>]  open hostilities (costs treasury); the target
 *                           has a window to accept or decline. An optional trailing
 *                           time (30m to 4h, e.g. "2h" or "90m") sets how long the
 *                           war will run once accepted; it defaults otherwise.
 *   .war accept [<empire>]  accept a declaration made against you: the clock starts
 *   .war decline [<empire>] refuse a declaration; it is withdrawn
 *   .war attack             press the assault NOW, pulling the next round forward
 *                           instead of waiting for the clock (cooldown limited)
 *   .war peace              sue for peace in an active war (both stand down, no
 *                           raze), or withdraw your own pending declaration
 *   .war status             the live war: rounds, losses, time left, raze stakes
 *
 * Phase 4 of the Empire pillar, reworked into the DEVASTATING TIMED conflict layer.
 * A war is no longer first-to-three instant rounds: once accepted it runs for a
 * set span (WAR_CONFIG.minDurationMinutes to maxDurationMinutes), a round firing
 * about every roundIntervalMinutes. Rounds are resolved ON READ by the engine in
 * lib/empire-repo.js (settleEmpireConflicts), so simply checking status advances
 * the war. When the clock runs out (or an army is wiped) whoever leads on rounds
 * WINS, and the LOSER is razed back to its founding: id, name, ruler and sworn
 * citizens survive, but every building, the army, the stash and the market are
 * gone, under a long recovery shield. Suing for peace is the only way to stand
 * down without a raze. All the per-round math is pure in lib/empire-combat.js.
 *
 * NO SCHEDULER: nothing runs on a timer. gateOwned advances any due conflict
 * (settleEmpireConflicts, gated by conflictsNeedSettle) before reading state, so
 * every war command sees a front current to this moment.
 *
 * STATE MODEL (no dedicated container, no drift):
 *   - A war lives as a mirror on record.war. While only 'declared' it sits on the
 *     AGGRESSOR ALONE, so a lapse or decline is a single-sided cleanup. It lands
 *     on BOTH sides when it turns 'active', at accept, and every transition into
 *     or out of 'active' is a two-party write updating both mirrors in one pass.
 *   - Once active the engine drives rounds from the AGGRESSOR's mirror and keeps
 *     the defender's in lock step, so the two never diverge.
 *
 * WRITE SAFETY: declare/accept/decline/peace and the manual-attack nudge each use
 * SEQUENTIAL, never-nested updatePlayer writes that settle with applyCollect before
 * touching anything rate-bearing. Rounds, casualties and the raze are applied by
 * the engine inside its one settle pass; every notification is pushed one owner at
 * a time, never a loop over members, never a group broadcast, never a DM fan-out.
 * Nothing here mints gems, and nothing reads or writes a player's baseStats.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { pushNotification } from '../lib/notification-repo.js'
import {
  ensureEmpiresInitialized, getOwnedEmpire, findEmpireByQuery, getEmpireRecord, ensureEmpirePlayer,
  sweepEmpireLifecycle, empireNeedsSweep, settleEmpireConflicts, conflictsNeedSettle,
} from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, WAR_CONFIG, HOUR_MS, applyCollect, previewCollect,
  armyPower, fmtDuration,
} from '../lib/empire-engine.js'
import { buildSnapshot, weightMatchOk } from '../lib/empire-combat.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'

// ── Shared helpers ───────────────────────────────────────────────────────────

function noEmpire(p) {
  return (
    `🏰 *You don't rule an empire yet.*\n` +
    `Found one for *${EMPIRE_CONFIG.foundCost.toLocaleString()} solars*:\n` +
    `> *${p}empire found <name>*`
  )
}

function disabledMsg(p) {
  return (
    `🚫 The Empire system is disabled in this group.\n` +
    `_A group admin can enable it with *${p}empire on*._`
  )
}

function hrsLeft(untilMs, now) {
  const ms = Math.max(0, (untilMs ?? 0) - now)
  const h = ms / HOUR_MS
  if (h >= 1) return `${Math.ceil(h)}h`
  return `${Math.max(1, Math.ceil(ms / 60000))}m`
}

function fmtLosses(losses) {
  const parts = []
  if (losses?.recruit) parts.push(`${losses.recruit.toLocaleString()} recruit${losses.recruit === 1 ? '' : 's'}`)
  if (losses?.soldier) parts.push(`${losses.soldier.toLocaleString()} soldier${losses.soldier === 1 ? '' : 's'}`)
  return parts.length ? parts.join(', ') : 'no rank and file'
}

const roundIntervalMs = () => Math.max(60000, Math.floor((WAR_CONFIG.roundIntervalMinutes ?? 15) * 60 * 1000))

/** Clamp a proposed war length (minutes) into the configured [min, max] band. */
function clampDurationMin(min) {
  const lo = WAR_CONFIG.minDurationMinutes ?? 30
  const hi = WAR_CONFIG.maxDurationMinutes ?? 240
  const v = Number.isFinite(min) ? min : (WAR_CONFIG.defaultDurationMinutes ?? 60)
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Splits an optional trailing time token off a declare query. "Foo 2h" gives
 * { head:'Foo', durMin:120 }; "Foo 90m" or "Foo 90" give 90 minutes; a query
 * with no trailing time gives { head:query, durMin:null }. A bare number counts
 * as minutes. The caller falls back to the whole query if the head does not match
 * an empire, so an empire literally named with a trailing number still resolves.
 */
function splitDuration(query) {
  const toks = (query ?? '').trim().split(/\s+/).filter(Boolean)
  if (toks.length >= 2) {
    const last = toks[toks.length - 1]
    const m = /^(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/i.exec(last)
    if (m) {
      const val = parseFloat(m[1])
      const unit = (m[2] || 'm').toLowerCase()
      const durMin = unit.startsWith('h') ? val * 60 : val
      return { head: toks.slice(0, -1).join(' '), durMin }
    }
  }
  return { head: (query ?? '').trim(), durMin: null }
}

const warActive = rec => rec?.war?.status === 'active'
const warDeclared = rec => rec?.war?.status === 'declared'
const warLapsed = (rec, now) => rec?.war?.status === 'declared' && (rec.war.acceptWindowUntil ?? 0) <= now

/**
 * Every empire that has an unlapsed declaration of war pending against `defId`.
 * A declaration lives only on the aggressor while 'declared', so this scan is
 * how a defender discovers who has moved against them, with no defender-side
 * mirror to keep in sync.
 */
function pendingAgainst(db, defId, now) {
  return Object.values(db.data.empires ?? {}).filter(rec =>
    rec?.war?.status === 'declared'
    && rec.war.role === 'aggressor'
    && rec.war.opponentId === defId
    && (rec.war.acceptWindowUntil ?? 0) > now)
}

/** Enabled-check + init + lifecycle sweep + conflict settle + owned lookup. */
async function gateOwned(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) { await ctx.reply(disabledMsg(p)); return null }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const now = Date.now()
  // Age abandoned empires so a dormant/succeeded target resolves before any
  // declaration reads it (the caller's own empire is spared), then advance any
  // war or siege that has come due so the front is current before we read it.
  if (empireNeedsSweep(ctx.db, now, ctx.from)) await sweepEmpireLifecycle(ctx.db, now, ctx.from)
  if (conflictsNeedSettle(ctx.db, now)) await settleEmpireConflicts(ctx.db, now)
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) { await ctx.reply(noEmpire(p)); return null }
  return owned
}

/** Render one recent-war log line, robust to new and legacy entry shapes. */
function renderWarLogLine(e, now) {
  const ago = `${Math.max(1, Math.ceil((now - (e.at ?? now)) / HOUR_MS))}h ago`
  const foe = e.opponent ?? e.vs ?? 'a rival'
  const trib = e.tribute ?? e.tributeLost ?? 0
  if (e.role === 'win') return `🏆 Beat *${foe}*${trib ? `, took ${trib.toLocaleString()} solars` : ''}. _${ago}_`
  if (e.role === 'razed') return `💀 Razed by *${foe}*${trib ? `, lost ${trib.toLocaleString()} solars` : ''}. _${ago}_`
  if (e.role === 'loss') return `💀 Lost to *${foe}*${trib ? `, paid ${trib.toLocaleString()} solars` : ''}. _${ago}_`
  return `🕊️ Peace with *${foe}*. _${ago}_`
}

// ── Declare (.war declare <empire> [<time>]) ────────────────────────────────────

async function doDeclare(ctx, query) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  if (warActive(owned)) {
    return ctx.reply(`⚔️ You are already at war with *${owned.war.opponentName}*. See *${p}war status*.`)
  }
  if (warDeclared(owned) && !warLapsed(owned, now)) {
    return ctx.reply(
      `📜 You already have a declaration pending against *${owned.war.opponentName}*.\n` +
      `_Withdraw it with *${p}war peace* before declaring on someone else._`
    )
  }
  if (!query) return ctx.reply(`⚔️ *Declare war on whom?* Try *${p}war declare <empire> [time]*, e.g. *${p}war declare Ravenhold 2h*.`)

  // Resolve the target, tolerating an optional trailing duration token.
  const { head, durMin } = splitDuration(query)
  let target = null
  let durationMin = WAR_CONFIG.defaultDurationMinutes ?? 60
  if (durMin != null && head) {
    target = findEmpireByQuery(ctx.db, head)
    if (target) durationMin = clampDurationMin(durMin)
  }
  if (!target) target = findEmpireByQuery(ctx.db, query)

  if (!target) return ctx.reply(`⚔️ No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (target.id === owned.id) return ctx.reply(`⚔️ You cannot declare war on your own empire.`)
  if (!target.ownerId) return ctx.reply(`⚔️ *${target.name}* has no ruler to answer a declaration.`)
  if (target.dormant) return ctx.reply(`💤 *${target.name}* lies dormant. There is no one there to fight.`)

  // Only once the target is legal do we check that you can actually march.
  if (armyPower(owned) <= 0) {
    return ctx.reply(`⚔️ You have no army to march. Recruit troops first with *${p}recruit <n>*.`)
  }
  if (warActive(target)) return ctx.reply(`⚔️ *${target.name}* is already locked in a war. Wait until it ends.`)
  if (target.siege?.status === 'active') {
    return ctx.reply(`🏰 *${target.name}* is out on a siege right now. You cannot declare on them until their army is home.`)
  }
  if ((target.shieldUntil ?? 0) > now) {
    return ctx.reply(`🛡️ *${target.name}* is under a recovery shield for *${hrsLeft(target.shieldUntil, now)}*. You cannot declare on them yet.`)
  }

  const atkSnap = buildSnapshot(owned)
  const defSnap = buildSnapshot(target)
  if (!weightMatchOk(atkSnap, defSnap, WAR_CONFIG.weightFloorPct ?? 0.5)) {
    return ctx.reply(
      `⚖️ *${target.name}* is far weaker than you. Your court will not sanction so lopsided a war.\n` +
      `_Wars are weight matched. Choose a rival closer to your own might._`
    )
  }

  // Affordability against the SETTLED treasury, so heavy upkeep can't leave the
  // declaration paid for at a floored zero.
  const cost = WAR_CONFIG.declareCostSolars ?? 0
  const settled = previewCollect(owned, now).treasuryAfter
  if (settled < cost) {
    return ctx.reply(
      `💰 Declaring war musters the army for *${cost.toLocaleString()} solars*.\n` +
      `Your treasury holds *${Math.max(0, Math.floor(settled)).toLocaleString()}* after upkeep. Build up your coffers first.`
    )
  }

  const durationMs = Math.floor(durationMin * 60 * 1000)
  const targetId = target.id
  const targetName = target.name
  const targetOwnerId = target.ownerId
  const acceptUntil = now + (WAR_CONFIG.acceptWindowHours ?? 24) * HOUR_MS

  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) return player
    applyCollect(rec, now)
    rec.treasury = Math.max(0, rec.treasury - cost)
    rec.dormant = false
    rec.war = {
      opponentId: targetId, opponentName: targetName,
      status: 'declared', role: 'aggressor',
      myWins: 0, theirWins: 0, roundsFought: 0,
      myLosses: { recruit: 0, soldier: 0 }, theirLosses: { recruit: 0, soldier: 0 },
      declaredAt: now, acceptWindowUntil: acceptUntil,
      startedAt: null, endsAt: null, nextRoundAt: null, lastAttackAt: null,
      durationMs, peaceOffered: false,
    }
    rec.lastActiveAt = now
    return player
  })

  await pushNotification(ctx.db, targetOwnerId, {
    kind: 'battle',
    title: `⚔️ ${owned.name} declared war`,
    body: `${owned.name} has declared war on you, to run *${fmtDuration(durationMs)}* once it begins. You have ${hrsLeft(acceptUntil, now)} to *${p}war accept* or *${p}war decline*.`
      + ` Ignore it and the declaration lapses. Lose the war and your empire is razed to its founding.`,
  }).catch(() => {})

  return ctx.reply(
    `⚔️📜 *WAR DECLARED*\n${RULE}\n` +
    `*${owned.name}* has declared war on *${targetName}*.\n` +
    `💰 Mustering the army cost *${cost.toLocaleString()} solars*.\n` +
    `⏳ Once accepted the war will run *${fmtDuration(durationMs)}*, a round about every *${WAR_CONFIG.roundIntervalMinutes ?? 15}m*.\n` +
    `📩 They have *${hrsLeft(acceptUntil, now)}* to accept or decline. If they let it lapse, the war is off and your muster is spent.\n` +
    `💀 Whoever leads when the clock runs out wins it all, and the loser is *razed to their founding*.\n` +
    `_Withdraw the declaration any time with *${p}war peace*._`
  )
}

// ── Accept / decline (.war accept, .war decline) ───────────────────────────────

/** Resolves which pending declaration a defender means, or replies and returns null. */
async function pickPending(ctx, owned, query, verb) {
  const p = config.prefix
  const now = Date.now()
  const pend = pendingAgainst(ctx.db, owned.id, now)
  if (!pend.length) { await ctx.reply(`🕊️ No one has declared war on you. There is nothing to ${verb}.`); return null }
  if (query) {
    const q = query.toLowerCase()
    const match = pend.find(r => r.id === q || (r.name ?? '').toLowerCase() === q || (r.name ?? '').toLowerCase().includes(q))
    if (!match) { await ctx.reply(`🔎 No pending declaration from *"${query}"*. Run *${p}war status* to see who has moved against you.`); return null }
    return match
  }
  if (pend.length > 1) {
    const names = pend.map(r => `• *${r.name}*`).join('\n')
    await ctx.reply(`⚔️ More than one empire has declared war on you:\n${names}\n\n_Specify which: *${p}war ${verb} <empire>*._`)
    return null
  }
  return pend[0]
}

async function doAccept(ctx, query) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  if (warActive(owned)) return ctx.reply(`⚔️ You are already at war with *${owned.war.opponentName}*. Finish it first.`)
  if (owned.siege?.status === 'active') return ctx.reply(`🏰 Your army is out on a siege. You cannot open a war until it returns.`)

  const aggressor = await pickPending(ctx, owned, query, 'accept')
  if (!aggressor) return

  const aggId = aggressor.id
  const aggName = aggressor.name
  const aggOwnerId = aggressor.ownerId
  const declaredAt = aggressor.war?.declaredAt ?? now
  const durationMs = Math.floor(clampDurationMin((aggressor.war?.durationMs ?? 0) / 60000) * 60 * 1000)
  const endsAt = now + durationMs
  const nextRoundAt = now + roundIntervalMs()

  // Aggressor first, then defender: both mirrors land 'active' with the clock
  // running in this one pair, and neither carries a value the other needs.
  await updatePlayer(ctx.db, aggOwnerId, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[aggId]
    if (!rec || rec.war?.status !== 'declared' || rec.war.opponentId !== owned.id) return player
    applyCollect(rec, now)
    rec.dormant = false
    rec.war.status = 'active'
    rec.war.myWins = 0; rec.war.theirWins = 0; rec.war.roundsFought = 0
    rec.war.myLosses = { recruit: 0, soldier: 0 }; rec.war.theirLosses = { recruit: 0, soldier: 0 }
    rec.war.startedAt = now
    rec.war.endsAt = endsAt
    rec.war.nextRoundAt = nextRoundAt
    rec.war.durationMs = durationMs
    rec.war.acceptWindowUntil = null
    rec.war.lastAttackAt = null
    rec.war.peaceOffered = false
    rec.lastActiveAt = now
    return player
  })
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) return player
    applyCollect(rec, now)
    rec.dormant = false
    rec.war = {
      opponentId: aggId, opponentName: aggName,
      status: 'active', role: 'defender',
      myWins: 0, theirWins: 0, roundsFought: 0,
      myLosses: { recruit: 0, soldier: 0 }, theirLosses: { recruit: 0, soldier: 0 },
      declaredAt, acceptWindowUntil: null,
      startedAt: now, endsAt, nextRoundAt, lastAttackAt: null,
      durationMs, peaceOffered: false,
    }
    rec.lastActiveAt = now
    return player
  })

  await pushNotification(ctx.db, aggOwnerId, {
    kind: 'battle',
    title: `⚔️ ${owned.name} accepted your war`,
    body: `${owned.name} answered your declaration. The war has begun and will run ${fmtDuration(durationMs)}. Rounds resolve on their own; press the pace with ${p}war attack.`,
  }).catch(() => {})

  return ctx.reply(
    `⚔️🔥 *WAR BEGUN*\n${RULE}\n` +
    `*${owned.name}* accepts the war with *${aggName}*.\n` +
    `⏳ It runs *${fmtDuration(durationMs)}*, a round firing about every *${WAR_CONFIG.roundIntervalMinutes ?? 15}m* on its own.\n` +
    `💀 Whoever leads on rounds when the clock runs out wins, and the loser is *razed to their founding*.\n` +
    `> *${p}war attack* to press the assault now\n` +
    `> *${p}war status* to watch it unfold\n` +
    `> *${p}war peace* to propose peace (both sides must agree)`
  )
}

async function doDecline(ctx, query) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return

  if (warActive(owned)) return ctx.reply(`⚔️ You are already at war with *${owned.war.opponentName}*. You cannot decline that now, only sue for peace.`)

  const aggressor = await pickPending(ctx, owned, query, 'decline')
  if (!aggressor) return

  const aggId = aggressor.id
  const aggName = aggressor.name
  const aggOwnerId = aggressor.ownerId

  // The defender holds no mirror while a war is only 'declared', so declining is
  // a single-sided write that clears the aggressor's declaration.
  await updatePlayer(ctx.db, aggOwnerId, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[aggId]
    if (!rec || rec.war?.status !== 'declared' || rec.war.opponentId !== owned.id) return player
    rec.war = null
    return player
  })

  await pushNotification(ctx.db, aggOwnerId, {
    kind: 'battle',
    title: `🕊️ ${owned.name} declined your war`,
    body: `${owned.name} refused your declaration. It has been withdrawn. Your muster is not refunded.`,
  }).catch(() => {})

  return ctx.reply(
    `🕊️ *${owned.name}* declines the war with *${aggName}*.\n` +
    `_Their declaration is withdrawn._`
  )
}

// ── Attack (.war attack) ────────────────────────────────────────────────────────

async function doAttack(ctx) {
  const p = config.prefix

  if (ctx.player?.inBattle) return ctx.reply(`⚔️ Finish your current battle before you march to war.`)
  if (ctx.player?.inDungeon) return ctx.reply(`🗺️ You can't wage war from inside a dungeon.`)

  const owned = await gateOwned(ctx)   // gateOwned has already advanced due rounds
  if (!owned) return
  const now = Date.now()

  if (!owned.war) return ctx.reply(`⚔️ You are not at war. Open one with *${p}war declare <empire>*.`)
  if (warDeclared(owned)) {
    return warLapsed(owned, now)
      ? ctx.reply(`⏳ Your declaration against *${owned.war.opponentName}* lapsed unanswered. Run *${p}war status* to clear it, then declare again.`)
      : ctx.reply(`📜 *${owned.war.opponentName}* has not accepted your declaration yet. You cannot strike until they do.`)
  }
  if (!warActive(owned)) return ctx.reply(`⚔️ You are not in an active war. Open one with *${p}war declare <empire>*.`)

  const cdMs = (WAR_CONFIG.attackCooldownMinutes ?? 10) * 60 * 1000
  if ((owned.war.lastAttackAt ?? 0) + cdMs > now) {
    return ctx.reply(`⏳ Your soldiers are regrouping. Press the assault again in *${hrsLeft((owned.war.lastAttackAt ?? 0) + cdMs, now)}*.`)
  }
  if (armyPower(owned) <= 0) {
    return ctx.reply(`⚔️ Your army is spent. You cannot press the assault, only hold and pray the clock favors you before it runs out.`)
  }

  const foeId = owned.war.opponentId
  const foe = getEmpireRecord(ctx.db, foeId)
  if (!foe || !foe.ownerId || !warActive(foe) || foe.war.opponentId !== owned.id) {
    // The opponent fell apart (razed, dissolved, or desynced). Clear our side.
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[owned.id]
      if (rec) { rec.war = null; rec.lastWarAt = now }
      return player
    })
    return ctx.reply(`🕊️ Your enemy is no longer standing to fight. The war is over.`)
  }

  const isAggressor = owned.war.role === 'aggressor'

  // Pull the next round to now. advanceWar is driven by the AGGRESSOR's mirror,
  // so we re-point that one; we always stamp our own lastAttackAt for cooldown.
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (rec?.war?.status === 'active') {
      rec.war.lastAttackAt = now
      if (rec.war.role === 'aggressor') rec.war.nextRoundAt = now
    }
    return player
  })
  if (!isAggressor) {
    await updatePlayer(ctx.db, foe.ownerId, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[foeId]
      if (rec?.war?.status === 'active' && rec.war.role === 'aggressor' && rec.war.opponentId === owned.id) rec.war.nextRoundAt = now
      return player
    })
  }

  // Resolve the round(s) now due through the engine's one settle pass.
  await settleEmpireConflicts(ctx.db, now)

  const after = getOwnedEmpire(ctx.db, ctx.from)
  const foeName = owned.war.opponentName

  // Still going: report the live standing.
  if (after?.war?.status === 'active') {
    const w = after.war
    const lines = [`⚔️ *You press the assault on ${w.opponentName}*`, RULE]
    lines.push(`🎯 Rounds: *${w.myWins ?? 0}-${w.theirWins ?? 0}* over *${w.roundsFought ?? 0}* fought.`)
    lines.push(`🩸 Your losses: ${fmtLosses(w.myLosses)}. Their losses: ${fmtLosses(w.theirLosses)}.`)
    lines.push(`⏳ *${hrsLeft(w.endsAt, now)}* left. Whoever leads when the clock runs out takes it all.`)
    lines.push(`> Watch it with *${p}war status*, or press again in *${WAR_CONFIG.attackCooldownMinutes ?? 10}m*.`)
    return ctx.reply(lines.join('\n'))
  }

  // Concluded during this pass: read the fresh top war-log entry for the outcome.
  const top = (after?.warLog ?? [])[0]
  const lines = []
  if (top?.role === 'win') {
    lines.push(`🏆🔥 *WAR WON!* 🔥🏆`)
    lines.push(RULE)
    lines.push(`*${after.name}* has broken *${top.opponent ?? foeName}* in the field.`)
    lines.push(`🎯 Final rounds: *${top.myWins ?? 0}-${top.theirWins ?? 0}* over *${top.roundsFought ?? 0}* fought.`)
    if (top.tribute) lines.push(`💰 Tribute seized: *${Number(top.tribute).toLocaleString()} solars*.`)
    lines.push(`🔥 Their empire is *razed to its founding*. Everything they built is gone.`)
    lines.push(`🛡️ Your battered army rests under a *${WAR_CONFIG.victorShieldHours ?? 6}h* shield.`)
    return ctx.reply(lines.join('\n'))
  }
  if (top?.role === 'razed') {
    lines.push(`💀 *WAR LOST* 💀`)
    lines.push(RULE)
    lines.push(`*${top.opponent ?? foeName}* has broken you. The war is lost.`)
    lines.push(`🎯 Final rounds: *${top.myWins ?? 0}-${top.theirWins ?? 0}* over *${top.roundsFought ?? 0}* fought.`)
    if (top.tributeLost) lines.push(`💸 Tribute paid: *${Number(top.tributeLost).toLocaleString()} solars*.`)
    lines.push(`🔥 *${after.name}* is *razed to its founding*: every building, your army, your stash and your market are gone.`)
    lines.push(`🛡️ Your people remain sworn to you, and a *${WAR_CONFIG.razeShieldHours ?? 72}h* shield guards you while you rebuild.`)
    return ctx.reply(lines.join('\n'))
  }
  return ctx.reply(`🕊️ The war has ended.`)
}

// ── Peace (.war peace) ──────────────────────────────────────────────────────────

async function doPeace(ctx) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  // Withdraw a pending declaration we made (single-sided; defender holds no mirror).
  if (warDeclared(owned) && owned.war.role === 'aggressor') {
    const foeId = owned.war.opponentId
    const foeName = owned.war.opponentName
    const lapsed = warLapsed(owned, now)
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[owned.id]
      if (rec && rec.war?.status === 'declared') rec.war = null
      return player
    })
    if (!lapsed) {
      const foe = getEmpireRecord(ctx.db, foeId)
      if (foe?.ownerId) {
        await pushNotification(ctx.db, foe.ownerId, {
          kind: 'battle',
          title: `🕊️ ${owned.name} withdrew their war`,
          body: `${owned.name} has withdrawn the declaration of war against you.`,
        }).catch(() => {})
      }
    }
    return ctx.reply(`🕊️ You withdraw your declaration of war on *${foeName}*.\n_Your muster is not refunded._`)
  }

  if (!warActive(owned)) {
    return ctx.reply(`🕊️ You are not in a war. There is no peace to sue for.`)
  }

  const foeId = owned.war.opponentId
  const foeName = owned.war.opponentName
  const foe = getEmpireRecord(ctx.db, foeId)
  const foeOwnerId = foe?.ownerId ?? null
  const shieldMs = (WAR_CONFIG.victorShieldHours ?? 6) * HOUR_MS

  // Desync guard: if the enemy is gone or no longer bound to us, the war is over.
  if (!foe || !warActive(foe) || foe.war.opponentId !== owned.id) {
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[owned.id]
      if (rec) { rec.war = null; rec.lastWarAt = now }
      return player
    })
    return ctx.reply(`🕊️ Your enemy is no longer standing to fight. The war is over.`)
  }

  // PEACE IS MUTUAL. Suing for peace alone does NOT stop the war or dodge a raze:
  // it only proposes terms. The war keeps grinding rounds until the enemy ALSO
  // sues for peace, so a winning empire can simply refuse and let the clock raze
  // its foe. Only when BOTH sides have offered do we conclude a bloodless white
  // peace, clearing both mirrors and shielding both, with no empire razed.
  if (foe.war.peaceOffered) {
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[owned.id]
      if (!rec) return player
      applyCollect(rec, now)
      rec.shieldUntil = Math.max(rec.shieldUntil ?? 0, now + shieldMs)
      rec.war = null
      rec.lastWarAt = now
      rec.dormant = false
      rec.lastActiveAt = now
      appendWarLog(rec, { at: now, role: 'peace', vs: foeName, tribute: 0, razed: null })
      return player
    })
    if (foeOwnerId) {
      await updatePlayer(ctx.db, foeOwnerId, player => {
        ensureEmpirePlayer(player)
        const rec = ctx.db.data.empires?.[foeId]
        if (!rec || rec.war?.opponentId !== owned.id) return player
        applyCollect(rec, now)
        rec.shieldUntil = Math.max(rec.shieldUntil ?? 0, now + shieldMs)
        rec.war = null
        rec.lastWarAt = now
        appendWarLog(rec, { at: now, role: 'peace', vs: owned.name, tribute: 0, razed: null })
        return player
      })
      await pushNotification(ctx.db, foeOwnerId, {
        kind: 'battle',
        title: `🕊️ Peace with ${owned.name}`,
        body: `${owned.name} accepted your peace terms. The war between you is over, and neither empire is razed.`,
      }).catch(() => {})
    }
    return ctx.reply(
      `🕊️ *PEACE AGREED*\n${RULE}\n` +
      `*${owned.name}* and *${foeName}* both lay down arms. The war is over, and neither empire is razed.\n` +
      `🛡️ Both sides stand down under a short shield.`
    )
  }

  // First to offer: record the proposal on our own mirror; the war rages on.
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (rec?.war?.status === 'active') { rec.war.peaceOffered = true; rec.war.peaceOfferedAt = now }
    return player
  })
  if (foeOwnerId) {
    await pushNotification(ctx.db, foeOwnerId, {
      kind: 'battle',
      title: `🕊️ ${owned.name} sues for peace`,
      body: `${owned.name} proposes peace. Run ${p}war peace to accept and end it bloodlessly, or fight on to raze them. The war continues until you accept.`,
    }).catch(() => {})
  }
  return ctx.reply(
    `🕊️ *You propose peace to ${foeName}.*\n${RULE}\n` +
    `The offer stands, but the war rages on: it only ends if *${foeName}* also sues for peace.\n` +
    `_Until then, rounds keep resolving and the clock keeps running toward a raze._`
  )
}

/** Appends a capped war-log entry to a record, newest first. Mutates in place. */
function appendWarLog(record, entry) {
  if (!Array.isArray(record.warLog)) record.warLog = []
  record.warLog.unshift(entry)
  const cap = WAR_CONFIG.warLogCap ?? 8
  if (record.warLog.length > cap) record.warLog.length = cap
}

// ── Status (.war status) ────────────────────────────────────────────────────────

async function doStatus(ctx) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  const lines = [`⚔️ *War room: ${owned.name}*`, RULE]

  if (warActive(owned)) {
    const w = owned.war
    lines.push(`🔥 At war with *${w.opponentName}*.`)
    lines.push(`🎯 Rounds: *${w.myWins ?? 0}-${w.theirWins ?? 0}* over *${w.roundsFought ?? 0}* fought.`)
    lines.push(`🩸 Your losses: ${fmtLosses(w.myLosses)}. Their losses: ${fmtLosses(w.theirLosses)}.`)
    lines.push(`⏳ *${hrsLeft(w.endsAt, now)}* left on the war.`)
    const cdMs = (WAR_CONFIG.attackCooldownMinutes ?? 10) * 60 * 1000
    const cdLeft = (w.lastAttackAt ?? 0) + cdMs - now
    lines.push(cdLeft > 0
      ? `⏳ Press the assault again in *${hrsLeft((w.lastAttackAt ?? 0) + cdMs, now)}*, or let rounds resolve on their own.`
      : `✅ Ready to press the assault: *${p}war attack*.`)
    const foe = getEmpireRecord(ctx.db, w.opponentId)
    if (foe?.war?.peaceOffered && !w.peaceOffered) {
      lines.push(`🕊️ *${w.opponentName}* has sued for peace. Run *${p}war peace* to accept and end it bloodlessly.`)
    } else if (w.peaceOffered) {
      lines.push(`🕊️ You have proposed peace. It ends only when *${w.opponentName}* also sues for peace.`)
    }
    lines.push(`💀 Whoever leads when the clock runs out wins. The loser is *razed to their founding*.`)
    lines.push(`_Sue for peace (both sides must agree): *${p}war peace*._`)
    return ctx.reply(lines.join('\n'))
  }

  if (warDeclared(owned)) {
    const foeName = owned.war.opponentName
    if (warLapsed(owned, now)) {
      // Self-clear the stale, single-sided declaration so the owner can move on.
      await updatePlayer(ctx.db, ctx.from, player => {
        ensureEmpirePlayer(player)
        const rec = ctx.db.data.empires?.[owned.id]
        if (rec && rec.war?.status === 'declared' && (rec.war.acceptWindowUntil ?? 0) <= now) rec.war = null
        return player
      })
      lines.push(`⏳ Your declaration against *${foeName}* lapsed unanswered. It has been cleared.`)
    } else {
      lines.push(`📜 Declaration pending against *${foeName}*.`)
      if (owned.war.durationMs) lines.push(`⏳ If accepted it will run *${fmtDuration(owned.war.durationMs)}*.`)
      lines.push(`📩 They have *${hrsLeft(owned.war.acceptWindowUntil, now)}* to accept or decline.`)
      lines.push(`_Withdraw it with *${p}war peace*._`)
    }
    return ctx.reply(lines.join('\n'))
  }

  // No war of our own: surface declarations waiting on us, then recent history.
  const pend = pendingAgainst(ctx.db, owned.id, now)
  if (pend.length) {
    lines.push(`🚨 *Declarations against you:*`)
    for (const r of pend) {
      const dur = r.war?.durationMs ? `, ${fmtDuration(r.war.durationMs)} war` : ''
      lines.push(`• *${r.name}* (${hrsLeft(r.war.acceptWindowUntil, now)} to answer${dur})`)
    }
    lines.push(`_Answer with *${p}war accept <empire>* or *${p}war decline <empire>*._`)
  } else {
    lines.push(`🕊️ You are not at war.`)
    lines.push(`_Open one with *${p}war declare <empire> [time]*._`)
  }

  const log = (owned.warLog ?? []).slice(0, 5)
  if (log.length) {
    lines.push(RULE)
    lines.push(`📜 *Recent wars:*`)
    for (const e of log) lines.push(renderWarLogLine(e, now))
  }
  return ctx.reply(lines.join('\n'))
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default {
  name:           'war',
  aliases:        [],
  category:       'empire',
  requiresPlayer: true,
  description:    'Declare and wage devastating timed war on rival empires',
  subcommands: [
    { cmd: 'declare <empire> [time]', desc: 'open hostilities (30m to 4h) against a rival' },
    { cmd: 'accept [<empire>]', desc: 'accept a declaration made against you' },
    { cmd: 'decline [<empire>]', desc: 'refuse a declaration' },
    { cmd: 'attack', desc: 'press the assault now, pulling the next round forward' },
    { cmd: 'peace', desc: 'sue for peace, or withdraw your declaration' },
    { cmd: 'status', desc: 'your war, or declarations waiting on you' },
  ],

  async run(ctx) {
    const p = config.prefix
    const sub = ctx.args[0]?.toLowerCase()
    const rest = ctx.args.slice(1).join(' ').trim()

    if (sub === 'declare') return doDeclare(ctx, rest)
    if (sub === 'accept') return doAccept(ctx, rest)
    if (sub === 'decline' || sub === 'refuse') return doDecline(ctx, rest)
    if (sub === 'attack' || sub === 'fight' || sub === 'strike') return doAttack(ctx)
    if (sub === 'peace' || sub === 'surrender' || sub === 'withdraw' || sub === 'cancel') return doPeace(ctx)
    if (sub === 'status' || sub === 'info') return doStatus(ctx)

    return ctx.reply(
      `⚔️ *Wage timed war on a rival empire.*\n` +
      `A war runs for a set span (30m to 4h). Whoever leads on rounds when the clock runs out wins, and the loser is *razed to their founding*.\n${RULE}\n` +
      `> *${p}war declare <empire> [time]* to open hostilities\n` +
      `> *${p}war accept* · *${p}war decline* to answer one\n` +
      `> *${p}war attack* to press the assault now\n` +
      `> *${p}war peace* to propose peace (both sides must agree)\n` +
      `> *${p}war status* to see where you stand`
    )
  },
}
