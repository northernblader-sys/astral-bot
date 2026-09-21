/**
 * plugins/raid.js — scout and lay timed sieges on rival empires.
 *
 *   .raid scout <empire>   fuzzy, noised intel on a target  (alias .spy <empire>)
 *   .raid <empire>         LAY SIEGE: a timed campaign resolved in assaults over
 *                          real time, not one instant clash
 *   .raid status           the live front of your siege (or one pressing you):
 *                          time left, assaults, losses so far, plunder secured
 *   .raid log              your empire's recent sieges
 *   .raid shield           your shield and troop-deploy standing
 *
 * Phase 3 of the Empire pillar, reworked into the TIMED conflict layer. A raid is
 * no longer a single dice roll: laying siege commits your army for a span
 * (RAID_CONFIG.siegeTicks assaults, one every siegeTickMinutes), and each assault
 * is resolved on read by the settle-on-read engine in lib/empire-repo.js. Between
 * assaults either side can poll the front with *.raid status* and watch the
 * losses mount. All the per-tick math is pure in lib/empire-combat.js.
 *
 * NO SCHEDULER: nothing here runs on a timer. Every command first advances any
 * conflict that has come due (settleEmpireConflicts, gated by the cheap
 * conflictsNeedSettle read), so simply checking the front is what moves it. A
 * siege lives ONLY on the attacker's record (record.siege); the defender learns
 * it is besieged by scanning for it (siegeAgainst), with no second mirror to drift.
 *
 * WRITE SAFETY:
 *   - Laying siege is ONE updatePlayer write on the attacker that stamps
 *     record.siege and commits the army; the defender is not written, only
 *     notified once (pushNotification, outside every mutator, .catch guarded).
 *   - Every assault, every casualty and every conclusion is applied by the repo
 *     inside its single settleEmpireConflicts pass, never here. Notifications on
 *     conclusion are pushed one owner at a time by the repo: never a loop over
 *     members, never a group broadcast, never a DM fan-out.
 * Nothing here mints gems, and nothing reads or writes a player's baseStats.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { pushNotification } from '../lib/notification-repo.js'
import {
  ensureEmpiresInitialized, getOwnedEmpire, findEmpireByQuery, ensureEmpirePlayer,
  settleEmpireConflicts, conflictsNeedSettle, siegeAgainst,
} from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, RAID_CONFIG, HOUR_MS, applyCollect,
  armyPower, tierOf, conflictPowerBonus, lootableTreasury, fmtDuration,
} from '../lib/empire-engine.js'
import { buildSnapshot, weightMatchOk, scoutReport } from '../lib/empire-combat.js'

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
  return parts.length ? parts.join(', ') : 'no one'
}

/**
 * Advance any conflict that has come due before reading empire state, so every
 * raid command sees a front that is current to this moment. Cheap-gated: the
 * write queue is only taken when conflictsNeedSettle finds genuine work.
 */
async function settleConflicts(ctx, now) {
  if (conflictsNeedSettle(ctx.db, now)) await settleEmpireConflicts(ctx.db, now)
}

// ── Scout (.raid scout / .spy) ────────────────────────────────────────────────

