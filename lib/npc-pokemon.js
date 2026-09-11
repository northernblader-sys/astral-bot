/**
 * npc-pokemon.js — the NPC / wild Pokemon battle engine.
 *
 * WHY THIS EXISTS SEPARATELY from plugins/pokebattle.js:
 *   The PvP engine (resolvePokeBattleTurn) is a two-player, asynchronous,
 *   simultaneous-select machine: each side locks a pendingMove, a 60s deadline
 *   sweeps timeouts, and the turn only resolves once BOTH players have chosen.
 *   An NPC has no second human to wait on, so forcing one through that pipeline
 *   would mean faking a JID, a wallet, a save row and a pendingMove for a
 *   creature that has none. Instead this engine is SYNCHRONOUS: the player picks
 *   a move, the NPC picks one immediately (simple type-aware AI), and the whole
 *   turn resolves in a single call. PvP is left completely untouched.
 *
 * WHAT IT REUSES (so an NPC fight is mechanically honest, not a knockoff):
 *   - computeBattleStats() for real IV/EV/nature/level stats.
 *   - typeEffectiveness()/effectivenessText() for the real 18x18 chart.
 *   - getMoveById() and the same simplified damage formula shape pokebattle
 *     uses (base -> STAB -> type -> crit -> random), minus the held-item/
 *     ability/mega/weather layers, which wild and tower fights deliberately
 *     don't run (kept simple on purpose, documented in the plan).
 *   - toOwnedPokemon() to build the NPC's mon with the identical owned shape.
 *
 * STATE lives on `player.npcBattleState` — a DISTINCT field from
 * `pokemonBattleState` (PvP) so the two never collide and inPokeBattle() stays
 * false during an NPC fight. Shape:
 *   npcBattleState = {
 *     kind:      'wild' | 'tower',
 *     playerHp, playerMaxHp,
 *     foe:       <owned-shape mon>,   // the CURRENT foe mon
 *     foeHp, foeMaxHp,
 *     turn:      <n>,
 *     // wild only:
 *     level, catchable,
 *     // tower only:
 *     stage, teamIdx, teamLen, masterName, masterEmoji,
 *   }
 *
 * Copy is player-facing: no dashes, per the house rule.
 */
import { getMoveById } from './move-pool.js'
import { computeBattleStats } from './pokemon-stats.js'
import { typeEffectiveness, effectivenessText } from './type-chart.js'
import { toOwnedPokemon } from './pokemon-engine.js'

const BASE_CRIT_CHANCE = 0.15

// ── Damage (the pokebattle formula, minus item/ability/mega/weather) ────────
function stab(move, attacker) {
  return (attacker.types ?? []).includes(move.type) ? 1.5 : 1
}

/**
 * One damaging hit. Mirrors pokebattle.js's damageFor core: physical uses
 * atk/def, special uses spAtk/spDef, status moves never reach here. Returns
 * { dmg, eff, crit }.
 */
function computeHit(move, atkMon, atkStats, defMon, defStats) {
  const level = atkMon.level ?? 5
  const isPhysical = move.category === 'physical'
  const atkStat = isPhysical ? atkStats.atk : atkStats.spAtk
  const defStat = isPhysical ? defStats.def : defStats.spDef

  const base = (((2 * level) / 5 + 2) * (move.power ?? 0) * (atkStat / Math.max(1, defStat))) / 50 + 2
  const eff = typeEffectiveness(move.type, defMon.types ?? [])
  const crit = Math.random() < BASE_CRIT_CHANCE
  const critMult = crit ? 1.5 : 1
  const rand = 0.85 + Math.random() * 0.15
  const dmg = Math.max(1, Math.floor(base * stab(move, atkMon) * eff * critMult * rand))
  return { dmg, eff, crit }
}

// ── NPC move AI ─────────────────────────────────────────────────────────────
/**
 * Pick the NPC's move. Damaging moves are scored by expected damage against the
 * player's types (power x STAB x effectiveness); the NPC picks the best with a
 * little randomness so it isn't perfectly predictable. Status-only movesets
 * fall back to a random pick. Returns a move id.
 */
export function pickNpcMove(foeMon, playerMon) {
  const moves = (foeMon.moves ?? []).map(getMoveById).filter(Boolean)
  if (!moves.length) return null
  const damaging = moves.filter(m => m.category !== 'status' && m.power)
  if (!damaging.length) return moves[Math.floor(Math.random() * moves.length)].id

  const scored = damaging.map(m => {
    const eff = typeEffectiveness(m.type, playerMon.types ?? [])
    const s = (m.power ?? 0) * stab(m, foeMon) * eff
    return { id: m.id, score: s * (0.85 + Math.random() * 0.3) }
  })
  scored.sort((a, b) => b.score - a.score)
  // 75% pick the best, else pick among the rest for a touch of unpredictability.
  if (scored.length === 1 || Math.random() < 0.75) return scored[0].id
  return scored[1 + Math.floor(Math.random() * (scored.length - 1))].id
}

