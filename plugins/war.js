/**
 * plugins/war.js — declare and wage war on rival empires.
 *
 *   .war declare <empire>   open hostilities (costs treasury); the target has a
 *                           window to accept or decline
 *   .war accept [<empire>]  accept a declaration made against you
 *   .war decline [<empire>] refuse a declaration; it is withdrawn
 *   .war attack             fight one round of your active war
 *   .war peace              sue for peace (in an active war) or withdraw your
 *                           own pending declaration
 *   .war status             your current war, or declarations waiting on you
 *
 * Phase 4 of the Empire pillar and the DEVASTATING conflict layer, the deliberate
 * counterweight to the light raid in plugins/raid.js. A war is fought over
 * several rounds (first to WAR_CONFIG.roundsToWin), each round bleeding troops
 * far harder than a raid and able to cost a named officer. At the end the victor
 * extracts capped tribute, permanently razes one of the loser's producing
 * buildings, and the loser becomes their vassal for a spell under a long
 * recovery shield. All the math is pure in lib/empire-combat.js.
 *
 * STATE MODEL (no dedicated container, no drift):
 *   - A war lives as a small mirror on record.war. While a declaration is only
 *     'declared' the mirror sits on the AGGRESSOR ALONE, so a lapse or a decline
 *     is a single-sided cleanup that can never desync a defender that was never
 *     touched. The mirror lands on BOTH sides only when it turns 'active', at
 *     accept, and every transition into or out of 'active' is a two-party write
 *     that updates both mirrors in one pass. So the only two-mirror state is
 *     always written atomically as a pair.
 *
 * WRITE SAFETY (the pvpConclude pattern, same as plugins/raid.js):
 *   1. Snapshot BOTH empires read-only and resolve the round into plain locals.
 *   2. Two SEQUENTIAL, never-nested updatePlayer calls. When a round ENDS the
 *      war, the LOSER is written first (it seizes its own tribute into a local
 *      and razes its own building), then the VICTOR (it credits that same
 *      local). When the war continues, order is irrelevant. Each mutator settles
 *      its empire with applyCollect BEFORE touching anything rate-bearing.
 *   3. After BOTH writes settle, exactly ONE pushNotification to the party that
 *      is NOT in this chat, outside every mutator and .catch guarded. Never a
 *      loop over members, never a group broadcast, never a DM fan-out.
 * Nothing here mints gems, and nothing reads or writes a player's baseStats.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { pushNotification } from '../lib/notification-repo.js'
import {
  ensureEmpiresInitialized, getOwnedEmpire, findEmpireByQuery, getEmpireRecord, ensureEmpirePlayer,
  sweepEmpireLifecycle, empireNeedsSweep,
} from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, WAR_CONFIG, HOUR_MS, DAY_MS, applyCollect, previewCollect,
  buildingDefMap, armyPower, tierOf, generalBonusOf, removeLowestOfficer, isVassal,
} from '../lib/empire-engine.js'
import { characterLabel } from '../lib/empire-abilities.js'
import { buildSnapshot, weightMatchOk, resolveWarRound, resolveWarSpoils } from '../lib/empire-combat.js'

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

/** Appends a capped war-log entry to a record, newest first. Mutates in place. */
function appendWarLog(record, entry) {
  if (!Array.isArray(record.warLog)) record.warLog = []
  record.warLog.unshift(entry)
  const cap = WAR_CONFIG.warLogCap ?? 8
  if (record.warLog.length > cap) record.warLog.length = cap
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

/** Enabled-check + init + owned lookup, replying and returning null when blocked. */
async function gateOwned(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) { await ctx.reply(disabledMsg(p)); return null }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  // Age abandoned empires on the war path too, so a dormant/succeeded target is
  // resolved before any declaration reads it. The caller's own empire is spared.
  const nowSweep = Date.now()
  if (empireNeedsSweep(ctx.db, nowSweep, ctx.from)) await sweepEmpireLifecycle(ctx.db, nowSweep, ctx.from)
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) { await ctx.reply(noEmpire(p)); return null }
  return owned
}

// ── Declare (.war declare <empire>) ────────────────────────────────────────────

