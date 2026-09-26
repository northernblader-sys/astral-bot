/**
 * <prefix>guardian — the Guardian of the Innocent event hub.
 *
 *   .guardian                 event banner, clock, your standing
 *   .guardian map             the seven locations, what is open, your wins there
 *   .guardian travel <name>   go to a location (then .rescue)
 *   .guardian accept|reject   answer a freed companion's request
 *   .guardian top             most beastkin freed
 *
 * Owner only:
 *   .guardian start [days]    open the event (default 7 days)
 *   .guardian end             close it now
 *   .guardian skip <n>        move the clock forward n days (testing)
 *   .guardian release <id>    free a claimed companion back into her location
 *
 * No location is level-gated. Locations open one by one over the first days,
 * each player can rescue at most GUARDIAN.dailyRescueCap times a day, and a
 * companion's captor only appears after GUARDIAN.companionWinsNeeded wins in
 * her location, so nothing here can be finished in a single day.
 */
import { config } from '../config.js'
import { updatePlayer, updateAllPlayers } from '../lib/player-repo.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  GUARDIAN, REGIONS, REGION_MAP, COMPANIONS, COMPANION_MAP, TYPE_BADGE,
  getGuardianEvent, isGuardianActive, eventDay, regionOpensAt, isRegionOpen,
  startGuardianEvent, endGuardianEvent, skipGuardianDays, findRegion, findCompanion,
  ensureGuardianState, rescuesLeftToday, dailyCap, renownRank, nextRenownRank,
  companionOwner, releaseCompanionClaim, playerCompanion, acceptOffer, rejectOffer,
  expireOffer, guardianLeaderboard,
} from '../lib/guardian-event.js'
import { RULE, replyOverImage, sendCompanionOffer } from '../lib/guardian-ui.js'

const obj = (c) => (c.pronoun === 'they' ? 'them' : c.pronoun === 'he' ? 'him' : 'her')

/** Unclaimed companions only: a claimed one vanishes from everyone else's view. */
function heldAt(db, region) {
  const c = region.companionId ? COMPANION_MAP[region.companionId] : null
  return c && !companionOwner(db, c.id) ? c : null
}

function eventStatusLine(db, now = Date.now()) {
  const e = getGuardianEvent(db)
  if (isGuardianActive(db, now)) {
    const total = Math.round((e.endsAt - e.startedAt) / 86400000)
    return `📅 Day *${eventDay(db, now)}*/${total}  ·  ⏳ Ends in *${formatTimeLeft(e.endsAt - now)}*`
  }
  if (e.startedAt && (e.endedAt || now >= e.endsAt)) return `🔚 _The event has ended. Your companion stays with you._`
  return `🔒 _Not started yet._`
}

function infoText(ctx) {
  const p = config.prefix
  const db = ctx.db
  const player = ctx.player
  const g = ensureGuardianState(player)
  const now = Date.now()
  const active = isGuardianActive(db, now)
  const rank = renownRank(g.freed)
  const next = nextRenownRank(g.freed)
  const comp = playerCompanion(player)
  const unclaimed = COMPANIONS.filter(c => !companionOwner(db, c.id))

  const lines = [
    `🕊️ *GUARDIAN OF THE INNOCENT*`,
    RULE,
    `_${GUARDIAN.intro}_`,
    ``,
    eventStatusLine(db, now),
    ``,
    `👤 *Your standing*`,
    `🕊️ Freed: *${g.freed}*  ·  ${rank.emoji} *${rank.label}*` + (next ? ` _(next: ${next.label} at ${next.min})_` : ''),
  ]
  if (active) {
    lines.push(`🗺️ Location: *${g.region ? REGION_MAP[g.region]?.name : 'none yet'}*  ·  Rescues left today: *${rescuesLeftToday(db, player, now)}*/${dailyCap(player)}`)
  }
  if (comp) lines.push(`💞 Companion: *${comp.name}*  ·  ${TYPE_BADGE[comp.type] ?? ''}  _(${p}companion)_`)
  if (g.offer && g.offer.expiresAt > now) lines.push(`⏳ *${COMPANION_MAP[g.offer.companionId]?.name}* is waiting for your answer: *${p}guardian accept* / *${p}guardian reject*`)

  if (unclaimed.length && !comp) {
    lines.push(``, `⛓️ *Still held somewhere out there:* ${unclaimed.length} of ${COMPANIONS.length}`)
    lines.push(`_Free enough people in one place and whoever holds the one they fear most will come out. Only one player in the world can ever take each of them home._`)
  }

  lines.push(
    ``,
    `🗺️ *${p}guardian map*  ·  🚶 *${p}guardian travel <name>*`,
    `⚔️ *${p}rescue*  ·  🏆 *${p}guardian top*`,
    `🌸 *${p}orihime-spin* _(event banner, 3,000 ☀️ a spin)_`,
  )
  return lines.join('\n')
}

