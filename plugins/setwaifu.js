/**
 * setwaifu.js — pick one of your owned cards as your waifu.
 * Usage: .setwaifu <card name>
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { setWaifu, tierStars, hasCardSeries } from '../lib/card-engine.js'

export default {
  name: 'setwaifu',
  aliases: ['setwife', 'waifuchoose'],
  category: 'cards',
  requiresPlayer: true,
  description: 'Set your waifu from your owned anime cards',

  async run(ctx) {
    const { args, reply, player } = ctx
    const query = args.join(' ').trim()
    if (!query) return reply(`❌ *Usage:* *${config.prefix}setwaifu <card name>*`)

    let chosen = null
    await updatePlayer(ctx.db, player.id, p => {
      chosen = setWaifu(p, query)
    })

    if (!chosen) {
      return reply(
        `❌ *You don't own a card matching* "_${query}_"*.\n` +
        `_Use *${config.prefix}collect <code>* to grab cards as they spawn._`
      )
    }

    return reply(
      `💘 *Waifu set!*\n\n` +
      `${tierStars(chosen.tier)} *${chosen.title}*\n` +
      (hasCardSeries(chosen.series) ? `📺 _${chosen.series}_\n` : '') +
      `\n_Check her out anytime with *${config.prefix}waifu*._`
    )
  },
}
