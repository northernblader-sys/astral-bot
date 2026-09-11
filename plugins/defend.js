import { config } from '../config.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { updatePlayer } from '../lib/player-repo.js'
import { resolveSwarmDefend } from '../lib/swarm-combat.js'
import { calcMonsterDamage, hpBar } from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
  resolveCatFormDefeat,
  applyBossStatDrain,
} from '../lib/combat-handlers.js'
import { getEffectiveStat, absorbDamage } from '../lib/effects.js'
import {
  applyBossSpecial,
  checkBossPhase,
  buildEnemyAttack,
  getBossTaunt,
  incrementBossTurn,
  cleanupBossFight,
  EVENT,
} from '../lib/boss-engine.js'
import { applyAllNamedPassives, NP_EVENT } from '../lib/named-passives.js'
import { beastIntervention, BEAST_EVENT } from '../lib/beast-engine.js'
import { wearArmorOnHit, breakMessage } from '../lib/durability.js'
import {
  activateFinalForm,
  sendFinalFormVideo,
  sendWillowAdvisory,
  tickFrostbindAura,
  applyAbsoluteOneSiphon,
  rollSerpentsGrace,
  applyIncomingDamage,
  applyAlyaStatBreak,
} from '../lib/character-abilities.js'

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

// Boss "lifespan drain" stat cuts live in lib/combat-handlers.js as
// applyBossStatDrain() — see that function's header for why they stopped
// being permanent subtractions from player.stats.

