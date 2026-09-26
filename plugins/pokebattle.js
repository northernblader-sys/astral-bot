/**
 * pokebattle.js — Pokémon-vs-Pokémon turn-based PvP, using each player's
 * main Pokémon (player.mainPokemonId). Mirrors plugins/pvp.js's structure
 * (challenge → accept/decline → simultaneous-select turns → conclude), but
 * fights are Pokémon-vs-Pokémon instead of trainer-vs-trainer, and rendering
 * goes through lib/pokemon-battle-render.mjs (real per-species artwork per
 * turn) instead of lib/battle-frame-render.mjs's fixed character/monster
 * sprites.
 *
 * Registered as `.p-battle` (short form — every Pokémon-system command uses
 * a `.p-<short>` primary name; `.pokebattle`/`.pbattle`/`.pokefight` still
 * work as aliases).
 *
 * TURN MODEL (Pokémon overhaul §3) — SIMULTANEOUS MOVE SELECTION:
 * Both players independently lock in a move via `.move <name or #>` (see
 * plugins/move.js) any time after a turn opens; there is no `myTurn` flag
 * gating who's "allowed" to act. Speed no longer determines who's allowed to
 * move — it only determines move ORDER once both sides have chosen. A turn
 * resolves the moment both `pendingMove`s are set. A 60s silent player
 * forfeits the whole match (routed through pokebattleConclude(), same as an
 * explicit `.p-battle forfeit`) — checked by main.js's timeout sweep,
 * not by this file (see the Pokémon overhaul file-by-file summary §5: the
 * sweep addition lives in main.js).
 *
 * STATE: pending challenge lives on the target as
 * `player.pokemonChallenge = { fromJid, expiresAt }` (mirrors pvpChallenge).
 * Once accepted, both players get:
 *   player.pokemonBattleState = {
 *     opponentJid, hp, maxHp, startedAt,
 *     pendingMove: null,     // move id locked in for the current turn
 *     turnDeadline: number,  // Date.now() + 60_000, reset each new turn
 *     turnNumber: 1,
 *   }
 * HP is tracked on the battleState itself (starting from the Pokémon's
 * current currentHp/maxHp) rather than mutated on player.pokemon[] directly
 * mid-fight, so a forfeit/disconnect never leaves a Pokémon's real
 * currentHp corrupted; only pokebattleConclude writes the final HP back.
 *
 * Wins/losses land in player.pokemonBattle = { wins, losses }, a lazily-
 * defaulted shape (same pattern as player.friends/friendRequests in
 * plugins/friend.js).
 *
 * Usage:
 *   <prefix>p-battle on|off   — group admins: enable/disable in this group
 *                                 (shares the group's pokemonEnabled flag)
 *   <prefix>p-battle @target  — challenge (reply or @mention)
 *   <prefix>p-battle accept   — accept a pending challenge against you
 *   <prefix>p-battle decline  — decline a pending challenge against you
 *   <prefix>p-battle forfeit  — concede the current match
 *   <prefix>move <name or #> — lock in your move for this turn (plugins/move.js)
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { getMainPokemon } from '../lib/pokemon-engine.js'
import { sendPokemonBattleTurnReply } from '../lib/pokemon-battle-render.mjs'
import { getMoveById } from '../lib/move-pool.js'
import { typeEffectiveness, effectivenessText } from '../lib/type-chart.js'
import { addStatusEffect, tickEffects } from '../lib/effects.js'
import { computeBattleStats } from '../lib/pokemon-stats.js'
import {
  choiceBoostFor, lifeOrbDamageMultiplier, applyChoiceLockOnMoveUse,
  applyLifeOrbRecoil, applyResistBerry, checkFocusSash, applyEndOfTurnHeldItems,
} from '../lib/pokemon-held-items.js'
import {
  abilityMovePowerMultiplier, abilityDefensiveResult, rollOnHitTakenAbility,
  roughSkinRecoil, checkSturdy, gutsAttackMultiplier, intimidateBattleStartLines,
  statusImmuneAbility, hasMagicGuard, abilitySpeedMultiplier,
} from '../lib/pokemon-abilities.js'
import {
  rollWeather, weatherAnnounceLine, weatherPowerMultiplier, weatherChipDamage,
} from '../lib/pokemon-weather.js'
import { canMegaEvolve, applyMegaOverlay, effectiveMonView, getMatchingMegaForm } from '../lib/mega-evolution.js'
import { runLevelUpEvolutionCheck } from '../lib/pokemon-evolution.js'
import { recordQuestEvent } from '../lib/quest-engine.js'

const CHALLENGE_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes to accept/decline
export const TURN_TIMEOUT_MS = 60 * 1000    // 60s to lock in a move — exported for main.js's sweep
const WIN_SOLARS       = 300
const BASE_CRIT_CHANCE = 0.15

// Duration (in ticks) applied to move-triggered status effects. Kept short —
// these are per-battle-turn ticks, not the general combat-engine's turn
// count, so a "burned for 3" here means 3 more Pokémon-battle turns.
const MOVE_EFFECT_DURATION = 3
const MOVE_EFFECT_DOT_VALUE = 8     // burn/poison per-tick damage from a move-applied status
const MOVE_EFFECT_STAT_VALUE = 6    // weaken/strengthen flat stat delta from a move-applied status

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

export function inPokeBattle(player) {
  return !!(player.inPokemonBattle && player.pokemonBattleState)
}

function ensureRecord(p) {
  if (!p.pokemonBattle) p.pokemonBattle = { wins: 0, losses: 0 }
  return p.pokemonBattle
}

/**
 * Real battle stats — overhaul addendum §9.4. Delegates to
 * lib/pokemon-stats.js's computeBattleStats(), which runs the actual
 * Gen 3+ IV/EV/nature formula and adds trainedAtk/trainedDef/etc on top
 * (those stay a separate additive system — see that file's header note).
 * Replaces the old flat `baseAtk + trainedAtk` computation this function
 * used before addendum §9 existed.
 *
 * `state` (a side's pokemonBattleState) is optional and layers two later
 * additions on top, both battle-only and neither touching the stored mon:
 *  - Mega Evolution (§10.3): if `state.megaActive` and mon still qualifies,
 *    the mega form's stat multipliers apply LAST, after everything else.
 *  - Weather-boosted speed abilities (§13/§12): Swift Swim/Chlorophyll/
 *    Sand Rush/Slush Rush double SPD only, only for turn-order purposes —
 *    applied after the mega overlay so a mega'd Pokémon's ability (which
 *    may differ from its base ability, e.g. Mega Charizard X's Tough
 *    Claws) is what's checked, not its pre-mega one.
 */
