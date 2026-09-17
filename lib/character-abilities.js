/**
 * lib/character-abilities.js — wires the three Season 1 characters' unique
 * abilities (Season System Spec §13) into real combat. Structurally mirrors
 * lib/named-passives.js: one lookup table (characterId -> handler), a
 * single dispatch function, the same event constants as NP_EVENT (so this
 * can piggyback on the exact call sites attack.js/pvp.js already invoke
 * applyAllNamedPassives from), and a plain result object
 * ({ modified, lines, ...overrides }) the caller folds into the turn.
 *
 * Characters are equipped one-at-a-time via player.equippedCharacter (see
 * plugins/character.js) — unlike named items, so dispatch here only ever
 * resolves at most one handler per event, never several.
 *
 * ── Mei — "Final Form" (spec §13.1) ─────────────────────────────────────
 * Automatically activates when the equipped-Mei player drops below 70% HP.
 * This file owns the activation math; combat turn handlers call
 * activateFinalForm() at their status-tick checkpoint. Resolved open
 * questions (see data/characters.json's mei entry description + inline
 * notes below for the exact values chosen):
 *   #26 defense increase — +100% DEF, deliberately half of the +200% ATK
 *       (keeps Final Form damage-forward without being unkillable).
 *   #27 duration — lasts the rest of the battle (simplest, matches the
 *       "prayer becomes transformation" framing — this is not a short
 *       buff, it is described as a state change).
 *   #28 cooldown — once-per-battle. battleState is discarded at fight end
 *       so this naturally resets every fight with zero extra bookkeeping;
 *       re-triggering every time HP dips under 70% within ONE battle would
 *       let a player bounce in and out of a permanent +200%/+100% state
 *       via repeated healing, which the spec's "surge with defensive
 *       power" framing (a single decisive turn, not a sustained loop)
 *       argues against.
 *
 * PvP REBALANCE (2026-08): Final Form originally granted +300% ATK /
 * +150% DEF on a 35%-of-maxHp heal, and applyMeiSustainHeal() below had NO
 * per-battle cap at all — every lethal hit was nullified and the bearer was
 * restored to 50% of max HP, forever. Since PvP has no turn limit and no
 * draw condition, that made a Mei player literally unkillable rather than
 * merely tanky: the opponent could not win, and the fight could not end.
 * The sustain is now a counted resource (MEI_SUSTAIN_MAX_PER_BATTLE) with a
 * diminishing revive, and the Final Form numbers are trimmed. All five
 * values live in the tuning block below — that is the only place to touch
 * them if she needs a further pass.
 *
 * ── Urahara — "Tear / Reshape" (spec §13.2) ─────────────────────────────
 * Passive: every player hit that lands on the enemy also applies the
 * 'sever' status effect (lib/effects.js) — the in-battle 20%-of-maxHp/tick
 * bleed, exactly the flat-effect shape effects.js expects, so PvE Urahara
 * needs zero special-casing beyond "make sure sever gets applied on hit."
 * Outside-of-battle / PvP-permanent ticking is NOT effects.js-driven (see
 * effects.js's file-level doc comment on 'sever') — it lives in
 * player.permanentSever, ticked action-triggered (spec: "fires on the
 * player's next action... no real-time/background timer") via
 * tickPermanentSever(), called once per action from attack.js/pvp.js/
 * dungeon.js's entry point. Resolved open questions:
 *   #29 Elixir — new season-exclusive consumable, already authored as
 *       data/season-01-content.json's severing_elixir with
 *       { type: 'cure', targets: ['tear'] }.
 *   #30 PvE application — yes, in-battle only, normal cleanse rules (the
 *       activeEffects 'sever' entry above); the PERMANENT form is PvP-only,
 *       matching the spec's "in PvP specifically" framing for the
 *       permanent case.
 *   #31 stacking — single-instance. A second permanent-sever application
 *       refreshes/keeps the existing debuff rather than stacking multiple
 *       simultaneous ticks — a player carrying two independent 0.5%/action
 *       drains with no cap would be a slow, silent death spiral with no
 *       comeback, which nothing else in this bleed-focused kit is designed
 *       to support.
 *
 * ── Willow — "Battle Advisor" (spec §13.3) ──────────────────────────────
 * Purely informational and delivered as a separate DM after PvP and boss
 * turns. The command was removed; the readout and delivery live here so all
 * combat entry points use the same behavior.
 */
import { addStatusEffect, hasEffect, getEffectiveStat, resolveVoidRebound } from './effects.js'
import { characterMap, skills as allSkills } from './game-data.js'
import { buildMoveOptions, moveCategories } from './effectiveness-engine.js'
import { getEquippedSkills } from './skill-slots.js'
import { sendImageTo, sendLocalVideoTo } from './image.js'
import { getPrimaryStat, calcPlayerDamage, applyDefense } from './combat-engine.js'
import { applyRebornDefense } from './reborn-engine.js'
import { fraktur } from './format.js'
// Yoriichi's "Cat Form Awakening" lives in its own module (see the ── Yoriichi ──
// marker further down for why). applyIncomingDamage() below needs three of her
// helpers to route damage into her pool, hence the import; the export block
// re-publishes the whole set so every module that already imports her helpers
// from this file keeps working unchanged.
//
// This is a deliberate import cycle — lib/yoriichi.js imports
// applyIncomingDamage() back out of this file. It resolves because every use on
// both sides is inside a function body, never at module-evaluation time.
import {
  isCatFormActive,
  resolveCatFormDamage,
  buildCatFormDefeatMessage,
} from './yoriichi.js'
export {
  yoriichiCatFormMaxHp,
  catFormDefense,
  grantYoriichiExp,
  checkYoriichiCatForm,
  sendYoriichiCatFormSequence,
  isCatFormActive,
  catFormPool,
  resolveCatFormDamage,
  catFormAttackDamage,
  healCatFormPool,
  resolveCatFormAction,
  buildCatFormDefeatMessage,
  isOpponentLive,
  clearYoriichiCatForm,
} from './yoriichi.js'

// Megumi Fushiguro's Ten Shadows / Chimera Shadow Garden / Mahoraga live in
// their own module (same split precedent as yoriichi.js). No import cycle:
// lib/megumi.js depends only on effects.js/combat-engine.js/image.js. The
// re-export keeps every combat file importing Megumi's helpers from this
// same module as every other character's.
export {
  hasMegumi,
  hasMahoraga,
  isChimeraDomainActive,
  megumiTurnStart,
  activateChimeraDomain,
  chimeraBurstDamage,
  rollShadowDodge,
  moveKeyFor,
  recordMahoragaExposure,
  resolveMegumiIncoming,
  sendDomainImage,
  sendWheelSpin,
  sendMegumiImage,
  sendMahoragaImage,
  MEGUMI_IMAGE,
  DOMAIN_IMAGE,
  MAHORAGA_IMAGE,
  WHEEL_GIF,
} from './megumi.js'

// Gogeta's Fusion of Equals / Instant Transmission / Soul Punisher / Big Bang
// Kamehameha live in lib/gogeta.js (same split precedent as megumi.js). No
// import cycle: that module depends only on effects.js and image.js.
// applyIncomingDamage() below needs the dodge roll, hence the plain import as
// well as the re-export.
import { rollInstantTransmission } from './gogeta.js'
export {
  GOGETA_CHARACTER_ID,
  GOGETA_IMAGE,
  KAMEHAMEHA_IMAGE,
  hasGogeta,
  armFusion,
  tickFusion,
  fusionTurnsLeft,
  isFusionActive,
  rollInstantTransmission,
  rollInstantTransmissionOpener,
  instantTransmissionChance,
  activateSoulPunisher,
  activateBigBangKamehameha,
  gogetaCooldowns,
  FUSION_TURNS,
  SOUL_PUNISHER_ID,
  SOUL_PUNISHER_MULT,
  SOUL_PUNISHER_COOLDOWN,
  BIG_BANG_KAMEHAMEHA_ID,
  BIG_BANG_KAMEHAMEHA_MULT,
  BIG_BANG_KAMEHAMEHA_COOLDOWN,
  sendKamehamehaImage,
  sendGogetaImage,
} from './gogeta.js'

export const CHAR_EVENT = {
  FIGHT_INIT: 'fight_init',
  TURN_START: 'turn_start',
  PLAYER_HIT: 'player_hit',
  TURN_END:   'turn_end',
}

/* ── the nuke gate: once per battle ───────────────────────────────────────── */
//
// Every once-per-battle ultimate in this file uses the same latch: a
// `bs.<name>Used` boolean on battleState, which resets for free when the fight
// ends. One fight is one fight, in PvE, PvP and party alike.
//
// `key` is the bs flag's base name, so key 'hollowPurple' is bs.hollowPurpleUsed.

/** Is this ultimate already spent this battle? */
function ultimateGate(player, bs, key, moveName, battleMessage = null) {
  if (!bs?.[`${key}Used`]) return { blocked: false }
  return {
    blocked: true,
    message: battleMessage ?? `⚠️ *${moveName}* has already been used this battle.`,
  }
}

/** Burn the charge on the battle ledger. */
function burnUltimate(player, bs, key) {
  if (bs) bs[`${key}Used`] = true
}

const IN_BATTLE_SEVER_PCT = 0.20   // spec §13.2 — 20% of max HP per tick, in battle
const OUT_OF_BATTLE_SEVER_PCT = 0.005 // spec §13.2 — 0.5% of max HP per tick, outside battle
const SEVER_TICK_DURATION = 999    // effectively "until cured" for the in-battle activeEffects entry;
                                    // real removal is via the 'cure' targets:['sever'] item only

// Mei tuning — see the ── Mei ── block below for the full writeup, and the
// "PvP REBALANCE" note in this file's top doc comment for why these exist as
// named constants rather than the inline literals they used to be.
const MEI_SUSTAIN_MAX_PER_BATTLE = 2        // death-saves per battle (was uncapped)
const MEI_SUSTAIN_REVIVE_PCT = [0.45, 0.20] // ...and the share of maxHp each successive save restores
const FINAL_FORM_HEAL_PCT = 0.25            // Final Form's on-activation heal, as a share of maxHp
const FINAL_FORM_ATK_MULT = 2.0             // +200% ATK (strengthen delta = base str x this)
const FINAL_FORM_DEF_MULT = 1.0             // +100% DEF — kept at half the ATK buff (open question #26)

// Twin Bond (Tyla & Alya) tuning — see the block below for the full writeup.
const CLONE_TANK_HP_THRESHOLD_PCT = 0.10 // Tyla: any hit >10% of current HP is fully tanked
const CLONE_TANK_MAX_PER_BATTLE = 3      // Tyla: at most 3 clone-tanks per battle — see applyCloneTank()
const STAT_BREAK_EVERY_N_TURNS = 3       // Alya: fires every 3rd turn
const STAT_BREAK_DURATION = 6            // ...for 6 turns
const DANCE_OF_THE_RAIN_AT_TURN = 10     // Twin combo: automatic once battle reaches turn 10
const DANCE_OF_THE_RAIN_MULT = 4.6       // legendary-tier — above Mei's Final Form (2.0x) and
                                          // above the mythic skill-pack ceiling (~4.3x, see
                                          // data/skill-tiers.json's "mythic" tier note), since this
                                          // is the flagship automatic finisher of a legendary character
// The stat pool Alya's random pick draws from — restricted per-target to
// whichever of these the target actually carries a nonzero value for (see
// pickRandomNonZeroStat below), so it never wastes a pick on a stat a
// dungeon monster doesn't have (monsters only carry atk/def — see
// data/monsters.json's baseStats — while PvP opponents are full players
// with all five). 'atk' is included alongside 'str' because monster
// objects use the flat field name 'atk' where players use 'str' as their
// primary offensive stat; weaken() targets whichever key is actually
// present on the entity, exactly as getEffectiveStat() already resolves it.
const STAT_BREAK_POOL = ['str', 'atk', 'agi', 'int', 'def', 'lck']

function _noop() {
  return { modified: false, lines: [] }
}

/** The equipped character's def (data/characters.json), or null. */
export function getEquippedCharacter(player) {
  const id = player.equippedCharacter
  return id ? (characterMap[id] ?? null) : null
}

// ── Mei ──────────────────────────────────────────────────────────────────

/**
 * activateFinalForm(player) -> { ok, message }
 * Called by a combat turn handler. Heals the player, applies +200% ATK and
 * +100% DEF for the rest of the battle via the existing 'strengthen'
 * effect (lib/effects.js) — no parallel buff system needed, this is
 * exactly what strengthen already does (a lazily-read stat delta via
 * getEffectiveStat()). Marks finalFormUsed so it cannot retrigger this
 * battle (spec open question #28, resolved above). Every number here comes
 * from the FINAL_FORM_* tuning constants at the top of the file.
 */
