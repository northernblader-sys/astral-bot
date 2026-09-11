/**
 * plugins/army.js: raise, view, and promote your empire's army.
 *
 * Phase 2 of the Empire pillar. An empire fields an officer-corps army: recruit
 * and soldier are integer levy counts, veteran and above are named officer
 * records whose power is derived on read (never stored). Wages are charged on
 * every collect over the same clamped window as production; a shortfall deserts
 * the lowest ranks first. That payroll sink is the core anti-runaway brake.
 *
 * Every write rides updatePlayer's serialized queue, and the empire record on
 * db.data.empires is mutated INSIDE that mutator (the season-runtime idiom).
 * Recruiting and promoting settle production first (applyCollect), exactly like
 * .empire upgrade, so the wage clock advances to now and new troops can never be
 * charged wages retroactively. Nothing here broadcasts and nothing mints gems.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { materials as materialDefs } from '../lib/game-data.js'
import {
  ensureEmpiresInitialized, getOwnedEmpire, ensureEmpirePlayer,
} from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, ARMY_RANKS, RANK_ORDER, rankMap, OFFICER_CAP, RECRUIT_COST_SOLARS,
  applyCollect, armyHeadcount, armyCap, armySlotsLeft, armyPower, wagePerHour,
  rankCount, officerCount, soldierPowerOf, canRecruit, applyRecruit,
  promoteInfo, applyPromote, applyPromoteOfficer,
} from '../lib/empire-engine.js'
import { soldierName } from '../lib/soldier-names.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const matName = Object.fromEntries(materialDefs.map(m => [m.id, m.name]))
const mname = id => matName[id] ?? id

// ── Shared gating ───────────────────────────────────────────────────────────

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

/**
 * The one gate every army command goes through. Handles the group opt-in,
 * reads the db, initializes empires, and resolves the caller's owned empire.
 * Calls fn(owned) only when all of that passes; otherwise replies and returns.
 * Self-contained so plugins/train.js can delegate straight into it.
 */
async function withEmpire(ctx, fn) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) return ctx.reply(disabledMsg(p))
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  return fn(owned)
}

// ── Views ─────────────────────────────────────────────────────────────────

/** A short note surfacing whatever a settle-first applyCollect claimed or cost. */
function settledNote(summary) {
  if (!summary?.hasSomething) return ''
  const parts = []
  if (summary.solarsGain) parts.push(`${summary.solarsGain.toLocaleString()} solars`)
  for (const [id, qty] of Object.entries(summary.matStored)) parts.push(`${qty} ${mname(id).toLowerCase()}`)
  const deserted = []
  const dz = summary.payroll?.deserters ?? {}
  if (dz.recruit) deserted.push(`${dz.recruit.toLocaleString()} recruits`)
  if (dz.soldier) deserted.push(`${dz.soldier.toLocaleString()} soldiers`)
  if (summary.payroll?.officersLost?.length) deserted.push(summary.payroll.officersLost.join(', '))
  let s = ''
  if (parts.length) s += `\n_Production settled first: ${parts.join(', ')}._`
  if (deserted.length) s += `\n_Payroll fell short during settle. Deserted: ${deserted.join(', ')}._`
  return s
}

function rosterLines(record) {
  const lines = []
  let idx = 0
  for (const rank of ARMY_RANKS) {
    if (!rank.named) {
      const c = rankCount(record, rank.id)
      if (c > 0) lines.push(`• ${rank.name}s: *${c.toLocaleString()}*  (power ${(c * rank.power).toLocaleString()})`)
      continue
    }
    const officers = (record.army.officers ?? [])
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.rank === rank.id)
    if (!officers.length) continue
    lines.push(`• ${rank.name}s (${officers.length}):`)
    for (const { o, i } of officers) {
      lines.push(`   [${i + 1}] ${o.name}  (power ${soldierPowerOf(o).toLocaleString()})`)
    }
    idx += officers.length
  }
  return lines
}

