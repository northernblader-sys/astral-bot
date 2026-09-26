/**
 * lib/megumi.js — Megumi Fushiguro's "Ten Shadows Technique", his Domain
 * Expansion "Chimera Shadow Garden", and the Mahoraga summon.
 *
 * Structurally this mirrors the Miyashi / Nisha aura sections in
 * lib/character-abilities.js: a small tuning block, a hasMegumi() gate, and
 * a set of pure(-ish) functions the combat plugins call from the SAME
 * turn-start / incoming-hit / signature-command slots they already call
 * tickFrostbindAura(), rollSerpentsGrace(), applyAlyaStatBreak() and
 * activateCinderVerdict() from. Everything here is re-exported from the top
 * of lib/character-abilities.js so the combat files import Megumi's helpers
 * from the exact same module as every other character.
 *
 * There is NO import cycle with character-abilities.js: the swarm drains
 * enemy.hp directly (the tickFrostbindAura / applyAbsoluteOneSiphon
 * convention — an ambient aura, not a mitigated "hit"), the Domain opening
 * burst runs through combat-engine.js's own calcPlayerDamage()/applyDefense()
 * pipeline, and Mahoraga's adaptation only ever RETURNS a "this hit is
 * nullified" flag — the caller zeroes the damage. So this file depends only
 * on effects.js, combat-engine.js and image.js.
 *
 * ── The three pieces ────────────────────────────────────────────────────
 *
 * 1. Thousand Shadows Swarm (passive, every Megumi turn — megumiTurnStart):
 *    Megumi floods the field with cursed spirits that drain the opponent's
 *    life force and steadily crush their attack. Each turn:
 *      • drains a growing % of the target's MAX HP (bypasses DEF — ambient),
 *      • heals Megumi a fraction of what was drained ("life force"), and
 *      • deepens a cumulative ATK debuff on the target (a single growing
 *        `weaken` effect, so it never stacks into a hundred entries).
 *    The drain % and the ATK cut both DOUBLE while the Domain is open.
 *
 * 2. Chimera Shadow Garden — Domain Expansion (.domain-expansion):
 *    Pinpoint-accurate to the anime. CSG is Megumi's INCOMPLETE domain:
 *      • No barrier ⇒ NO sure-hit guarantee and NO opponent lock-in, so it is
 *        modeled as a state, not a one-shot "you cannot dodge" nuke, and it
 *        costs 0 MP (canon: very low cursed-energy cost — he can maintain it).
 *      • Unlimited hand-sign-free shikigami, INCLUDING duplicates of already
 *        destroyed ones ⇒ the swarm's drain and ATK cut DOUBLE for the rest
 *        of the fight.
 *      • Megumi and his shikigami travel freely through the shadows ⇒ a high
 *        flat dodge chance on incoming hits while it is open.
 *      • An opening burst (a summoned horde) that runs through the ordinary
 *        damage pipeline at DOMAIN_BURST_MULT — sits between Wither's
 *        Cinder Verdict (8.0) and Circe's Wishing Star (12.0).
 *      • Canon tie-in: opening the Garden is exactly where Megumi reaches for
 *        Mahoraga, so activating it "summons" Mahoraga for the fight too.
 *    Once per battle; lasts the rest of the battle (a state change, like
 *    Mei's Final Form), tracked on battleState so it clears for free at
 *    fight end.
 *
 * 3. Mahoraga — the Divine General (recordMahoragaExposure):
 *    Available only while Megumi is equipped (the Ten Shadows' final
 *    shikigami). Its Wheel adapts to any single move used against Megumi over
 *    3 CONSECUTIVE uses; on the 3rd, the Wheel spins, the move is mastered,
 *    and that exact move deals 0 damage from then on — until a DIFFERENT move
 *    is used (a new move starts its own 3-count; a mastered move stays
 *    mastered). Move identity keys: 'attack' (basic), 'skill:<id>',
 *    'boss:<AttackName>', 'enemy:basic'. This matches the requested behavior
 *    verbatim: `.pvp skill fireball` three times ⇒ fireball nullified; any
 *    exact `.pvp attack`/skill used 3× ⇒ nulled.
 */

import { addStatusEffect, getEffectiveStat, resolveVoidRebound } from './effects.js'
import { calcPlayerDamage, applyDefense } from './combat-engine.js'
import { sendImageTo, sendGifTo } from './image.js'