function mapText(ctx) {
  const p = config.prefix
  const db = ctx.db
  const g = ensureGuardianState(ctx.player)
  const now = Date.now()
  const lines = [`🗺️ *GUARDIAN OF THE INNOCENT: LOCATIONS*`, RULE, `_No level requirement anywhere. The slavers size themselves to whoever walks in._`, ``]
  REGIONS.forEach((r, i) => {
    const open = isRegionOpen(db, r, now)
    const here = g.region === r.id ? '  📍_(you are here)_' : ''
    const wins = g.regionWins?.[r.id] ?? 0
    const held = heldAt(db, r)
    lines.push(
      (open ? `${r.emoji} *${i + 1}. ${r.name}*${here}` : `🔒 *${i + 1}. ${r.name}*  _(opens in ${formatTimeLeft(regionOpensAt(db, r) - now)})_`),
    )
    lines.push(`_${r.description}_`)
    const meta = [`🌟 fame x${r.fameMult}`, `🕊️ your rescues here: ${wins}`]
    if (held && !playerCompanion(ctx.player) && !g.rejected?.includes(held.id)) {
      meta.push(wins >= GUARDIAN.companionWinsNeeded ? `⛓️ *someone is waiting behind the last door*` : `⛓️ someone important is held here`)
    }
    lines.push(meta.join('  ·  '), ``)
  })
  lines.push(`Type *${p}guardian travel <name or number>* then *${p}rescue*.`)
  return lines.join('\n')
}

async function doTravel(ctx) {
  const p = config.prefix
  const q = ctx.args.slice(1).join(' ')
  if (!q) return ctx.reply(`🚶 Where to? _Type_ *${p}guardian map* _for the list._`)
  const region = findRegion(q)
  if (!region) return ctx.reply(`❌ No location called "_${q}_". _Type_ *${p}guardian map*.`)
  if (!isGuardianActive(ctx.db)) return ctx.reply(`🔒 The event is not running.`)
  const now = Date.now()
  if (!isRegionOpen(ctx.db, region, now)) {
    return ctx.reply(`🔒 *${region.name}* opens in *${formatTimeLeft(regionOpensAt(ctx.db, region) - now)}*.`)
  }
  let text = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    if (player.inBattle) { text = `⚔️ Finish your current battle first!`; return }
    const g = ensureGuardianState(player)
    rescuesLeftToday(ctx.db, player, now) // syncs the run before we write region
    g.region = region.id
    text =
      `${region.emoji} *${region.name}*\n${RULE}\n` +
      `_${region.arrival}_\n\n` +
      `Type *${p}rescue* to break open the next pen.`
  })
  return ctx.reply(text)
}

async function doAnswer(ctx, accept) {
  const p = config.prefix
  let res = null
  let expired = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    const now = Date.now()
    expired = expireOffer(player, now)
    res = accept ? acceptOffer(ctx.db, player, ctx.from, now) : rejectOffer(player, now)
  })
  if (expired && res?.reason === 'none') {
    return ctx.reply(`_${expired.name} waited as long as ${expired.pronoun === 'they' ? 'they' : 'she'} could. The request has lapsed. The captor will be back after ${GUARDIAN.captorRetryWins} more rescues in that location._`)
  }
  if (!res || res.reason === 'none') return ctx.reply(`🕊️ Nobody is waiting on an answer from you.`)
  const c = res.companion
  if (!res.ok) {
    if (res.reason === 'taken') return ctx.reply(`💔 _Someone else reached ${c.name} first. ${c.name} is theirs now._`)
    if (res.reason === 'has_one') return ctx.reply(`💞 You already have a companion.`)
    return ctx.reply(`⏳ _The request has lapsed._`)
  }
  if (accept) {
    return replyOverImage(ctx, c.image,
      `💞 *${c.name.toUpperCase()} IS YOURS*\n${RULE}\n` +
      `🗣️ _${c.accept}_\n\n` +
      `✨ *${c.perk.name}:* ${c.perk.description}\n\n` +
      `🔒 _Nobody else in the world will ever see ${obj(c)} again._\n` +
      `💬 *${p}companion talk <message>* to talk to ${obj(c)}  ·  📖 *${p}companion story*`)
  }
  return ctx.reply(
    `🕊️ *You let ${c.name} go.*\n${RULE}\n` +
    `🗣️ _${c.reject}_\n\n` +
    `_${c.name} walks off alone. You will not be asked again._`)
}