export function activateFinalForm(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (player.equippedCharacter !== 'mei') {
    return { ok: false, message: `❌ You need Mei equipped to use *.finalform*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  // Final Form has no PvP turn-engine handoff, so it must never resolve against
  // a duel's battleState (type 'pvp', no enemy on it). plugins/finalform.js
  // already refuses type==='pvp' up front; this backstops any other caller,
  // the way activateLiveBlast() carries its own duel guard.
  if (bs.type === 'pvp') {
    return { ok: false, message: `🌀 *Final Form doesn't reach a duel.* Save it for dungeon runs and boss fights.` }
  }
  if (bs.finalFormUsed) {
    return { ok: false, message: `⚠️ *Final Form* has already been used this battle.` }
  }
  // Mei's Prayer Bead can nudge this threshold for the current battle only.
  const finalFormThreshold = bs.finalFormThreshold ?? 0.70
  if (player.hp > player.maxHp * finalFormThreshold) {
    return { ok: false, message: null }
  }

  bs.finalFormUsed = true
  bs.finalFormActive = true // read by combat-engine call sites that want to know Mei is transformed (narrative only)

  const healAmount = Math.floor(player.maxHp * FINAL_FORM_HEAL_PCT)
  const before = player.hp
  player.hp = Math.min(player.maxHp, player.hp + healAmount)
  const healed = player.hp - before

  // 'strengthen' duration is set far beyond any realistic battle length; it
  // is naturally discarded with battleState when the fight ends, so "lasts
  // the rest of the battle" (open question #27, resolved) needs no explicit
  // end-of-battle cleanup here.
  const atkDelta = Math.round((player.stats?.str ?? 0) * FINAL_FORM_ATK_MULT)
  const defDelta = Math.round((player.stats?.def ?? 0) * FINAL_FORM_DEF_MULT)
  if (atkDelta > 0) addStatusEffect(player, { type: 'strengthen', stat: 'str', value: atkDelta, duration: 999, sourceId: 'final_form' })
  if (defDelta > 0) addStatusEffect(player, { type: 'strengthen', stat: 'def', value: defDelta, duration: 999, sourceId: 'final_form' })

  return {
    ok: true,
    message:
      `🌸✨ *FINAL FORM AWAKENS!* ✨🌸\n` +
      `─────────────\n` +
      `_Mei's prayer becomes transformation..._\n\n` +
      `❤️ Healed *${healed}* HP! (${player.hp}/${player.maxHp})\n` +
      `⚔️ Attack surges *+${Math.round(FINAL_FORM_ATK_MULT * 100)}%*!\n` +
      `🛡️ Defense surges *+${Math.round(FINAL_FORM_DEF_MULT * 100)}%*!\n\n` +
      `_The transformation holds for the rest of this battle._`,
  }
}

/**
 * applyMeiSustainHeal(player, incomingDamage, bsOverride) -> { prevented, damage, healed, remaining, message }
 *
 * Mei's death-save, separate from Final Form: it intercepts a hit that would
 * otherwise drop the bearer to 0 and restores them instead. Call this after
 * mitigation and shields have reduced a hit to its actual HP damage, but
 * before subtracting that damage from player.hp.
 *
 * CAPPED, AND WHY
 * This used to have no per-battle limit — it fired on every lethal hit for
 * as long as Mei was equipped, always restoring to 50% of max HP. Combined
 * with PvP having no turn limit and no draw, that was not "hard to kill", it
 * was unkillable: no sequence of opponent actions could ever end the fight.
 * It is now a counted resource, MEI_SUSTAIN_MAX_PER_BATTLE saves per battle,
 * each restoring less than the last (MEI_SUSTAIN_REVIVE_PCT). Once they are
 * spent the next lethal hit lands normally and the bearer dies.
 *
 * WHERE THE COUNTER LIVES
 * bs.meiSustainUsed, on the same per-battle state object every other
 * once-per-battle latch in this file uses (bs.finalFormUsed,
 * bs.cloneTankUsed, ...), so it resets for free when battleState is nulled
 * at fight end. Solo PvE and PvP both put that object on player.battleState;
 * party fights deliberately don't (see plugins/party.js's charState note), so
 * they pass their per-member stand-in as bsOverride, exactly as they already
 * do for activateFinalForm(). If NO state object is reachable the save is
 * denied outright rather than granted uncounted — failing closed, because an
 * uncounted save is the exact bug this cap exists to remove.
 */
export function applyMeiSustainHeal(player, incomingDamage, bsOverride = null) {
  const damage = Math.max(0, Number(incomingDamage) || 0)
  const currentHp = Number(player?.hp ?? 0)
  const maxHp = Number(player?.maxHp ?? 0)

  if (
    player?.equippedCharacter !== 'mei' ||
    damage <= 0 ||
    maxHp <= 0 ||
    currentHp <= 0 ||
    currentHp - damage > 0
  ) {
    return { prevented: false, damage }
  }

  // The hit is lethal and Mei is equipped — spend a save if one is left.
  const bs = bsOverride ?? player?.battleState ?? null
  if (!bs) return { prevented: false, damage }

  const used = Number(bs.meiSustainUsed ?? 0)
  if (used >= MEI_SUSTAIN_MAX_PER_BATTLE) {
    return {
      prevented: false,
      damage,
      remaining: 0,
      message:
        `\n\n🌸 *The prayer goes unanswered.*\n` +
        `_Mei's seal is spent — it will not catch this one._`,
    }
  }

  bs.meiSustainUsed = used + 1
  const revivePct = MEI_SUSTAIN_REVIVE_PCT[Math.min(used, MEI_SUSTAIN_REVIVE_PCT.length - 1)]
  const before = currentHp
  player.hp = Math.min(maxHp, Math.max(1, Math.floor(maxHp * revivePct)))
  const healed = player.hp - before
  const remaining = MEI_SUSTAIN_MAX_PER_BATTLE - bs.meiSustainUsed

  return {
    prevented: true,
    damage: 0,
    healed,
    remaining,
    message:
      `\n\n🌸 *MEI'S SUSTAIN ACTIVATES!*\n` +
      `_The seal catches the killing blow and restores Mei's bearer._\n` +
      `💫 Death prevented — the battle continues!\n` +
      `❤️ HP restored: ${player.hp}/${player.maxHp}\n` +
      `_(${remaining} sustain${remaining === 1 ? '' : 's'} left this battle)_`,
  }
}

// ── Wither ───────────────────────────────────────────────────────────────

// Cinder Verdict's damage multiplier, fed straight into calcPlayerDamage's
// existing `damageMultiplier` param — no parallel damage path. For scale:
// data/skill-tiers.json caps a legendary skill at 3.0x, so 8x is roughly
// 2.7x the strongest repeatable skill in the game. That is deliberate for a
// once-per-battle, zero-MP peak-character ultimate, and it is NOT a scripted
// instakill: the result still goes through applyDefense() at the call site,
// whose def/(def+500) curve pulls it back hard against tanky targets.
// Checked against sample builds (INT 150 + Wither's +40):
//   DEF 40  / HP 700  -> 1407 dmg (kill)
//   DEF 250 / HP 1400 ->  960 dmg (69%, kill only on a crit)
//   DEF 500 / HP 2200 ->  720 dmg (33%)
//   DEF 1200/ HP 3500 ->  423 dmg (12%)
export const CINDER_VERDICT_MULT = 8.0

/**
 * activateCinderVerdict(player) -> { ok, message, multiplier }
 *
 * Wither's one combat move. Deliberately shaped exactly like
 * activateFinalForm() above: same guard order (character equipped -> in
 * battle -> once-per-battle flag), same bs.<name>Used flag pattern, and the
 * flag lives on battleState so it resets for free when the fight ends.
 * Costs no MP.
 *
 * This function only validates and burns the once-per-battle charge — it
 * returns the multiplier for the CALLER to run through the normal
 * calcPlayerDamage(player, skill, damageMultiplier) -> applyDefense()
 * pipeline, so mitigation, crits and accuracy all still apply.
 */
export function activateCinderVerdict(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (player.equippedCharacter !== 'wither') {
    return { ok: false, message: `❌ You need Wither equipped to use *${'.cinderverdict'}*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const gate = ultimateGate(player, bs, 'wither', 'Cinder Verdict')
  if (gate.blocked) return { ok: false, message: gate.message }

  burnUltimate(player, bs, 'wither')
  return { ok: true, multiplier: CINDER_VERDICT_MULT, message: null }
}

// ── Urahara ──────────────────────────────────────────────────────────────


/**
 * applyTearOnHit(player, enemy) — call right after a player hit lands on
 * an enemy in PvE (attack.js/useability.js's PLAYER_HIT point), only when
 * Urahara is equipped. Applies the in-battle 'sever' activeEffects entry
 * to the enemy (20%-of-maxHp/tick, cleansable only via the Severing Elixir
 * cure). Returns a narrative line, or null if Urahara isn't equipped.
 */
export function applyTearOnHit(player, enemy, ctx = null) {
  if (player.equippedCharacter !== 'urahara') return null
  if (hasEffect(enemy, 'tear')) return null // single application; refreshed on cure+reapply only
  addStatusEffect(enemy, { type: 'tear', pctPerTick: IN_BATTLE_SEVER_PCT, duration: SEVER_TICK_DURATION, sourceId: 'tear_reshape' })
  const line =
    `🗡️🩸 *TEAR / RESHAPE*\n` +
    `─────────────\n` +
    `*${enemy.name}* is marked with a wound.\n` +
    `_Bleeding for 20% max HP each turn — hard to cure._`
  if (ctx) {
    void sendImageTo(ctx, 'urahara-tear', line, ctx.sender).catch(() => {})
    return null
  }
  return line
}

// ── Miyashi ──────────────────────────────────────────────────────────────
//
// "Absolute Zero" — passive frost aura, not a triggered burst like Mei's
// Final Form or a once-per-battle nuke like Wither's Cinder Verdict. Two
// parts, both always live while Miyashi is equipped:
//   1. Frostbind (ambient): every enemy turn, the aura alone burns
//      FROSTBIND_DRAIN_PCT of the enemy's max HP — no hit required — and
//      has a chance to apply 'frostlock' (lib/effects.js), which does NOT
//      skip the enemy's turn (that's freeze/stun's job) but forces
//      whatever action they take down to a basic attack: no skills, no
//      items, no character/named abilities. See applyFrostlockGate() below
//      for the actual enforcement — this function only rolls + applies it.
//   2. Absolute Zero (threshold): once the enemy's HP is at or below 50%,
//      the aura intensifies — drain increases to FROSTBIND_DRAIN_PCT_LOW,
//      and the frostlock chance becomes guaranteed (100%) for the rest of
//      the fight. bs.miyashiIntensified is a one-way latch (spec: once
//      triggered, stays on even if the enemy somehow heals back above
//      50% — an "it caught, it holds" framing, consistent with Mei's Final
//      Form also being irreversible for the battle once active).
const FROSTBIND_DRAIN_PCT = 0.09        // 8-10% — mid of the requested range
const FROSTBIND_DRAIN_PCT_LOW = 0.13    // intensified drain post-Absolute Zero
const FROSTBIND_LOCK_CHANCE = 0.40      // pre-threshold chance to frostlock the enemy each turn
const FROSTBIND_THRESHOLD = 0.50        // enemy HP% that triggers Absolute Zero

/**
 * tickFrostbindAura(player, enemy, bsOverride) -> { message } | null
 * Call once per enemy turn (attack.js's monster/boss turn, pvp.js's
 * opponent turn) while Miyashi is equipped, BEFORE the enemy's action is
 * resolved — the frostlock roll needs to land before applyFrostlockGate()
 * reads it. Mutates enemy.hp directly (ambient drain, not a hit — bypasses
 * defense entirely, same convention as tear/permanentSever ticks).
 */
export function tickFrostbindAura(player, enemy, bsOverride = null) {
  if (player?.equippedCharacter !== 'miyashi') return null
  if (!enemy || (enemy.hp ?? 0) <= 0) return null
  const bs = bsOverride ?? player.battleState ?? null

  const intensified = bs?.miyashiIntensified || ((enemy.hp / (enemy.maxHp || enemy.hp || 1)) <= FROSTBIND_THRESHOLD)
  if (bs && intensified && !bs.miyashiIntensified) bs.miyashiIntensified = true

  const drainPct = intensified ? FROSTBIND_DRAIN_PCT_LOW : FROSTBIND_DRAIN_PCT
  const drain = Math.max(1, Math.round((enemy.maxHp ?? enemy.hp ?? 0) * drainPct))
  const lockChance = intensified ? 1 : FROSTBIND_LOCK_CHANCE
  const locked = Math.random() < lockChance

  // Shunya — The Empty Vessel: an aura needs something to bite. A void has no
  // warmth to steal and no kit to lock, so the whole tick turns back on the one
  // who made the cold. Returned rather than applied because `player` is a
  // snapshot in a duel — see resolveVoidRebound() in lib/effects.js.
  const rebound = resolveVoidRebound(enemy, player, drain, 'the frost')
  if (rebound.rebounded) {
    const voidLines = [
      intensified ? `❄️🔻 *ABSOLUTE ZERO* deepens...` : `❄️ *Frostbind* chills the air...`,
      rebound.message,
    ]
    if (locked) voidLines.push(`🥶 _The frostlock has no one to hold but its caster._`)
    return {
      message: voidLines.join('\n'),
      intensified,
      locked: false,
      damage: 0,
      reboundDamage: rebound.damage,
      reboundEffects: locked ? [{ type: 'frostlock', duration: 1, sourceId: 'absolute_zero' }] : [],
    }
  }

  const before = enemy.hp
  enemy.hp = Math.max(0, enemy.hp - drain)

  if (locked) addStatusEffect(enemy, { type: 'frostlock', duration: 1, sourceId: 'absolute_zero' })

  const lines = [
    intensified ? `❄️🔻 *ABSOLUTE ZERO* deepens!` : `❄️ *Frostbind* chills the air!`,
    `_${enemy.name} takes *${before - enemy.hp}* frost damage from the aura alone._`,
  ]
  if (locked) lines.push(`🥶 _Frozen to the bone — locked to a basic attack this turn!_`)

  return { message: lines.join('\n'), intensified, locked, damage: before - enemy.hp }
}

/**
 * applyFrostlockGate(entity, requestedAction) -> { blocked, action }
 * Call at the point attack.js/pvp.js resolves an action ('attack' | 'skill'
 * | 'item' | 'ability' | ...) for anyone carrying the 'frostlock' status.
 * Returns the action to actually execute — unchanged if not blocked, or
 * forced to 'attack' if it was. Purely a gate; it does not consume or
 * clear the status (that's the normal duration-tick in effects.js).
 */
export function applyFrostlockGate(entity, requestedAction) {
  if (!hasEffect(entity, 'frostlock')) return { blocked: false, action: requestedAction }
  if (requestedAction === 'attack') return { blocked: false, action: 'attack' }
  return { blocked: true, action: 'attack' }
}

// ── Nisha ────────────────────────────────────────────────────────────────
//
// "Absolute One" — the deliberate mirror of Miyashi's Absolute Zero: where
// Miyashi's aura punishes the enemy for acting (drain + skill lock), Nisha's
// rewards her own survival (evasion + lifesteal). Two parts, both always
// live while Nisha is equipped:
//   1. Serpent's Grace (passive): NISHA_DODGE_CHANCE flat chance to no-sell
//      an incoming hit entirely. Modeled exactly on lib/named-passives.js's
//      flash_step_dodge (same ENEMY_DEAL_DAMAGE-shaped call site, same
//      trueDamage exemption — ctx.trueDamage hits are NOT dodgeable, so
//      %-HP/guaranteed effects still land) — just a much higher rate,
//      which is the point of the character.
//   2. Absolute One (passive aura): each of Nisha's own turns, siphons
//      NISHA_SIPHON_PCT of the enemy's max HP straight to her HP. This is
//      intentionally the mirror-but-lower-scale of Frostbind's drain —
//      Frostbind ticks on the ENEMY's turn and also locks their kit;
//      Absolute One only ticks on NISHA's turn and only heals, no lock —
//      so the two "auras" read as opposites without being equal-strength
//      copies of each other.
const NISHA_DODGE_CHANCE = 0.20   // Serpent's Grace
const NISHA_SIPHON_PCT = 0.10     // Absolute One — 10% enemy max HP -> Nisha's HP, per Nisha turn

/**
 * rollSerpentsGrace(player, ctx) -> { dodged, damage }
 * Call at the same ENEMY_DEAL_DAMAGE-shaped point named-passives.js's
 * flash_step_dodge is called from, while Nisha is equipped. ctx.damage is
 * the incoming hit after mitigation; ctx.trueDamage marks hits that must
 * always land (guaranteedHits, doubleStrike, %-HP effects) — Serpent's
 * Grace does not apply to those, same exemption flash_step_dodge uses.
 */
export function rollSerpentsGrace(player, ctx) {
  if (player?.equippedCharacter !== 'nisha') return { dodged: false, damage: ctx?.damage ?? 0 }
  if (ctx?.trueDamage) return { dodged: false, damage: ctx.damage }
  if (Math.random() >= NISHA_DODGE_CHANCE) return { dodged: false, damage: ctx?.damage ?? 0 }
  return {
    dodged: true,
    damage: 0,
    message: `🐍💨 *Serpent's Grace* — the attack never lands!`,
  }
}

/**
 * applyAbsoluteOneSiphon(player, enemy) -> { message, healed, drained } | null
 * Call once on each of Nisha's own turns (the same point Urahara's
 * applyTearOnHit fires from — after the player's action is chosen, in
 * attack.js/pvp.js), while Nisha is equipped. Moves HP directly from enemy
 * to player — bypasses defense (ambient aura effect, not a hit), same
 * convention tickFrostbindAura uses above.
 */
export function applyAbsoluteOneSiphon(player, enemy) {
  if (player?.equippedCharacter !== 'nisha') return null
  if (!enemy || (enemy.hp ?? 0) <= 0) return null

  const siphon = Math.max(1, Math.round((enemy.maxHp ?? enemy.hp ?? 0) * NISHA_SIPHON_PCT))
  const actualDrain = Math.min(siphon, enemy.hp)

  // Shunya — The Empty Vessel: there is no life in a void to draw on. The
  // siphon reverses and, critically, Nisha heals for NOTHING — the void gives
  // nothing back, so lifesteal against her is pure self-harm.
  const rebound = resolveVoidRebound(enemy, player, actualDrain, 'the siphon')
  if (rebound.rebounded) {
    return {
      message: `🩸✨ *ABSOLUTE ONE* reaches into *${enemy.name}*...\n` + rebound.message,
      healed: 0,
      drained: 0,
      reboundDamage: rebound.damage,
    }
  }

  enemy.hp = Math.max(0, enemy.hp - actualDrain)

  const beforeHp = player.hp
  player.hp = Math.min(player.maxHp, player.hp + actualDrain)
  const healed = player.hp - beforeHp

  return {
    message:
      `🩸✨ *ABSOLUTE ONE* draws life from *${enemy.name}*!\n` +
      `_${actualDrain} HP siphoned — Nisha restored *${healed}* HP._ (${player.hp}/${player.maxHp})`,
    healed,
    drained: actualDrain,
  }
}

const TIER_BLURB = {
  'super-effective': 'the strongest option available.',
  effective: 'a solid choice for this matchup.',
  weak: 'a poor fit against this enemy.',
  resisted: 'likely to be heavily resisted.',
}

function willowFlavorLine(tier) {
  switch (tier) {
    case 'super-effective': return 'There — right there. Hit it exactly like that.'
    case 'effective':       return "Good instinct. That'll work."
    case 'weak':            return "Don't. You'll barely scratch it."
    case 'resisted':        return "It's braced for that one. Try something else."
    default:                return 'Nothing stands out. Trust your gut on this one.'
  }
}

// The equipped character's ability -> effectiveness-engine move category
// (data/effectiveness.json's moveCategories descriptions: "holy" is
// explicitly "Mei's Final Form...", "severing" is explicitly "Urahara's
// Tear/Reshape..."). Willow herself has no combat-category ability.
const CHARACTER_ABILITY_CATEGORY = {
  mei: 'holy',
  urahara: 'severing',
  wither: 'fire',
}

/**
 * Resolve the equipped character's combat ability category/name and the
 * equipped named weapon's effect category, the same way real combat sites
 * (attack.js/skill.js) would need to for gradeMove() — used both to feed
 * buildMoveOptions here and to keep this in one place if combat ever wants
 * the same resolution.
 */
function resolveCombatCategoryContext(player) {
  const character = getEquippedCharacter(player)
  const characterCategory = character ? (CHARACTER_ABILITY_CATEGORY[character.id] ?? null) : null
  const characterName = characterCategory ? (character?.ability?.name ?? character?.name ?? null) : null

  // No Season 1 named weapon currently carries a combat-effect category tag
  // (data/named-weapon-passives.json has no `category` field yet), so this
  // resolves to null today but is wired the same way characterCategory is
  // so a future category tag on the equipped named weapon picks up here
  // with no further changes to buildWillowReadout.
  const namedWeaponCategory = player?.equippedNamedWeapon?.category ?? null

  return { characterCategory, characterName, namedWeaponCategory }
}

/** Build Willow's advisory text without changing battle state or costing a turn. */
export function buildWillowReadout(player, enemy) {
  const equippedSkillIds = getEquippedSkills(player)
  const equippedSkillDefs = allSkills.filter((s) =>
    equippedSkillIds.includes(s.id) && s.type === 'active',
  )
  const { characterCategory, characterName, namedWeaponCategory } = resolveCombatCategoryContext(player)
  const options = buildMoveOptions(player, enemy, {
    skills: equippedSkillDefs,
    characterCategory,
    characterName,
    namedWeaponCategory,
  })
  let out =
    `🦉 *WILLOW'S BATTLE ADVISORY*\n` +
    `─────────────\n` +
    `_${enemy.name} studied. Your strongest options:_\n\n`

  for (const opt of options.slice(0, 6)) {
    out += `${opt.emoji} *${opt.name}* _(${moveCategories[opt.category]?.label ?? opt.category})_ — ${opt.grade}x\n`
  }

  const best = options[0]
  if (best) {
    out += `\n💡 *Recommendation:* ${best.name} — ${TIER_BLURB[best.tier] ?? 'a reasonable pick.'}`
    out += `\n\n🌿 _"${willowFlavorLine(best.tier)}"_ — Willow`
  }

  return out + `\n\n_Advisory only — it does not change damage or cost a turn._`
}

/**
 * Send Willow's readout as a separate DM. `recipient` is explicit because
 * the command may have been issued in a group chat.
 */
export async function sendWillowAdvisory(ctx, player, enemy, isBossFight, recipient = ctx.from) {
  if (player?.equippedCharacter !== 'willow') return null
  if (player?.battleState?.type !== 'pvp' && !isBossFight) return null
  const readout = buildWillowReadout(player, enemy)
  await sendImageTo(ctx, 'willow-advisory', readout, recipient)
  return readout
}

/** Send Mei's auto-trigger announcement as the requested local MP4. */
export function sendFinalFormVideo(ctx, caption, recipient = ctx.sender) {
  return sendLocalVideoTo(ctx, 'mei-finalform.mp4', caption, recipient)
}

/**
 * applyPermanentSeverOnWin(winnerPlayerObj, loserPlayerObj) — call from
 * pvp.js's pvpConclude(), BEFORE loser.activeEffects is wiped, only when
 * the WINNER has Urahara equipped. Spec §13.2: "In PvP specifically: the
 * bleed becomes a PERMANENT debuff on the losing/hit player." Stored
 * outside activeEffects (see effects.js's file doc comment) so it survives
 * pvpConclude's `loser.activeEffects = []` reset and persists into the
 * loser's next battles until cured.
 * Single-instance (open question #31, resolved) — does not stack.
 */
export function applyPermanentSeverOnWin(winner, loser) {
  if (winner.equippedCharacter !== 'urahara') return null
  // The Empty Vessel (Shunya) — even a "permanent" Tear finds nothing to bite
  // into. This debuff bypasses the effects.js pipeline (it lives on
  // loser.permanentSever, not in activeEffects), so the statusImmune gate in
  // addStatusEffect never sees it — it has to be refused here explicitly.
  if (hasEmptyVessel(loser)) return null
  loser.permanentSever = loser.permanentSever ?? null
  if (loser.permanentSever) return null // already carrying one — does not stack
  loser.permanentSever = { active: true, appliedAt: Date.now(), sourceId: 'tear_reshape' }
  return `🗡️🩸 *${loser.name}* is left with a permanent Tear — it will bleed until 300 Severing Elixirs are consumed!`
}

/**
 * tickPermanentSever(entity) — action-triggered tick (spec: "fires on the
 * player's next action... no real-time/background timer", matching the
 * existing wearWeaponOnTurn/wearArmorOnHit durability pattern in
 * lib/durability.js). Call once per player action (attack, defend, skill,
 * dungeon entry, pvp move, etc.) for any entity that might be carrying
 * permanentSever. 0.5%-of-maxHp damage per tick (spec §13.2, outside-
 * battle rate — used here for "next action" regardless of whether that
 * action happens to be inside or outside an active fight, since a
 * permanent debuff by definition persists across both).
 * Returns a narrative line, or null if nothing ticked.
 */
export function tickPermanentSever(entity) {
  if (!entity?.permanentSever?.active) return null
  const dmg = Math.max(1, Math.round((entity.maxHp ?? 0) * OUT_OF_BATTLE_SEVER_PCT))
  const before = entity.hp ?? 0
  entity.hp = Math.max(0, before - dmg)
  return `🩸 _The old Tear wound reopens — *${dmg}* damage._ (${entity.hp}/${entity.maxHp})`
}

/**
 * cureePermanentSever(player, elixirsConsumed) -> { cured, remaining }
 * Called by plugins/curetear.js. Spec: "the affected player must consume
 * 30 Elixirs to remove the effect." Implemented as one command that
 * consumes 300 Severing Elixirs from inventory in a single action
 * (rather than requiring the player to run .use 30 separate times) —
 * see plugins/curetear.js for the inventory math; this function just
 * flips the flag once the caller has confirmed 30 were spent.
 */
export function curePermanentSever(player) {
  if (!player.permanentSever?.active) return { cured: false }
  player.permanentSever = null
  return { cured: true }
}

// ── Shunya — The Empty Vessel ──────────────────────────────────────────────
//
// शून्य (shunya) = zero / void / emptiness. Her identity is negative space:
// there is nothing in her for a hostile effect to attach to.
//
//   Void Immunity (passive): she cannot receive ANY negative status effect —
//   burn, poison, freeze, stun, blind, weaken, frostlock, tear, shred, locks,
//   the lot. Enforced generically in lib/effects.js: the equip path sets
//   player.statusImmune, and addStatusEffect() refuses every negative effect
//   on a statusImmune entity — the one funnel all duration debuffs pass
//   through, so it holds in PvE, PvP and boss fights. Two debuffs bypass that
//   funnel and are refused at their own sites: the boss "lifespan drain" stat
//   cut (plugins/skill.js) and Urahara's permanent Tear
//   (applyPermanentSeverOnWin above). She is NOT immune to raw damage — she
//   bleeds and dies like anyone, which keeps her off the dodge/negation axis
//   the other characters already occupy.
//
//   The Void Returns It (PvP): when a duelist tries to land a debuff on her,
//   it doesn't just fizzle — the void hands it back onto the caster
//   (plugins/pvp.js). PvP-only because that is the one place the caster is
//   cleanly in scope at the moment of application; in PvE the effect simply
//   vanishes (immunity), the same result minus the counter-hit.
//
// effects.js stays character-agnostic (it only knows the statusImmune flag,
// exactly like endWeakened) — THIS file owns the "shunya ⇒ statusImmune" map.
export const SHUNYA_CHARACTER_ID = 'shunya'

/** True when `player` has Shunya (The Empty Vessel) equipped. */
export function hasEmptyVessel(player) {
  return player?.equippedCharacter === SHUNYA_CHARACTER_ID
}

/**
 * Keeps `player.statusImmune` in lockstep with whether Shunya is equipped.
 * Call from the equip/unequip path (plugins/character.js) after
 * equippedCharacter changes, in EITHER direction: equipping her sets the
 * flag, equipping anyone else — or unequipping — clears it. Idempotent, so
 * it is safe to call on every equip regardless of the transition.
 */
export function syncEmptyVesselFlag(player) {
  if (!player) return
  if (hasEmptyVessel(player)) player.statusImmune = true
  else if (player.statusImmune) delete player.statusImmune
}

// ── The Transcendent ───────────────────────────────────────────────────────
//
// "Second Transcendance" — a true second wind worn as a passive. While the
// Transcendent is equipped, the player acts TWICE on every one of their turns:
// their primary hit lands, then an independent echo strike follows with its
// own accuracy and crit roll. Unlike Wither's once-per-battle Cinder Verdict
// (a multiplier on a single hit), this is a genuine extra action, every turn,
// for the whole fight — no charge, no cooldown, no MP.
//
// There is no activate*() here because nothing needs gating or a once-per-
// battle latch: the passive is simply "are you the Transcendent?", checked at
// each generic offensive site (attack.js / skill.js / party.js / pvp.js). The
// echo itself is lib/combat-engine.js's rollEchoStrike() — placed there, not
// here, so this file needn't import the damage pipeline. The whole design is
// built so the echo never touches bs.turn (see rollEchoStrike's doc comment),
// which is what makes it "flawless alongside" the turn-keyed abilities above.
export const SECOND_TRANSCENDANCE_ID = 'ariel'

/** True when `player` has the Transcendent equipped (attacks strike twice). */
export function hasSecondTranscendance(player) {
  return player?.equippedCharacter === SECOND_TRANSCENDANCE_ID
}

// ── The Streamer ───────────────────────────────────────────────────────────
//
// A media-born fighter whose power is the crowd. Won from `.yato-spin`
// (plugins/yato-spin.js) at 1 gem per spin, with no fame wall — fame scales him
// but does not unlock him. Not one-of-one: unlike every other spin character,
// anyone who clears the dead zone can spin for their own copy. Its signature is
// the active skill `.live-blast` (plugins/liveblast.js), which reads the owner's
// LIVE viewer count from the streaming feature (plugins/stream.js's
// getStreamViewers) and converts it straight into damage: 0 viewers = 0 power,
// and a 500k-fame owner's ~10,000-viewer cap one-taps a 50,000-HP boss.
//
// activateLiveBlast() is the gate ONLY — shaped exactly like
// activateCinderVerdict() above (equipped -> in battle -> once-per-battle
// bs.liveBlastUsed latch that resets for free when battleState clears). It
// carries NO multiplier: the damage is viewer-scaled and computed entirely in
// the plugin, which reads the viewer count and (importantly) checks viewers>0
// BEFORE calling this, so a crowd-less attempt never burns the once-per-battle
// charge. Reading viewers lives in the plugin, not here, so this file stays
// free of any dependency on plugins/stream.js.
//
// Live Blast is his FIRST form only. It is retired permanently the moment he
// ascends — see "The Streamer's true form" below, past resolveTearOfGod().
export const STREAMER_CHARACTER_ID = 'yato'

/** True when `player` has the Streamer equipped. */
export function hasStreamer(player) {
  return player?.equippedCharacter === STREAMER_CHARACTER_ID
}

/**
 * .live-blast gate — validates + burns the once-per-battle charge, mirroring
 * activateCinderVerdict(). Returns { ok, message }; the CALLER computes the
 * viewer-scaled damage and applies it. No MP, no multiplier.
 */
export function activateLiveBlast(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (player.equippedCharacter !== STREAMER_CHARACTER_ID) {
    return { ok: false, message: `❌ You need *Yato* equipped to use *.live-blast*.` }
  }
  // Retired by the true form. Checked before the battle and latch checks
  // because this is a PERMANENT refusal, not a cooldown, and the player needs
  // to be told the move is gone rather than that it is spent. The plugin has
  // its own copy of this guard ahead of its viewer check — see the note in
  // plugins/liveblast.js for why both are needed.
  if (hasYatoTrueForm(player)) {
    return { ok: false, message: LIVE_BLAST_RETIRED_MESSAGE }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  if (bs.liveBlastUsed) {
    return { ok: false, message: `⚠️ *Live Blast* has already been used this battle.` }
  }
  bs.liveBlastUsed = true
  return { ok: true, message: null }
}

/**
 * Tear of God — Yato's passive half, and the only death-save in the bot that
 * refuses a blow rather than surviving one.
 *
 * Once per battle, when a strike that has already been through every other
 * reduction would still take him to 0, the hit is thrown away entirely and he
 * is set back to half of his maximum health. No transformation, no rewind, no
 * exchange — the blow simply does not get to have happened.
 *
 * HOW THIS IS DIFFERENT FROM THE OTHER THREE (they must not overlap):
 *   - Anastasia's Hypnosis rewinds the whole fight to its opening state, twice.
 *   - Yoriichi's cat form lets the defeat land and continues on a second,
 *     separate HP pool with its own rules.
 *   - Minna's Hollow Exchange is player-activated and trades conditions with
 *     the enemy instead of preventing anything.
 * This one is automatic, costs no turn, and leaves the fight exactly as it was
 * except that he is standing.
 *
 * WHY IT IS BEATABLE — the part that keeps him fair.
 * It lives inside applyIncomingDamage(), which is the funnel for *struck*
 * damage: monster and boss attacks, duel strikes, echoes, reflected hits. It is
 * deliberately NOT in processStatusTurn(), so burn, poison, bleed, armour-shred
 * rot and a boss's lifespan-drain all still kill him outright — a tear can
 * catch a sword, not something already in the blood. That makes the whole
 * status-effect half of the roster (Willow, Urahara's Sever, every DoT boss)
 * his real counter, and it means the answer to Yato is another character rather
 * than better numbers. Once per battle on top of that: the second killing blow
 * of a fight is always real.
 */
export const TEAR_OF_GOD_HP_FRACTION = 0.5

export function resolveTearOfGod(player, damage, bsOverride = null) {
  if (!hasStreamer(player)) return { saved: false, message: '' }
  // Not lethal (hp survives the hit) -> the tear stays where it is.
  if (damage < (player.hp ?? 0)) return { saved: false, message: '' }
  const bs = bsOverride ?? player.battleState
  if (!bs || bs.tearOfGodUsed) return { saved: false, message: '' }

  bs.tearOfGodUsed = true
  // Math.max so a tear can never LOWER his health: taking a lethal hit from
  // above half leaves him where he was rather than dragging him down to 50%.
  const restored = Math.max(player.hp ?? 0, Math.floor((player.maxHp ?? 1) * TEAR_OF_GOD_HP_FRACTION))
  player.hp = restored

  return {
    saved: true,
    message:
      `💧✨ *TEAR OF GOD*\n` +
      `_The blow lands, and something older than the boy refuses it. ` +
      `One tear falls for a life he can't remember — and *${player.name}* is still standing._\n` +
      `❤️ Restored to *${restored}*/${player.maxHp} HP _(once per battle)_`,
  }
}

// ── The Streamer's true form ───────────────────────────────────────────────
//
// The only PERMANENT character evolution in the bot. Everything else that
// transforms is per-battle and ADDITIVE: Mei's Final Form grants stats for one
// fight, Yoriichi's cat form opens a second HP pool, Megumi's domain summons.
// None of them take anything away. This one is one-way and it REPLACES. Once
// player.yatoAscended is set, Live Blast is gone for good and .unwritten
// (plugins/unwritten.js) is his active in its place.
//
// WHAT WAKES IT: losing. Not a command, not a purchase, not a fame number. The
// first time a Yato owner is actually defeated with him equipped. Tear of God
// above refuses killing blow #1; this fires on the blow that finally sticks,
// which is why awakenYatoTrueForm() hooks handleDeath() in
// lib/combat-handlers.js at the exact line that increments battleRecord.losses.
// That anchor is load-bearing:
//
//   - It sits AFTER the Premium auto-revive early return, so a player the bot
//     saved did not lose and does not ascend. Ascension fires exactly when the
//     bot's own loss counter moves, which is the definition of "lost" the rest
//     of the game already uses.
//   - It is PvE only. A duel never reaches handleDeath (plugins/pvp.js has its
//     own pvpConclude(), which only moves 5% of the loser's solars), and
//     awakening on a duel loss would let two friends hand each other the true
//     form in under a minute.
//
// A real death costs gear, the whole loose inventory and half of both bars. That
// price is what makes this an awakening rather than a checkbox.
//
// player.yatoAscended is PERMANENT. Nothing unsets it: not a later death, not
// unequipping him, not re-equipping him, not a new season. player.yatoSpins is
// the existing precedent for a permanent player-level Yato field.
//
// IT GRANTS NO STATS, DELIBERATELY. Yato is the only character in the roster
// with no statBonuses key at all and that stays true. applyEquipmentBonus()
// (lib/combat-engine.js) is called with the character definition on equip and
// again with sign -1 on unequip, so a definition whose numbers changed while he
// was equipped would subtract different values than it added and silently
// corrupt the stat sheet. It also would not survive the stat floor in
// handleDeath(). The ability is the whole reward.

/** True once this player's Yato has ascended. One-way, and never unset. */
export function hasYatoTrueForm(player) {
  return !!player?.yatoAscended
}

/** True when an ASCENDED Yato is the equipped character. */
export function hasAscendedStreamer(player) {
  return hasStreamer(player) && hasYatoTrueForm(player)
}

/**
 * Shown wherever Live Blast is attempted after ascension. Deliberately does not
 * read like a cooldown or a spent charge: the move does not exist any more.
 */
export const LIVE_BLAST_RETIRED_MESSAGE =
  `📺 *That form is gone.*\n\n` +
  `_The stream, the room, the ten thousand people leaning in. He does not need ` +
  `any of it now, and it cannot be called back._\n\n` +
  `_Use *.unwritten* instead._`

/**
 * The awakening. Called from handleDeath() in lib/combat-handlers.js, at the
 * battleRecord.losses increment. Returns { awakened, message }.
 *
 * Idempotent, and cheap on the hot path: EVERY death in the game runs this, and
 * all but one of them fall out on the first two checks.
 */
export function awakenYatoTrueForm(player) {
  if (!hasStreamer(player)) return { awakened: false, message: '' }
  if (hasYatoTrueForm(player)) return { awakened: false, message: '' }

  player.yatoAscended = true

  return {
    awakened: true,
    message:
      `📺⛩️ *TRUE FORM*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_The boy dies. He is allowed to. There was one tear and it has already ` +
      `been spent, and nothing is owed to him twice._\n\n` +
      `_What opens its eyes in the dark afterwards is not the boy, and it is not ` +
      `confused about where it is. It has been here longer than here has, asleep ` +
      `behind a face that thought fame was something a person could be given. It ` +
      `knows the shape of every mountain in this world, and it did not learn them ` +
      `by walking._\n\n` +
      `📵 *Live Blast is gone.* He will never need a crowd again.\n` +
      `🕯️ *Unwritten* is his now, in every fight, for nothing.\n\n` +
      `_You are still dead. Get up first._`,
  }
}

// ── Unwritten ──────────────────────────────────────────────────────────────
//
// The ascended active. He does not hit the enemy: he takes part of it back out
// of the world. Each use deletes a flat slice of the enemy's ORIGINAL maxHp and
// clamps current hp down to the new ceiling.
//
// WHY maxHp AND NOT DAMAGE. Nothing else in the 18-character roster reads or
// writes maxHp, which makes it the one uncontested mechanic left (the roster
// already owns nukes, DoTs, stuns, dodges, damage reduction, status immunity,
// double strikes, stat breaks and five death-saves). It is also the ONLY answer
// in the game to a boss that heals: a heal, The End's scripted second wind and a
// phase reset all restore INTO a ceiling that keeps shrinking. The engine
// already proves the pattern, at lib/boss-engine.js's naruto_baryon TURN_END
// case, which burns that boss's own maxHp down 2% a turn with this same clamp.
//
// LINEAR OFF THE ORIGINAL CEILING, not compounding off the current one. A
// compounding cut is asymptotic and unreadable; this way it lands identically on
// a 500 HP mob and on The End's 120,000, and the player can count it: nine
// erasures take anything to the floor and the tenth is refused.
//
// IT CAN NEVER KILL. The floor stops maxHp at a tenth of where it started and hp
// is clamped to at least 1, so erasure walks anything to the brink and stops
// there. The last of anything has to be killed the ordinary way. That single
// rule buys three things: the ability cannot one-tap (unlike the Live Blast it
// replaces), the plugin needs no victory branch on the erase step, and
// bosses/the_last_prayer.js stays unbeatable exactly as its own file documents,
// with no special case anywhere in here.
//
// WHY IT IS STILL BEATABLE, which is the standing balance rule for Yato: it does
// nothing whatsoever about incoming damage. One command is one full turn cycle
// in this bot, so nine erasures is nine turns of being hit, and the bosses worth
// using this on kill a well-geared player well before then. It hard-counters HP
// and healing and has no answer at all for pressure. The answer to Yato stays
// another character rather than better numbers.
//
// NOT AVAILABLE IN PVP, and this is a data-safety rule rather than a balance one.
// plugins/pvp.js operates on the real player records (opp.maxHp, and
// loser.hp = loser.maxHp on conclude), so erasing maxHp in a duel would
// permanently mutilate a live player's stat sheet and desync the
// applyEquipmentBonus() add/subtract pair on their next unequip. Stats are
// locked in this bot: only growth, allocations, stat packs and job perks move
// them. The plugin refuses duels up front.
export const UNWRITTEN_ERASE_FRAC = 0.10   // per use, off the ORIGINAL maxHp
export const UNWRITTEN_FLOOR_FRAC = 0.10   // maxHp can never fall below this

/**
 * The original ceiling for this fight, recorded on first use so later uses stay
 * linear after the ceiling has already moved. Read-only.
 */
function unwrittenOriginal(bs, enemy) {
  return bs?.unwrittenOrigMaxHp ?? (enemy?.maxHp ?? enemy?.hp ?? 1)
}

/** The floor maxHp can never fall below in this fight. Read-only. */
function unwrittenFloor(bs, enemy) {
  return Math.max(1, Math.floor(unwrittenOriginal(bs, enemy) * UNWRITTEN_FLOOR_FRAC))
}

/**
 * Read-only gate, mirroring the canHypnosisRewind()/resolveHypnosisRewind() pair
 * this file already uses. Mutates NOTHING, so the plugin can refuse a use before
 * it spends a turn of the fight (a refused erasure must not cost the player a
 * status tick and an enemy swing). eraseFromWorld() calls this itself, so the
 * two can never drift.
 */
export function canEraseFromWorld(player, enemy, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!hasStreamer(player)) {
    return { ok: false, message: `❌ You need *Yato* equipped to use *.unwritten*.` }
  }
  if (!hasYatoTrueForm(player)) {
    return {
      ok: false,
      message:
        `🕯️ *Not yet.*\n\n` +
        `_Something in him is still asleep. It has never once had a reason to wake up._`,
    }
  }
  if (!player.inBattle || !bs || !enemy) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const maxHpBefore = enemy.maxHp ?? unwrittenOriginal(bs, enemy)
  if (maxHpBefore <= unwrittenFloor(bs, enemy)) {
    return {
      ok: false,
      atFloor: true,
      message:
        `🕯️ *There is nothing left to take back.*\n\n` +
        `_What remains of *${enemy.name}* is the part that was always its own. ` +
        `Kill it the ordinary way._`,
    }
  }
  return { ok: true, message: '' }
}

/**
 * Applies one erasure to `enemy`. Gate and math in one call, because here the
 * math IS the ability (unlike activateLiveBlast(), which is a gate only because
 * its damage depends on a viewer count this file must not import).
 *
 * Mutates enemy.maxHp/enemy.hp and records the original ceiling on the battle
 * state, so it resets with the fight for free the way bs.liveBlastUsed does.
 * Returns { ok, message, cut, maxHpBefore, maxHpAfter, hpAfter, atFloor }.
 */
export function eraseFromWorld(player, enemy, bsOverride = null) {
  const gate = canEraseFromWorld(player, enemy, bsOverride)
  if (!gate.ok) return gate

  const bs = bsOverride ?? player.battleState
  bs.unwrittenOrigMaxHp = unwrittenOriginal(bs, enemy)

  const floor = unwrittenFloor(bs, enemy)
  const cut   = Math.max(1, Math.floor(bs.unwrittenOrigMaxHp * UNWRITTEN_ERASE_FRAC))

  const maxHpBefore = enemy.maxHp ?? bs.unwrittenOrigMaxHp
  enemy.maxHp = Math.max(floor, maxHpBefore - cut)
  // Clamps DOWN only, and never to 0: erasure brings anything to the brink and
  // refuses to finish it. Math.max(1, ...) is the belt to the floor's braces.
  enemy.hp = Math.max(1, Math.min(enemy.hp ?? enemy.maxHp, enemy.maxHp))

  return {
    ok: true,
    cut: maxHpBefore - enemy.maxHp,
    maxHpBefore,
    maxHpAfter: enemy.maxHp,
    hpAfter: enemy.hp,
    atFloor: enemy.maxHp <= floor,
    message: '',
  }
}

// ── Yoriichi ─────────────────────────────────────────────────────────────
//
// "Cat Form Awakening" used to be implemented here as a ~400 line block. It
// now lives in lib/yoriichi.js, on its own, because splitting one mechanic
// across this file + lib/combat-handlers.js + plugins/pvp.js is what let its
// central defect survive: she was written as a replacement combatant but was
// still driven by the owner typing commands, and every turn ended by printing
// the owner a list of moves. See that file's header for the full picture.
//
// Everything is re-exported from the top of this file, so the ~9 modules that
// import her helpers from here are unaffected.


// ── Tyla & Alya ──────────────────────────────────────────────────────────
/**
 * Twin Bond — one equip slot, one character id ('tyla_alya'), three linked
 * pieces exactly like Mei's file section above (activateFinalForm +
 * applyMeiSustainHeal coexisting under one equip):
 *
 *   Tyla — Clone Tank (passive, up to 3 per battle):
 *     Any single hit that would deal more than 10% of the player's CURRENT
 *     HP is fully absorbed by a clone — the player takes 0 damage from that
 *     hit. Capped at CLONE_TANK_MAX_PER_BATTLE (3) uses per battle — the
 *     4th+ qualifying hit of a battle lands for its full (Mei-sustained)
 *     damage like normal. The counter lives on player.battleState
 *     (bs.cloneTankUsed), so it resets for free whenever battleState is
 *     nulled at battle end — same mechanism as Alya's
 *     alyaLastBreakTurn/danceOfTheRainUsed below. Wired into
 *     applyIncomingDamage() below (checked AFTER Mei's sustain shaves the
 *     raw hit down, so the 10% threshold reads against what would actually
 *     land — same ordering rationale as cat form's own check).
 *
 *   Alya — Stat Break (automatic, every 3rd turn):
 *     Zeroes out ONE random enemy stat for 6 turns via the existing
 *     weaken() effect (lib/effects.js) — value is set to the target's own
 *     current stat, which floors getEffectiveStat() at exactly 0 (not
 *     "reduced by some amount", genuinely zero) regardless of any buff
 *     already stacked on that stat. Picks only from stats the target
 *     actually carries a nonzero value for (STAT_BREAK_POOL, filtered) —
 *     dungeon monsters only have atk/def (data/monsters.json), PvP
 *     opponents are full players with all five, so the pick pool is
 *     resolved per-target rather than hardcoded to one shape.
 *
 *   Dance of the Rain — automatic legendary twin strike, once the battle
 *     reaches turn 10. Both girls hit in the same strike; the caller
 *     (plugins/attack.js / plugins/pvp.js) still runs this through the
 *     SAME calcPlayerDamage()/applyDefense() pipeline every other hit
 *     uses, with DANCE_OF_THE_RAIN_MULT as the damage multiplier — same
 *     "reuse the real pipeline, just override the multiplier" pattern as
 *     Wither's CINDER_VERDICT_MULT and Yoriichi's catFormAttackDamage().
 *     Fires once, the first turn the check passes (bs.danceOfTheRainUsed
 *     gates re-triggering — a repeatable turn-10+ nuke every subsequent
 *     turn would dwarf the rest of the kit).
 */

/** True if the equipped character is Tyla & Alya. */
function isTwinBondActive(player) {
  return player?.equippedCharacter === 'tyla_alya'
}

/**
 * Tyla's clone tank. Called from applyIncomingDamage() with the
 * already-Mei-sustained damage. Returns { tanked, message } — if tanked,
 * the caller must treat the hit as 0 damage. Capped at
 * CLONE_TANK_MAX_PER_BATTLE uses per battle via bs.cloneTankUsed, a plain
 * counter on player.battleState (same storage spot as
 * alyaLastBreakTurn/danceOfTheRainUsed) — resets for free whenever
 * battleState is nulled at battle end.
 */
function applyCloneTank(player, incomingDamage) {
  const dmg = Math.max(0, Number(incomingDamage) || 0)
  if (!isTwinBondActive(player) || dmg <= 0) return { tanked: false }

  const currentHp = Number(player?.hp ?? 0)
  if (currentHp <= 0) return { tanked: false }

  if (dmg <= currentHp * CLONE_TANK_HP_THRESHOLD_PCT) return { tanked: false }

  const bs = player?.battleState
  const used = bs?.cloneTankUsed ?? 0
  if (used >= CLONE_TANK_MAX_PER_BATTLE) return { tanked: false }

  if (bs) bs.cloneTankUsed = used + 1
  const remaining = CLONE_TANK_MAX_PER_BATTLE - (used + 1)

  return {
    tanked: true,
    message: `🌗 A clone intercepts the attack — *${player.name ?? 'you'}* remain${player.name ? 's' : ''} unscathed! _(${remaining} clone${remaining === 1 ? '' : 's'} left this battle)_`,
  }
}

/**
 * Picks a random stat key the target actually has a nonzero value for
 * (via getEffectiveStat, so an already-zeroed stat from a PRIOR Stat
 * Break isn't picked again while it's still active — nothing to reduce
 * further). Returns null if the target has nothing left to break (e.g.
 * a monster with atk/def both already at 0, or already weakened).
 */
function pickRandomNonZeroStat(target) {
  const available = STAT_BREAK_POOL.filter(stat => getEffectiveStat(target, stat) > 0)
  if (!available.length) return null
  return available[Math.floor(Math.random() * available.length)]
}

/**
 * Alya's Stat Break. Called once per player turn (from the same
 * turn-advance checkpoint that increments battleState.turn) with the
 * enemy/opponent as `target`. Fires only on turns that are exact
 * multiples of STAT_BREAK_EVERY_N_TURNS (3, 6, 9, ...). Returns
 * { triggered, stat, message }.
 */
export function applyAlyaStatBreak(player, target, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!isTwinBondActive(player) || !bs || !target) return { triggered: false }

  const turn = bs.turn ?? 1
  if (turn % STAT_BREAK_EVERY_N_TURNS !== 0) return { triggered: false }

  // Guard against firing twice on the same turn number if a caller ends up
  // invoking this more than once per turn (mirrors finalFormUsed-style
  // once-per-trigger flags elsewhere in this file).
  if (bs.alyaLastBreakTurn === turn) return { triggered: false }

  const stat = pickRandomNonZeroStat(target)
  if (!stat) return { triggered: false }

  const STAT_LABEL = { str: 'STR', atk: 'ATK', agi: 'AGI', int: 'INT', def: 'DEF', lck: 'LCK' }

  // Shunya — The Empty Vessel: addStatusEffect() would swallow this `weaken`
  // silently (statusImmune), which reads like Alya's turn simply did nothing.
  // There is nothing in a void to unravel, so the unravelling finds the only
  // other thing on the field: Alya herself. The stat is re-picked from HER
  // sheet — breaking a stat the opponent had says nothing about what the caster
  // has left to lose. Carried out rather than applied because `player` is a
  // snapshot in a duel (see resolveVoidRebound in lib/effects.js).
  if (target.statusImmune) {
    bs.alyaLastBreakTurn = turn
    const ownStat = pickRandomNonZeroStat(player)
    if (!ownStat) {
      return {
        triggered: true,
        rebounded: true,
        message: `🌘 *Alya* reaches into *${target.name ?? 'the enemy'}* and finds ⭕ *nothing to unravel.*`,
      }
    }
    return {
      triggered: true,
      rebounded: true,
      reboundEffects: [{
        type: 'weaken', stat: ownStat, value: getEffectiveStat(player, ownStat),
        duration: STAT_BREAK_DURATION, sourceId: 'alya_stat_break',
      }],
      message:
        `🌘 *Alya* reaches into *${target.name ?? 'the enemy'}* and finds nothing to unravel.\n` +
        `⭕ _The thread was always her own_ — *${player.name ?? 'Alya'}*'s ` +
        `${STAT_LABEL[ownStat] ?? ownStat.toUpperCase()} is reduced to *0* for *${STAT_BREAK_DURATION}* turns!`,
    }
  }

  const value = getEffectiveStat(target, stat)
  addStatusEffect(target, { type: 'weaken', stat, value, duration: STAT_BREAK_DURATION, sourceId: 'alya_stat_break' })
  bs.alyaLastBreakTurn = turn

  return {
    triggered: true,
    stat,
    message: `🌘 *Alya* unravels *${target.name ?? 'the enemy'}*'s ${STAT_LABEL[stat] ?? stat.toUpperCase()} — reduced to *0* for *${STAT_BREAK_DURATION}* turns!`,
  }
}

/**
 * Dance of the Rain — checked at the same turn-advance checkpoint as
 * applyAlyaStatBreak(). Once battleState.turn reaches
 * DANCE_OF_THE_RAIN_AT_TURN, fires exactly once (bs.danceOfTheRainUsed
 * gate) and returns the multiplier the caller should feed into
 * calcPlayerDamage() for that turn's attack, same shape as
 * catFormAttackDamage()'s "just the multiplier" contract. Returns 1
 * (no-op multiplier) on every turn it doesn't trigger.
 */
export function danceOfTheRainMultiplier(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  if (!isTwinBondActive(player) || !bs) return 1
  if (bs.danceOfTheRainUsed) return 1
  if ((bs.turn ?? 1) < DANCE_OF_THE_RAIN_AT_TURN) return 1

  bs.danceOfTheRainUsed = true
  bs.danceOfTheRainActive = true // read by the caller this same turn to know to narrate it
  return DANCE_OF_THE_RAIN_MULT
}

/**
 * Narration line for the turn Dance of the Rain fires. Call once,
 * immediately after danceOfTheRainMultiplier() returns > 1 — mirrors how
 * Wither's CINDER_VERDICT narration is built alongside its multiplier.
 * Clears bs.danceOfTheRainActive so this doesn't repeat on subsequent
 * lines/messages built from the same turn.
 */
export function buildDanceOfTheRainMessage(bsOverride, player) {
  const bs = bsOverride ?? player?.battleState
  if (!bs?.danceOfTheRainActive) return ''
  bs.danceOfTheRainActive = false
  return (
    `\n\n🌗🌘 *DANCE OF THE RAIN* 🌘🌗\n` +
    `_Turn ${bs.turn ?? DANCE_OF_THE_RAIN_AT_TURN}. Tyla and Alya move as one — a single, ruinous strike._`
  )
}

/**
 * applyIncomingDamage(player, rawDamage) -> { damage, message, catFormDefeated }
 * Composite wrapper meant to REPLACE the existing two-step
 * "applyMeiSustainHeal() then player.hp = Math.max(0, player.hp - x.damage)"
 * pattern at every one of plugins/attack.js's 7 damage-application sites
 * (and pvp.js's equivalent). Order matters and mirrors how the two
 * abilities stack conceptually: Mei's sustain shaves the raw hit down
 * FIRST (as if it always applies to the player, cat form or not — her
 * damage reduction is a defensive stat, not a death-prevention mechanic),
 * THEN Tyla's clone tank checks whether the (already-sustained) hit is
 * still big enough to fully absorb, THEN the result is routed to either
 * player.hp or Yoriichi's separate pool depending on isCatFormActive().
 * Tyla and Yoriichi are mutually exclusive in practice (equippedCharacter
 * is a single id — see lib/game-data.js's characterMap), so the ordering
 * between "clone tank" and "cat form" never actually has to resolve both
 * firing on the same hit; the check order here just keeps every character
 * ability, present or future, reading through the exact same composite
 * pipeline. Callers should use this in place of calling
 * applyMeiSustainHeal()+the manual subtraction directly; the raw
 * applyMeiSustainHeal() export stays available for any call site that
 * genuinely only ever wants the Mei behavior with no cat-form awareness.
 */
export function applyIncomingDamage(player, rawDamage, bsOverride = null) {
  // Gogeta's Instant Transmission is checked before anything else, including
  // Circe's cards: this is not a defence, a block or a reduction, it is him
  // not being in the path. A hit he vanished out of never happened, so it must
  // not heal Mei, spend one of Tyla's clone-tanks, chip the cat-form pool or
  // burn Yato's tear. equippedCharacter is a single id, so this and every
  // branch below it are mutually exclusive in practice; the order is here to
  // keep one funnel readable, not to resolve a real collision.
  const vanish = rollInstantTransmission(player, bsOverride)
  if (vanish.dodged) {
    return { damage: 0, message: vanish.message, catFormDefeated: false }
  }

  // Circe's defensive cards resolve BEFORE anything else: a hit she dodged
  // (Final Dash) or that landed on a copy (Wings of a Butterfly) never
  // happened, so it must not heal Mei, must not spend one of Tyla's three
  // clone-tanks, and must not chip the cat-form pool. Last Laugh is a
  // reduction, not a block, so its output feeds the rest of the pipeline
  // normally. See resolveCirceGuard() for why these are interceptors here
  // rather than status effects.
  const guard = resolveCirceGuard(player, rawDamage)
  if (guard.blocked) {
    return { damage: 0, message: guard.message, catFormDefeated: false }
  }

  let message = guard.message || ''

  // Alexa's Lovestruck sits at the very front of the reduction chain, ahead of
  // even Gojo's Infinity, because it is not a defence at all: it is the enemy
  // failing to commit to the blow in the first place. The tier was decided at
  // the opening bell by armLovestruck() and parked on battleState, which is the
  // only reason a funnel that never sees the attacker can answer "how much will
  // does it have left". A DEVOTED enemy lands nothing, so the pipeline stops
  // here and no relic, sustain or tear is spent on a hit that was never thrown.
  const love = resolveLovestruck(player, guard.damage, bsOverride)
  if (love.message) message += (message ? '\n' : '') + love.message
  if (love.zeroed) {
    return { damage: 0, message, catFormDefeated: false }
  }

  // Gojo's Infinity is the outermost shell: the hit is thinned (or stopped
  // outright, for a small enough one) BEFORE anything downstream reacts to its
  // size, so the relic quarter, Mei's sustain and Yato's tear all read the
  // already-thinned number. Placed here, right after "did the hit happen",
  // for the same reason the relic is: applyIncomingDamage() is the one funnel
  // every struck hit passes through, PvP included. Only struck damage, never a
  // DoT — see applyInfinity()'s doc.
  const infinity = applyInfinity(player, love.damage)
  if (infinity.message) message += (message ? '\n' : '') + infinity.message
  if (infinity.nullified) {
    return { damage: 0, message, catFormDefeated: false }
  }

  // Reborn relics sit here, immediately after the "did this hit even happen"
  // question and before anything that reacts to the size of the hit. The
  // Armor of Existence cuts the hit to a quarter and the Robe of the Dragons
  // caps it at a share of max HP, so both must land BEFORE Mei's sustain
  // heals off it and before Tyla's clone decides whether it can absorb it —
  // otherwise a relic wearer would spend defensive resources on damage the
  // relic was always going to eat. Placed in this composite wrapper rather
  // than in lib/named-passives.js because applyIncomingDamage() is the one
  // funnel every incoming hit in the game passes through, PvP included.
  const relic = applyRebornDefense(player, infinity.damage)

  const sustain = applyMeiSustainHeal(player, relic.damage, bsOverride)
  if (relic.message) message += (message ? '\n' : '') + relic.message
  if (sustain.message) message += (message ? '\n' : '') + sustain.message

  const clone = applyCloneTank(player, sustain.damage)
  if (clone.tanked) {
    if (clone.message) message += (message ? '\n' : '') + clone.message
    return { damage: 0, message, catFormDefeated: false }
  }

  if (isCatFormActive(player)) {
    const cat = resolveCatFormDamage(player, sustain.damage)
    if (cat.message) message += (message ? '\n' : '') + cat.message
    if (cat.defeated) message += buildCatFormDefeatMessage()
    return { damage: 0, message, catFormDefeated: cat.defeated }
  }

  // Yato's Tear of God sits LAST, after every reduction above has had its
  // say, because it is the only one that needs to know whether the hit is
  // actually lethal — a hit Circe dodged, a relic quartered, Mei sustained or
  // a clone tanked was never a killing blow and must not spend the tear.
  const tear = resolveTearOfGod(player, sustain.damage, bsOverride)
  if (tear.saved) {
    if (tear.message) message += (message ? '\n' : '') + tear.message
    return { damage: 0, message, catFormDefeated: false }
  }

  player.hp = Math.max(0, player.hp - sustain.damage)
  return { damage: sustain.damage, message, catFormDefeated: false }
}

/**
 * isOpponentLive() and clearYoriichiCatForm() used to live here. They are part
 * of the cat-form mechanic and now live in lib/yoriichi.js with the rest of it,
 * re-exported from the top of this file so existing importers are unaffected.
 */

// ── Demon Lord Anastasia ─────────────────────────────────────────────────
/**
 * Hypnosis — the only ability in the bot that rewinds a battle instead of
 * modifying one. When her owner would die, the fight is restored to its
 * opening state and replayed, with the enemy short 15% of the health they
 * started with. Two rewinds per battle; the third death is real.
 *
 * WHY A SNAPSHOT AND NOT A HEAL
 * "Go back in time to the beginning" cannot be reconstructed after the
 * fact. The owner's HP/MP at the opening bell is not derivable from their
 * maxHp (they may have walked in at half health), and neither are the
 * enemy's rolled stats, the turn counter, or the once-per-battle latches
 * every other character ability sets. So armHypnosis() takes a deep copy
 * at battle start and resolveHypnosisRewind() restores it verbatim.
 *
 * WHAT THE REWIND RESTORES (see HYPNOSIS_SNAPSHOT_FIELDS)
 *   hp, mp, activeEffects, battleState, inBattle, inDungeon, dungeonFloor,
 *   equippedDurability
 * Restoring the whole battleState object is deliberate and does most of the
 * work for free: the enemy's HP and status effects, the turn counter,
 * abilityCooldowns, bossState phase counters, and every once-per-battle
 * latch that lives on it (finalFormUsed, witherUsed, yoriichiCatFormUsed,
 * cloneTanksUsed, ...) all come back exactly as they were. That means
 * Yoriichi genuinely gets to intercept again in the rewound timeline, which
 * is the correct reading of "the fight never happened" rather than a
 * special case anyone has to maintain.
 *
 * WHAT THE REWIND DOES *NOT* RESTORE — on purpose
 *   - player.hypnosis itself (it lives outside battleState precisely so the
 *     rewind counter survives the restore; a snapshot that contained its
 *     own counter would reset it and rewind forever)
 *   - consumables drunk mid-fight, stamina spent entering the floor, XP or
 *     drops already banked, and Urahara's permanentSever. Time going back
 *     un-fights the fight, not the shopping.
 *
 * TOLL MATH
 * The toll compounds off the enemy's opening HP, matching "loses 15% of
 * their current HP" read at each restart: rewind 1 leaves them at 85% of
 * their starting HP, rewind 2 at 85% of that (72.25%). Floored at 1 so a
 * rewind can never itself be the killing blow.
 */
const HYPNOSIS_CHARACTER_ID = 'anastasia'
const HYPNOSIS_MAX_REWINDS = 2
const HYPNOSIS_ENEMY_TOLL_PCT = 0.15
const HYPNOSIS_SNAPSHOT_FIELDS = [
  'hp', 'mp', 'activeEffects', 'battleState',
  'inBattle', 'inDungeon', 'dungeonFloor', 'equippedDurability',
]

/**
 * battleState is persisted to a JSON db, so it is JSON-serializable by
 * construction — a structuredClone would buy nothing here and JSON round-
 * tripping keeps the snapshot's shape identical to what lowdb will write.
 */
function hypnosisClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value ?? null))
}

