/**
 * where.js — where you actually are.
 *
 * Dungeon first, then the town street. Empire interiors stay on .goto.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { locationsMap } from '../lib/game-data.js'
import { spotOf, npcsAt } from '../lib/town.js'
import { nextHint, ensureBoardState } from '../lib/guild-board.js'

export default {
  name: 'where',
  aliases: ['whereami', 'location'],
  category: 'town',
  requiresPlayer: true,
  description: 'Where you are standing: a dungeon floor, or a street in Astral Town',

  async run(ctx) {
    const p = config.prefix
    const player = ctx.player
    let hint = null
    await updatePlayer(ctx.db, ctx.from, fresh => {
      ensureBoardState(fresh)
      hint = nextHint(fresh)
      return fresh
    })

    if (player.inDungeon || (player.inBattle && player.location && player.location !== 'astral_town')) {
      const loc = locationsMap[player.location]
      const floor = player.dungeonFloor || player.battleState?.floor || 1
      const total = loc?.floors ? `/${loc.floors}` : ''
      return ctx.reply(
        `🗺️ *${loc?.name ?? player.location ?? 'A dungeon'}*\n` +
        `Floor *${floor}${total}*${player.inBattle ? '  ·  in a fight' : ''}\n\n` +
        (hint ? `📜 ${hint}\n` : '') +
        `*${p}dungeon* to go on  ·  *${p}dungeon leave* to come back to town`,
      )
    }

    const spot = spotOf(player.townSpot)
    if (!spot) {
      return ctx.reply(
        `🧭 *Astral Town.* You have not picked a street yet.\n\n` +
        `_The shop and the inn are still open. Walking is optional until a slip asks for it._\n` +
        `*${p}town* to see the streets.` +
        (hint ? `\n\n📜 ${hint}` : ''),
      )
    }

    const people = npcsAt(spot.id).map(n => n.name).join(', ')
    return ctx.reply(
      `${spot.emoji} *${spot.name}*, Astral Town\n` +
      `_${spot.scene}_\n\n` +
      (people ? `Here: ${people}\n*${p}talk*\n` : '') +
      (hint ? `\n📜 ${hint}\n` : '') +
      `*${p}town* to walk somewhere else.`,
    )
  },
}
