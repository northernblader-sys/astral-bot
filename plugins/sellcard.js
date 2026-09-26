/**
 * sellcard.js — sell an owned anime card for Solars, priced by tier/rarity.
 * Usage: .sellcard <card name>
 * See lib/card-engine.js for cardSellPrice() and findOwnedCard().
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { findOwnedCard, cardSellPrice, tierStars } from '../lib/card-engine.js'

export default {
  name: 'sellcard',
  aliases: ['cardsell'],
  category: 'cards',
  requiresPlayer: true,
  description: 'Sell one of your anime cards for Solars (priced by rarity)',

  async run(ctx) {
    const { args, reply, player } = ctx
    const query = args.join(' ').trim()
    if (!query) return reply(`❌ *Usage:* *${config.prefix}sellcard <card name>*`)

    let outcome = null
    await updatePlayer(ctx.db, player.id, p => {
      const card = findOwnedCard(p, query)
      if (!card) { outcome = { ok: false }; return }

      // Can't sell your currently-set waifu without unsetting her first —
      // avoids accidentally selling the card .me is displaying.
      if (p.waifuId === card.id) { outcome = { ok: false, isWaifu: true, card }; return }

      const price = cardSellPrice(card.tier)
      p.cards = (p.cards ?? []).filter(c => c.id !== card.id)
      p.wallet.solars = (p.wallet?.solars ?? 0) + price

      outcome = { ok: true, card, price, balance: p.wallet.solars }
    })

    if (!outcome?.ok) {
      if (outcome?.isWaifu) {
        return reply(
          `❌ *${outcome.card.title}* is your current waifu — can't sell her.\n` +
          `_Set a different waifu with *${config.prefix}setwaifu <name>* first._`
        )
      }
      return reply(`❌ *You don't own a card matching* "_${query}_"*.`)
    }

    return reply(
      `💰 *Sold!*\n\n` +
      `${tierStars(outcome.card.tier)} *${outcome.card.title}*\n` +
      `☀️ Earned: *${outcome.price}* Solars\n` +
      `☀️ Balance: *${outcome.balance}*`
    )
  },
}