export function hasAnastasia(player) {
  return player?.equippedCharacter === HYPNOSIS_CHARACTER_ID
}

/**
 * A fingerprint of the battle a snapshot belongs to, built only from
 * battleState fields that do NOT change across the life of one fight (turn,
 * hp, defending and the cooldown map are all deliberately excluded).
 *
 * This is the guard that stops a snapshot from one fight being restored into
 * a different one. It matters because not every battle in the bot arms her:
 * plugins/party.js builds its own `battleState = { enemy, bossState }` for
 * the season party boss and never calls armHypnosis(), so without a key
 * check a leftover snapshot from the player's last dungeon run could be
 * restored on top of a party fight — teleporting them back into a dungeon
 * mid-raid. A mismatched key simply means "no rewind here", which is the
 * correct answer for any battle Hypnosis was not armed for.
 */
function hypnosisBattleKey(player) {
  const bs = player?.battleState
  if (!bs) return null
  return JSON.stringify([
    bs.type ?? null,
    bs.opponentJid ?? null,
    bs.startedAt ?? null,
    bs.locationId ?? null,
    bs.floor ?? null,
    bs.enemy?.name ?? null,
    bs.enemy?.maxHp ?? null,
  ])
}

/**
 * armHypnosis(player, { force }) — call at battle start, AFTER battleState
 * is built and applyPassiveAbilities() has run, so the snapshot includes
 * the passives the rewind needs to put back.
 *
 * Overwriting unconditionally on every battle start is what stops a stale
 * snapshot from leaking into the next fight, which matters more than the
 * clear-on-conclude calls: those can be missed on an unusual exit path,
 * this one cannot.
 *
 * force: snapshot even without her equipped. Used for the OPPONENT in a
 * duel — a PvP rewind has to restore both sides, and the side being
 * rewound-into is by definition not the one holding her.
 */
