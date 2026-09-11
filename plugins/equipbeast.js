/**
 * equipbeast.js — set/clear the player's active summoned beast.
 * Follows the same equip/unequip shape as plugins/pet.js, but the 4-owned
 * cap is enforced at acquisition (plugins/summon.js), never here — any
 * beast already in summonedBeasts can be freely equipped.
 *
 * Usage:
 *   <prefix>equipbeast <name>   — set your active beast
 *   <prefix>equipbeast unequip  — clear your active beast
 */
import { config } from '../config.js'
import { beastMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { findOwnedBeast } from '../lib/beast-engine.js'

function findBeastDef(query) {
  const q = query.toLowerCase().trim()
  if (beastMap[q]) return beastMap[q]
  return Object.values(beastMap).find((b) => b.name.toLowerCase().includes(q)) ?? null
}

export default {
  name: 'equipbeast',
  aliases: ['setbeast', 'activebeast'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}equipbeast <name> — set your active summoned beast`,

  async run(ctx) {
    const { player, args, db } = ctx
    const pr = config.prefix
    const query = args.join(' ').trim()

    if (!query) {
      return ctx.reply(
        `Usage:\n` +
        `  *${pr}equipbeast <name>* — set your active beast\n` +
        `  *${pr}equipbeast unequip* — clear your active beast\n\n` +
        `See your roster: *${pr}summon list*`,
      )
    }

    if (query.toLowerCase() === 'unequip') {
      if (!player.activeBeast) return ctx.reply(`❌ You don't have an active beast.`)
      const oldDef = beastMap[player.activeBeast]
      await updatePlayer(db, ctx.from, (p) => { p.activeBeast = null })
      return ctx.reply(`✅ *${oldDef?.name ?? player.activeBeast}* is no longer your active beast.`)
    }

    const def = findBeastDef(query)
    if (!def || !findOwnedBeast(player, def.id)) {
      return ctx.reply(`❌ You don't own a beast matching *"${query}"*.\nSee your roster: *${pr}summon list*`)
    }
    if (player.activeBeast === def.id) {
      return ctx.reply(`⚠️ *${def.name}* is already your active beast.`)
    }

    let raceAborted = false
    let oldName = null
    await updatePlayer(db, ctx.from, (p) => {
      if (!findOwnedBeast(p, def.id)) { raceAborted = true; return }
      if (p.activeBeast) oldName = beastMap[p.activeBeast]?.name ?? p.activeBeast
      p.activeBeast = def.id
    })

    if (raceAborted) return ctx.reply(`❌ Equip failed — your state changed. Please try again.`)

    const swapLine = oldName ? `\n↩️ *${oldName}* is resting in your roster.` : ''
    return ctx.reply(
      `${def.emoji} *${def.name}* is now your active beast!${swapLine}\n` +
      `It may intervene in battle to protect you or land a bonus strike.`,
    )
  },
}
