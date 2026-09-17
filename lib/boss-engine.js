/**
 * lib/boss-engine.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Boss Engine: bridges boss definition files (bosses/*.js) with the existing
 * combat loop in attack.js / skill.js / defend.js.
 *
 * INTEGRATION PATTERN
 * ───────────────────
 * When a fight starts with a boss:
 *   1. Call initBossFight(player, bossId)
 *      - Loads the boss definition
 *      - Seeds player.battleState.enemy from the definition's stats
 *      - Initialises player.battleState.bossState (special mechanic state)
 *
 * Each turn (call after attack / skill / defend resolves):
 *   2. applyBossSpecial(player, event, context)
 *      - event: one of the EVENT_* constants below
 *      - context: { damage, skillId, element, isCrit, isHit, isMiss }
 *      Returns a result object with { modified, narrativeLine, statChanges }
 *
 * Phase transitions:
 *   3. checkBossPhase(player) after HP changes
 *      Returns a phase-transition object if a threshold is crossed or null.
 *
 * On enemy attack turn:
 *   4. buildEnemyAttack(player)
 *      Returns { damage, narrativeLine, statusEffects[] }
 *      Incorporates any bossState ATK bonuses set by specials.
 *
 * On fight end:
 *   5. cleanupBossFight(player) — resets bossState safely.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getBossById } from '../bosses/index.js'

// ─── Event constants ─────────────────────────────────────────────────────────
export const EVENT = {
  PLAYER_BASIC_ATTACK:  'on_basic_attack',
  PLAYER_SKILL_ATTACK:  'on_skill_attack',
  PLAYER_DEFEND:        'on_player_defend',
  PLAYER_HIT_ENEMY:     'on_player_hit',
  PLAYER_MISS:          'on_player_miss',
  ENEMY_DEAL_DAMAGE:    'on_deal_damage',
  ENEMY_TAKE_DAMAGE:    'on_incoming_damage',
  TURN_START:           'turn_start',
  TURN_END:             'turn_end',
  FIGHT_INIT:           'fight_init',
}

// ─── Grade stat multipliers ───────────────────────────────────────────────────
const GRADE_MULT = {
  SS:    { hp: 1.0, atk: 1.0, def: 1.0 },
  'SS+': { hp: 1.4, atk: 1.3, def: 1.2 },
  SSS:   { hp: 2.0, atk: 1.7, def: 1.5 },
  'SSS+':{ hp: 3.0, atk: 2.2, def: 2.0 },
  MYTHIC:{ hp: 4.5, atk: 3.0, def: 2.8 },
  OMNI:  { hp: 8.0, atk: 6.0, def: 5.0 },
}

// Boss stats use the floor as the difficulty curve. This keeps the roster
// varied without allowing grade multipliers to turn late bosses into 100k+
// damage sponges.
const BOSS_BALANCE = {
  minFloor: 65,
  maxFloor: 100,
  minHp: 10_000,
  maxHp: 50_000,
  minDef: 350,
  maxDef: 1_800,
  attackScale: 0.50,
  maxAtk: 4_500,
}
const BOSS_DAMAGE_TO_PLAYER_SCALE = 0.60

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fight initialisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise a boss fight.
 *
 * @param {object} player  - Full player document from the DB.
 * @param {string} bossId  - Boss id string (e.g. 'gojo_satoru').
 * @param {number} [encounterFloor] - The floor this boss is actually being
 *   fought on. Boss HP and DEF are determined by the encounter floor, not by
 *   the character's raw definition or grade multiplier.
 * @returns {{ ok: boolean, enemy: object, bossState: object, entranceLine: string }}
 */
