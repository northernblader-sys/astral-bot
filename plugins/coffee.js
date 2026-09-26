/**
 * plugins/coffee.js — order a cup at an empire's coffee house.
 *
 * The one interactive walkable spot: a visitor (or citizen, or the ruler) buys a
 * drink and the coin drops straight into that empire's treasury. It is pure
 * flavor plus an owner-income sink. No stats change (stats are locked) and
 * nothing is minted: the price simply moves from a wallet to a treasury in ONE
 * serialized mutator, the same way a market sale credits the seller. Ordering
 * also steps you up to the counter (sets player.empireSpot), so .goto and .order
 * agree on where you are. Never broadcasts.
 *
 * "Where am I standing?" is resolved by standingIn() from plugins/goto.js, so a
 * visited empire's coffee house serves you while you are there, and your own (or
 * one you are sworn to) serves you at home.
 *
 * Phase 9: when the RULER orders, the round lifts every named resident's favor
 * (see plugins/folk.js). That is the only extra effect, and it rides the same
 * single mutator, so a cup is still one write.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { ensureEmpiresInitialized } from '../lib/empire-repo.js'
import { coffeeHouseBuilt, coffeeMenu, coffeeDrink, cupFavorForFolk } from '../lib/empire-engine.js'
import { standingIn } from './goto.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'

async function gate(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      await ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
      return false
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  return true
}

/** The drinks board (read-only): names, prices, and how to order. */
function renderBoard(record, walletSolars, p) {
  const lines = [`☕ *The Coffee House of ${record.name}*`, RULE]
  for (const d of coffeeMenu()) {
    lines.push(`☕ *${d.name}*  ·  ${d.price.toLocaleString()} solars`)
  }
  lines.push('')
  lines.push(`_Order with *${p}order <drink>*. Every cup funds ${record.name}'s treasury._`)
  lines.push(`_Your wallet: *${walletSolars.toLocaleString()} solars*._`)
  return lines.join('\n')
}

export default {
  name:           'order',
  aliases:        ['coffee', 'cafe', 'brew'],
  category:       'empire',
  requiresPlayer: true,
  description:    'Order a drink at an empire coffee house (the coin funds its treasury)',

  async run(ctx) {
    const p = config.prefix
    if (!(await gate(ctx))) return

    const { record, rel } = standingIn(ctx)
    if (!record) {
      return ctx.reply(
        `☕ You are not standing in any empire, so there is no counter to order at.\n` +
        `_Travel to one with *${p}empire visit <name>*, or found your own with *${p}empire found <name>*._`
      )
    }
    if (!coffeeHouseBuilt(record)) {
      return ctx.reply(
        rel === 'owner'
          ? `☕ *${record.name}* has no coffee house yet.\n` +
            `_Raise one with *${p}empire build coffee_house* (needs Village rank), then folk can gather and spend here._`
          : `☕ *${record.name}* has no coffee house to order at.`
      )
    }

    const me = ctx.db.data.users?.[ctx.from] ?? ctx.player
    const have = Math.max(0, Math.floor(Number(me?.wallet?.solars) || 0))
    const query = ctx.args.join(' ').trim()

    // Bare .order / .coffee — read the board. No write, no move.
    if (!query) return ctx.reply(renderBoard(record, have, p))

    const drink = coffeeDrink(query)
    if (!drink) {
      const names = coffeeMenu().map(d => d.name).join(', ')
      return ctx.reply(
        `☕ *"${query}"* isn't on the board.\n` +
        `_Today: ${names}. Order with *${p}order <drink>*._`
      )
    }
    if (have < drink.price) {
      return ctx.reply(`💸 A *${drink.name}* costs *${drink.price.toLocaleString()} solars*. Your wallet has *${have.toLocaleString()}*.`)
    }

    // ONE mutator: the wallet debit and the treasury credit are the same
    // serialized write, so no coin can appear or vanish in between. Ordering also
    // steps you up to the counter so .goto agrees on where you are standing.
    const recId = record.id
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      const rec = ctx.db.data.empires?.[recId]
      if (!rec) { outcome = { reason: 'missing' }; return player }
      const wallet = player.wallet ?? (player.wallet = {})
      const bal = Math.max(0, Math.floor(Number(wallet.solars) || 0))
      if (bal < drink.price) { outcome = { reason: 'poor', have: bal }; return player }
      wallet.solars = bal - drink.price
      rec.treasury = Math.max(0, Math.floor(Number(rec.treasury) || 0)) + drink.price
      rec.lastActiveAt = Date.now()
      player.empireSpot = 'coffee'
      // When the RULER is the one at the counter, the whole room notices: every
      // named resident gains favor (see the Townsfolk section of empire-engine).
      // A visitor's cup funds the treasury and nothing more, since buying your
      // own drink somewhere else is not the same as your lord standing a round.
      const lifted = rel === 'owner' ? cupFavorForFolk(rec, Date.now()) : 0
      outcome = { reason: 'ok', wallet: wallet.solars, lifted }
      return player
    })

    if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire record could not be found.`)
    if (outcome?.reason === 'poor') {
      return ctx.reply(`💸 A *${drink.name}* costs *${drink.price.toLocaleString()} solars*. Your wallet has *${outcome.have.toLocaleString()}*.`)
    }

    return ctx.reply(
      `☕ *One ${drink.name}, coming up.*\n` +
      `_${drink.line}_\n\n` +
      (outcome.lifted
        ? `🏘️ You stand a round for the house. *${outcome.lifted}* ${outcome.lifted === 1 ? 'resident' : 'residents'} warm to you.\n`
        : '') +
      `*${drink.price.toLocaleString()} solars* go to ${record.name}'s treasury. Your wallet: *${outcome.wallet.toLocaleString()} solars*.`
    )
  },
}