// ── Assets (user-supplied) ─────────────────────────────────────────────────
export const MEGUMI_IMAGE   = 'https://i.ibb.co/VY7VY4Nq/Megumi-Fushiguro.jpg'
export const DOMAIN_IMAGE    = 'https://i.ibb.co/sv5G9C3D/megumi-domain-expansion.jpg'
export const MAHORAGA_IMAGE  = 'https://i.ibb.co/Dgjt55TW/THE-DIVINE-GENRAL-MAHORAGA.jpg'
export const WHEEL_GIF        = 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExNjNqd3lpbG9kOHh4Mnl6NDkyeXZiYWlpZ2h4b29oMnI4bnB0anU3YiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3PWoEkrdX6eLVcyT4I/giphy.gif'

// ── Tuning block ────────────────────────────────────────────────────────────
// Thousand Shadows Swarm
const SWARM_DRAIN_BASE     = 0.035  // % of target max HP drained on turn 1
const SWARM_DRAIN_STEP     = 0.005  // +0.5% each subsequent turn
const SWARM_DRAIN_CAP      = 0.07   // capped at 7% (before Domain doubling)
const SWARM_HEAL_FRAC      = 0.40   // Megumi heals 40% of what he drains
const SWARM_ATK_CUT_STEP   = 0.06   // ATK cut deepens 6%/turn
const SWARM_ATK_CUT_CAP    = 0.60   // ATK cut caps at 60% (before Domain doubling)
const SWARM_ATK_CUT_CEIL   = 0.85   // absolute ceiling after any doubling
const SWARM_ATK_DURATION   = 4      // re-applied every turn, so a short window that stays fresh
const SWARM_SOURCE         = 'megumi_shadow_swarm'

// Chimera Shadow Garden
const DOMAIN_SWARM_MULT    = 2.0    // swarm drain + ATK cut double while open
const DOMAIN_BURST_MULT    = 9.0    // opening-horde damage multiplier
const DOMAIN_DODGE_CHANCE  = 0.45   // shadow-travel evasion on incoming hits
const DOMAIN_SHIKIGAMI_PCT = 0.05   // per-turn bonus shikigami true strike (% target max HP)

// Mahoraga
const MAHORAGA_ADAPT_HITS  = 3      // consecutive uses of the same move to master it
const MAHORAGA_STRIKE_PCT  = 0.03   // per-turn shadow-sword true strike (% target max HP)

// ── Gates ───────────────────────────────────────────────────────────────────

/** True when Megumi is the equipped character. */
export function hasMegumi(player) {
  return player?.equippedCharacter === 'megumi'
}

/**
 * Mahoraga is the Ten Shadows' final shikigami — it is available whenever
 * Megumi is equipped (the summon "only works when Megumi is equipped", as
 * requested). No separate unlock: equipping Megumi is what gives access.
 */
export function hasMahoraga(player) {
  return hasMegumi(player)
}

/** Lazily create + return Megumi's per-battle scratch state on battleState. */
function megumiState(bs) {
  if (!bs) return null
  if (!bs.megumi) {
    bs.megumi = {
      turns:        0,
      domainUsed:   false,
      domainActive: false,
      mahoragaOut:  false,
      wheel:        { lastKey: null, streak: 0, mastered: {} },
    }
  }
  // Defensive: an older battleState (mid-fight upgrade) may lack wheel.
  if (!bs.megumi.wheel) bs.megumi.wheel = { lastKey: null, streak: 0, mastered: {} }
  return bs.megumi
}

export function isChimeraDomainActive(player, bsOverride = null) {
  const bs = bsOverride ?? player?.battleState
  return !!(hasMegumi(player) && bs?.megumi?.domainActive)
}

// ── 1. Thousand Shadows Swarm + Domain/Mahoraga per-turn strikes ────────────

/**
 * Deepen the cumulative ATK debuff on the target. Implemented as a SINGLE
 * `weaken` entry (sourceId SWARM_SOURCE) that is removed and re-applied each
 * turn with a larger value — so it never stacks into dozens of entries and
 * getEffectiveStat() reads one clean, growing penalty. The penalty is a % of
 * the target's BASE atk/str (not the already-weakened value), so it grows
 * predictably instead of compounding on itself toward zero.
 */
/**
 * Builds the swarm's cumulative ATK-cut effect def for `entity` at `pct`,
 * WITHOUT applying it. Split out from deepenAtkCut() below so the same math can
 * be aimed at a different entity than the one being drained — a cut that
 * rebounds off Shunya has to be recomputed from the caster's own sheet, and in a
 * duel the caster object is a snapshot that can't be mutated in place.
 * Returns null when there's nothing left to cut.
 */