function statsOf(mon, state = null) {
  let stats = computeBattleStats(mon)

  const megaForm = state?.megaActive ? getMatchingMegaForm(mon) : null
  if (megaForm) stats = applyMegaOverlay(stats, megaForm)

  const view = effectiveMonView(mon, state)
  const speedMult = abilitySpeedMultiplier(mon, state?.weather, view.ability)
  if (speedMult !== 1) stats = { ...stats, spd: Math.floor(stats.spd * speedMult) }

  return stats
}

/**
 * damageFor — standard simplified Pokémon damage formula (overhaul §3.3
 * step 3, extended by addendum §12/§13). Physical moves use atk/def,
 * special moves use spAtk/spDef. Status moves never reach here (0 power,
 * handled separately by the caller).
 *
 * Full multiplier order (addendum §13.2's explicit ordering, with §12's
 * ability hooks slotted alongside the item hooks they're required to stay
 * separate from): base → STAB → type-eff (ability-adjusted) → weather →
 * crit → random → Life Orb / Guts / Intimidate stat-level multipliers.
 *
 * `attackerView`/`defenderView` come from lib/mega-evolution.js's
 * effectiveMonView() — real types/ability normally, or the mega form's
 * overlay when that side has Mega Evolved this battle. `weather` and
 * `attackerAtkMult` (Intimidate) come from the relevant side's
 * pokemonBattleState.
 */
function damageFor(move, attackerMon, attackerStats, defenderMon, defenderStats, ctx) {
  const { attackerView, defenderView, weather, attackerAtkMult = 1 } = ctx
  const level = attackerMon.level ?? 5
  const isPhysical = move.category === 'physical'
  const atkStatKey = isPhysical ? 'atk' : 'spAtk'
  const defStatKey = isPhysical ? 'def' : 'spDef'

  // Held-item stat boosts (Choice Band/Specs — addendum §11.1/§11.2) apply
  // as a flat multiplier on the attacker's relevant offensive stat, kept as
  // its own clearly-separate step from the ability step below, per the
  // addendum's explicit instruction not to tangle the two.
  const choiceMult = choiceBoostFor(attackerMon, atkStatKey)
  // Guts (addendum §12) — flat ATK boost while afflicted with a status
  // condition. Intimidate (§12) — flat ATK debuff rolled once at battle
  // start and carried on the attacker's own pokemonBattleState the whole
  // fight (`attackerAtkMult`, passed in by the caller). Both are
  // ability-level multipliers, kept separate from the Choice-item multiplier
  // above even though all three stack onto the same stat.
  const gutsMult = gutsAttackMultiplier(attackerMon, atkStatKey, attackerView.ability)
  const atkStat = attackerStats[atkStatKey] * choiceMult * gutsMult * attackerAtkMult
  const defStat = defenderStats[defStatKey]

  const base = ((2 * level / 5 + 2) * move.power * (atkStat / Math.max(1, defStat)) / 50 + 2)
  const stab = (attackerView.types ?? []).includes(move.type) ? 1.5 : 1

  // Type effectiveness, then ability-adjusted (Levitate/Water Absorb/Volt
  // Absorb/Flash Fire/Thick Fat — addendum §12.2: "passive triggers are
  // checked during type-effectiveness lookup itself"). defenderView.types
  // covers a mega form's type change; defenderView.ability covers a mega
  // form's ability swap.
  const rawEff = typeEffectiveness(move.type, defenderView.types)
  const abilityDef = abilityDefensiveResult(defenderMon, move.type, rawEff, defenderView.ability)
  const eff = abilityDef.multiplier

  const isCrit = Math.random() < BASE_CRIT_CHANCE
  const crit = isCrit ? 1.5 : 1
  const randomFactor = 0.85 + Math.random() * 0.15 // 0.85–1.0
  // Weather (addendum §13.2) — same multiplier-chain step as STAB/type-eff.
  const weatherMult = weatherPowerMultiplier(weather, move.type)
  // Blaze/Torrent/Overgrow (addendum §12) — low-HP same-type power boost.
  const abilityPowerMult = abilityMovePowerMultiplier(attackerMon, move.type, attackerView.ability)
  // Life Orb (addendum §11.1/§11.2) — flat damage-output boost, applied in
  // the same multiplier chain as STAB/type-eff/weather/crit/random; its own
  // recoil half is applied separately in the caller after this returns
  // (needs to know the attacker actually landed the hit first).
  const lifeOrbMult = lifeOrbDamageMultiplier(attackerMon)

  const dmg = Math.floor(
    base * stab * eff * weatherMult * abilityPowerMult * crit * randomFactor * lifeOrbMult
  )
  return {
    dmg: Math.max(eff === 0 ? 0 : 1, dmg),
    eff,
    crit: isCrit,
    absorb: abilityDef.absorb,
    absorbHealFraction: abilityDef.healFraction,
  }
}

/**
 * applyMoveEffect — maps a move's { type, chance, stat? } effect def (from
 * data/moves.json) onto lib/effects.js's addStatusEffect() shapes. Rolls
 * the chance here since moves.json's chance is move-specific, not something
 * effects.js knows about. Returns a human-readable log line, or null if the
 * chance roll missed / there was no effect to apply.
 *
 * `targetMon`/`targetAbilityOverride` (addendum §12) let a status-immune
 * ability (Immunity/Limber/Magma Armor/Water Veil) block burn/poison/
 * freeze/stun from ever landing — checked before the roll consumes any
 * randomness, since a blocked status shouldn't "use up" the move's chance
 * differently than real Pokémon (the roll always happens; immunity just
 * no-ops the result).
 */
