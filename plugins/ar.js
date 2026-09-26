import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { resolveSwarmDirectionalAttack } from '../lib/swarm-combat.js'

export default {
  name: 'ar', aliases: ['attackright'],
  category: 'combat', requiresPlayer: true,
  description: 'Strike the monster on your right in a swarm fight',

  async run(ctx) {
    const p = config.prefix
    await updatePlayer(ctx.db, ctx.from, async (player) => {
      if (player.battleState?.mode !== 'swarm') {
        await ctx.reply(`▶ *${p}ar* only works in a swarm fight. _In a 1v1 fight use ${p}attack._`)
        return player
      }
      return resolveSwarmDirectionalAttack(player, ctx, 'right')
    })
  },
}
