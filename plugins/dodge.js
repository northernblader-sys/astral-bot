import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { resolveSwarmDodge } from '../lib/swarm-combat.js'

export default {
  name: 'dodge', aliases: ['dg'],
  category: 'combat', requiresPlayer: true,
  description: 'Dodge the whole incoming volley in a swarm fight (evade, or graze if late)',

  async run(ctx) {
    const p = config.prefix
    await updatePlayer(ctx.db, ctx.from, async (player) => {
      if (player.battleState?.mode !== 'swarm') {
        await ctx.reply(`🌀 *${p}dodge* only works in a swarm fight. _Enter a dungeon with ${p}dungeon._`)
        return player
      }
      return resolveSwarmDodge(player, ctx)
    })
  },
}
