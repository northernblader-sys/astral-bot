/**
 * <prefix>finalform
 *
 * Mei's unique ability (Season System Spec §13.1). Only usable while Mei
 * (data/characters.json 'mei') is the equipped character AND the player
 * is currently in battle AND the trigger condition has been met (HP
 * dropped below 70% at some point this fight — see
 * lib/character-abilities.js's checkFinalFormTrigger(), called every turn
 * from plugins/attack.js and plugins/useability.js).
 *
 * This is a stateful trigger check + manual activation, NOT an automatic
 * passive — matching the spec's "usable once the trigger condition has
 * been met" framing (the player still has to choose to spend their turn
 * on it).
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { activateFinalForm } from '../lib/character-abilities.js'
import { processStatusTurn, resolvePlayerHpZero } from '../lib/combat-handlers.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

export default {
  name: 'finalform',
  aliases: ['ff', 'transform'],
  category: 'combat',
  description: `${config.prefix}finalform — awaken Mei's Final Form once your HP drops below 70% in battle (must have Mei equipped).`,
  requiresPlayer: true,

  async run(ctx) {
    const { db, from } = ctx
    let replyMsg = ''
    let handled = false

    await updatePlayer(db, from, async (player) => {
      const result = activateFinalForm(player)
      replyMsg = result.message
      if (!result.ok) return player

      // activateFinalForm() heals the player before applying the buff, so
      // this can never itself cause death — but it still counts as the
      // player's action for the turn, so any of the player's OWN lingering
      // DOTs (e.g. a Tear bleed, poison, burn) still tick here exactly as
      // they would on a normal .attack/.useability turn, for consistency.
      const statusResult = processStatusTurn(player)
      if (statusResult.lines.length) replyMsg += '\n\n' + statusResult.lines.join('\n')

      if (player.hp <= 0) {
        // resolvePlayerHpZero() covers totem -> pearl -> Yoriichi cat form
        // -> real death, same chain every other combat plugin uses. Prior
        // to this, finalform.js only ever checked the totem here, so a
        // lingering DOT tick that finished the player off would skip
        // Yoriichi's save entirely even with her equipped and active.
        const res = await resolvePlayerHpZero(player, ctx, replyMsg, { boss: isBossFight(player) })
        if (!res.fallThrough) {
          // Every non-fallThrough branch of resolvePlayerHpZero (pearl,
          // Yoriichi, real death) already sends its own ctx.reply
          // internally — skip our own reply below, same convention
          // attack.js/useability.js already follow.
          handled = true
          return res.returnValue
        }
        replyMsg = res.msg
      }

      return player
    })

    if (!handled) return ctx.reply(replyMsg)
  },
}
