/**
 * hollowexchange.js — Minna's one combat move.
 *
 * Costs no MP and fires once per battle (bs.hollowExchangeUsed, set by
 * activateHollowExchange() in lib/character-abilities.js — the same battleState
 * flag pattern activateCinderVerdict/activateThiefsEye use, so it resets with the
 * fight for free).
 *
 * The turn follows plugins/thiefseye.js, with the damage half removed, because
 * THIS IS NOT AN ATTACK. There is no accuracy roll, no crit, no calcPlayerDamage
 * or applyDefense, and no EVENT.ENEMY_TAKE_DAMAGE — a boss whose special
 * retaliates on being damaged does not react to this, deliberately, because it
 * was not damaged. It gave something up. The exchange also cannot kill (the floor
 * in activateHollowExchange guarantees it), so there is no victory branch after
 * it; the only ways this turn ends a fight are the enemy's own status tick and
 * the enemy's counter-attack.
 *
 * checkBossPhase IS still called, and that is not an inconsistency with the
 * above: a phase shift is keyed to where the boss's HP bar sits, not to having
 * been hit. Dropping a boss from 95% to the floor crosses thresholds, and a boss
 * that skipped its phase-two transformation because the bar moved "the wrong way"
 * would be a genuine bug.
 *
 * TURN ORDER IS NOT thiefseye's. The gate runs twice: once as a dry run at the
 * very top so an illegal cast is refused for free, then for real AFTER the status
 * phase. Both halves matter — a refusal must not cost the turn, and a stun must
 * not silently apply the exchange and then announce she was unable to act.
 *
 * Usage: <prefix>hollowexchange
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { calcMonsterHitChance, calcMonsterDamage, hpBar } from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
  resolveCatFormDefeat,
} from '../lib/combat-handlers.js'
import { getEffectiveStat } from '../lib/effects.js'
import {
  applyBossSpecial, checkBossPhase, buildEnemyAttack,
  getBossTaunt, incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateHollowExchange,
  buildHollowExchangeReveal,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpHollowExchange } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

export default {
  name: 'hollowexchange',
  aliases: ['hollow-exchange', 'hollow', 'exchange', 'hx'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}hollowexchange — Minna trades HP percentages with the enemy (once per battle, no MP)`,

  async run(ctx) {
    const p = config.prefix

    // Hollow Exchange works in duels too. PvP uses a two-player battleState
    // (no bs.enemy) and its own turn engine, so hand off to pvp.js rather than
    // running the PvE boss/monster pipeline below against a shape it can't read.
    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpHollowExchange(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const bs = player.battleState
      const e  = bs?.enemy
      if (!bs || !e) {
        await ctx.reply(`🚫 You're not in a battle.`)
        return player
      }

      // Dry run: every guard, no mutation. "Not hollow enough" and "nothing worth
      // taking" both depend on HP that moves every turn, so they are the refusals
      // players will actually hit — and neither should cost them the turn below.
      const precheck = activateHollowExchange(player, e, bs, { dryRun: true })
      if (!precheck.ok) {
        if (precheck.message) await ctx.reply(precheck.message)
        return player
      }

      const boss = isBossFight(player)

      bs.playerDefending = false
      let msg = ''

      // Urahara's permanent Tear — action-triggered tick, same as every
      // other combat entry point.
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
        msg += `💫 *${player.name}* is unable to act this turn!\n`
        msg += `_(The exchange is still hers to make — nothing was spent.)_\n`
      } else {
        // The real cast. Re-runs the same guards the dry run did, which can now
        // legitimately fail: a poison tick in the status phase above may have
        // dropped the player's HP, and dying outright was already handled, but
        // the enemy could also have been brought under the floor by its own
        // bleed before she got to act.
        const res = activateHollowExchange(player, e, bs)
        if (!res.ok) {
          if (res.message) await ctx.reply(msg ? msg + res.message : res.message)
          return player
        }

        msg += buildHollowExchangeReveal(player, e, res)

        if (boss) {
          const phase = checkBossPhase(player)
          if (phase?.triggered && phase.lines?.length) {
            msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
          }
        }
      }

      const enemyStatus = processStatusTurn(e)
      if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }

      if (enemyStatus.incapacitated) {
        msg += `💫 *${e.name}* is unable to attack this turn!\n`
      } else if (boss) {
        const bossAtk    = buildEnemyAttack(player)
        const dealResult = applyBossSpecial(player, EVENT.ENEMY_DEAL_DAMAGE, { damage: bossAtk.damage, isHit: true })
        const rawBossAtk = (dealResult.modified && dealResult.damage !== undefined) ? dealResult.damage : bossAtk.damage
        const incoming   = bossAtk.bypassDefense
          ? rawBossAtk
          : calcMonsterDamage(rawBossAtk, getEffectiveStat(player, 'def'), false)
        const applied = applyIncomingDamage(player, incoming)
        if (applied.message) msg += applied.message + '\n'
        msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
        msg += `🩸 *${applied.damage}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
        if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
        msg += `\n💬 _"${getBossTaunt(player)}"_\n`
        if (applied.catFormDefeated) {
          return resolveCatFormDefeat(player, ctx, { boss: true })
        }
        if (player.hp <= 0) {
          const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
          if (!res.fallThrough) return res.returnValue
          msg = res.msg
        }
      } else if (Math.random() > calcMonsterHitChance(e, player)) {
        msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates... and *MISSES!*`
      } else {
        const enemyDmg = calcMonsterDamage(e.atk, getEffectiveStat(player, 'def'), false)
        const applied = applyIncomingDamage(player, enemyDmg)
        if (applied.message) msg += applied.message + '\n'
        msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates!\n🩸 *${applied.damage}* damage!`
        if (applied.catFormDefeated) {
          return resolveCatFormDefeat(player, ctx)
        }
        if (player.hp <= 0) {
          const res = await resolvePlayerHpZero(player, ctx, msg, {})
          if (!res.fallThrough) return res.returnValue
          msg = res.msg
        }
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
  },
}
