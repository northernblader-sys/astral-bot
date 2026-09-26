import { config } from '../config.js'
import { tickShunShunRikka } from '../lib/orihime.js'
import { companionTurnStrike } from '../lib/guardian-event.js'
import { updatePlayer } from '../lib/player-repo.js'
import { swarmAttackNudge } from '../lib/swarm-combat.js'
import {
  playerHitLine,
  playerMissLine,
  playerAbsorbedLine,
  enemyHitLine,
  enemyMissLine,
} from '../lib/battle-flavor.js'
import {
  calcPlayerDamage,
  applyDefense,
  calcMonsterDamage,
  calcPlayerHitChance,
  calcMonsterHitChance,
  rollEchoStrike,
  hpBar,
} from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
  resolveCatFormDefeat,
  applyBossStatDrain,
} from '../lib/combat-handlers.js'
import { getEffectiveStat, addStatusEffect, absorbDamage } from '../lib/effects.js'
import { getModValue, applyHighDefenseCatchup } from '../lib/mods.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { sendCinematicBossTurn } from '../lib/boss-cinematic.js'
import {
  applyBossSpecial,
  checkBossPhase,
  buildEnemyAttack,
  getBossTaunt,
  getBossHitLine,
  getBossDodgeLine,
  incrementBossTurn,
  cleanupBossFight,
  EVENT,
} from '../lib/boss-engine.js'
import { applyAllNamedPassives, NP_EVENT } from '../lib/named-passives.js'
import { beastIntervention, BEAST_EVENT } from '../lib/beast-engine.js'
import {
  wearWeaponOnTurn,
  wearArmorOnHit,
  breakMessage,
} from '../lib/durability.js'
import {
  activateFinalForm,
  applyTearOnHit,
  sendFinalFormVideo,
  sendWillowAdvisory,
  tickPermanentSever,
  tickFrostbindAura,
  applyAbsoluteOneSiphon,
  rollSerpentsGrace,
  isCatFormActive,
  resolveCatFormDamage,
  buildCatFormDefeatMessage,
  catFormAttackDamage,
  applyIncomingDamage,
  applyAlyaStatBreak,
  applyFrostlockGate,
  megumiTurnStart,
  resolveMegumiIncoming,
  sendWheelSpin,
  danceOfTheRainMultiplier,
  buildDanceOfTheRainMessage,
  hasSecondTranscendance,
  hasWitchOfEnvy,
  advanceWondersOfEnvy,
  bypassesWondersOfEnvy,
} from '../lib/character-abilities.js'
import { isStreaming, rampStreamViewers } from './stream.js'
import { applyStruckReactions, applyPackLifestealOnDeal } from '../lib/premium-abilities.js'
import { sendImage } from '../lib/image.js'

/** True when the current fight is against an anime boss with active bossState. */
function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

/**
 * Convert a result.applyEffect spec (from applyBossSpecial) into a proper
 * status-effect object that addStatusEffect() accepts.
 */
function _buildBossEffect(player, spec) {
  if (!spec) return null
  const amount = spec.pctPerTurn
    ? Math.max(1, Math.round(player.maxHp * spec.pctPerTurn))
    : (spec.amount ?? 1)
  return {
    type: spec.type,
    duration: spec.turns ?? 2,
    amount,
    sourceId: spec.source ?? 'boss',
  }
}

// Boss "lifespan drain" stat cuts live in lib/combat-handlers.js as
// applyBossStatDrain() — one shared implementation instead of three near-
// identical copies, and a temporary weaken effect instead of a permanent
// subtraction from player.stats that nothing could ever give back.

// resolvePlayerHpZero (totem -> pearl -> Yoriichi cat form -> real death)
// now lives in lib/combat-handlers.js so every combat plugin shares the
// exact same checkpoint chain instead of re-implementing it inline. See
// that file's doc comment for the usage pattern used at every
// "if (player.hp <= 0)" site below.

