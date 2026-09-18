/**
 * swarm-combat.js — multi-monster ("swarm") dungeon combat.
 *
 * The classic dungeon loop is strict 1v1: one enemy in battleState.enemy, trade
 * hits, handleVictory advances the floor. This engine replaces that on floors 1
 * to 99 of every main dungeon with a small pack that closes from different lanes
 * at once. WhatsApp has no clock and we can't auto-fire messages (the no-fanout
 * rule), so real time is out. Instead monsters TELEGRAPH: a monster in reach
 * visibly winds up an attack that lands the NEXT turn, and the player answers a
 * beat ahead by killing it, stepping out of its lane, dodging, or guarding.
 *
 * HOW IT PLUGS IN
 *   - Gated entirely behind battleState.mode === 'swarm'. The 1v1 pipeline is
 *     byte-identical for every floor-100 master fight (Syclila, Kikaru,
 *     Celestia, Bam, Esteria). plugins/dungeon.js builds the floor; the combat
 *     verbs (attack/skill/defend/flee/ml/mr/dodge) branch to the resolvers here.
 *   - battleState.enemy is kept pointed at a live monster at all times, because
 *     dungeon.js, flee.js and resolvePlayerHpZero's cat-form branch all read it.
 *   - Reward math is NOT duplicated: every kill is paid through creditKill()
 *     (the per-kill core lifted out of handleVictory), and the floor-clearing
 *     kill is handed to handleVictory() itself so floor advance, regen and
 *     checkpoint saves all keep working.
 *
 * THE BATTLEFIELD
 *   Three lanes: 0 left, 1 center, 2 right. The player holds bs.playerLane.
 *   Each monster holds a lane and a range ('far' | 'near'). A monster can hit
 *   only when it is 'near' AND within one lane of the player, so center is
 *   exposed to all three lanes and an edge to two: where you stand matters.
 *   Far monsters drift toward your lane and close to near over a turn; standing
 *   still lets the whole pack reach near and wind up at once = overwhelmed.
 *
 * OUT OF SCOPE: multi-monster canvas art (text frames only), boss floors (floor
 * 100 stays a 1v1 master fight), monster status effects, and the full skill
 * effect pipeline (swarm .skill is a single-target damaging strike only).
 */

import {
  pickMonsterForFloor,
  calcPlayerDamage,
  applyDefense,
  calcPlayerHitChance,
  calcMonsterDamage,
  hpBar,
  enemyPowerRatio,
  scaleEnemyToPlayer,
} from './combat-engine.js'
import {
  creditKill,
  handleVictory,
  resolvePlayerHpZero,
  processStatusTurn,
} from './combat-handlers.js'
import { getEffectiveStat } from './effects.js'
import { applyIncomingDamage } from './character-abilities.js'
import { getModValue } from './mods.js'
import { regularByLoc, skills as allSkills } from './game-data.js'
import { getEquippedSkills } from './skill-slots.js'
import { config } from '../config.js'

// ── Lanes ────────────────────────────────────────────────────────────────
const LANE_NAMES = ['left', 'center', 'right']
const laneName = (n) => LANE_NAMES[n] ?? 'center'

// Where a fresh pack spreads: flanks first (left + right), then the center
// lane fills. A 4th monster doubles up in the center, the most-exposed lane.
const LANE_SPREAD = [0, 2, 1, 1]

// Exponents for scaleEnemyToPlayer on a swarm monster. Squishier than a boss:
// HP tracks power (hpExp near 1) so a whale can no longer one-shot the pack and
// every monster survives roughly a hit and a half, long enough to close from
// both flanks and connect; ATK climbs gently and DEF barely moves because 2-4
// of them swing at once and monsters are hitters, not walls.
const MONSTER_SCALE = { hpExp: 0.85, atkExp: 0.4, defExp: 0.2 }

const APPRENTICE_TITLES = [
  'the Grit Sworn',
  'the Iron Willed',
  'the Stubborn Blade',
  'the Unyielding Cadet',
]

// ── Flavor ───────────────────────────────────────────────────────────────
// Swarm combat should read like a fight you are living through, not a ledger
// of hits. Every reaction pulls from a pool so the same beat never lands twice
// in a row, and near-misses carry a timing tell ("by 0.4 seconds") to sell the
// close call. The numbers stay, the player still needs the read, they just
// arrive wrapped in the moment. No dashes, per the player-facing copy rule.
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const em = (m) => m.emoji ?? '👹'