function buildAtkCutDef(entity, pct) {
  const statKey =
    (entity.stats?.atk ?? entity.atk ?? 0) > 0 ? 'atk'
    : (entity.stats?.str ?? entity.str ?? 0) > 0 ? 'str'
    : 'atk'
  const base = entity.stats?.[statKey] ?? entity[statKey] ?? 0
  if (base <= 0) return null
  return {
    type: 'weaken', stat: statKey, value: Math.max(1, Math.round(base * pct)),
    duration: SWARM_ATK_DURATION, sourceId: SWARM_SOURCE,
  }
}

function deepenAtkCut(target, pct) {
  const def = buildAtkCutDef(target, pct)
  // Drop our previous instance so the debuff is replaced, not stacked.
  target.activeEffects = (target.activeEffects ?? []).filter(e => e.sourceId !== SWARM_SOURCE)
  if (!def) {
    const statKey =
      (target.stats?.atk ?? target.atk ?? 0) > 0 ? 'atk'
      : (target.stats?.str ?? target.str ?? 0) > 0 ? 'str'
      : 'atk'
    return { statKey, value: 0 }
  }
  addStatusEffect(target, def)
  return { statKey: def.stat, value: def.value }
}

const STAT_LABEL = { atk: 'ATK', str: 'STR' }

/**
 * megumiTurnStart(player, target, bsOverride) -> { message, lines[] } | null
 *
 * Call once on each of Megumi's OWN turns, in the same turn-start slot the
 * combat files already use for tickFrostbindAura()/applyAbsoluteOneSiphon()/
 * applyAlyaStatBreak(). Resolves, in order:
 *   • the Thousand Shadows Swarm drain + self-heal + ATK cut,
 *   • (Domain open) a bonus shikigami true strike,
 *   • (Mahoraga out) a shadow-sword true strike.
 * All HP movement here bypasses DEF on purpose (ambient aura / true strikes),
 * exactly like the Frostbind and Absolute One auras.
 *
 * Mutates target.hp and player.hp directly. `target` is the enemy/opponent
 * object (monster, boss, or the opposing player in PvP).
 */
export function megumiTurnStart(player, target, bsOverride = null) {
  if (!hasMegumi(player)) return null
  if (!target || (target.hp ?? 0) <= 0) return null
  const bs = bsOverride ?? player.battleState ?? null
  const st = megumiState(bs)
  if (!st) return null

  st.turns += 1
  const domain = st.domainActive
  const dMult  = domain ? DOMAIN_SWARM_MULT : 1
  const targetMax = target.maxHp ?? target.hp ?? 0
  const lines = []

  // — Drain —
  const drainPct = Math.min(SWARM_DRAIN_CAP, SWARM_DRAIN_BASE + SWARM_DRAIN_STEP * (st.turns - 1)) * dMult
  const wouldDrain = Math.min(target.hp, Math.max(1, Math.round(targetMax * drainPct)))
  const cutPct = Math.min(SWARM_ATK_CUT_CEIL, Math.min(SWARM_ATK_CUT_CAP, SWARM_ATK_CUT_STEP * st.turns) * dMult)

  // Shunya — The Empty Vessel: a thousand cursed spirits swarm a void and find
  // nothing to feed on. Both halves of the swarm turn back on Megumi — the
  // drain as damage, the ATK cut recomputed from his own sheet — and he absorbs
  // NOTHING, because the void yields no life force. His two TRUE strikes below
  // are deliberately left alone: she is immune to drains and debuffs, never to
  // raw damage, so an open Domain is still a real answer to her.
  const rebound = resolveVoidRebound(target, player, wouldDrain, 'the swarm')

  let drain = 0
  let healed = 0
  const reboundEffects = []

  const swarmWord = domain ? '🌑 *A THOUSAND SHADES* pour from the Garden' : '👥 *A thousand cursed spirits* swarm'
  lines.push(`${swarmWord} over *${target.name ?? 'the enemy'}*!`)

  if (rebound.rebounded) {
    lines.push(rebound.message)
    const ownCut = buildAtkCutDef(player, cutPct)
    if (ownCut) {
      reboundEffects.push(ownCut)
      lines.push(`⬇️ _His own ${STAT_LABEL[ownCut.stat] ?? ownCut.stat.toUpperCase()} caves in by *${ownCut.value}* instead._`)
    }
  } else {
    drain = wouldDrain
    target.hp = Math.max(0, target.hp - drain)

    // — Self-heal off the drained life force —
    const beforeHp = player.hp ?? 0
    const heal = Math.max(0, Math.round(drain * SWARM_HEAL_FRAC))
    player.hp = Math.min(player.maxHp ?? beforeHp, beforeHp + heal)
    healed = player.hp - beforeHp

    // — Cumulative ATK cut —
    const cut = deepenAtkCut(target, cutPct)

    lines.push(`🩸 _Life force drained: *${drain}*_${healed > 0 ? ` — _Megumi absorbs *${healed}* HP._` : ''}`)
    if (cut.value > 0) {
      lines.push(`⬇️ _${STAT_LABEL[cut.statKey] ?? cut.statKey.toUpperCase()} crushed by *${cut.value}* (${Math.round(cutPct * 100)}% total)._`)
    }
  }

  // — Domain: bonus shikigami true strike —
  if (domain && target.hp > 0) {
    const shik = Math.min(target.hp, Math.max(1, Math.round(targetMax * DOMAIN_SHIKIGAMI_PCT)))
    target.hp = Math.max(0, target.hp - shik)
    lines.push(`🐉 _Nue and the Great Serpent tear through the dark for *${shik}* true damage!_`)
  }

  // — Mahoraga: shadow-sword true strike while it is out —
  if (st.mahoragaOut && target.hp > 0) {
    const sword = Math.min(target.hp, Math.max(1, Math.round(targetMax * MAHORAGA_STRIKE_PCT)))
    target.hp = Math.max(0, target.hp - sword)
    lines.push(`⚔️ _Mahoraga's blade falls — *${sword}* true damage._`)
  }

  return { message: lines.join('\n'), lines, drained: drain, healed, reboundDamage: rebound.damage, reboundEffects }
}