export default {
  name: 'defend',
  aliases: ['def', 'd', 'block'],
  category: 'combat',
  requiresPlayer: true,
  description: 'Take a defensive stance — reduce damage, recover 5% MP',

  async run(ctx) {
    const p = config.prefix
    await updatePlayer(ctx.db, ctx.from, async (player) => {
      // Entry Tower swarm floors run the multi-monster engine (swarm-combat.js);
      // the 1v1 pipeline below is byte-identical for every other fight.
      if (player.battleState?.mode === 'swarm') return resolveSwarmDefend(player, ctx)
      if (player.battleState?.type === 'pvp') {
        await ctx.reply(`⚔️ *You're in a duel* — use *${p}pvp defend* instead.`)
        return player
      }
      if (!player.inBattle || !player.battleState) {
        await ctx.reply(`❌ *Not in battle.*`)
        return player
      }
      const bs = player.battleState
      const e = bs.enemy
      const boss = isBossFight(player)
      const hpBeforeTurn  = player.hp
      const eHpBeforeTurn = e.hp

      let msg = ''
      const catTurn = await checkCatFormOngoingTurn(player, ctx, { boss })
      if (catTurn.intercepted) return catTurn.returnValue

      // ── Named-weapon/item passives: fight-start effects (once) ───────────
      const npState = bs.namedPassive ?? (bs.namedPassive = {})
      if (!npState.fightInitDone) {
        npState.fightInitDone = true
        const initResult = applyAllNamedPassives(player, NP_EVENT.FIGHT_INIT, {
          enemy: e,
          bs,
        })
        if (initResult.modified) msg += initResult.lines.join('\n') + '\n'
      }

      // ── Named-weapon/item passives: turn-start effects (e.g. Gate of Babylon) ─
      const tsNamedResult = applyAllNamedPassives(player, NP_EVENT.TURN_START, {
        enemy: e,
        bs,
      })
      if (tsNamedResult.modified) msg += tsNamedResult.lines.join('\n') + '\n'
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }

      // ── Boss: increment turn counter + TURN_START event ───────────────────
      if (boss) {
        incrementBossTurn(player)
        const tsResult = applyBossSpecial(player, EVENT.TURN_START, {})

        if (tsResult.narrativeLine) msg += `_${tsResult.narrativeLine}_\n`

        // Jotaro Time Stop — guaranteedHits is an array of per-hit damage values
        if (
          Array.isArray(tsResult.guaranteedHits) &&
          tsResult.guaranteedHits.length
        ) {
          msg += `🕐 *ZA WARUDO!* Time has stopped!\n`
          let totalTSD = 0
          for (const hitDmg of tsResult.guaranteedHits) {
            const applied = applyIncomingDamage(player, hitDmg)
            totalTSD += applied.damage
            if (applied.message) msg += applied.message + '\n'
            if (applied.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss })
            }
          }
          msg += `👊 *Star Platinum* delivers *${tsResult.guaranteedHits.length}* rapid strikes!\n`
          msg += `🩸 *${totalTSD}* total damage! _(ignores DEF)_\n`
          if (player.hp <= 0) {
            const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
            if (!res.fallThrough) return res.returnValue
            msg = res.msg
          }
        }

        // Whitebeard quake residue — true damage at turn start
        if (tsResult.playerTrueDamage) {
          const applied = applyIncomingDamage(player, tsResult.playerTrueDamage)
          if (applied.message) msg += applied.message + '\n'
          if (applied.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx, { boss })
          }
          msg += `🌊 *Quake shockwave* hits for *${tsResult.playerTrueDamage}* true damage!\n`
          if (player.hp <= 0) {
            const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
            if (!res.fallThrough) return res.returnValue
            msg = res.msg
          }
        }
      }

      // ── Player's own status effects (DOT, CC) tick first ─────────────────
      const playerStatus = processStatusTurn(player)
      if (playerStatus.lines.length) msg += playerStatus.lines.join('\n') + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }

      const finalForm = activateFinalForm(player)
      if (finalForm.ok) {
        msg += finalForm.message + '\n'
        void sendFinalFormVideo(ctx, finalForm.message).catch(() => {})
      }

      // ── Miyashi's Frostbind aura — same turn-start slot as attack.js/skill.js.
      const frostbind = tickFrostbindAura(player, e, bs)
      if (frostbind) {
        msg += frostbind.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Nisha's Absolute One — same turn-start slot as attack.js/skill.js.
      const absoluteOne = applyAbsoluteOneSiphon(player, e)
      if (absoluteOne) {
        msg += absoluteOne.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Alya's Stat Break — same turn-start slot as attack.js/skill.js.
      const alyaBreak = applyAlyaStatBreak(player, e, bs)
      if (alyaBreak.triggered) {
        msg += alyaBreak.message + '\n'
      }

      // ── Summon Beast: turn-start bonus attack chance (fires even while
      // defending — the beast acts independently of the player's stance) ──
      const beastTsResult = beastIntervention(player, BEAST_EVENT.TURN_START, { enemy: e, bs })
      if (beastTsResult.modified) {
        e.hp = Math.max(0, e.hp - beastTsResult.bonusDamage)
        msg += beastTsResult.lines.join('\n') + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      let defending = false
      let counterNullified = false
      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else {
        const mpRegen = Math.floor(player.maxMp * 0.05)
        player.mp = Math.min(player.maxMp, player.mp + mpRegen)
        bs.playerDefending = true
        defending = true
        msg += `🛡️ *${player.name}* defends! _(+${mpRegen} MP)_\n`

        // Named-weapon/item passives: Defend-only effects (Six Eyes Blindfold
        // fully nullifies the counter-attack resolved further below).
        const defendNamedResult = applyAllNamedPassives(
          player,
          NP_EVENT.PLAYER_DEFEND,
          { enemy: e, bs },
        )
        if (defendNamedResult.modified)
          msg += defendNamedResult.lines.join('\n') + '\n'
        counterNullified =
          defendNamedResult.modified && defendNamedResult.damage === 0

        if (boss) {
          // PLAYER_DEFEND — Aizen breaks hypnosis on defend, Sasuke Amaterasu clears, etc.
          const defendResult = applyBossSpecial(player, EVENT.PLAYER_DEFEND, {})
          if (defendResult.narrativeLine)
            msg += `_${defendResult.narrativeLine}_\n`

          // Remove a boss-applied effect if the mechanic calls for it (e.g. Sasuke Amaterasu)
          if (defendResult.removeEffect) {
            player.activeEffects = (player.activeEffects ?? []).filter(
              (fx) => fx.sourceId !== defendResult.removeEffect,
            )
          }
        }
      }

      // ── Enemy's own status effects tick before counter-attack ─────────────
      const enemyStatus = processStatusTurn(e)
      if (enemyStatus.lines.length) msg += enemyStatus.lines.join('\n') + '\n'
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }

      if (enemyStatus.incapacitated) {
        msg += `💫 *${e.name}* is unable to attack this turn!\n`
      } else if (boss) {
        // ── BOSS counter-attack ───────────────────────────────────────────────
        const bossAtk = buildEnemyAttack(player)
        const dealResult = applyBossSpecial(player, EVENT.ENEMY_DEAL_DAMAGE, {
          damage: bossAtk.damage,
          isHit: true,
        })
        const rawBossAtk =
          dealResult.modified && dealResult.damage !== undefined
            ? dealResult.damage
            : bossAtk.damage

        const hitList = Array.isArray(dealResult.guaranteedHits)
          ? dealResult.guaranteedHits
          : null
        let totalPlayerDmg = 0

        if (hitList) {
          for (const hDmg of hitList) {
            const applied = applyIncomingDamage(player, hDmg)
            totalPlayerDmg += applied.damage
            if (applied.message) msg += applied.message + '\n'
          if (applied.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx, { boss })
          }
          }
          msg += `${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
          msg += `🩸 *${totalPlayerDmg}* total damage! _(ignores DEF)_\n`
        } else {
          const defendSingle = (dmg) =>
            bossAtk.bypassDefense
              ? dmg
              : calcMonsterDamage(
                  dmg,
                  getEffectiveStat(player, 'def'),
                  defending,
                )

          let primaryHit = defendSingle(rawBossAtk)

          if (counterNullified) {
            primaryHit = 0
          } else {
            const dmgNamedResult = applyAllNamedPassives(
              player,
              NP_EVENT.ENEMY_DEAL_DAMAGE,
              {
                enemy: e,
                bs,
                damage: primaryHit,
                trueDamage: bossAtk.bypassDefense,
              },
            )
            if (dmgNamedResult.modified) {
              if (dmgNamedResult.damage !== undefined)
                primaryHit = dmgNamedResult.damage
              msg += dmgNamedResult.lines.join('\n') + '\n'
            }

            // Nisha's Serpent's Grace — flat dodge chance, same shape/exemption
            // as attack.js/skill.js (skipped for true damage).
            const dodgeRoll = rollSerpentsGrace(player, { damage: primaryHit, trueDamage: bossAtk.bypassDefense })
            if (dodgeRoll.dodged) {
              primaryHit = 0
              msg += dodgeRoll.message + '\n'
            }

            const beastDmgResult = beastIntervention(player, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
              enemy: e,
              bs,
              damage: primaryHit,
            })
            if (beastDmgResult.modified) {
              if (beastDmgResult.damage !== undefined) primaryHit = beastDmgResult.damage
              msg += beastDmgResult.lines.join('\n') + '\n'
            }
          }

          const absorbedPrimary = absorbDamage(player, primaryHit)
          const shieldBlockedPrimary = primaryHit - absorbedPrimary
          const appliedPrimary = applyIncomingDamage(player, absorbedPrimary)
          totalPlayerDmg += appliedPrimary.damage
          if (appliedPrimary.message) msg += appliedPrimary.message + '\n'
          if (appliedPrimary.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx, { boss })
          }

          if (bossAtk.doubleStrike) {
            const hit2 = defendSingle(rawBossAtk)
            const absorbedHit2 = absorbDamage(player, hit2)
            const shieldBlockedHit2 = hit2 - absorbedHit2
            const appliedHit2 = applyIncomingDamage(player, absorbedHit2)
            totalPlayerDmg += appliedHit2.damage
            if (appliedHit2.message) msg += appliedHit2.message + '\n'
            if (appliedHit2.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss })
            }
            msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*! ⚡ *DOUBLE STRIKE!*\n`
            msg += `🩸 *${totalPlayerDmg}* total damage!\n`
            if (shieldBlockedPrimary + shieldBlockedHit2 > 0)
              msg += `🛡️ Shield absorbed *${shieldBlockedPrimary + shieldBlockedHit2}* damage!\n`
          } else {
            msg += `\n${e.emoji ?? '👾'} *${e.name}* attacks${defending ? ' through your guard' : ''}!\n`
            msg += `🩸 *${absorbedPrimary}* damage!${defending ? ' _(DEF boosted)_' : ''}${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
            if (shieldBlockedPrimary > 0) msg += `🛡️ Shield absorbed *${shieldBlockedPrimary}* damage!\n`
          }
        }

        if (bossAtk.narrativeLines?.length)
          msg += `_${bossAtk.narrativeLines[0]}_\n`
        if (dealResult.narrativeLine) msg += `_${dealResult.narrativeLine}_\n`

        msg = applyBossStatDrain(player, dealResult, msg)

        if (dealResult.playerMpDrain) {
          const drained = Math.min(
            player.mp ?? 0,
            Math.floor(dealResult.playerMpDrain),
          )
          player.mp = Math.max(0, (player.mp ?? 0) - drained)
          if (drained > 0) msg += `💧 *${drained}* MP drained!\n`
        }

        msg += `\n💬 _"${getBossTaunt(player)}"_\n`

        if (player.hp <= 0) {
          const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
          if (!res.fallThrough) return res.returnValue
          msg = res.msg
        }
      } else {
        // ── Regular enemy attack ──────────────────────────────────────────────
        let enemyDmg = calcMonsterDamage(
          getEffectiveStat(e, 'atk'),
          getEffectiveStat(player, 'def'),
          defending,
        )
        let dmgNamedLines = ''

        if (counterNullified) {
          enemyDmg = 0
        } else {
          const dmgNamedResult = applyAllNamedPassives(
            player,
            NP_EVENT.ENEMY_DEAL_DAMAGE,
            {
              enemy: e,
              bs,
              damage: enemyDmg,
            },
          )
          if (dmgNamedResult.modified) {
            if (dmgNamedResult.damage !== undefined)
              enemyDmg = dmgNamedResult.damage
            dmgNamedLines = '\n' + dmgNamedResult.lines.join('\n')
          }

          // Nisha's Serpent's Grace — flat dodge chance against regular
          // (non-boss) enemy hits too, matching attack.js/skill.js.
          const dodgeRoll = rollSerpentsGrace(player, { damage: enemyDmg, trueDamage: false })
          if (dodgeRoll.dodged) {
            enemyDmg = 0
            dmgNamedLines += '\n' + dodgeRoll.message
          }

          const beastDmgResult = beastIntervention(player, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
            enemy: e,
            bs,
            damage: enemyDmg,
          })
          if (beastDmgResult.modified) {
            if (beastDmgResult.damage !== undefined) enemyDmg = beastDmgResult.damage
            dmgNamedLines += '\n' + beastDmgResult.lines.join('\n')
          }
        }

        const absorbedEnemyDmg = absorbDamage(player, enemyDmg)
        const shieldBlockedEnemy = enemyDmg - absorbedEnemyDmg
        const appliedEnemy = applyIncomingDamage(player, absorbedEnemyDmg)
        if (appliedEnemy.message) msg += appliedEnemy.message + '\n'
        if (appliedEnemy.catFormDefeated) {
          return resolveCatFormDefeat(player, ctx, { boss })
        }
        msg += `\n${e.emoji ?? '👾'} *${e.name}* attacks${defending ? ' through your guard' : ''}!\n🩸 *${appliedEnemy.damage}* damage${defending ? ' _(DEF boosted)_' : ''}${dmgNamedLines}`
        if (shieldBlockedEnemy > 0) msg += `\n🛡️ Shield absorbed *${shieldBlockedEnemy}* damage!`
        if (player.hp <= 0) {
          const res = await resolvePlayerHpZero(player, ctx, msg, {})
          if (!res.fallThrough) return res.returnValue
          msg = res.msg
        }
      }

      // Phase check — defend can't normally deal damage, but quake/reflect could kill enemy
      if (boss && e.hp <= 0) {
        cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }

      // ── TURN_END event ────────────────────────────────────────────────────
      if (boss) {
        const teResult = applyBossSpecial(player, EVENT.TURN_END, {})
        if (teResult.narrativeLine) msg += `\n_${teResult.narrativeLine}_`
      }

      // Named-weapon/item passives: end-of-turn effects.
      const teNamedResult = applyAllNamedPassives(player, NP_EVENT.TURN_END, {
        enemy: e,
        bs,
      })
      if (teNamedResult.modified) msg += '\n' + teNamedResult.lines.join('\n')
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }

      msg +=
        `\n\n❤️ ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp}/${player.maxMp} MP\n\n` +
        `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs

      // Durability — armor wears if the player took damage this turn
      // (defending doesn't wear the weapon since it isn't being used).
      if (player.hp < hpBeforeTurn) {
        const aWear = wearArmorOnHit(player)
        msg += breakMessage(aWear)
      }

      await sendWillowAdvisory(ctx, player, e, boss)
      await sendBattleTurnReply(ctx, { bs, player, e, msg, hpBeforeTurn, eHpBeforeTurn, boss })
      return player
    })
  },
}
