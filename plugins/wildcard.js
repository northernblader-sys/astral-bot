/**
 * wildcard.js — Circe, the Jester's one combat move (Boundless tier).
 *
 * Costs no MP and fires three times per battle (bs.wildCardUses, managed by
 * drawWildCard() in lib/character-abilities.js — the same battleState-flag
 * pattern activateFinalForm/activateCinderVerdict use, so it resets with the
 * fight for free).
 *
 * The turn is deliberately the same shape as plugins/cinderverdict.js:
 * accuracy roll, damage through calcPlayerDamage() -> applyDefense(), boss
 * engine hooks when fighting an anime boss, then the enemy's counter-attack.
 * What's different is that the draw is RANDOM and only two of the six cards
 * deal damage at all:
 *
 *   🌟 Wishing Star        — 12x, and outright executes a non-boss monster
 *   🎭 Fool's Gambit       — 2.5x, cannot miss, ignores their DEF
 *   🃏 Final Dash          — arms one guaranteed dodge
 *   🤡 Last Laugh          — enemy hits 50% weaker for 10 turns
 *   🎪 Wings of a Butterfly — enemy hits scatter into copies for 5 turns
 *   🦋 Vanishing Act       — only when nearly dead: ends the fight, back to town
 *
 * The three defensive cards do nothing here on the turn they're drawn — they
 * arm state that lib/character-abilities.js's applyIncomingDamage() reads, so
 * they take effect on the counter-attack at the bottom of this very turn. That
 * is intentional: spending a draw always does something visible immediately.
 *
 * Usage: <prefix>wildcard
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
  hasCirce,
  wildCardUsesLeft,
  drawWildCard,
  resolveWildCard,
  buildWildCardReveal,
  circeGuardStatus,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { pvpWildCard } from './pvp.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/** Trailing "🤡 Last Laugh: 7 turns left" style line, or '' when nothing is up. */
function buildGuardStatusLine(player) {
  const g = circeGuardStatus(player)
  const parts = []
  if (g.finalDash) parts.push(`🃏 _Final Dash armed_`)
  if (g.lastLaugh > 0) parts.push(`🤡 _Last Laugh ${g.lastLaugh}t_`)
  if (g.butterfly > 0) parts.push(`🎪 _Copies ${g.butterfly}t_`)
  return parts.length ? `\n${parts.join(' · ')}` : ''
}