// ── 2. Chimera Shadow Garden (Domain Expansion) ─────────────────────────────

/**
 * activateChimeraDomain(player, bsOverride) ->
 *   { ok, message, multiplier, alreadyUsed, mahoragaSummoned }
 *
 * The signature-command gate, modeled on activateCinderVerdict(): validates
 * once-per-battle, flips the persistent Domain latch (doubles the swarm +
 * grants shadow-travel dodge for the rest of the fight), summons Mahoraga for
 * the fight, and hands back the opening-burst multiplier for the caller to
 * run through calcPlayerDamage()/applyDefense() — same "reuse the real
 * pipeline, just override the multiplier" contract every other signature move
 * uses. Costs 0 MP (canon: CSG is an incomplete domain, very low cost).
 */
export function activateChimeraDomain(player, bsOverride = null) {
  if (!hasMegumi(player)) {
    return { ok: false, message: `❌ Only *Megumi Fushiguro* can expand the Chimera Shadow Garden.` }
  }
  const bs = bsOverride ?? player.battleState
  if (!bs) {
    return { ok: false, message: `❌ You can only expand your Domain in battle.` }
  }
  const st = megumiState(bs)
  if (st.domainUsed) {
    return { ok: false, alreadyUsed: true, message: `🌑 The *Chimera Shadow Garden* is already open — its shadows still flood the field.` }
  }

  st.domainUsed   = true
  st.domainActive = true
  const mahoragaSummoned = !st.mahoragaOut
  st.mahoragaOut  = true  // canon tie-in: the Garden is where Mahoraga is called

  const message =
    `╔══════ 🌑 *DOMAIN EXPANSION* 🌑 ══════╗\n` +
    `\n     *「 CHIMERA SHADOW GARDEN 」*\n     *嵌合暗翳庭*\n\n` +
    `_Shadow floods the world. There are no walls here — only depth._\n` +
    `_Megumi's shikigami rise without limit, the dead resummoned as if never slain._` +
    (mahoragaSummoned ? `\n\n🕛 _From the deepest shadow, the Divine General **Mahoraga** is called forth._` : '')

  return { ok: true, message, multiplier: DOMAIN_BURST_MULT, mahoragaSummoned }
}

/**
 * chimeraBurstDamage(player, enemy) -> { dmg, isCrit }
 * The opening horde's damage, through the ordinary pipeline (calcPlayerDamage
 * with the Domain multiplier, then the enemy's DEF). Kept here so both the
 * PvE plugin and pvp.js compute it identically. calcPlayerDamage returns
 * { rawDmg, isCrit } (same contract Cinder Verdict / Dance of the Rain use).
 */
