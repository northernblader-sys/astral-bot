/**
 * purple.js — Gojo's Hollow Purple, one of his two combat moves.
 *
 * Costs no MP and fires once per battle (bs.hollowPurpleUsed, set by
 * activateHollowPurple() in lib/character-abilities.js — the same battleState
 * flag pattern activateCinderVerdict/activateLiveBlast use, so it resets with
 * the fight for free).
 *
 * The turn is the same shape as plugins/cinderverdict.js — status tick, the
 * burst, boss-engine hooks, then the enemy's counter-attack and bs.turn++ —
 * with two deliberate differences from Cinder Verdict:
 *
 *   1. IT BYPASSES DEF. The imaginary mass of Blue and Red clashing erases what
 *      is in its path, so the multiplier from calcPlayerDamage() is applied
 *      raw, WITHOUT applyDefense(). Cinder Verdict is mitigated; this is not.
 *   2. IT NEVER MISSES. There is no accuracy roll. Crit still rolls (it comes
 *      out of calcPlayerDamage), but the hit always lands.
 *
 * PvP: in a duel this hands off to pvp.js's pvpHollowPurple() (the 'hollowpurple'
 * action there), since this plugin only knows the PvE battleState shape (bs.enemy).
 * Gojo's Infinity passive guards him in a duel too, through applyIncomingDamage(),
 * which the duel engine already calls.
 *
 * Usage: <prefix>hollowpurple
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
  activateHollowPurple,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpHollowPurple } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

// The burst itself. Sent as the caption image on the turn Hollow Purple fires,
// not on the refusals above it — a player who already spent the charge, or who
// tried it in a duel, is being told "no", and art on a "no" reads as if the
// move went off.
const HOLLOW_PURPLE_ART = 'https://i.ibb.co/k6z3nW7K/hollow-purple.jpg'

/**
 * Sends the turn narration as a caption on the Hollow Purple art, falling back
 * to plain text if the image cannot be sent (dead URL, a platform whose ctx has
 * no replyImage). The fallback is the whole point: this move is once per battle
 * and the charge is already spent by the time we reach here, so a broken image
 * must never swallow the turn the player paid for.
 */
async function replyWithArt(ctx, text) {
  if (typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage(HOLLOW_PURPLE_ART, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'hollowpurple',
  // 'hp' is the short form players actually type. It collides with nothing
  // else in the registry (checked across all three plugin dirs) and 'hx' is
  // already taken by hollowexchange.js, so the two shorthands stay distinct.
  aliases: ['purple', 'hollow-purple', 'hp'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}hollowpurple — Gojo's once-per-battle Hollow Purple (no MP, bypasses DEF)`,

  async run(ctx) {
    const p = config.prefix

    // In a duel, Hollow Purple hands off to the PvP turn engine: this plugin
    // only knows the PvE battleState shape (bs.enemy), so pvpHollowPurple()
    // resolves it there instead. Infinity still guards Gojo in a duel too,
    // through applyIncomingDamage(), which pvp.js already calls.
    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpHollowPurple(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const gate = activateHollowPurple(player)
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

      const playerStatus = processStatusTurn(player)
      if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }

      msg +=
        `🟦🟥 *HOLLOW PURPLE*\n` +
        `─────────────\n` +
        `_Blue draws *${e.name}* in. Red throws them out. Gojo brings his hands together, and the two become one._\n\n`

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        // Multiplier from the stock roll, but applied RAW: Hollow Purple never
        // misses and no armour softens it, so there is no accuracy roll and no
        // applyDefense(). Crit still comes out of calcPlayerDamage.
        const { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
        const dmg = Math.max(1, Math.round(rawDmg))
        e.hp = Math.max(0, e.hp - dmg)

        msg += `🟪 *${dmg.toLocaleString()}* damage! _(ignores DEF)_${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`
        msg += `_Everything in the line simply stops being there._\n`

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
      await replyWithArt(ctx, msg)
      return player
    })
  },
}