function topText(ctx) {
  const rows = guardianLeaderboard(ctx.db, 10)
  if (!rows.length) return `🏆 *Guardian of the Innocent* — nobody has freed anyone yet.`
  const medal = ['🥇', '🥈', '🥉']
  return [
    `🏆 *MOST BEASTKIN FREED*`, RULE,
    ...rows.map((r, i) => {
      const c = r.companion ? COMPANION_MAP[r.companion] : null
      return `${medal[i] ?? `${i + 1}.`} *${r.name}*  ·  🕊️ ${r.freed}  ·  ${renownRank(r.freed).emoji}` + (c ? `  ·  💞 ${c.name}` : '')
    }),
  ].join('\n')
}

async function ownerCmd(ctx, sub) {
  const p = config.prefix
  if (!isOwnerJid(ctx.from)) return ctx.reply(`🔒 Owner only.`)
  let text = ''
  if (sub === 'start') {
    const days = Math.max(1, Math.min(30, Math.floor(Number(ctx.args[1]) || GUARDIAN.durationDays)))
    await updateAllPlayers(ctx.db, () => { startGuardianEvent(ctx.db, { days }); return true })
    return replyOverImage(ctx, GUARDIAN.banner,
      `🕊️ *GUARDIAN OF THE INNOCENT HAS BEGUN*\n${RULE}\n_${GUARDIAN.intro}_\n\n` +
      `📅 Runs for *${days}* days. New locations open over the first week.\n\n` +
      `*${p}guardian*  ·  *${p}guardian map*  ·  *${p}rescue*`)
  }
  if (sub === 'end') {
    await updateAllPlayers(ctx.db, () => { endGuardianEvent(ctx.db); return true })
    return ctx.reply(`🔚 Guardian of the Innocent closed. Companions stay with their players.`)
  }
  if (sub === 'skip') {
    const n = Math.max(1, Math.floor(Number(ctx.args[1]) || 1))
    if (!getGuardianEvent(ctx.db).startedAt) return ctx.reply(`❌ Not started.`)
    await updateAllPlayers(ctx.db, () => { skipGuardianDays(ctx.db, n); return true })
    return ctx.reply(`⏩ Moved forward *${n}* day(s). ${eventStatusLine(ctx.db)}`)
  }
  if (sub === 'release') {
    const c = findCompanion(ctx.args.slice(1).join(' '))
    if (!c) return ctx.reply(`❌ Which companion? ${COMPANIONS.map(x => x.id).join(', ')}`)
    await updateAllPlayers(ctx.db, (users) => {
      const prev = releaseCompanionClaim(ctx.db, c.id)
      for (const u of Object.values(users ?? ctx.db.data.users ?? {})) {
        if (u?.guardian?.companion === c.id) { u.guardian.companion = null; u.guardian.trust = 0; u.guardian.chat = [] }
      }
      text = prev ? `🔓 *${c.name}* released from ${prev.split('@')[0]}. ${c.pronoun === 'they' ? 'They are' : 'She is'} held at ${REGION_MAP[c.regionId]?.name} again.` : `ℹ️ ${c.name} was not claimed.`
      return true
    })
    return ctx.reply(text)
  }
  return null
}

export default {
  name: 'guardian',
  aliases: ['goti', 'guardianevent'],
  category: 'event',
  requiresPlayer: true,
  description: 'Guardian of the Innocent: free beastkin captives, grow your fame, and meet the companions',

  async run(ctx) {
    ctx.args = ctx.args ?? []
    const sub = String(ctx.args[0] ?? '').toLowerCase()
    if (['start', 'end', 'skip', 'release'].includes(sub)) return ownerCmd(ctx, sub)
    if (sub === 'map' || sub === 'locations') return ctx.reply(mapText(ctx))
    if (sub === 'travel' || sub === 'go') return doTravel(ctx)
    if (sub === 'accept' || sub === 'yes') return doAnswer(ctx, true)
    if (sub === 'reject' || sub === 'no') return doAnswer(ctx, false)
    if (sub === 'top' || sub === 'lb' || sub === 'leaderboard') return ctx.reply(topText(ctx))
    if (sub === 'offer') {
      const g = ensureGuardianState(ctx.player)
      const c = g.offer && g.offer.expiresAt > Date.now() ? COMPANION_MAP[g.offer.companionId] : null
      return c ? sendCompanionOffer(ctx, c) : ctx.reply(`🕊️ Nobody is waiting on an answer from you.`)
    }
    return replyOverImage(ctx, GUARDIAN.banner, infoText(ctx))
  },
}

export { infoText, mapText }
