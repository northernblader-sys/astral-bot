/**
 * deck.js — view all anime cards you own.
 * Usage: .deck
 */
import { config } from '../config.js'
import { tierStars, cardSellPrice, hasCardSeries } from '../lib/card-engine.js'

const PAGE_SIZE = 10

export default {
  name: 'deck',
  aliases: ['cards', 'mycards', 'collection'],
  category: 'cards',
  requiresPlayer: true,
  description: 'View your anime card collection',

  async run(ctx) {
    const { args, reply, player } = ctx
    const cards = player.cards ?? []

    if (!cards.length) {
      return reply(
        `🎴 *${player.name}'s Deck*\n\n` +
        `_Empty._\n\n` +
        `_Cards spawn in enabled groups — grab one with *${config.prefix}collect <code>*._`
      )
    }

    const page = Math.max(1, parseInt(args[0], 10) || 1)
    const totalPages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE))
    const clamped = Math.min(page, totalPages)
    const start = (clamped - 1) * PAGE_SIZE
    const pageItems = [...cards]
      .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0))
      .slice(start, start + PAGE_SIZE)

    const lines = pageItems.map(c => {
      const waifuTag = player.waifuId === c.id ? ' 💘' : ''
      // Hide the 'Unknown' series placeholder — show just the worth when the
      // card has no real series name.
      const meta = [
        hasCardSeries(c.series) ? c.series : null,
        `☀️${cardSellPrice(c.tier)}`,
      ].filter(Boolean).join(' · ')
      return `${tierStars(c.tier)} *${c.title}*${waifuTag}\n     _${meta}_`
    })

    const footer = totalPages > 1
      ? `\n\n📄 _Page ${clamped}/${totalPages}_` + (clamped < totalPages ? `   ▶️ *${config.prefix}deck ${clamped + 1}*` : '')
      : ''

    return reply(
      `🎴 *${player.name}'s Deck* _(${cards.length} card${cards.length === 1 ? '' : 's'})_\n\n` +
      lines.join('\n\n') +
      footer +
      `\n\n_${config.prefix}setwaifu <name>_ · _${config.prefix}sellcard <name>_`
    )
  },
}