// A near-miss margin. Turn combat has no real clock, so this is pure color,
// and the owner asked for it by name: sometimes an actual fraction of a second.
const MARGINS = [
  'by a hair', 'by half a breath', 'so close you feel the wind of it',
  'a blink before it lands', 'by the width of a heartbeat', 'with nothing to spare',
]
const margin = () =>
  Math.random() < 0.45 ? `by ${(0.1 + Math.random() * 0.5).toFixed(1)} seconds` : pick(MARGINS)

// You stepped out of a committed swing (moved clear of its reach).
const WHIFF_LINES = [
  (m) => `💨 ${em(m)} ${m.name} commits to the swing and hits the air where you stood.`,
  (m) => `💨 You clear ${em(m)} ${m.name}'s lane ${margin()}, its blow tears through nothing.`,
  (m) => `💨 Too late to correct, ${em(m)} ${m.name}'s strike carries past you.`,
  (m) => `💨 ${em(m)} ${m.name} swings where you were, not where you are.`,
]

// Whole volley slipped on a clean dodge.
const SLIP_LINES = [
  (n) => `🌀 You bend the whole thing around you, ${n} strike${n > 1 ? 's slip' : ' slips'} past ${margin()}.`,
  (n) => `🌀 You read every angle and slip it ${margin()}, the swarm finds only afterimage.`,
  (n) => `🌀 Not one lands, you slide clear ${margin()}.`,
  (n) => `🌀 You duck under the whole swarm ${margin()} and come up untouched.`,
]

// Dodge answered a beat late: it grazes.
const GRAZE_INTRO = [
  `😬 A fraction too slow. You twist, but not all of it misses.`,
  `😬 You move a beat late and the edge of the volley catches you.`,
  `😬 Almost. The dodge is late and it clips you on the way past.`,
  `😬 Not quite, you slip most of it and wear the rest.`,
]

// A monster's blow landing at full weight.
const HIT_LINES = [
  (m, d, bar) => `${em(m)} ${m.name} crashes into you for *${d}*.  ${bar}`,
  (m, d, bar) => `${em(m)} ${m.name} catches you clean, *${d}*.  ${bar}`,
  (m, d, bar) => `${em(m)} You take ${m.name}'s full weight, *${d}*.  ${bar}`,
  (m, d, bar) => `${em(m)} ${m.name} lands it before you recover, *${d}*.  ${bar}`,
]
// Blow landing while you guard.
const GUARD_HIT_LINES = [
  (m, d, bar) => `🛡️ You take ${em(m)} ${m.name} on your guard, *${d}* bleeds through.  ${bar}`,
  (m, d, bar) => `🛡️ ${em(m)} ${m.name} hammers your guard for *${d}*.  ${bar}`,
  (m, d, bar) => `🛡️ Braced, you give up only *${d}* to ${em(m)} ${m.name}.  ${bar}`,
]
// Blow landing as a graze (a late dodge softened it).
const GRAZE_HIT_LINES = [
  (m, d, bar) => `   ${em(m)} ${m.name} clips you for *${d}*.  ${bar}`,
  (m, d, bar) => `   ${em(m)} ${m.name}'s edge grazes you, *${d}*.  ${bar}`,
]

// Your strike missing.
const MISS_LINES = [
  (m) => `🗡️ You commit early and ${em(m)} ${m.name} isn't there, your strike finds nothing.`,
  (m) => `🗡️ ${em(m)} ${m.name} reads it and slips your swing.`,
  (m) => `🗡️ Your blade whistles past ${em(m)} ${m.name} by a hair.`,
]
// Your strike landing.
const PLAYER_HIT_LINES = [
  (m, d, bar, c) => `🗡️ You cut into ${em(m)} ${m.name} for *${d}*${c}.  ${bar}`,
  (m, d, bar, c) => `🗡️ Your strike bites ${em(m)} ${m.name}, *${d}*${c}.  ${bar}`,
  (m, d, bar, c) => `🗡️ You open up ${em(m)} ${m.name} for *${d}*${c}.  ${bar}`,
]
const CRIT_TAG = [' 💥 *clean through*', ' 💥 *a perfect line*', ' 💥 *right where it hurts*']
// A monster dropping.
const KILL_LINES = [
  (m) => `☠️ ${em(m)} *${m.name}* drops and does not rise.`,
  (m) => `☠️ *${m.name}* folds under it.`,
  (m) => `☠️ You put ${em(m)} *${m.name}* down.`,
  (m) => `☠️ *${m.name}* falls, one less blade on you.`,
]
// Brace on a dodge turn.
const DODGE_BRACE = [
  `🌀 You stop reading their health and start reading their feet.`,
  `🌀 You drop your weight and watch the whole line at once.`,
  `🌀 You give up the attack and read the swarm instead.`,
]

