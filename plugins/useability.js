/**
 * useability.js — use an equipped *active* ability in battle.
 * Structured the same way plugins/skill.js resolves a skill: accuracy roll,
 * damage/effect application via lib/ability-engine.js, boss-engine hooks
 * when fighting an anime boss, then the enemy's counter-attack.
 *
 * Cooldown model: cooldownTurns is tracked per-battle like skill.js tracks
 * mpCost, but as a turn counter instead of a resource — battleState.turn
 * already increments on every combat action, so we just remember the
 * battle-turn number an ability becomes usable again on.
 *
 * Usage: <prefix>useability <slot # or name>
 *
 * A one-of-one Premium ability (player.premiumAbility — Freeze Touch and the
 * other four) is listed here too and, when named, routed to its own active
 * command body: it is not an equippedAbilities entry, so it never resolved here
 * before and a monthly buyer read "None equipped" for an ability they hold.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  calcPlayerHitChance, calcMonsterHitChance, calcMonsterDamage, hpBar,
} from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
  resolveCatFormDefeat,
} from '../lib/combat-handlers.js'
import { getEffectiveStat, addStatusEffect } from '../lib/effects.js'
import { findEquippedAbility, resolveActiveAbility, getAbilityDef } from '../lib/ability-engine.js'
import {
  applyBossSpecial, checkBossPhase, buildEnemyAttack,
  getBossTaunt, getBossHitLine, getBossDodgeLine,
  incrementBossTurn, cleanupBossFight, EVENT,
} from '../lib/boss-engine.js'
import {
  activateFinalForm,
  applyTearOnHit,
  sendFinalFormVideo,
  sendWillowAdvisory,
  tickPermanentSever,
  applyIncomingDamage,
} from '../lib/character-abilities.js'
import { sendCinematicBossTurn } from '../lib/boss-cinematic.js'
import { getPlayerAbility } from '../lib/premium-abilities.js'
import { runPremiumActive } from '../lib/premium-active-runner.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/** Case- and separator-insensitive key, so "freeze touch" == freeze_touch. */
const fold = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The one-of-one Premium ability THIS player holds, when `query` names it (by
 * id, name, active name or one of the active's aliases). Null for anyone
 * else's ability, or for a slot ability — those resolve through
 * findEquippedAbility() instead.
 */
export function findHeldPremiumAbility(player, query) {
  const def = getPlayerAbility(player)
  if (!def) return null
  const q = fold(query)
  if (!q) return null
  const keys = [def.id, def.name, def.activeName, ...(def.activeAliases ?? [])].filter(Boolean).map(fold)
  // Exact on any key, plus a fuzzy match only for keys long enough to be
  // unambiguous: a 2-letter alias like 'fu' has to be typed exactly, or
  // ".useability fury" would fire Freeze-Up at nothing.
  const hit = keys.some(k => k === q || (k.length >= 4 && (k.includes(q) || q.includes(k))))
  return hit ? def : null
}

/** How the listing points at a one-of-one's real command. */
export function premiumLineFor(def, p) {
  return def.activeCommand
    ? `use *${p}${def.activeCommand}* in battle, once a fight`
    : `passive, always on while your Premium is active`
}

function buildBossEffect(player, spec) {
  if (!spec) return null
  const amount = spec.pctPerTurn
    ? Math.max(1, Math.round(player.maxHp * spec.pctPerTurn))
    : (spec.amount ?? 1)
  return { type: spec.type, duration: spec.turns ?? 2, amount, sourceId: spec.source ?? 'boss' }
}

export default {
  name: 'useability', aliases: ['ua', 'useab'],
  category: 'combat', requiresPlayer: true,
  description: `${config.prefix}useability <slot # or name> — use an equipped active ability in battle`,

  async run(ctx) {
    const p = config.prefix
    const { args } = ctx

    if (!args.length) {
      const equipped = (ctx.player.equippedAbilities ?? [])
        .map(id => getAbilityDef(id)).filter(Boolean)
      const list = equipped.map((a, i) => `  ${i + 1}. *${a.name}* _(${a.rarity}, ${a.type})_`).join('\n')
      // The one-of-one Premium ability is NOT in equippedAbilities — it lives on
      // player.premiumAbility with its own engine — so without this line a
      // monthly buyer who was gifted Freeze Touch read "None equipped" and
      // concluded the grant never happened.
      const premium = getPlayerAbility(ctx.player)
      const premiumLine = premium
        ? `\n  👑 *${premium.name}* _(one-of-one premium)_\n     ${premiumLineFor(premium, p)}`
        : ''
      // "None equipped" reads as "the grant never landed" to a buyer holding a
      // one-of-one, so the empty-slot wording names the slots specifically.
      const slotLines = list || (premium ? `_No slot abilities equipped._` : `_None equipped._`)
      return ctx.reply(
        `✨ *Your Equipped Abilities:*\n${slotLines}${premiumLine}\n\n` +
        `Usage: *${p}useability <slot # or name>*\n` +
        `_Everything you hold, slots included: *${p}ability*._`,
      )
    }

    // A one-of-one Premium ability named on this command is routed to its own
    // active (the same body .freezeup/.heatwave/.nighteyes/.daylight run) rather
    // than being reported as "not found or not equipped". It is checked BEFORE
    // the duel refusal below because, unlike slot abilities, these DO work in a
    // duel — that is the whole point of the format-agnostic runner.
    const heldPremium = findHeldPremiumAbility(ctx.player, args.join(' '))
    if (heldPremium?.active) return runPremiumActive(ctx, heldPremium.id)

    // Equipped abilities resolve on the PvE turn engine: everything below reads
    // bs.enemy and works a monster fight. A duel's battleState is type 'pvp'
    // with no enemy on it, so this plugin never hands off to the PvP turn engine
    // the way the character actives (Gojo, Kamehameha, etc.) do. Refuse cleanly
    // here instead of computing a turn against an undefined opponent, matching
    // .unwritten and .liveblast. Listing (the no-args branch above) still works
    // in a duel since it never touches the battle state.
    if (ctx.player?.battleState?.type === 'pvp') {
      return ctx.reply(
        `✨ *Equipped abilities don't work in a duel.*\n\n` +
        `_Save them for dungeon runs, boss fights and swarms. In a duel, fight with ${p}attack, ${p}defend and your character's own power._`,
      )
    }

    await updatePlayer(ctx.db, ctx.from, async player => {
      if (!player.inBattle || !player.battleState) {
        await ctx.reply(`❌ Not in battle. Use *${p}dungeon* to find an enemy.`)
        return player
      }

      const bs    = player.battleState
      const e     = bs.enemy
      const boss  = isBossFight(player)
      const catTurn = await checkCatFormOngoingTurn(player, ctx, { boss })
      if (catTurn.intercepted) return catTurn.returnValue
      const query = args.join(' ')
      const ability = findEquippedAbility(player, query)

      if (!ability) {
        await ctx.reply(
          `❌ Ability *"${query}"* not found or not equipped.\n` +
          `Type *${p}useability* to see yours, or *${p}ability* for everything you hold.`,
        )
        return player
      }
      if (ability.type !== 'active') {
        await ctx.reply(`⚠️ *${ability.name}* is passive — it's already applying automatically this battle.`)
        return player
      }

      bs.abilityCooldowns = bs.abilityCooldowns ?? {}
      const readyAtTurn = bs.abilityCooldowns[ability.id] ?? 0
      if ((bs.turn ?? 1) < readyAtTurn) {
        await ctx.reply(`⏳ *${ability.name}* is on cooldown for *${readyAtTurn - (bs.turn ?? 1)}* more turn(s).`)
        return player
      }

      bs.playerDefending = false
      let msg = ''

      // ── Urahara's permanent Tear (PvP-only debuff) — action-triggered tick.
      const permaSeverLine = tickPermanentSever(player)
      if (permaSeverLine) msg += permaSeverLine + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }

      // ── Boss: increment turn counter + TURN_START event ───────────────────
      if (boss) {
        incrementBossTurn(player)
        const tsResult = applyBossSpecial(player, EVENT.TURN_START, {})
        if (tsResult.narrativeLine) msg += `_${tsResult.narrativeLine}_\n`

        if (Array.isArray(tsResult.guaranteedHits) && tsResult.guaranteedHits.length) {
          msg += `🕐 Time itself seems to stop!\n`
          let totalTSD = 0
          for (const hitDmg of tsResult.guaranteedHits) {
            const applied = applyIncomingDamage(player, hitDmg)
            totalTSD += applied.damage
            if (applied.message) msg += applied.message + '\n'
            if (applied.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss: true })
            }
          }
          msg += `🩸 *${totalTSD}* total damage! _(ignores DEF)_\n`
          if (player.hp <= 0) {
            const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
            if (!res.fallThrough) return res.returnValue
            msg = res.msg
          }
        }
        if (tsResult.playerTrueDamage) {
          const applied = applyIncomingDamage(player, tsResult.playerTrueDamage)
          if (applied.message) msg += applied.message + '\n'
          if (applied.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx, { boss: true })
          }
          msg += `🌊 A shockwave hits for *${tsResult.playerTrueDamage}* true damage!\n`
          if (player.hp <= 0) {
            const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
            if (!res.fallThrough) return res.returnValue
            msg = res.msg
          }
        }
      }

      // ── Player's own status effects tick first ────────────────────────────
      const playerStatus = processStatusTurn(player)
      if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }

      // ── Mei's Final Form — automatic trigger at <=70% HP.
      const finalForm = activateFinalForm(player)
      if (finalForm.ok) {
        msg += finalForm.message + '\n'
        void sendFinalFormVideo(ctx, finalForm.message).catch(() => {})
      }

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else if (Math.random() > calcPlayerHitChance(player, e)) {
        // ── MISS ──────────────────────────────────────────────────────────
        msg += `💨 *${player.name}* uses *${ability.name}* on *${e.name}*... and *MISSES!*\n`
        if (boss) {
          const missResult = applyBossSpecial(player, EVENT.PLAYER_MISS, { isMiss: true })
          msg += `💬 _"${getBossDodgeLine(player)}"_\n`
          if (missResult.narrativeLine) msg += `_${missResult.narrativeLine}_\n`
          if (missResult.applyEffect) {
            const fx = buildBossEffect(player, missResult.applyEffect)
            if (fx) addStatusEffect(player, fx)
          }
        }
        // A missed ability still goes on cooldown — you spent the turn.
        bs.abilityCooldowns[ability.id] = (bs.turn ?? 1) + ability.cooldownTurns
      } else {
        // ── HIT ───────────────────────────────────────────────────────────
        bs.abilityCooldowns[ability.id] = (bs.turn ?? 1) + ability.cooldownTurns
        msg += `✨ *${player.name}* uses *${ability.name}* on *${e.name}*!\n`

        const { lines, defeated } = resolveActiveAbility(ability, player, e, true)
        if (lines.length) msg += lines.join('\n') + '\n'

        // Urahara — Tear/Reshape: applies on any player hit landing,
        // including ability hits, same as attack.js.
        if (!defeated && e.hp > 0) {
          const tearLine = applyTearOnHit(player, e, ctx)
          if (tearLine) msg += tearLine + '\n'
        }

        if (boss) {
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: 0, element: 'physical', isCrit: false, isHit: true,
          })
          if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`
          const hitResult = applyBossSpecial(player, EVENT.PLAYER_SKILL_ATTACK, { skillId: ability.id, isHit: true })
          if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
          msg += `💬 _"${getBossHitLine(player)}"_\n`
        }

        if (defeated || e.hp <= 0) {
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

      // ── Enemy status effects tick before counter-attack ───────────────────
      const enemyStatus = processStatusTurn(e)
      if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
      if (e.hp <= 0) { if (boss) cleanupBossFight(player); return handleVictory(player, e, ctx) }

      if (enemyStatus.incapacitated) {
        msg += `💫 *${e.name}* is unable to attack this turn!\n`
      } else if (boss) {
        const bossAtk    = buildEnemyAttack(player)
        const dealResult = applyBossSpecial(player, EVENT.ENEMY_DEAL_DAMAGE, { damage: bossAtk.damage, isHit: true })
        const rawBossAtk = (dealResult.modified && dealResult.damage !== undefined) ? dealResult.damage : bossAtk.damage

        const hitList = Array.isArray(dealResult.guaranteedHits) ? dealResult.guaranteedHits : null
        let totalPlayerDmg = 0

        if (hitList) {
          for (const hDmg of hitList) {
            const applied = applyIncomingDamage(player, hDmg)
            totalPlayerDmg += applied.damage
            if (applied.message) msg += applied.message + '\n'
            if (applied.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss: true })
            }
          }
          msg += `${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
          msg += `🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_\n`
        } else {
          const defendSingle = (dmg) => bossAtk.bypassDefense ? dmg : calcMonsterDamage(dmg, getEffectiveStat(player, 'def'), false)
          const primaryHit = defendSingle(rawBossAtk)
          const appliedPrimary = applyIncomingDamage(player, primaryHit)
          totalPlayerDmg += appliedPrimary.damage
          if (appliedPrimary.message) msg += appliedPrimary.message + '\n'
          if (appliedPrimary.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx, { boss: true })
          }
          if (bossAtk.doubleStrike) {
            const hit2 = defendSingle(rawBossAtk)
            const appliedHit2 = applyIncomingDamage(player, hit2)
            totalPlayerDmg += appliedHit2.damage
            if (appliedHit2.message) msg += appliedHit2.message + '\n'
            if (appliedHit2.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss: true })
            }
            msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*\n`
            msg += `🩸 *${totalPlayerDmg}* total damage!\n`
          } else {
            msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
            msg += `🩸 *${primaryHit}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
          }
        }
        if (bossAtk.narrativeLines?.length)
          msg += bossAtk.narrativeLines.map(l => `_${l}_`).join('\n') + '\n'
        if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`
        msg += `\n💬 _"${getBossTaunt(player)}"_\n`
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

      if (!boss) {
        msg += `\n\n👤 *${player.name}*\n❤️ ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp}/${player.maxMp} MP\n` +
               `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}\n\n` +
               `*${p}attack* · *${p}skill <name>* · *${p}useability <name>* · *${p}defend* · *${p}flee*`
      }

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs
      await sendWillowAdvisory(ctx, player, e, boss)
      if (boss) await sendCinematicBossTurn(ctx, { player, e, body: msg })
      else await ctx.reply(msg)
      return player
    })
  },
}
