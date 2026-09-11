/**
 * homeinvite.js — the guest list, visiting, and parties.
 *
 * One plugin owns all three commands because they're one feature seen from
 * three sides: `home.visitors[]` is the only state, .homeinvite writes it,
 * .homevisit reads it, and .homeparty spends it. Which command was typed is
 * read off ctx.cmd, the same way farm.js splits .plant from .harvest.
 *
 * Commands:
 *   .homeinvite @user        — add someone to your guest list
 *   .homeinvite remove @user — revoke access
 *   .homeinvite              — who can walk in
 *   .homevisit @user         — look around a home you're invited to
 *   .homeparty               — throw one; guests recover HP/MP with you
 */
import { config } from '../config.js'
import { getPlayer, playerExists, updatePlayer } from '../lib/player-repo.js'
import {
  ensureHome, hasHome, tierOf, comfortOf, storageCap, plotCap,
  splitPlots, roomMap, decorMap, perkTotal,
  cooldownLeft, formatRemaining,
} from '../lib/housing-engine.js'

const MAX_VISITORS = 25
const PARTY_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** Party cost scales with the house you're showing off. */
const PARTY_BASE_COST = 2000

const noHome = () =>
  `🏕️ *You need a home first.*\n\n*${config.prefix}home claim* — free tent`

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

const shortJid = jid => String(jid).replace(/@.*/, '')

function nameOf(db, jid) {
  return getPlayer(db, jid)?.name ?? `Unknown (${shortJid(jid)})`
}

// ── Guest list ────────────────────────────────────────────────────────

function listView(ctx) {
  const p = config.prefix
  const home = ensureHome(ctx.player)
  const lines = [`🔑 *YOUR GUEST LIST* _(${home.visitors.length}/${MAX_VISITORS})_`, '']

  if (!home.visitors.length) {
    lines.push(`_Nobody can let themselves in yet._`, '')
  } else {
    for (const jid of home.visitors) lines.push(`  👤 *${nameOf(ctx.db, jid)}*`)
    lines.push('')
  }

  lines.push(`*${p}homeinvite @user* — add someone`)
  lines.push(`*${p}homeinvite remove @user* — revoke`)
  lines.push(`*${p}homeparty* — throw a party for them`)
  return lines.join('\n')
}

async function handleInvite(ctx, raw) {
  const p = config.prefix
  const targetJid = resolveTargetJid(ctx, raw)
  if (!targetJid) return ctx.reply(`❓ *Usage:* *${p}homeinvite @user*`)
  if (targetJid === ctx.from) return ctx.reply(`❌ You already live there.`)
  if (!playerExists(ctx.db, targetJid)) return ctx.reply(`❌ That player isn't registered yet.`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    if (home.visitors.includes(targetJid)) { outcome = { reason: 'dupe' }; return player }
    if (home.visitors.length >= MAX_VISITORS) { outcome = { reason: 'full' }; return player }
    home.visitors.push(targetJid)
    outcome = { reason: 'ok', count: home.visitors.length }
    return player
  })

  const who = nameOf(ctx.db, targetJid)
  if (outcome.reason === 'dupe') return ctx.reply(`❌ *${who}* is already on your guest list.`)
  if (outcome.reason === 'full') {
    return ctx.reply(`🔑 *Guest list is full* _(${MAX_VISITORS})_.\n*${p}homeinvite remove @user* to make room.`)
  }

  return ctx.reply(
    `🔑 *${who} can now visit.*\n` +
    `_They can look around with_ *${p}homevisit @you*.\n\n` +
    `👥 Guests: *${outcome.count}/${MAX_VISITORS}*`,
  )
}