function armyInfoText(ctx, record) {
  const p = config.prefix
  const head = armyHeadcount(record)
  const lines = [`⚔️ *Army of ${record.name}*`, RULE]

  if (head === 0) {
    lines.push(`You have no troops yet.`)
    lines.push(`Recruit your first with *${p}recruit <n>* (${RECRUIT_COST_SOLARS.toLocaleString()} solars each).`)
    return lines.join('\n')
  }

  lines.push(`Headcount: *${head.toLocaleString()}* / ${armyCap(record).toLocaleString()}`)
  lines.push(`Total power: *${armyPower(record).toLocaleString()}*`)
  const wage = wagePerHour(record)
  if (wage > 0) lines.push(`Wages: *${wage.toLocaleString()}* solars/h (paid on collect)`)
  lines.push(RULE)
  for (const l of rosterLines(record)) lines.push(l)
  lines.push(RULE)

  const info = promoteInfo(record)
  if (info) {
    const fromName = rankMap[info.fromRank]?.name ?? info.fromRank
    const toName = rankMap[info.toRank]?.name ?? info.toRank
    lines.push(`⬆️ Next bulk drill: *${fromName} → ${toName}* (${info.available.toLocaleString()} eligible)`)
    lines.push(`> *${p}train soldier <n>* to drill that many up one step`)
  }
  if ((record.army.officers ?? []).length) {
    lines.push(`> *${p}army promote <#>* to rank up one officer on their own`)
  }
  lines.push(`> *${p}recruit <n>* to add troops`)
  return lines.join('\n')
}

// ── Recruit ─────────────────────────────────────────────────────────────────

async function doRecruit(ctx, owned, nArg) {
  const p = config.prefix
  const n = Math.floor(Number(nArg))
  if (!Number.isInteger(n) || n <= 0) {
    return ctx.reply(`❌ How many? e.g. *${p}recruit 20*. Each recruit costs ${RECRUIT_COST_SOLARS.toLocaleString()} treasury solars.`)
  }

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    // Settle first so the wage clock advances to now: the troops we add can't
    // be charged wages for time before they existed (mirrors .empire upgrade).
    const settled = applyCollect(rec, now)
    const chk = canRecruit(rec, n)
    if (!chk.ok) { outcome = { ...chk, settled }; return player }
    const res = applyRecruit(rec, n)
    rec.lastActiveAt = now
    outcome = { ...res, settled }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'count') {
    return ctx.reply(`❌ How many? e.g. *${p}recruit 20*.`)
  }
  if (outcome?.reason === 'cap') {
    return ctx.reply(
      `🛡️ Your army can field *${outcome.cap.toLocaleString()}* and has room for *${outcome.slots.toLocaleString()}* more.\n` +
      `Build or upgrade a Barracks with *${p}empire build barracks* to field a bigger army.`
    )
  }
  if (outcome?.reason === 'poor') {
    return ctx.reply(
      `💸 Recruiting ${n.toLocaleString()} costs *${outcome.cost.toLocaleString()} solars*.\n` +
      `Your treasury has *${outcome.have.toLocaleString()}*.`
    )
  }
  return ctx.reply(
    `⚔️ *Recruited ${outcome.count.toLocaleString()}.*\n` +
    `Army: *${outcome.head.toLocaleString()}* / ${outcome.cap.toLocaleString()}  ·  power ${armyPower(ctx.db.data.empires[owned.id]).toLocaleString()}\n` +
    `Paid ${outcome.cost.toLocaleString()} solars.` +
    settledNote(outcome.settled) +
    `\n\n_Wages come out of the treasury on every *${p}empire collect*._`
  )
}

export async function armyRecruit(ctx, nArg) {
  return withEmpire(ctx, owned => doRecruit(ctx, owned, nArg))
}

// ── Train / promote (.train soldier) ─────────────────────────────────────────

