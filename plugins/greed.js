/**
 * greed.js - Echidna's signature move: Gospel of Greed.
 *
 * Once per battle, no MP (bs.greedTitheUsed, set by activateGreedTithe() in
 * lib/character-abilities.js - the same battleState latch every other active
 * uses, so it resets with the fight for free). She opens the Gospel and her
 * shadow walks through the enemy's pockets - for a heartbeat wearing their
 * face - and what she brings back depends ENTIRELY on her mood
 * (lib/echidna.js): half the enemy's carried money when amused or
 * capricious (plus a chance at gems from the hoard), a quarter when
 * displeased. Her holder's granted child steals alongside her, scaled by the
 * child's stage. The enemy then loses its next turn patting its empty
 * pockets - applied as a plain 'stun' for GREED_TANGLE_TURNS so the generic
 * processStatusTurn() skips it exactly the way Puppet Strings' tangle does.
 *
 * The tithe NEVER damages the enemy - it is pure theft plus tempo - so there
 * is no defeat branch for the theft itself; the turn shape mirrors
 * plugins/puppetry.js otherwise (status tick, boss engine ticks, enemy turn
 * plays out as "distracted, no move comes").
 *
 * PvP: in a duel this hands off to pvp.js's pvpGreedTithe() (the
 * 'greedtithe' action there), since this plugin only knows the PvE
 * battleState shape (bs.enemy) - the duel side takes the money and gems off
 * the OPPONENT'S actual wallet.
 *
 * Usage: <prefix>greed
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { hpBar } from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
} from '../lib/combat-handlers.js'
import { addStatusEffect } from '../lib/effects.js'
import {
  applyBossSpecial, checkBossPhase,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateGreedTithe,
  resolveEchidnaTithePvE,
  buildGreedTitheReveal,
  sendWillowAdvisory,
  tickPermanentSever,
  GREED_TANGLE_TURNS,
} from '../lib/character-abilities.js'
import { pvpGreedTithe } from './pvp.js'
import { resolveSwarmAbility } from '../lib/swarm-combat.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * runGospelOfGreed(ctx) - the whole Echidna tithe turn. Kept as its own
 * exported function so a general dispatcher could call it, mirroring
 * runPuppetStrings() in plugins/puppetry.js; the plugin's run() is a thin
 * wrapper.
 */
export async function runGospelOfGreed(ctx) {
  const p = config.prefix

  // In a duel, the tithe hands off to the PvP turn engine: the money has to
  // come off the opponent's REAL wallet, and this plugin only knows the PvE
  // battleState shape (bs.enemy). Same handoff puppetry.js uses.
  if (ctx.player?.battleState?.type === 'pvp') {
    return pvpGreedTithe(ctx)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, {
      boss: isBossFight(player),
    })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activateGreedTithe(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }
    const mood = gate.mood

    // Swarm floors: fold the tithe into one swarm turn against the nearest
    // threat. She picks that one monster's pockets clean (half its carried
    // wealth, mood permitting its gems), and it hangs distracted - expressed
    // swarm-native as its wind-up cancelled and its next re-aim skipped. The
    // rest of the pack still closes, so she works a floor without freezing
    // it, same discipline puppetry uses.
    if (player.battleState?.mode === 'swarm') {
      return resolveSwarmAbility(player, ctx, (target) => {
        const res = resolveEchidnaTithePvE(player, target, mood)
        return {
          lines: [buildGreedTitheReveal({
            ownerName: player.name,
            enemyName: target.name,
            mood,
            solars: res.solars,
            gems: res.gems,
            context: 'dungeon',
            childRec: res.child,
          })],
          cancelTelegraph: true,
          suppressReTelegraph: true,
        }
      })
    }

    const bs   = player.battleState
    const e    = bs.enemy
    const boss = isBossFight(player)

    bs.playerDefending = false
    let msg = ''

    const permaSeverLine = tickPermanentSever(player)
    if (permaSeverLine) msg += permaSeverLine + '\n'
    if (player.hp <= 0) {
      const res = await resolvePlayerHpZero(player, ctx, msg, {})
      if (!res.fallThrough) return res.returnValue
      msg = res.msg
    }

    if (boss) {
      incrementBossTurn(player)
      const tsResult = applyBossSpecial(player, EVENT.TURN_START, {})
      if (tsResult.narrativeLine) msg += `_${tsResult.narrativeLine}_\n`
    }

    const playerStatus = processStatusTurn(player)
    if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
    if (player.hp <= 0) {
      const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
      if (!res.fallThrough) return res.returnValue
      msg = res.msg
    }

    if (playerStatus.incapacitated) {
      // She could not raise a hand this turn, but the charge is already spent -
      // the Gospel was her one attempt, same discipline as the other actives.
      msg +=
        `🍵📖 *GOSPEL OF GREED*\n` +
        `─────────────\n` +
        `💫 *${player.name}* is unable to act this turn, and the Gospel never opens!\n`
    } else {
      // The theft itself. resolveEchidnaTithePvE credits the holder's wallet
      // (mood-shaped share of the enemy's carried solars + the gem plunder +
      // the child's cut) and touches NOTHING on the enemy record.
      const res = resolveEchidnaTithePvE(player, e, mood)

      // The distraction. A plain stun so processStatusTurn() below skips the
      // enemy's turn for us; a status-immune enemy tears free and
      // addStatusEffect reports immune - the money is gone either way.
      const distract = addStatusEffect(e, {
        type: 'stun',
        duration: GREED_TANGLE_TURNS,
        sourceId: 'gospel_of_greed',
      })

      msg += buildGreedTitheReveal({
        ownerName: player.name,
        enemyName: e.name,
        mood,
        solars: res.solars,
        gems: res.gems,
        context: boss ? 'boss' : 'dungeon',
        childRec: res.child,
        immune: !!distract?.immune,
      }) + '\n'

      // The tithe deals no damage, so the enemy cannot die to it - the
      // victory check below only guards a degenerate enemy already at 0.
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }
    }

    // Enemy turn. Ticking their statuses counts the distraction down by one
    // and, while it holds, reports them as incapacitated - no counter lands
    // this turn.
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) {
      if (boss) cleanupBossFight(player)
      return handleVictory(player, e, ctx)
    }

    if (enemyStatus.incapacitated) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* is still counting what is missing. No move comes.`
    } else {
      // Only reachable if the enemy was immune to the distraction above; the
      // theft landed regardless, then it steadies. No damage is dealt to the
      // player here - the tithe turn is the player's action, and a real
      // counter is resolved on the next .attack, not folded into this
      // narration. Same shape puppetry uses.
      msg += `\n${e.emoji ?? '👾'} *${e.name}* gives up the counting and steadies.`
    }

    if (boss) {
      const teResult = applyBossSpecial(player, EVENT.TURN_END, {})
      if (teResult.narrativeLine) msg += `\n_${teResult.narrativeLine}_`
    }

    msg += `\n\n👤 *${player.name}*\n❤️ ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp}/${player.maxMp} MP\n` +
           `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}\n\n` +
           `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

    bs.turn = (bs.turn ?? 1) + 1
    player.battleState = bs
    await sendWillowAdvisory(ctx, player, e, boss)
    await ctx.reply(msg)
    return player
  })
}

export default {
  name: 'greed',
  aliases: ['tithe', 'greedgrab', 'gospel', 'gospelofgreed', 'witchs-grasp', 'stealgreed'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}greed: Echidna's once-per-battle Gospel of Greed. Her mood decides how much of the enemy's money - and sometimes gems - she hands you (no MP)`,
  run: runGospelOfGreed,
}