async function handleRevoke(ctx, raw) {
  const p = config.prefix
  const targetJid = resolveTargetJid(ctx, raw)
  if (!targetJid) return ctx.reply(`❓ *Usage:* *${p}homeinvite remove @user*`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const at = home.visitors.indexOf(targetJid)
    if (at === -1) { outcome = { reason: 'notthere' }; return player }
    home.visitors.splice(at, 1)
    outcome = { reason: 'ok', count: home.visitors.length }
    return player
  })

  const who = nameOf(ctx.db, targetJid)
  if (outcome.reason === 'notthere') return ctx.reply(`❌ *${who}* wasn't on your guest list.`)
  return ctx.reply(`🚪 *${who} can no longer let themselves in.*\n👥 Guests: *${outcome.count}*`)
}

// ── Visiting ──────────────────────────────────────────────────────────

async function handleVisit(ctx) {
  const p = config.prefix
  const targetJid = resolveTargetJid(ctx, ctx.args[0])
  if (!targetJid) return ctx.reply(`❓ *Usage:* *${p}homevisit @user*`)
  if (targetJid === ctx.from) return ctx.reply(`🏠 That's your own house — *${p}home*.`)
  if (!playerExists(ctx.db, targetJid)) return ctx.reply(`❌ That player isn't registered yet.`)

  const host = getPlayer(ctx.db, targetJid)
  if (!hasHome(host)) return ctx.reply(`🏕️ *${host.name} doesn't have a home yet.*`)

  const visitors = host.home?.visitors ?? []
  if (!visitors.includes(ctx.from)) {
    return ctx.reply(
      `🚪 *The door's locked.*\n` +
      `*${host.name}* hasn't invited you in. Ask them to run *${p}homeinvite @you*.`,
    )
  }

  const tier = tierOf(host)
  const { ready, growing } = splitPlots(host)
  const lines = [
    `🏠 *${host.name.toUpperCase()}'S ${tier.name.toUpperCase()}*`,
    `_${tier.blurb}_`,
    '',
    `✨ Comfort: *${comfortOf(host)}*   🛏️ Rest: *+${(tier.restBonus ?? 0) + perkTotal(host, 'rest')}%*`,
    `🚪 Rooms: *${host.home.rooms.length}/${tier.rooms}*   🖼️ Decor: *${host.home.decor.length}/${tier.decorSlots}*`,
    `🌱 Plots: *${host.home.plots.length}/${plotCap(host)}*   📦 Storage: *${host.home.storage.length}/${storageCap(host)}*`,
  ]

  if (host.home.rooms.length) {
    lines.push('', `*Rooms*`)
    for (const id of host.home.rooms) {
      const room = roomMap[id]
      if (room) lines.push(`  • *${room.name}* — _${room.blurb}_`)
    }
  }
  if (host.home.decor.length) {
    lines.push('', `*Decor*`, `  ${host.home.decor.map(id => decorMap[id]?.name ?? id).join(', ')}`)
  }
  if (ready.length || growing.length) {
    lines.push('', `*Out back*`, `  🌾 ${ready.length + growing.length} plot${ready.length + growing.length === 1 ? '' : 's'} planted` +
      `${ready.length ? ` _(${ready.length} ripe — not yours to pick)_` : ''}`)
  }

  lines.push('', `_You're a guest here. Look, don't take._`)
  lines.push(`*${p}neighborhood* — the whole street`)
  return ctx.reply(lines.join('\n'))
}

// ── Party ─────────────────────────────────────────────────────────────

