/**
 * soulpunisher.js — Gogeta's Soul Punisher, the cheap half of his kit.
 *
 * A ranged ki blast: medium damage (SOUL_PUNISHER_MULT), no MP, no weapon
 * wear (nothing in his hand touches anything), and a two-turn cooldown that
 * Instant Transmission sometimes refuses to start. Everything about whether
 * it is allowed to fire lives in activateSoulPunisher() in lib/gogeta.js; this
 * plugin owns the turn.
 *
 * The turn is the same shape as plugins/purple.js — status tick, the blast,
 * boss-engine hooks, then the enemy's counter-attack and bs.turn++ — with two
 * differences from Hollow Purple:
 *
 *   1. DEF APPLIES. This is a normal hit, just a strong one, so the multiplier
 *      goes through applyDefense() like an ordinary attack.
 *   2. IT NEVER MISSES. There is no accuracy roll, for the same reason no
 *      character move in the bot has one: the charge is already spent by the
 *      time the roll would happen, and eating a two-turn cooldown on a whiff
 *      reads as the command being broken. Crit still rolls, out of
 *      calcPlayerDamage().
 *
 * No art. The user's brief puts the standing image on standard displays
 * (profile, spin result, idle) and reserves the Kamehameha image for the
 * ultimate, so a basic ki blast firing every other turn stays plain text.
 *
 * PvP: hands off to pvp.js's pvpSoulPunisher() ('soulpunisher' action there),
 * since this plugin only knows the PvE battleState shape (bs.enemy).
 *
 * Usage: <prefix>soulpunisher
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  calcPlayerDamage, applyDefense,
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
  getBossTaunt, getBossHitLine,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateSoulPunisher,
  fusionTurnsLeft,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpSoulPunisher } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

export default {
  name: 'soulpunisher',
  // No 'sp' alias: plugins/skill.js already owns it, and it loads first, so
  // claiming it here would silently shadow nothing and just confuse.
  aliases: ['soulpunish', 'soul-punisher', 'punisher', 'spunisher', 'kiblast'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}soulpunisher: Gogeta's ranged ki blast (no MP, short cooldown)`,

  async run(ctx) {
    const p = config.prefix

    // In a duel this hands off to the PvP turn engine: this plugin only knows
    // the PvE battleState shape (bs.enemy).
    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpSoulPunisher(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const gate = activateSoulPunisher(player)
      if (!gate.ok) {
        if (gate.message) await ctx.reply(gate.message)
        return player
      }
      // CHUNK_MARKER_SP_TURN
      const bs   = player.battleState
      const e    = bs.enemy
      const boss = isBossFight(player)

      bs.playerDefending = false
      let msg = ''

      // Urahara's permanent Tear — action-triggered tick, same as every
      // other combat entry point. (No-op unless Urahara is equipped.)
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

      // processStatusTurn also ticks the fusion clock (see lib/combat-handlers.js),
      // so the countdown and the break both narrate themselves from here.
      const playerStatus = processStatusTurn(player)
      if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }

      const fusionLeft = fusionTurnsLeft(player, bs)
      msg +=
        `🔵 *SOUL PUNISHER*\n` +
        `─────────────\n` +
        `_Gogeta puts a hand out, and a point of ki the size of a fist crosses the distance to *${e.name}* before the sound does._\n\n`
      if (gate.extra) msg += gate.extra + '\n'
      // CHUNK_MARKER_SP_DAMAGE
      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        const { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
        const dmg = Math.max(1, Math.round(applyDefense(rawDmg, getEffectiveStat(e, 'def'))))
        e.hp = Math.max(0, e.hp - dmg)

        msg += `💠 *${dmg.toLocaleString()}* damage!${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`
        if (fusionLeft > 0) msg += `_Fusion of Equals: ${fusionLeft} turn${fusionLeft === 1 ? '' : 's'} left._\n`

        if (e.hp > 0) {
          const tearLine = applyTearOnHit(player, e, ctx)
          if (tearLine) msg += tearLine + '\n'
        }

        if (boss) {
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: dmg, isCrit, isHit: true,
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
      // CHUNK_MARKER_SP_COUNTER
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
             `*${p}attack* · *${p}soulpunisher* · *${p}kamehameha* · *${p}defend* · *${p}flee*`

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs
      await sendWillowAdvisory(ctx, player, e, boss)
      await ctx.reply(msg)



      return player
    })
  },
}