export function armHypnosis(player, { force = false } = {}) {
  if (!player) return false
  if (!force && !hasAnastasia(player)) {
    delete player.hypnosis
    return false
  }
  const snapshot = {}
  for (const field of HYPNOSIS_SNAPSHOT_FIELDS) snapshot[field] = hypnosisClone(player[field])
  player.hypnosis = { used: 0, battleKey: hypnosisBattleKey(player), snapshot }
  return true
}

/** Rewinds still available this battle (0 if unarmed / not her owner). */
export function hypnosisRewindsLeft(player) {
  if (!hasAnastasia(player) || !player.hypnosis?.snapshot) return 0
  if (player.hypnosis.battleKey !== hypnosisBattleKey(player)) return 0
  return Math.max(0, HYPNOSIS_MAX_REWINDS - (player.hypnosis.used ?? 0))
}

/** True if a death right now would be undone rather than taken. */
export function canHypnosisRewind(player) {
  return hypnosisRewindsLeft(player) > 0
}

/**
 * The enemy's HP after `rewindNumber` tolls, given the HP they opened the
 * battle on. Exported because a PvP opponent is a separate player record
 * that pvp.js has to write inside its own updatePlayer() call — it cannot
 * be reached through the rewinding player's battleState the way a dungeon
 * monster can.
 *
 * Applied ITERATIVELY, flooring after each turn of the clock, rather than as
 * one 0.85**n multiply. Two reasons: it is literally what the ability says
 * ("15% of their current HP", re-evaluated at each restart, so rewind 2 takes
 * 15% of the 85% that survived rewind 1), and 0.85**2 is 0.7224999… in
 * binary, so the single-multiply form silently loses a point of HP — 1444
 * where the ability promises 1445. Never returns below 1: a rewind is a
 * reset, not a kill, so it must never itself finish the enemy off.
 */
export function hypnosisTolledHp(startHp, rewindNumber) {
  let hp = Math.max(0, Math.floor(Number(startHp) || 0))
  for (let i = 0; i < Math.max(0, Math.floor(rewindNumber)); i++) {
    hp = Math.floor(hp * (1 - HYPNOSIS_ENEMY_TOLL_PCT))
  }
  return Math.max(1, hp)
}

/**
 * What one specific turn of the clock costs the enemy, given the HP they
 * opened the battle on. Returns the before/after pair so the message can
 * show the toll for THIS rewind (15% of what was left) rather than the
 * cumulative gap from the opening HP, which on rewind 2 would read as a
 * "15%" that is visibly 28%.
 *
 * Exported for pvp.js, which has to apply the toll to a separate player
 * record inside its own updatePlayer() call and needs the identical numbers
 * a dungeon monster gets.
 */
export function hypnosisTollStep(openingHp, rewindNumber) {
  const before = hypnosisTolledHp(openingHp, rewindNumber - 1)
  const after = hypnosisTolledHp(openingHp, rewindNumber)
  return { before, after, dealt: before - after }
}