async function doDeclare(ctx, query) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  if (isVassal(owned, now)) {
    return ctx.reply(
      `⛓️ You are a vassal of *${owned.vassalOfName ?? 'another empire'}* for *${hrsLeft(owned.vassalUntil, now)}* more.\n` +
      `_A vassal cannot declare war until they are free._`
    )
  }
  if (warActive(owned)) {
    return ctx.reply(`⚔️ You are already at war with *${owned.war.opponentName}*. See *${p}war status*.`)
  }
  if (warDeclared(owned) && !warLapsed(owned, now)) {
    return ctx.reply(
      `📜 You already have a declaration pending against *${owned.war.opponentName}*.\n` +
      `_Withdraw it with *${p}war peace* before declaring on someone else._`
    )
  }
  if (!query) return ctx.reply(`⚔️ *Declare war on whom?* Try *${p}war declare <empire>*.`)

  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`⚔️ No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (target.id === owned.id) return ctx.reply(`⚔️ You cannot declare war on your own empire.`)
  if (!target.ownerId) return ctx.reply(`⚔️ *${target.name}* has no ruler to answer a declaration.`)
  if (target.dormant) return ctx.reply(`💤 *${target.name}* lies dormant. There is no one there to fight.`)

  // Only once the target is a legal one do we check that you can actually march.
  if (armyPower(owned) <= 0) {
    return ctx.reply(`⚔️ You have no army to march. Recruit troops first with *${p}recruit <n>*.`)
  }
  if (warActive(target)) return ctx.reply(`⚔️ *${target.name}* is already locked in a war. Wait until it ends.`)
  if (isVassal(target, now)) {
    return ctx.reply(`⛓️ *${target.name}* is a vassal of *${target.vassalOfName ?? 'another empire'}* and under their protection.`)
  }
  if ((target.shieldUntil ?? 0) > now) {
    return ctx.reply(`🛡️ *${target.name}* is under a recovery shield for *${hrsLeft(target.shieldUntil, now)}*. You cannot declare on them yet.`)
  }

  const atkSnap = buildSnapshot(owned, { generalBonus: generalBonusOf(owned) })
  const defSnap = buildSnapshot(target, { generalBonus: generalBonusOf(target) })
  if (!weightMatchOk(atkSnap, defSnap, WAR_CONFIG.weightFloorPct ?? 0.5)) {
    return ctx.reply(
      `⚖️ *${target.name}* is far weaker than you. Your court will not sanction so lopsided a war.\n` +
      `_Wars are weight matched. Choose a rival closer to your own might._`
    )
  }

  // Affordability against the settled treasury, so heavy upkeep can't leave the
  // declaration paid for at a floored zero.
  const cost = WAR_CONFIG.declareCostSolars ?? 0
  const settled = previewCollect(owned, now).treasuryAfter
  if (settled < cost) {
    return ctx.reply(
      `💰 Declaring war musters the army for *${cost.toLocaleString()} solars*.\n` +
      `Your treasury holds *${Math.max(0, Math.floor(settled)).toLocaleString()}* after upkeep. Build up your coffers first.`
    )
  }

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
      myWins: 0, theirWins: 0,
      declaredAt: now, acceptWindowUntil: acceptUntil,
      startedAt: null, lastAttackAt: null,
    }
    rec.lastActiveAt = now
    return player
  })

  await pushNotification(ctx.db, targetOwnerId, {
    kind: 'battle',
    title: `⚔️ ${owned.name} declared war`,
    body: `${owned.name} has declared war on you. You have ${hrsLeft(acceptUntil, now)} to *${p}war accept* or *${p}war decline*.`
      + ` Ignore it and the declaration lapses.`,
  }).catch(() => {})

  return ctx.reply(
    `⚔️📜 *WAR DECLARED*\n${RULE}\n` +
    `*${owned.name}* has declared war on *${targetName}*.\n` +
    `💰 Mustering the army cost *${cost.toLocaleString()} solars*.\n` +
    `⏳ They have *${hrsLeft(acceptUntil, now)}* to accept or decline. If they let it lapse, the war is off and your muster is spent.\n` +
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

  const aggressor = await pickPending(ctx, owned, query, 'accept')
  if (!aggressor) return

  const aggId = aggressor.id
  const aggName = aggressor.name
  const aggOwnerId = aggressor.ownerId
  const declaredAt = aggressor.war?.declaredAt ?? now

  // Aggressor first, then defender. No value crosses between them here, so the
  // order is only for readability; both mirrors land 'active' in this one pair.
  await updatePlayer(ctx.db, aggOwnerId, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[aggId]
    if (!rec || rec.war?.status !== 'declared' || rec.war.opponentId !== owned.id) return player
    applyCollect(rec, now)
    rec.dormant = false
    rec.war.status = 'active'
    rec.war.myWins = 0
    rec.war.theirWins = 0
    rec.war.startedAt = now
    rec.war.acceptWindowUntil = null
    rec.war.lastAttackAt = null
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
      myWins: 0, theirWins: 0,
      declaredAt, acceptWindowUntil: null,
      startedAt: now, lastAttackAt: null,
    }
    rec.lastActiveAt = now
    return player
  })

  await pushNotification(ctx.db, aggOwnerId, {
    kind: 'battle',
    title: `⚔️ ${owned.name} accepted your war`,
    body: `${owned.name} answered your declaration. The war has begun. Strike with ${p}war attack.`,
  }).catch(() => {})

  return ctx.reply(
    `⚔️🔥 *WAR BEGUN*\n${RULE}\n` +
    `*${owned.name}* accepts the war with *${aggName}*.\n` +
    `First to *${WAR_CONFIG.roundsToWin ?? 3}* rounds wins it all.\n` +
    `> *${p}war attack* to fight a round\n` +
    `> *${p}war status* to see the tally`
  )
}

async function doDecline(ctx, query) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

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

  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  if (!owned.war) {
    return ctx.reply(`⚔️ You are not at war. Open one with *${p}war declare <empire>*.`)
  }
  if (warDeclared(owned)) {
    return warLapsed(owned, now)
      ? ctx.reply(`⏳ Your declaration against *${owned.war.opponentName}* lapsed unanswered. Run *${p}war status* to clear it, then declare again.`)
      : ctx.reply(`📜 *${owned.war.opponentName}* has not accepted your declaration yet. You cannot strike until they do.`)
  }

  const cdMs = (WAR_CONFIG.attackCooldownHours ?? 3) * HOUR_MS
  if ((owned.war.lastAttackAt ?? 0) + cdMs > now) {
    return ctx.reply(`⏳ Your soldiers are regrouping. Strike again in *${hrsLeft((owned.war.lastAttackAt ?? 0) + cdMs, now)}*.`)
  }
  if (armyPower(owned) <= 0) {
    return ctx.reply(`⚔️ Your army is spent. Recruit and train before you can press the war.`)
  }

  const target = getEmpireRecord(ctx.db, owned.war.opponentId)
  if (!target || !target.ownerId || !warActive(target) || target.war.opponentId !== owned.id) {
    // The opponent fell apart (sold, dissolved, or desynced). Clear our side.
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[owned.id]
      if (rec) { rec.war = null; rec.lastWarAt = now }
      return player
    })
    return ctx.reply(`🕊️ Your enemy is no longer standing to fight. The war is over.`)
  }

  const callerSnap = buildSnapshot(owned, { generalBonus: generalBonusOf(owned) })
  const oppSnap = buildSnapshot(target, { generalBonus: generalBonusOf(target) })
  const plan = resolveWarRound(callerSnap, oppSnap, Math.random, now)

  const need = WAR_CONFIG.roundsToWin ?? 3
  const callerWins = plan.attackerWins
  const newCallerWins = (owned.war.myWins ?? 0) + (callerWins ? 1 : 0)
  const newOppWins = (owned.war.theirWins ?? 0) + (callerWins ? 0 : 1)
  const warEnds = newCallerWins >= need || newOppWins >= need
  const callerIsVictor = newCallerWins >= need

  // Spoils are computed once, from the final snapshots, only when the war ends.
  const spoils = warEnds
    ? (callerIsVictor
        ? resolveWarSpoils(callerSnap, oppSnap, Math.random)
        : resolveWarSpoils(oppSnap, callerSnap, Math.random))
    : { tribute: 0, razed: null }

  const callerId = owned.id
  const callerName = owned.name
  const oppId = target.id
  const oppName = target.name
  const oppOwnerId = target.ownerId

  let tributeTaken = 0
  let razedName = ''
  let callerOfficerLost = ''
  let oppOfficerLost = ''

  // Settle books to the war moment, then apply this side's round casualties.
  const bleed = (rec, losses, officerFlag) => {
    applyCollect(rec, now)
    rec.dormant = false
    rec.army.levies.recruit = Math.max(0, (rec.army.levies.recruit ?? 0) - (losses.recruit ?? 0))
    rec.army.levies.soldier = Math.max(0, (rec.army.levies.soldier ?? 0) - (losses.soldier ?? 0))
    let lost = ''
    if (officerFlag) { const g = removeLowestOfficer(rec); if (g) lost = g.name }
    rec.lastActiveAt = now
    return lost
  }
  // The war loser seizes its OWN tribute into the shared local and razes its own
  // building, so the victor write that follows can credit the exact same figure.
  const finishLoser = (rec, lordId, lordName) => {
    tributeTaken = Math.max(0, Math.min(spoils.tribute, Math.max(0, rec.treasury)))
    rec.treasury = Math.max(0, rec.treasury - tributeTaken)
    if (spoils.razed) {
      const bi = rec.buildings.findIndex(b => b.type === spoils.razed)
      if (bi >= 0) { rec.buildings.splice(bi, 1); razedName = buildingDefMap[spoils.razed]?.name ?? spoils.razed }
      rec.assignments.workers = (rec.assignments?.workers ?? []).filter(a => a.buildingType !== spoils.razed)
    }
    rec.shieldUntil = Math.max(rec.shieldUntil ?? 0, now + (WAR_CONFIG.loserShieldHours ?? 48) * HOUR_MS)
    rec.vassalOf = lordId
    rec.vassalOfName = lordName
    rec.vassalUntil = now + (WAR_CONFIG.vassalDays ?? 14) * DAY_MS
    rec.war = null
    rec.lastWarAt = now
    appendWarLog(rec, { at: now, role: 'loss', vs: lordName, tribute: tributeTaken, razed: razedName || null })
  }
  const finishVictor = (rec, foeName) => {
    rec.treasury += tributeTaken
    rec.shieldUntil = Math.max(rec.shieldUntil ?? 0, now + (WAR_CONFIG.victorShieldHours ?? 6) * HOUR_MS)
    rec.war = null
    rec.lastWarAt = now
    appendWarLog(rec, { at: now, role: 'win', vs: foeName, tribute: tributeTaken, razed: razedName || null })
  }

  if (!warEnds) {
    // War continues: order is irrelevant. Opponent first, then caller.
    await updatePlayer(ctx.db, oppOwnerId, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[oppId]
      if (!rec) return player
      oppOfficerLost = bleed(rec, plan.defenderLosses, plan.defenderOfficerLost)
      if (rec.war && rec.war.status === 'active') { rec.war.myWins = newOppWins; rec.war.theirWins = newCallerWins }
      return player
    })
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[callerId]
      if (!rec) return player
      callerOfficerLost = bleed(rec, plan.attackerLosses, plan.attackerOfficerLost)
      if (rec.war && rec.war.status === 'active') { rec.war.myWins = newCallerWins; rec.war.theirWins = newOppWins; rec.war.lastAttackAt = now }
      return player
    })
  } else if (callerIsVictor) {
    // Loser is the opponent. Write the loser FIRST so tribute is real.
    await updatePlayer(ctx.db, oppOwnerId, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[oppId]
      if (!rec) return player
      oppOfficerLost = bleed(rec, plan.defenderLosses, plan.defenderOfficerLost)
      finishLoser(rec, callerId, callerName)
      return player
    })
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[callerId]
      if (!rec) return player
      callerOfficerLost = bleed(rec, plan.attackerLosses, plan.attackerOfficerLost)
      finishVictor(rec, oppName)
      return player
    })
  } else {
    // Loser is the caller. Write the caller (loser) FIRST.
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[callerId]
      if (!rec) return player
      callerOfficerLost = bleed(rec, plan.attackerLosses, plan.attackerOfficerLost)
      finishLoser(rec, oppId, oppName)
      return player
    })
    await updatePlayer(ctx.db, oppOwnerId, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[oppId]
      if (!rec) return player
      oppOfficerLost = bleed(rec, plan.defenderLosses, plan.defenderOfficerLost)
      finishVictor(rec, callerName)
      return player
    })
  }

  // ── One notification to the opponent (never the in-chat caller).
  const oppScore = `${newOppWins}-${newCallerWins}`
  let note
  if (!warEnds) {
    note = callerWins
      ? {
          kind: 'battle',
          title: `⚔️ ${callerName} won a war round`,
          body: `${callerName} took a round against you. The war stands ${oppScore}. Answer with ${p}war attack.`,
        }
      : {
          kind: 'battle',
          title: `🛡️ You won a war round`,
          body: `You repelled ${callerName}'s assault and took the round. The war stands ${oppScore} in your favor.`,
        }
  } else if (callerIsVictor) {
    note = {
      kind: 'battle',
      title: `💀 ${callerName} won the war`,
      body: `${callerName} has defeated you`
        + (tributeTaken ? `, taking ${tributeTaken.toLocaleString()} solars in tribute` : '')
        + (razedName ? ` and razing your ${razedName}` : '')
        + `. You are their vassal for ${WAR_CONFIG.vassalDays ?? 14} days, shielded while you rebuild.`,
    }
  } else {
    note = {
      kind: 'battle',
      title: `🏆 You won the war against ${callerName}`,
      body: `You broke ${callerName}`
        + (tributeTaken ? ` and extracted ${tributeTaken.toLocaleString()} solars in tribute` : '')
        + (razedName ? `, razing their ${razedName}` : '')
        + `. They are now your vassal.`,
    }
  }
  await pushNotification(ctx.db, oppOwnerId, note).catch(() => {})

  // ── Battle report to the caller, in-chat.
  const lines = []
  if (warEnds) {
    lines.push(callerIsVictor ? `🏆🔥 *WAR WON!* 🔥🏆` : `💀 *WAR LOST* 💀`)
    lines.push(RULE)
    lines.push(callerIsVictor
      ? `*${callerName}* has crushed *${oppName}* in the field.`
      : `*${oppName}* has broken *${callerName}*. The war is lost.`)
    lines.push(`🎯 Final tally: *${newCallerWins}-${newOppWins}*.`)
    if (callerIsVictor) {
      if (tributeTaken) lines.push(`💰 Tribute seized: *${tributeTaken.toLocaleString()} solars*.`)
      if (razedName) lines.push(`🔥 You razed their *${razedName}* to the ground. It is gone for good.`)
      lines.push(`⛓️ *${oppName}* is now your vassal for *${WAR_CONFIG.vassalDays ?? 14} days*.`)
      lines.push(`🛡️ Your battered army rests under a *${WAR_CONFIG.victorShieldHours ?? 6}h* shield.`)
    } else {
      if (tributeTaken) lines.push(`💸 Tribute paid: *${tributeTaken.toLocaleString()} solars*.`)
      if (razedName) lines.push(`🔥 Your *${razedName}* was razed. It is gone for good.`)
      lines.push(`⛓️ You are now a vassal of *${oppName}* for *${WAR_CONFIG.vassalDays ?? 14} days*.`)
      lines.push(`🛡️ A *${WAR_CONFIG.loserShieldHours ?? 48}h* recovery shield shelters you while you rebuild.`)
    }
  } else {
    lines.push(callerWins ? `⚔️ *ROUND WON*` : `🛡️ *ROUND LOST*`)
    lines.push(RULE)
    lines.push(callerWins
      ? `*${callerName}* took the round from *${oppName}*.`
      : `*${oppName}* held the field this round.`)
    lines.push(`🎯 The war stands *${newCallerWins}-${newOppWins}*, first to *${need}*.`)
  }
  lines.push('')
  lines.push(`⚔️ Effective power: you *${plan.aEff.toLocaleString()}*  vs  them *${plan.dEff.toLocaleString()}*`)
  const atkGeneral = owned.assignments?.generals?.[0]
  if (atkGeneral) lines.push(`🎖️ ${characterLabel(atkGeneral.charId)} led your charge.`)
  const defGeneral = target.assignments?.generals?.[0]
  if (defGeneral) lines.push(`🎖️ ${characterLabel(defGeneral.charId)} led their defense.`)
  lines.push(`🩸 Your losses: ${fmtLosses(plan.attackerLosses)}${callerOfficerLost ? `, and ${callerOfficerLost} fell` : ''}.`)
  lines.push(`🩸 Their losses: ${fmtLosses(plan.defenderLosses)}${oppOfficerLost ? `, and ${oppOfficerLost} fell` : ''}.`)
  if (!warEnds) lines.push(`⏳ Regroup, then strike again in *${WAR_CONFIG.attackCooldownHours ?? 3}h*.`)
  return ctx.reply(lines.join('\n'))
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
  const penalty = WAR_CONFIG.peaceCostSolars ?? 0
  const shieldMs = (WAR_CONFIG.victorShieldHours ?? 6) * HOUR_MS
  let paid = 0

  // Two-party write clears BOTH mirrors and shields both sides. The suer pays a
  // reparation that is BURNED, not transferred, so no value crosses hands here.
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) return player
    applyCollect(rec, now)
    paid = Math.max(0, Math.min(penalty, Math.max(0, rec.treasury)))
    rec.treasury = Math.max(0, rec.treasury - paid)
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
      title: `🕊️ ${owned.name} sued for peace`,
      body: `${owned.name} has sued for peace. The war between you is over.`,
    }).catch(() => {})
  }

  return ctx.reply(
    `🕊️ *PEACE*\n${RULE}\n` +
    `*${owned.name}* sues for peace with *${foeName}*. The war is over.\n` +
    (paid ? `💸 Reparations of *${paid.toLocaleString()} solars* were paid to end it.\n` : '') +
    `🛡️ Both sides stand down under a short shield.`
  )
}

