/**
 * homedecor.js — furnish your house.
 *
 * Decor is the cosmetic half of the pillar and it feeds exactly one number:
 * comfort. Comfort is what the neighborhood map (.neighborhood) ranks houses
 * by, so decor is the visible flex rather than a stat boost — rooms do stats.
 *
 * Commands:
 *   .homedecor                — the catalog and what you've placed
 *   .homedecor <item>         — place it
 *   .homedecor remove <item>  — take it back down (no refund)
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  ensureHome, hasHome, tierOf, DECOR, decorMap,
  decorSlotsLeft, comfortOf,
} from '../lib/housing-engine.js'

const noHome = () =>
  `🏕️ *You need a home first.*\n\n*${config.prefix}home claim* — free tent`

function findDecor(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return undefined
  if (decorMap[q]) return decorMap[q]
  return DECOR.find(d => d.name.toLowerCase().includes(q))
}

function decorView(ctx) {
  const p = config.prefix
  const player = ctx.player
  ensureHome(player)
  if (!hasHome(player)) return noHome()

  const tier = tierOf(player)
  const placed = player.home.decor
  const free = decorSlotsLeft(player)

  const lines = [
    `🖼️ *DECOR*`,
    `_${tier.name} — ${placed.length}/${tier.decorSlots} slots used_`,
    `✨ Comfort: *${comfortOf(player)}*`,
    '',
  ]

  if (placed.length) {
    lines.push(`*Placed*`)
    for (const id of placed) {
      const d = decorMap[id]
      if (d) lines.push(`  ✅ *${d.name}* — ✨ ${d.comfort}`)
    }
    lines.push('')
  }

  const owned = new Set(placed)
  const shop = DECOR.filter(d => !owned.has(d.id))
  if (shop.length) {
    lines.push(`*Catalog*`)
    for (const d of shop) {
      lines.push(`  *${d.name}* — ☀️ ${d.solars.toLocaleString()}  ·  ✨ +${d.comfort}`)
    }
    lines.push('')
  }

  if (!free) {
    lines.push(`⚠️ *No decor slots left* — *${p}home upgrade* for more, or *${p}homedecor remove <item>*.`, '')
  }

  lines.push(`*${p}homedecor <item>* — place it`)
  lines.push(`*${p}neighborhood* — see how your comfort ranks`)
  return lines.join('\n')
}

async function handleRemove(ctx, args) {
  const p = config.prefix
  const query = args.join(' ').trim()
  if (!query) return ctx.reply(`❌ *Usage:* *${p}homedecor remove <item>*`)

  const decor = findDecor(query)
  if (!decor) return ctx.reply(`❌ *No decor called* "_${query}_".`)

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const home = ensureHome(player)
    const at = home.decor.indexOf(decor.id)
    if (at === -1) { outcome = { reason: 'notplaced' }; return player }
    home.decor.splice(at, 1)
    outcome = { reason: 'ok', comfort: comfortOf(player), left: decorSlotsLeft(player) }
    return player
  })

  if (outcome.reason === 'notplaced') {
    return ctx.reply(`❌ *You haven't placed a ${decor.name}.*`)
  }
  return ctx.reply(
    `📦 *${decor.name} taken down.*\n` +
    `_No refund — you kept the nails._\n\n` +
    `✨ Comfort: *${outcome.comfort}*   🖼️ Free slots: *${outcome.left}*`,
  )
}

export default {
  name: 'homedecor',
  aliases: ['decor', 'hdecor'],
  category: 'housing',
  description: 'Furnish your house and raise its comfort rating',
  subcommands: [
    { cmd: '<item>', desc: 'place it — comfort drives your street ranking' },
    { cmd: 'remove <item>', desc: 'take it down and free the slot (no refund)' },
  ],
  requiresPlayer: true,

  async run(ctx) {
    const p = config.prefix
    if (!hasHome(ctx.player)) return ctx.reply(noHome())

    const sub = (ctx.args[0] ?? '').toLowerCase()
    if (sub === 'remove' || sub === 'sell' || sub === 'take') {
      return handleRemove(ctx, ctx.args.slice(1))
    }
    if (!ctx.args.length) return ctx.reply(decorView(ctx))

    const query = ctx.args.join(' ')
    const decor = findDecor(query)
    if (!decor) {
      return ctx.reply(`❌ *No decor called* "_${query}_".\n_See_ *${p}homedecor* _for the catalog._`)
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      const home = ensureHome(player)
      const tier = tierOf(player)

      if (home.decor.includes(decor.id)) { outcome = { reason: 'dupe' }; return player }
      if (decorSlotsLeft(player) <= 0) { outcome = { reason: 'noslots', cap: tier.decorSlots }; return player }

      const wallet = player.wallet ?? (player.wallet = {})
      const solars = wallet.solars ?? 0
      if (solars < decor.solars) { outcome = { reason: 'poor', have: solars }; return player }

      wallet.solars = solars - decor.solars
      home.decor.push(decor.id)
      outcome = {
        reason: 'ok',
        comfort: comfortOf(player),
        used: home.decor.length,
        cap: tier.decorSlots,
        balance: wallet.solars,
      }
      return player
    })

    if (outcome.reason === 'dupe') {
      return ctx.reply(`❌ *You already have a ${decor.name} up.*`)
    }
    if (outcome.reason === 'noslots') {
      return ctx.reply(
        `🖼️ *All ${outcome.cap} decor slots are full.*\n` +
        `*${p}homedecor remove <item>* to swap, or *${p}home upgrade* for more wall.`,
      )
    }
    if (outcome.reason === 'poor') {
      return ctx.reply(
        `❌ *Not enough Solars.*\n*${decor.name}* costs ☀️ *${decor.solars.toLocaleString()}* — ` +
        `you have ☀️ *${outcome.have.toLocaleString()}*.`,
      )
    }

    return ctx.reply(
      `🖼️ *${decor.name} placed!*\n\n` +
      `✨ Comfort: *${outcome.comfort}* _(+${decor.comfort})_\n` +
      `🖼️ Decor: *${outcome.used}/${outcome.cap}*\n` +
      `☀️ Balance: *${outcome.balance.toLocaleString()}*\n\n` +
      `*${p}neighborhood* — see where that puts you`,
    )
  },
}