/**
 * restoreHypnosisSnapshot(player) -> boolean
 * Puts a player back to their battle-opening state WITHOUT consuming a
 * rewind and without requiring them to be her owner. This is the half of
 * the mechanic a duel needs: a PvP rewind has to unwind both sides, and the
 * side that just won is by definition not the one holding Anastasia, so it
 * must be restorable without touching a rewind counter it doesn't own.
 * Returns false if that player was never armed (nothing mutated).
 *
 * Deliberately does NOT check hypnosisBattleKey(): several pvp.js conclude
 * sites null the winner's battleState before calling pvpConclude, so by the
 * time this runs there is no live battle left to fingerprint. The key check
 * belongs on canHypnosisRewind() — the gate that decides whether a rewind
 * happens at all — not on the primitive that carries it out.
 */
export function restoreHypnosisSnapshot(player) {
  const snapshot = player?.hypnosis?.snapshot
  if (!snapshot) return false
  for (const field of HYPNOSIS_SNAPSHOT_FIELDS) {
    const restored = hypnosisClone(snapshot[field])
    if (restored === undefined) delete player[field]
    else player[field] = restored
  }
  return true
}

/**
 * resolveHypnosisRewind(player) -> { rewound, rewindNumber, rewindsLeft, toll }
 *
 * Restores the player to their battle-opening state and charges the toll to
 * `battleState.enemy` if there is one (dungeon/boss). In PvP there is no
 * enemy object — the opponent is their own player record — so `toll` comes
 * back null and the caller applies hypnosisTolledHp() to the opponent
 * itself. Returns { rewound: false } if no rewind was available, in which
 * case nothing was mutated and the caller should proceed to a real death.
 */
export function resolveHypnosisRewind(player) {
  if (!canHypnosisRewind(player)) return { rewound: false }

  const state = player.hypnosis
  const rewindNumber = (state.used ?? 0) + 1

  restoreHypnosisSnapshot(player)
  state.used = rewindNumber

  let toll = null
  const enemy = player.battleState?.enemy
  if (enemy) {
    // enemy.hp is the OPENING hp right now — restoreHypnosisSnapshot() just
    // put the whole battleState back — so the toll is computed off that, not
    // off whatever the enemy had been chewed down to before the rewind.
    const step = hypnosisTollStep(enemy.hp, rewindNumber)
    enemy.hp = step.after
    toll = { name: enemy.name, ...step, maxHp: enemy.maxHp }
  }

  return {
    rewound: true,
    rewindNumber,
    rewindsLeft: HYPNOSIS_MAX_REWINDS - rewindNumber,
    toll,
  }
}

/**
 * clearHypnosis(player) — call wherever a battle concludes for real
 * (victory, unrewindable death, flee, pearl, duel conclude). Hygiene only:
 * armHypnosis() overwrites on the next battle start regardless, so a missed
 * call here cannot let a snapshot from an old fight be restored into a new
 * one.
 */
export function clearHypnosis(player) {
  if (player) delete player.hypnosis
}

/**
 * The reveal block. Her copy is set in Mathematical Bold Fraktur (see
 * fraktur() in lib/format.js) — she is the bot's only Boundless-tier
 * character and her text is meant to read as visibly not-the-same-voice as
 * every other ability message. Only her own lines are styled; the stat
 * readout underneath stays plain so it remains scannable.
 */
export function buildHypnosisMessage(player, { rewindNumber, rewindsLeft, toll }) {
  const remaining = rewindsLeft === 1
    ? `One turn of the clock remains.`
    : `The clock will not turn again.`

  return (
    `\n\n🕰️ ━━━━━━━━━━━━━━━━━━━━ 🕰️\n` +
    `${fraktur('Time folds backward')}\n\n` +
    `_${fraktur('Anastasia')} lifts one hand, and the hour turns against itself._\n\n` +
    `❝ ${fraktur('Time went back. The hour of the clock reveals what your eye did not see.')} ❞\n\n` +
    `💫 The fight begins again — from the first breath.\n` +
    (toll
      ? `🩸 *${toll.name}* pays the toll: *−${toll.dealt} HP* _(${Math.round(HYPNOSIS_ENEMY_TOLL_PCT * 100)}% — now ${toll.after}/${toll.maxHp})_\n`
      : '') +
    `❤️ HP: ${player.hp}/${player.maxHp}   💧 MP: ${player.mp ?? 0}/${player.maxMp}\n` +
    `⏳ Rewind *${rewindNumber}* of *${HYPNOSIS_MAX_REWINDS}* — ${remaining}`
  )
}

/**
 * Appended to the death message on the death that Hypnosis could not undo,
 * so the owner can tell "she has no rewinds left" apart from "she never
 * fired". Returns '' for anyone who isn't her owner.
 */
export function buildHypnosisSpentLine(player) {
  if (!hasAnastasia(player)) return ''
  if ((player.hypnosis?.used ?? 0) < HYPNOSIS_MAX_REWINDS) return ''
  // No _italic_ markers: the whole line is Fraktur, which has no italic
  // variant, so the markers would buy nothing and would show up as literal
  // underscores on any client that declines to parse a non-ASCII span.
  return `\n\n🕰️ ${fraktur('The clock will not turn a third time.')}`
}

// ── Circe, the Jester — "Wild Card" ───────────────────────────────────────
/**
 * Six cards, three draws per battle, and the draw is random — "She snaps her
 * fingers, and the wheel stops. Whatever it lands on, she commits to
 * completely." So this is deliberately NOT a menu: the owner spends a draw and
 * takes what the wheel gives them.
 *
 * The three draws are labelled Opening / Mid-fight / Closing stretch after the
 * character's own description of them. Those are LABELS on draws 1-2-3, not
 * turn-window gates — nothing here forces you to wait until some turn number
 * to spend draw 3. Gating them by turn would mean a fight that ends on turn 4
 * silently voids a third of her kit.
 *
 * All of her per-battle state lives on battleState (bs.wildCard*), which the
 * engine discards at the end of every fight — the same free-reset trick
 * bs.witherUsed and bs.finalFormUsed use, so nothing has to remember to clean
 * up after her.
 */
export const CIRCE_CHARACTER_ID = 'circe'
export const WILD_CARD_MAX_USES = 3

/** Draw 1/2/3 → the character's own name for that slot. */
const WILD_CARD_SLOTS = ['Opening', 'Mid-fight', 'Closing stretch']

// Wishing Star — "there is nothing left standing where the enemy used to be."
// Against an ordinary dungeon monster that is literal: execute, no HP check.
// Bosses and duel opponents are exempt and eat the multiplier instead, because
// a 1-in-6 unconditional one-shot would decide boss fights and duels by
// coin-flip. 12x sits above Wither's Cinder Verdict (8x) and above Dance of
// the Rain (4.6x) — it is the single heaviest hit in the bot, as befits the
// rarest outcome on a Boundless character's wheel.
const WISHING_STAR_MULT = 12.0
// Fool's Gambit — she takes her own swing, then swaps places so it lands on
// them. Modest multiplier, but it cannot miss and it ignores their defense:
// the blow was never aimed at their guard.
const FOOLS_GAMBIT_MULT = 2.5
const LAST_LAUGH_TURNS = 10
const LAST_LAUGH_REDUCTION = 0.50
const BUTTERFLY_TURNS = 5
// Not immunity — enemies do occasionally connect with the real her. 60% keeps
// five turns of copies genuinely strong without reading as "the fight paused."
const BUTTERFLY_SCATTER_CHANCE = 0.60
// "This card only shows itself when she is at her limit, hit points nearly
// gone." Below this fraction of max HP the deck is 6 cards; above it, 5.
const VANISHING_ACT_HP_PCT = 0.20
// Where Vanishing Act puts her. data/locations.json has exactly one town and
// plugins/travel.js hard-codes the same id as TOWN_ID.
const CIRCE_HOME_TOWN = 'astral_town'

/**
 * The wheel. `conditional` cards are filtered out of the draw pool unless
 * their gate passes (see wildCardPool below).
 */
export const WILD_CARD_DECK = [
  {
    id: 'wishing_star',
    emoji: '🌟',
    name: 'Wishing Star',
    kind: 'damage',
    flavor: 'A single star falls from nowhere, hanging in the air above them for one heartbeat too long. She winks, blows it a kiss, and it drops.',
    quip: 'Make a wish, darling. I promise it\'ll come true.',
  },
  {
    id: 'fools_gambit',
    emoji: '🎭',
    name: "Fool's Gambit",
    kind: 'damage',
    flavor: 'She grins, raises her hand, and strikes herself first — and is already gone before the blow lands, swapped in place with her enemy in a blink of shadow and color.',
    quip: 'Oh, you thought that was for me? Silly you.',
  },
  {
    id: 'final_dash',
    emoji: '🃏',
    name: 'Final Dash',
    kind: 'state',
    flavor: 'The card flickers gold. In a single sharp motion she is no longer where she stood.',
    quip: 'Catch me if you can~',
  },
  {
    id: 'last_laugh',
    emoji: '🤡',
    name: 'Last Laugh',
    kind: 'state',
    flavor: 'She throws every card she is holding straight up into the sky. Where they land, a massive ring of light bursts open, shaped like a grinning clown\'s face.',
    quip: 'Aww, don\'t cry. The show\'s just getting good.',
  },
  {
    id: 'wings_of_a_butterfly',
    emoji: '🎪',
    name: 'Wings of a Butterfly',
    kind: 'state',
    flavor: 'She spins, and suddenly there are copies of her, all laughing the same laugh.',
    quip: 'Guess which one\'s real. You\'ve got five turns.',
  },
  {
    id: 'vanishing_act',
    emoji: '🦋',
    name: 'Vanishing Act',
    kind: 'escape',
    conditional: 'lowHp',
    flavor: 'A puff of colored smoke, and she is simply not there anymore.',
    quip: 'Encore\'s cancelled, folks. Catch me next town!',
  },
]

const WILD_CARD_BY_ID = Object.fromEntries(WILD_CARD_DECK.map(c => [c.id, c]))

/** True when this player has Circe equipped. */
export function hasCirce(player) {
  return player?.equippedCharacter === CIRCE_CHARACTER_ID
}

/** Draws already spent this battle. */
export function wildCardUsesSpent(player) {
  return player?.battleState?.wildCardUses ?? 0
}

/** Draws remaining this battle (0 for anyone who isn't her owner). */
export function wildCardUsesLeft(player) {
  if (!hasCirce(player)) return 0
  return Math.max(0, WILD_CARD_MAX_USES - wildCardUsesSpent(player))
}

/** Is she hurt badly enough for Vanishing Act to show itself? */
export function circeAtHerLimit(player) {
  const maxHp = player?.maxHp ?? 0
  if (maxHp <= 0) return false
  return (player?.hp ?? 0) <= maxHp * VANISHING_ACT_HP_PCT
}

/**
 * The cards actually on the wheel right now. Vanishing Act is an escape, so
 * it is also filtered out of duels where escaping is meaningless mid-turn —
 * see the isPvp note in resolveWildCard.
 */
export function wildCardPool(player, { allowEscape = true } = {}) {
  return WILD_CARD_DECK.filter((card) => {
    if (card.conditional !== 'lowHp') return true
    return allowEscape && circeAtHerLimit(player)
  })
}

/**
 * drawWildCard(player, opts) -> { ok, card, useNumber, slot, usesLeft } | { ok:false, message }
 * Spends one draw and returns what the wheel landed on. Gating lives here so
 * the PvE plugin and the PvP turn engine cannot disagree about it.
 */
export function drawWildCard(player, { allowEscape = true } = {}) {
  if (!hasCirce(player)) {
    return { ok: false, message: `🃏 *Wild Card* belongs to *Circe, the Jester* — equip her first.` }
  }
  if (!player.battleState) {
    return { ok: false, message: `❌ *Not in battle.*` }
  }
  const spent = wildCardUsesSpent(player)
  if (spent >= WILD_CARD_MAX_USES) {
    return {
      ok: false,
      message:
        `🃏 *Her hand is empty.*\n` +
        `_All ${WILD_CARD_MAX_USES} draws are spent this battle._`,
    }
  }

  const pool = wildCardPool(player, { allowEscape })
  const card = pool[Math.floor(Math.random() * pool.length)]
  const useNumber = spent + 1

  player.battleState.wildCardUses = useNumber

  return {
    ok: true,
    card,
    useNumber,
    slot: WILD_CARD_SLOTS[useNumber - 1] ?? `Draw ${useNumber}`,
    usesLeft: WILD_CARD_MAX_USES - useNumber,
    poolSize: pool.length,
  }
}

/**
 * resolveWildCard(player, card, opts) -> descriptor
 * Applies every state-only outcome immediately and hands damage cards back to
 * the caller as a multiplier, because PvE and PvP compute damage through
 * different engines (calcPlayerDamage/applyDefense here vs pvp.js's own
 * pipeline) — same split plugins/cinderverdict.js already uses with
 * activateCinderVerdict()'s gate.multiplier.
 *
 * Returned shape:
 *   { kind, lines, multiplier?, ignoreDefense?, guaranteedHit?, execute?, escaped? }
 */
export function resolveWildCard(player, card, { isPvp = false, enemyIsBoss = false } = {}) {
  const bs = player.battleState
  const turn = bs?.turn ?? 1
  const lines = []

  switch (card.id) {
    case 'wishing_star': {
      // Execute only where it cannot decide a fight that is supposed to be a
      // contest — see WISHING_STAR_MULT's note.
      const execute = !isPvp && !enemyIsBoss
      lines.push(
        execute
          ? `💥 The explosion swallows the battlefield in white light.`
          : `💥 The explosion swallows the battlefield in white light — and something is still standing.`,
      )
      return { kind: 'damage', multiplier: WISHING_STAR_MULT, execute, lines }
    }

    case 'fools_gambit': {
      lines.push(`🔁 *Places swapped* — the blow meant for her tears into them instead.`)
      return {
        kind: 'damage',
        multiplier: FOOLS_GAMBIT_MULT,
        ignoreDefense: true,
        guaranteedHit: true,
        lines,
      }
    }

    case 'final_dash': {
      bs.wildCardFinalDash = true
      lines.push(`🃏 *The next attack will not land.*`)
      return { kind: 'state', lines }
    }

    case 'last_laugh': {
      bs.wildCardLastLaughUntil = turn + LAST_LAUGH_TURNS
      lines.push(
        `🤡 For *${LAST_LAUGH_TURNS} turns*, every strike they throw lands ` +
        `*${Math.round(LAST_LAUGH_REDUCTION * 100)}% weaker*.`,
      )
      return { kind: 'state', lines }
    }

    case 'wings_of_a_butterfly': {
      bs.wildCardButterflyUntil = turn + BUTTERFLY_TURNS
      lines.push(
        `🎪 For *${BUTTERFLY_TURNS} turns*, attacks scatter into copies ` +
        `_(${Math.round(BUTTERFLY_SCATTER_CHANCE * 100)}% chance each)_.`,
      )
      return { kind: 'state', lines }
    }

    case 'vanishing_act': {
      player.inBattle = false
      player.battleState = null
      player.inDungeon = false
      player.location = CIRCE_HOME_TOWN
      lines.push(`🦋 *The battle ends without her.*`)
      return { kind: 'escape', escaped: true, town: CIRCE_HOME_TOWN, lines }
    }

    default:
      return { kind: 'state', lines: [] }
  }
}

/**
 * resolveCirceGuard(player, incomingDamage) -> { blocked, damage, message }
 *
 * Her three defensive cards all resolve here, and this is called from
 * applyIncomingDamage() — the one function every enemy-damage site in the bot
 * already routes through (attack.js, skill.js, defend.js, useability.js,
 * cinderverdict.js, flee.js and pvp.js all call it). Hooking one function
 * instead of ~20 call sites is why these three cards are damage interceptors
 * rather than status effects:
 *
 *   - Last Laugh could ALMOST be a 'weaken' on the enemy's attack stat, but
 *     PvE reads monster attack as a raw `e.atk` field (see calcMonsterDamage
 *     call sites) and never through getEffectiveStat(), so a weaken entry
 *     would be silently ignored by every dungeon fight.
 *   - Wings of a Butterfly could ALMOST be 'blind', but blind is only a 0.30
 *     accuracy penalty and monster hit chance is floored at 0.55
 *     (lib/combat-engine.js calcMonsterHitChance), so the enemy would still
 *     connect ~62% of the time — nothing like "no one can tell which one is
 *     real."
 *
 * Ordering is deliberate: Final Dash is a one-shot and is consumed first so a
 * lucky Butterfly scatter cannot waste it. Last Laugh is a reduction rather
 * than a block, so it applies to whatever damage survives the other two.
 *
 * Note this intentionally does not exempt true/DEF-bypassing damage the way
 * rollSerpentsGrace() exempts ctx.trueDamage. Final Dash is a single dodge off
 * a 1-in-6 draw with at most 3 draws a battle; letting it eat one boss hit is
 * the point of the card.
 */
export function resolveCirceGuard(player, incomingDamage) {
  const damage = Math.max(0, Math.floor(Number(incomingDamage) || 0))
  const bs = player?.battleState
  if (!hasCirce(player) || !bs) return { blocked: false, damage, message: '' }

  const turn = bs.turn ?? 1

  if (bs.wildCardFinalDash) {
    delete bs.wildCardFinalDash
    return {
      blocked: true,
      damage: 0,
      message: `🃏 *Final Dash!* _She slips past it like it was never a threat at all._\n❝ Catch me if you can~ ❞`,
    }
  }

  if (turn < (bs.wildCardButterflyUntil ?? 0) && Math.random() < BUTTERFLY_SCATTER_CHANCE) {
    return {
      blocked: true,
      damage: 0,
      message: `🎪 *The strike lands on a copy* — it scatters into light. _(Wings of a Butterfly)_`,
    }
  }

  if (turn < (bs.wildCardLastLaughUntil ?? 0)) {
    const reduced = Math.max(0, Math.floor(damage * (1 - LAST_LAUGH_REDUCTION)))
    return {
      blocked: false,
      damage: reduced,
      message: `🤡 *Last Laugh* softens the blow — *${damage} → ${reduced}*.`,
    }
  }

  return { blocked: false, damage, message: '' }
}

/** Turns of Last Laugh / Wings left, for status readouts. 0 when inactive. */
export function circeGuardStatus(player) {
  const bs = player?.battleState
  if (!hasCirce(player) || !bs) return { finalDash: false, lastLaugh: 0, butterfly: 0 }
  const turn = bs.turn ?? 1
  return {
    finalDash: !!bs.wildCardFinalDash,
    lastLaugh: Math.max(0, (bs.wildCardLastLaughUntil ?? 0) - turn),
    butterfly: Math.max(0, (bs.wildCardButterflyUntil ?? 0) - turn),
  }
}

/** The reveal block — activation patter, the card, its flavor and its quip. */
export function buildWildCardReveal(card, { useNumber, slot, usesLeft }, outcomeLines = []) {
  // Her own reaction line, saved for the rarest outcome on the wheel.
  const reaction = card.id === 'wishing_star' ? `\n😏 _"Ooooh, now THAT's a good one."_\n` : ''

  return (
    `🃏🎪 *WILD CARD* 🎪🃏\n` +
    `─────────────\n` +
    `💬 _"Step right up, step right up! Let's see what fate's got in her sleeve tonight!"_\n\n` +
    `🎴 _Six cards erupt into the air, spinning around her in a glittering ring._\n` +
    `✋ _She snaps her fingers, and the wheel stops._\n` +
    reaction +
    `\n${card.emoji} ━━━━━ *${card.name.toUpperCase()}* ━━━━━ ${card.emoji}\n` +
    `_${card.flavor}_\n\n` +
    (outcomeLines.length ? outcomeLines.join('\n') + '\n\n' : '') +
    `❝ ${card.quip} ❞\n\n` +
    `🎟️ *${slot}* — draw *${useNumber}* of *${WILD_CARD_MAX_USES}*` +
    (usesLeft > 0
      ? ` · _${usesLeft} left_`
      : ` · _her hand is empty_`)
  )
}

/** Lookup by id, for tests and for any caller that stores only the id. */
export function wildCardById(id) {
  return WILD_CARD_BY_ID[id] ?? null
}