export function initBossFight(player, bossId, encounterFloor = null) {
  const def = getBossById(bossId)
  if (!def) return { ok: false, error: `Unknown boss: ${bossId}` }

  const mult = GRADE_MULT[def.grade] ?? GRADE_MULT['SS']
  const homeFloor = def.floor ?? encounterFloor ?? BOSS_BALANCE.minFloor
  const floor = encounterFloor ?? homeFloor
  const floorRatio = Math.min(
    1,
    Math.max(
      0,
      (floor - BOSS_BALANCE.minFloor) /
        (BOSS_BALANCE.maxFloor - BOSS_BALANCE.minFloor),
    ),
  )
  const scaledHp = Math.round(
    BOSS_BALANCE.minHp +
      (BOSS_BALANCE.maxHp - BOSS_BALANCE.minHp) * floorRatio,
  )
  const balancedDef = Math.round(
    BOSS_BALANCE.minDef +
      (BOSS_BALANCE.maxDef - BOSS_BALANCE.minDef) * floorRatio,
  )
  const scaledAtk = Math.min(
    BOSS_BALANCE.maxAtk,
    Math.max(
      700,
      Math.round(def.atk * mult.atk * BOSS_BALANCE.attackScale),
    ),
  )

  // A boss may pin its combat stats via def.statOverride, bypassing the floor
  // curve entirely. Used for deliberately off-curve encounters like the
  // Season 1 End boss (floor 50, which the curve would otherwise clamp to the
  // 10k HP minimum). baseAtk still tracks the FINAL atk so escalation mechanics
  // (e.g. The Tide Rises) have a stable reference point to scale against.
  const ov       = def.statOverride ?? null
  const finalHp  = ov?.hp  ?? scaledHp
  const finalDef = ov?.def ?? balancedDef
  const finalAtk = ov?.atk ?? scaledAtk

  // Build the enemy object that gets stored in player.battleState.enemy.
  // We keep the raw def available on bossState for narrative lookups.
  const enemy = {
    id:       def.id,
    name:     def.name,
    emoji:    def.emoji ?? '👾',
    type:     def.type,
    grade:    def.grade,
    floor,

    hp:       finalHp,
    maxHp:    finalHp,
    atk:      finalAtk,
    baseAtk:  finalAtk,
    def:      finalDef,
    baseDef:  finalDef,

    exp:      def.exp,
    gold:     def.gold,
    drops:    def.drops ?? [],

    weakTo:   def.weakTo   ?? [],
    resistTo: def.resistTo ?? [],

    activeEffects: [],
  }

  // bossState holds all special-mechanic counters.
  // Each special mechanic in a boss def has an engineNote describing exactly
  // which keys to track here. This init function seeds the common patterns;
  // uncommon keys are added lazily on first use.
  const bossState = {
    _defId:       def.id,          // cross-ref back to definition
    turn:         0,               // incremented at start of each enemy turn
    phase:        1,               // current narrative phase (1–3)
    phasesUsed:   {},             // { 75: true, 50: true, 25: true }

    hitsThisTurn:         0,
    dispelledThisTurn:    false,

    // Special mechanic flags — pre-seeded for all bosses.
    // The engineNote for each boss specifies which keys it uses.
    // Undefined keys are simply ignored by applyBossSpecial.

    // Common patterns ↓
    hollowTriggered:      false,
    quirkTheftUsed:       false,
    memoryRewriteUsed:    false,
    theOneStart:          false,
    hypnosisActive:       false,
    hypnosisTurns:        0,
    amaterasuActive:      false,
    gearShiftActive:      false,
    gearShiftTurns:       0,
    shadowHands:          0,
    activeHands:          {},
    timeUnits:            0,
    cycleCharges:         3,
    truthSeekingBalls:    3,
    sukunahikonaCharges:  3,
    pathDodgesLeft:       2,
    drainStacks:          0,
    consecutiveHits:      0,
    hakiBonus:            0,
    hakiBonusTurns:       0,
    quakeResidue:         false,
    skillUseCounts:       {},
    analysisReady:        false,
    analyzedSkillId:      null,
    protections:          {},
    stolenSkillId:        null,
    stolenUntilTurn:      null,
    lastSkillUsed:        null,
    theOne:               false,
    theOneShield:         false,
    almightyEdit:         null,
    almightyWarning:      false,
    hakiInfusionBonus:    0,
  }

  // Pick a random entrance line from the definition.
  const entranceLine = _pick(def.entrance ?? ['...'])

  return { ok: true, enemy, bossState, entranceLine, def }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Apply boss special mechanics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a boss special mechanic for a given combat event.
 *
 * @param {object} player   - Player document (with battleState and bossState).
 * @param {string} event    - One of the EVENT.* constants.
 * @param {object} context  - { damage, skillId, element, isCrit, isHit, isMiss }
 * @returns {{ modified: boolean, narrativeLine: string|null, statChanges: object }}
 */
export function applyBossSpecial(player, event, context = {}) {
  const { enemy, bossState } = player.battleState
  if (!enemy || !bossState) return _noop()

  const def = getBossById(bossState._defId)
  if (!def?.special) return _noop()

  const result = { modified: false, narrativeLine: null, statChanges: {} }
  const { damage = 0, skillId = null, element = 'physical', isCrit = false,
          isHit = true, isMiss = false } = context

  // ── Route by special trigger key ─────────────────────────────────────────
  switch (bossState._defId) {

    // GOJO SATORU — Infinity nullification
    case 'gojo_satoru':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && bossState.infinityActive) {
        if (damage > 0) {
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      break

    // THE LAST PRAYER — Faith Barrier + The Prayer Continues + The Tide Rises.
    // A deliberate attrition wall: the closer to death, the harder to hurt; the
    // first lethal blow is refused; and its power climbs every turn — so even a
    // no-cooldown revive (Mei) buys time without ever actually ending it.
    case 'the_last_prayer': {
      if (event === EVENT.ENEMY_TAKE_DAMAGE && damage > 0) {
        // ── Faith Barrier ──────────────────────────────────────────────
        // Devotion hardens as the altar is threatened. Reduction climbs from
        // 12% at full HP to a 40% cap near death — enough to feel resilient
        // without turning the last sliver of HP into an unkillable slog.
        const hpFrac    = Math.max(0, enemy.hp / enemy.maxHp)   // 1 → 0
        const reduction = Math.min(0.40, 0.12 + (1 - hpFrac) * 0.38)
        let dmg = Math.max(1, Math.floor(damage * (1 - reduction)))

        // ── The Prayer Continues ───────────────────────────────────────
        // The first blow that would silence the choir does not. The verse is
        // taken up anew: HP restored to 40%, the choir rising in fervour.
        if (!bossState.prayerContinued && enemy.hp - dmg <= 0) {
          bossState.prayerContinued = true
          enemy.hp = Math.floor(enemy.maxHp * 0.40)
          const zeal = Math.floor((enemy.baseAtk ?? enemy.atk) * 0.25)
          enemy.atk += zeal
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[1]
          break
        }

        result.modified = true
        result.damage   = dmg
        // Announce the barrier once (the first time it bites), then stay silent
        // so it doesn't narrate on every single hit.
        if (!bossState.barrierAnnounced) {
          bossState.barrierAnnounced = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
        break
      }

      if (event === EVENT.TURN_START) {
        // ── The Tide Rises ─────────────────────────────────────────────
        // The drowned tide never recedes: ATK climbs ~9% of base per turn
        // toward a 1.90x cap. A slow party is ground down no matter how often
        // it revives its own.
        const base = enemy.baseAtk ?? enemy.atk
        const cap  = Math.floor(base * 1.55)
        if (enemy.atk < cap) {
          const step = Math.max(1, Math.floor(base * 0.07))
          enemy.atk = Math.min(cap, enemy.atk + step)
          bossState.tideTurns = (bossState.tideTurns ?? 0) + 1
          if (enemy.atk >= cap && !bossState.tideMaxed) {
            bossState.tideMaxed  = true
            result.modified      = true
            result.narrativeLine = def.special.narrativeLines[3]
          } else if (bossState.tideTurns % 3 === 1) {
            result.modified      = true
            result.narrativeLine = def.special.narrativeLines[2]
          }
        }
      }
      break
    }

    // THE END — Aura Veil + The Ending Refuses + The Air Grows Heavy.
    // A KILLABLE finale (the event ends only when someone lands the kill): a
    // flat aura barrier, ONE dramatic second wind, and a soft enrage that
    // punishes a slow fight. Deliberately NOT the unkillable attrition wall
    // the_last_prayer is — after the one-shot revive it is genuinely mortal.
    case 'the_end': {
      if (event === EVENT.ENEMY_TAKE_DAMAGE && damage > 0) {
        // ── Aura Veil ──────────────────────────────────────────────────
        // The sleeping air drinks a flat 15% of every blow. Flat (not
        // hp-scaled like Faith Barrier) so the last sliver of HP never
        // becomes a slog — the boss must be finishable.
        let dmg = Math.max(1, Math.floor(damage * 0.85))

        // ── The Ending Refuses ─────────────────────────────────────────
        // The first blow that would finish the End does not: it gathers the
        // dark back into itself, HP restored to 35%, heavier than before.
        // One-shot — after this it dies like anything else.
        if (!bossState.endingRefused && enemy.hp - dmg <= 0) {
          bossState.endingRefused = true
          enemy.hp = Math.floor(enemy.maxHp * 0.35)
          const surge = Math.floor((enemy.baseAtk ?? enemy.atk) * 0.30)
          enemy.atk += surge
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[1]
          break
        }

        result.modified = true
        result.damage   = dmg
        // Announce the veil once (the first time it bites), then stay silent.
        if (!bossState.veilAnnounced) {
          bossState.veilAnnounced = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
        break
      }

      if (event === EVENT.TURN_START) {
        // ── The Air Grows Heavy ────────────────────────────────────────
        // ATK climbs ~6% of base per turn toward a 1.55x cap. The strong must
        // finish quickly; the weak are ground down — exactly as intended.
        const base = enemy.baseAtk ?? enemy.atk
        const cap  = Math.floor(base * 1.55)
        if (enemy.atk < cap) {
          const step = Math.max(1, Math.floor(base * 0.06))
          enemy.atk = Math.min(cap, enemy.atk + step)
          bossState.airTurns = (bossState.airTurns ?? 0) + 1
          if (enemy.atk >= cap && !bossState.airMaxed) {
            bossState.airMaxed   = true
            result.modified      = true
            result.narrativeLine = def.special.narrativeLines[3]
          } else if (bossState.airTurns % 3 === 1) {
            result.modified      = true
            result.narrativeLine = def.special.narrativeLines[2]
          }
        }
      }
      break
    }

    // MAHORAGA — Adaptation
    case 'mahoraga_jjk':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && element) {
        if (!bossState.adaptations) bossState.adaptations = {}
        if (!bossState.adaptations[element]) {
          bossState.adaptations[element] = 0
        }
        bossState.adaptations[element] = Math.min(
          bossState.adaptations[element] + 1, 3
        )
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
      }
      break

    // MELIODAS — Full Counter
    case 'meliodas':
      if (event === EVENT.PLAYER_SKILL_ATTACK && damage > 0) {
        const bounce = Math.floor(damage * 2.0)
        result.modified          = true
        result.damage            = 0          // Meliodas takes none
        result.reflectDamage     = bounce     // apply to player
        result.narrativeLine     = def.special.narrativeLines[0]
      }
      break

    // ICHIGO — Hollow Resurgence
    case 'ichigo_kurosaki':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && !bossState.hollowTriggered) {
        if (enemy.hp - damage <= enemy.maxHp * 0.25) {
          bossState.hollowTriggered = true
          const healAmt = Math.floor(enemy.maxHp * 0.15)
          enemy.hp = Math.min(enemy.maxHp, enemy.hp + healAmt)
          const atkBonus = Math.floor(enemy.atk * 0.40)
          enemy.atk += atkBonus
          bossState.hollowAtkBonus = atkBonus
          bossState.hollowTurns    = 4
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      if (event === EVENT.TURN_END && bossState.hollowTriggered && bossState.hollowTurns > 0) {
        bossState.hollowTurns--
        if (bossState.hollowTurns === 0) {
          enemy.atk -= bossState.hollowAtkBonus
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[3]
        }
      }
      break

    // SASUKE — Amaterasu mark on player miss
    case 'sasuke_uchiha':
      if (event === EVENT.PLAYER_MISS) {
        bossState.amaterasuActive = true
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
        result.applyEffect   = { type: 'burn', source: 'amaterasu', pctPerTurn: 0.03, turns: 3 }
      }
      if (event === EVENT.PLAYER_DEFEND && bossState.amaterasuActive) {
        bossState.amaterasuActive = false
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
        result.removeEffect  = 'amaterasu'
      }
      break

    // AIZEN — Complete Hypnosis
    case 'aizen_sosuke':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && !bossState.hypnosisUsed) {
        const pct = (enemy.maxHp - enemy.hp) / enemy.maxHp
        if (pct >= 0.40) {
          bossState.hypnosisUsed   = true
          bossState.hypnosisActive = true
          bossState.hypnosisTurns  = 3
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
          result.invertHitRoll = true
        }
      }
      if (event === EVENT.TURN_END && bossState.hypnosisActive) {
        bossState.hypnosisTurns--
        if (bossState.hypnosisTurns <= 0) {
          bossState.hypnosisActive = false
          result.invertHitRoll = false
        }
      }
      if (event === EVENT.PLAYER_DEFEND && bossState.hypnosisActive) {
        bossState.hypnosisActive = false
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
        result.invertHitRoll = false
      }
      break

    // NARUTO BARYON — Lifespan drain
    case 'naruto_baryon':
      if (event === EVENT.ENEMY_DEAL_DAMAGE) {
        bossState.drainStacks = Math.min(bossState.drainStacks + 1, 10)
        const pen = Math.min(bossState.drainStacks * 0.03, 0.30)
        result.modified           = true
        result.playerAtkReduction = pen
        result.playerDefReduction = pen
        result.narrativeLine      = def.special.narrativeLines[0]
      }
      if (event === EVENT.TURN_END) {
        enemy.maxHp = Math.max(1000, Math.floor(enemy.maxHp * 0.98))
        enemy.hp    = Math.min(enemy.hp, enemy.maxHp)
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[3]
      }
      break

    // EREN — Path Foresight (dodge first 2 basic attacks)
    case 'eren_founding':
      if (event === EVENT.PLAYER_BASIC_ATTACK && bossState.pathDodgesLeft > 0) {
        bossState.pathDodgesLeft--
        result.modified      = true
        result.damage        = 0
        result.narrativeLine = def.special.narrativeLines[0]
      }
      break

    // WHITEBEARD — Quake residue
    case 'whitebeard':
      if (event === EVENT.ENEMY_DEAL_DAMAGE) {
        bossState.quakeResidue = true
      }
      if (event === EVENT.TURN_START && bossState.quakeResidue) {
        bossState.quakeResidue   = false
        result.modified          = true
        result.playerTrueDamage  = Math.floor(
          enemy.atk * BOSS_DAMAGE_TO_PLAYER_SCALE * 0.08,
        )
        result.narrativeLine     = def.special.narrativeLines[0]
      }
      break

    // SHANKS — Conqueror Haki streak
    case 'shanks':
      if (event === EVENT.ENEMY_DEAL_DAMAGE && isHit) {
        bossState.consecutiveHits++
        if (bossState.consecutiveHits === 3) {
          bossState.hakiBonus      = 0.25
          bossState.hakiBonusTurns = 2
          enemy.atk = Math.floor(enemy.baseAtk * 1.25)
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        } else if (bossState.consecutiveHits === 6) {
          bossState.hakiBonus      = 0.50
          bossState.hakiBonusTurns = 2
          enemy.atk = Math.floor(enemy.baseAtk * 1.50)
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[1]
        }
      }
      if ((event === EVENT.PLAYER_MISS || isMiss) && bossState.consecutiveHits > 0) {
        bossState.consecutiveHits = 0
        bossState.hakiBonus       = 0
        enemy.atk = enemy.baseAtk
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[3]
      }
      if (event === EVENT.TURN_END && bossState.hakiBonusTurns > 0) {
        bossState.hakiBonusTurns--
        if (bossState.hakiBonusTurns === 0 && bossState.consecutiveHits < 3) {
          enemy.atk = enemy.baseAtk
        }
      }
      break

    // KAIDO — Invincible Hide
    case 'kaido':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && element === 'physical' && !isCrit) {
        result.modified      = true
        result.damage        = Math.floor(damage * 0.50)
        result.narrativeLine = def.special.narrativeLines[0]
      }
      break

    // FRIEREN — Spell Analysis
    case 'frieren':
      if (event === EVENT.PLAYER_SKILL_ATTACK && skillId) {
        if (!bossState.skillUseCounts[skillId]) bossState.skillUseCounts[skillId] = 0
        bossState.skillUseCounts[skillId]++
        bossState.lastSkillUsed = skillId
        if (bossState.skillUseCounts[skillId] >= 2 && bossState.analyzedSkillId !== skillId) {
          bossState.analyzedSkillId = skillId
          bossState.analysisReady   = true
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      break

    // REINHARD — Divine Protection Adaptation
    case 'reinhard_van_astrea':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && element) {
        const p = bossState.protections
        if (p[element] === undefined) {
          p[element]           = 0.50
          result.modified      = true
          result.damage        = Math.floor(damage * 0.50)
          result.narrativeLine = def.special.narrativeLines[0]
        } else if (p[element] === 0.50) {
          p[element]           = 0.75
          result.modified      = true
          result.damage        = Math.floor(damage * 0.25)
          result.narrativeLine = def.special.narrativeLines[1]
        } else {
          // Already at 75%
          result.modified = true
          result.damage   = Math.floor(damage * 0.25)
        }
      }
      break

    // SATELLA — Unseen Hands
    case 'satella':
      if (event === EVENT.TURN_START) {
        if (bossState.shadowHands < 4) {
          bossState.shadowHands++
          const bonus = 1 + bossState.shadowHands * 0.15
          enemy.atk   = Math.floor(enemy.baseAtk * bonus)
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      if (event === EVENT.PLAYER_HIT_ENEMY && damage >= enemy.maxHp * 0.10 && bossState.shadowHands > 0) {
        bossState.shadowHands--
        const bonus = 1 + bossState.shadowHands * 0.15
        enemy.atk   = Math.floor(enemy.baseAtk * bonus)
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      }
      break

    // MADOKA — Law of the Cycle
    case 'madoka_kaname':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && damage > enemy.maxHp * 0.15 && bossState.cycleCharges > 0) {
        bossState.cycleCharges--
        const base    = Math.floor(enemy.maxHp * 0.15)
        const excess  = damage - base
        result.modified      = true
        result.damage        = base + Math.floor(excess * 0.50)
        result.narrativeLine = def.special.narrativeLines[0]
      }
      break

    // LAIN — Memory Rewrite
    case 'lain_iwakura':
      if (event === EVENT.ENEMY_TAKE_DAMAGE && !bossState.memoryRewriteUsed) {
        if (enemy.hp - damage <= enemy.maxHp * 0.50) {
          bossState.memoryRewriteUsed = true
          enemy.hp = Math.floor(enemy.maxHp * 0.60)

          // Reset all transient bossState flags while preserving permanent markers.
          const KEEP = new Set(['_defId', 'turn', 'phase', 'phasesUsed', 'memoryRewriteUsed'])
          for (const key of Object.keys(bossState)) {
            if (KEEP.has(key)) continue
            // Re-seed to the initBossFight default for that key type.
            const v = bossState[key]
            if (typeof v === 'boolean')          bossState[key] = false
            else if (typeof v === 'number')      bossState[key] = 0
            else if (Array.isArray(v))           bossState[key] = []
            else if (v !== null && typeof v === 'object') bossState[key] = {}
            else                                 bossState[key] = null
          }

          result.modified         = true
          result.resetPlayerMp    = true
          result.clearPlayerBuffs = true
          result.clearSkillCooldowns = true
          result.narrativeLine    = def.special.narrativeLines[0]
        }
      }
      break

    // JULIUS — Time Capture
    case 'julius_novachrono':
      if (event === EVENT.PLAYER_HIT_ENEMY) {
        bossState.hitsThisTurn++
        bossState.timeUnits++
        if (bossState.timeUnits >= 4) {
          const healAmt = Math.floor(enemy.maxHp * 0.12)
          enemy.hp = Math.min(enemy.maxHp, enemy.hp + healAmt)
          bossState.timeUnits  = 0
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[2]
        }
      }
      if (event === EVENT.TURN_START) bossState.hitsThisTurn = 0
      break

    // HAGOROMO — Truth-Seeking Ball Screen
    case 'hagoromo_otsutsuki':
      if (event === EVENT.PLAYER_SKILL_ATTACK && damage > 0 && bossState.truthSeekingBalls > 0) {
        bossState.truthSeekingBalls--
        result.modified      = true
        result.damage        = 0
        result.narrativeLine = def.special.narrativeLines[0]
      }
      break

    // ISSHIKI — Sukunahikona Nullification
    case 'isshiki_otsutsuki':
      if (event === EVENT.TURN_END && bossState.sukunahikonaCharges > 0) {
        bossState.sukunahikonaWarning = true
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      }
      if (event === EVENT.PLAYER_BASIC_ATTACK && bossState.sukunahikonaWarning
          && damage > enemy.maxHp * 0.10 && bossState.sukunahikonaCharges > 0) {
        bossState.sukunahikonaCharges--
        bossState.sukunahikonaWarning = false
        result.modified      = true
        result.damage        = 0
        result.narrativeLine = def.special.narrativeLines[0]
      }
      break

    // YHWACH — Almighty Edit
    case 'yhwach':
      if (event === EVENT.TURN_START && bossState.turn % 4 === 3) {
        bossState.almightyWarning = true
        bossState.almightyEdit    = Math.ceil(Math.random() * 3)
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
      }
      if (event === EVENT.PLAYER_BASIC_ATTACK && bossState.almightyEdit === 1) {
        bossState.almightyEdit    = null
        bossState.almightyWarning = false
        result.modified      = true
        result.damage        = 0
        result.narrativeLine = def.special.narrativeLines[1]
      }
      if (event === EVENT.ENEMY_DEAL_DAMAGE && bossState.almightyEdit === 2) {
        bossState.almightyEdit    = null
        bossState.almightyWarning = false
        result.modified      = true
        result.bypassDefense = true
        result.narrativeLine = def.special.narrativeLines[2]
      }
      if (event === EVENT.TURN_END && bossState.almightyEdit === 3) {
        bossState.almightyEdit    = null
        bossState.almightyWarning = false
        const healAmt = Math.floor(enemy.maxHp * 0.08)
        enemy.hp = Math.min(enemy.maxHp, enemy.hp + healAmt)
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[3]
      }
      break

    // DEKU — Gear Shift
    case 'deku_mha':
      if (event === EVENT.TURN_START && bossState.turn % 4 === 0 && bossState.turn > 0) {
        bossState.gearShiftActive = true
        bossState.gearShiftTurns  = 2
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
      }
      if (event === EVENT.PLAYER_HIT_ENEMY && bossState.gearShiftActive && damage >= enemy.maxHp * 0.15) {
        bossState.gearShiftActive = false
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      }
      if (event === EVENT.TURN_END && bossState.gearShiftActive) {
        bossState.gearShiftTurns--
        if (bossState.gearShiftTurns <= 0) bossState.gearShiftActive = false
      }
      break

    // ALL FOR ONE — Quirk Theft
    case 'all_for_one':
      if (event === EVENT.PLAYER_SKILL_ATTACK && skillId) {
        bossState.lastSkillUsed = skillId
      }
      if (event === EVENT.ENEMY_TAKE_DAMAGE && !bossState.quirkTheftUsed) {
        const pct = (enemy.maxHp - enemy.hp) / enemy.maxHp
        if (pct >= 0.45 && bossState.lastSkillUsed) {
          bossState.quirkTheftUsed  = true
          bossState.stolenSkillId   = bossState.lastSkillUsed
          bossState.stolenUntilTurn = bossState.turn + 3
          const bonus               = Math.floor(enemy.atk * 0.10)
          enemy.atk                += bonus
          bossState.stolenAtkBonus  = bonus
          result.modified      = true
          result.blockSkillId  = bossState.stolenSkillId
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      if (event === EVENT.TURN_END && bossState.stolenSkillId
          && bossState.turn >= bossState.stolenUntilTurn) {
        enemy.atk -= bossState.stolenAtkBonus
        bossState.stolenSkillId  = null
        result.modified      = true
        result.unblockSkill  = true
        result.narrativeLine = def.special.narrativeLines[3]
      }
      break

    // ESCANOR — The One Window
    case 'escanor':
      if (event === EVENT.TURN_START && bossState.turn === 6) {
        bossState.theOne      = true
        bossState.theOneShield = true
        enemy.atk = Math.floor(enemy.baseAtk * 2.0)
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
      }
      if (event === EVENT.TURN_START && bossState.turn === 9) {
        bossState.theOne = false
        enemy.atk = enemy.baseAtk
        enemy.def = Math.floor(enemy.baseDef * 0.50)
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      }
      if (event === EVENT.ENEMY_TAKE_DAMAGE && bossState.theOne && bossState.theOneShield) {
        bossState.theOneShield = false
        result.modified      = true
        result.damage        = Math.floor(damage * 0.50)
        result.narrativeLine = def.special.narrativeLines[1]
      }
      if (event === EVENT.TURN_START && bossState.theOne) {
        bossState.theOneShield = true  // refreshes each turn while active
      }
      break

    // ASTA — Anti-Magic Immunity
    case 'asta':
      if (event === EVENT.ENEMY_TAKE_DAMAGE) {
        const magicTypes = ['magic', 'fire', 'ice', 'holy', 'shadow', 'void']
        if (magicTypes.includes(element)) {
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      if (event === EVENT.ENEMY_DEAL_DAMAGE && !bossState.dispelledThisTurn) {
        // Only trigger dispel when the player actually has dispellable buffs.
        // Caller is responsible for passing context.playerHasBuffs = true when
        // player.activeEffects contains at least one strengthen/regen effect.
        const playerHasBuffs = context.playerHasBuffs ?? false
        if (playerHasBuffs) {
          bossState.dispelledThisTurn = true
          result.modified      = true
          result.dispelBuff    = true
          result.narrativeLine = def.special.narrativeLines[2]
        }
      }
      if (event === EVENT.TURN_START) bossState.dispelledThisTurn = false
      break

    // SUNG JINWOO — Shadow Soldier Summons
    case 'sung_jinwoo':
      if (event === EVENT.TURN_START && bossState.turn % 3 === 0 && bossState.turn > 0) {
        if (bossState.shadowHands < 3) {
          bossState.shadowHands++
          const bonusDmg = Math.floor(enemy.baseAtk * 0.15) * bossState.shadowHands
          bossState.shadowBonusDmg = bonusDmg
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
      }
      break

    // LUFFY — Rubber Reality
    case 'luffy_gear5':
      if (event === EVENT.ENEMY_TAKE_DAMAGE) {
        const LIGHTNING_ALIASES = new Set(['lightning', 'electric', 'thunder', 'volt'])
        if (LIGHTNING_ALIASES.has(element)) {
          const heal = Math.floor(enemy.maxHp * 0.05)
          enemy.hp = Math.min(enemy.maxHp, enemy.hp + heal)
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[3]
        } else if (element === 'physical' || element === 'strike') {
          const bounce = Math.min(Math.floor(damage * 0.30), Math.floor(
            (player.stats?.maxHp ?? 1000) * 0.10
          ))
          result.modified        = true
          result.reflectDamage   = bounce
          result.narrativeLine   = def.special.narrativeLines[0]
        }
      }
      break

    // JOTARO — Time Stop on turns 8 and 16
    case 'jotaro_kujo':
      if (event === EVENT.TURN_START && (bossState.turn === 7 || bossState.turn === 15)) {
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
      }
      if (event === EVENT.TURN_START && (bossState.turn === 8 || bossState.turn === 16)) {
        const fiveHits = Array.from(
          { length: 5 },
          () => Math.floor(enemy.atk * BOSS_DAMAGE_TO_PLAYER_SCALE * 0.40),
        )
        result.modified         = true
        result.guaranteedHits   = fiveHits
        result.narrativeLine    = def.special.narrativeLines[1]
      }
      break

    // MERUEM — (handled by existing mechanics, placeholder)
    case 'meruem':
      break

    // VEGETA — (handled by existing mechanics, placeholder)
    case 'vegeta':
      break

    // ── ORIGINAL TOWER MASTERS (floor 100 of each main dungeon) ───────────────
    // Five masters, ascending in power: Syclila < Kikaru < Celestia < Bam <
    // Esteria. Each carries one peak ability the climber must read and answer.
    // The narrativeLines[] indices below match bosses/<id>.js exactly.

    // SYCLILA — Mirror Veil (Entry Tower, weakest master). Every few turns she
    // raises a mirror; the tell lands a full turn before it goes live
    // (mirrorArmedTurn). Strike into the live mirror and the blow is turned back
    // on you. Read it and DEFEND instead: the mirror shatters on nothing and she
    // is left exposed to a bonus hit.
    case 'syclila': {
      if (event === EVENT.TURN_START
          && bossState.turn % 4 === 0 && bossState.turn > 0
          && !bossState.mirrorRaised && !bossState.exposed) {
        bossState.mirrorRaised    = true
        bossState.mirrorArmedTurn = bossState.turn
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[0]
      } else if (event === EVENT.ENEMY_TAKE_DAMAGE && damage > 0) {
        if (bossState.mirrorRaised && bossState.turn > bossState.mirrorArmedTurn) {
          // Struck into the live mirror — most of the force is turned back.
          bossState.mirrorRaised = false
          result.modified      = true
          result.damage        = Math.floor(damage * 0.15)
          result.reflectDamage = Math.floor(damage * 0.40)
          result.narrativeLine = def.special.narrativeLines[1]
        } else if (bossState.exposed) {
          // Mirror shattered by a well-read defend — punish the opening.
          bossState.exposed = false
          result.modified      = true
          result.damage        = Math.floor(damage * 1.5)
          result.narrativeLine = def.special.narrativeLines[3]
        }
      } else if (event === EVENT.PLAYER_DEFEND
          && bossState.mirrorRaised && bossState.turn > bossState.mirrorArmedTurn) {
        // Guarded instead of swinging: the mirror breaks on nothing.
        bossState.mirrorRaised = false
        bossState.exposed      = true
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      }
      break
    }

    // KIKARU — Afterimage Tempo (Gambit's Dungeon). Left to build a rhythm, he
    // blurs into afterimages (basic attacks begin to whiff) and finally unloads
    // a flurry. Break the tempo with a skill or a crit to reset it before the
    // flurry lands. Crits always connect (they bypass the afterimage dodge).
    case 'kikaru': {
      if (event === EVENT.TURN_START) {
        bossState.tempo = (bossState.tempo || 0) + 1
        if (bossState.tempo === 3) {
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
      } else if (event === EVENT.PLAYER_BASIC_ATTACK
          && (bossState.tempo || 0) >= 3 && !isCrit && damage > 0) {
        const dodgeChance = Math.min(0.5, (bossState.tempo || 0) * 0.10)
        if (Math.random() < dodgeChance) {
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[1]
        }
      } else if (event === EVENT.PLAYER_SKILL_ATTACK && (bossState.tempo || 0) > 0) {
        bossState.tempo = 0
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      } else if (event === EVENT.PLAYER_HIT_ENEMY && isCrit && (bossState.tempo || 0) > 0) {
        bossState.tempo = 0
        result.modified      = true
        result.narrativeLine = def.special.narrativeLines[2]
      } else if (event === EVENT.ENEMY_DEAL_DAMAGE && (bossState.tempo || 0) >= 5) {
        bossState.tempo = 0
        result.modified      = true
        result.damage        = Math.floor(damage * 1.7)
        result.narrativeLine = def.special.narrativeLines[3]
      }
      break
    }

    // CELESTIA — Verdict of the Scales (Centurion's Dungeon). On a fixed 3-turn
    // cadence she warns once, then delivers a Verdict measured as a fraction of
    // the player's MAX HP (not her attack), as true damage so gear cannot
    // out-grow it. The fraction climbs as her own health falls. DEFEND on the
    // verdict turn to halve the sentence.
    case 'celestia': {
      if (event === EVENT.TURN_START) {
        bossState.verdictClock = (bossState.verdictClock || 0) + 1
        if (bossState.verdictClock % 3 === 2) {
          bossState.verdictPending = true
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        } else if (bossState.verdictClock % 3 === 0) {
          bossState.verdictDue = true
        }
      } else if (event === EVENT.ENEMY_DEAL_DAMAGE && bossState.verdictDue) {
        const hpFrac = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0
        const frac   = hpFrac > 0.5 ? 0.60 : hpFrac > 0.25 ? 0.85 : 1.10
        let base = Math.floor((player.maxHp || 1) * frac)
        if (player.battleState?.playerDefending) {
          base = Math.floor(base * 0.5)
          result.narrativeLine = def.special.narrativeLines[2]
        } else {
          result.narrativeLine = def.special.narrativeLines[1]
        }
        base = Math.max(1, base)
        const h1 = Math.ceil(base / 2)
        result.modified          = true
        result.guaranteedHits    = [h1, base - h1]  // true damage, ignores DEF
        bossState.verdictDue     = false
        bossState.verdictPending = false
      }
      break
    }

    // BAM — Reverse Flow (Astral Tower, second-strongest). He telegraphs a still,
    // open guard (the tell lands a turn before it goes live); the next blow you
    // strike into it is mostly absorbed and stored, then returned magnified on
    // his following hit. The counter is restraint: do not pour your biggest hit
    // into the opening. Below 30% he ignites once, surging his attack and
    // searing extra damage into every hit thereafter.
    case 'bam': {
      if (event === EVENT.TURN_START) {
        if (!bossState.ignited && enemy.hp <= enemy.maxHp * 0.30) {
          // Ignition — one-time, at the shallows.
          bossState.ignited = true
          enemy.atk = Math.floor(enemy.atk * 1.35)
          enemy.baseAtk = enemy.atk
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[3]
        } else if (bossState.turn % 3 === 0 && bossState.turn > 0
            && !bossState.reverseArmed && !(bossState.storedFlow > 0)) {
          // Open the guard — the tell. The reverse goes live next turn.
          bossState.reverseArmed     = true
          bossState.reverseArmedTurn = bossState.turn
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[0]
        }
      } else if (event === EVENT.ENEMY_TAKE_DAMAGE && damage > 0
          && bossState.reverseArmed && bossState.turn > bossState.reverseArmedTurn) {
        // Force poured into the open guard — swallowed, stored, coming back.
        bossState.reverseArmed = false
        bossState.storedFlow   = Math.floor(damage * 1.5)
        result.modified      = true
        result.damage        = Math.floor(damage * 0.2)
        result.narrativeLine = def.special.narrativeLines[1]
      } else if (event === EVENT.ENEMY_DEAL_DAMAGE) {
        let dmg  = damage
        let line = null
        if (bossState.storedFlow > 0) {
          dmg += bossState.storedFlow
          bossState.storedFlow = 0
          line = def.special.narrativeLines[2]
        }
        if (bossState.ignited) {
          dmg += Math.floor((player.maxHp || 1) * 0.03)
          if (!line && bossState.turn % 2 === 0) line = def.special.narrativeLines[4]
        }
        if (dmg !== damage) {
          result.modified      = true
          result.damage        = dmg
          if (line) result.narrativeLine = line
        }
      }
      break
    }

    // ESTERIA — Two Forms (Eternal Dungeon, strongest master; ability specified
    // by the user). Her first form cannot be killed: the blow that would end it
    // sheds it instead, and she rises in a second form with a fresh, larger HP
    // pool and surged attack/defence. In the second form her attack RAMPS every
    // turn, a ward HARDENS as her health falls, and she periodically FLURRIES.
    // Win twice, outrace the ramp, and break a wall that thickens as you close.
    case 'esteria': {
      const sf = def.secondForm || { hp: enemy.maxHp, atkMult: 1.3, defMult: 1.25 }
      if (event === EVENT.ENEMY_TAKE_DAMAGE && damage > 0) {
        if (bossState.form !== 2 && !bossState.form2Used && enemy.hp - damage <= 0) {
          // The mask shatters. The true fight begins on a full second bar.
          bossState.form2Used    = true
          bossState.form         = 2
          enemy.maxHp   = sf.hp
          enemy.hp      = sf.hp
          enemy.atk     = Math.floor(enemy.atk * sf.atkMult)
          enemy.def     = Math.floor(enemy.def * sf.defMult)
          enemy.baseAtk = enemy.atk
          enemy.baseDef = enemy.def
          bossState.form2BaseAtk = enemy.atk
          bossState.rampMult     = 1
          bossState.form2Turns   = 0
          bossState.flurryNext   = false
          result.modified      = true
          result.damage        = 0
          result.narrativeLine = def.special.narrativeLines[0]
        } else if (bossState.form === 2) {
          // Hardening ward — turns aside more of each blow the closer she is to
          // death (12% up to a 45% cap).
          const hpFrac    = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0
          const reduction = Math.min(0.45, 0.12 + 0.33 * (1 - hpFrac))
          result.modified = true
          result.damage   = Math.max(1, Math.floor(damage * (1 - reduction)))
          bossState.wardHits = (bossState.wardHits || 0) + 1
          if (bossState.wardHits % 3 === 1)
            result.narrativeLine = def.special.narrativeLines[2]
        }
      } else if (event === EVENT.TURN_START && bossState.form === 2) {
        bossState.form2Turns = (bossState.form2Turns || 0) + 1
        // Compounding reign — attack ramps ~8% of the second-form base per turn
        // toward a 1.8x cap.
        bossState.rampMult = Math.min(1.8, (bossState.rampMult || 1) + 0.08)
        enemy.atk = Math.floor((bossState.form2BaseAtk || enemy.atk) * bossState.rampMult)
        // Flurry arms every 4th second-form turn; it lands on the counter-attack.
        if (bossState.form2Turns % 4 === 0) bossState.flurryNext = true
        if (bossState.form2Turns % 3 === 2) {
          result.modified      = true
          result.narrativeLine = def.special.narrativeLines[1]
        }
      } else if (event === EVENT.ENEMY_DEAL_DAMAGE && bossState.form === 2 && bossState.flurryNext) {
        bossState.flurryNext = false
        result.modified      = true
        result.damage        = Math.floor(damage * 1.6)
        result.narrativeLine = def.special.narrativeLines[3]
      }
      break
    }

    default:
      break
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Phase transition check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the boss has crossed a narrative phase threshold.
 * Call after enemy.hp changes.
 *
 * @param {object} player
 * @returns {{ triggered: boolean, pct: number, lines: string[] } | null}
 */
export function checkBossPhase(player) {
  const { enemy, bossState } = player.battleState
  if (!enemy || !bossState) return null

  const def = getBossById(bossState._defId)
  if (!def?.phases) return null

  const hpPct = Math.floor((enemy.hp / enemy.maxHp) * 100)

  for (const threshold of [75, 50, 25]) {
    if (hpPct <= threshold && !bossState.phasesUsed[threshold]) {
      bossState.phasesUsed[threshold] = true
      const lines = def.phases[threshold] ?? []
      return { triggered: true, pct: threshold, lines }
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Build enemy attack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the enemy's attack for this turn.
 * Selects a random attack from the boss definition, applies bossState bonuses.
 *
 * Two Thief's Eye hooks live here (Xiao — see the `── Xiao ──` section of
 * lib/character-abilities.js). This is the one function every boss attack in
 * the bot flows through, from every combat entry point (attack.js, skill.js,
 * defend.js, useability.js, cinderverdict.js, thiefseye.js, party.js, ...), so
 * hooking it once covers all of them instead of touching each call site.
 * Both hooks are plain reads/writes of battleState fields on purpose: no import
 * of lib/character-abilities.js, which would invert the layering (that module
 * is the ability layer sitting on top of the engines).
 *
 * @param {object} player
 * @returns {{ attackName: string, damage: number, narrativeLines: string[], bypassDefense: boolean }}
 */
export function buildEnemyAttack(player) {
  const { enemy, bossState } = player.battleState
  if (!enemy) return { attackName: 'Strike', damage: enemy?.atk ?? 0, narrativeLines: [] }

  const def = getBossById(bossState._defId)

  // Pick a random attack name.
  //
  // THIEF'S EYE (deny): any attack Xiao has stolen is gone for the rest of the
  // fight. MUST be a non-mutating .filter() — def.attacks is a shared
  // module-level array on the boss definition (e.g. bosses/sukuna_ryomen.js),
  // so splicing it would delete that attack from the boss for every player in
  // every future fight until the process restarts. The `|| pool` fallback is
  // the other half of the safety: if a player somehow denied every attack a
  // boss has, _pick() on an empty array returns undefined and the boss would
  // attack with `undefined` forever, so the pool reverts rather than emptying.
  const pool           = def?.attacks ?? ['Strike']
  const denied         = Array.isArray(bossState.thiefsEyeDenied) ? bossState.thiefsEyeDenied : []
  const surviving      = denied.length ? pool.filter(a => !denied.includes(a)) : pool
  const attackName     = _pick(surviving.length ? surviving : pool)
  const narrativeLines = def?.attackNarratives?.[attackName] ?? []

  let damage = enemy.atk

  // Apply bossState bonuses (shadow soldiers, haki, etc.)
  if (bossState.shadowBonusDmg) damage += bossState.shadowBonusDmg

  // If gear shift is active, caller should apply damage twice
  const doubleStrike = bossState._defId === 'deku_mha' && bossState.gearShiftActive

  const scaledDamage = Math.floor(damage * BOSS_DAMAGE_TO_PLAYER_SCALE)

  // THIEF'S EYE (copy): record what the boss just reached for, so Xiao can
  // throw it back on a later turn. Unconditional — it costs one object write
  // and never reads the player's equipped character, so nothing else in combat
  // is affected by the field existing. The PRE-mitigation scaled damage is what
  // gets recorded, deliberately: it is the power of the technique itself rather
  // than however much the player's own DEF let through, which is what makes the
  // echo floor meaningful for a high-DEF player. Mirrors recordEnemyMove() in
  // lib/character-abilities.js — change both if the shape changes.
  player.battleState.lastEnemyMove = {
    name: attackName,
    damage: scaledDamage,
    kind: 'boss',
    id: attackName,
  }

  return {
    attackName,
    damage:       scaledDamage,
    narrativeLines,
    bypassDefense: false,
    doubleStrike,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Narrative helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a random taunt line for the current boss.
 * @param {object} player
 * @returns {string}
 */
export function getBossTaunt(player) {
  const def = getBossById(player.battleState?.bossState?._defId)
  return _pick(def?.tauntLines ?? ['...'])
}

/**
 * Get the boss hit reaction line (enemy was hit by player).
 * @param {object} player
 * @returns {string}
 */
export function getBossHitLine(player) {
  const def = getBossById(player.battleState?.bossState?._defId)
  return _pick(def?.hitLines ?? ['Hmm.'])
}

/**
 * Get the boss dodge reaction line (enemy evaded player attack).
 * @param {object} player
 * @returns {string}
 */
export function getBossDodgeLine(player) {
  const def = getBossById(player.battleState?.bossState?._defId)
  return _pick(def?.dodgeLines ?? ['...'])
}

/**
 * Get victory lines (boss wins).
 * @param {object} player
 * @returns {string[]}
 */
export function getBossVictoryLines(player) {
  const def = getBossById(player.battleState?.bossState?._defId)
  return def?.victoryLines ?? ['...']
}

/**
 * Get defeat lines (boss loses).
 * @param {object} player
 * @returns {string[]}
 */
export function getBossDefeatLines(player) {
  const def = getBossById(player.battleState?.bossState?._defId)
  return def?.defeatLines ?? ['...']
}

/**
 * Get the drop list for this boss.
 * @param {object} player
 * @returns {string[]}
 */
export function getBossDrops(player) {
  const def = getBossById(player.battleState?.bossState?._defId)
  return def?.drops ?? []
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reset bossState after a fight ends.
 * @param {object} player
 */
export function cleanupBossFight(player) {
  if (player.battleState) {
    player.battleState.bossState = null
  }
}

/**
 * True only for a LIVE tower-master boss fight: a boss enemy with real, positive
 * HP and an initialised bossState. Deliberately strict — a genuinely corrupted
 * battle state (no enemy, or NaN/zero HP) reads as NOT a live boss fight. The
 * emergency .cb escape and the mid-boss command lockdown both key off this, so a
 * corrupted state must stay recoverable while a healthy fight stays locked down.
 * @param {object} player
 * @returns {boolean}
 */
export function isLiveBossFight(player) {
  const bs = player?.battleState
  return !!(
    bs?.enemy?.isBoss &&
    bs?.bossState &&
    Number.isFinite(bs.enemy.hp) &&
    bs.enemy.hp > 0
  )
}

/**
 * Increment the turn counter. Call at the start of each player turn.
 * @param {object} player
 */
export function incrementBossTurn(player) {
  if (player.battleState?.bossState) {
    player.battleState.bossState.turn++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function _noop() {
  return { modified: false, narrativeLine: null, statChanges: {} }
}