export function chimeraBurstDamage(player, enemy) {
  const { rawDmg, isCrit } = calcPlayerDamage(player, null, DOMAIN_BURST_MULT)
  return { dmg: applyDefense(rawDmg, getEffectiveStat(enemy, 'def')), isCrit }
}

/**
 * rollShadowDodge(player, ctx) -> { dodged, damage, message? }
 * Shadow-travel evasion while the Garden is open. Modeled exactly on
 * rollSerpentsGrace(): called at the same incoming-hit slot, trueDamage hits
 * are exempt (guaranteed hits / %-HP effects still land). No-op unless the
 * Domain is currently active.
 */
export function rollShadowDodge(player, ctx, bsOverride = null) {
  if (!isChimeraDomainActive(player, bsOverride)) return { dodged: false, damage: ctx?.damage ?? 0 }
  if (ctx?.trueDamage) return { dodged: false, damage: ctx.damage }
  if (Math.random() >= DOMAIN_DODGE_CHANCE) return { dodged: false, damage: ctx?.damage ?? 0 }
  return {
    dodged: true,
    damage: 0,
    message: `🌑💨 *Shadow Travel* — Megumi melts into the dark; the attack finds nothing.`,
  }
}

// ── 3. Mahoraga — Wheel of adaptation ───────────────────────────────────────

/**
 * moveKeyFor(kind, id) — canonical identity of an incoming move, so "the same
 * move used 3 times" is measured exactly. kind: 'attack' | 'skill' | 'boss'
 * | 'enemy'. id: skill id / boss attack name (ignored for plain attacks).
 */
export function moveKeyFor(kind, id = '') {
  switch (kind) {
    case 'skill': return `skill:${id}`
    case 'boss':  return `boss:${id}`
    case 'enemy': return 'enemy:basic'
    case 'attack':
    default:      return 'attack'
  }
}

/**
 * recordMahoragaExposure(player, moveKey, moveLabel, bsOverride) ->
 *   { nullified, justMastered, adapting, streak, wheelSpin, message } | null
 *
 * Call on the DEFENDING side — i.e. for the Megumi player, at each incoming
 * hit, BEFORE the damage is applied — with the attacker's moveKeyFor(...).
 * Wheel logic:
 *   • already mastered  ⇒ { nullified:true }               (0 damage, forever)
 *   • same move as last ⇒ streak++                          (build toward 3)
 *   • different move     ⇒ streak resets to 1 on the new move
 *   • streak reaches 3   ⇒ master it, spin the Wheel, nullify THIS 3rd hit too
 *                          ({ justMastered:true, wheelSpin:true, nullified:true })
 * Returns null when Mahoraga isn't in play (not Megumi, no battleState).
 *
 * NOTE: mastery persists for the rest of the battle (the Wheel does not
 * un-adapt). "Until they use a different skill" is satisfied because a
 * different move deals full damage until IT too is mastered — the mastered
 * move alone stays at 0.
 */
export function recordMahoragaExposure(player, moveKey, moveLabel = 'that attack', bsOverride = null) {
  if (!hasMahoraga(player)) return null
  const bs = bsOverride ?? player?.battleState
  const st = megumiState(bs)
  if (!st) return null

  // Mahoraga must be "out" to adapt. It rides along with Megumi from the
  // opening bell (the Ten Shadows' final shikigami is always in reserve), so
  // arm it lazily the first time anything is thrown at Megumi.
  if (!st.mahoragaOut) st.mahoragaOut = true

  const wheel = st.wheel

  if (wheel.mastered[moveKey]) {
    return {
      nullified: true, justMastered: false, adapting: false,
      streak: MAHORAGA_ADAPT_HITS, wheelSpin: false,
      message: `🛞 *Mahoraga has already mastered ${moveLabel}* — it deals *0* damage.`,
    }
  }

  if (wheel.lastKey === moveKey) {
    wheel.streak += 1
  } else {
    wheel.lastKey = moveKey
    wheel.streak = 1
  }

  if (wheel.streak >= MAHORAGA_ADAPT_HITS) {
    wheel.mastered[moveKey] = true
    return {
      nullified: true, justMastered: true, adapting: false,
      streak: wheel.streak, wheelSpin: true,
      message:
        `🛞✨ *THE WHEEL SPINS!*\n` +
        `_Mahoraga adapts to ${moveLabel}. From this moment it deals *0* damage._`,
    }
  }

  const left = MAHORAGA_ADAPT_HITS - wheel.streak
  return {
    nullified: false, justMastered: false, adapting: true,
    streak: wheel.streak, wheelSpin: false,
    message: `🛞 _Mahoraga studies ${moveLabel}... (${wheel.streak}/${MAHORAGA_ADAPT_HITS} — ${left} more to master it)_`,
  }
}