// ── Xiao — "Thief's Eye" ──────────────────────────────────────────────────
/**
 * The only ability in the bot that takes a move OFF the enemy's board. Three
 * parts, and the third is the one nothing else here does:
 *
 *   1. COPY (passive, zero cost) — the last named move used against her owner
 *      is recorded on battleState as `lastEnemyMove`. Deliberately the LAST
 *      move rather than the first: timing the cast is how the player chooses
 *      what to steal, which turns a passive into a decision. Written from two
 *      places, both of which already sit on the single path every enemy move
 *      in the game passes through:
 *        - PvE bosses: buildEnemyAttack() in lib/boss-engine.js, the one
 *          function that picks a boss's named attack for every call site in
 *          the bot (attack.js, skill.js, defend.js, useability.js,
 *          cinderverdict.js, ...). It writes the field inline rather than
 *          importing this module — see recordEnemyMove()'s note below.
 *        - PvP: runPvpTurn() in plugins/pvp.js, alongside the existing
 *          resolveMegumiIncoming() call, which already computes the exact
 *          move identity this needs. Recorded onto the DEFENDER, since the
 *          defender is the side who might have Xiao equipped — the same
 *          target Megumi's own hook writes to.
 *
 *   2. CAST (.thiefseye, once per battle, no MP) — throws the copied move
 *      back through the stock calcPlayerDamage()/applyDefense() pipeline at
 *      THIEFS_EYE_MULT, then floors the result at the recorded hit times
 *      THIEFS_EYE_ECHO_MULT. See those constants for why the floor exists.
 *
 *   3. DENY (permanent, rest of battle) — the stolen move is then gone. For a
 *      boss, its name goes on bossState.thiefsEyeDenied and buildEnemyAttack()
 *      filters it out of the attack pool from that turn on. For a duel, the
 *      caller writes it to the opponent's battleState.thiefsEyeDeniedByOpponent
 *      and pvp.js refuses it at the same point frostlock already forces an
 *      action down to a basic attack.
 *
 * WHAT SHE CANNOT STEAL, AND WHY THAT IS NOT A BUG
 * Plain dungeon monsters have no named moves — attack.js resolves their turn
 * as an unnamed `e.atk` retaliation — so nothing ever writes lastEnemyMove in
 * an ordinary dungeon fight and there is nothing for her to take. She steals
 * from bosses and from other players. activateThiefsEye() says so in as many
 * words rather than failing silently, because "nothing happened" on a
 * once-per-battle ability reads exactly like a broken command.
 */
export const XIAO_CHARACTER_ID = 'xiao'

// 3.2x through the normal pipeline. For scale: a legendary skill caps at 3.0x
// (data/skill-tiers.json), Dance of the Rain is 4.6x and Cinder Verdict is
// 8.0x. She sits just above the best repeatable skill and well below the
// dedicated once-per-battle nukes, because the echo floor below is where her
// damage actually comes from against anything worth stealing from.
const THIEFS_EYE_MULT = 3.2
// ...and the floor: the echo lands for at least 1.5x the hit that taught it to
// her, applied AFTER applyDefense().
//
// The floor is the whole reason this ability reads as theft rather than as
// another multiplier. Boss damage is scaled by BOSS_DAMAGE_TO_PLAYER_SCALE and
// boss DEF is high, so a bare 3.2x player hit run through applyDefense's
// def/(def+500) curve lands soft — stealing Sukuna's Malevolent Shrine would
// deal less than the Shrine did, which is absurd on its face. Applying the
// floor after mitigation is deliberate and consistent: the move was tuned
// against the PLAYER's defense, and re-aiming someone's own technique at them
// should not then be re-mitigated by their guard. It was never aimed at it.
const THIEFS_EYE_ECHO_MULT = 1.5

/** True if the equipped character is Xiao. */
export function hasXiao(player) {
  return player?.equippedCharacter === XIAO_CHARACTER_ID
}

/**
 * recordEnemyMove(defender, move) — writes the move the defender just had used
 * against them, for Thief's Eye to copy later. Safe to call for every player in
 * every fight: it is an unconditional plain-data write with no dependency on
 * Xiao being equipped, so nothing has to check first and no other character is
 * affected by the field existing.
 *
 * `move` is { name, damage } plus optional { kind, id } for a PvP move
 * identity. Only `name` and `damage` are read by activateThiefsEye(); kind/id
 * are carried so pvp.js's deny check can match a skill by id rather than by
 * display name.
 *
 * lib/boss-engine.js writes this same field inline instead of calling this
 * function, on purpose: boss-engine is a low-level engine and this module is the
 * ability layer that imports the engines, so boss-engine -> character-abilities
 * would invert that layering (and would put boss-engine inside this module's
 * existing deliberate cycle with ./yoriichi.js). The write is two lines of plain
 * data, so the duplication is cheap. If the shape of the field ever changes,
 * boss-engine's buildEnemyAttack() is the other place to change.
 */
export function recordEnemyMove(defender, move) {
  const bs = defender?.battleState
  if (!bs || !move?.name) return
  bs.lastEnemyMove = {
    name: move.name,
    damage: Math.max(0, Math.floor(Number(move.damage) || 0)),
    kind: move.kind ?? null,
    id: move.id ?? null,
  }
}

/** The move Thief's Eye would copy right now, or null if there is nothing. */
export function stolenMoveAvailable(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  return bs?.lastEnemyMove ?? null
}

/**
 * Move names already stolen from this boss — never used again this fight.
 *
 * lib/boss-engine.js's buildEnemyAttack() does not call this: it reads
 * bossState.thiefsEyeDenied directly and filters its pool with .includes(), for
 * the same layering reason recordEnemyMove() documents — boss-engine is a low
 * level engine and this module is the ability layer that sits on top of the
 * engines, so an import in that direction would invert the dependency. If the
 * field's shape ever changes, buildEnemyAttack() is the other place to change.
 */
export function deniedMoves(bossState) {
  const denied = bossState?.thiefsEyeDenied
  return Array.isArray(denied) ? denied : []
}

/**
 * activateThiefsEye(player, bsOverride) -> { ok, message, multiplier, echoFloor, move }
 *
 * Shaped exactly like activateCinderVerdict() above — same guard order
 * (character equipped -> in battle -> once-per-battle latch), same
 * bs.<name>Used flag living on battleState so it resets for free when the fight
 * ends, and the same "return the multiplier, let the caller run the real damage
 * pipeline" contract so mitigation, crits and accuracy all still apply.
 *
 * The one addition over Wither's gate: this also needs something to copy, so it
 * fails with an explanation when lastEnemyMove is empty (see the file section
 * header for why that is a legitimate state and not an error).
 *
 * PvE DENY IS APPLIED HERE. The PvP deny is not, because it has to be written
 * to a separate player record inside pvp.js's own updatePlayer() call — the
 * returned `move` is what that caller writes.
 */