function applyMoveEffect(move, targetMonLike, targetMon, targetAbilityOverride = null) {
  const eff = move.effect
  if (!eff) return null
  if (Math.random() * 100 >= (eff.chance ?? 100)) return null
  if (['burn', 'poison', 'stun', 'freeze'].includes(eff.type) &&
      targetMon && statusImmuneAbility(targetMon, eff.type, targetAbilityOverride)) {
    return null
  }

  switch (eff.type) {
    case 'burn':
      addStatusEffect(targetMonLike, { type: 'burn', amount: MOVE_EFFECT_DOT_VALUE, duration: MOVE_EFFECT_DURATION })
      return `🔥 ${targetMonLike.name} was burned!`
    case 'poison':
      addStatusEffect(targetMonLike, { type: 'poison', amount: MOVE_EFFECT_DOT_VALUE, duration: MOVE_EFFECT_DURATION })
      return `🟢 ${targetMonLike.name} was poisoned!`
    case 'freeze':
      addStatusEffect(targetMonLike, { type: 'freeze', duration: MOVE_EFFECT_DURATION })
      return `❄️ ${targetMonLike.name} was frozen solid!`
    case 'stun':
      addStatusEffect(targetMonLike, { type: 'stun', duration: 1 })
      return `💫 ${targetMonLike.name} flinched and is stunned!`
    case 'weaken':
      addStatusEffect(targetMonLike, { type: 'weaken', stat: eff.stat, value: MOVE_EFFECT_STAT_VALUE, duration: MOVE_EFFECT_DURATION })
      return `⬇️ ${targetMonLike.name}'s ${eff.stat.toUpperCase()} fell!`
    case 'strengthen':
      addStatusEffect(targetMonLike, { type: 'strengthen', stat: eff.stat, value: MOVE_EFFECT_STAT_VALUE, duration: MOVE_EFFECT_DURATION })
      return `⬆️ ${targetMonLike.name}'s ${eff.stat.toUpperCase()} rose!`
    default:
      return null
  }
}