// ── Unified incoming-hit resolver ───────────────────────────────────────────

/**
 * resolveMegumiIncoming(defender, opts) ->
 *   { damage, lines[], message, wheelCaption, nullified, dodged }
 *
 * ONE call that bundles everything that happens when a hit lands on a Megumi
 * player, in the correct order:
 *   1. Mahoraga's Wheel adapts (and nullifies to 0 once the move is mastered),
 *   2. otherwise the Chimera Shadow Garden's shadow-travel dodge gets its roll.
 *
 * Every combat surface — attack.js, skill.js (monsters, dungeons, bosses) and
 * pvp.js (duels) — calls exactly this, so the Wheel and the Garden behave
 * identically everywhere instead of each file re-implementing the sequence.
 * A non-Megumi defender gets `damage` back untouched and no lines, so the call
 * is safe to place unconditionally in any incoming-damage path.
 *
 * opts:
 *   damage      — incoming damage AFTER defense/mitigation
 *   trueDamage  — true for DEF-bypassing / %-HP hits (exempt from the dodge,
 *                 NOT from Mahoraga: the Wheel adapts to anything)
 *   kind, id    — move identity for the Wheel; see moveKeyFor()
 *   label       — human-readable move name for the narration
 *   bs          — battleState override (PvP passes the defender's own)
 *
 * `wheelCaption` is non-null on exactly the turn a move gets mastered — the
 * caller sends it as its OWN message with the Wheel-spin GIF, then continues
 * with the ordinary battle text.
 */
export function resolveMegumiIncoming(defender, opts = {}) {
  const {
    damage = 0, trueDamage = false,
    kind = 'attack', id = '', label = 'that attack',
    bs = null,
  } = opts

  const out = {
    damage, lines: [], message: '',
    wheelCaption: null, nullified: false, dodged: false,
  }
  if (!hasMegumi(defender)) return out

  const finish = () => { out.message = out.lines.join('\n'); return out }

  // 1. Mahoraga's Wheel.
  const mora = recordMahoragaExposure(defender, moveKeyFor(kind, id), label, bs)
  if (mora) {
    // On the mastering turn the spin text becomes the GIF's caption instead of
    // inline battle text (it is its own message); every other state narrates
    // inline.
    if (mora.wheelSpin) out.wheelCaption = mora.message
    else if (mora.message) out.lines.push(mora.message)

    if (mora.nullified) {
      out.nullified = true
      out.damage = 0
      out.lines.push(`🛡️ *0* damage — Mahoraga has adapted to ${label}.`)
      return finish()
    }
  }

  // 2. Chimera Shadow Garden — shadow-travel evasion.
  const dodge = rollShadowDodge(defender, { damage: out.damage, trueDamage }, bs)
  if (dodge.dodged) {
    out.dodged = true
    out.damage = 0
    if (dodge.message) out.lines.push(dodge.message)
  } else {
    out.damage = dodge.damage
  }
  return finish()
}

// ── Asset senders (separate messages, so media never blocks the turn text) ──

/** The Domain Expansion splash — shown whenever Megumi opens CSG, anywhere. */
export function sendDomainImage(ctx, caption = '', recipient = ctx.from) {
  return sendImageTo(ctx, DOMAIN_IMAGE, caption, recipient).catch(() => {})
}

/**
 * The Wheel-spin animation. Sent as its OWN message (GIF→MP4 playback via
 * sendGifTo, "like Tyla's") the moment Mahoraga masters a move — the generic
 * battle text is sent separately by the caller right after this.
 */
export function sendWheelSpin(ctx, caption = '🛞 *Mahoraga\'s Wheel spins...*', recipient = ctx.from) {
  return sendGifTo(ctx, WHEEL_GIF, caption, recipient).catch(() => {})
}

export function sendMegumiImage(ctx, caption = '', recipient = ctx.from) {
  return sendImageTo(ctx, MEGUMI_IMAGE, caption, recipient).catch(() => {})
}

export function sendMahoragaImage(ctx, caption = '', recipient = ctx.from) {
  return sendImageTo(ctx, MAHORAGA_IMAGE, caption, recipient).catch(() => {})
}