export function activateThiefsEye(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (!hasXiao(player)) {
    return { ok: false, message: `❌ You need Xiao equipped to use *.thiefseye*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  if (bs.thiefsEyeUsed) {
    return { ok: false, message: `⚠️ *Thief's Eye* has already taken something this battle.` }
  }

  const move = stolenMoveAvailable(player, bs)
  if (!move) {
    return {
      ok: false,
      message:
        `👁️ *There is nothing to take yet.*\n` +
        `─────────────\n` +
        `_Xiao can only copy a move that has a name — a boss technique, or a duelist's skill._\n\n` +
        `_Let them use something on you first. Ordinary beasts swing without naming it, and she has no interest in that._`,
    }
  }

  bs.thiefsEyeUsed = true

  // PvE deny: the boss loses this attack for the rest of the fight. Stored on
  // bossState (not battleState) so it sits with the rest of the per-boss phase
  // bookkeeping buildEnemyAttack() already reads.
  const bossState = bs.bossState
  if (bossState) {
    bossState.thiefsEyeDenied = [...deniedMoves(bossState), move.name]
  }

  return {
    ok: true,
    message: null,
    multiplier: THIEFS_EYE_MULT,
    echoFloor: Math.floor((move.damage ?? 0) * THIEFS_EYE_ECHO_MULT),
    move,
  }
}

/**
 * resolveThiefsEyeDamage(gate, mitigatedDamage) -> { damage, echoed }
 * Folds the echo floor in, and reports whether the floor is what decided the
 * number so the narration can say "the echo lands heavier than the original"
 * only when it is actually true.
 */
export function resolveThiefsEyeDamage(gate, mitigatedDamage) {
  const dealt = Math.max(0, Math.floor(Number(mitigatedDamage) || 0))
  const floor = Math.max(0, Math.floor(Number(gate?.echoFloor) || 0))
  return floor > dealt
    ? { damage: floor, echoed: true }
    : { damage: dealt, echoed: false }
}

/**
 * The theft announcement, printed BEFORE the accuracy roll — so a missed
 * Thief's Eye still reads as a theft that was attempted (and still spent, since
 * the latch is set in the gate). Split from the outcome block below for exactly
 * that reason: the header has to exist on both paths, the damage lines only on
 * one. Both live here rather than in plugins/thiefseye.js so PvE and PvP print
 * identical copy.
 */
export function buildThiefsEyeIntro(move, targetName) {
  return (
    `👁️🗝️ *THIEF'S EYE*\n` +
    `─────────────\n` +
    `_She does not flinch at it. She watches it — and then she has it._\n\n` +
    `🗡️ *${move.name}* is turned back on *${targetName}*!\n\n`
  )
}

/** Damage + echo + deny lines for a theft that connected. */
export function buildThiefsEyeOutcome(move, { damage, isCrit, echoed, targetName }) {
  return (
    `🩸 *${damage}* damage!${isCrit ? ' 💥 *CRITICAL!*' : ''}\n` +
    (echoed ? `_The echo lands heavier than the blow that taught it._\n` : '') +
    `🚫 *${move.name}* is hers now — *${targetName}* will not use it again this fight.\n`
  )
}

/**
 * recordThiefsEyeDeny(target, move) — the PvP half of part 3. Writes the stolen
 * move onto the DEFENDER's own battleState, because in a duel the "enemy" whose
 * move is being taken is a separate player record: activateThiefsEye() cannot
 * reach them the way it reaches bossState, so plugins/pvp.js calls this inside
 * the opponent's updatePlayer().
 *
 * Stores { name, id, kind } rather than just a name so the gate below can match
 * a skill by id — two skills can share a display name across skill packs, and
 * the id is what Megumi's Wheel already keys move identity on.
 */
export function recordThiefsEyeDeny(target, move) {
  const bs = target?.battleState
  if (!bs || !move?.name) return
  const denied = Array.isArray(bs.thiefsEyeDeniedByOpponent) ? bs.thiefsEyeDeniedByOpponent : []
  const id = move.id ?? null
  if (denied.some(d => d.id === id && d.name === move.name)) return
  bs.thiefsEyeDeniedByOpponent = [...denied, { name: move.name, id, kind: move.kind ?? null }]
}

/**
 * applyThiefsEyeDenyGate(actor, action, skill) -> { blocked, message }
 *
 * Enforces the deny in a duel, called from runPvpTurn() at the same point
 * applyFrostlockGate() runs. Unlike frostlock this does NOT downgrade the action
 * to a basic attack — it refuses the command outright without consuming the
 * turn, the same way "you don't know a skill called X" is handled a few lines
 * further down. That is the honest behaviour: the move does not exist for them
 * any more, so naming it is an invalid command, not a punished one.
 *
 * A PLAIN BASIC ATTACK IS NEVER DENIABLE, and that is load-bearing rather than
 * an oversight. pvp.js only records a named move (skill or signature ability)
 * as stealable, mirroring PvE — where an ordinary monster swinging without
 * naming it writes nothing. If `attack` could be taken, a duelist with no MP
 * and no usable skill would have nothing left but `.pvp defend` forever, and
 * "refuse without consuming the turn" would turn into a soft-lock. Every
 * deniable move therefore has a fallback, always.
 */
export function applyThiefsEyeDenyGate(actor, action, skill = null) {
  const denied = actor?.battleState?.thiefsEyeDeniedByOpponent
  if (!Array.isArray(denied) || !denied.length) return { blocked: false }
  if (action === 'attack' || action === 'defend') return { blocked: false }

  // Same move identity pvp.js hands to resolveMegumiIncoming(): the skill's id
  // for a skill, the action name for a signature ability.
  const id = action === 'skill' ? (skill?.id ?? '') : action
  const hit = denied.find(d => d.id === id)
  if (!hit) return { blocked: false }

  return {
    blocked: true,
    message:
      `🚫 *${hit.name}* is gone.\n` +
      `_Thief's Eye took it, and nothing she takes is ever given back. Choose something else._`,
  }
}

// ── Minna — "Hollow Exchange" ────────────────────────────────────────────────
//
// Once per battle, trade HP *percentage* with the target: she at 12% and a boss
// at 90% becomes she at 90% and the boss at the floor. It is deliberately NOT
// damage and NOT a heal — no crit roll, no applyDefense(), no
// EVENT.ENEMY_TAKE_DAMAGE, no on-hit effects, and it can never kill. Both HP
// values are written directly. Its entire value is when you call it.
//
// UNLIKE THIEF'S EYE, THIS WORKS ON ANYTHING WITH HP — plain dungeon monsters
// included. Xiao needs a *named* move to copy, so ordinary monsters give her
// nothing; Minna only needs a percentage, so there is no enemy in the bot she
// cannot trade with.
//
// The two guardrails below are what keep it from being an auto-win button, and
// they are load-bearing in opposite directions:
//
//   SELF_MAX_PCT — she must already be at or below 40% to cast. Without it this
//     is a full-HP nuke: open a boss fight at 100%, swap, and the boss is at the
//     floor before it has acted. With it, casting means you were nearly dead,
//     which is the fantasy ("hollow") and the cost in the same rule.
//
//   FLOOR_PCT — the target can never be taken below 40% of ITS max HP. Without
//     it, a percentage swap against a boss sitting at 95% is an execute, and any
//     boss fight becomes "survive to 40% HP, press one button, win". With it the
//     ability is a comeback tool that buys you a second half of the fight, and
//     the enemy still has 40% of its bar to kill you with.
//
// Because SELF_MAX_PCT === FLOOR_PCT, a legal cast always leaves the target at
// exactly the floor, and the caster always ends strictly better off than they
// started (see the proof in activateHollowExchange's comments). Nothing here
// needs a "did this actually help?" check, and the target can never GAIN HP —
// two failure modes that a naive `swap(a, b)` has and this does not.
export const MINNA_CHARACTER_ID = 'minna'

/** She must be at or below this fraction of max HP to cast at all. */
const HOLLOW_EXCHANGE_SELF_MAX_PCT = 0.40
/** The exchange can never take the target below this fraction of ITS max HP. */
const HOLLOW_EXCHANGE_FLOOR_PCT = 0.40

export function hasMinna(player) {
  return player?.equippedCharacter === MINNA_CHARACTER_ID
}

const pct = (n) => `${Math.round(n * 100)}%`

/**
 * activateHollowExchange(player, target, bsOverride)
 *   -> { ok, message, before, after }
 *
 * Guard order is copied from activateCinderVerdict/activateThiefsEye: character
 * equipped -> in battle -> once-per-battle latch -> the ability's own
 * preconditions. The latch (bs.hollowExchangeUsed) lives on battleState, which is
 * discarded when the fight ends, so it resets for free.
 *
 * EVERY REFUSAL HAPPENS BEFORE THE LATCH IS SET, so a cast that could not
 * legally land never costs the charge. That matters more here than for a damage
 * ability: the two preconditions depend on HP that moves every turn, so a player
 * WILL try this too early, and burning their one exchange on "you're not hurt
 * enough yet" would be indefensible.
 *
 * `opts.dryRun` runs every guard and returns the same { ok, message } WITHOUT
 * setting the latch or touching either HP value. Callers use it to refuse the
 * command up front — before the status/boss-turn phase spends the turn — and then
 * call again for real at the point of action. One function rather than a separate
 * canHollowExchange() so the two thresholds and the floor cannot drift between a
 * check and its apply.
 *
 * Applies the exchange itself — both `player.hp` and `target.hp` are written
 * here rather than in the plugin, so the floor and the clamps exist in exactly
 * one place and PvE and PvP cannot drift apart on them.
 *
 * @param target any object with numeric `hp`/`maxHp` — a PvE enemy, a boss, or
 *        the opposing player object in a duel.
 */
export function activateHollowExchange(player, target, bsOverride = null, { dryRun = false } = {}) {
  if (!hasMinna(player)) {
    return { ok: false, message: `🚫 *Hollow Exchange* belongs to Minna. Equip her first.` }
  }

  const bs = bsOverride ?? player?.battleState
  if (!bs) {
    return { ok: false, message: `🚫 You're not in a battle.` }
  }
  const gate = ultimateGate(player, bs, 'hollowExchange', 'Hollow Exchange',
    `🕳️ *Hollow Exchange has already been made this battle.*\n` +
    `_The space between you two is already even. There is nothing left to trade._`)
  if (gate.blocked) return { ok: false, message: gate.message }

  const playerMax = Math.max(1, Math.floor(Number(player?.maxHp) || 1))
  const targetMax = Math.max(1, Math.floor(Number(target?.maxHp) || 1))
  const playerHp  = Math.max(0, Math.floor(Number(player?.hp) || 0))
  const targetHp  = Math.max(0, Math.floor(Number(target?.hp) || 0))

  const playerPct = playerHp / playerMax
  const targetPct = targetHp / targetMax

  if (playerPct > HOLLOW_EXCHANGE_SELF_MAX_PCT) {
    return {
      ok: false,
      message:
        `🕳️ *Not hollow enough.*\n` +
        `_She has nothing to offer while there is still this much of you left. ` +
        `Come back at *${pct(HOLLOW_EXCHANGE_SELF_MAX_PCT)}* health or lower — you're at *${pct(playerPct)}*._\n` +
        `_(Your exchange is untouched.)_`,
    }
  }

  if (targetPct <= HOLLOW_EXCHANGE_FLOOR_PCT) {
    return {
      ok: false,
      message:
        `🕳️ *Nothing worth taking.*\n` +
        `_*${target?.name ?? 'Your enemy'}* is down to *${pct(targetPct)}* — as hollow as you are. ` +
        `The exchange refuses to take anyone below *${pct(HOLLOW_EXCHANGE_FLOOR_PCT)}*, so there is no gap left to trade._\n` +
        `_(Your exchange is untouched.)_`,
    }
  }

  if (dryRun) return { ok: true, dryRun: true }

  burnUltimate(player, bs, 'hollowExchange')

  // The two guards above prove playerPct <= 0.40 < targetPct, so:
  //   - the caster always gains (newPlayerPct = targetPct > playerPct), and
  //   - Math.max(playerPct, FLOOR) is always exactly FLOOR, which is always
  //     strictly below targetPct — the target always loses, never gains.
  // The Math.max is kept anyway so the intent survives someone raising
  // SELF_MAX_PCT above FLOOR_PCT later, and the Math.min is the hard promise
  // that this can never top an enemy up.
  const newPlayerPct = targetPct
  const newTargetPct = Math.min(targetPct, Math.max(playerPct, HOLLOW_EXCHANGE_FLOOR_PCT))

  const newPlayerHp = Math.max(1, Math.min(playerMax, Math.floor(playerMax * newPlayerPct)))
  const newTargetHp = Math.max(1, Math.min(targetMax, Math.floor(targetMax * newTargetPct)))

  player.hp = newPlayerHp
  target.hp = newTargetHp

  return {
    ok: true,
    before: { playerHp, targetHp, playerPct, targetPct },
    after:  { playerHp: newPlayerHp, targetHp: newTargetHp, playerPct: newPlayerPct, targetPct: newTargetPct },
    gained: newPlayerHp - playerHp,
    taken:  targetHp - newTargetHp,
  }
}

/**
 * The narration block for a completed exchange. Prints both sides of the trade
 * as percentages, because percentages are what actually moved — showing only raw
 * HP makes a swap against a high-max-HP boss look arbitrary.
 */
export function buildHollowExchangeReveal(player, target, res) {
  const targetName = target?.name ?? 'the enemy'
  return (
    `🕳️ *— HOLLOW EXCHANGE —*\n` +
    `_She does not reach for a weapon. She reaches for the difference between you._\n\n` +
    `👤 *${player?.name ?? 'You'}*  ${pct(res.before.playerPct)} → *${pct(res.after.playerPct)}*  _(+${res.gained} HP)_\n` +
    `👾 *${targetName}*  ${pct(res.before.targetPct)} → *${pct(res.after.targetPct)}*  _(−${res.taken} HP)_\n` +
    `_Not a heal. Not a wound. Even._\n`
  )
}

// ── Gojo Satoru ──────────────────────────────────────────────────────────────
//
// "Limitless" — three parts that must not overlap with anything already in the
// roster:
//
//   1. INFINITY (passive). Always live while Gojo is equipped. Every STRUCK hit
//      is thinned to a fraction before anything else reacts to its size, and a
//      hit small enough (a share of his max HP) never lands at all. This is
//      NOT Nisha's binary dodge (a hit either lands or does not), NOT the Reborn
//      relic's flat quarter (a fixed fraction with no floor), and NOT Shunya's
//      status-only immunity (raw force still wounds her fully). It is a
//      convergence: small approaches never complete, large ones arrive
//      diminished. Hooked into applyIncomingDamage() so it covers PvE and PvP
//      through the one funnel, and — like Yato's Tear — it only touches struck
//      damage, never DoTs, so burn/poison/bleed still bite him normally.
//
//   2. HOLLOW PURPLE (active, once per battle). Blue draws in, Red throws out,
//      and the imaginary mass of the two clashing erases what is between. A
//      heavy multiplier that, unlike Wither's Cinder Verdict, bypasses DEF and
//      never misses: "no armour softens" it. See plugins/purple.js.
//
//   3. UNLIMITED VOID (active, once per battle). His Domain. Pure control, no
//      damage: it floods the enemy with infinite information and locks them out
//      of acting for a few turns (a hard stun). No other character skips an
//      enemy's turn outright — Miyashi's frostlock only forces a basic attack —
//      so the lockdown is his alone. See plugins/domain.js.
//
// activateHollowPurple()/activateUnlimitedVoid() are gates ONLY, shaped exactly
// like activateCinderVerdict()/activateLiveBlast() above: equipped -> in battle
// -> once-per-battle bs latch that resets for free when battleState clears. The
// plugins run the actual turn.
export const GOJO_CHARACTER_ID = 'gojo'

/** True when `player` has Gojo (Limitless) equipped. */
export function hasLimitless(player) {
  return player?.equippedCharacter === GOJO_CHARACTER_ID
}

// Infinity tuning. The reduction is a flat share removed from every struck hit;
// the nullify floor is a share of max HP below which a hit simply never arrives.
// Deliberately distinct numbers from the Reborn relic's quarter so the two read
// differently when stacked.
const INFINITY_REDUCTION = 0.65      // struck hits arrive at 35% of their size
const INFINITY_NULLIFY_PCT = 0.10    // a hit <= 10% of Gojo's max HP never lands

/**
 * applyInfinity(player, rawDamage) -> { damage, message, nullified }
 * The passive half of Limitless, called from applyIncomingDamage() on the
 * defender. Returns the raw damage untouched for anyone who is not Gojo. For
 * Gojo: a hit at or below the nullify floor is stopped completely (nullified:
 * true, caller returns 0 and skips the rest of the pipeline); anything larger
 * is thinned by INFINITY_REDUCTION and passed on for the relic/sustain/tear
 * stages to keep reacting to.
 */
export function applyInfinity(player, rawDamage) {
  if (!hasLimitless(player)) return { damage: rawDamage, message: '', nullified: false }
  const dmg = Math.max(0, Math.round(rawDamage))
  if (dmg <= 0) return { damage: 0, message: '', nullified: false }

  const nullFloor = Math.max(1, Math.round((player.maxHp ?? player.hp ?? 0) * INFINITY_NULLIFY_PCT))
  if (dmg <= nullFloor) {
    return { damage: 0, nullified: true, message: `♾️ _Infinity holds. The blow never reaches him._` }
  }

  const thinned = Math.max(1, Math.round(dmg * (1 - INFINITY_REDUCTION)))
  return {
    damage: thinned,
    nullified: false,
    message: `♾️ _The strike slows the closer it gets, the space in front of him refusing to end. ` +
             `It arrives spent and small: ${dmg} thins to ${thinned} before it touches him._`,
  }
}

// Hollow Purple — heavy multiplier, applied by plugins/purple.js WITHOUT
// applyDefense() (bypasses DEF) and with no accuracy roll (never misses). Far
// above Cinder Verdict's 8x on purpose: it is meant to be the single hardest hit
// in the game, and it is gated behind the whole 180-spin gojo-spin dead zone.
export const HOLLOW_PURPLE_MULT = 18

/**
 * .hollowpurple gate — validates + burns the once-per-battle charge, mirroring
 * activateCinderVerdict(). Returns { ok, multiplier, message }; the caller runs
 * the damage (bypassing DEF). No MP.
 */
export function activateHollowPurple(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (!hasLimitless(player)) {
    return { ok: false, message: `❌ You need *Gojo* equipped to use *.hollowpurple*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const gate = ultimateGate(player, bs, 'hollowPurple', 'Hollow Purple')
  if (gate.blocked) return { ok: false, message: gate.message }
  burnUltimate(player, bs, 'hollowPurple')
  return { ok: true, multiplier: HOLLOW_PURPLE_MULT, message: null }
}

// Unlimited Void — the enemy is stunned for this many of their turns (the domain
// turn's own counter plus the turns after, since combat-handlers'
// processStatusTurn() checks incapacitation before it ticks the effect down).
export const UNLIMITED_VOID_STUN_TURNS = 4

/**
 * .unlimitedvoid gate — validates + burns the once-per-battle charge, mirroring
 * activateLiveBlast(). Carries no multiplier: the effect is control, not damage.
 * The caller applies the stun (UNLIMITED_VOID_STUN_TURNS) to the enemy. No MP.
 */
export function activateUnlimitedVoid(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (!hasLimitless(player)) {
    return { ok: false, message: `❌ You need *Gojo* equipped to use *.unlimitedvoid*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const gate = ultimateGate(player, bs, 'unlimitedVoid', 'Unlimited Void',
    `⚠️ *Unlimited Void* has already been opened this battle.`)
  if (gate.blocked) return { ok: false, message: gate.message }
  burnUltimate(player, bs, 'unlimitedVoid')
  return { ok: true, message: null }
}

// ── Alexa, the Witch of Love ─────────────────────────────────────────────────
//
// "Lovestruck" — she adds nothing to her owner's stats and nothing to her
// owner's damage. What she takes is the WILL of whatever is standing across
// from them, and how much will is left is decided ONCE, at the opening bell,
// by weighing the two sides against each other.
//
// THREE TIERS, ONE COMPARISON. armLovestruck() asks a single question at the
// start of a fight: who finishes first, and by how much? It answers with a
// ratio of "turns they need to kill me" over "turns I need to kill them",
// built out of the bot's own damage maths (getPrimaryStat + applyDefense, the
// same two calls every real hit goes through), so the answer tracks gear,
// buffs and debuffs rather than a made-up power score:
//
//   ratio >= 8.0  -> DEVOTED   the fight was never close. It cannot raise a
//                              hand at all: every struck hit deals 0.
//   ratio >= 1.0  -> SMITTEN   her owner is the stronger side. The enemy has
//                              no will to fight: struck hits lose 70%.
//   ratio  < 1.0  -> A SWOON   the enemy genuinely outclasses her owner and
//                              still falters: struck hits lose 20%.
//
// WHY THE TIER IS COMPUTED AT BATTLE START AND PARKED ON battleState.
// applyIncomingDamage() is the one funnel every struck hit in the game passes
// through, PvE and PvP alike, and it deliberately receives NO reference to the
// attacker. Threading one through its ~80 call sites to answer "how strong is
// the thing hitting me" would be a rewrite of combat for one character. It is
// also the wrong fiction: the willpower breaks the moment she is SEEN, when the
// enemy walks into the room, not freshly on every swing. So armLovestruck()
// runs beside armHypnosis() at each fight's opening (plugins/dungeon.js and
// plugins/pvp.js), stashes `bs.lovestruck = { tier, ... }`, and the funnel just
// reads it. It costs one object write per fight and clears itself for free when
// battleState is nulled at the end, exactly like every other per-battle latch.
//
// WHAT IT DOES NOT TOUCH. Only STRUCK damage, same rule as Gojo's Infinity and
// Yato's Tear: poison, burn, bleed and rot never route through
// applyIncomingDamage(), so they go on working at full strength against her
// owner. Nothing swung them, so there was never any will in them to break, and
// it is the honest weakness of an otherwise very strong passive.
//
// THE SECOND HALF, PvP ONLY. Her owner's rival brings a companion of their own,
// and that companion falls for her too. bs.awestruck locks the rival out of
// skills and character commands for the opening turns of the duel (they can
// still swing, defend and run), narrated by name: "Nisha is not functioning
// well, she is staring at Alexa." Dungeon monsters and bosses carry no
// equipped character, so this half is inherently duel-side.
//
// WHO IS IMMUNE. Exactly one thing in the game: The End, the world-event
// finale. Every other boss and every dungeon monster falls for her, and so does
// every rival's companion whoever it is, Circe and Anastasia and Yato included.
// There is no level requirement either: she works the moment she is equipped.
export const ALEXA_CHARACTER_ID = 'alexa'

/** True when `player` has Alexa (Lovestruck) equipped. */
export function hasAlexa(player) {
  return player?.equippedCharacter === ALEXA_CHARACTER_ID
}

/**
 * True when Lovestruck is running. Equipping her is the whole requirement; this
 * stays its own function rather than being folded into hasAlexa() because it is
 * the one place a condition would go if she is ever given one again.
 */
export function lovestruckIsLive(player) {
  return hasAlexa(player)
}

// lib/end-event.js's THE_END_BOSS_ID, written out as a bare string instead of
// imported: this module is pulled in by nearly every combat plugin and the id is
// one word, so it is not worth the import-cycle risk. The End's enemy record
// carries it as `animeBossId` (plugins/dungeon.js); the other two spellings are
// read defensively in case another spawn path ever marks it differently.
const LOVESTRUCK_IMMUNE_BOSS_ID = 'the_end'

/**
 * True only for The End. Nothing else in the game resists her, by design: no
 * character, no boss, no monster.
 */
export function bypassesLovestruck(entity) {
  if (!entity) return false
  return entity.animeBossId === LOVESTRUCK_IMMUNE_BOSS_ID
    || entity.bossId === LOVESTRUCK_IMMUNE_BOSS_ID
    || entity.id === LOVESTRUCK_IMMUNE_BOSS_ID
}

// Boss ATK is scaled on its way to the player by lib/boss-engine.js's
// BOSS_DAMAGE_TO_PLAYER_SCALE before mitigation. The comparison has to see the
// same number a real boss swing does, or every boss reads as far deadlier than
// it actually plays. Keep in step with that constant if it ever moves.
const BOSS_ATK_TO_PLAYER_SCALE = 0.60

// Tier thresholds on the turns-to-kill ratio. SMITTEN opens the moment her
// owner is the side that finishes first, which is what "the player is stronger
// than the boss" means. DEVOTED is deliberately parked far higher than that:
// "no damage at all" is for a fight that was never close, an eight-to-one race,
// not merely a comfortable win. Dropping it toward 3 makes a floor-appropriate
// boss fight completely harmless, which is not what she is for.
const LOVESTRUCK_DEVOTED_RATIO = 8.0
const LOVESTRUCK_SMITTEN_RATIO = 1.0

// A real player turn is a skill, not a poke. The comparison's player side is
// built from getPrimaryStat(), which is a bare basic attack, so it would judge
// every player as roughly a third of the damage they actually put out and slide
// almost every fight down into the swoon tier. This factor stands in for a
// realistic mixed turn (legendary skills sit at 3.0x, ordinary ones lower), and
// it is the one knob to turn if the tiers ever feel too generous or too stingy:
// raising it moves more fights up toward devoted, lowering it toward a swoon.
const LOVESTRUCK_PLAYER_THROUGHPUT = 2.5

// How many of the rival's turns their own companion spends staring instead of
// working. Bounded on purpose: an unbounded lockout stacked on top of a 70%
// damage cut makes her owner unbeatable in a duel rather than merely favoured.
// Set it to Infinity for a rival who never snaps out of it.
export const ALEXA_AWE_TURNS = 3

/**
 * The three tiers. `pct` is the share of every struck hit that never arrives;
 * 1 means the hit does not happen at all. Each tier carries its own line per
 * context (dungeon monster / boss / duel), because "a boss that outclasses you
 * pulls its swing" and "a rival who was never in your league cannot lift their
 * arm" are not the same moment and should not share one generic sentence.
 */
const LOVESTRUCK_TIERS = {
  swoon: {
    pct: 0.20,
    label: 'A SWOON',
    emoji: '💗',
    dungeon: (foe) => `_${foe} is stronger than you and knows it. The swing comes in mean and then goes soft at the very end, for no reason it could name. One look at her cost it that much._`,
    boss:    (foe) => `_${foe} has every advantage here and is not going to lose it over this. But it saw her behind you, and for one heartbeat it forgot to mean it._`,
    pvp:     (foe) => `_${foe} has you outmatched and the blow still lands politely. They caught sight of her over your shoulder, and their aim quietly apologised._`,
    echo: [
      'Another swing arrives with its heart not quite in it.',
      'Mean, and then suddenly careful.',
      'Half an eye on you, the rest of it on her.',
    ],
  },
  smitten: {
    pct: 0.70,
    label: 'LOVESTRUCK',
    emoji: '💞',
    dungeon: (foe) => `_${foe} has no will left to fight. It has fallen in love with Alexa, and what reaches you is barely a gesture at violence._`,
    boss:    (foe) => `_${foe} came into this room to end you and cannot remember agreeing to it. It has fallen in love with Alexa. The weapon still moves, because that is all it knows how to do, but there is nothing behind it now._`,
    pvp:     (foe) => `_${foe} has no will to fight you. They have fallen in love with Alexa, and every strike they throw is thrown at the wrong person._`,
    echo: [
      'Half a heart in it, and the wrong half.',
      'They are still fighting you. They stopped meaning to a while ago.',
      'The blow lands like an apology.',
    ],
  },
  devoted: {
    pct: 1,
    label: 'DEVOTED',
    emoji: '💘',
    dungeon: (foe) => `_${foe} cannot raise a hand at all. It has no will, no fight, nothing left but her, and it simply stands there being in love while you work._`,
    boss:    (foe) => `_${foe} was never in your league and has now stopped pretending. It has fallen completely in love with Alexa: lovestruck, immobile, adoring, and utterly harmless. Whatever it just tried to do to you did not happen._`,
    pvp:     (foe) => `_${foe} cannot make themselves hurt you. They have fallen completely in love with Alexa, and they stand there lovestruck and immobile while their own attack dies in their hands._`,
    echo: [
      'They try again. They cannot make themselves do it.',
      'The arm comes up, remembers her, and stops.',
      'Adoring, immobile, and completely harmless.',
    ],
  },
}

function lovestruckTierFor(ratio) {
  if (ratio >= LOVESTRUCK_DEVOTED_RATIO) return 'devoted'
  if (ratio >= LOVESTRUCK_SMITTEN_RATIO) return 'smitten'
  return 'swoon'
}

/** True for a rolled boss enemy, in any of the three ways the bot marks one. */
function isBossLike(enemy) {
  return Boolean(enemy?.isBoss || enemy?.bossState || enemy?.bossId || enemy?.isFinalBoss)
}

/**
 * The enemy side of the comparison, normalised across the three shapes the
 * "thing hitting me" can take: a rolled dungeon monster, a boss (whose ATK is
 * pre-scaled on the way out), and a duel opponent (a player record with no
 * .atk at all, whose offence is their class's primary stat).
 */
function lovestruckFoeNumbers(enemy) {
  if (typeof enemy?.atk === 'number') {
    const scale = isBossLike(enemy) ? BOSS_ATK_TO_PLAYER_SCALE : 1
    return {
      atk: Math.max(0, enemy.atk) * scale,
      def: Math.max(0, enemy.def ?? 0),
      hp:  Math.max(1, enemy.maxHp ?? enemy.hp ?? 1),
    }
  }
  let atk = 0
  let def = 0
  try {
    atk = Math.max(0, getPrimaryStat(enemy) ?? 0)
    def = Math.max(0, getEffectiveStat(enemy, 'def') ?? 0)
  } catch {
    // A malformed opponent record must never take a fight down; a zeroed foe
    // simply reads as harmless, which is the safe direction for a passive that
    // only ever reduces damage.
    atk = Math.max(0, enemy?.stats?.str ?? 0)
    def = Math.max(0, enemy?.stats?.def ?? 0)
  }
  // A duel opponent is player-shaped, so their offence gets the same throughput
  // factor her owner's does. Without it the comparison would flatter whoever
  // holds her and read a mirror-match duel as a walkover. Monster ATK needs no
  // such correction: a monster's atk already IS its damage for the turn.
  return {
    atk: atk * LOVESTRUCK_PLAYER_THROUGHPUT,
    def,
    hp: Math.max(1, enemy?.maxHp ?? enemy?.hp ?? 1),
  }
}

/**
 * lovestruckRatio(player, enemy) -> number
 * "Turns they need to put me down" over "turns I need to put them down". Above
 * 1 means her owner is the stronger side; the further above, the less of a
 * fight it ever was. Built from applyDefense() so armour on either side counts,
 * and from maxHp rather than current HP so the tier does not drift mid-fight
 * (the will breaks on sight, once).
 */
function lovestruckRatio(player, enemy) {
  const foe   = lovestruckFoeNumbers(enemy)
  const myAtk = Math.max(0, getPrimaryStat(player) ?? 0) * LOVESTRUCK_PLAYER_THROUGHPUT
  const myDef = Math.max(0, getEffectiveStat(player, 'def') ?? 0)
  const myHp  = Math.max(1, player?.maxHp ?? player?.hp ?? 1)

  const myDmg  = Math.max(1, applyDefense(myAtk, foe.def))
  const foeDmg = Math.max(1, applyDefense(foe.atk, myDef))

  const myTurnsToKill  = foe.hp / myDmg
  const foeTurnsToKill = myHp / foeDmg
  if (!Number.isFinite(myTurnsToKill) || myTurnsToKill <= 0) return LOVESTRUCK_DEVOTED_RATIO
  return foeTurnsToKill / myTurnsToKill
}

/**
 * armLovestruck(self, opponent, opts) -> the armed tier record, or null.
 *
 * Called once per fight, right after battleState is built and after
 * applyPassiveAbilities(), beside armHypnosis(). Handles BOTH directions in one
 * call, because each side of a duel arms its own record and each needs to know
 * about the other:
 *
 *   1. `self` holds Alexa  -> bs.lovestruck, read by applyIncomingDamage() to
 *      thin (or erase) every struck hit `self` takes for the rest of the fight.
 *   2. `opponent` holds Alexa -> bs.awestruck, read by applyAweGate() to lock
 *      `self`'s own companion out of skills while they stand there staring.
 *
 * Always clears both first, so a stale latch from an earlier fight can never
 * ride into a new one on a record that was saved mid-battle. No-op for anyone
 * who is not in a fight, and no-op in both directions if neither side has her.
 */
export function armLovestruck(self, opponent = null, opts = {}) {
  const bs = opts.bsOverride ?? self?.battleState
  if (!bs) return null

  bs.lovestruck = null
  bs.awestruck  = null

  if (lovestruckIsLive(self) && opponent && !bypassesLovestruck(opponent)) {
    const tier = lovestruckTierFor(lovestruckRatio(self, opponent))
    bs.lovestruck = {
      tier,
      pct:     LOVESTRUCK_TIERS[tier].pct,
      foe:     opponent?.name ?? 'the enemy',
      context: bs.type === 'pvp' ? 'pvp' : (isBossLike(opponent) ? 'boss' : 'dungeon'),
      shown:   false,
      beats:   0,
    }
  }

  if (opponent && lovestruckIsLive(opponent)) {
    const mine = self?.equippedCharacter ? getEquippedCharacter(self) : null
    const mineId = mine?.id ?? self?.equippedCharacter ?? null
    // Every companion in the roster falls for her, no exceptions. The only
    // requirement is that the rival brought one at all.
    if (mineId) {
      bs.awestruck = {
        charId:    mineId,
        charName:  mine?.name ?? mineId,
        charEmoji: mine?.emoji ?? '💗',
        turnsLeft: ALEXA_AWE_TURNS,
        shown:     false,
      }
    }
  }

  return bs.lovestruck
}

/** Which of the three per-context lines a tier should use. */
function lovestruckLine(tier, state) {
  const ctx = state?.context === 'pvp' ? 'pvp' : state?.context === 'boss' ? 'boss' : 'dungeon'
  return tier[ctx](state?.foe ?? 'the enemy')
}

/** The full reveal, printed once per fight on the first struck hit. */
function lovestruckRevealBlock(state, tier, raw, kept) {
  const numbers = tier.pct >= 1
    ? `_${raw} was coming. Nothing arrives._`
    : `_${raw} was coming. *${kept}* arrives._`
  return (
    `${tier.emoji} *· ${tier.label} ·*\n` +
    `${lovestruckLine(tier, state)}\n` +
    numbers
  )
}

/** The short line on every struck hit after the reveal. */
function lovestruckEchoLine(state, tier, raw, kept) {
  const line = tier.echo[(state.beats ?? 1) % tier.echo.length]
  const tail = tier.pct >= 1 ? `${raw} → nothing` : `${raw} → ${kept}`
  return `${tier.emoji} _${line} (${tail})_`
}

/**
 * resolveLovestruck(player, rawDamage, bsOverride) -> { damage, message, zeroed }
 *
 * The passive half, called from applyIncomingDamage() on the defender. Returns
 * the hit untouched for anyone without an armed tier. `zeroed` is true only for
 * the devoted tier, where the caller stops the pipeline dead: a hit that was
 * never thrown must not heal Mei, spend a clone, or burn Yato's tear. A
 * rawDamage of 0 passes straight through so a no-damage call behaves exactly as
 * it did before she existed.
 */
export function resolveLovestruck(player, rawDamage, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  const state = bs?.lovestruck
  if (!state) return { damage: rawDamage, message: '', zeroed: false }

  const dmg = Math.max(0, Math.round(rawDamage))
  if (dmg <= 0) return { damage: rawDamage, message: '', zeroed: false }

  const tier = LOVESTRUCK_TIERS[state.tier] ?? LOVESTRUCK_TIERS.swoon
  const kept = tier.pct >= 1 ? 0 : Math.max(1, Math.round(dmg * (1 - tier.pct)))

  state.beats = (state.beats ?? 0) + 1
  let message
  if (state.shown) {
    message = lovestruckEchoLine(state, tier, dmg, kept)
  } else {
    state.shown = true
    message = lovestruckRevealBlock(state, tier, dmg, kept)
  }

  return { damage: kept, message, zeroed: tier.pct >= 1 }
}

// Actions that are never taken away from an awestruck duelist: they can always
// swing, brace, or walk out of the fight. Everything else (skills, character
// commands, ultimates) belongs to a companion who is currently not working.
const AWE_ALLOWED_ACTIONS = new Set(['attack', 'defend', 'flee', 'forfeit', 'surrender'])

/**
 * applyAweGate(actor, requestedAction) -> { blocked, action, message }
 *
 * Shaped exactly like applyFrostlockGate() and called next to it in
 * runPvpTurn(): a blocked action is DOWNGRADED to a basic attack rather than
 * skipped, so the actor still gets their turn, just without the companion who
 * is busy being in love. Ticks down every turn it is live, whatever the actor
 * asked for, and narrates itself once on the way in and once on the way out.
 */
export function applyAweGate(actor, requestedAction) {
  const awe = actor?.battleState?.awestruck
  if (!awe || (awe.turnsLeft ?? 0) <= 0) {
    return { blocked: false, action: requestedAction, message: '' }
  }

  awe.turnsLeft -= 1
  const broke = awe.turnsLeft <= 0
  const who = `${awe.charEmoji ?? '💗'} *${awe.charName}*`

  const lines = []
  if (!awe.shown) {
    awe.shown = true
    lines.push(
      `${who} is not functioning well: stood there in awe, staring at *Alexa*, ` +
      `and not hearing a word ${actor?.name ?? 'you'} says.`,
    )
  }

  const blocked = !AWE_ALLOWED_ACTIONS.has(requestedAction)
  if (blocked) {
    lines.push(`_${awe.charName} will not answer. ${actor?.name ?? 'You'} swings alone._`)
  }
  if (broke) {
    lines.push(`_${awe.charName} finally looks away. Whatever that was, it is over._`)
  }

  return {
    blocked,
    action: blocked ? 'attack' : requestedAction,
    message: lines.length ? lines.join('\n') : '',
  }
}

// ── Red Rose — "Puppet Strings" ──────────────────────────────────────────────
//
// Puppetry, and the one thing nothing else in the roster does: she turns the
// enemy's own body against them. Once per battle, no MP, she takes the strings
// and the enemy strikes ITSELF — the blow is built from the enemy's own attack,
// run through the enemy's own defense, so a hard-hitting foe wounds itself hard
// and a well-armoured one shrugs part of it off. Then the strings hold a single
// beat (a 1-turn tangle) and the enemy loses its next action too.
//
// WHY IT IS NOT ANY OF THE CONTROL ABILITIES ALREADY HERE, on purpose:
//   - Gojo's Unlimited Void is a pure 4-turn LOCKOUT with no damage. Puppetry
//     tangles for a single turn and its whole point is the self-damage. It is
//     deliberately far weaker as a lock and unique as a strike.
//   - Miyashi's Frostlock forces the enemy into a basic attack AIMED AT YOU.
//     Puppetry aims the enemy AT ITSELF.
//   - Xiao's Thief's Eye STEALS a named move for good. Puppetry steals nothing
//     and copies nothing; it borrows the enemy's next swing and points it home.
//   - Circe's Fool's Gambit is a random, reactive place-swap on one incoming
//     blow. Puppetry is deterministic, chosen, once, off the enemy's own stats.
//   - Alexa's Lovestruck only ever thins incoming damage. Puppetry deals it.
//
// WHY IT IS NOT OVERPOWERED. Three guardrails, all load-bearing:
//   1. Once per battle, no MP, latched on battleState like every other active.
//   2. The self-hit can NEVER take the enemy below PUPPET_FLOOR_PCT of its max
//      HP. It is a tempo swing and a chunk of chip, never a one-button kill —
//      the same discipline as Minna's Hollow Exchange floor. Against anything
//      already at or below the floor there is simply nothing to take.
//   3. The tangle is ONE turn. She denies the enemy a single action; she does
//      not lock a fight down.
//
// WORKS ON ANYTHING WITH HP, unlike Xiao (who needs a named move to copy):
// ordinary monsters, bosses and duel opponents all have an attack stat and a
// defense stat, which is all puppetSelfNumbers() needs. "Even their characters"
// is the duel half: in a duel the tangle skips the opponent's whole next turn,
// so their equipped companion hangs limp on the strings right alongside them.
//
// activatePuppetStrings() is a GATE ONLY, shaped exactly like
// activateUnlimitedVoid(): equipped -> in battle -> once-per-battle latch that
// resets for free when battleState clears. The caller (plugins/puppetry.js for
// PvE, plugins/pvp.js's opponent phase for a duel) runs resolvePuppetSelfHit()
// against the writable enemy and applies the tangle, the same split the void
// uses between its actor-phase gate and its opponent-phase effect.
export const RED_ROSE_CHARACTER_ID = 'red_rose'

// The enemy's own swing, turned inward. Above 1.0 because a puppet does not
// hesitate the way a real fighter pulls a blow — but nowhere near the dedicated
// nukes (Cinder Verdict 8x, Hollow Purple 18x): this is the ENEMY's attack, not
// hers, and it is capped hard by the floor below.
const PUPPET_SELF_MULT = 1.6
// The self-hit can never bring the enemy below this share of its max HP.
const PUPPET_FLOOR_PCT = 0.20
// Turns the enemy stays tangled after striking itself. One, deliberately — see
// the header: her control is a redirect, not Gojo's lockout.
export const PUPPET_TANGLE_TURNS = 1

/** True when `player` has Red Rose (Puppet Strings) equipped. */
export function hasRedRose(player) {
  return player?.equippedCharacter === RED_ROSE_CHARACTER_ID
}

/**
 * activatePuppetStrings(player, bsOverride) -> { ok, message }
 *
 * Pure gate, identical in shape to activateUnlimitedVoid(): validates the
 * character, the battle, and the once-per-battle latch, and burns the charge on
 * success. It computes and applies NOTHING — the caller runs resolvePuppetSelfHit()
 * against the writable enemy and places the tangle, so PvE and PvP can each own
 * their own write and defeat check without this function needing a writable enemy.
 * A failed gate never spends the charge.
 */
export function activatePuppetStrings(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (!hasRedRose(player)) {
    return { ok: false, message: `❌ You need *Red Rose* equipped to use *.puppet*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const gate = ultimateGate(player, bs, 'puppetStrings', 'Puppet Strings',
    `🌹 *The strings are already cut this battle.*\n` +
    `_A marionette only dances once. What was hers to move, she has moved._`)
  if (gate.blocked) return { ok: false, message: gate.message }
  burnUltimate(player, bs, 'puppetStrings')
  return { ok: true, message: null }
}

/**
 * The enemy's attack/defense, normalised across the three shapes the target can
 * take — a rolled dungeon monster / boss (numeric .atk/.def, boss atk already
 * pre-scaled by the engine) and a duel opponent (a player record whose offence
 * is their class's primary stat). Same normalisation lovestruckFoeNumbers() does.
 */
function puppetSelfNumbers(enemy) {
  if (typeof enemy?.atk === 'number') {
    return { atk: Math.max(0, enemy.atk), def: Math.max(0, enemy.def ?? 0) }
  }
  let atk = 0
  let def = 0
  try {
    atk = Math.max(0, getPrimaryStat(enemy) ?? 0)
    def = Math.max(0, getEffectiveStat(enemy, 'def') ?? 0)
  } catch {
    atk = Math.max(0, enemy?.stats?.str ?? 0)
    def = Math.max(0, enemy?.stats?.def ?? 0)
  }
  return { atk, def }
}

/**
 * resolvePuppetSelfHit(enemy) -> { raw, dealt, newHp, floored, floorHp }
 *
 * Computes the self-strike WITHOUT writing enemy.hp — the caller sets
 * enemy.hp = res.newHp so PvE and PvP keep their own defeat handling. `raw` is
 * the enemy's own PUPPET_SELF_MULT swing run through its own defense;
 * PUPPET_FLOOR_PCT of the enemy's max HP is the hard floor the hit stops at, so
 * `floored` reports when the floor is what decided the number (nothing lethal,
 * ever). `dealt` is 0 when the enemy is already at or below the floor.
 */
export function resolvePuppetSelfHit(enemy) {
  const { atk, def } = puppetSelfNumbers(enemy)
  const maxHp = Math.max(1, Math.floor(Number(enemy?.maxHp ?? enemy?.hp ?? 1)))
  const hp    = Math.max(0, Math.floor(Number(enemy?.hp ?? 0)))
  const raw   = Math.max(1, Math.floor(applyDefense(atk * PUPPET_SELF_MULT, def)))
  const floorHp = Math.floor(maxHp * PUPPET_FLOOR_PCT)
  // Never lethal, and never a HEAL: if the enemy is already at or below the
  // floor (chipped there by other damage), the min() keeps it where it is
  // instead of Math.max() raising it back up to floorHp.
  const newHp = Math.min(hp, Math.max(floorHp, hp - raw))
  const dealt = Math.max(0, hp - newHp)
  return { raw, dealt, newHp, floored: dealt < raw, floorHp }
}

/**
 * The reveal for a puppetry turn. `context` is 'dungeon' | 'boss' | 'pvp'; the
 * closing line changes only for a duel, where the fantasy is that the rival's
 * own companion is caught on the strings too.
 */
export function buildPuppetStringsReveal(ownerName, enemyName, res, { context = 'dungeon', tangled = true, immune = false } = {}) {
  const strike = res.dealt > 0
    ? (res.floored
        ? `🩸 Its own blow lands for *${res.dealt}* before the strings ease off. She will not let a puppet break in her hands.`
        : `🩸 Its own blow lands for *${res.dealt}* on the one who threw it.`)
    : `🩸 _There was almost nothing left of it to turn, and the strike barely stirs._`

  const tail = immune
    ? `\n⭕ _It tears free of the strings a heartbeat early. Whatever it is, it does not stay held._`
    : tangled
      ? (context === 'pvp'
          ? `\n🎭 _Tangled. ${enemyName} and the companion at their side both hang limp for a turn. She has the both of them._`
          : `\n🎭 _Tangled. ${enemyName} hangs on her strings for a turn and cannot move._`)
      : ''

  return (
    `🌹🎀 *PUPPET STRINGS*\n` +
    `─────────────\n` +
    `_${ownerName} lifts one hand, and *${enemyName}* is no longer the one deciding where it moves._\n` +
    `_The strings pull taut. It raises its own weapon, and it does not get a say in where it comes down._\n\n` +
    `${strike}` +
    tail
  )
}

// ── Naruto Uzumaki (Baryon Mode) ─────────────────────────────────────────
// Naruto's one combat move: .kurama. Modeled on Nisha's dragon (a summoned
// companion, once per battle, cinematic) but boss-safe and multi-mode like Red
// Rose's Puppet Strings — it works in PvE (boss/monster/swarm), party dungeons
// and PvP duels, the same three places .puppet does. Two things make it unlike
// every other active in the roster:
//
//   1. It costs the USER health. Baryon Mode burns Naruto's own lifespan to
//      fuel the fusion (KURAMA_SELF_COST_PCT of his max HP), floored so it can
//      never self-kill (he is always left on at least 1 HP). No other active
//      hurts its own caster — this is the gamble that balances the payload.
//   2. It carries a lifespan-drain rider. On top of the KURAMA_MULT strike
//      (run through the stock calcPlayerDamage -> applyDefense pipeline, so
//      DEF, crits and accuracy all still apply, exactly like Cinder Verdict),
//      the enemy loses a flat KURAMA_DRAIN_PCT of its MAX HP as true damage
//      that no armour touches — "anything Baryon touches loses lifespan."
//
// activateKurama() is the gate: it validates, burns the once-per-battle charge
// (bs.kuramaUsed) and applies the self-cost, returning the multiplier + drain
// for the caller to run through its own pipeline. PvE plugin, party handler and
// the PvP turn engine each own their own enemy write and defeat check, exactly
// as activateCinderVerdict / activatePuppetStrings do.
export const NARUTO_CHARACTER_ID = 'naruto'
export const KURAMA_MULT = 5.5           // the fusion strike, through calcPlayerDamage->applyDefense
export const KURAMA_DRAIN_PCT = 0.08     // + this share of the enemy's MAX HP as true damage (rider)
const KURAMA_SELF_COST_PCT = 0.15        // Baryon burns this share of Naruto's MAX HP to summon (never lethal)
// The Nine Tails summon splash, shown the moment Baryon Mode commits, in every
// battle format. Sent as its own message (sendKuramaSummonImage), so a dead
// image host degrades to text and never blocks the turn, same as Megumi's
// Domain splash and Gogeta's Kamehameha.
export const KURAMA_SUMMON_IMAGE = 'https://i.ibb.co/Kx2tT0gs/when-summon-inb-balle.jpg'

/** True when `player` has Naruto (Baryon Mode) equipped. */
export function hasNaruto(player) {
  return player?.equippedCharacter === NARUTO_CHARACTER_ID
}

// Naruto's voice. The reveal picks a line by context so his words read a little
// differently facing a tower master, a rival duelist, or fighting beside a party.
const NARUTO_LINES = {
  boss: [
    'You are strong. That is exactly why I am not holding anything back.',
    'Kurama. One more time. Lend me everything you have.',
    'I did not climb this whole way just to lose here.',
  ],
  pvp: [
    'No hard feelings. Kurama and I settle this in one move.',
    'You wanted my best, so here it is. All of it.',
    'I never go back on my word. That is my nindo.',
  ],
  party: [
    'Cover me. Kurama and I will tear a hole in their line.',
    'Everyone get back, this one is ours.',
    'Leave the big one to me and the fox.',
  ],
  dungeon: [
    'Kurama, we are doing this together.',
    'One shot. Let us make it count.',
    'Baryon Mode. Time to end this fast.',
  ],
}

/** A random Naruto battle line for the given context ('boss'|'pvp'|'party'|'dungeon'). */
export function narutoBattleLine(context = 'dungeon') {
  const pool = NARUTO_LINES[context] ?? NARUTO_LINES.dungeon
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * activateKurama(player, bsOverride)
 *   -> { ok, multiplier, drainPct, selfCost, selfCostLine, message }
 *
 * Pure gate + self-cost, same shape as activateCinderVerdict()/activatePuppetStrings():
 * validates character/battle/once-per-battle latch, burns the charge, and burns
 * Naruto's own lifespan to fuel the fusion (floored so he is never left below 1
 * HP). It computes NO enemy damage — it hands back the multiplier and drain
 * percentage for the caller to run through its own pipeline. A failed gate never
 * spends the charge and never costs health.
 */
export function activateKurama(player, bsOverride = null) {
  const bs = bsOverride ?? player.battleState
  if (!hasNaruto(player)) {
    return { ok: false, message: `❌ You need *Naruto (Baryon Mode)* equipped to use *.kurama*.` }
  }
  if (!player.inBattle || !bs) {
    return { ok: false, message: `❌ Not in battle.` }
  }
  const gate = ultimateGate(player, bs, 'kurama', 'Baryon Mode',
    `🦊 *Kurama has already answered this battle.*\n` +
    `_Baryon Mode burns once. There is nothing left to spend a second time._`)
  if (gate.blocked) return { ok: false, message: gate.message }
  burnUltimate(player, bs, 'kurama')

  // Baryon self-cost — burns Naruto's own lifespan, floored so he keeps >= 1 HP.
  const maxHp = Math.max(1, Math.floor(Number(player.maxHp ?? player.hp ?? 1)))
  const hp = Math.max(1, Math.floor(Number(player.hp ?? 1)))
  const selfCost = Math.min(Math.max(0, hp - 1), Math.floor(maxHp * KURAMA_SELF_COST_PCT))
  player.hp = Math.max(1, hp - selfCost)

  const selfCostLine = selfCost > 0
    ? `🩸 _Baryon Mode eats its own fuel. Naruto burns *${selfCost}* of his own lifespan to hold the fusion._`
    : null

  return { ok: true, multiplier: KURAMA_MULT, drainPct: KURAMA_DRAIN_PCT, selfCost, selfCostLine, message: null }
}

/**
 * resolveKuramaDrain(enemy, drainPct = KURAMA_DRAIN_PCT) -> { drain, newHp }
 *
 * The lifespan-drain rider. Computes a flat share of the enemy's MAX HP as true
 * damage WITHOUT writing enemy.hp — the caller sets enemy.hp = res.newHp so PvE,
 * party and PvP keep their own defeat handling. It is applied AFTER the main
 * strike, so the combined assault can finish an enemy the strike left standing;
 * on its own it is just a chunk of chip that no armour reduces.
 */
export function resolveKuramaDrain(enemy, drainPct = KURAMA_DRAIN_PCT) {
  const maxHp = Math.max(1, Math.floor(Number(enemy?.maxHp ?? enemy?.hp ?? 1)))
  const hp = Math.max(0, Math.floor(Number(enemy?.hp ?? 0)))
  const drain = Math.max(0, Math.floor(maxHp * drainPct))
  const newHp = Math.max(0, hp - drain)
  return { drain, newHp }
}

/**
 * The reveal for a Kurama summon. `context` is 'dungeon' | 'boss' | 'pvp' | 'party'.
 * Carries Naruto's voice (narutoBattleLine) and the full Baryon beat: the fusion,
 * the strike, and the lifespan drain. The caller shows the self-cost line first.
 */
export function buildKuramaReveal(ownerName, enemyName, { mainDmg = 0, isCrit = false, drain = 0, missed = false, context = 'dungeon' } = {}) {
  const say = narutoBattleLine(context)
  const head =
    `🦊🌀 *BARYON MODE: KURAMA*\n` +
    `─────────────\n` +
    `💬 _"${say}"_\n` +
    `_${ownerName} and the Nine Tails fold into one. The air turns to fire, and *${enemyName}* is already too slow._\n\n`

  if (missed) {
    return head + `💨 _The fusion overshoots by a hair. The strike tears past *${enemyName}* and *MISSES!*_`
  }

  const strike = `🌠 *Baryon Rasengan* lands for *${mainDmg}*!${isCrit ? ' 💥 *CRITICAL!*' : ''}`
  const rider = drain > 0
    ? `\n🦊 _The fox's touch drags the lifespan out of *${enemyName}*: *${drain}* more, and no armour in the world softens it._`
    : ''
  return head + strike + rider
}

/**
 * The Nine Tails summon splash as its OWN message, fired the moment Baryon Mode
 * commits (before the turn text), in every battle format. Defaults to ctx.from
 * so it lands in the fight's chat, and swallows any media failure so a dead
 * image host degrades to text and never blocks the turn — the same treatment as
 * sendDomainImage/sendKamehamehaImage.
 */
export function sendKuramaSummonImage(ctx, caption = '', recipient = ctx.from) {
  return sendImageTo(ctx, KURAMA_SUMMON_IMAGE, caption, recipient).catch(() => {})
}



