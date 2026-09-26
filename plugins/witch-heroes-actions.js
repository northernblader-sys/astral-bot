import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import {
  activateEndworld,
  useSword,
  swordStatus,
  completeTurn,
  absoluteSlash,
} from '../lib/witch-heroes.js'
import { showCoordinate } from '../lib/witch-heroes-cinematic.js'

function targetFor(db, player) {
  return player?.battleState?.enemy ?? getPlayer(db, player?.battleState?.opponentJid) ?? null
}

export default {
  name: 'endworld',
  aliases: ['end-world', 'ss', 'swordstatus', 'sword-status', 'sword', 'absolute-sword'],
  category: 'combat',
  requiresPlayer: true,
  description: 'Scarlett, Ronova and Sword Maiden combat actions',

  async run(ctx) {
    const cmd = ctx.cmd
    if (cmd === 'ss' || cmd === 'swordstatus' || cmd === 'sword-status') {
      return ctx.reply(swordStatus(ctx.player))
    }

    if (cmd === 'endworld' || cmd === 'end-world') {
      let out
      await updatePlayer(ctx.db, ctx.from, player => {
        out = activateEndworld(player)
        return player
      })
      return ctx.reply(out.message)
    }

    let out
    let targetId = null
    let isPvpTurn = false
    let movedAt = null
    const strikes = []

    await updatePlayer(ctx.db, ctx.from, player => {
      const target = targetFor(ctx.db, player)
      targetId = player.battleState?.opponentJid
      isPvpTurn = player.battleState?.type === 'pvp'
      out = useSword(player, target, ctx.args[0]?.toLowerCase())

      if (out.ok && out.cinematic === 'coordinate' && target) {
        for (let i = 0; i < out.strikes; i++) {
          strikes.push({ damage: absoluteSlash(player, target, 1), revived: false })
        }
      }

      if (out.ok && target?.battleState) {
        if (isPvpTurn) {
          // A sword technique is a real PvP move. Its charge and MP are spent,
          // then the turn passes to the opponent. This technique does not
          // recharge itself; charge comes from a later non-sword PvP turn.
          movedAt = Date.now()
          player.battleState.myTurn = false
          player.battleState.turn = (player.battleState.turn ?? 1) + 1
          player.battleState.lastMoveAt = movedAt
        } else {
          completeTurn([player, target], player.battleState.turn ?? 1, { chargeSword: false })
        }
      }
      return player
    })

    // PvP records are independent. Persist the target mutation, then pass the
    // turn; PvE opponents are already covered by the normal battle adapter.
    if (out?.ok && targetId) {
      await updatePlayer(ctx.db, targetId, player => {
        if (isPvpTurn && player.battleState?.type === 'pvp' && player.battleState.opponentJid === ctx.from) {
          player.battleState.myTurn = true
          player.battleState.lastMoveAt = movedAt
        }
        return player
      })
    }

    if (out?.ok && out.cinematic === 'coordinate') {
      return showCoordinate(ctx, strikes, out.message, {
        player: ctx.player,
        participants: [ctx.player, targetFor(ctx.db, ctx.player)],
      })
    }
    return ctx.reply(out?.message ?? 'No active battle.')
  },
}
