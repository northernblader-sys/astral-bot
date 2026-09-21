/**
 * kurohitsugi.js — Aizen's Kurohitsugi (Hadō #90), one of his two combat moves.
 *
 * Costs no MP and fires once per battle (bs.kurohitsugiUsed, set by
 * activateKurohitsugi() in lib/character-abilities.js — the same battleState
 * flag pattern activateHollowPurple/activateCinderVerdict use, so it resets
 * with the fight for free).
 *
 * The turn is the same shape as plugins/cinderverdict.js and plugins/purple.js
 * — status tick, the burst, boss-engine hooks, then the enemy's counter-attack
 * and bs.turn++ — and it carries Hollow Purple's two deliberate rules:
 *
 *   1. IT BYPASSES DEF. A coffin of distorted time-space crushes what is inside
 *      it; the multiplier from calcPlayerDamage() is applied raw, WITHOUT
 *      applyDefense(). No armour softens Kurohitsugi.
 *   2. IT NEVER MISSES. There is no accuracy roll. Crit still rolls (it comes
 *      out of calcPlayerDamage), but the hit always lands.
 *
 * The one thing that differs from Hollow Purple is the multiplier itself: not
 * a flat 18 but kurohitsugiMultiplier(), which scales UP with every sense
 * Kyōka Suigetsu has already stolen this fight AND with how wounded the enemy
 * already is (see the KUROHITSUGI_* constants). It is the closer — held for a
 * wounded enemy late in a completed hypnosis, it is the hardest single hit in
 * the game; opened early it is merely strong.
 *
 * PvP: in a duel this hands off to pvp.js's pvpKurohitsugi() (the 'kurohitsugi'
 * action there), since this plugin only knows the PvE battleState shape
 * (bs.enemy). Kyōka Suigetsu's passive misdirect guards him in a duel too,
 * through applyIncomingDamage(), which the duel engine already calls.
 *
 * Usage: <prefix>kurohitsugi
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
  activateKurohitsugi,
  kurohitsugiMultiplier,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
  aizenSenses,
  AIZEN_MAX_SENSES,
} from '../lib/character-abilities.js'
import { resolveSwarmAbility } from '../lib/swarm-combat.js'
import {
  kurohitsugiCastLine, kurohitsugiImpactLine,
} from '../lib/aizen-flavor.js'
import { pvpKurohitsugi } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * Sends the turn narration as a caption on the Aizen art, falling back to
 * plain text if the image cannot be sent (dead URL, a platform whose ctx has
 * no replyImage). Same reasoning as plugins/purple.js: the move is once per
 * battle and the charge is already spent by the time we reach here, so a
 * broken image must never swallow the turn the player paid for.
 */
async function replyWithArt(ctx, text) {
  if (typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage('https://i.ibb.co/jvwH2Qfj/Aizen-Sosuke-The-One-Above-All.jpg', text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'kurohitsugi',
  aliases: ['kuro', 'blackcoffin', 'black-coffin', 'coffin', 'hado90'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}kurohitsugi — Aizen's once-per-battle Hadō #90 (no MP, bypasses DEF, crushes the wounded)`,

  async run(ctx) {
    const p = config.prefix

    // In a duel, Kurohitsugi hands off to the PvP turn engine: this plugin only
    // knows the PvE battleState shape (bs.enemy), so pvpKurohitsugi() resolves
    // it there instead. Kyōka Suigetsu still guards him in a duel too, through
    // applyIncomingDamage(), which pvp.js already calls.
    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpKurohitsugi(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const gate = activateKurohitsugi(player)
      if (!gate.ok) {
        if (gate.message) await ctx.reply(gate.message)
        return player
      }

      // Swarm floors: fold the coffin into one swarm turn against the nearest
      // threat, the same shape kurama.js/puppetry.js/timestop.js use. The
      // coffin crushes THAT one monster RAW (no armour softens Hadō #90) and
      // the rest of the pack still closes and re-aims, so he swings a floor
      // without wrongly clearing it: kills route through resolveSwarmAbility's
      // shared branch, where only the floor-clearing blow hands off to
      // handleVictory. Without this branch the1v1 turn below ran against
      // bs.enemy and a kill called handleVictory while other monsters were
      // still alive, wiping the pack for free.
      if (player.battleState?.mode === 'swarm') {
        return resolveSwarmAbility(player, ctx, (target) => {
          const senses = aizenSenses(player)
          const executeTier = (target.maxHp ?? 0) > 0 && (target.hp / target.maxHp) < 0.35
          const mult = kurohitsugiMultiplier(player, target)
          const { rawDmg, isCrit } = calcPlayerDamage(player, null, mult)
          const dmg = Math.max(1, Math.round(rawDmg))
          target.hp = Math.max(0, target.hp - dmg)
          const lines = [
            `⬛ *KUROHITSUGI* ⬛`,
            `─────────────`,
            kurohitsugiCastLine(senses),
          ]
          if (senses > 0) {
            lines.push(`_He already owns ${senses}/${AIZEN_MAX_SENSES} of their senses. The seal tightens around what remains._`)
          }
          lines.push(`⬛ *${dmg.toLocaleString()}* damage! _(ignores DEF)_${isCrit ? ' 💥 *CRITICAL!*' : ''}`)
          lines.push(kurohitsugiImpactLine({ execute: executeTier, kill: target.hp <= 0 }))
          return { lines }
        })
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

      const senses = aizenSenses(player)
      msg +=
        `⬛ *KUROHITSUGI* ⬛\n` +
        `─────────────\n` +
        `${kurohitsugiCastLine(senses)}\n` +
        (senses > 0 ? `_He already owns ${senses}/${AIZEN_MAX_SENSES} of their senses. The seal tightens around what remains._\n` : '') +
        `\n`

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        // Multiplier from the two scales (stolen senses + how wounded the
        // enemy already is), applied RAW: Kurohitsugi never misses and no
        // armour softens it, so there is no accuracy roll and no
        // applyDefense(). Crit still comes out of calcPlayerDamage.
        const executeTier = (e.maxHp ?? 0) > 0 && (e.hp / e.maxHp) < 0.35
        const mult = kurohitsugiMultiplier(player, e)
        const { rawDmg, isCrit } = calcPlayerDamage(player, null, mult)
        const dmg = Math.max(1, Math.round(rawDmg))
        e.hp = Math.max(0, e.hp - dmg)

        msg += `⬛ *${dmg.toLocaleString()}* damage! _(ignores DEF)_${isCrit ? ' 💥 *CRITICAL!*' : ''}\n`
        msg += `${kurohitsugiImpactLine({ execute: executeTier, kill: e.hp <= 0 })}\n`

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