// ── Build ──────────────────────────────────────────────────────────────────
/**
 * buildSwarmFloor(locationId, floor) -> { monsters, isApprentice } | null
 *
 * Pack size scales gently for a starter dungeon: floors 1-30 -> 2, 31-60 -> 3,
 * 61-99 -> 4. Every 10th floor (10, 20, ... 90) is a checkpoint: one elevated
 * "apprentice" mini-boss (a pickMonsterForFloor base, ~2.2x HP / ~1.4x ATK /
 * ~2x rewards, themed to Asta as a grit-sworn sword rookie) plus 1-2 escorts.
 * The apprentice is deliberately NOT isBoss, so the floor-clear still runs
 * handleVictory's regular floor-advance branch, not the boss/conquest branch.
 * Floor 100 (Asta) never reaches here: dungeon.js keeps it on the 1v1 path.
 * Returns null when the location has no monster pool for this floor, so the
 * caller can fall back to the existing "no monsters found" bug message.
 */
export function buildSwarmFloor(locationId, floor, player = null) {
  const checkpoint = floor % 10 === 0
  const count = floor <= 30 ? 2 : floor <= 60 ? 3 : 4
  const monsters = []

  if (checkpoint) {
    const base = pickMonsterForFloor(locationId, floor, regularByLoc)
    if (!base) return null
    const title = APPRENTICE_TITLES[Math.floor(Math.random() * APPRENTICE_TITLES.length)]
    monsters.push(mkMonster({
      ...base,
      name: `Apprentice of the Sword, ${title}`,
      emoji: '💀',
      tier: 'elite',
      hp: Math.round(base.hp * 2.2),
      maxHp: Math.round(base.maxHp * 2.2),
      atk: Math.round(base.atk * 1.4),
      xp: Math.round((base.xp ?? 0) * 2),
      solars: Math.round((base.solars ?? 0) * 2),
      isBoss: false,
      apprentice: true,
    }, 0, 1))
    const escorts = count <= 2 ? 1 : 2
    for (let i = 0; i < escorts; i++) {
      const e = pickMonsterForFloor(locationId, floor, regularByLoc)
      if (e) monsters.push(mkMonster(e, monsters.length, i === 0 ? 0 : 2))
    }
  } else {
    for (let i = 0; i < count; i++) {
      const m = pickMonsterForFloor(locationId, floor, regularByLoc)
      if (!m) continue
      monsters.push(mkMonster(m, monsters.length, LANE_SPREAD[i] ?? 1))
    }
  }

  if (!monsters.length) return null
  // Player-power scaling: a whale who has outgrown the floor curve gets a pack
  // with the HP to survive more than one swing and the bite to actually hurt
  // from every lane at once, while an on-curve or weak climber sees the swarm
  // exactly as the curve tuned it (ratio floored at 1 inside enemyPowerRatio).
  const ratio = player ? enemyPowerRatio(player, locationId, floor) : 1
  if (ratio > 1) for (const m of monsters) scaleEnemyToPlayer(m, ratio, MONSTER_SCALE)
  return { monsters, isApprentice: checkpoint }
}

// A monster spawns FAR and not yet winding up: the first turn is a free read of
// the field, not free damage taken. spawnTurn anchors its personal speed-kill
// clock so a monster killed fast still pays like a fast 1v1 kill.
function mkMonster(m, uid, lane) {
  return { ...m, uid, lane, range: 'far', telegraph: false, alive: true, spawnTurn: 1 }
}

// ── Field queries ────────────────────────────────────────────────────────
const liveMonsters = (bs) => bs.monsters.filter((m) => m.alive)

const inReach = (m, playerLane) =>
  m.alive && m.range === 'near' && Math.abs(m.lane - playerLane) <= 1

// Stable, identical ordering for the frame and for `.attack <n>` targeting, so
// the number a player sees is the number they hit. Left to right, then spawn
// order within a lane.
const displayList = (bs) =>
  liveMonsters(bs).slice().sort((a, b) => a.lane - b.lane || a.uid - b.uid)

/**
 * The default target and the value parked on bs.enemy: the most pressing threat.
 * A monster winding up in your reach outranks everything (killing it cancels
 * its hit — "punish the opening"), then anything else in reach, then near, then
 * far; ties break by lane distance.
 */