// ── Foe construction ────────────────────────────────────────────────────────
/**
 * Build an NPC foe mon (owned shape) from a raw species fetch (fetchRandomPokemon
 * / fetchPokemonById result) at a given level. Reuses toOwnedPokemon so the foe
 * has real moves, IVs, nature and base stats exactly like a caught Pokemon.
 */
export function buildFoeMon(raw, level) {
  const mon = toOwnedPokemon(raw, { level })
  // NPC foes never carry held items or evolve mid fight.
  mon.heldItem = null
  return mon
}

// ── Turn resolution ─────────────────────────────────────────────────────────
/**
 * Resolve ONE full NPC-battle turn. Pure with respect to the db: it MUTATES the
 * passed `bs` (npcBattleState) and `playerMon` (for currentHp bookkeeping only)
 * and returns a result the caller renders and acts on. No I/O, no reply, no
 * db write. Call inside updatePlayer.
 *
 * @returns {
 *   log:        string[],           // battle log lines for this turn
 *   foeFainted: bool,               // the current foe mon fainted this turn
 *   playerFainted: bool,            // the player's mon fainted this turn
 *   lastAction: { actor, kind, damage } | null,  // for the render impact burst
 * }
 */
export function resolveNpcTurn(bs, playerMon, playerMoveId) {
  const log = []
  const foeMon = bs.foe
  const playerMove = getMoveById(playerMoveId)
  const foeMoveId = pickNpcMove(foeMon, playerMon)
  const foeMove = getMoveById(foeMoveId)

  const playerStats = computeBattleStats(playerMon)
  const foeStats = computeBattleStats(foeMon)

  // Turn order: higher speed first, player wins ties.
  const playerFirst = playerStats.spd >= foeStats.spd
  const order = playerFirst
    ? [{ who: 'player' }, { who: 'foe' }]
    : [{ who: 'foe' }, { who: 'player' }]

  let foeFainted = false
  let playerFainted = false
  let lastAction = null

  for (const step of order) {
    if (foeFainted || playerFainted) break

    if (step.who === 'player') {
      if (!playerMove) { log.push(`⚠️ Your Pokemon has no usable move.`); continue }
      const hitLine = actOnce({
        move: playerMove, atkMon: playerMon, atkStats: playerStats,
        defMon: foeMon, defStats: foeStats, actorLabel: 'left',
        atkName: playerMon.nickname ?? playerMon.name, defName: foeMon.name,
        applyDamage: (dmg) => { bs.foeHp = Math.max(0, bs.foeHp - dmg) },
        log,
      })
      if (hitLine) lastAction = hitLine
      if (bs.foeHp <= 0) { log.push(`💀 *${foeMon.name}* fainted!`); foeFainted = true }
    } else {
      if (!foeMove) { log.push(`⚠️ ${foeMon.name} hesitates.`); continue }
      const hitLine = actOnce({
        move: foeMove, atkMon: foeMon, atkStats: foeStats,
        defMon: playerMon, defStats: playerStats, actorLabel: 'right',
        atkName: foeMon.name, defName: playerMon.nickname ?? playerMon.name,
        applyDamage: (dmg) => { bs.playerHp = Math.max(0, bs.playerHp - dmg) },
        log,
      })
      if (hitLine) lastAction = hitLine
      if (bs.playerHp <= 0) { log.push(`💀 *${playerMon.nickname ?? playerMon.name}* fainted!`); playerFainted = true }
    }
  }

  bs.turn = (bs.turn ?? 1) + 1
  return { log, foeFainted, playerFainted, lastAction }
}

/**
 * One actor's single action. Handles miss, status moves (no damage in this
 * simplified engine, just a flavor line), and damaging hits. Pushes lines into
 * `log`, applies damage via the callback, and returns a lastAction descriptor
 * (or null for a pure status move).
 */
function actOnce({ move, atkMon, atkStats, defMon, defStats, actorLabel, atkName, defName, applyDamage, log }) {
  const missed = move.accuracy != null && Math.random() * 100 >= move.accuracy
  if (missed) {
    log.push(`💨 *${atkName}*'s ${move.name} missed!`)
    return { actor: actorLabel, kind: 'miss', damage: null }
  }

  log.push(`${move.category === 'status' ? '✨' : '⚔️'} *${atkName}* used *${move.name}*!`)

  if (move.category === 'status' || !move.power) {
    // Status moves are cosmetic in the NPC engine (no stat-stage system here).
    return null
  }

  const { dmg, eff, crit } = computeHit(move, atkMon, atkStats, defMon, defStats)
  applyDamage(dmg)
  const effText = effectivenessText(eff)
  log.push(
    `${crit ? '💥 *Critical hit!* ' : ''}${effText ? effText + ' ' : ''}*${defName}* took *${dmg}* damage.`,
  )
  return { actor: actorLabel, kind: crit ? 'crit' : 'hit', damage: dmg }
}