async function doScout(ctx, query) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const now = Date.now()
  await settleConflicts(ctx, now)

  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  if (!query) return ctx.reply(`🔎 *Scout whom?* Try *${p}raid scout <empire>* or *${p}spy <empire>*.`)

  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`🔎 No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (target.id === owned.id) return ctx.reply(`🔎 That's your own empire. Scout a rival instead.`)

  // Conflict-power lifts POWER only, on both sides, and the defender gets its
  // walls (watchtower), so a scout shows the same strength a siege resolves on.
  const atkSnap = buildSnapshot(owned, { generalBonus: conflictPowerBonus(owned, { defending: false }) })
  const defSnap = buildSnapshot(target, { generalBonus: conflictPowerBonus(target, { defending: true }) })
  const r = scoutReport(atkSnap, defSnap, Math.random, now)

  const lines = [`🔎 *Scouting ${target.name}*`, RULE]
  lines.push(`🏰 Tier: *${tierOf(target).name}*`)
  lines.push(`⚔️ Army looks like *${r.armyBand}*.`)
  lines.push(`👥 Garrison: *${r.headcountBand}*.`)
  lines.push(`💰 Coffers: *${r.treasuryBand}*.`)
  lines.push(RULE)
  const beingSieged = siegeAgainst(ctx.db, target.id, now)
  if (r.shielded) {
    lines.push(`🛡️ They are under a recovery *shield*. You cannot besiege them yet.`)
  } else if (target.war?.status === 'active') {
    lines.push(`⚔️ They are locked in a *war* right now. You cannot besiege them until it ends.`)
  } else if (beingSieged) {
    lines.push(`🏰 They are *already under siege* by *${beingSieged.name}*. Only one besieger at a time.`)
  } else if (!r.weightLegal) {
    lines.push(`⚖️ Too small a target. Besieging them would be a stomp, and your officers refuse.`)
  } else {
    lines.push(`✅ A siege is possible.${r.deployed ? ' Their troops are *deployed elsewhere* right now, so their walls are thin.' : ''}`)
    lines.push(`> *${p}raid ${target.name}*`)
  }
  lines.push(`\n_Scouts report in rough figures. Numbers are never exact._`)
  return ctx.reply(lines.join('\n'))
}

// ── Lay siege (.raid <empire>) ────────────────────────────────────────────────