function nearestThreat(bs) {
  const live = liveMonsters(bs)
  if (!live.length) return null
  const pl = bs.playerLane
  const rank = (m) => {
    const ir = m.range === 'near' && Math.abs(m.lane - pl) <= 1
    if (ir && m.telegraph) return 0
    if (ir) return 1
    if (m.range === 'near') return 2
    return 3
  }
  return live.slice().sort((a, b) =>
    rank(a) - rank(b) || Math.abs(a.lane - pl) - Math.abs(b.lane - pl) || a.uid - b.uid
  )[0]
}

function killTurnsFor(bs, m) {
  return Math.max(1, bs.turn - (m.spawnTurn ?? 1) + 1)
}

// AGI-driven, same spirit as the 1v1 hit tables: a nimble hunter slips a volley
// far more often, but it is never a sure thing and never hopeless.
function swarmDodgeChance(player) {
  const agi =
    getEffectiveStat(player, 'agi') ||
    getEffectiveStat(player, 'dex') ||
    getEffectiveStat(player, 'spd') ||
    10
  return Math.min(0.85, Math.max(0.3, 0.45 + agi * 0.0025))
}

function swarmFleeChance(player) {
  const agi =
    getEffectiveStat(player, 'agi') ||
    getEffectiveStat(player, 'dex') ||
    getEffectiveStat(player, 'spd') ||
    10
  return Math.min(0.85, Math.max(0.35, 0.45 + agi * 0.002))
}

// One monster's blow landing on the player. mult 1 = full, 0.35 = a graze (a
// dodge answered a beat too late). All incoming damage funnels through
// applyIncomingDamage so cat form, Gojo's Infinity, Alexa's Lovestruck, relics
// and the rest read a swarm hit exactly like any other. It subtracts HP itself.
function strike(player, m, mult, defending, style = 'full') {
  const raw = calcMonsterDamage(getEffectiveStat(m, 'atk'), getEffectiveStat(player, 'def'), defending)
  const dmg = Math.max(1, Math.round(raw * mult))
  const res = applyIncomingDamage(player, dmg)
  let line = ''
  if (res.message) line += res.message + '\n'
  const bar = hpBar(player.hp, player.maxHp)
  const pool = style === 'graze' ? GRAZE_HIT_LINES : (defending ? GUARD_HIT_LINES : HIT_LINES)
  line += pick(pool)(m, res.damage, bar) + '\n'
  return line
}

/**
 * Route a mid-turn player death through the canonical chain (totem -> Yoriichi
 * cat form -> Anastasia hypnosis rewind -> pearl -> real death). bs.enemy MUST
 * already point at the monster that dealt the killing blow, because the
 * cat-form auto-fight resumes against a single enemy. Returns { ended } — when
 * ended is true the chain already replied and we return its value; when false
 * the player was saved (totem/hypnosis) and the turn continues with res.msg.
 */
async function routeDeath(player, ctx, msg) {
  const res = await resolvePlayerHpZero(player, ctx, msg, { boss: false })
  if (res.fallThrough) return { ended: false, msg: res.msg ?? msg }
  return { ended: true, value: res.returnValue }
}

// ── The turn ────────────────────────────────────────────────────────────────
/**
 * One swarm turn, shared by every verb:
 *   1. tick the player's status (DOT/CC/fusion clock); death -> routeDeath
 *   2. apply the player's action (attack/skill/move/dodge/defend)
 *   3. resolve telegraphs set LAST turn: kill/whiff/graze/land; death -> routeDeath
 *   4. survivors drift toward the player, far -> near, and re-telegraph
 *   5. advance the turn counter, refresh bs.enemy
 *   6. render the frame and reply
 * The floor-clearing kill short-circuits in step 2/3 into handleVictory.
 */