export default {
  name: 'p-battle',
  aliases: ['pokebattle', 'pbattle', 'pokefight'],
  category: 'pokemon',
  requiresPlayer: true,
  description: `${config.prefix}p-battle @target — challenge another player's Pokémon to a battle`,
  subcommands: [
    { cmd: 'on|off',      desc: 'group admins: enable/disable Pokémon battles here' },
    { cmd: '@target',     desc: 'challenge another player (reply or @mention)' },
    { cmd: 'accept',      desc: 'accept a pending challenge against you' },
    { cmd: 'decline',     desc: 'decline a pending challenge against you' },
    { cmd: 'forfeit',     desc: 'concede the current battle' },
    { cmd: 'megaevolve',  desc: 'Mega Evolve your active Pokémon, once per battle, if holding its mega stone' },
  ],

  async run(ctx) {
    const { player, args, db } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── ON / OFF (group admins only) — shares the pokemonEnabled flag ─────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return ctx.reply(NOT_ALLOWED)
      // Report the stored value, and say so when the write failed — see mine.js.
      // Note this shares pokemonEnabled with .pokeswitch, which ALSO maintains
      // the spawn-group list; this command only gates the battle commands.
      const res = await saveGroupSettings(ctx.sender, (s) => { s.pokemonEnabled = (sub === 'on') })
      if (!res.ok) return ctx.reply(saveFailedMessage('Pokémon features', res.error))
      return ctx.reply(`🐾 Pokémon features are now *${res.settings.pokemonEnabled ? 'ON' : 'OFF'}* in this group.`)
    }

    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.pokemonEnabled) {
        return ctx.reply(
          `🚫 Pokémon features are disabled in this group.\n` +
          `_A group admin can turn it on with *${pr}p-battle on*._`
        )
      }
    }

    // ── ACCEPT ──────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const challenge = player.pokemonChallenge
      if (!challenge) return ctx.reply(`❌ You have no pending Pokémon battle challenge.`)
      if (Date.now() > challenge.expiresAt) {
        await updatePlayer(db, ctx.from, (p) => { p.pokemonChallenge = null })
        return ctx.reply(`⏳ That challenge expired.`)
      }
      const challengerJid = challenge.fromJid
      if (!playerExists(db, challengerJid)) {
        await updatePlayer(db, ctx.from, (p) => { p.pokemonChallenge = null })
        return ctx.reply(`❌ That challenger is no longer registered.`)
      }
      const challenger = getPlayer(db, challengerJid)
      const challengerMon = getMainPokemon(challenger)
      const myMon = getMainPokemon(player)
      if (!challengerMon) {
        await updatePlayer(db, ctx.from, (p) => { p.pokemonChallenge = null })
        return ctx.reply(`❌ *${challenger.name}* no longer has a Main Pokémon set.`)
      }
      if (!myMon) return ctx.reply(`❌ Set a Main Pokémon first: *${pr}p-poke main <n>*.`)
      if (inPokeBattle(challenger) || inPokeBattle(player)) {
        await updatePlayer(db, ctx.from, (p) => { p.pokemonChallenge = null })
        return ctx.reply(`❌ One of you is already in a Pokémon battle.`)
      }

      // Weather (addendum §13.1) — rolled ONCE here, at accept time, and
      // duplicated onto both sides' state, same convention as hp/maxHp.
      const weather = rollWeather()
      const weatherLine = weatherAnnounceLine(weather)

      // Intimidate (addendum §12.1/§12.2) — reinterpreted as on-battle-start
      // since there's no switching in a 1v1 bot. Rolled once here too, and
      // the resulting ATK multiplier is stored per-side so damageFor() can
      // apply it without re-deriving it every turn.
      const { aAtkMult: myAtkMult, bAtkMult: challengerAtkMult, lines: intimidateLines } =
        intimidateBattleStartLines(myMon, challengerMon)

      let raceAborted = false
      const openDeadline = Date.now() + TURN_TIMEOUT_MS
      await updatePlayer(db, challengerJid, (c) => {
        if (inPokeBattle(c)) { raceAborted = true; return }
        const cMon = getMainPokemon(c)
        c.inPokemonBattle = true
        c.pokemonBattleState = {
          opponentJid: ctx.from,
          hp: cMon.currentHp, maxHp: cMon.maxHp,
          startedAt: Date.now(),
          pendingMove: null,
          turnDeadline: openDeadline,
          turnNumber: 1,
          weather,
          megaActive: false,
          intimidatedAtkMult: challengerAtkMult,
        }
      })
      if (raceAborted) {
        await updatePlayer(db, ctx.from, (p) => { p.pokemonChallenge = null })
        return ctx.reply(`❌ *${challenger.name}* is no longer available to battle.`)
      }

      await updatePlayer(db, ctx.from, (p) => {
        p.pokemonChallenge = null
        p.inPokemonBattle = true
        p.pokemonBattleState = {
          opponentJid: challengerJid,
          hp: myMon.currentHp, maxHp: myMon.maxHp,
          startedAt: Date.now(),
          pendingMove: null,
          turnDeadline: openDeadline,
          turnNumber: 1,
          weather,
          megaActive: false,
          intimidatedAtkMult: myAtkMult,
        }
      })

      // Single combined prompt — both players independently `.move` whenever
      // ready; no sequential "ask P1 then P2" messaging (that would leak one
      // player's choice to the other before they've locked in — a real
      // balance issue in a sequential-ask design). See overhaul §3.2 step 1.
      return ctx.reply(
        `⚔️ *POKÉMON BATTLE ACCEPTED!* ⚔️\n\n` +
        `${challengerMon.shiny ? '✨ ' : ''}*${challengerMon.name}* (Lv.${challengerMon.level}) — ${challenger.name}\n` +
        `🆚\n` +
        `${myMon.shiny ? '✨ ' : ''}*${myMon.name}* (Lv.${myMon.level}) — ${player.name}\n\n` +
        (weatherLine ? `${weatherLine}\n` : ``) +
        (intimidateLines.length ? `${intimidateLines.join('\n')}\n` : ``) +
        `\n*Turn 1!* Both trainers, lock in your move:\n` +
        `*${pr}move* to see your options · *${pr}move <name or #>* to choose\n` +
        `_60 seconds — a silent trainer forfeits the match._\n` +
        `_Holding a mega stone? *${pr}p-battle megaevolve* works alongside your move, once per battle._`
      )
    }

    // ── DECLINE ─────────────────────────────────────────────────────────
    if (sub === 'decline') {
      if (!player.pokemonChallenge) return ctx.reply(`❌ You have no pending Pokémon battle challenge.`)
      const fromJid = player.pokemonChallenge.fromJid
      await updatePlayer(db, ctx.from, (p) => { p.pokemonChallenge = null })
      const fromName = playerExists(db, fromJid) ? getPlayer(db, fromJid).name : 'them'
      return ctx.reply(`🚫 You declined the Pokémon battle from *${fromName}*.`)
    }

    // ── FORFEIT ─────────────────────────────────────────────────────────
    if (sub === 'forfeit' || sub === 'flee') {
      if (!inPokeBattle(player)) return ctx.reply(`❌ You're not in a Pokémon battle.`)
      const opponentJid = player.pokemonBattleState.opponentJid
      return pokebattleConclude(db, opponentJid, ctx.from, ctx, `_${player.name}'s Pokémon forfeits!_`)
    }

    // ── MEGAEVOLVE (addendum §10.3) ────────────────────────────────────
    // Free action, doesn't consume the turn's move slot — usable any time
    // during your turn, before or alongside `.move`. Once per battle.
    // Requires the mega stone matching your active Pokémon's species to be
    // its currently-EQUIPPED held item (§11) — not a one-time inventory
    // consumable, per §10.3's explicit correction.
    if (sub === 'megaevolve' || sub === 'mega') {
      if (!inPokeBattle(player)) return ctx.reply(`❌ You're not in a Pokémon battle.`)
      if (player.pokemonBattleState.megaActive) {
        return ctx.reply(`❌ Your Pokémon has already Mega Evolved this battle.`)
      }
      const mon = getMainPokemon(player)
      if (!mon || !canMegaEvolve(mon)) {
        return ctx.reply(
          `❌ *${mon?.nickname ?? mon?.name ?? 'Your Pokémon'}* can't Mega Evolve — ` +
          `it needs to be holding its matching mega stone.\n` +
          `_Equip one with *${pr}p-poke hold <n> <item>*._`
        )
      }

      const form = getMatchingMegaForm(mon)
      let raceLost = false
      await updatePlayer(db, ctx.from, (p) => {
        if (!p.pokemonBattleState || p.pokemonBattleState.megaActive) { raceLost = true; return }
        p.pokemonBattleState.megaActive = true
      })
      if (raceLost) return ctx.reply(`❌ Your Pokémon has already Mega Evolved this battle.`)

      return ctx.reply(
        `✨ *${mon.nickname ?? mon.name}* Mega Evolved into *${form.megaName}*! ✨\n` +
        `_This lasts for the rest of the battle — lock in your move with *${pr}move* whenever you're ready._`
      )
    }

    // ── (legacy) ATTACK — turns are now selected via .move, not .p-battle attack ──
    if (sub === 'attack') {
      return ctx.reply(`❓ Battles now use moves — try *${pr}move* to see your options.`)
    }

    // ── CHALLENGE (default) ────────────────────────────────────────────
    if (inPokeBattle(player)) {
      return ctx.reply(`❌ You're already in a Pokémon battle. Use *${pr}move* or *${pr}p-battle forfeit*.`)
    }
    if (!getMainPokemon(player)) {
      return ctx.reply(`❌ Set a Main Pokémon first: *${pr}p-poke main <n>*.`)
    }
    const targetJid = resolveTargetJid(ctx, args[0])
    if (!targetJid) {
      return ctx.reply(`❓ Usage: *${pr}p-battle @target* — reply to or @mention who you want to battle.`)
    }
    if (targetJid === ctx.from) return ctx.reply(`❌ You can't battle yourself.`)
    if (!playerExists(db, targetJid)) return ctx.reply(`❌ That player isn't registered yet.`)

    const target = getPlayer(db, targetJid)
    if (!getMainPokemon(target)) {
      return ctx.reply(`❌ *${target.name}* doesn't have a Main Pokémon set yet.`)
    }
    if (inPokeBattle(target)) return ctx.reply(`⚔️ *${target.name}* is already in a Pokémon battle.`)
    if (target.pokemonChallenge && Date.now() < target.pokemonChallenge.expiresAt) {
      return ctx.reply(`⏳ *${target.name}* already has a pending Pokémon battle challenge.`)
    }

    await updatePlayer(db, targetJid, (t) => {
      t.pokemonChallenge = { fromJid: ctx.from, expiresAt: Date.now() + CHALLENGE_TIMEOUT_MS }
    })

    const myMon = getMainPokemon(player)
    const targetMon = getMainPokemon(target)
    return ctx.reply(
      `⚔️ *${player.name}*'s ${myMon.name} challenges *${target.name}*'s ${targetMon.name} to a battle!\n\n` +
      `*${target.name}*, use *${pr}p-battle accept* or *${pr}p-battle decline* within 2 minutes.`
    )
  },
}

// EV award on battle win — overhaul addendum §9.3. Flat amount to whichever
// stat the LOSER's highest base stat is, capped per-stat and in total.
const EV_YIELD_AMOUNT    = 1
const EV_YIELD_CAP_STAT  = 252
const EV_YIELD_CAP_TOTAL = 510