async function doTrain(ctx, owned, nArg) {
  const p = config.prefix
  const n = Math.floor(Number(nArg))
  if (!Number.isInteger(n) || n <= 0) {
    return ctx.reply(`❌ How many? e.g. *${p}train soldier 5*. Promotes your lowest ranks up one step.`)
  }

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const settled = applyCollect(rec, now)
    const res = applyPromote(rec, n, soldierName)
    if (res.ok) rec.lastActiveAt = now
    outcome = { ...res, settled }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'empty') {
    return ctx.reply(`⚔️ You have no troops to promote. Recruit first with *${p}recruit <n>*.`)
  }
  if (outcome?.reason === 'maxed') {
    return ctx.reply(`🏆 Every soldier is already a Warlord. There is nothing higher to promote them to.`)
  }
  if (outcome?.reason === 'officercap') {
    return ctx.reply(
      `🎖️ Your officer corps is full (*${outcome.cap}* officers).\n` +
      `Promote existing officers higher, or wait for losses, before minting new ones.`
    )
  }
  if (outcome?.reason === 'poor') {
    const fromName = rankMap[outcome.fromRank]?.name ?? outcome.fromRank
    const toName = rankMap[outcome.toRank]?.name ?? outcome.toRank
    const cost = fmtUnitCost(outcome.unitCost)
    return ctx.reply(
      `💸 Promoting a ${fromName} to ${toName} costs *${cost}* each.\n` +
      `Your treasury and warehouse can't cover even one.` +
      settledNote(outcome.settled)
    )
  }

  const fromName = rankMap[outcome.fromRank]?.name ?? outcome.fromRank
  const toName = rankMap[outcome.toRank]?.name ?? outcome.toRank
  const lines = [`⬆️ *Promoted ${outcome.promoted.toLocaleString()} ${fromName}${outcome.promoted === 1 ? '' : 's'} to ${toName}${outcome.promoted === 1 ? '' : 's'}.*`]
  const spent = []
  if (outcome.spentSolars) spent.push(`${outcome.spentSolars.toLocaleString()} solars`)
  for (const [id, qty] of Object.entries(outcome.spentMaterials ?? {})) spent.push(`${qty} ${mname(id).toLowerCase()}`)
  if (spent.length) lines.push(`Paid ${spent.join(', ')}.`)
  if (outcome.newOfficers?.length) {
    lines.push(`🎖️ New officers: ${outcome.newOfficers.join(', ')}.`)
  }
  if (outcome.hitCap) {
    lines.push(`_Officer corps is now full (${OFFICER_CAP}); further named promotions are capped._`)
  }
  lines.push('')
  lines.push(`Army power: *${armyPower(ctx.db.data.empires[owned.id]).toLocaleString()}*`)
  return ctx.reply(lines.join('\n') + settledNote(outcome.settled))
}

function fmtUnitCost(cost) {
  const parts = [`${(cost?.solars ?? 0).toLocaleString()} solars`]
  for (const [id, qty] of Object.entries(cost?.materials ?? {})) parts.push(`${qty} ${mname(id).toLowerCase()}`)
  return parts.join(' + ')
}

export async function armyTrainSoldier(ctx, nArg) {
  return withEmpire(ctx, owned => doTrain(ctx, owned, nArg))
}

// ── Rename an officer ─────────────────────────────────────────────────────────

