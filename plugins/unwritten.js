/**
 * unwritten.js — Yato's ascended active, and the move that replaces Live Blast.
 *
 * He does not hit the enemy. He takes part of it back out of the world: each use
 * deletes a flat tenth of the enemy's ORIGINAL maxHp and clamps its current hp
 * down to the new ceiling. The mechanic, the numbers and the full design notes
 * live in eraseFromWorld() in lib/character-abilities.js. This file is the turn.
 *
 * Only reachable once player.yatoAscended is set, which happens exactly once per
 * player, on their first real defeat with Yato equipped (awakenYatoTrueForm(),
 * hooked into handleDeath() in lib/combat-handlers.js). Before that this command
 * refuses politely and says nothing about how to trigger it.
 *
 * The turn is the same shape as plugins/liveblast.js, with three differences:
 *
 *   1. NO CROWD, NO CHARGE. No stream, no dungeon, no Premium, no mana, no fame,
 *      and no once-per-battle latch. It can be used every single turn. The cost
 *      is the turn itself: one command is one full turn cycle in this bot, so
 *      nine erasures is nine turns of standing there being hit.
 *   2. IT CANNOT KILL. The floor in eraseFromWorld() stops maxHp at a tenth of
 *      where it started and hp is clamped to at least 1, so there is no victory
 *      branch on the erase step at all. The standard check after the enemy's
 *      status tick stays, because a poison tick can still finish the job.
 *   3. THE GATE IS READ-ONLY AND RUNS FIRST. canEraseFromWorld() mutates
 *      nothing, so a refused use (not ascended, or already at the floor) costs
 *      the player nothing. Same reasoning as the viewer check in liveblast.js
 *      sitting ahead of the latch: a refusal must never quietly spend a turn.
 *
 * Refuses duels outright, and that one is data safety rather than balance.
 * plugins/pvp.js operates on the real player records, so erasing maxHp there
 * would permanently damage a live player's stat sheet and desync the
 * applyEquipmentBonus() add/subtract pair on their next unequip.
 *
 * Usage: <prefix>unwritten
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
import { characterMap } from '../lib/game-data.js'
import {
  applyBossSpecial, checkBossPhase, buildEnemyAttack,
  getBossTaunt, getBossHitLine,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  canEraseFromWorld,
  eraseFromWorld,
  applyTearOnHit,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
  STREAMER_CHARACTER_ID,
} from '../lib/character-abilities.js'

/**
 * Art is sent on the FIRST erasure of a fight only, not all nine. The true form
 * showing itself is a moment; nine identical images in one battle is a wall.
 * Falls back to Yato's normal portrait until data/characters.json has a
 * trueForm.image, so this never sends a broken URL or a blank card.
 */
function trueFormArt() {
  const yato = characterMap[STREAMER_CHARACTER_ID]
  return yato?.trueForm?.image || yato?.image || ''
}

async function replyWithArt(ctx, text, withArt) {
  const art = withArt ? trueFormArt() : ''
  if (!art || typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage(art, text)
  } catch {
    return ctx.reply(text)
  }
}

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

export default {
  name: 'unwritten',
  aliases: ['unwrite', 'erase', 'uw'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}unwritten — Yato's true form: erases the enemy's maximum HP (no MP)`,

  async run(ctx) {
    const p = config.prefix

    // Refused before anything is read or spent. Nothing about a duel can be
    // edited safely, and falling into the PvE pipeline below would read bs.enemy
    // off a battleState that has no enemy on it.
    if (ctx.player?.battleState?.type === 'pvp') {
      return ctx.reply(
        `🕯️ *Not here.*\n\n` +
        `_There is no world to edit in a duel. There is only a person standing in ` +
        `front of you, and they are not his to take back._`
      )
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      const catTurn = await checkCatFormOngoingTurn(player, ctx, {
        boss: isBossFight(player),
      })
      if (catTurn.intercepted) return catTurn.returnValue

      const bs = player.battleState
      const e  = bs?.enemy

      // ── Read-only gate, ahead of every mutation in the turn ───────────────
      // Handles "not equipped", "not ascended", "not in battle" and "already at
      // the floor". A refusal here costs the player nothing: no status tick, no
      // boss turn, no enemy swing.
      const gate = canEraseFromWorld(player, e)
      if (!gate.ok) {
        await ctx.reply(gate.message)
        return player
      }

      const boss = isBossFight(player)
      // Read before eraseFromWorld() records the ceiling, so this is true only
      // on the first use in this fight.
      const firstUse = bs.unwrittenOrigMaxHp === undefined

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

      msg +=
        `🕯️ *UNWRITTEN*\n` +
        `─────────────\n`

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        const hpBefore = e.hp ?? 0
        const erase = eraseFromWorld(player, e)

        // Cannot happen: the gate above already cleared every refusal path and
        // nothing between the two can change them. Handled rather than assumed,
        // because silently continuing would print an erasure that never landed.
        if (!erase.ok) {
          await ctx.reply(erase.message)
          return player
        }

        const hpLost = Math.max(0, hpBefore - (e.hp ?? 0))

        msg +=
          `_He does not raise a hand. He stops agreeing that so much of ` +
          `*${e.name}* was ever there._\n\n` +
          `📉 *${erase.cut.toLocaleString()}* erased from its maximum.\n` +
          `🚫 Ceiling: *${erase.maxHpBefore.toLocaleString()}* → ` +
          `*${erase.maxHpAfter.toLocaleString()}* _(gone for good)_\n`
        if (hpLost > 0) msg += `🩸 *${hpLost.toLocaleString()}* of it was still standing in the way.\n`
        msg += erase.atFloor
          ? `_There is nothing left to take back. Kill the rest the ordinary way._\n`
          : `_Nothing it does can put that back._\n`

        // No-op while Yato is equipped (equippedCharacter is a single id, so an
        // owner cannot hold Urahara at the same time). Kept so this plugin
        // matches its siblings' turn shape and does not become the one entry
        // point that misses the hook if the Tear ever stops being character-gated.
        if (e.hp > 0) {
          const tearLine = applyTearOnHit(player, e, ctx)
          if (tearLine) msg += tearLine + '\n'
        }

        if (boss) {
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: hpLost, isCrit: false, isHit: true,
          })
          if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
          msg += `💬 _"${getBossHitLine(player)}"_\n`
        }

        // Deliberately NO victory check here. An erasure can never take anything
        // to 0 (see the floor and the Math.max(1, ...) clamp in eraseFromWorld),
        // so there is no killing blow to resolve on this branch.

        if (boss) {
          const phase = checkBossPhase(player)
          if (phase?.triggered && phase.lines?.length) {
            msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.map(l => `_${l}_`).join('\n') + '\n'
          }
        }
      }

      const enemyStatus = processStatusTurn(e)
      if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
      // This one stays: erasure cannot kill, but a poison or burn tick on the
      // shrunken pool absolutely can.
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
             `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}  _max ${e.maxHp.toLocaleString()}_\n\n` +
             `*${p}unwritten* · *${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs
      await sendWillowAdvisory(ctx, player, e, boss)
      await replyWithArt(ctx, msg, firstUse)
      return player
    })
  },
}