async function processSwarmTurn(player, ctx, action) {
  const bs = player.battleState
  const p = config.prefix
  let msg = ''
  let lastHitter = null

  // 1. player status
  const status = processStatusTurn(player)
  if (status.lines?.length) msg += status.lines.join('\n') + '\n'
  if (player.hp <= 0) {
    bs.enemy = nearestThreat(bs) ?? bs.monsters[0]
    const done = await routeDeath(player, ctx, msg)
    if (done.ended) return done.value
    msg = done.msg
  }
  const incap = status.incapacitated

  // A fresh guard state every turn: only this turn's defend keeps it up, which
  // is what mitigates the volley resolving in step 3 below.
  bs.playerDefending = false
  let playerDodged = false

  // 2. player action
  if (incap) {
    msg += `💫 You're unable to act this turn!\n`
  } else if (action.kind === 'attack' || action.kind === 'skill') {
    if (action.kind === 'skill') {
      player.mp = Math.max(0, (player.mp ?? 0) - action.skill.mpCost)
      msg += `✨ You channel *${action.skill.name}*.\n`
    }
    // A basic attack is DIRECTIONAL now: the resolver already aimed it left or
    // right and there is no auto-target fallback, so a swing with nothing in
    // reach on that side commits to empty air and still costs the turn (step 3's
    // telegraphs land regardless). That is the whole point of aiming with al/ar,
    // there is no free general swing anymore. A skill still auto-targets the
    // nearest threat: it is MP-gated, not the spammable free attack.
    const target = action.kind === 'attack'
      ? (action.target?.alive ? action.target : null)
      : (action.target?.alive ? action.target : nearestThreat(bs))
    if (action.kind === 'attack' && !target) {
      const side = action.dir === 'right' ? 'right' : 'left'
      msg += `🗡️ You swing to your *${side}* and cut only air, nothing is in reach there.\n`
    } else if (target) {
      if (Math.random() > calcPlayerHitChance(player, target)) {
        msg += pick(MISS_LINES)(target) + '\n'
      } else {
        const dmgMult = 1 + (getModValue(player, 'damage_multiplier') ?? 0)
        const critBoost = getModValue(player, 'crit_chance_boost') ?? 0
        const { rawDmg, isCrit } = calcPlayerDamage(
          player, action.kind === 'skill' ? action.skill : null, dmgMult, critBoost, { consumeBuffs: true },
        )
        const dmg = applyDefense(rawDmg, getEffectiveStat(target, 'def'))
        target.hp = Math.max(0, target.hp - dmg)
        msg += pick(PLAYER_HIT_LINES)(target, dmg, hpBar(target.hp, target.maxHp), isCrit ? pick(CRIT_TAG) : '') + '\n'
        if (target.hp <= 0) {
          target.alive = false
          msg += pick(KILL_LINES)(target) + '\n'
          if (!bs.monsters.some((m) => m.alive)) {
            // Last monster of the floor. Hand the kill to handleVictory so the
            // floor advances, HP/MP regens and the checkpoint saves, all exactly
            // as a 1v1 clear would. Set bs.turn to THIS monster's personal kill
            // time first, since handleVictory reads bs.turn for the speed-kill reward.
            await ctx.reply(msg.trimEnd())
            bs.turn = killTurnsFor(bs, target)
            return handleVictory(player, target, ctx)
          }
          // Not the last kill: pay it on the same terms as a 1v1 kill, no floor
          // advance. XP, Solars and drops are credited inside.
          creditKill(player, target, ctx, {
            battleType: 'dungeon',
            killTurns: killTurnsFor(bs, target),
            locId: bs.locationId,
          })
        }
      }
    }
  } else if (action.kind === 'ability') {
    // A character's signature active (Puppet Strings, Unlimited Void, Cinder
    // Verdict, ...) folded into one swarm turn. The plugin's apply() does the
    // ability's core single-target effect on the nearest threat — it writes
    // target.hp itself, exactly like the attack branch — and returns its
    // narration plus optional control flags. cancelTelegraph drops the target's
    // pending wind-up now; suppressReTelegraph stops it re-aiming this turn, so
    // a control move "spends its next move" without a monster status the swarm
    // engine does not tick. Kills are credited on the SAME terms as an .attack
    // kill: a non-final kill pays through creditKill, only the floor-clearing
    // blow hands off to handleVictory (so a single-target ability can never
    // wrongly clear a floor while other monsters are still alive).
    const target = action.target?.alive ? action.target : nearestThreat(bs)
    if (!target) {
      msg += `_There is nothing left on the field to reach._\n`
    } else {
      const r = action.apply(target, player, bs) ?? {}
      if (r.lines?.length) msg += r.lines.join('\n') + '\n'
      if (r.cancelTelegraph) target.telegraph = false
      if (r.suppressReTelegraph) target._skipReTelegraph = true
      if (target.hp <= 0) {
        target.alive = false
        msg += pick(KILL_LINES)(target) + '\n'
        if (!bs.monsters.some((m) => m.alive)) {
          await ctx.reply(msg.trimEnd())
          bs.turn = killTurnsFor(bs, target)
          return handleVictory(player, target, ctx)
        }
        creditKill(player, target, ctx, {
          battleType: 'dungeon',
          killTurns: killTurnsFor(bs, target),
          locId: bs.locationId,
        })
      }
    }
  } else if (action.kind === 'move') {
    const before = bs.playerLane
    bs.playerLane = action.dir === 'left' ? Math.max(0, bs.playerLane - 1) : Math.min(2, bs.playerLane + 1)
    msg += bs.playerLane === before
      ? `🚧 You're already at the ${laneName(bs.playerLane)} edge.\n`
      : `🏃 You shift to the *${laneName(bs.playerLane)} lane*.\n`
  } else if (action.kind === 'dodge') {
    playerDodged = true
    msg += pick(DODGE_BRACE) + '\n'
  } else if (action.kind === 'defend') {
    bs.playerDefending = true
    const regen = Math.ceil((player.maxMp ?? 0) * 0.25)
    player.mp = Math.min(player.maxMp ?? 0, (player.mp ?? 0) + regen)
    msg += `🛡️ You raise your guard${regen ? ` and recover *${regen} MP*` : ''}.\n`
  }

  // 3. telegraphs due this turn (set last turn). A dead monster's is already
  // cancelled — it's not in liveMonsters — which is "kill the winder" for free.
  let volley = []
  for (const m of liveMonsters(bs)) {
    if (!m.telegraph) continue
    m.telegraph = false
    if (!inReach(m, bs.playerLane)) {
      msg += pick(WHIFF_LINES)(m) + '\n'
      continue
    }
    volley.push(m)
  }
  if (volley.length) {
    if (playerDodged) {
      if (Math.random() < swarmDodgeChance(player)) {
        msg += pick(SLIP_LINES)(volley.length) + '\n'
        volley = []
      } else {
        msg += pick(GRAZE_INTRO) + '\n'
        for (const m of volley) { msg += strike(player, m, 0.35, false, 'graze'); lastHitter = m }
      }
    } else {
      for (const m of volley) { msg += strike(player, m, 1, bs.playerDefending); lastHitter = m }
    }
  }
  if (player.hp <= 0) {
    bs.enemy = lastHitter ?? nearestThreat(bs) ?? bs.monsters[0]
    const done = await routeDeath(player, ctx, msg)
    if (done.ended) return done.value
    msg = done.msg
  }

  // 4. approach & flank, then re-telegraph. Drift happens here, AFTER this
  // turn's telegraphs resolved, so a near monster is "committed" to its lane
  // for the turn (your move can whiff it) and only re-aims between turns.
  for (const m of liveMonsters(bs)) {
    if (Math.abs(m.lane - bs.playerLane) > 1) m.lane += Math.sign(bs.playerLane - m.lane)
    if (m.range === 'far' && Math.abs(m.lane - bs.playerLane) <= 1) m.range = 'near'
  }
  for (const m of liveMonsters(bs)) {
    // A monster whose wind-up a control ability just cancelled skips its re-aim
    // for this one turn: it loses its next move instead of instantly winding up
    // again. The flag is one-shot, cleared the moment it is honored.
    if (m._skipReTelegraph) { m._skipReTelegraph = false; continue }
    if (inReach(m, bs.playerLane)) m.telegraph = true
  }

  // 5. advance
  bs.turn++
  bs.enemy = nearestThreat(bs) ?? bs.monsters[0]

  // 6. render
  await ctx.reply(msg.trimEnd() + '\n\n' + renderSwarmFrame(bs, player))
  return player
}

