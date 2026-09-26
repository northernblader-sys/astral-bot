/**
 * <prefix>curetear
 *
 * Removes Urahara's PERMANENT PvP Tear/Reshape debuff. This is deliberately
 * its own command rather than routed through the generic <prefix>use:
 * clearing the permanent sever consumes REQUIRED (30) Severing Elixirs in a
 * single action, and making the player fire that many separate `.use`
 * commands would be a genuinely painful UX with zero gameplay upside. This
 * command consumes them all at once and reports how many more are needed if
 * the player doesn't have enough yet.
 *
 * Does NOT touch the in-battle 'sever'-style activeEffects DOT (that one
 * cures normally via <prefix>use severing_elixir since it IS a normal
 * activeEffects entry once effects.js's cure() is given explicit
 * targets: ['tear']; see data/items.json's severing_elixir, a cheap
 * shop-buyable cure). This command is specifically for player.permanentSever,
 * which lives outside activeEffects entirely (see lib/character-abilities.js).
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { curePermanentSever } from '../lib/character-abilities.js'

const ELIXIR_ID = 'severing_elixir'
const REQUIRED = 30

export default {
  name: 'curetear',
  aliases: ['cureTear', 'removetear', 'cure_tear'],
  category: 'combat',
  description: `${config.prefix}curetear — consume ${REQUIRED} Severing Elixirs to remove a permanent Tear debuff from a lost PvP duel.`,
  requiresPlayer: true,

  async run(ctx) {
    const { db, from, player } = ctx
    const p = config.prefix

    if (!player.permanentSever?.active) {
      return ctx.reply(`✅ You don't have a permanent Tear debuff to cure.`)
    }

    const owned = (player.inventory ?? []).filter((id) => id === ELIXIR_ID).length
    if (owned < REQUIRED) {
      return ctx.reply(
        `🩸 *Permanent Tear active.* _(0.5% max HP lost on every action, until cured.)_\n\n` +
        `You need *${REQUIRED}* Severing Elixirs to cure it. You have *${owned}*.\n` +
        `_Buy them cheap from the ${p}shop, or find them in Season 1's dungeon (${p}dungeon: The Beginning of the End) and its boss._`,
      )
    }

    let replyMsg = ''
    await updatePlayer(db, from, (fresh) => {
      const inv = fresh.inventory ?? []
      const freshOwned = inv.filter((id) => id === ELIXIR_ID).length
      if (freshOwned < REQUIRED) {
        replyMsg = `❌ Inventory changed — you now have *${freshOwned}/${REQUIRED}* Severing Elixirs. Try again.`
        return
      }

      // Remove exactly 300 instances.
      let toRemove = REQUIRED
      fresh.inventory = inv.filter((id) => {
        if (id === ELIXIR_ID && toRemove > 0) {
          toRemove -= 1
          return false
        }
        return true
      })

      const result = curePermanentSever(fresh)
      replyMsg = result.cured
        ? `🌿✨ *The Tear closes.* _${REQUIRED} Severing Elixirs consumed._\n\nYou're fully cured of the permanent bleed.`
        : `✅ You don't have a permanent Tear debuff to cure.`
    })

    return ctx.reply(replyMsg)
  },
}
