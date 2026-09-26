/**
 * homebuild.js — add rooms to your house.
 *
 * Rooms are the mechanical half of the housing pillar: each one grants a perk
 * (rest, growth, storage, xp, craft, repair, luck) that other systems read via
 * perkTotal(). Rooms with the same perk stack on purpose — see the note in
 * lib/housing-engine.js.
 *
 * Commands:
 *   .homebuild                — rooms you can build now, and what's locked
 *   .homebuild <room>         — build it
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  ensureHome, hasHome, tierOf, ROOMS, roomMap,
  availableRooms, roomSlotsLeft, perkTotal,
} from '../lib/housing-engine.js'

const PERK_LABEL = {
  rest: 'rest recovery',
  cook: 'cooking',
  craft: 'crafting discount',
  xp: 'XP bonus',
  growth: 'crop speed',
  storage: 'home storage',
  repair: 'repair discount',
  luck: 'luck',
}

const noHome = () =>
  `🏕️ *You need a home first.*\n\n*${config.prefix}home claim* — free tent`

function findRoom(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return undefined
  if (roomMap[q]) return roomMap[q]
  return ROOMS.find(r => r.name.toLowerCase().includes(q))
}

function buildView(ctx) {
  const p = config.prefix
  const player = ctx.player
  ensureHome(player)
  if (!hasHome(player)) return noHome()

  const tier = tierOf(player)
  const slots = roomSlotsLeft(player)
  const built = new Set(player.home.rooms)
  const open = availableRooms(player)
  const locked = ROOMS.filter(r => r.minRank > tier.rank)

  const lines = [
    `🔨 *BUILD A ROOM*`,
    `_${tier.name} — ${player.home.rooms.length}/${tier.rooms} rooms used_`,
    '',
  ]

  if (built.size) {
    lines.push(`*Already built*`)
    for (const id of player.home.rooms) {
      const room = roomMap[id]
      if (room) lines.push(`  ✅ *${room.name}* — +${room.value} ${PERK_LABEL[room.perk] ?? room.perk}`)
    }
    lines.push('')
  }

  if (!slots) {
    lines.push(
      `⚠️ *No room slots left.*`,
      `Upgrade your house with *${p}home upgrade* to build more.`,
      '',
    )
  }

  if (open.length) {
    lines.push(`*Available*`)
    for (const room of open) {
      lines.push(
        `*${room.name}* — ☀️ ${room.solars.toLocaleString()}`,
        `  _${room.blurb}_`,
      )
    }
    lines.push('')
  } else if (slots) {
    lines.push(`_You've built everything your tier allows._`, '')
  }

  if (locked.length) {
    lines.push(`*Locked* _(needs a bigger house)_`)
    for (const room of locked) lines.push(`  🔒 ${room.name}`)
    lines.push('')
  }

  lines.push(`*${p}homebuild <room>* — build one`)
  lines.push(`*${p}homedecor* — furnish instead`)
  return lines.join('\n')
}

export default {
  name: 'homebuild',
  aliases: ['build', 'hbuild'],
  category: 'housing',
  description: 'Build rooms in your house for permanent perks',
  subcommands: [
    { cmd: '<room>', desc: 'build it — see .homebuild alone for the list' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    const p = config.prefix
    if (!hasHome(ctx.player)) return ctx.reply(noHome())
    if (!ctx.args.length) return ctx.reply(buildView(ctx))

    const query = ctx.args.join(' ')
    const room = findRoom(query)
    if (!room) {
      return ctx.reply(`❌ *No room called* "_${query}_".\n_See_ *${p}homebuild* _for the list._`)
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      const home = ensureHome(player)
      const tier = tierOf(player)

      if (home.rooms.includes(room.id)) { outcome = { reason: 'dupe' }; return player }
      if (room.minRank > tier.rank) { outcome = { reason: 'locked', tier }; return player }
      if (roomSlotsLeft(player) <= 0) { outcome = { reason: 'noslots', tier }; return player }

      const wallet = player.wallet ?? (player.wallet = {})
      const solars = wallet.solars ?? 0
      if (solars < room.solars) { outcome = { reason: 'poor', have: solars }; return player }

      wallet.solars = solars - room.solars
      home.rooms.push(room.id)
      outcome = {
        reason: 'ok',
        used: home.rooms.length,
        cap: tier.rooms,
        total: perkTotal(player, room.perk),
        balance: wallet.solars,
      }
      return player
    })

    if (outcome.reason === 'dupe') {
      return ctx.reply(`❌ *You already have a ${room.name}.*`)
    }
    if (outcome.reason === 'locked') {
      return ctx.reply(
        `🔒 *${room.name}* needs a bigger house.\n` +
        `You're at *${outcome.tier.name}* — see *${p}home tiers*.`,
      )
    }
    if (outcome.reason === 'noslots') {
      return ctx.reply(
        `🚪 *All ${outcome.tier.rooms} room slots are full.*\n` +
        `*${p}home upgrade* to make space.`,
      )
    }
    if (outcome.reason === 'poor') {
      return ctx.reply(
        `❌ *Not enough Solars.*\n*${room.name}* costs ☀️ *${room.solars.toLocaleString()}* — ` +
        `you have ☀️ *${outcome.have.toLocaleString()}*.`,
      )
    }

    return ctx.reply(
      `🔨 *${room.name} built!*\n\n` +
      `_${room.blurb}_\n\n` +
      `📈 ${PERK_LABEL[room.perk] ?? room.perk}: *+${outcome.total}*` +
      `${outcome.total !== room.value ? ` _(stacked)_` : ''}\n` +
      `🚪 Rooms: *${outcome.used}/${outcome.cap}*\n` +
      `☀️ Balance: *${outcome.balance.toLocaleString()}*`,
    )
  },
}