// ── Verb resolvers (called from the plugins, inside updatePlayer) ───────────

// The nearest live NEAR monster on one side of you, or null. "Left" is the lane
// immediately to your left (playerLane-1), "right" is playerLane+1; reach is one
// lane, so those are the only side lanes that exist. A monster in your OWN lane
// is "on top of you" and is deliberately NOT returned here: no side-swing lands
// on it, you have to step off its lane (ml/mr) to line it up first. A winding-up
// flanker is picked ahead of a quiet one so you can still punish the opening.
function directionalTarget(bs, dir) {
  const wantLane = dir === 'left' ? bs.playerLane - 1 : bs.playerLane + 1
  const cands = liveMonsters(bs).filter((m) => m.range === 'near' && m.lane === wantLane)
  if (!cands.length) return null
  return cands.sort((a, b) => (b.telegraph ? 1 : 0) - (a.telegraph ? 1 : 0) || a.uid - b.uid)[0]
}

/**
 * A directional basic attack: .al strikes left, .ar strikes right. There is no
 * auto-target, the direction IS the aim. If nothing is in reach on that side the
 * swing still commits (processSwarmTurn resolves it as a whiff into empty air and
 * the swarm's telegraphs still land), so mis-reading the field costs you the turn.
 */
export async function resolveSwarmDirectionalAttack(player, ctx, dir) {
  const bs = player.battleState
  const target = directionalTarget(bs, dir)
  return processSwarmTurn(player, ctx, { kind: 'attack', dir, target })
}