/** Which of the loser's 6 base stats is highest — that's the EV the winner earns. */
function highestBaseStatKey(mon) {
  const stats = {
    hp:    mon.baseHp   ?? 0,
    atk:   mon.baseAtk  ?? 0,
    def:   mon.baseDef  ?? 0,
    spAtk: mon.baseSpAtk ?? 0,
    spDef: mon.baseSpDef ?? 0,
    spd:   mon.baseSpd  ?? 0,
  }
  let bestKey = 'hp', bestVal = -Infinity
  for (const [key, val] of Object.entries(stats)) {
    if (val > bestVal) { bestVal = val; bestKey = key }
  }
  return bestKey
}

/**
 * awardEv — mutates winnerMon.evs in place: +1 EV in the stat matching
 * loserMon's highest base stat, respecting the 252-per-stat / 510-total
 * ceiling (classic Pokémon EV-yield-by-opponent-species behavior, kept
 * simple per addendum §9.3 — flat 1, not the real games' variable yield).
 * No-op once either cap is already hit.
 */
function awardEv(winnerMon, loserMon) {
  if (!winnerMon || !loserMon) return
  winnerMon.evs = winnerMon.evs ?? { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0 }

  const total = Object.values(winnerMon.evs).reduce((sum, v) => sum + (v ?? 0), 0)
  if (total >= EV_YIELD_CAP_TOTAL) return

  const key = highestBaseStatKey(loserMon)
  const current = winnerMon.evs[key] ?? 0
  if (current >= EV_YIELD_CAP_STAT) return

  winnerMon.evs[key] = current + EV_YIELD_AMOUNT
}

/**
 * pokebattleConclude — the only win/loss handler. Awards WIN_SOLARS to the
 * winner, records wins/losses, restores both Pokémon to full HP (so a loss
 * doesn't leave a Pokémon crippled without a trip through .p-poke heal),
 * clears both battle states, and awards the winner's mon 1 EV per addendum
 * §9.3 (scaled by the loser's highest base stat, capped). Also clears any
 * leftover activeEffects on the way out — a burn/weaken shouldn't survive
 * past the fight that caused it.
 */
export async function pokebattleConclude(db, winnerJid, loserJid, ctx, reasonLine) {
  let winnerName = '', loserName = ''
  let loserMonSnapshot = null

  await updatePlayer(db, loserJid, (loser) => {
    loserName = loser.name
    ensureRecord(loser).losses++
    const mon = getMainPokemon(loser)
    if (mon) {
      mon.currentHp = mon.maxHp
      mon.activeEffects = []
      // Captured for the winner's EV award below — read-only, base stats
      // aren't mutated by this call, so a plain reference snapshot is fine.
      loserMonSnapshot = mon
    }
    loser.inPokemonBattle = false
    loser.pokemonBattleState = null
  })

  let winnerLeveledUp = false
  await updatePlayer(db, winnerJid, (winner) => {
    winnerName = winner.name
    ensureRecord(winner).wins++
    winner.wallet = winner.wallet ?? {}
    winner.wallet.solars = (winner.wallet.solars ?? 0) + WIN_SOLARS
    recordQuestEvent(winner, 'poke_win', 1)
    const mon = getMainPokemon(winner)
    if (mon) {
      mon.currentHp = mon.maxHp
      mon.activeEffects = []
      const levelBefore = mon.level
      awardEv(mon, loserMonSnapshot)
      // awardEv() only touches evs today (no battle-XP/level system exists
      // yet — feed/train remain the only ways a Pokémon levels up), so this
      // will always be false right now. Kept as a real comparison rather
      // than a hardcoded `false` so this wiring activates automatically the
      // moment battle XP/leveling lands, with no pokebattle.js changes
      // needed then.
      if (mon.level !== levelBefore) winnerLeveledUp = true
    }
    winner.inPokemonBattle = false
    winner.pokemonBattleState = null
  })

  // Post-battle evolution check — overhaul addendum §8.2: "if a Pokémon
  // would hit its evolution level via a battle-XP gain, queue the evolution
  // check to run right after pokebattleConclude(), applied outside the
  // battle, not mid-turn." Mirrors plugins/pokemon.js's feed/train pattern:
  // only fetch (PokéAPI evolution-chain call) when a level-up actually
  // happened, and run it in its own updatePlayer AFTER the win write above
  // has already landed, since it needs its own await and shouldn't hold
  // that write's lock open any longer than necessary.
  let winnerEvolution = null
  if (winnerLeveledUp) {
    await updatePlayer(db, winnerJid, async (winner) => {
      const freshMon = getMainPokemon(winner)
      if (!freshMon) return winner
      winnerEvolution = await runLevelUpEvolutionCheck(freshMon)
      return winner
    })
  }
  const winnerEvoLine = winnerEvolution
    ? `\n\n🎉 *${winnerEvolution.oldName}* is evolving! ✨\nCongratulations! *${winnerEvolution.oldName}* evolved into *${winnerEvolution.newName}*!`
    : ''

  return ctx.reply(
    `🏆 *BATTLE OVER!*\n\n` +
    reasonLine + `\n\n` +
    `👑 *${winnerName}* defeats *${loserName}*!\n` +
    `💰 *+${WIN_SOLARS} Solars* awarded.\n\n` +
    `❤️ Both Pokémon are fully healed.` +
    winnerEvoLine
  )
}

/**
 * resolvePokeBattleTurn — resolves a turn once BOTH players have a
 * pendingMove set. Replaces the old runPokeBattleTurn()'s single-attacker
 * body with the full simultaneous-turn resolution from overhaul §3.3.
 *
 * IMPORTANT: every updatePlayer() call here is sequential/top-level, never
 * nested inside another updatePlayer()'s mutator — same discipline the
 * original file documented at length (lib/player-repo.js runs every
 * updatePlayer/updateAllPlayers call through one shared write queue; a
 * nested call deadlocks against the outer call's own await). Read/validate/
 * mutate each player with its own separate top-level updatePlayer() call,
 * and do the image render only after every write has already completed and
 * released the queue.
 *
 * ctx here is whichever player's `.move` command triggered resolution (the
 * second of the two to lock in) — replies go to that same chat/context,
 * matching how the original file always replied via the acting player's ctx.
 */
