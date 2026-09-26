/**
 * timestop.js — Reverie's signature move: Time Stop.
 *
 * Once per battle, no MP (bs.timeStopUsed, set by activateTimeStop() in
 * lib/character-abilities.js — the same battleState latch every other active
 * uses, so it resets with the fight for free). She stops time: the enemy
 * FREEZES where it stands for TIME_STOP_TURNS of its own moves. The freeze rides
 * the ordinary 'freeze' effect, so the generic processStatusTurn() skips the
 * enemy's turn for us — the same discipline Red Rose's tangle and Gojo's
 * Unlimited Void both rely on, no per-plugin enemy-turn hook needed.
 *
 * The turn shape is the front half of plugins/puppetry.js: status tick, the
 * freeze, then the enemy's turn plays out as "frozen outside of time, no move
 * comes" (the freeze we just placed). It applies TIME_STOP_TURNS at once, so the
 * enemy loses this move and its next two as well, on ordinary .attack turns
 * after, exactly the way a multi-turn burn keeps ticking.
 *
 * PvP: in a duel this hands off to pvp.js's pvpTimeStop() (the 'timestop' action
 * there), since this plugin only knows the PvE battleState shape (bs.enemy). A
 * duel is also the only place the target can have Montana equipped — that
 * negate-and-counter interaction lives entirely in the PvP branch.
 *
 * Usage: <prefix>tms
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
  activateTimeStop,
  tickPermanentSever,
  sendWillowAdvisory,
  TIME_STOP_TURNS,
} from '../lib/character-abilities.js'
import { pvpTimeStop } from './pvp.js'
import { resolveSwarmAbility } from '../lib/swarm-combat.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/** The flavored reveal for a landed time stop. */
function timeStopReveal(actorName, targetName) {
  return (
    `⏱️ *TIME STOP*\n` +
    `─────────────\n` +
    `🕛 *${actorName}* lifts a hand, and the world stops answering to anything but her.\n` +
    `❄️ *${targetName}* freezes mid-motion, caught between one instant and the next.\n` +
    `_The next *${TIME_STOP_TURNS}* moves are hers alone. Time starts again only when she allows it._`
  )
}

/**
 * runTimeStop(ctx) — the whole Reverie time-stop turn. Kept as its own exported
 * function so a general dispatcher could call it, mirroring runPuppetStrings();
 * the plugin's run() is a thin wrapper.
 */
export async function runTimeStop(ctx) {
  const p = config.prefix

  // In a duel, time stop hands off to the PvP turn engine: this plugin only
  // knows the PvE battleState shape (bs.enemy). Same handoff puppetry uses.
  if (ctx.player?.battleState?.type === 'pvp') {
    return pvpTimeStop(ctx)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, {
      boss: isBossFight(player),
    })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activateTimeStop(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    // Swarm floors: fold the time stop into one swarm turn against the nearest
    // threat. The strings-equivalent here is a freeze — that one monster is
    // caught mid-motion, its wind-up cancelled and its next re-aim skipped, so
    // it loses its move while the rest of the pack still closes. Kills can't
    // route through this (a freeze deals no damage), so no floor-clear branch is
    // needed.
    if (player.battleState?.mode === 'swarm') {
      return resolveSwarmAbility(player, ctx, (target) => {
        addStatusEffect(target, { type: 'freeze', duration: TIME_STOP_TURNS, sourceId: 'time_stop' })
        return {
          lines: [
            `⏱️ _${player.name} stops time. ${target.name} freezes mid-lunge and will not move for the next ${TIME_STOP_TURNS} turns._`,
          ],
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
      // She could not raise a hand this turn, but the charge is already spent —
      // the time stop is her one attempt, same discipline as the other actives.
      msg +=
        `⏱️ *TIME STOP*\n` +
        `─────────────\n` +
        `💫 *${player.name}* is unable to act this turn, and time never stops!\n`
    } else {
      // The freeze. A status-immune enemy (a Shunya owner in an enemy slot)
      // stands outside the stopped moment and addStatusEffect reports immune.
      const froze = addStatusEffect(e, {
        type: 'freeze',
        duration: TIME_STOP_TURNS,
        sourceId: 'time_stop',
      })

      if (froze?.immune) {
        msg +=
          `⏱️ *TIME STOP*\n` +
          `─────────────\n` +
          `⭕ *${e.name}* stands outside the stopped moment. Time finds no hold on it.\n`
      } else {
        msg += timeStopReveal(player.name, e.name) + '\n'
      }

      if (boss) {
        const phase = checkBossPhase(player)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
        }
      }
    }

    // Enemy turn. Ticking their statuses counts the freeze down by one and, while
    // it holds, reports them as incapacitated — no counter lands this turn.
    const enemyStatus = processStatusTurn(e)
    if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
    if (e.hp <= 0) {
      if (boss) cleanupBossFight(player)
      return handleVictory(player, e, ctx)
    }

    if (enemyStatus.incapacitated) {
      msg += `\n${e.emoji ?? '👾'} *${e.name}* is frozen outside of time. No move comes.`
    } else {
      // Only reachable if the enemy was immune to the freeze above; it simply
      // steadies. No damage is dealt to the player here — the time stop is the
      // player's action, and a real counter is resolved on the next .attack.
      msg += `\n${e.emoji ?? '👾'} *${e.name}* shrugs off the stopped moment and steadies.`
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
  name: 'tms',
  aliases: ['timestop', 'time-stop', 'stoptime', 'reverie-tms'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}tms: Reverie's once-per-battle time stop. The enemy freezes and loses its next ${TIME_STOP_TURNS} moves (no MP)`,
  run: runTimeStop,
}
