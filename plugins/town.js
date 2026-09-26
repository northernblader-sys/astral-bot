/**
 * town.js — walk Astral Town.
 *
 *   .town              the streets
 *   .town <place>      walk there
 *
 * Soft. It writes player.townSpot and nothing else. .shop and .inn keep
 * working from anywhere in town. This is not .walk: .roam already answers to that.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { TOWN_SPOTS, findSpot, npcsAt, townWalkBlock } from '../lib/town.js'
import { noteVisit } from '../lib/guild-board.js'

function blockReply(reason, p) {
  if (reason === 'battle') return `⚔️ Finish the fight before you wander town.`
  if (reason === 'dungeon') return `🗺️ You are still in a dungeon.\n_Leave with *${p}dungeon leave*, then walk._`
  return `⚠️ Register first.`
}

function listStreets(player, p) {
  const here = player?.townSpot
  const lines = [
    `🧭 *ASTRAL TOWN*`,
    `_The streets, not the menu. Walking here does not lock the shop or the inn._`,
    '',
  ]
  for (const spot of TOWN_SPOTS) {
    const mark = spot.id === here ? '  ·  you are here' : ''
    const people = npcsAt(spot.id).map(n => n.name).join(', ')
    lines.push(`${spot.emoji} *${spot.name}*${mark}`)
    lines.push(`   _${people}_  ·  *${p}town ${spot.id}*`)
  }
  lines.push('')
  lines.push(`*${p}where*  ·  *${p}talk*  ·  *${p}board*`)
  lines.push(`_Inside an empire, the interior is *${p}goto*, not this._`)
  return lines.join('\n')
}

export default {
  name: 'town',
  aliases: ['streets', 'stroll'],
  category: 'town',
  requiresPlayer: true,
  description: 'Walk the streets of Astral Town and see who is standing there',
  subcommands: [
    { cmd: '<place>', desc: 'walk to a street: square, market, inn, guildhall, pier, and the rest' },
  ],

  async run(ctx) {
    const p = config.prefix
    const query = ctx.args.join(' ').trim()
    if (!query) return ctx.reply(listStreets(ctx.player, p))

    const blocked = townWalkBlock(ctx.player)
    if (blocked) return ctx.reply(blockReply(blocked, p))

    const spot = findSpot(query)
    if (!spot) {
      return ctx.reply(
        `🧭 No street called *${query}*.\n` +
        `_Try: ${TOWN_SPOTS.map(s => s.id).join(', ')}._`,
      )
    }

    let note = null
    await updatePlayer(ctx.db, ctx.from, player => {
      player.townSpot = spot.id
      note = noteVisit(player)
      return player
    })

    const people = npcsAt(spot.id)
    const who = people.length
      ? people.map(n => `*${n.name}* _(${n.title})_`).join(', ')
      : '_nobody is waiting_'
    return ctx.reply(
      `${spot.emoji} *You walk to ${spot.name}.*\n` +
      `_${spot.scene}_\n\n` +
      `People here: ${who}\n` +
      `*${p}talk* to speak to them.` +
      (note?.line ? `\n\n${note.line}` : ''),
    )
  },
}