export default {
  name: 'attack',
  aliases: ['atk', 'a'],
  category: 'combat',
  requiresPlayer: true,
  description: 'Basic attack in battle',

  async run(ctx) {
    const p = config.prefix
    await updatePlayer(ctx.db, ctx.from, async (player) => {
      // Swarm floors run the multi-monster engine (swarm-combat.js), where the
      // basic attack is DIRECTIONAL: a plain .a no longer swings, it points the
      // player at .al / .ar and reprints the field (no turn spent). The 1v1
      // pipeline below is byte-identical for every floor-100 master fight.
      if (player.battleState?.mode === 'swarm') return swarmAttackNudge(player, ctx)
      if (player.battleState?.type === 'pvp') {
        await ctx.reply(`⚔️ *You're in a duel* — use *${p}pvp attack* instead.`)
        return player
      }
      if (!player.inBattle || !player.battleState) {
        await ctx.reply(`❌ *Not in battle.* _Use_ *${p}dungeon* _to find an enemy._`)
        return player
      }

      const bs = player.battleState
      const e = bs.enemy
      const boss = isBossFight(player)
      const hpBeforeTurn = player.hp
      const eHpBeforeTurn = e.hp

      let msg = ''

      // ── Urahara's permanent Tear (PvP-only debuff) — action-triggered tick.
      // Fires on the player's next action regardless of context, matching
      // the existing wearWeaponOnTurn/wearArmorOnHit "no real-time timer"
      // pattern. See lib/character-abilities.js's file doc comment.
      const permaSeverLine = tickPermanentSever(player)
      if (permaSeverLine) msg += permaSeverLine + '\n'
      if (player.hp <= 0) {
        const res = await resolvePlayerHpZero(player, ctx, msg, {})
        if (!res.fallThrough) return res.returnValue
        msg = res.msg
      }
      const catTurn = await checkCatFormOngoingTurn(player, ctx, { boss })
      if (catTurn.intercepted) return catTurn.returnValue
      bs.playerDefending = false

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
            const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
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
            const res = await resolvePlayerHpZero(player, ctx, msg, { boss })
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

      // ── Mei's Final Form — automatic trigger at <=70% HP.
      const finalForm = activateFinalForm(player)
      if (finalForm.ok) {
        msg += finalForm.message + '\n'
        void sendFinalFormVideo(ctx, finalForm.message).catch(() => {})
      }

      // ── Orihime — Shun Shun Rikka: turn-start heal, once-per-battle rejection
      // of a poison/burn/bleed. Same equipped-character passive slot as Final Form.
      const rikka = tickShunShunRikka(player, bs)
      if (rikka) msg += rikka.message + '\n'

      // ── Guardian of the Innocent — a Battle companion (Minna / Rune & Lica)
      // strikes beside the player at the start of every PvE turn.
      const compStrike = companionTurnStrike(player, e, bs)
      if (compStrike) {
        msg += compStrike.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Miyashi's Frostbind aura — ambient drain + skill-lock roll on the
      // enemy, ticks every turn cycle regardless of whether the player's own
      // action lands. Mirrors Mei's Final Form slot (equipped-character
      // passive, resolved once per turn, before the player's attack).
      const frostbind = tickFrostbindAura(player, e, bs)
      if (frostbind) {
        msg += frostbind.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Nisha's Absolute One — siphons HP from the enemy to the player
      // on Nisha's own turn cycle. Same slot as Frostbind above.
      const absoluteOne = applyAbsoluteOneSiphon(player, e)
      if (absoluteOne) {
        msg += absoluteOne.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Alya's Stat Break — fires every 3rd turn, zeroes a random enemy
      // stat for 6 turns. Same turn-start slot as Frostbind/Absolute One
      // above (equipped-character passive, resolved once per turn before
      // the player's own attack).
      const alyaBreak = applyAlyaStatBreak(player, e, bs)
      if (alyaBreak.triggered) {
        msg += alyaBreak.message + '\n'
      }

      // ── Megumi's Thousand Shadows Swarm — a thousand cursed spirits drain
      // the enemy's life force (healing Megumi a share of it) and deepen a
      // cumulative ATK cut every turn; doubled once the Chimera Shadow Garden
      // is open, plus the Garden's shikigami and Mahoraga's blade if they're
      // out. Same turn-start slot as Frostbind / Absolute One / Stat Break
      // above, so it ticks in monster fights, dungeons and boss fights alike.
      const swarm = megumiTurnStart(player, e, bs)
      if (swarm) {
        msg += swarm.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Tella's Wonders of You — the Witch of Envy escalates on a fixed
      // clock (see advanceWondersOfEnvy). Same turn-start slot as the passives
      // above, so she ticks in monster fights, dungeons and boss fights alike.
      // The two world-enders (The End, The Last Prayer) are immune; everything
      // else, bosses included, is fair game, which is the whole point of her.
      if (hasWitchOfEnvy(player)) {
        const envy = advanceWondersOfEnvy(bs, {
          context: boss ? 'boss' : 'dungeon',
          foeName: e?.name ?? 'the enemy',
          ownerName: player?.name ?? 'you',
          immune: bypassesWondersOfEnvy(e),
          oppDefendedLast: false, // a PvE foe has no defend action to read
        })
        if (envy) {
          if (envy.art) {
            void sendImage(ctx, envy.art, `🖤 ${player.name}'s Witch of Envy takes her final form.`).catch(() => {})
          }
          if (envy.halveFraction) e.hp = Math.max(1, Math.floor(e.hp * envy.halveFraction))
          if (envy.lines) msg += envy.lines + '\n'
          if (envy.forcedLoss) {
            if (envy.drainOwner) player.hp = 1
            e.hp = 0
            if (boss) cleanupBossFight(player)
            return handleVictory(player, e, ctx)
          }
        }
      }

      // ── Summon Beast: turn-start bonus attack chance ─────────────────────
      const beastTsResult = beastIntervention(player, BEAST_EVENT.TURN_START, { enemy: e, bs })
      if (beastTsResult.modified) {
        e.hp = Math.max(0, e.hp - beastTsResult.bonusDamage)
        msg += beastTsResult.lines.join('\n') + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn!\n`
      } else if (Math.random() > calcPlayerHitChance(player, e)) {
        // ── MISS ─────────────────────────────────────────────────────────────
        // Boss misses keep the plain line (their cinematic voice follows below);
        // a generic monster miss draws from the flavor pool instead.
        msg += boss
          ? `💨 *${player.name}* attacks *${e.name}*... and *MISSES!*\n`
          : playerMissLine(player.name, e, player.equippedCharacter) + '\n'
        if (boss) {
          const missResult = applyBossSpecial(player, EVENT.PLAYER_MISS, {
            isMiss: true,
          })
          msg += `💬 _"${getBossDodgeLine(player)}"_\n`
          if (missResult.narrativeLine) msg += `_${missResult.narrativeLine}_\n`
          if (missResult.applyEffect) {
            const fx = _buildBossEffect(player, missResult.applyEffect)
            if (fx) addStatusEffect(player, fx)
          }
        }
      } else {
        // ── HIT ──────────────────────────────────────────────────────────────
        // Cheat mods: Heavy Hand (damage_multiplier) / Lucky Edge
        // (crit_chance_boost) — PvE only, deliberately not applied in
        // pvp.js so cheat-mod power never affects player-vs-player fights.
        // Yoriichi's cat form (see lib/character-abilities.js) stacks
        // multiplicatively on top of the damage_multiplier cheat mod, same
        // way Premium/mods already stack rather than add — she is not a
        // mod, but the pipeline only exposes one multiplier slot here.
        const catFormMult = catFormAttackDamage(player)
        // Dance of the Rain — Tyla & Alya's automatic legendary twin strike,
        // fires exactly once the first turn battleState.turn reaches 10.
        // Same "just the multiplier" contract as catFormMult above; stacks
        // into the same slot since Tyla/Yoriichi are mutually exclusive
        // equips (one equippedCharacter id at a time).
        const danceMult = danceOfTheRainMultiplier(player, bs)
        const { rawDmg, isCrit } = calcPlayerDamage(
          player,
          null,
          (getModValue(player, 'damage_multiplier') ?? 1) * catFormMult * danceMult,
          getModValue(player, 'crit_chance_boost') ?? 0,
        )

        // Named-weapon/item passives: pre-defense damage overrides (e.g.
        // Tensa Zangetsu's x1.5, One For All's stack bonus, Venuzdonoa's
        // DEF-bypass).
        const preNamedResult = applyAllNamedPassives(
          player,
          NP_EVENT.PRE_DAMAGE,
          {
            enemy: e,
            bs,
            damage: rawDmg,
            rawDmg,
            isCrit,
          },
        )
        const effectiveRawDmg =
          preNamedResult.modified && preNamedResult.damage !== undefined
            ? preNamedResult.damage
            : rawDmg
        if (preNamedResult.lines.length)
          msg += preNamedResult.lines.join('\n') + '\n'

        let finalDmg = preNamedResult.bypassDefense
          ? effectiveRawDmg
          : applyDefense(effectiveRawDmg, getEffectiveStat(e, 'def'))
        finalDmg = applyHighDefenseCatchup(player, e, finalDmg)

        if (boss) {
          // PLAYER_BASIC_ATTACK — Eren's Path Foresight dodges first 2 basic attacks, etc.
          const basicResult = applyBossSpecial(
            player,
            EVENT.PLAYER_BASIC_ATTACK,
            {
              damage: finalDmg,
              element: 'physical',
              isCrit,
              isHit: true,
            },
          )
          if (basicResult.modified && basicResult.damage !== undefined)
            finalDmg = basicResult.damage
          if (basicResult.narrativeLine)
            msg += `_${basicResult.narrativeLine}_\n`

          // ENEMY_TAKE_DAMAGE — Gojo nullifies, Kaido halves, Mahoraga adapts, etc.
          const takeResult = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
            damage: finalDmg,
            element: 'physical',
            isCrit,
            isHit: true,
          })
          if (takeResult.modified && takeResult.damage !== undefined)
            finalDmg = takeResult.damage
          if (takeResult.narrativeLine) msg += `_${takeResult.narrativeLine}_\n`

          // Meliodas Full Counter — reflect damage back at player
          if (takeResult.reflectDamage) {
            const applied = applyIncomingDamage(player, takeResult.reflectDamage)
            if (applied.message) msg += applied.message + '\n'
            if (applied.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss })
            }
            msg += `🔁 *Full Counter!* Your attack is reflected!\n🩸 *${takeResult.reflectDamage}* damage back at you!\n`
            if (player.hp <= 0) {
              const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
              if (!res.fallThrough) return res.returnValue
              msg = res.msg
            }
          }
        }

        // Apply damage to enemy
        e.hp = Math.max(0, e.hp - finalDmg)

        // Boss hits keep the terse two-line stamp so the cinematic wrapper reads
        // clean; a generic monster hit gets a rotating flavor line instead.
        if (boss) {
          msg += `⚔️ *${player.name}* attacks *${e.name}*!${isCrit ? ' ⚡ *CRIT!*' : ''}\n`
          msg += finalDmg > 0
            ? `💥 *${finalDmg}* damage!\n`
            : `🛡️ _Attack absorbed, no damage dealt!_\n`
        } else {
          msg += (finalDmg > 0
            ? playerHitLine(player.name, e, finalDmg, isCrit, player.equippedCharacter)
            : playerAbsorbedLine(player.name, e, player.equippedCharacter)) + '\n'
        }
        msg += buildDanceOfTheRainMessage(bs, player)

        // Named-weapon/item passives: post-hit effects (lifesteal, bonus
        // strikes, elemental add-on damage, crit-triggered reflect, etc.)
        const hitNamedResult = applyAllNamedPassives(
          player,
          NP_EVENT.PLAYER_HIT,
          {
            enemy: e,
            bs,
            isHit: true,
            isCrit,
            rawDmg: effectiveRawDmg,
            finalDmg,
          },
        )
        if (hitNamedResult.lines.length)
          msg += hitNamedResult.lines.join('\n') + '\n'

        // Dark Monarch pack — Dread lifesteal: heal the wielder a share of the
        // damage they just dealt (the incoming-cut half lives in absorbDamage).
        if (finalDmg > 0) {
          const ls = applyPackLifestealOnDeal(player, finalDmg)
          if (ls.heal > 0) {
            player.hp = Math.min(player.maxHp, player.hp + ls.heal)
            msg += ls.lines.join('\n') + '\n'
          }
        }

        // Urahara — Tear/Reshape (spec §13.2): apply the in-battle 'sever'
        // bleed to the enemy on the player's own hit landing. Applied
        // after damage this hit dealt, before the e.hp<=0 victory check
        // below, so a lethal hit still short-circuits to victory without
        // wastefully applying a bleed to an enemy that's already dead.
        if (e.hp > 0) {
          const tearLine = applyTearOnHit(player, e, ctx)
          if (tearLine) msg += tearLine + '\n'
        }
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }

        if (boss) {
          // PLAYER_HIT_ENEMY — after damage lands (Shanks hit-streak, Aizen hypnosis, etc.)
          const hitResult = applyBossSpecial(player, EVENT.PLAYER_HIT_ENEMY, {
            damage: finalDmg,
            isCrit,
            element: 'physical',
            isHit: true,
          })
          if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
          if (finalDmg > 0) msg += `💬 _"${getBossHitLine(player)}"_\n`
        }

        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }

        if (boss) {
          // Phase transition — announce narrative when HP crosses 75 / 50 / 25 %
          const phase = checkBossPhase(player)
          if (phase?.triggered && phase.lines?.length) {
            msg += `\n⚡ *— PHASE SHIFT —*\n` + phase.lines.join('\n') + '\n'
          }
        }
      }

      // ⚡ Second Transcendance — the equipped Transcendent acts a SECOND time
      // every turn. One extra, independent strike, inserted after the primary
      // hit/miss resolves and BEFORE the enemy's status tick + counter-attack,
      // so it's part of the same turn. It never advances bs.turn and never adds
      // a second retaliation, keeping every turn-counter-keyed ability (Alya,
      // Dance of the Rain, boss phases, cooldowns, durability) in lockstep. It
      // fires even when the first swing missed — the passive is "always twice."
      if (e.hp > 0 && hasSecondTranscendance(player)) {
        const echo = rollEchoStrike(player, e) // basic attack — no skill scaling
        if (echo?.missed) {
          msg += `⚡ *SECOND TRANSCENDANCE* — the echo swings and *misses!*\n`
        } else if (echo) {
          let echoDmg = applyDefense(echo.rawDmg, getEffectiveStat(e, 'def'))
          if (boss) {
            // Route the echo through the same nullify/halve/adapt hook the
            // primary hit uses, so Gojo/Kaido/Mahoraga still govern the 2nd hit.
            const echoTake = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
              damage: echoDmg, element: 'physical', isCrit: echo.isCrit, isHit: true,
            })
            if (echoTake.modified && echoTake.damage !== undefined) echoDmg = echoTake.damage
            if (echoTake.narrativeLine) msg += `_${echoTake.narrativeLine}_\n`
          }
          e.hp = Math.max(0, e.hp - echoDmg)
          msg += `⚡ *SECOND TRANSCENDANCE* — *${player.name}* moves again!${echo.isCrit ? ' ⚡ *CRIT!*' : ''}\n`
          msg += echoDmg > 0 ? `🩸 *${echoDmg}* damage!\n` : `🛡️ _The echo is absorbed — no damage._\n`
        }
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // 📺 Streamer — a live crowd swells with every blow struck in the dungeon,
      // so .live-blast scales up the longer the streamer fights. No-op for
      // anyone not currently live (plugins/stream.js owns the viewer meter).
      if (isStreaming(player.id)) rampStreamViewers(player.id)

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

        // Miyashi's frostlock — a locked enemy still ACTS, but only with a
        // basic attack: no named special, no barrage, no DEF-bypass, no
        // double strike (see lib/character-abilities.js applyFrostlockGate).
        // Bosses are the only PvE enemies that own specials to lose, so this
        // is exactly where the lockdown is supposed to bite. Suppressing the
        // ENEMY_DEAL_DAMAGE event is what drops guaranteedHits/multi-hit.
        const frostGate = applyFrostlockGate(e, 'skill')
        if (frostGate.blocked) {
          bossAtk.attackName   = 'a frost-numbed Strike'
          bossAtk.narrativeLines = []
          bossAtk.bypassDefense  = false
          bossAtk.doubleStrike   = false
          msg += `❄️ *${e.name}* is *frostlocked* — the technique dies in their throat.\n`
        }

        const dealResult = frostGate.blocked
          ? { modified: false, damage: bossAtk.damage }
          : applyBossSpecial(player, EVENT.ENEMY_DEAL_DAMAGE, {
              damage: bossAtk.damage,
              isHit: true,
            })
        const rawBossAtk =
          dealResult.modified && dealResult.damage !== undefined
            ? dealResult.damage
            : bossAtk.damage

        // guaranteedHits on ENEMY_DEAL_DAMAGE = array of damage values (future-proof)
        const hitList = Array.isArray(dealResult.guaranteedHits)
          ? dealResult.guaranteedHits
          : null
        let totalPlayerDmg = 0

        if (hitList) {
          // Multi-hit true-damage bursts (Jotaro-style) are intentionally not
          // run through named passives (flash_step_dodge et al. explicitly
          // don't apply to true-damage/%-HP effects — see named-passives.js).
          //
          // Mahoraga is the exception: the Wheel adapts to ANY move, true
          // damage included, so the whole volley is resolved as one exposure
          // to bossAtk.attackName. Once mastered the entire barrage lands for
          // 0 (the Garden's dodge still doesn't apply — trueDamage).
          const mega = resolveMegumiIncoming(player, {
            damage: 0, trueDamage: true,
            kind: 'boss', id: bossAtk.attackName, label: bossAtk.attackName, bs,
          })
          if (mega.wheelCaption) void sendWheelSpin(ctx, mega.wheelCaption).catch(() => {})
          if (mega.message) msg += mega.message + '\n'

          if (mega.nullified) {
            msg += `${e.emoji ?? '👾'} *${e.name}* unleashes *${bossAtk.attackName}*! _(${hitList.length} hits)_\n`
            msg += `🩸 *0* total damage — the Divine General has already mastered it.\n`
          } else {
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
          }
        } else {
          const defendSingle = (dmg) =>
            bossAtk.bypassDefense
              ? dmg
              : calcMonsterDamage(dmg, getEffectiveStat(player, 'def'), false)

          let primaryHit = defendSingle(rawBossAtk)

          // Named-weapon/item passives: incoming-damage overrides (dodge,
          // block, resolve reduction) and counter-hooks (full counter armor,
          // Lostvayne's crit-reflect tracking).
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
          // as named-passives.js's flash_step_dodge (skipped for true damage).
          const dodgeRoll = rollSerpentsGrace(player, { damage: primaryHit, trueDamage: bossAtk.bypassDefense })
          if (dodgeRoll.dodged) {
            primaryHit = 0
            msg += dodgeRoll.message + '\n'
          }

          // Megumi — Mahoraga's Wheel (adapts to this boss attack by name,
          // nullifying it outright once mastered) then the Chimera Shadow
          // Garden's shadow-travel dodge. No-op for any other character.
          const mega = resolveMegumiIncoming(player, {
            damage: primaryHit,
            trueDamage: !!bossAtk.bypassDefense,
            kind: 'boss', id: bossAtk.attackName, label: bossAtk.attackName, bs,
          })
          if (mega.wheelCaption) void sendWheelSpin(ctx, mega.wheelCaption).catch(() => {})
          if (mega.message) msg += mega.message + '\n'
          primaryHit = mega.damage
          const megumiVoided = mega.nullified || mega.dodged

          // Summon Beast: chance to redirect this hit onto the beast's HP.
          const beastDmgResult = beastIntervention(player, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
            enemy: e,
            bs,
            damage: primaryHit,
          })
          if (beastDmgResult.modified) {
            if (beastDmgResult.damage !== undefined) primaryHit = beastDmgResult.damage
            msg += beastDmgResult.lines.join('\n') + '\n'
          }

          const absorbedPrimary = absorbDamage(player, primaryHit)
          const shieldBlockedPrimary = primaryHit - absorbedPrimary
          const appliedPrimary = applyIncomingDamage(player, absorbedPrimary)
          totalPlayerDmg += appliedPrimary.damage
          if (appliedPrimary.message) msg += appliedPrimary.message + '\n'
          if (appliedPrimary.catFormDefeated) {
            return resolveCatFormDefeat(player, ctx, { boss })
          }
          if (shieldBlockedPrimary > 0) msg += `🛡️ Shield absorbed *${shieldBlockedPrimary}* damage!\n`

          if (bossAtk.doubleStrike) {
            // Deku Gear Shift — second hit. Nullified/evaded alongside the
            // first when Mahoraga has mastered the move or Megumi slipped
            // into the shadows: it's the same attack, twice.
            const hit2 = megumiVoided ? 0 : defendSingle(rawBossAtk)
            const absorbedHit2 = absorbDamage(player, hit2)
            const shieldBlockedHit2 = hit2 - absorbedHit2
            const appliedHit2 = applyIncomingDamage(player, absorbedHit2)
            totalPlayerDmg += appliedHit2.damage
            if (appliedHit2.message) msg += appliedHit2.message + '\n'
            if (appliedHit2.catFormDefeated) {
              return resolveCatFormDefeat(player, ctx, { boss })
            }
            if (shieldBlockedHit2 > 0) msg += `🛡️ Shield absorbed *${shieldBlockedHit2}* damage!\n`
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

        // Side-effects: Naruto Baryon lifespan drain reduces player stats
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
      } else if (Math.random() > calcMonsterHitChance(e, player)) {
        // ── Regular enemy misses ──────────────────────────────────────────────
        msg += '\n' + enemyMissLine(e, player.equippedCharacter)
      } else {
        // ── Regular enemy hits ────────────────────────────────────────────────
        let enemyDmg = calcMonsterDamage(
          getEffectiveStat(e, 'atk'),
          getEffectiveStat(player, 'def'),
          false,
        )

        // Named-weapon/item passives: incoming-damage overrides.
        const dmgNamedResult = applyAllNamedPassives(
          player,
          NP_EVENT.ENEMY_DEAL_DAMAGE,
          {
            enemy: e,
            bs,
            damage: enemyDmg,
          },
        )
        let dmgNamedLines = ''
        if (dmgNamedResult.modified) {
          if (dmgNamedResult.damage !== undefined)
            enemyDmg = dmgNamedResult.damage
          dmgNamedLines = '\n' + dmgNamedResult.lines.join('\n')
        }

        // Nisha's Serpent's Grace — flat dodge chance against regular
        // (non-boss) enemy hits too.
        const dodgeRoll = rollSerpentsGrace(player, { damage: enemyDmg, trueDamage: false })
        if (dodgeRoll.dodged) {
          enemyDmg = 0
          dmgNamedLines += '\n' + dodgeRoll.message
        }

        // Megumi — Mahoraga's Wheel + the Garden's shadow dodge. A plain
        // enemy's basic attack is one move identity ('enemy:basic'), so three
        // straight swings from the same monster get mastered and then land
        // for 0 for the rest of the fight.
        const mega = resolveMegumiIncoming(player, {
          damage: enemyDmg, trueDamage: false,
          kind: 'enemy', label: `${e.name}'s attack`, bs,
        })
        if (mega.wheelCaption) void sendWheelSpin(ctx, mega.wheelCaption).catch(() => {})
        if (mega.message) dmgNamedLines += '\n' + mega.message
        enemyDmg = mega.damage

        // Summon Beast: chance to redirect this hit onto the beast's HP.
        const beastDmgResult = beastIntervention(player, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
          enemy: e,
          bs,
          damage: enemyDmg,
        })
        if (beastDmgResult.modified) {
          if (beastDmgResult.damage !== undefined) enemyDmg = beastDmgResult.damage
          dmgNamedLines += '\n' + beastDmgResult.lines.join('\n')
        }

        const absorbedEnemyDmg = absorbDamage(player, enemyDmg)
        const shieldBlockedEnemy = enemyDmg - absorbedEnemyDmg
        const appliedEnemy = applyIncomingDamage(player, absorbedEnemyDmg)
        if (appliedEnemy.message) msg += appliedEnemy.message + '\n'
        if (appliedEnemy.catFormDefeated) {
          return resolveCatFormDefeat(player, ctx, { boss })
        }
        msg += '\n' + enemyHitLine(e, appliedEnemy.damage, player.equippedCharacter) + dmgNamedLines
        if (shieldBlockedEnemy > 0) msg += `\n🛡️ Shield absorbed *${shieldBlockedEnemy}* damage!`
        if (player.hp <= 0) {
          const res = await resolvePlayerHpZero(player, ctx, msg, {})
          if (!res.fallThrough) return res.returnValue
          msg = res.msg
        }
      }

      // ── TURN_END event ────────────────────────────────────────────────────
      if (boss) {
        const teResult = applyBossSpecial(player, EVENT.TURN_END, {})
        if (teResult.narrativeLine) msg += `\n_${teResult.narrativeLine}_`
      }

      // Named-weapon/item passives: end-of-turn effects (stacking buffs,
      // periodic shockwaves, lifespan drain).
      const teNamedResult = applyAllNamedPassives(player, NP_EVENT.TURN_END, {
        enemy: e,
        bs,
      })
      if (teNamedResult.modified) msg += '\n' + teNamedResult.lines.join('\n')
      if (e.hp <= 0) {
        if (boss) cleanupBossFight(player)
        return handleVictory(player, e, ctx)
      }

      // Premium ability passive + pack thorns: the player was struck this turn,
      // so punish the attacker (freeze/burn/sleep chance, Gemstone flame-thorns
      // burn, Sicilian riposte reflect). Runs after the TURN_END victory check
      // and before the status bar so any riposte chip — and a possible KO from
      // it — land on the same HP the bar then renders.
      if (player.hp < hpBeforeTurn && e.hp > 0) {
        const struck = applyStruckReactions(player, e, hpBeforeTurn - player.hp)
        if (struck.lines.length) msg += '\n' + struck.lines.join('\n')
        if (struck.counterDamage > 0) {
          e.hp = Math.max(0, e.hp - struck.counterDamage)
          if (e.hp <= 0) {
            if (boss) cleanupBossFight(player)
            return handleVictory(player, e, ctx)
          }
        }
      }

      if (!boss) {
        msg +=
          `\n\n👤 *${player.name}*\n❤️ ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp}/${player.maxMp} MP\n` +
          `${e.emoji ?? '👾'} *${e.name}*\n❤️ ${hpBar(e.hp, e.maxHp)}\n\n` +
          `*${p}attack* · *${p}skill <name>* · *${p}defend* · *${p}flee*`
      }

      bs.turn = (bs.turn ?? 1) + 1
      player.battleState = bs

      // Durability — weapon wears every turn it's used; armor wears only
      // if the player actually took damage this turn.
      const wWear = wearWeaponOnTurn(player)
      msg += breakMessage(wWear)
      if (player.hp < hpBeforeTurn) {
        const aWear = wearArmorOnHit(player, hpBeforeTurn - player.hp)
        msg += breakMessage(aWear)
      }

      await sendWillowAdvisory(ctx, player, e, boss)
      if (boss) await sendCinematicBossTurn(ctx, { player, e, body: msg })
      else await sendBattleTurnReply(ctx, { bs, player, e, msg, hpBeforeTurn, eHpBeforeTurn, boss })
      return player
    })
  },
}
