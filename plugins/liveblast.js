/**
 * liveblast.js — Yato's one combat move.
 *
 * Costs no MP and fires once per battle (bs.liveBlastUsed, set by
 * activateLiveBlast() in lib/character-abilities.js — the same battleState
 * flag pattern activateCinderVerdict/activateFinalForm use, so it resets with
 * the fight for free).
 *
 * The turn is the same shape as plugins/cinderverdict.js — status tick, the
 * burst, boss-engine hooks, then the enemy's counter-attack and bs.turn++ —
 * with two deliberate differences:
 *
 *   1. THE CROWD IS THE DAMAGE. Damage is viewers × DAMAGE_PER_VIEWER, read
 *      live out of plugins/stream.js. No stat roll, no crit, no accuracy
 *      roll, and it bypasses DEF: this isn't a swing, it's ten thousand
 *      people looking at the same monster at once, and armour has no answer
 *      for that. An empty stream deals literally nothing, which is the whole
 *      balance lever — see the tuning note below.
 *   2. THE VIEWER CHECK COMES BEFORE THE GATE. activateLiveBlast() burns the
 *      once-per-battle latch, so a player who fires this with no crowd would
 *      otherwise lose the move for the rest of the fight to a no-op. The
 *      crowd is checked first and rejected without touching the latch.
 *
 * Tuning: viewers cap at fame × 0.02 (calcMaxViewers in stream.js), so at
 * DAMAGE_PER_VIEWER = 5 a full house pays out fame × 0.1 damage — 250k fame
 * (today's top tier) caps at ~25,000, and a 500k-fame owner caps at 10,000
 * viewers → 50,000 damage, exactly one 50k-HP boss. Fame is what scales this,
 * not what unlocks Yato: his spin has no fame wall, so a low-fame owner simply
 * gets a small crowd and a small blast. The one-tap is earned by the fame, and
 * it still costs a Premium stream, a dungeon, and a fight spent letting the
 * crowd build.
 *
 * Usage: <prefix>live-blast
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
  getBossTaunt, getBossHitLine,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateLiveBlast,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
  hasYatoTrueForm,
  LIVE_BLAST_RETIRED_MESSAGE,
} from '../lib/character-abilities.js'
import { getStreamViewers, isStreaming } from './stream.js'

/** Damage contributed by each live viewer. See the tuning note above. */
const DAMAGE_PER_VIEWER = 5

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

export default {
  name: 'live-blast',
  aliases: ['liveblast', 'lb', 'blast'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}live-blast — Yato's once-per-battle crowd burst (no MP)`,

  async run(ctx) {
    const p = config.prefix

    // ── Retired by the true form ──────────────────────────────────────────
    // Sits ahead of EVERYTHING, including the crowd check further down, because
    // an ascended player who isn't streaming would otherwise be told "you're not
    // live" about a move that no longer exists. Ascension is one-way, so this is
    // permanent: see awakenYatoTrueForm() in lib/character-abilities.js.
    // activateLiveBlast() carries the same guard for any other caller.
    if (hasYatoTrueForm(ctx.player)) {
      return ctx.reply(LIVE_BLAST_RETIRED_MESSAGE)
    }

    // Streaming requires being inside a dungeon (see plugins/stream.js), so a
    // duel can never have a crowd behind it. Say so rather than falling into
    // the PvE pipeline below, which would read bs.enemy off a battleState
    // that doesn't have one.
    if (ctx.player?.battleState?.type === 'pvp') {
      return ctx.reply(
        `📵 *Live Blast doesn't reach a duel.*\n\n` +
        `_The crowd only gathers on a dungeon run — there's no stream to draw power from here._`
      )
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      // ── The crowd, checked BEFORE the latch is spent ──────────────────
      const viewers = getStreamViewers(player.id)
      if (viewers <= 0) {
        await ctx.reply(
          isStreaming(player.id)
            ? `📵 *Nobody's watching yet.*\n\n_Your stream is live but the room is empty — Live Blast has nothing to convert. Keep fighting and let the crowd build._`
            : `📵 *You're not live.*\n\n_Live Blast runs on an audience. Go live with *${p}stream start* inside a dungeon, let the crowd build over a few turns, then fire._`
        )
        return player
      }

      const gate = activateLiveBlast(player)
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
        `📺🔴 *LIVE BLAST*\n` +
        `─────────────\n` +
        `👁️ *${viewers.toLocaleString()}* viewers turn on *${e.name}* at once.\n\n`

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        // No accuracy roll and no DEF: a broadcast doesn't miss and armour
        // doesn't stop being watched. The crowd IS the number.
        const dmg = Math.floor(viewers * DAMAGE_PER_VIEWER)
        e.hp = Math.max(0, e.hp - dmg)

        msg += `💥 *${dmg.toLocaleString()}* damage! _(ignores DEF)_\n`
        msg += `💬 _chat is going insane_\n`

        if (e.hp > 0) {
          const tearLine = applyTearOnHit(player, e, ctx)
          if (tearLine) msg += tearLine + '\n'
        }

        if (boss) {
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: dmg, isCrit: false, isHit: true,
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
