/**
 * plugins/raid.js — scout and raid rival empires.
 *
 *   .raid scout <empire>   fuzzy, noised intel on a target  (alias .spy <empire>)
 *   .raid <empire>         launch a raid, resolved instantly against a snapshot
 *   .raid log              your empire's recent raids
 *   .raid shield           your shield and troop-deploy status
 *
 * Phase 3 of the Empire pillar, and the load-bearing safety design. A raid is
 * the light, frequent conflict layer: capped loot, one building only knocked
 * offline (never destroyed), the beaten side shielded from being farmed. All
 * the math lives in lib/empire-combat.js as pure functions of read-only
 * snapshots plus an rng, so it is fully simulatable without a socket.
 *
 * WRITE SAFETY (the pvpConclude pattern, plugins/pvp.js):
 *   1. Snapshot BOTH empires read-only and resolve the raid into plain locals.
 *   2. Two SEQUENTIAL, never-nested updatePlayer calls: defender first (it
 *      computes the loot actually seized into a local), then attacker (it
 *      credits that same local). Each mutates its own empire record on
 *      db.data.empires in place, the season-runtime in-mutator idiom.
 *   3. After BOTH writes settle, exactly ONE pushNotification to the defender's
 *      inbox, outside every mutator (it wraps updateAllPlayers) and .catch
 *      guarded. Never a loop over members, never a group broadcast, never a DM
 *      fan-out. The attacker gets the battle report as the in-chat reply.
 * Nothing here mints gems, and nothing reads or writes a player's baseStats.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { pushNotification } from '../lib/notification-repo.js'
import {
  ensureEmpiresInitialized, getOwnedEmpire, findEmpireByQuery, ensureEmpirePlayer,
} from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, RAID_CONFIG, HOUR_MS, applyCollect, findBuilding, buildingDefMap,
  armyPower, armyHeadcount, tierOf, generalBonusOf,
} from '../lib/empire-engine.js'
import { characterLabel } from '../lib/empire-abilities.js'
import { buildSnapshot, weightMatchOk, resolveRaid, scoutReport } from '../lib/empire-combat.js'

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

/** Appends a capped raid-log entry to a record, newest first. Mutates in place. */
function appendRaidLog(record, entry) {
  if (!Array.isArray(record.raidLog)) record.raidLog = []
  record.raidLog.unshift(entry)
  const cap = RAID_CONFIG.raidLogCap ?? 8
  if (record.raidLog.length > cap) record.raidLog.length = cap
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

  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  if (!query) return ctx.reply(`🔎 *Scout whom?* Try *${p}raid scout <empire>* or *${p}spy <empire>*.`)

  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`🔎 No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (target.id === owned.id) return ctx.reply(`🔎 That's your own empire. Scout a rival instead.`)

  const now = Date.now()
  // A posted general lifts POWER only, on both sides, so a scout report shows
  // the same number the raid will actually resolve against.
  const atkSnap = buildSnapshot(owned, { generalBonus: generalBonusOf(owned) })
  const defSnap = buildSnapshot(target, { generalBonus: generalBonusOf(target) })
  const r = scoutReport(atkSnap, defSnap, Math.random, now)

  const lines = [`🔎 *Scouting ${target.name}*`, RULE]
  lines.push(`🏰 Tier: *${tierOf(target).name}*`)
  lines.push(`⚔️ Army looks like *${r.armyBand}*.`)
  lines.push(`👥 Garrison: *${r.headcountBand}*.`)
  lines.push(`💰 Coffers: *${r.treasuryBand}*.`)
  lines.push(RULE)
  if (r.shielded) {
    lines.push(`🛡️ They are under a recovery *shield*. You cannot raid them yet.`)
  } else if (!r.weightLegal) {
    lines.push(`⚖️ Too small a target. Raiding them would be a stomp, and your officers refuse.`)
  } else {
    lines.push(`✅ A raid is possible.${r.deployed ? ' Their troops are *deployed elsewhere* right now, so their defense is thin.' : ''}`)
    lines.push(`> *${p}raid ${target.name}*`)
  }
  lines.push(`\n_Scouts report in rough figures. Numbers are never exact._`)
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
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const log = owned.raidLog ?? []
  if (!log.length) {
    return ctx.reply(`📜 *${owned.name}* has no raids on record yet. Find a target with *${p}raid scout <empire>*.`)
  }
  const now = Date.now()
  const lines = [`📜 *Raid log: ${owned.name}*`, RULE]
  for (const e of log) {
    const ago = `${Math.max(1, Math.ceil((now - (e.at ?? now)) / HOUR_MS))}h ago`
    if (e.role === 'attack') {
      lines.push(`⚔️ Raided *${e.vs}* ${e.win ? 'and won' : 'and lost'}${e.win && e.loot ? `, took ${e.loot.toLocaleString()} solars` : ''}. _${ago}_`)
    } else {
      lines.push(`🛡️ Raided by *${e.vs}* ${e.win ? 'and held' : 'and fell'}${!e.win && e.loot ? `, lost ${e.loot.toLocaleString()} solars` : ''}. _${ago}_`)
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
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const now = Date.now()
  const lines = [`🛡️ *Standing of ${owned.name}*`, RULE]
  if ((owned.shieldUntil ?? 0) > now) {
    lines.push(`🛡️ Recovery shield active: *${hrsLeft(owned.shieldUntil, now)}* left. Rivals cannot raid you.`)
  } else {
    lines.push(`🛡️ No shield. Your empire can be raided.`)
  }
  if ((owned.deployedUntil ?? 0) > now) {
    lines.push(`⚔️ Troops deployed: *${hrsLeft(owned.deployedUntil, now)}* until they return. You cannot raid again yet, and your defense is thin.`)
  } else {
    lines.push(`⚔️ Troops are home and ready.`)
  }
  const cdMs = (RAID_CONFIG.cooldownHours ?? 1) * HOUR_MS
  const cdLeft = (owned.lastRaidAt ?? 0) + cdMs - now
  if (cdLeft > 0 && (owned.deployedUntil ?? 0) <= now) {
    lines.push(`⏳ Raid cooldown: *${hrsLeft((owned.lastRaidAt ?? 0) + cdMs, now)}* left.`)
  }
  return ctx.reply(lines.join('\n'))
}

// ── Raid (.raid <empire>) ─────────────────────────────────────────────────────

async function doRaid(ctx, query) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }

  // A player mid-duel or in a dungeon can't also march an army out.
  if (ctx.player?.inBattle) return ctx.reply(`⚔️ Finish your current battle before you raid.`)
  if (ctx.player?.inDungeon) return ctx.reply(`🗺️ You can't raid from inside a dungeon.`)

  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)

  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  if (!query) return ctx.reply(`⚔️ *Raid whom?* Scout first with *${p}raid scout <empire>*, then *${p}raid <empire>*.`)

  const now = Date.now()

  // Attacker gates.
  if ((owned.deployedUntil ?? 0) > now) {
    return ctx.reply(`⚔️ Your troops are already deployed (*${hrsLeft(owned.deployedUntil, now)}* left). One raid at a time.`)
  }
  const cdMs = (RAID_CONFIG.cooldownHours ?? 1) * HOUR_MS
  if ((owned.lastRaidAt ?? 0) + cdMs > now) {
    return ctx.reply(`⏳ Your soldiers need to regroup. Raid again in *${hrsLeft((owned.lastRaidAt ?? 0) + cdMs, now)}*.`)
  }
  if (armyPower(owned) <= 0) {
    return ctx.reply(`⚔️ You have no army to raid with. Recruit troops first with *${p}recruit <n>*.`)
  }

  // Target gates.
  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`⚔️ No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (target.id === owned.id) return ctx.reply(`⚔️ You cannot raid your own empire.`)
  if (!target.ownerId) return ctx.reply(`⚔️ *${target.name}* has no ruler to answer for it.`)
  if ((target.shieldUntil ?? 0) > now) {
    return ctx.reply(`🛡️ *${target.name}* is under a recovery shield for *${hrsLeft(target.shieldUntil, now)}*. Pick another target.`)
  }

  const atkSnap = buildSnapshot(owned, { generalBonus: generalBonusOf(owned) })
  const defSnap = buildSnapshot(target, { generalBonus: generalBonusOf(target) })
  if (!weightMatchOk(atkSnap, defSnap)) {
    return ctx.reply(
      `⚖️ *${target.name}* is far weaker than you. Your officers refuse to lead a stomp.\n` +
      `_Raids are weight matched. Find a rival closer to your own strength._`
    )
  }

  // A deployed defender fights at reduced strength: their own troops are away.
  if ((target.deployedUntil ?? 0) > now) {
    defSnap.power = Math.floor(defSnap.power * (RAID_CONFIG.deployDefenseMult ?? 0.6))
  }

  const plan = resolveRaid(atkSnap, defSnap, Math.random, now)

  // ── Write 1: DEFENDER. Settles their books, seizes the loot into a local,
  // applies casualties, damages one building, raises their shield if beaten.
  const defOwnerId = target.ownerId
  const defId = target.id
  const atkId = owned.id
  const atkName = owned.name
  const defName = target.name
  let lootTaken = 0
  let damagedName = ''

  await updatePlayer(ctx.db, defOwnerId, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[defId]
    if (!rec) return player
    applyCollect(rec, now) // settle production/wages to the raid moment first
    lootTaken = plan.attackerWins ? Math.min(plan.loot, Math.max(0, rec.treasury)) : 0
    rec.treasury = Math.max(0, rec.treasury - lootTaken)
    rec.army.levies.recruit = Math.max(0, (rec.army.levies.recruit ?? 0) - plan.defenderLosses.recruit)
    rec.army.levies.soldier = Math.max(0, (rec.army.levies.soldier ?? 0) - plan.defenderLosses.soldier)
    if (plan.damaged) {
      const b = findBuilding(rec, plan.damaged.type)
      if (b) { b.damagedUntil = plan.damaged.until; damagedName = buildingDefMap[plan.damaged.type]?.name ?? plan.damaged.type }
    }
    if (plan.defenderShieldUntil) rec.shieldUntil = plan.defenderShieldUntil
    rec.lastActiveAt = now
    appendRaidLog(rec, { at: now, role: 'defense', vs: atkName, win: !plan.attackerWins, loot: lootTaken })
    return player
  })

  // ── Write 2: ATTACKER. Settles their books, credits the seized loot,
  // applies their own casualties, marks troops deployed and stamps cooldown.
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[atkId]
    if (!rec) return player
    applyCollect(rec, now)
    rec.treasury += lootTaken
    rec.army.levies.recruit = Math.max(0, (rec.army.levies.recruit ?? 0) - plan.attackerLosses.recruit)
    rec.army.levies.soldier = Math.max(0, (rec.army.levies.soldier ?? 0) - plan.attackerLosses.soldier)
    rec.deployedUntil = plan.attackerDeployedUntil
    rec.lastRaidAt = now
    rec.lastActiveAt = now
    appendRaidLog(rec, { at: now, role: 'attack', vs: defName, win: plan.attackerWins, loot: lootTaken })
    return player
  })

  // ── Defender inbox notification (outside both mutators, best-effort).
  const note = plan.attackerWins
    ? {
        kind: 'battle',
        title: `⚔️ ${defName} was raided`,
        body: `${atkName} broke through your defenses`
          + (lootTaken ? ` and made off with ${lootTaken.toLocaleString()} solars` : '')
          + (damagedName ? `. Your ${damagedName} was knocked offline` : '')
          + `. A recovery shield is now up.`,
      }
    : {
        kind: 'battle',
        title: `🛡️ ${defName} repelled a raid`,
        body: `${atkName} attacked your empire and was driven off. Your walls held.`,
      }
  await pushNotification(ctx.db, defOwnerId, note).catch(() => {})

  // ── Battle report to the attacker, in-chat.
  const lines = []
  if (plan.attackerWins) {
    lines.push(`⚔️🔥 *RAID SUCCESSFUL!* 🔥⚔️`)
    lines.push(RULE)
    lines.push(`*${atkName}* overran *${defName}*.`)
    if (lootTaken) lines.push(`💰 Seized *${lootTaken.toLocaleString()} solars* into your treasury.`)
    else lines.push(`💰 Their coffers were bare. No solars to seize.`)
    if (damagedName) lines.push(`🏚️ Knocked their *${damagedName}* offline for *${Math.ceil((RAID_CONFIG.buildingDamageHours ?? 6))}h*.`)
  } else {
    lines.push(`⚔️💀 *RAID REPELLED* 💀⚔️`)
    lines.push(RULE)
    lines.push(`*${defName}* held the line. Your assault was driven off.`)
  }
  lines.push('')
  lines.push(`⚔️ Effective power: you *${plan.aEff.toLocaleString()}*  vs  them *${plan.dEff.toLocaleString()}*`)
  const atkGeneral = owned.assignments?.generals?.[0]
  if (atkGeneral) lines.push(`🎖️ ${characterLabel(atkGeneral.charId)} led the assault.`)
  const defGeneral = target.assignments?.generals?.[0]
  if (defGeneral) lines.push(`🎖️ ${characterLabel(defGeneral.charId)} commanded their defense.`)
  lines.push(`🩸 Your losses: ${fmtLosses(plan.attackerLosses)}.`)
  lines.push(`🩸 Their losses: ${fmtLosses(plan.defenderLosses)}.`)
  lines.push(`⏳ Your troops are deployed for *${hrsLeft(plan.attackerDeployedUntil, now)}* and your home defense is thin until they return.`)
  return ctx.reply(lines.join('\n'))
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default {
  name:           'raid',
  aliases:        ['spy'],
  category:       'empire',
  requiresPlayer: true,
  description:    'Scout and raid rival empires for loot',
  subcommands: [
    { cmd: 'scout <empire>', desc: 'noised intel on a target (also .spy)' },
    { cmd: '<empire>', desc: 'launch a raid for capped loot' },
    { cmd: 'log', desc: 'your recent raids' },
    { cmd: 'shield', desc: 'your shield and troop-deploy status' },
  ],

  async run(ctx) {
    const p = config.prefix

    // .spy <empire> is a straight alias for .raid scout <empire>.
    if (ctx.cmd === 'spy') return doScout(ctx, ctx.args.join(' ').trim())

    const sub = ctx.args[0]?.toLowerCase()
    if (sub === 'scout') return doScout(ctx, ctx.args.slice(1).join(' ').trim())
    if (sub === 'log') return doLog(ctx)
    if (sub === 'shield') return doShieldView(ctx)
    if (!sub) {
      return ctx.reply(
        `⚔️ *Raid a rival empire.*\n` +
        `> *${p}raid scout <empire>* to gather intel\n` +
        `> *${p}raid <empire>* to attack\n` +
        `> *${p}raid log* · *${p}raid shield*`
      )
    }
    // Anything else is treated as a target name.
    return doRaid(ctx, ctx.args.join(' ').trim())
  },
}
