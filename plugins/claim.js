/**
 * claim.js — grab a spawned anime card by its claim code.
 * Usage: .claim <code>
 * See handler.js for the spawn hook and lib/card-engine.js for storage.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { addCardToPlayer, tierStars, cardSellPrice } from '../lib/card-engine.js'
import { getActiveSpawn, clearActiveSpawn } from '../lib/card-spawn-state.js'

export default {
  name: 'claim',
  aliases: ['grab'],
  category: 'cards',
  requiresPlayer: true,
  description: 'Claim a spawned anime card with its claim code',

  async run(ctx) {
    const { args, reply, sender, player } = ctx
    const code = (args[0] ?? '').trim()
    if (!code) return reply(`❌ *Usage:* *${config.prefix}claim <code>*`)

    const spawn = getActiveSpawn(sender)
    if (!spawn) return reply(`❌ *No card is currently spawned here.*`)
    if (spawn.claim.toLowerCase() !== code.toLowerCase()) {
      return reply(`❌ *Wrong code!* That card is still up for grabs.`)
    }

    clearActiveSpawn(sender)

    await updatePlayer(ctx.db, player.id, p => {
      addCardToPlayer(p, spawn)
    })

    return reply(
      `🎉 *${player.name}* claimed the card!\n\n` +
      `${tierStars(spawn.tier)} *${spawn.title}*\n` +
      `📺 _${spawn.series}_\n` +
      `☀️ Worth: *${cardSellPrice(spawn.tier)}* Solars _(if sold)_\n\n` +
      `_Set as your waifu with *${config.prefix}setwaifu ${spawn.title}*, or sell with *${config.prefix}sellcard ${spawn.title}*._`
    )
  },
}
