import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'

/**
 * Season 1 deliberately uses one command for both checkpoint items.
 * A cracked shard is the starter version and may only be placed outside
 * a dungeon; a full pearl can be placed anywhere.
 */
export default {
  name: 'setpearl',
  aliases: ['placepearl'],
  category: 'season',
  requiresPlayer: true,
  description: 'Place an Ender Pearl or Cracked Ender Shard checkpoint',

  async run(ctx) {
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      const inventory = player.inventory ?? []
      const pearlId = inventory.includes('ender_pearl') ? 'ender_pearl'
        : inventory.includes('cracked_ender_shard') ? 'cracked_ender_shard'
        : null
      if (!pearlId) {
        outcome = { reason: 'missing' }
        return player
      }
      if (pearlId === 'cracked_ender_shard' && (player.inBattle || player.inDungeon)) {
        outcome = { reason: 'shardOutside' }
        return player
      }
      player.placedPearl = {
        itemId: pearlId,
        location: player.location ?? 'astral_town',
        placedAt: Date.now(),
      }
      outcome = {
        reason: 'ok',
        itemId: pearlId,
        location: player.placedPearl.location,
      }
      return player
    })

    if (outcome.reason === 'missing') {
      return ctx.reply(`❌ You need an *Ender Pearl* or *Cracked Ender Shard* first.`)
    }
    if (outcome.reason === 'shardOutside') {
      return ctx.reply(`❌ The Cracked Ender Shard can only be placed outside a dungeon.`)
    }
    return ctx.reply(
      `📍 *Checkpoint placed!*\n` +
      `${outcome.itemId === 'ender_pearl' ? 'Ender Pearl' : 'Cracked Ender Shard'} is anchored at *${outcome.location}*.\n` +
      `_It is consumed if it saves you from a dungeon death._`,
    )
  },
}