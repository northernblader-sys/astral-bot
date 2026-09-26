import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { resolveSwarmMove } from '../lib/swarm-combat.js'

export default {
  name: 'ml', aliases: ['moveleft'],
  category: 'combat', requiresPlayer: true,
  description: 'Shift one lane left in a swarm fight (dodge a committed attacker)',

  async run(ctx) {
    const p = config.prefix
    await updatePlayer(ctx.db, ctx.from, async (player) => {
      if (player.battleState?.mode !== 'swarm') {
        await ctx.reply(`↔️ *${p}ml* only works in a swarm fight. _Enter a dungeon with ${p}dungeon._`)
        return player
      }
      return resolveSwarmMove(player, ctx, 'left')
    })
  },
}