export default {
  name: 'wildcard',
  aliases: ['wc', 'circe', 'wild'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}wildcard — Circe's Wild Card: draw one of six fates (3 per battle, no MP)`,

  async run(ctx) {
    const p = config.prefix

    // Wild Card works in duels too. PvP uses a two-player battleState (no
    // bs.enemy) and its own turn engine, so hand off to pvp.js rather than
    // running the PvE boss/monster pipeline below against a shape it can't read.
    if (ctx.player?.battleState?.type === 'pvp') {
      return pvpWildCard(ctx)
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      // ── Cheap up-front gates ──────────────────────────────────────────
      // Checked BEFORE the status ticks below, and deliberately without
      // consuming a draw: drawWildCard() is what spends one, and it isn't
      // called until we're actually committed to resolving a card. Gating
      // here means a turn where start-of-turn poison kills you doesn't also
      // eat one of her three draws.
      if (!hasCirce(player)) {
        await ctx.reply(
          `🃏 *Wild Card* belongs to *Circe, the Jester*.\n` +
          `_Equip her with_ *${p}character equip circe* _first._`,
        )
        return player
      }
      if (!player.inBattle || !player.battleState) {
        await ctx.reply(`❌ *Not in battle.* Use *${p}dungeon* to find an enemy.`)
        return player
      }
      if (!player.battleState.enemy) {
        await ctx.reply(`⚠️ *No enemy found in your battle state.* _Use *${p}cb* to clear it and try again._`)
        return player
      }
      if (wildCardUsesLeft(player) <= 0) {
        await ctx.reply(
          `🃏 *Her hand is empty.*\n` +
          `_All 3 draws are spent this battle._\n\n` +
          `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`,
        )
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
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
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
        // Can't snap her fingers while frozen/stunned — and since no draw has
        // been spent yet, the card is still hers to play next turn.
        msg += `💫 *${player.name}* is unable to act this turn!\n`
        msg += `\n\n👤 *${player.name}*\n❤️ ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp}/${player.maxMp} MP\n` +
               `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}\n\n` +
               `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`
        bs.turn = (bs.turn ?? 1) + 1
        player.battleState = bs
        await ctx.reply(msg)
        return player
      }

      // ── The draw ──────────────────────────────────────────────────────
      // Vanishing Act is in the pool only when she's at her limit; that gate
      // lives in wildCardPool().
      const draw = drawWildCard(player, { allowEscape: true })
      if (!draw.ok) {
        await ctx.reply(draw.message)
        return player
      }

      const outcome = resolveWildCard(player, draw.card, { isPvp: false, enemyIsBoss: boss })
      const outcomeLines = [...outcome.lines]

      // ── 🦋 Vanishing Act — the fight is simply over ────────────────────
      // resolveWildCard() has already cleared inBattle/battleState and moved
      // her to town, so there is no counter-attack and nothing left to tick.
      if (outcome.kind === 'escape') {
        if (boss) cleanupBossFight(player)
        await ctx.reply(
          msg +
          buildWildCardReveal(draw.card, draw, outcomeLines) +
          `\n\n🏙️ _She reappears in the neighbouring town, entirely unbothered._\n` +
          `📍 *Astral Town* — the fight with *${e.name}* is over.\n` +
          `_No loot, no XP, no scratch on her._\n\n` +
          `*${p}dungeon* _to head back out._`,
        )
        return player
      }

      msg += buildWildCardReveal(draw.card, draw, outcomeLines) + '\n\n'

      // ── Damage cards ──────────────────────────────────────────────────
      if (outcome.kind === 'damage') {
        // Fool's Gambit can't miss — she's swinging at herself, then trading
        // places. Wishing Star still has to connect.
        const hits = outcome.guaranteedHit || Math.random() <= calcPlayerHitChance(player, e)

        if (!hits) {
          msg += `💨 The star drifts wide — *MISSED!*\n`
          if (boss) {
            const missResult = applyBossSpecial(player, EVENT.PLAYER_MISS, { isMiss: true })
            msg += `💬 _"${getBossDodgeLine(player)}"_\n`
            if (missResult.narrativeLine) msg += `_${missResult.narrativeLine}_\n`
          }
        } else if (outcome.execute) {
          // "There is nothing left standing where the enemy used to be."
          e.hp = 0
          msg += `☄️ *${e.name}* is erased where it stood. _(no HP left to check)_\n`
          if (boss) cleanupBossFight(player)
          await ctx.reply(msg)
          return handleVictory(player, e, ctx)
        } else {
          const { rawDmg, isCrit } = calcPlayerDamage(player, null, outcome.multiplier)
          const dmg = outcome.ignoreDefense ? rawDmg : applyDefense(rawDmg, e.def)
          e.hp = Math.max(0, e.hp - dmg)

          msg += `🩸 *${dmg}* damage!${isCrit ? ' 💥 *CRITICAL!*' : ''}` +
                 `${outcome.ignoreDefense ? ' _(ignores DEF)_' : ''}\n`

          if (e.hp > 0) {
            const tearLine = applyTearOnHit(player, e, ctx)
            if (tearLine) msg += tearLine + '\n'
          }

          if (boss) {
            const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
              damage: dmg, element: 'physical', isCrit, isHit: true,
            })
            if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
            msg += `💬 _"${getBossHitLine(player)}"_\n`
          }

          if (e.hp <= 0) {
            if (boss) cleanupBossFight(player)
            await ctx.reply(msg)
            return handleVictory(player, e, ctx)
          }

          if (boss) {
            const phase = checkBossPhase(player)
            if (phase?.triggered && phase.lines?.length) {
              msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
            }
          }
        }
      }

      // ── Enemy's turn ──────────────────────────────────────────────────
      const enemyStatus = processStatusTurn(e)
      if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        await ctx.reply(msg)
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
        // Final Dash / Wings / Last Laugh all resolve inside here.
        const applied = applyIncomingDamage(player, incoming)
        msg += `\n${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
        if (applied.message) msg += applied.message + '\n'
        if (applied.damage > 0) {
          msg += `🩸 *${applied.damage}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
        }
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
        msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates!\n`
        if (applied.message) msg += applied.message + '\n'
        if (applied.damage > 0) msg += `🩸 *${applied.damage}* damage!`
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
             `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}` +
             buildGuardStatusLine(player) +
             `\n🎟️ _Draws left: ${wildCardUsesLeft(player)}/3_\n\n` +
             `*${p}wildcard* · *${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs
      await sendWillowAdvisory(ctx, player, e, boss)
      await ctx.reply(msg)
      return player
    })
  },
}