export async function resolvePokeBattleTurn(db, ctx, jidA, jidB) {
  // ── Step 1: read both players' battle state + main Pokémon + move ───────
  // Immediately clears pendingMove back to null as part of the SAME
  // updatePlayer call that reads it (atomic claim-and-consume) — if two
  // `.move` calls somehow both believed the opponent was ready and both
  // called this function concurrently, the second one to run this step
  // sees pendingMove already null and bails via the missing-move check
  // below instead of resolving the same turn twice.
  let a = null, b = null
  await updatePlayer(db, jidA, (p) => {
    if (!p.pokemonBattleState) return
    a = { player: p, mon: getMainPokemon(p), state: { ...p.pokemonBattleState } }
    p.pokemonBattleState.pendingMove = null
  })
  await updatePlayer(db, jidB, (p) => {
    if (!p.pokemonBattleState) return
    b = { player: p, mon: getMainPokemon(p), state: { ...p.pokemonBattleState } }
    p.pokemonBattleState.pendingMove = null
  })

  if (!a?.mon || !b?.mon || !a.state || !b.state) {
    // One side's Pokémon or battle state vanished mid-flight — bail cleanly.
    await updatePlayer(db, jidA, (p) => { p.inPokemonBattle = false; p.pokemonBattleState = null })
    await updatePlayer(db, jidB, (p) => { p.inPokemonBattle = false; p.pokemonBattleState = null })
    return ctx.reply(`❌ A battle state error occurred — the match was cancelled.`)
  }

  const moveA = getMoveById(a.state.pendingMove)
  const moveB = getMoveById(b.state.pendingMove)
  if (!moveA || !moveB) {
    // Most likely: this turn was already resolved by a concurrent call (see
    // the atomic claim-and-consume note above) — not a real error, just a
    // race that the guard caught. Silently no-op rather than double-reply.
    return
  }

  // ── Step 2: determine order — higher spd first, tie → challenger-first ──
  // "Challenger" here is whichever side's opponentJid points at the other —
  // both states carry opponentJid, so a is the challenger iff a's
  // opponentJid resolves to jidB AND a was the one who originally sent the
  // challenge. Simpler equivalent (and unchanged from the old tie-break
  // convention): jidA acted as "first" in the accept() call ordering, so on
  // a tie jidA goes first.
  const statsA = statsOf(a.mon, a.state)
  const statsB = statsOf(b.mon, b.state)
  const aFirst = statsA.spd !== statsB.spd ? statsA.spd > statsB.spd : true

  const order = aFirst
    ? [{ jid: jidA, side: a, stats: statsA, move: moveA, oppJid: jidB, opp: b, oppStats: statsB, oppMove: moveB },
       { jid: jidB, side: b, stats: statsB, move: moveB, oppJid: jidA, opp: a, oppStats: statsA, oppMove: moveA }]
    : [{ jid: jidB, side: b, stats: statsB, move: moveB, oppJid: jidA, opp: a, oppStats: statsA, oppMove: moveA },
       { jid: jidA, side: a, stats: statsA, move: moveA, oppJid: jidB, opp: b, oppStats: statsB, oppMove: moveB }]

  // Working HP pool, keyed by jid — mutated as we go, written back at the end.
  const hp = { [jidA]: a.state.hp, [jidB]: b.state.hp }
  const maxHp = { [jidA]: a.state.maxHp, [jidB]: b.state.maxHp }
  // Working activeEffects, keyed by jid — same pattern: mutate a plain
  // object shaped like what lib/effects.js expects, write back at the end.
  const fx = {
    [jidA]: { name: a.mon.nickname ?? a.mon.name, hp: hp[jidA], maxHp: maxHp[jidA], activeEffects: a.mon.activeEffects ?? [] },
    [jidB]: { name: b.mon.nickname ?? b.mon.name, hp: hp[jidB], maxHp: maxHp[jidB], activeEffects: b.mon.activeEffects ?? [] },
  }

  const log = []
  let defeatedJid = null
  // Tracks the most recent hit/miss so the render's impact-burst/miss-stamp
  // still fires on something meaningful for a multi-action turn — the
  // render file's `state.lastAction` contract only supports one actor/kind
  // per frame (§3.4: render mechanics stay as-is, only the content passed
  // in changes), so this picks the LAST action of the turn as representative.
  let finalAction = null

  for (const attacker of order) {
    if (defeatedJid) break // second attacker's action is skipped if the first already KO'd them
    if (hp[attacker.jid] <= 0) continue

    const atkMon  = attacker.side.mon
    const defMon  = attacker.opp.mon
    const defJid  = attacker.oppJid
    const move    = attacker.move
    const missed  = move.accuracy != null && Math.random() * 100 >= move.accuracy
    // render's contract (lib/pokemon-battle-render.mjs): lastAction.actor is
    // the ATTACKER's side; the render computes the defender's position from
    // it internally (impact burst / miss stamp draw on the opposite side).
    // "left" = jidA's side, "right" = jidB's side, matching the left/right
    // state shape sendPokemonBattleTurnReply's caller builds below.
    const attackerSide = attacker.jid === jidA ? 'left' : 'right'

    if (missed) {
      log.push(`💨 *${atkMon.name}*'s ${move.name} missed!`)
      finalAction = { actor: attackerSide, kind: 'miss', damage: null }
      continue
    }

    // Mega Evolution overlay (addendum §10) — real types/ability normally,
    // or the mega form's if this side Mega Evolved this battle. Threaded
    // through damageFor()/applyMoveEffect() so STAB, type-effectiveness,
    // and ability lookups all reflect the mega'd form for the rest of the
    // fight, per §10.3.
    const atkView = effectiveMonView(atkMon, attacker.side.state)
    const defView = effectiveMonView(defMon, attacker.opp.state)
    const displayAtkName = atkView.displayName
    const displayDefName = defView.displayName

    log.push(`${move.category === 'status' ? '✨' : '⚔️'} *${displayAtkName}* used *${move.name}*!`)

    // Choice Band/Specs lock-in (addendum §11.1/§11.2) — the FIRST move used
    // while holding a choice item locks the holder into it for the rest of
    // the battle. Set here (on actual use, not on selection) regardless of
    // whether the move deals damage — status moves lock too, same as the
    // real item. A no-op if not holding a choice item or already locked.
    const lockLine = applyChoiceLockOnMoveUse(attacker.side, move.id)
    if (lockLine) log.push(lockLine)

    if (move.category !== 'status' && move.power) {
      let { dmg, eff, crit, absorb, absorbHealFraction } = damageFor(
        move, atkMon, attacker.stats, defMon, attacker.oppStats,
        {
          attackerView: atkView,
          defenderView: defView,
          weather: attacker.side.state.weather,
          attackerAtkMult: attacker.side.state.intimidatedAtkMult ?? 1,
        }
      )

      // Water Absorb / Volt Absorb / Flash Fire (addendum §12) — the hit is
      // fully absorbed instead of just doing 0 damage: the defender heals a
      // fraction of its max HP (Flash Fire's real payoff is a passive
      // fire-boost rather than healing, so its healFraction is 0 — see
      // lib/pokemon-abilities.js's header note on that simplification).
      if (absorb) {
        log.push(`🌀 *${displayDefName}*'s ability absorbed the hit!`)
        if (absorbHealFraction > 0) {
          const healAmount = Math.max(1, Math.floor(defMon.maxHp * absorbHealFraction))
          hp[defJid] = Math.min(maxHp[defJid], hp[defJid] + healAmount)
          fx[defJid].hp = hp[defJid]
          log.push(`💚 *${displayDefName}* restored ${healAmount} HP!`)
        }
        finalAction = { actor: attackerSide, kind: 'miss', damage: null }
        continue
      }

      // Sturdy (addendum §12) — ability-based version of Focus Sash, checked
      // first since a Pokémon can't realistically have both trigger the same
      // hit; Focus Sash still applies afterward for anyone Sturdy didn't
      // already save (different holders, same turn, different sides).
      const sturdyCheck = checkSturdy(attacker.opp.state, defMon, dmg, defView.ability)
      dmg = sturdyCheck.adjustedDamage
      if (sturdyCheck.line) log.push(sturdyCheck.line)

      // Focus Sash (addendum §11.1/§11.2) — clamp lethal damage against a
      // full-HP holder down to "leaves exactly 1 HP" instead, consuming the
      // sash. Checked BEFORE the damage is actually applied to hp[], since
      // it changes what "dmg" itself should be.
      const sashCheck = checkFocusSash(defMon, dmg)
      dmg = sashCheck.adjustedDamage
      if (sashCheck.line) log.push(sashCheck.line)

      hp[defJid] = Math.max(0, hp[defJid] - dmg)
      fx[defJid].hp = hp[defJid]

      const effText = effectivenessText(eff)
      log.push(
        `${crit ? '💥 *Critical hit!* ' : ''}${effText ? effText + ' ' : ''}` +
        `*${displayDefName}* took *${dmg}* damage.`
      )
      finalAction = { actor: attackerSide, kind: crit ? 'crit' : 'hit', damage: dmg }

      // Resist berry (addendum §11.1/§11.2) — auto-heals the defender once
      // if this hit was super-effective, consuming the berry. Checked AFTER
      // damage is applied (it heals off the post-hit HP), using the same
      // `eff` multiplier the effectiveness text above was built from.
      const berryLine = applyResistBerry(defMon, eff)
      if (berryLine) {
        log.push(berryLine)
        hp[defJid] = defMon.currentHp
        fx[defJid].hp = hp[defJid]
      }

      // Static/Poison Point/Flame Body/Rough Skin (addendum §12) — the
      // DEFENDER's on-hit-taken ability procs against the ATTACKER, after
      // damage lands. Two separate small checks (status roll vs flat
      // recoil), same "each its own function" discipline as the held-item
      // step below.
      const abilityStatusLine = rollOnHitTakenAbility(defMon, atkMon, defView.ability)
      if (abilityStatusLine) log.push(abilityStatusLine)
      const roughSkinLine = roughSkinRecoil(defMon, atkMon, dmg, defView.ability)
      if (roughSkinLine) {
        log.push(roughSkinLine)
        hp[attacker.jid] = atkMon.currentHp
        fx[attacker.jid].hp = hp[attacker.jid]
      }

      // Life Orb recoil (addendum §11.1/§11.2) — applies to the ATTACKER
      // after it lands a damaging hit, independent of the Focus Sash/berry
      // steps above which both concern the defender.
      const recoilLine = applyLifeOrbRecoil(atkMon, dmg)
      if (recoilLine) {
        log.push(recoilLine)
        hp[attacker.jid] = atkMon.currentHp
        fx[attacker.jid].hp = hp[attacker.jid]
      }

      if (hp[defJid] <= 0) {
        log.push(`💀 *${displayDefName}* fainted!`)
        defeatedJid = defJid
      }
      // Life Orb recoil / Rough Skin can themselves faint the attacker
      // (real-games behavior: recoil can KO you) — check that side too, but
      // only if the defender didn't already decide the outcome above.
      if (!defeatedJid && hp[attacker.jid] <= 0) {
        log.push(`💀 *${displayAtkName}* fainted from the recoil!`)
        defeatedJid = attacker.jid
      }
    }

    // Move effect (burn/poison/freeze/stun/weaken/strengthen) applies
    // regardless of whether the move also dealt damage — status moves have
    // 0 power and rely entirely on this step. Blocked entirely by a
    // status-immune ability (addendum §12) rather than applied-then-cured.
    const effLine = applyMoveEffect(move, fx[defJid], defMon, defView.ability)
    if (effLine) log.push(effLine)
  }

  // ── Step 3: if either side fainted, conclude immediately ────────────────
  if (defeatedJid) {
    const winnerJid = defeatedJid === jidA ? jidB : jidA
    // Persist working HP/effects back before concluding so pokebattleConclude's
    // full-heal starts from an accurate (if moot) state.
    await updatePlayer(db, jidA, (p) => {
      const mon = getMainPokemon(p)
      if (mon) { mon.currentHp = Math.max(0, hp[jidA]); mon.activeEffects = fx[jidA].activeEffects }
    })
    await updatePlayer(db, jidB, (p) => {
      const mon = getMainPokemon(p)
      if (mon) { mon.currentHp = Math.max(0, hp[jidB]); mon.activeEffects = fx[jidB].activeEffects }
    })
    return pokebattleConclude(db, winnerJid, defeatedJid, ctx, log.join('\n'))
  }

  // ── Step 4: tick active status effects (burn/poison DoT, durations) ─────
  const monByJid = { [jidA]: a.mon, [jidB]: b.mon }
  for (const jid of [jidA, jidB]) {
    const before = fx[jid].hp
    const lines = tickEffects(fx[jid])
    if (lines.length) {
      hp[jid] = Math.max(0, fx[jid].hp)
      log.push(...lines.map(l => `${fx[jid].name}: ${l}`))
      if (hp[jid] <= 0 && !defeatedJid) {
        log.push(`💀 *${fx[jid].name}* fainted!`)
        defeatedJid = jid
      }
    }
  }

  // ── Step 4b: end-of-turn held items (Leftovers — addendum §11.1/§11.2) ──
  // Deliberately its own small step, separate from the status-tick loop
  // above (which is effects.js-driven) and from the ability step below —
  // per the addendum's explicit instruction to keep held-item effects and
  // ability effects as two separate small functions. Only runs for sides
  // that didn't already faint from the status tick above.
  for (const jid of [jidA, jidB]) {
    if (defeatedJid) break
    if (hp[jid] <= 0) continue
    const heldLine = applyEndOfTurnHeldItems(fx[jid], monByJid[jid])
    if (heldLine) {
      hp[jid] = fx[jid].hp
      log.push(heldLine)
    }
  }

  // ── Step 4c: end-of-turn weather chip damage (addendum §13.2) ───────────
  // Same status-tick step burn/poison DoT already runs in, per §13.2's
  // explicit instruction. Sandstorm/hail chip is skipped for
  // Magic-Guard-equivalent Pokémon (addendum §12's "no-indirect-damage"
  // ability) — see lib/pokemon-abilities.js's header note on that being
  // scoped to only the damage sources this overhaul's own files control.
  const sideStates = { [jidA]: a.state, [jidB]: b.state }
  for (const jid of [jidA, jidB]) {
    if (defeatedJid) break
    if (hp[jid] <= 0) continue
    const mon = monByJid[jid]
    const view = effectiveMonView(mon, sideStates[jid])
    if (hasMagicGuard(mon, view.ability)) continue
    const chip = weatherChipDamage(sideStates[jid]?.weather, view.types, maxHp[jid])
    if (chip > 0) {
      hp[jid] = Math.max(0, hp[jid] - chip)
      fx[jid].hp = hp[jid]
      const weatherNoun = sideStates[jid].weather === 'sandstorm' ? 'the sandstorm' : 'the hail'
      log.push(`🌫️ *${fx[jid].name}* is buffeted by ${weatherNoun}! (-${chip} HP)`)
      if (hp[jid] <= 0) {
        log.push(`💀 *${fx[jid].name}* fainted!`)
        defeatedJid = jid
      }
    }
  }

  if (defeatedJid) {
    const winnerJid = defeatedJid === jidA ? jidB : jidA
    await updatePlayer(db, jidA, (p) => {
      const mon = getMainPokemon(p)
      if (mon) { mon.currentHp = Math.max(0, hp[jidA]); mon.activeEffects = fx[jidA].activeEffects }
    })
    await updatePlayer(db, jidB, (p) => {
      const mon = getMainPokemon(p)
      if (mon) { mon.currentHp = Math.max(0, hp[jidB]); mon.activeEffects = fx[jidB].activeEffects }
    })
    return pokebattleConclude(db, winnerJid, defeatedJid, ctx, log.join('\n'))
  }

  // ── Step 5: neither fainted — reset for the next turn ────────────────────
  const nextDeadline = Date.now() + TURN_TIMEOUT_MS
  let turnNumberNow = 1
  await updatePlayer(db, jidA, (p) => {
    const mon = getMainPokemon(p)
    if (mon) { mon.currentHp = Math.max(0, hp[jidA]); mon.activeEffects = fx[jidA].activeEffects }
    p.pokemonBattleState.hp = Math.max(0, hp[jidA])
    p.pokemonBattleState.pendingMove = null
    p.pokemonBattleState.turnDeadline = nextDeadline
    p.pokemonBattleState.turnNumber = (p.pokemonBattleState.turnNumber ?? 1) + 1
    // Persist a Choice item lock set THIS turn (§11.1/§11.2) — a.state was
    // only an in-memory copy of pokemonBattleState from step 1, so a lock
    // mutated onto it during the attack loop needs writing back here.
    if (a.state.choiceLockedMove && !p.pokemonBattleState.choiceLockedMove) {
      p.pokemonBattleState.choiceLockedMove = a.state.choiceLockedMove
    }
    turnNumberNow = p.pokemonBattleState.turnNumber
  })
  await updatePlayer(db, jidB, (p) => {
    const mon = getMainPokemon(p)
    if (mon) { mon.currentHp = Math.max(0, hp[jidB]); mon.activeEffects = fx[jidB].activeEffects }
    p.pokemonBattleState.hp = Math.max(0, hp[jidB])
    p.pokemonBattleState.pendingMove = null
    p.pokemonBattleState.turnDeadline = nextDeadline
    p.pokemonBattleState.turnNumber = (p.pokemonBattleState.turnNumber ?? 1) + 1
    if (b.state.choiceLockedMove && !p.pokemonBattleState.choiceLockedMove) {
      p.pokemonBattleState.choiceLockedMove = b.state.choiceLockedMove
    }
  })

  log.push(`\n*Turn ${turnNumberNow}!* Both trainers, lock in your next move.`)

  // ── Step 6: render + send — OUTSIDE any write lock, so rendering never
  // blocks the shared db write queue for other players. ────────────────────
  return sendPokemonBattleTurnReply(ctx, {
    left:  { name: a.mon.nickname ?? a.mon.name, image: a.mon.image, hp: hp[jidA], maxHp: maxHp[jidA], level: a.mon.level },
    right: { name: b.mon.nickname ?? b.mon.name, image: b.mon.image, hp: hp[jidB], maxHp: maxHp[jidB], level: b.mon.level },
    msg: log.join('\n'),
    lastAction: finalAction, // last hit/crit/miss of the turn — the render's impact burst/miss stamp fires on it; the full multi-line log carries every action's detail
  })
}

/**
 * handlePokeBattleTimeout — called by main.js's timeout sweep (§3.2 step 4)
 * for a player whose turnDeadline has passed with pendingMove still null.
 * Routes through pokebattleConclude exactly like an explicit forfeit.
 * Exported so main.js doesn't need to duplicate this file's battle-state
 * shape knowledge.
 */
export async function handlePokeBattleTimeout(db, ctx, timedOutJid, opponentJid, timedOutName) {
  return pokebattleConclude(db, opponentJid, timedOutJid, ctx, `_${timedOutName}'s Pokémon didn't move in time and forfeits!_`)
}
