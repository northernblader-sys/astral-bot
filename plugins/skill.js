import { config } from '../config.js'
import { sendBattleTurnReply } from '../lib/battle-frame-render.mjs'
import { sendCinematicBossTurn } from '../lib/boss-cinematic.js'
import { updatePlayer } from '../lib/player-repo.js'
import { resolveSwarmSkill } from '../lib/swarm-combat.js'
import { skills as allSkills } from '../lib/game-data.js'
import { getEquippedSkills } from '../lib/skill-slots.js'
import {
  calcPlayerDamage,
  applyDefense,
  calcMonsterDamage,
  calcPlayerHitChance,
  calcMonsterHitChance,
  rollEchoStrike,
  findSkill,
  hpBar,
  buildEffectDef,
} from '../lib/combat-engine.js'
import {
  handleVictory,
  processStatusTurn,
  resolvePlayerHpZero,
  checkCatFormOngoingTurn,
  resolveCatFormDefeat,
  applyBossStatDrain,
} from '../lib/combat-handlers.js'
import { addStatusEffect, getEffectiveStat, hasEffect, absorbDamage } from '../lib/effects.js'
import { getModValue, applyHighDefenseCatchup } from '../lib/mods.js'
import { beastIntervention, BEAST_EVENT } from '../lib/beast-engine.js'
import {
  wearWeaponOnTurn,
  wearArmorOnHit,
  breakMessage,
} from '../lib/durability.js'
import {
  activateFinalForm,
  sendFinalFormVideo,
  sendWillowAdvisory,
  tickFrostbindAura,
  applyAbsoluteOneSiphon,
  rollSerpentsGrace,
  isCatFormActive,
  resolveCatFormDamage,
  buildCatFormDefeatMessage,
  catFormAttackDamage,
  applyIncomingDamage,
  applyAlyaStatBreak,
  applyTearOnHit,
  tickPermanentSever,
  applyFrostlockGate,
  megumiTurnStart,
  resolveMegumiIncoming,
  sendWheelSpin,
  danceOfTheRainMultiplier,
  buildDanceOfTheRainMessage,
  hasSecondTranscendance,
} from '../lib/character-abilities.js'
import { isStreaming, rampStreamViewers } from './stream.js'
import { applyStruckReactions, applyPackLifestealOnDeal } from '../lib/premium-abilities.js'
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

const EFFECT_APPLIED_LINE = {
  stun: (n) => `⚡ *${n}* is stunned!\n`,
  freeze: (n) => `❄️ *${n}* is frozen!\n`,
  blind: (n) => `🌑 *${n}* is blinded!\n`,
  burn: (n) => `🔥 *${n}* is burning!\n`,
  poison: (n) => `☠️ *${n}* is poisoned!\n`,
  bleed: (n) => `🩸 *${n}* is bleeding!\n`,
  weaken: (n) => `💔 *${n}* is weakened!\n`,
  slow: (n) => `🐢 *${n}* is slowed!\n`,
}

function isBossFight(player) {
  return !!(player.battleState?.enemy?.isBoss && player.battleState?.bossState)
}

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
// applyBossStatDrain(). The Empty Vessel (Shunya) gate that used to sit here
// moved with it, which is how she finally became immune to boss drains on
// .attack and .defend too — those two copies never had the check.

