/**
 * kurama.js — Naruto Uzumaki's one combat move: summon the Nine Tails.
 *
 * Costs no MP and fires once per battle (bs.kuramaUsed, set by activateKurama()
 * in lib/character-abilities.js — the same battleState latch every other active
 * uses, so it resets with the fight for free). Two things set it apart from the
 * rest of the roster's finishers, both handled inside activateKurama():
 *
 *   1. It costs NARUTO his own health. Baryon Mode burns a slice of his max HP
 *      to hold the fusion (floored so it can never self-kill). Even a miss pays
 *      the cost, the same way Cinder Verdict spends its charge on a whiff — the
 *      gamble is the point.
 *   2. On top of the strike it drags the enemy's lifespan out: resolveKuramaDrain
 *      removes a flat share of the enemy's MAX HP as true damage no armour
 *      touches, applied right after the main hit lands.
 *
 * The turn is deliberately the same shape as plugins/cinderverdict.js: accuracy
 * roll, the strike through calcPlayerDamage() -> applyDefense(), the lifespan
 * drain rider, boss-engine hooks when fighting an anime boss, then the enemy's
 * normal counter-attack. Unlike Red Rose's Puppet Strings there is no tangle —
 * the enemy answers on the same turn, so this is a heavy finisher, not a lock.
 *
 * Swarm floors fold it into one swarm turn against the nearest threat, exactly
 * like Puppet Strings does, but without cancelling the wind-up: the fox tears
 * one monster and the rest of the pack still closes.
 *
 * PvP: in a duel this hands off to pvp.js's pvpKurama() (the 'kurama' action
 * there), since this plugin only knows the PvE battleState shape (bs.enemy).
 *
 * Usage: <prefix>kurama
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
  activateKurama,
  resolveKuramaDrain,
  buildKuramaReveal,
  sendKuramaSummonImage,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpKurama } from './pvp.js'
import { resolveSwarmAbility } from '../lib/swarm-combat.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * runKurama(ctx) — the whole Baryon Mode summon turn. Kept as its own exported
 * function so a general dispatcher could call it, mirroring runPuppetStrings();
 * the plugin's run() is a thin wrapper.
 */
export async function runKurama(ctx) {
  const p = config.prefix

  // In a duel, the summon hands off to the PvP turn engine: this plugin only
  // knows the PvE battleState shape (bs.enemy). Same handoff Cinder Verdict uses.
  if (ctx.player?.battleState?.type === 'pvp') {
    return pvpKurama(ctx)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, {
      boss: isBossFight(player),
    })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activateKurama(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    // The Nine Tails summon splash, its own message the moment the fusion
    // commits and before the turn text, covering the solo, boss and swarm paths
    // alike. Media failure never blocks the turn (sendKuramaSummonImage swallows
    // it), same as Megumi's Domain splash.
    await sendKuramaSummonImage(ctx, `🦊🌀 *${player.name} tears the seal open. KURAMA answers.*`, ctx.from)

    // Swarm floors: fold the summon into one swarm turn against the nearest
    // threat. The fox tears that one monster (the strike through its own guard,
    // then the lifespan drain on top), but nothing is tangled — the rest of the
    // pack still closes and re-aims, so Baryon Mode swings a floor without
    // freezing it. Kills route through the shared branch so the drain can never
    // wrongly clear a floor while other monsters are still alive.
    if (player.battleState?.mode === 'swarm') {
      const selfCostLine = gate.selfCostLine
      return resolveSwarmAbility(player, ctx, (target) => {
        const { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
        const dmg = applyDefense(rawDmg, getEffectiveStat(target, 'def'))
        target.hp = Math.max(0, target.hp - dmg)
        const drainRes = resolveKuramaDrain(target, gate.drainPct)
        target.hp = drainRes.newHp
        const lines = []
        if (selfCostLine) lines.push(selfCostLine)
        lines.push(buildKuramaReveal(player.name, target.name, {
          mainDmg: dmg, isCrit, drain: drainRes.drain, context: 'dungeon',
        }))
        return { lines }
      })
    }

    const bs   = player.battleState
    const e    = bs.enemy
    const boss = isBossFight(player)

    bs.playerDefending = false
    let msg = ''

    // Urahara's permanent Tear — action-triggered tick, same as every other
    // combat entry point.
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

    // The fusion is committed — the self-cost is already paid inside the gate,
    // so it is shown here whether the strike lands, misses, or he cannot act.
    if (gate.selfCostLine) msg += gate.selfCostLine + '\n'

    if (playerStatus.incapacitated) {
      msg +=
        `🦊🌀 *BARYON MODE: KURAMA*\n` +
        `─────────────\n` +
        `💫 *${player.name}* cannot hold the fusion this turn, and the moment passes!\n`
    } else if (Math.random() > calcPlayerHitChance(player, e)) {
      msg += buildKuramaReveal(player.name, e.name, {
        missed: true, context: boss ? 'boss' : 'dungeon',
      }) + '\n'
      if (boss) {
        const missResult = applyBossSpecial(player, EVENT.PLAYER_MISS, { isMiss: true })
        msg += `💬 _"${getBossDodgeLine(player)}"_\n`
        if (missResult.narrativeLine) msg += `_${missResult.narrativeLine}_\n`
      }
    } else {
      // Stock damage pipeline — the Baryon multiplier is passed as
      // damageMultiplier, and applyDefense still mitigates the result.
      const { rawDmg, isCrit } = calcPlayerDamage(player, null, gate.multiplier)
      const dmg = applyDefense(rawDmg, e.def)
      e.hp = Math.max(0, e.hp - dmg)

      // The lifespan drain rider — true damage, a flat share of the enemy's max
      // HP, no armour applies. Applied after the strike so the two together can
      // finish an enemy the strike alone left standing.
      const drainRes = resolveKuramaDrain(e, gate.drainPct)
      e.hp = drainRes.newHp

      msg += buildKuramaReveal(player.name, e.name, {
        mainDmg: dmg, isCrit, drain: drainRes.drain,
        context: boss ? 'boss' : 'dungeon',
      }) + '\n'

      if (boss) {
        const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: dmg + drainRes.drain, isCrit, isHit: true,
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
}

export default {
  name: 'kurama',
  aliases: ['baryon', 'kuramamode', 'ninetails', 'bijuu', 'krm'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}kurama — Naruto's once-per-battle Nine Tails summon. Burns his own lifespan for one overwhelming strike that drains the enemy's lifespan too (no MP)`,
  run: runKurama,
}