async function handleParty(ctx) {
  const p = config.prefix
  if (!hasHome(ctx.player)) return ctx.reply(noHome())

  const comfort = comfortOf(ctx.player)
  const guests = (ctx.player.home?.visitors ?? []).filter(jid => playerExists(ctx.db, jid))
  if (!guests.length) {
    return ctx.reply(
      `🎉 *A party of one is just you, at home.*\n` +
      `*${p}homeinvite @user* — get some guests on the list first.`,
    )
  }

  const cost = PARTY_BASE_COST + comfort * 250 + guests.length * 500
  // Recovery is comfort-driven: a bare tent is a polite gathering, an estate
  // with a chandelier actually restores people.
  const pct = Math.min(60, 10 + Math.floor(comfort / 2))

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const left = cooldownLeft(home.lastParty, PARTY_COOLDOWN_MS)
    if (left > 0) { outcome = { reason: 'cooldown', left }; return player }

    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    if (solars < cost) { outcome = { reason: 'poor', have: solars }; return player }

    wallet.solars = solars - cost
    home.lastParty = Date.now()

    const maxHp = player.maxHp ?? 100
    const maxMp = player.maxMp ?? 50
    player.hp = Math.min(maxHp, (player.hp ?? maxHp) + Math.max(1, Math.round(maxHp * pct / 100)))
    player.mp = Math.min(maxMp, (player.mp ?? maxMp) + Math.max(1, Math.round(maxMp * pct / 100)))

    outcome = { reason: 'ok', balance: wallet.solars, hp: player.hp, maxHp, mp: player.mp, maxMp }
    return player
  })

  if (outcome.reason === 'cooldown') {
    return ctx.reply(
      `🎉 *The last party hasn't been cleaned up yet.*\nThrow another in *${formatRemaining(outcome.left)}*.`,
    )
  }
  if (outcome.reason === 'poor') {
    return ctx.reply(
      `❌ *You can't afford the spread.*\n` +
      `A party for *${guests.length}* guest${guests.length === 1 ? '' : 's'} costs ☀️ *${cost.toLocaleString()}* — ` +
      `you have ☀️ *${outcome.have.toLocaleString()}*.`,
    )
  }

  // Guests are topped up in their own write, after the host's. Each is its own
  // updatePlayer so one unregistered or broken record can't roll back the rest.
  const fed = []
  for (const jid of guests) {
    await updatePlayer(ctx.db, jid, guest => {
      const maxHp = guest.maxHp ?? 100
      const maxMp = guest.maxMp ?? 50
      guest.hp = Math.min(maxHp, (guest.hp ?? maxHp) + Math.max(1, Math.round(maxHp * pct / 100)))
      guest.mp = Math.min(maxMp, (guest.mp ?? maxMp) + Math.max(1, Math.round(maxMp * pct / 100)))
      return guest
    })
    fed.push(nameOf(ctx.db, jid))
  }

  return ctx.reply(
    `🎉 *PARTY AT YOUR PLACE!* _(+${pct}% recovery)_\n\n` +
    `✨ Comfort: *${comfort}*   💸 Spent: ☀️ *${cost.toLocaleString()}*\n` +
    `❤️ HP: *${outcome.hp}/${outcome.maxHp}*   💙 MP: *${outcome.mp}/${outcome.maxMp}*\n\n` +
    `*Guests topped up (${fed.length})*\n` +
    `  ${fed.join(', ')}\n\n` +
    `_Again in ${formatRemaining(PARTY_COOLDOWN_MS)}. Raise comfort with_ *${p}homedecor* _for a better one._`,
  )
}

// ── Entry ─────────────────────────────────────────────────────────────

export default {
  name: 'homeinvite',
  aliases: ['homevisit', 'homeparty', 'hinvite'],
  category: 'housing',
  description: 'Invite players over, visit their homes, throw a party',
  subcommands: [
    { cmd: '@user', desc: 'add someone to your guest list' },
    { cmd: 'remove @user', desc: 'revoke their access' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    const invoked = (ctx.cmd ?? '').toLowerCase()
    if (invoked === 'homevisit') return handleVisit(ctx)
    if (invoked === 'homeparty') return handleParty(ctx)

    if (!hasHome(ctx.player)) return ctx.reply(noHome())

    const sub = (ctx.args[0] ?? '').toLowerCase()
    if (sub === 'remove' || sub === 'revoke' || sub === 'kick') {
      return handleRevoke(ctx, ctx.args[1])
    }
    if (sub === 'visit') return handleVisit({ ...ctx, args: ctx.args.slice(1) })
    if (sub === 'party') return handleParty(ctx)
    if (!ctx.args.length) return ctx.reply(listView(ctx))

    return handleInvite(ctx, ctx.args[0])
  },
}
