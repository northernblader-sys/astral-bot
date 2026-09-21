/**
 * hougyoku.js — Aizen's Hōgyoku: The One Above All, his second combat move.
 *
 * Costs no MP and fires once per battle (bs.hougyokuUsed, set by
 * activateHogyoku() in lib/character-abilities.js — the same battleState flag
 * pattern the other actives use, so it resets with the fight for free).
 *
 * This one deals NO damage. It is pure evolution: the Hōgyoku reforges his
 * body (a third of max HP back), all five senses of the enemy's fall at once
 * (Kyōka Suigetsu completes on the spot — from here every struck blow against
 * him is misdirected), and every stat surges for the rest of the battle (the
 * Final Form strengthen pattern: duration 999, discarded with battleState
 * when the fight ends). The turn is spent evolving past the ceiling — and
 * unlike Gojo's Unlimited Void the enemy still gets their counter, because
 * nothing about the Hōgyoku touches them: they simply swing at whatever he
 * has become (see plugins/purple.js's enemy-turn block, reused verbatim).
 *
 * PvP: in a duel this hands off to pvp.js's pvpHogyoku() (the 'hougyoku'
 * action there), since this plugin only knows the PvE battleState shape
 * (bs.enemy). Kyōka Suigetsu's passive misdirect guards him in a duel too,
 * through applyIncomingDamage(), which the duel engine already calls.
 *
 * Usage: <prefix>hougyoku
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
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
  getBossTaunt,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateHogyoku,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { resolveSwarmAbility } from '../lib/swarm-combat.js'
import { pvpHogyoku } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * Sends the turn narration as a caption on the Aizen art (the one art in
 * existence that IS this moment), falling back to plain text if the image
 * cannot be sent. Same reasoning as plugins/purple.js: the charge is spent by
 * the time we get here, so a broken image must not swallow the turn.
 */
async function replyWithArt(ctx, text) {
  if (typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage('https://i.ibb.co/jvwH2Qfj/Aizen-Sosuke-The-One-Above-All.jpg', text)
  } catch {
    return ctx.reply(text)
  }
}

/**
 * runHogyoku(ctx) — the whole evolution turn, factored out of the plugin
 * object so the top-level dispatch can call it when needed. The plugin's own
 * run() is a thin wrapper around this.
 */
export async function runHogyoku(ctx) {
  const p = config.prefix

  // In a duel, the Hōgyoku hands off to the PvP turn engine: this plugin only
  // knows the PvE battleState shape (bs.enemy), so pvpHogyoku() resolves it
  // there instead (the 'hougyoku' action in pvp.js).
  if (ctx.player?.battleState?.type === 'pvp') {
    return pvpHogyoku(ctx)
  }

  await updatePlayer(ctx.db, ctx.from, async player => {
    const catTurn = await checkCatFormOngoingTurn(player, ctx, {
      boss: isBossFight(player),
    })
    if (catTurn.intercepted) return catTurn.returnValue

    const gate = activateHogyoku(player)
    if (!gate.ok) {
      if (gate.message) await ctx.reply(gate.message)
      return player
    }

    // Swarm floors: the Hōgyoku spends its turn evolving, folded into one
    // swarm turn exactly like kurohitsugi's swarm branch. It deals no damage
    // and freezes nothing: the pack still closes and re-aims at whatever he
    // has become. No kill can happen from the evolution itself, so no
    // floor-clear branch is needed (resolveSwarmAbility's shared kill routing
    // is still in place if that ever changes).
    if (player.battleState?.mode === 'swarm') {
      const reveal = gate.message
      return resolveSwarmAbility(player, ctx, () => ({ lines: [reveal] }))
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
      // He could not reach for it this turn, but the charge is already spent —
      // the Hōgyoku is his one attempt, same discipline as the other actives.
      msg += `💫 *${player.name}* is unable to act this turn, and the Hōgyoku lies quiet!\n`
    } else {
      // The evolution. Resolved entirely on `player` inside activateHogyoku —
      // heal, five senses, stat surge — and it carries its own reveal copy.
      msg += gate.message + '\n'
      // Report the evolution to the boss engine as a landed, damage-less hit so
      // phase logic that watches for the player acting still ticks.
      if (boss) {
        const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
          damage: 0, isCrit: false, isHit: true,
        })
        if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
        const phase = checkBossPhase(player)
        if (phase?.triggered && phase.lines?.length) {
          msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
        }
      }
    }

    // Enemy turn. The Hōgyoku does not touch them, so unlike the domain's
    // stun turn they still get their swing — at whatever he has become.
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
      msg += `\n${e.emoji ?? '👾'} *${e.name}* strikes at what he left behind... and *MISSES!*`
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
}

export default {
  name: 'hougyoku',
  aliases: ['hogyoku', 'transcend', 'transcendence', 'the-one-above-all'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}hougyoku — Aizen's once-per-battle evolution: reforge, complete hypnosis, stat surge (no MP)`,
  run: runHogyoku,
}
