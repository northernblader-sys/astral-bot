/**
 * cinderverdict.js — Wither's one combat move (Season 1 peak character).
 *
 * Costs no MP and fires once per battle (bs.witherUsed, set by
 * activateCinderVerdict() in lib/character-abilities.js — the same
 * battleState flag pattern activateFinalForm uses, so it resets with the
 * fight for free).
 *
 * The turn is deliberately the same shape as plugins/useability.js: accuracy
 * roll, damage through calcPlayerDamage() -> applyDefense(), boss-engine
 * hooks when fighting an anime boss, then the enemy's counter-attack. The
 * only thing special here is the 8x damageMultiplier — mitigation, crits and
 * accuracy are all the stock pipeline, so this is a very heavy hit rather
 * than a guaranteed kill.
 *
 * Usage: <prefix>cinderverdict
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  calcPlayerDamage, applyDefense, calcPlayerHitChance,
  calcMonsterHitChance, calcMonsterDamage, hpBar,
} from '../lib/combat-engine.js'
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
  getBossTaunt, getBossHitLine, getBossDodgeLine,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateCinderVerdict,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpCinderVerdict } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

export default {
  name: 'cinderverdict',
  aliases: ['cinder', 'cv', 'verdict'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}cinderverdict — Wither's once-per-battle ember sentence (no MP)`,

  async run(ctx) {
    const p = config.prefix

    // Cinder Verdict works in duels too. PvP uses a two-player battleState
    // (no bs.enemy) and its own turn engine, so hand off to pvp.js rather than
    // running the PvE boss/monster pipeline below against a shape it can't read.
    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpCinderVerdict(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const gate = activateCinderVerdict(player)
      if (!gate.ok) {
        if (gate.message) await ctx.reply(gate.message)
        return player
      }

      const bs   = player.battleState
      const e    = bs.enemy
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

      msg +=
        `🔥⚖️ *CINDER VERDICT*\n` +
        `─────────────\n` +
        `_Wither names *${e.name}*, and the name catches fire._\n\n`

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else if (Math.random() > calcPlayerHitChance(player, e)) {
        msg += `💨 The sentence gutters out — *MISSED!*\n`
        if (boss) {
          const missResult = applyBossSpecial(player, EVENT.PLAYER_MISS, { isMiss: true })
          msg += `💬 _"${getBossDodgeLine(player)}"_\n`
          if (missResult.narrativeLine) msg += `_${missResult.narrativeLine}_\n`
        }
      } else {
        // Stock damage pipeline — 8x is passed as damageMultiplier, and
        // applyDefense still mitigates the result.
        const { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
        const dmg = applyDefense(rawDmg, e.def)
        e.hp = Math.max(0, e.hp - dmg)

        msg += `🩸 *${dmg}* damage!${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`

        if (e.hp > 0) {
          const tearLine = applyTearOnHit(player, e, ctx)
          if (tearLine) msg += tearLine + '\n'
        }

        if (boss) {
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: dmg, element: 'fire', isCrit, isHit: true,
          })
          if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
          msg += `💬 _"${getBossHitLine(player)}"_\n`
        }

        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }

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