// ── Status (.war status) ────────────────────────────────────────────────────────

async function doStatus(ctx) {
  const p = config.prefix
  const owned = await gateOwned(ctx)
  if (!owned) return
  const now = Date.now()

  const lines = [`⚔️ *War room: ${owned.name}*`, RULE]

  if (isVassal(owned, now)) {
    lines.push(`⛓️ You are a *vassal* of *${owned.vassalOfName ?? 'another empire'}* for *${hrsLeft(owned.vassalUntil, now)}* more.`)
    lines.push(`_A vassal cannot declare war until freed._`)
    lines.push(RULE)
  }

  if (warActive(owned)) {
    const need = WAR_CONFIG.roundsToWin ?? 3
    lines.push(`🔥 At war with *${owned.war.opponentName}*.`)
    lines.push(`🎯 Rounds: *${owned.war.myWins ?? 0}-${owned.war.theirWins ?? 0}*, first to *${need}*.`)
    const cdMs = (WAR_CONFIG.attackCooldownHours ?? 3) * HOUR_MS
    const cdLeft = (owned.war.lastAttackAt ?? 0) + cdMs - now
    lines.push(cdLeft > 0
      ? `⏳ Next strike in *${hrsLeft((owned.war.lastAttackAt ?? 0) + cdMs, now)}*.`
      : `✅ Ready to strike: *${p}war attack*.`)
    lines.push(`_Or end it early with *${p}war peace*._`)
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
      lines.push(`⏳ They have *${hrsLeft(owned.war.acceptWindowUntil, now)}* to accept or decline.`)
      lines.push(`_Withdraw it with *${p}war peace*._`)
    }
    return ctx.reply(lines.join('\n'))
  }

  // No war of our own: surface declarations waiting on us, then recent history.
  const pend = pendingAgainst(ctx.db, owned.id, now)
  if (pend.length) {
    lines.push(`🚨 *Declarations against you:*`)
    for (const r of pend) lines.push(`• *${r.name}* (${hrsLeft(r.war.acceptWindowUntil, now)} to answer)`)
    lines.push(`_Answer with *${p}war accept <empire>* or *${p}war decline <empire>*._`)
  } else {
    lines.push(`🕊️ You are not at war.`)
    lines.push(`_Open one with *${p}war declare <empire>*._`)
  }

  const log = (owned.warLog ?? []).slice(0, 5)
  if (log.length) {
    lines.push(RULE)
    lines.push(`📜 *Recent wars:*`)
    for (const e of log) {
      const ago = `${Math.max(1, Math.ceil((now - (e.at ?? now)) / HOUR_MS))}h ago`
      if (e.role === 'win') lines.push(`🏆 Beat *${e.vs}*${e.tribute ? `, took ${e.tribute.toLocaleString()} solars` : ''}. _${ago}_`)
      else if (e.role === 'loss') lines.push(`💀 Lost to *${e.vs}*${e.tribute ? `, paid ${e.tribute.toLocaleString()} solars` : ''}. _${ago}_`)
      else lines.push(`🕊️ Peace with *${e.vs}*. _${ago}_`)
    }
  }
  return ctx.reply(lines.join('\n'))
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default {
  name:           'war',
  aliases:        [],
  category:       'empire',
  requiresPlayer: true,
  description:    'Declare and wage devastating war on rival empires',
  subcommands: [
    { cmd: 'declare <empire>', desc: 'open hostilities against a rival' },
    { cmd: 'accept [<empire>]', desc: 'accept a declaration made against you' },
    { cmd: 'decline [<empire>]', desc: 'refuse a declaration' },
    { cmd: 'attack', desc: 'fight one round of your active war' },
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
      `⚔️ *Wage war on a rival empire.*\n` +
      `Wars are devastating: the loser pays tribute, has a building razed, and becomes a vassal.\n${RULE}\n` +
      `> *${p}war declare <empire>* to open hostilities\n` +
      `> *${p}war accept* · *${p}war decline* to answer one\n` +
      `> *${p}war attack* to fight a round\n` +
      `> *${p}war peace* to end it\n` +
      `> *${p}war status* to see where you stand`
    )
  },
}