/**
 * The plain .a / .attack path in a swarm fight. Attacks are directional now, so a
 * bare swing no longer auto-targets and grinds the pack down on its own. It costs
 * no turn: it just points the player at .al / .ar and the read they now have to
 * make, then reprints the field so the new controls are right there.
 */
export async function swarmAttackNudge(player, ctx) {
  const p = config.prefix
  await ctx.reply(
    `⚔️ *Swarm attacks are directional now.*\n` +
    `A plain *${p}a* no longer swings, the pack closes from your *left*, your *right*, and right *on top of you*.\n\n` +
    `▸ *${p}al* — strike the monster on your *left* ◀\n` +
    `▸ *${p}ar* — strike the monster on your *right* ▶\n` +
    `▸ *${p}ml* / *${p}mr* — sidestep to line up whatever is *on top of you*, then strike\n\n` +
    `_A swing into an empty side cuts only air and still costs the turn, so read the field._\n\n` +
    renderSwarmFrame(player.battleState, player),
  )
  return player
}

export async function resolveSwarmSkill(player, ctx) {
  const bs = player.battleState
  const p = config.prefix
  const equipped = getEquippedSkills(player)
    .map((s) => (typeof s === 'string' ? allSkills.find((k) => k.id === s) : s))
    .filter(Boolean)
  const damaging = equipped.filter((s) => s.type === 'active' && s.effects?.[0]?.multiplier != null)
  if (!damaging.length) {
    await ctx.reply(`✋ No active damaging skill equipped for the swarm. Use *${p}attack*.`)
    return player
  }

  // Optional trailing target number: ".skill fireball 2". The rest is the name.
  const args = (ctx.args ?? []).slice()
  let target = nearestThreat(bs)
  if (args.length && /^\d+$/.test(args[args.length - 1])) {
    const list = displayList(bs)
    const picked = list[parseInt(args.pop(), 10) - 1]
    if (picked) target = picked
  }
  const query = args.join(' ').toLowerCase().trim()
  let skill = query ? damaging.find((s) => s.name.toLowerCase().includes(query)) : null
  if (query && !skill) {
    await ctx.reply(`❓ No damaging skill matches "${query}". Equipped: ${damaging.map((s) => s.name).join(', ')}`)
    return player
  }
  if (!skill) skill = damaging.find((s) => (player.mp ?? 0) >= s.mpCost) ?? damaging[0]
  if ((player.mp ?? 0) < skill.mpCost) {
    await ctx.reply(`💧 *${skill.name}* needs *${skill.mpCost} MP*, you have *${player.mp ?? 0}*. Use *${p}defend* to regen.`)
    return player
  }
  return processSwarmTurn(player, ctx, { kind: 'skill', target, skill })
}

export async function resolveSwarmDefend(player, ctx) {
  return processSwarmTurn(player, ctx, { kind: 'defend' })
}

export async function resolveSwarmDodge(player, ctx) {
  return processSwarmTurn(player, ctx, { kind: 'dodge' })
}

export async function resolveSwarmMove(player, ctx, dir) {
  return processSwarmTurn(player, ctx, { kind: 'move', dir })
}

export async function resolveSwarmFlee(player, ctx) {
  const bs = player.battleState
  const p = config.prefix
  if (Math.random() < swarmFleeChance(player)) {
    player.inBattle = false
    player.battleState = null
    await ctx.reply(`🏃 You break off and slip away from the swarm.`)
    return player
  }
  // Failed break: you turned your back, so every telegraphing monster still in
  // reach lands its blow at full. No dodge, no guard.
  let msg = `😖 You couldn't break away!\n`
  let lastHitter = null
  for (const m of liveMonsters(bs)) {
    if (m.telegraph && inReach(m, bs.playerLane)) {
      m.telegraph = false
      msg += strike(player, m, 1, false)
      lastHitter = m
    }
  }
  if (player.hp <= 0) {
    bs.enemy = lastHitter ?? nearestThreat(bs) ?? bs.monsters[0]
    const res = await resolvePlayerHpZero(player, ctx, msg, { boss: false })
    if (!res.fallThrough) return res.returnValue
    msg = res.msg ?? msg
  }
  // Survivors reposition and re-telegraph, same as a normal turn's tail.
  for (const m of liveMonsters(bs)) {
    if (Math.abs(m.lane - bs.playerLane) > 1) m.lane += Math.sign(bs.playerLane - m.lane)
    if (m.range === 'far' && Math.abs(m.lane - bs.playerLane) <= 1) m.range = 'near'
  }
  for (const m of liveMonsters(bs)) {
    if (inReach(m, bs.playerLane)) m.telegraph = true
  }
  bs.turn++
  bs.enemy = nearestThreat(bs) ?? bs.monsters[0]
  await ctx.reply(msg.trimEnd() + '\n\n' + renderSwarmFrame(bs, player))
  return player
}