export default {
  name: 'skill',
  aliases: ['sk', 's', 'sp'],
  category: 'combat',
  requiresPlayer: true,
  description: `Use a skill in battle (${config.prefix}skill <name>)`,

  async run(ctx) {
    const { args, reply } = ctx
    const p = config.prefix

    // No args → list skills
    if (!args.length) {
      const player = ctx.player
      const equipped = getEquippedSkills(player)
      const skillById = Object.fromEntries(allSkills.map((s) => [s.id, s]))
      const owned = equipped
        .map((id) => skillById[id])
        .filter((s) => s && s.type === 'active')
      // Shows each skill's real multiplier (effects[0].multiplier), not
      // just its tier label — two "common"-tier skills can still differ,
      // and this is the loadout screen a player checks mid-fight, so the
      // actual power reads at a glance instead of every line looking the same.
      const list = owned
        .map((s, i) => {
          const mult = s.effects?.[0]?.multiplier
          const power = mult != null ? ` · ${Math.round(mult * 100)}%` : ''
          return `  ${i + 1}. *${s.name}* _(${s.tier}, ${s.mpCost} MP${power})_`
        })
        .join('\n')
      return reply(
        `✨ *Equipped Skills* _(${equipped.length}/4 slots)_:\n${list || '_None equipped — use ' + p + 'skillslot to set up your loadout!_'}\n\nUsage: *${p}skill <name or #>* · *${p}skillslot* to configure`,
      )
    }

    await updatePlayer(ctx.db, ctx.from, async (player) => {
      // Entry Tower swarm floors run the multi-monster engine (swarm-combat.js);
      // the 1v1 pipeline below is byte-identical for every other fight.
      if (player.battleState?.mode === 'swarm') return resolveSwarmSkill(player, ctx)
      if (player.battleState?.type === 'pvp') {
        await reply(`⚔️ *You're in a duel* — use *${p}pvp skill <name>* instead.`)
        return player
      }
      if (!player.inBattle || !player.battleState) {
        await reply(`❌ *Not in battle.*`)
        return player
      }
      const bs = player.battleState
      const e = bs.enemy
      const boss = isBossFight(player)
      const query = args.join(' ')
      const equippedIds = getEquippedSkills(player)
      const slotNum = Number(query.trim())
      const skillById = Object.fromEntries(allSkills.map((s) => [s.id, s]))
      const skill = (Number.isInteger(slotNum) && slotNum >= 1 && slotNum <= equippedIds.length)
        ? skillById[equippedIds[slotNum - 1]]
        : findSkill(query, equippedIds, allSkills)

      if (!skill) {
        await reply(
          `❌ Skill *${query}* not found.\nType *${p}skill* to see yours.`,
        )
        return player
      }
      if (skill.type !== 'active') {
        await reply(`⚠️ *${skill.name}* is passive — applies automatically.`)
        return player
      }
      if ((player.mp ?? 0) < skill.mpCost) {
        await reply(
          `💧 Need *${skill.mpCost} MP*, have *${player.mp ?? 0}*. Use *${p}defend* to regen MP.`,
        )
        return player
      }

      // ── Yoriichi's cat form: she is the combatant now, so the whole turn is
      // hers — but the MOVE is still the owner's, which is why the resolved
      // skill is threaded through. This intercept sits AFTER the parse and the
      // exists/active/affordable checks on purpose: it used to run before them,
      // so `.skill <name>` during cat form never even read the skill and
      // silently collapsed into a plain basic attack. checkCatFormOngoingTurn
      // spends the MP itself (the code below is never reached on her turns).
      const catTurn = await checkCatFormOngoingTurn(player, ctx, { boss, skill })
      if (catTurn.intercepted) return catTurn.returnValue

      let msg = ''

      // ── Urahara's permanent Tear — action-triggered tick. Same placement
      // as attack.js: fires on the player's action regardless of context, so
      // `.skill` costs the carrier a Sever tick exactly like `.attack` does.
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

      // ── Miyashi's Frostbind aura — same turn-start slot as attack.js.
      const frostbind = tickFrostbindAura(player, e, bs)
      if (frostbind) {
        msg += frostbind.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Nisha's Absolute One — same turn-start slot as attack.js.
      const absoluteOne = applyAbsoluteOneSiphon(player, e)
      if (absoluteOne) {
        msg += absoluteOne.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }
      }

      // ── Alya's Stat Break — same turn-start slot as attack.js.
      const alyaBreak = applyAlyaStatBreak(player, e, bs)
      if (alyaBreak.triggered) {
        msg += alyaBreak.message + '\n'
      }

      // ── Megumi's Thousand Shadows Swarm — same turn-start slot as
      // attack.js: drain + self-heal + deepening ATK cut, doubled while the
      // Chimera Shadow Garden is open, plus Garden/Mahoraga true strikes.
      const swarm = megumiTurnStart(player, e, bs)
      if (swarm) {
        msg += swarm.message + '\n'
        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
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

      const hpBeforeTurn  = player.hp
      const eHpBeforeTurn = e.hp
      if (playerStatus.incapacitated) {
        msg += `💫 *${player.name}* is unable to act this turn! _(MP not spent)_\n`
      } else {
        player.mp -= skill.mpCost
        bs.playerDefending = false
        // Derive element from skill definition (fall back to 'physical')
        const skillElement =
          skill.element ??
          (skill.effects?.[0]?.type === 'magic' ? 'magic' : 'physical')

        msg += `✨ *${player.name}* uses *${skill.name}*! _(${skill.mpCost} MP)_\n`

        if (
          skill.effects?.[0]?.type === 'shield' ||
          skill.effects?.[0]?.type === 'regen'
        ) {
          // Self-targeted support skills — always land, applied to the
          // caster, no accuracy check (same as heal below).
          const selfDef = buildEffectDef(skill.effects[0], player, skill.id)
          if (selfDef) {
            addStatusEffect(player, selfDef)
            if (selfDef.type === 'shield') {
              msg += `🛡️ *${player.name}* raises a shield absorbing *${selfDef.amount}* damage for *${selfDef.duration}* turn(s)!\n`
            } else {
              msg += `💚 *${player.name}* is regenerating *${selfDef.amount} HP* per turn for *${selfDef.duration}* turn(s)!\n`
            }
          }

          if (boss) {
            const supportSkillResult = applyBossSpecial(
              player,
              EVENT.PLAYER_SKILL_ATTACK,
              {
                damage: 0,
                skillId: skill.id,
                element: skillElement,
                isCrit: false,
                isHit: true,
              },
            )
            if (supportSkillResult.narrativeLine)
              msg += `_${supportSkillResult.narrativeLine}_\n`
          }
        } else if (skill.effects?.[0]?.type === 'heal') {
          // Heals always land — no accuracy check on self-targeted effects
          const amt = Math.floor(calcPlayerDamage(player, skill).rawDmg)
          player.hp = Math.min(player.maxHp, player.hp + amt)
          msg += `💚 Healed *${amt} HP*!\n`

          // Some heal skills carry a secondary debuff (poison/burn/weaken)
          // that lands on the enemy alongside the self-heal — e.g. cleric's
          // Astral Tide. Apply it the same way the attack branch does.
          const healSecondary = skill.effects?.[1]
          const healEffectDef = buildEffectDef(healSecondary, e, skill.id)
          if (healEffectDef) {
            addStatusEffect(e, healEffectDef)
            msg += EFFECT_APPLIED_LINE[healSecondary.type]?.(e.name) ?? ''
          }

          if (boss) {
            // Fire PLAYER_SKILL_ATTACK even for heals so Frieren can track the skill ID
            const healSkillResult = applyBossSpecial(
              player,
              EVENT.PLAYER_SKILL_ATTACK,
              {
                damage: 0,
                skillId: skill.id,
                element: skillElement,
                isCrit: false,
                isHit: true,
              },
            )
            if (healSkillResult.narrativeLine)
              msg += `_${healSkillResult.narrativeLine}_\n`
          }
        } else if (Math.random() > calcPlayerHitChance(player, e)) {
          // ── MISS ─────────────────────────────────────────────────────────────
          msg += `💨 *${skill.name}* misses *${e.name}*! _(MP still spent)_\n`
          if (boss) {
            const missResult = applyBossSpecial(player, EVENT.PLAYER_MISS, {
              isMiss: true,
            })
            msg += `💬 _"${getBossDodgeLine(player)}"_\n`
            if (missResult.narrativeLine)
              msg += `_${missResult.narrativeLine}_\n`
            if (missResult.applyEffect) {
              const fx = _buildBossEffect(player, missResult.applyEffect)
              if (fx) addStatusEffect(player, fx)
            }
          }
        } else {
          // ── HIT ────────────────────────────────────────────────────────────
          // Cheat mods (PvE only — see attack.js/party.js for the same
          // pattern; skill.js's boss-flagged branch confirms this path is
          // never reached from pvp.js).
          const catFormMult = catFormAttackDamage(player)
          const danceMult = danceOfTheRainMultiplier(player, bs)
          const { rawDmg, isCrit } = calcPlayerDamage(
            player,
            skill,
            (getModValue(player, 'damage_multiplier') ?? 1) * catFormMult * danceMult,
            getModValue(player, 'crit_chance_boost') ?? 0,
          )
          let finalDmg = applyHighDefenseCatchup(
            player,
            e,
            applyDefense(rawDmg, getEffectiveStat(e, 'def')),
          )

          if (boss) {
            // PLAYER_SKILL_ATTACK — Frieren tracks skill use, Meliodas counters, etc.
            const skillResult = applyBossSpecial(
              player,
              EVENT.PLAYER_SKILL_ATTACK,
              {
                damage: finalDmg,
                skillId: skill.id,
                element: skillElement,
                isCrit,
                isHit: true,
              },
            )
            if (skillResult.modified && skillResult.damage !== undefined)
              finalDmg = skillResult.damage
            if (skillResult.narrativeLine)
              msg += `_${skillResult.narrativeLine}_\n`

            // Meliodas / Frieren reflect — bounce damage back at player
            if (skillResult.reflectDamage) {
              const applied = applyIncomingDamage(player, skillResult.reflectDamage)
              if (applied.message) msg += applied.message + '\n'
              if (applied.catFormDefeated) {
                return resolveCatFormDefeat(player, ctx, { boss })
              }
              msg += `🔁 *Counter!* Your skill is reflected!\n🩸 *${skillResult.reflectDamage}* damage back at you!\n`
              if (player.hp <= 0) {
                const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
                if (!res.fallThrough) return res.returnValue
                msg = res.msg
              }
            }

            // ENEMY_TAKE_DAMAGE — Gojo nullifies, Kaido halves, Mahoraga adapts, etc.
            const takeResult = applyBossSpecial(
              player,
              EVENT.ENEMY_TAKE_DAMAGE,
              {
                damage: finalDmg,
                element: skillElement,
                isCrit,
                isHit: true,
                skillId: skill.id,
              },
            )
            if (takeResult.modified && takeResult.damage !== undefined)
              finalDmg = takeResult.damage
            if (takeResult.narrativeLine)
              msg += `_${takeResult.narrativeLine}_\n`

            if (takeResult.reflectDamage) {
              const applied = applyIncomingDamage(player, takeResult.reflectDamage)
              if (applied.message) msg += applied.message + '\n'
              if (applied.catFormDefeated) {
                return resolveCatFormDefeat(player, ctx, { boss })
              }
              msg += `🔁 *Full Counter!* Your skill is reflected!\n🩸 *${takeResult.reflectDamage}* damage back at you!\n`
              if (player.hp <= 0) {
                const res = await resolvePlayerHpZero(player, ctx, msg, { boss: true })
                if (!res.fallThrough) return res.returnValue
                msg = res.msg
              }
            }
          }

          e.hp = Math.max(0, e.hp - finalDmg)
          if (finalDmg > 0) {
            msg += `💥 *${finalDmg}* damage!${isCrit ? ' ⚡ *CRIT!*' : ''}\n`
          } else {
            msg += `🛡️ _Attack absorbed — no damage dealt!_\n`
          }
          msg += buildDanceOfTheRainMessage(bs, player)

          // Dark Monarch pack — Dread lifesteal on the skill's dealt damage.
          if (finalDmg > 0) {
            const ls = applyPackLifestealOnDeal(player, finalDmg)
            if (ls.heal > 0) {
              player.hp = Math.min(player.maxHp, player.hp + ls.heal)
              msg += ls.lines.join('\n') + '\n'
            }
          }

          // Urahara — Tear/Reshape: apply the in-battle 'sever' bleed on the
          // player's own hit landing, same as attack.js. Guarded on e.hp > 0
          // so a lethal skill short-circuits to victory instead of bleeding
          // a corpse.
          if (e.hp > 0) {
            const tearLine = applyTearOnHit(player, e, ctx)
            if (tearLine) msg += tearLine + '\n'
          }

          // Secondary effect (stun, freeze, burn, etc.) from skill definition
          const secondary = skill.effects?.[1]
          const effectDef = buildEffectDef(secondary, e, skill.id)
          if (effectDef) {
            addStatusEffect(e, effectDef)
            msg += EFFECT_APPLIED_LINE[secondary.type]?.(e.name) ?? ''
          }

          if (boss) {
            // PLAYER_HIT_ENEMY — after damage/effects land
            const hitResult = applyBossSpecial(player, EVENT.PLAYER_HIT_ENEMY, {
              damage: finalDmg,
              isCrit,
              element: skillElement,
              skillId: skill.id,
              isHit: true,
            })
            if (hitResult.narrativeLine) msg += `_${hitResult.narrativeLine}_\n`
            if (finalDmg > 0) msg += `💬 _"${getBossHitLine(player)}"_\n`
          }
        }

        if (e.hp <= 0) {
          if (boss) cleanupBossFight(player)
          return handleVictory(player, e, ctx)
        }

        if (boss) {
          const phase = checkBossPhase(player)
          if (phase?.triggered && phase.lines?.length) {
            msg +=
              `\n⚡ *— PHASE SHIFT —*\n` +
              phase.lines.map((l) => `_${l}_`).join('\n') +
              '\n'
          }
        }
      }

      // ⚡ Second Transcendance — the equipped Transcendent acts a SECOND time
      // every turn. Here the echo scales off the SAME skill (no extra MP, no
      // re-applied secondary effect — damage only). Inserted after the primary
      // hit/miss resolves and before the enemy's status tick + counter, so it
      // never advances bs.turn nor adds a second retaliation.
      if (e.hp > 0 && hasSecondTranscendance(player)) {
        const echo = rollEchoStrike(player, e, skill)
        if (echo?.missed) {
          msg += `⚡ *SECOND TRANSCENDANCE* — the echo swings and *misses!*\n`
        } else if (echo) {
          let echoDmg = applyDefense(echo.rawDmg, getEffectiveStat(e, 'def'))
          if (boss) {
            const echoTake = applyBossSpecial(player, EVENT.ENEMY_TAKE_DAMAGE, {
              damage: echoDmg, element: skillElement, isCrit: echo.isCrit, isHit: true, skillId: skill.id,
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

      // 📺 Streamer — the crowd swells with every blow struck in the dungeon;
      // no-op for anyone not currently live (plugins/stream.js owns the meter).
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

        // Miyashi's frostlock — same enforcement as attack.js: a locked boss
        // still acts, but is forced down to a basic attack (no named special,
        // no barrage, no DEF-bypass, no double strike).
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
              : calcMonsterDamage(dmg, getEffectiveStat(player, 'def'), false)

          let primaryHit = defendSingle(rawBossAtk)

          // Nisha's Serpent's Grace — flat dodge chance, same shape/exemption
          // as attack.js (skipped for true damage).
          const dodgeRoll = rollSerpentsGrace(player, { damage: primaryHit, trueDamage: bossAtk.bypassDefense })
          if (dodgeRoll.dodged) {
            primaryHit = 0
            msg += dodgeRoll.message + '\n'
          }

          // Megumi — Mahoraga's Wheel then the Garden's shadow-travel dodge,
          // same as attack.js.
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

          if (bossAtk.doubleStrike) {
            const hit2 = megumiVoided ? 0 : defendSingle(rawBossAtk)
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
            msg += `${e.emoji ?? '👾'} *${e.name}* uses *${bossAtk.attackName}*!\n`
            msg += `🩸 *${absorbedPrimary}* damage!${bossAtk.bypassDefense ? ' _(bypasses DEF)_' : ''}\n`
            if (shieldBlockedPrimary > 0) msg += `🛡️ Shield absorbed *${shieldBlockedPrimary}* damage!\n`
          }
        }

        if (bossAtk.narrativeLines?.length)
          msg += bossAtk.narrativeLines.map(l => `_${l}_`).join('\n') + '\n'
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
      } else if (Math.random() > calcMonsterHitChance(e, player)) {
        msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates... and *MISSES!*`
      } else {
        let enemyDmg = calcMonsterDamage(
          e.atk,
          getEffectiveStat(player, 'def'),
          false,
        )
        let beastDmgLine = ''
        // Nisha's Serpent's Grace — flat dodge chance against regular
        // (non-boss) enemy hits too, matching attack.js.
        const dodgeRoll = rollSerpentsGrace(player, { damage: enemyDmg, trueDamage: false })
        if (dodgeRoll.dodged) {
          enemyDmg = 0
          beastDmgLine = '\n' + dodgeRoll.message
        }

        // Megumi — Mahoraga's Wheel + the Garden's shadow dodge, same as
        // attack.js.
        const mega = resolveMegumiIncoming(player, {
          damage: enemyDmg, trueDamage: false,
          kind: 'enemy', label: `${e.name}'s attack`, bs,
        })
        if (mega.wheelCaption) void sendWheelSpin(ctx, mega.wheelCaption).catch(() => {})
        if (mega.message) beastDmgLine += '\n' + mega.message
        enemyDmg = mega.damage
        const beastDmgResult = beastIntervention(player, BEAST_EVENT.ENEMY_DEAL_DAMAGE, {
          enemy: e,
          bs,
          damage: enemyDmg,
        })
        if (beastDmgResult.modified) {
          if (beastDmgResult.damage !== undefined) enemyDmg = beastDmgResult.damage
          beastDmgLine = '\n' + beastDmgResult.lines.join('\n')
        }
        const absorbedEnemyDmg = absorbDamage(player, enemyDmg)
        const shieldBlockedEnemy = enemyDmg - absorbedEnemyDmg
        const appliedEnemy = applyIncomingDamage(player, absorbedEnemyDmg)
        if (appliedEnemy.message) msg += appliedEnemy.message + '\n'
      if (appliedEnemy.catFormDefeated) {
        return resolveCatFormDefeat(player, ctx, { boss })
      }
        msg += `\n${e.emoji ?? '👾'} *${e.name}* retaliates!\n🩸 *${appliedEnemy.damage}* damage!${beastDmgLine}`
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

      // Premium ability passive + pack thorns: player was struck this turn →
      // punish the attacker (see attack.js for the full rationale). Before the
      // status bar so a riposte chip/KO shows on the same HP the bar renders.
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