async function doRename(ctx, owned, args) {
  const p = config.prefix
  const idx = parseInt(args[0], 10)
  const newName = args.slice(1).join(' ').trim()
  if (!Number.isInteger(idx) || idx <= 0 || !newName) {
    return ctx.reply(`❌ *Usage:* *${p}army rename <number> <new name>*. Find the number in *${p}army*.`)
  }
  if (newName.length < 2 || newName.length > 24) {
    return ctx.reply(`❌ Keep the name between 2 and 24 characters.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const officer = rec.army?.officers?.[idx - 1]
    if (!officer) { outcome = { reason: 'nooff' }; return player }
    const old = officer.name
    officer.name = newName
    rec.lastActiveAt = Date.now()
    outcome = { reason: 'ok', old, next: newName }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'nooff') return ctx.reply(`❌ No officer at number ${idx}. Check the roster with *${p}army*.`)
  return ctx.reply(`🎖️ Renamed *${outcome.old}* to *${outcome.next}*.`)
}

// ── Promote a single officer (.army promote <#>) ──────────────────────────────

/**
 * Advance ONE officer, by roster number, up a single rank on their own, without
 * waiting on the rest of the corps. Settles production first (like doTrain) so
 * the higher wage never applies to time before the promotion.
 */
async function doPromoteOfficer(ctx, owned, idxArg) {
  const p = config.prefix
  const idx = parseInt(idxArg, 10)
  if (!Number.isInteger(idx) || idx <= 0) {
    return ctx.reply(
      `❌ Which officer? e.g. *${p}army promote 2*.\n` +
      `Find the number next to each name in *${p}army*.`
    )
  }

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const settled = applyCollect(rec, now)
    const res = applyPromoteOfficer(rec, idx)
    if (res.ok) rec.lastActiveAt = now
    outcome = { ...res, settled }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'nooff') {
    return ctx.reply(`❌ No officer at number ${idx}. Named officers are listed in *${p}army*.`)
  }
  if (outcome?.reason === 'maxed') {
    const rankName = rankMap[outcome.fromRank]?.name ?? outcome.fromRank
    return ctx.reply(`🏆 *${outcome.name}* is a ${rankName}, the highest rank. There is nothing higher to promote them to.`)
  }
  if (outcome?.reason === 'poor') {
    const toName = rankMap[outcome.toRank]?.name ?? outcome.toRank
    return ctx.reply(
      `💸 Promoting *${outcome.name}* to ${toName} costs *${fmtUnitCost(outcome.unitCost)}*.\n` +
      `Your treasury and warehouse can't cover it.` +
      settledNote(outcome.settled)
    )
  }

  const fromName = rankMap[outcome.fromRank]?.name ?? outcome.fromRank
  const toName = rankMap[outcome.toRank]?.name ?? outcome.toRank
  return ctx.reply(
    `🎖️ *${outcome.name}* rose from ${fromName} to *${toName}*.\n` +
    `Paid ${fmtUnitCost(outcome.unitCost)}.\n` +
    `Army power: *${armyPower(ctx.db.data.empires[owned.id]).toLocaleString()}*` +
    settledNote(outcome.settled)
  )
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default {
  name:           'army',
  aliases:        ['recruit'],
  category:       'empire',
  requiresPlayer: true,
  description:    "Raise and command your empire's army",
  subcommands: [
    { cmd: 'info', desc: 'view your roster, headcount and power' },
    { cmd: 'recruit <n>', desc: 'add recruits (also just .recruit <n>)' },
    { cmd: 'train soldier <n>', desc: 'bulk-drill your lowest ranks up one step' },
    { cmd: 'promote <#>', desc: 'rank up one named officer on their own' },
    { cmd: 'rename <n> <name>', desc: 'rename one of your officers' },
  ],

  async run(ctx) {
    const p = config.prefix

    // The .recruit alias: the whole argument is the count.
    if (ctx.cmd === 'recruit') return armyRecruit(ctx, ctx.args[0])

    const sub = ctx.args[0]?.toLowerCase()
    if (!sub || sub === 'info') return withEmpire(ctx, owned => ctx.reply(armyInfoText(ctx, owned)))
    if (sub === 'recruit') return armyRecruit(ctx, ctx.args[1])
    if (sub === 'train') {
      // .army train soldier <n> — bulk drill of the lowest ranks up one step.
      if (ctx.args[1]?.toLowerCase() !== 'soldier') {
        return ctx.reply(`❌ *Usage:* *${p}army train soldier <n>* to drill your lowest ranks up one step.`)
      }
      return armyTrainSoldier(ctx, ctx.args[2])
    }
    // .army promote <#> — advance ONE named officer, by roster number, on their own.
    if (sub === 'promote') return withEmpire(ctx, owned => doPromoteOfficer(ctx, owned, ctx.args[1]))
    if (sub === 'rename') return withEmpire(ctx, owned => doRename(ctx, owned, ctx.args.slice(1)))

    return ctx.reply(
      `❓ Unknown army command.\n` +
      `Try: *${p}army*, *${p}recruit <n>*, *${p}train soldier <n>*, *${p}army promote <#>*, *${p}army rename <n> <name>*.`
    )
  },
}