/**
 * resolveSwarmAbility — a character's signature active on a swarm floor.
 *
 * Called from an ability plugin exactly like resolveSwarmDirectionalAttack: inside the
 * plugin's updatePlayer mutator, AFTER its once-per-battle gate has burned, so
 * the latch is spent once and the ability then plays out as ONE swarm turn
 * against the nearest threat (or opts.target). apply(target, player, bs) does
 * the ability's core single-target effect — writing target.hp itself, like the
 * attack branch — and returns { lines?, cancelTelegraph?, suppressReTelegraph? }.
 * The shared 'ability' branch in processSwarmTurn owns kills, crediting and the
 * frame, so no plugin re-implements floor advance or victory in swarm.
 */
export async function resolveSwarmAbility(player, ctx, apply, opts = {}) {
  const bs = player.battleState
  const target = opts.target?.alive ? opts.target : nearestThreat(bs)
  return processSwarmTurn(player, ctx, { kind: 'ability', apply, target })
}

// ── Frame ────────────────────────────────────────────────────────────────
/**
 * The text battlefield, laid out by DIRECTION relative to you: what is on your
 * left, what is right on top of you, and what is on your right. That is the read
 * the fight now runs on, since .al / .ar strike a side and a monster in your own
 * lane can only be reached after you step off it. Each live monster shows its
 * approach (closing / in reach / point-blank), a wind-up warning and an HP bar;
 * then your bars, who strikes next turn, the point-blank nudge, and the controls.
 */
export function renderSwarmFrame(bs, player) {
  const p = config.prefix
  const pl = bs.playerLane
  const live = displayList(bs)

  const sideOf = (m) => (m.lane < pl ? 'left' : m.lane > pl ? 'right' : 'onyou')
  const groups = { left: [], onyou: [], right: [] }
  for (const m of live) groups[sideOf(m)].push(m)

  const monsterLine = (m) => {
    const tag = m.range === 'far'
      ? '🔭 closing in'
      : (sideOf(m) === 'onyou' ? '⚠️ point-blank' : '⚔️ in reach')
    const warn = m.telegraph ? '  ⚠️ *winding up!*' : ''
    return `   ${m.emoji ?? '👹'} ${m.name} _(${tag})_${warn}\n   ${hpBar(m.hp, m.maxHp)}`
  }

  let out = `⚔️ *FLOOR ${bs.floor} — SWARM*${bs.isApprentice ? '  💀 _Apprentice Wave_' : ''}\n`
  out += `🧭 You hold the *${laneName(pl)}* — they close from every side.\n`

  if (groups.left.length)  out += `\n◀ *YOUR LEFT*\n`  + groups.left.map(monsterLine).join('\n')  + '\n'
  if (groups.onyou.length) out += `\n● *ON YOU*\n`      + groups.onyou.map(monsterLine).join('\n') + '\n'
  if (groups.right.length) out += `\n▶ *YOUR RIGHT*\n` + groups.right.map(monsterLine).join('\n') + '\n'

  out += `\n👤 *${player.name ?? 'You'}*  ${hpBar(player.hp, player.maxHp)}  💧 ${player.mp ?? 0}/${player.maxMp ?? 0}\n`

  const incoming = live.filter((m) => m.telegraph)
  out += incoming.length
    ? `\n🎯 *Next turn:* ${incoming.map((m) => m.name).join(', ')} will strike. Cut them down, ${p}dodge, or move clear.\n`
    : `\n_The field is still... for now._\n`

  // The point-blank nudge: a NEAR monster in your own lane can't be hit by a side
  // swing, so tell the player to step off its lane first (the move-and-attack read).
  const onTop = groups.onyou.filter((m) => m.range === 'near')
  if (onTop.length) {
    out += `⚠️ *${onTop.map((m) => m.name).join(', ')}* ${onTop.length > 1 ? 'are' : 'is'} on top of you. Sidestep (*${p}ml* / *${p}mr*), then strike.\n`
  }

  out += `\n▸ *${p}al* ◀ strike left · *${p}ar* strike right ▶\n`
  out += `▸ *${p}ml* / *${p}mr* move · *${p}dodge* · *${p}defend* · *${p}skill* · *${p}flee*`
  return out
}
