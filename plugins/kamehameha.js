/**
 * kamehameha.js — Gogeta's Big Bang Kamehameha, the ultimate.
 *
 * Three walls in front of it, all enforced by activateBigBangKamehameha() in
 * lib/gogeta.js: the fusion must still be holding, the energy bar must be
 * FULL (and firing empties it), and there is an eight-turn cooldown on top
 * that the fusion clock usually outlives. In practice most fights only ever
 * see this once, which is the intent.
 *
 * The turn is the same shape as plugins/purple.js, and shares Hollow Purple's
 * two exemptions:
 *
 *   1. IT BYPASSES DEF. calcPlayerDamage()'s roll is applied raw, with no
 *      applyDefense(). Armour is not a meaningful answer to this.
 *   2. IT NEVER MISSES. No accuracy roll. Crit still rolls.
 *
 * ART: this is the one place in the bot that sends KAMEHAMEHA_IMAGE, and it
 * sends it only on the turn the beam actually fires. Every refusal above (no
 * energy, cooldown, fusion already broken, wrong character) is plain text, on
 * purpose: art on a "no" reads as if the move went off.
 *
 * PvP: hands off to pvp.js's pvpKamehameha() ('kamehameha' action there),
 * since this plugin only knows the PvE battleState shape (bs.enemy).
 *
 * Usage: <prefix>kamehameha
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  calcPlayerDamage,
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
  activateBigBangKamehameha,
  fusionTurnsLeft,
  KAMEHAMEHA_IMAGE,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpKamehameha } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * Sends the turn narration as a caption on the Kamehameha art, falling back to
 * plain text if the image cannot be sent (dead URL, a platform whose ctx has no
 * replyImage). The fallback is the whole point: the energy bar is already
 * emptied and the cooldown already set by the time we reach here, so a broken
 * image must never swallow the turn the player paid for.
 */
async function replyWithArt(ctx, text) {
  if (typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage(KAMEHAMEHA_IMAGE, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'kamehameha',
  aliases: ['bbk', 'bigbang', 'bigbangkamehameha', 'kame', 'big-bang-kamehameha'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}kamehameha: Gogeta's Big Bang Kamehameha (full energy bar, bypasses DEF)`,

  async run(ctx) {
    const p = config.prefix

    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpKamehameha(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const gate = activateBigBangKamehameha(player)
      if (!gate.ok) {
        if (gate.message) await ctx.reply(gate.message)
        return player
      }
      // CHUNK_MARKER_BBK_TURN
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

      // processStatusTurn also ticks the fusion clock (lib/combat-handlers.js).
      // The gate above already refused a broken fusion, so a break narrated
      // here is the fusion running out on the very turn the beam went off.
      const playerStatus = processStatusTurn(player)
      if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }

      const fusionLeft = fusionTurnsLeft(player, bs)
      msg +=
        `🔵💥 *BIG BANG KAMEHAMEHA* 💥🔵\n` +
        `─────────────\n` +
        `_Hands together, elbows locked, every last scrap of energy pulled into one point. ` +
        `Then it opens, and there is nothing between Gogeta and *${e.name}* any more, because there is no longer a between._\n\n`
      if (gate.extra) msg += gate.extra + '\n'
      // CHUNK_MARKER_BBK_DAMAGE
      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        // Applied RAW: no accuracy roll and no applyDefense(). Crit still comes
        // out of calcPlayerDamage.
        const { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
        const dmg = Math.max(1, Math.round(rawDmg))
        e.hp = Math.max(0, e.hp - dmg)

        msg += `🌀 *${dmg.toLocaleString()}* damage! _(ignores DEF)_${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`
        msg += `💧 _Energy bar spent down to nothing._\n`
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
      // CHUNK_MARKER_BBK_COUNTER
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
             `*${p}attack* · *${p}soulpunisher* · *${p}defend* · *${p}flee*`

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs
      await sendWillowAdvisory(ctx, player, e, boss)
      await replyWithArt(ctx, msg)



      return player
    })
  },
}
