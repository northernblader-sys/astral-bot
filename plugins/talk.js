/**
 * talk.js — speak to whoever is on this street.
 *
 *   .talk           the person here, if there is only one
 *   .talk <name>    a named person on this street
 *
 * Guild slips that want a conversation land here. Idle talk is just the
 * person being a person.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { spotOf, npcsAt, findNpc, townWalkBlock } from '../lib/town.js'
import { noteTalk, stepLabel } from '../lib/guild-board.js'

export default {
  name: 'talk',
  aliases: ['speak', 'ask'],
  category: 'town',
  requiresPlayer: true,
  description: 'Talk to the person standing on your street',
  subcommands: [
    { cmd: '<name>', desc: 'speak to someone on this street by name' },
  ],

  async run(ctx) {
    const p = config.prefix
    const blocked = townWalkBlock(ctx.player)
    if (blocked === 'battle') return ctx.reply(`⚔️ Not in the middle of a fight.`)
    if (blocked === 'dungeon') {
      return ctx.reply(`🗺️ Nobody from town followed you down.\n_Come back, then *${p}town* and *${p}talk*._`)
    }

    const spot = spotOf(ctx.player.townSpot)
    if (!spot) {
      return ctx.reply(`🧭 You are not on a street yet.\n*${p}town* to walk somewhere, then *${p}talk*.`)
    }

    const here = npcsAt(spot.id)
    if (!here.length) return ctx.reply(`${spot.emoji} *${spot.name}* is empty right now.`)

    const query = ctx.args.join(' ').trim()
    let npc = query ? findNpc(query, spot.id) : (here.length === 1 ? here[0] : null)
    if (query && !npc) {
      return ctx.reply(
        `❓ *${query}* is not on ${spot.name}.\n` +
        `Here: ${here.map(n => `*${n.name}*`).join(', ')}`,
      )
    }
    if (!npc) {
      return ctx.reply(
        `${spot.emoji} *${spot.name}*\n` +
        here.map(n => `  • *${n.name}* _(${n.title})_  ·  *${p}talk ${n.id}*`).join('\n'),
      )
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      if (player.townSpot !== spot.id) player.townSpot = spot.id
      outcome = noteTalk(player, npc.id)
      return player
    })

    if (!outcome.ok && outcome.reason === 'short') {
      const need = outcome.need
      const name = outcome.step.itemName ?? outcome.step.item
      return ctx.reply(
        `${npc.name} looks at your hands.\n\n` +
        `_${npc.line}_\n\n` +
        `❌ They need *${need} ${name}*. You have *${outcome.have}*.\n` +
        `*${p}shop buy ${outcome.step.item}*`,
      )
    }

    const idle = `_${npc.line}_`
    if (!outcome.ok) {
      let extra = ''
      if (outcome.reason === 'wrong') extra = `\n\n_The slip is not asking for ${npc.name}. *${p}board track*_`
      else if (outcome.reason === 'notnow') extra = `\n\n_The slip wants something else first. *${p}board track*_`
      return ctx.reply(`*${npc.name}* _(${npc.title})_\n${idle}${extra}`)
    }

    return ctx.reply(
      `*${npc.name}*\n_${outcome.line}_\n\n` +
      (outcome.ready
        ? `🎁 *The slip is finished.* Pin it with *${p}board turnin*.`
        : `▶️ ${outcome.next ?? stepLabel(null)}\n*${p}board track*`),
    )
  },
}