async function doSiege(ctx, query) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }

  // A player mid-duel or in a dungeon can't also march an army out to a siege.
  if (ctx.player?.inBattle) return ctx.reply(`⚔️ Finish your current battle before you march an army out.`)
  if (ctx.player?.inDungeon) return ctx.reply(`🗺️ You can't lay siege from inside a dungeon.`)

  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const now = Date.now()
  await settleConflicts(ctx, now)

  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  if (!query) return ctx.reply(`⚔️ *Besiege whom?* Scout first with *${p}raid scout <empire>*, then *${p}raid <empire>*.`)

  // Attacker gates.
  if (owned.siege?.status === 'active') {
    return ctx.reply(`🏰 You are already besieging *${owned.siege.targetName}*. Watch it with *${p}raid status*.`)
  }
  if (owned.war?.status === 'active') {
    return ctx.reply(`⚔️ You are at war. See it through before you send troops off to a siege.`)
  }
  if ((owned.deployedUntil ?? 0) > now) {
    return ctx.reply(`⚔️ Your troops are already deployed (*${hrsLeft(owned.deployedUntil, now)}* left). One campaign at a time.`)
  }
  const cdMs = (RAID_CONFIG.siegeCooldownHours ?? 3) * HOUR_MS
  if ((owned.lastRaidAt ?? 0) + cdMs > now) {
    return ctx.reply(`⏳ Your soldiers are still recovering from the last campaign. March again in *${hrsLeft((owned.lastRaidAt ?? 0) + cdMs, now)}*.`)
  }
  if (armyPower(owned) <= 0) {
    return ctx.reply(`⚔️ You have no army to march. Recruit troops first with *${p}recruit <n>*.`)
  }

  // Target gates.
  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`⚔️ No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (target.id === owned.id) return ctx.reply(`⚔️ You cannot besiege your own empire.`)
  if (!target.ownerId) return ctx.reply(`⚔️ *${target.name}* has no ruler to answer for it.`)
  if ((target.shieldUntil ?? 0) > now) {
    return ctx.reply(`🛡️ *${target.name}* is under a recovery shield for *${hrsLeft(target.shieldUntil, now)}*. Pick another target.`)
  }
  if (target.war?.status === 'active') {
    return ctx.reply(`⚔️ *${target.name}* is already locked in a war. You cannot besiege them until it ends.`)
  }
  const existing = siegeAgainst(ctx.db, target.id, now)
  if (existing) {
    return ctx.reply(`🏰 *${target.name}* is already under siege by *${existing.name}*. Only one besieger at a time.`)
  }

  const atkSnap = buildSnapshot(owned, { generalBonus: conflictPowerBonus(owned, { defending: false }) })
  const defSnap = buildSnapshot(target, { generalBonus: conflictPowerBonus(target, { defending: true }) })
  if (!weightMatchOk(atkSnap, defSnap)) {
    return ctx.reply(
      `⚖️ *${target.name}* is far weaker than you. Your officers refuse to lead a stomp.\n` +
      `_Sieges are weight matched. Find a rival closer to your own strength._`
    )
  }

  // Shape the campaign. Loot per assault is a slice of the target's LOOTABLE
  // treasury (the vault's protected share is off the table), spread across the
  // ticks; the repo re-clamps to what is actually there when the siege ends.
  const ticks = Math.max(1, Math.floor(Number(RAID_CONFIG.siegeTicks) || 6))
  const tickMs = Math.max(60000, Math.floor((Number(RAID_CONFIG.siegeTickMinutes) || 15) * 60 * 1000))
  const totalMs = ticks * tickMs
  const lootPool = Math.max(0, Math.floor(Math.min(lootableTreasury(target) * (RAID_CONFIG.lootTreasuryPct ?? 0.15), RAID_CONFIG.lootHardCap ?? Infinity)))
  const lootPerTick = Math.max(0, Math.floor(lootPool / ticks))
  const targetId = target.id
  const targetName = target.name
  const targetOwnerId = target.ownerId
  const atkId = owned.id
  const atkName = owned.name

  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[atkId]
    if (!rec) return player
    applyCollect(rec, now)
    rec.siege = {
      status: 'active',
      targetId, targetName,
      startedAt: now,
      endsAt: now + totalMs,
      nextTickAt: now + tickMs,
      tickMs,
      ticksTotal: ticks,
      ticksDone: 0,
      attackerTickWins: 0,
      defenderTickWins: 0,
      loot: 0,
      lootPerTick,
      attackerLosses: { recruit: 0, soldier: 0 },
      defenderLosses: { recruit: 0, soldier: 0 },
      log: [],
    }
    rec.deployedUntil = now + totalMs
    rec.lastRaidAt = now
    rec.lastActiveAt = now
    return player
  })

  // One inbox note to the defender: their walls are under siege. Never a fan-out.
  await pushNotification(ctx.db, targetOwnerId, {
    kind: 'empire',
    title: `🏰 ${targetName} is under siege`,
    body: `*${atkName}* has laid siege to your walls. It will grind on for about ${fmtDuration(totalMs)} across ${ticks} assaults. Watch the front with ${p}raid status.`,
  }).catch(() => {})

  const lines = [`⚔️🏰 *SIEGE LAUNCHED* 🏰⚔️`, RULE]
  lines.push(`*${atkName}* marches on *${targetName}*.`)
  lines.push('')
  lines.push(`⏳ The siege grinds on for *${fmtDuration(totalMs)}*, an assault about every *${Math.round(tickMs / 60000)}m* across *${ticks} assaults*.`)
  lines.push(`💰 Up to *${lootPool.toLocaleString()} solars* can be carried off if your assaults break through.`)
  lines.push(`⚔️ Opening strength: you *${atkSnap.power.toLocaleString()}*  vs  them *${defSnap.power.toLocaleString()}*.`)
  lines.push('')
  lines.push(`⏳ Your army is committed until the siege ends, and your own walls are thin while it is away.`)
  lines.push(`> Watch it unfold with *${p}raid status*.`)
  return ctx.reply(lines.join('\n'))
}

// ── Status (.raid status) ─────────────────────────────────────────────────────

async function doSiegeStatus(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const now = Date.now()
  await settleConflicts(ctx, now)

  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const lines = [`🏰 *War front: ${owned.name}*`, RULE]
  let any = false

  // Outgoing: we are the besieger.
  const sg = owned.siege
  if (sg?.status === 'active') {
    any = true
    lines.push(`⚔️ *Your siege of ${sg.targetName}*`)
    lines.push(`⏳ Time left: *${hrsLeft(sg.endsAt, now)}*  ·  assaults *${sg.ticksDone}/${sg.ticksTotal}*`)
    lines.push(`🗡️ Assaults won: you *${sg.attackerTickWins}* · them *${sg.defenderTickWins}*`)
    lines.push(`🩸 Your losses: ${fmtLosses(sg.attackerLosses)}. Their losses: ${fmtLosses(sg.defenderLosses)}.`)
    lines.push(`💰 Plunder secured so far: *${Math.floor(sg.loot ?? 0).toLocaleString()} solars* (paid out only if you win).`)
    const recent = (sg.log ?? []).slice(0, 3)
    if (recent.length) {
      lines.push(`_Recent assaults:_`)
      for (const e of recent) {
        lines.push(`  ${e.attackerWon ? '🗡️ pressed the walls' : '🛡️ thrown back'} · you lost ${e.aLoss}, them ${e.dLoss}`)
      }
    }
    lines.push(RULE)
  }

  // Incoming: someone is besieging us. The siege lives on THEIR record, so from
  // our seat their attackerTickWins are assaults against us.
  const inc = siegeAgainst(ctx.db, owned.id, now)
  if (inc?.siege?.status === 'active') {
    any = true
    const s = inc.siege
    lines.push(`🛡️ *Under siege by ${inc.name}*`)
    lines.push(`⏳ Time left: *${hrsLeft(s.endsAt, now)}*  ·  assaults *${s.ticksDone}/${s.ticksTotal}*`)
    lines.push(`🗡️ Assaults won: them *${s.attackerTickWins}* · you *${s.defenderTickWins}*`)
    lines.push(`🩸 Your losses: ${fmtLosses(s.defenderLosses)}. Their losses: ${fmtLosses(s.attackerLosses)}.`)
    lines.push(`💰 At risk if the walls fall: up to *${Math.floor(s.loot ?? 0).toLocaleString()} solars* carried off so far.`)
    const recent = (s.log ?? []).slice(0, 3)
    if (recent.length) {
      lines.push(`_Recent assaults:_`)
      for (const e of recent) {
        lines.push(`  ${e.attackerWon ? '🔥 breached your walls' : '🛡️ you held'} · you lost ${e.dLoss}, them ${e.aLoss}`)
      }
    }
    lines.push(RULE)
  }

  if (!any) {
    lines.push(`🕊️ No sieges under way.`)
    lines.push(`_Launch one with *${p}raid <empire>*, or scout a target with *${p}raid scout <empire>*._`)
  } else {
    lines.push(`_The front advances whenever anyone checks it. Look again with *${p}raid status*._`)
  }
  return ctx.reply(lines.join('\n'))
}

// ── Log / shield views (.raid log, .raid shield) ──────────────────────────────

async function doLog(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const now = Date.now()
  await settleConflicts(ctx, now)
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const log = owned.raidLog ?? []
  if (!log.length) {
    return ctx.reply(`📜 *${owned.name}* has no sieges on record yet. Find a target with *${p}raid scout <empire>*.`)
  }
  const lines = [`📜 *Siege log: ${owned.name}*`, RULE]
  for (const e of log) {
    const ago = `${Math.max(1, Math.ceil((now - (e.at ?? now)) / HOUR_MS))}h ago`
    // Robust to both the new siege entries (role 'attacker'/'defender', opponent,
    // won) and any legacy instant-raid entries (role 'attack'/'defense', vs, win).
    const isSiege = e.kind === 'siege'
    const won = e.won ?? e.win
    const foe = e.opponent ?? e.vs ?? 'a rival'
    const loot = Math.abs(Number(e.loot ?? 0))
    const attackerSide = e.role === 'attacker' || e.role === 'attack'
    const verbAtk = isSiege ? 'Besieged' : 'Raided'
    const verbDef = isSiege ? 'Besieged by' : 'Raided by'
    if (attackerSide) {
      lines.push(`${isSiege ? '🏰' : '⚔️'} ${verbAtk} *${foe}* ${won ? 'and won' : 'and lost'}${won && loot ? `, took ${loot.toLocaleString()} solars` : ''}. _${ago}_`)
    } else {
      lines.push(`🛡️ ${verbDef} *${foe}* ${won ? 'and held' : 'and fell'}${!won && loot ? `, lost ${loot.toLocaleString()} solars` : ''}. _${ago}_`)
    }
  }
  return ctx.reply(lines.join('\n'))
}

async function doShieldView(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const now = Date.now()
  await settleConflicts(ctx, now)
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const lines = [`🛡️ *Standing of ${owned.name}*`, RULE]
  if ((owned.shieldUntil ?? 0) > now) {
    lines.push(`🛡️ Recovery shield active: *${hrsLeft(owned.shieldUntil, now)}* left. Rivals cannot besiege you.`)
  } else {
    lines.push(`🛡️ No shield. Your empire can be besieged.`)
  }
  if (owned.siege?.status === 'active') {
    lines.push(`⚔️ You are besieging *${owned.siege.targetName}*, *${owned.siege.ticksDone}/${owned.siege.ticksTotal}* assaults done, *${hrsLeft(owned.siege.endsAt, now)}* left. See *${p}raid status*.`)
  } else if ((owned.deployedUntil ?? 0) > now) {
    lines.push(`⚔️ Troops deployed: *${hrsLeft(owned.deployedUntil, now)}* until they return, and your walls are thin until they do.`)
  } else {
    lines.push(`⚔️ Troops are home and ready to march.`)
  }
  const incoming = siegeAgainst(ctx.db, owned.id, now)
  if (incoming?.siege?.status === 'active') {
    lines.push(`🏰 You are *under siege* by *${incoming.name}*. Check the front with *${p}raid status*.`)
  }
  const cdMs = (RAID_CONFIG.siegeCooldownHours ?? 3) * HOUR_MS
  const cdLeft = (owned.lastRaidAt ?? 0) + cdMs - now
  if (cdLeft > 0 && owned.siege?.status !== 'active' && (owned.deployedUntil ?? 0) <= now) {
    lines.push(`⏳ Campaign cooldown: *${hrsLeft((owned.lastRaidAt ?? 0) + cdMs, now)}* until you can march again.`)
  }
  return ctx.reply(lines.join('\n'))
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default {
  name:           'raid',
  aliases:        ['spy'],
  category:       'empire',
  requiresPlayer: true,
  description:    'Scout and lay timed sieges on rival empires',
  subcommands: [
    { cmd: 'scout <empire>', desc: 'noised intel on a target (also .spy)' },
    { cmd: '<empire>', desc: 'lay a timed siege for capped loot' },
    { cmd: 'status', desc: 'the live front of your siege (and any pressing you)' },
    { cmd: 'log', desc: 'your recent sieges' },
    { cmd: 'shield', desc: 'your shield and troop-deploy standing' },
  ],

  async run(ctx) {
    const p = config.prefix

    // .spy <empire> is a straight alias for .raid scout <empire>.
    if (ctx.cmd === 'spy') return doScout(ctx, ctx.args.join(' ').trim())

    const sub = ctx.args[0]?.toLowerCase()
    if (sub === 'scout') return doScout(ctx, ctx.args.slice(1).join(' ').trim())
    if (sub === 'status' || sub === 'front') return doSiegeStatus(ctx)
    if (sub === 'log') return doLog(ctx)
    if (sub === 'shield') return doShieldView(ctx)
    if (!sub) {
      return ctx.reply(
        `⚔️ *Lay siege to a rival empire.*\n` +
        `A siege is a timed campaign, fought in assaults over real time.\n${RULE}\n` +
        `> *${p}raid scout <empire>* to gather intel\n` +
        `> *${p}raid <empire>* to lay siege\n` +
        `> *${p}raid status* to watch the front\n` +
        `> *${p}raid log* · *${p}raid shield*`
      )
    }
    // Anything else is treated as a target name to besiege.
    return doSiege(ctx, ctx.args.join(' ').trim())
  },
}
