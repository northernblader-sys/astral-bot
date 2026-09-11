/**
 * effects.js — shared status-effect engine.
 *
 * Target-agnostic: every function takes a plain entity object (player or
 * monster) and reads/mutates its `activeEffects` array. Nothing here assumes
 * a combat loop exists — the engine is intentionally decoupled.
 *
 * activeEffects entry shape:
 * {
 *   type:      string,        // one of the 10 effect types below
 *   remaining: number,        // ticks/turns remaining
 *   value:     number,        // magnitude (heal amount, dmg/tick, shield pool, stat delta)
 *   meta:      object | null, // effect-specific extra data
 *   sourceId:  string | null, // itemId or skillId that applied it
 * }
 *
 * Effect types:
 *   heal       — instant; no activeEffects entry
 *   regen      — sustained heal per tick
 *   burn       — damage over time (fire / physical)
 *   poison     — damage over time (distinct from burn for cleanse/resist)
 *   freeze     — hard CC; entity cannot act while active
 *   stun       — hard CC; single-turn skip
 *   shield     — damage-absorption pool; drained by absorbDamage()
 *   weaken     — stat debuff; read via getEffectiveStat(), never mutates entity.stats
 *   strengthen — stat buff; inverse of weaken, read via getEffectiveStat()
 *   blind      — accuracy CC; combat loop checks hasEffect(entity, 'blind')
 *                and applies 70% hit-chance penalty. No per-tick mutation.
 *   tear       — percentage-of-maxHp damage over time (Season 1, Urahara's
 *                Tear/Reshape — spec §13.2). Deliberately NOT the same type
 *                as 'poison': it is percentage-based (value is a 0-1 fraction
 *                of maxHp, not a flat amount) and is exempt from cure's
 *                default NEGATIVE_TYPES strip list below, so ordinary
 *                cleanse/cure effects do not accidentally remove it — only
 *                an explicit { type: 'cure', targets: ['tear'] } (e.g.
 *                Severing Elixir) can. This activeEffects entry is the
 *                normal-duration PvE form only; the PvP "permanent until
 *                cured" form is a *separate* mechanism
 *                (player.permanentSever, see lib/character-abilities.js)
 *                because pvp.js's pvpConclude() wipes activeEffects on both
 *                players at the end of every duel — a permanent debuff has
 *                to live outside that array to survive a duel ending.
 *
 * Effect types added for the Skill Pack v2 mythic/legendary set (see
 * data/skills.json "source": "skill_pack" entries and
 * reflect-wiring-patch.md for the one piece NOT yet wired into combat):
 *   reflect            — counter stance; NOT yet hooked into the enemy-hp
 *                         mutation sites in attack.js/pvp.js. See patch file.
 *   ignore_armor       — flat defense-mitigation bypass, instant or duration
 *   pierce             — proportional defense-mitigation bypass
 *   aoe_splash         — instant flag, secondary-target splash damage
 *   haste              — turn-order buff; no scheduler exists yet to act on
 *                         it (combat here is strict alternation), stored for
 *                         forward compatibility only
 *   execute_multiplier — instant flag, bonus damage below an hp% threshold
 *   dispel_buffs       — instant, strips strengthen/shield/haste from target
 *   cleanse_debuffs    — instant, alias of cure({ targets: 'all' })
 *   knockback          — narration-only no-op (no positional combat state
 *                         exists in this engine)
 *   self_damage        — instant recoil damage to the caster, bypasses shield
 *   shred_res          — resistance/defense-over-time debuff, distinct from
 *                         weaken so it isn't accidentally cleansed by it
 *   stun_chance        — probabilistic stun; rolls percent at apply time
 *
 * NOTE on health_potion effect shape { type: 'heal', stat: 'hp', amount: 50 }:
 *   Handled correctly by applyEffect(). No item schema change needed.
 *
 * NOTE on strengthen (battle_cry):
 *   The skill runner computes Math.round(player.stats[stat] * multiplier) and
 *   passes it as `value` to addStatusEffect — this file stores and reads the
 *   pre-computed flat delta. Does not stack: a second application refreshes
 *   duration and replaces value if the new value is larger; otherwise ignored.
 */

// The End event weaken magnitude. end-event.js is a pure leaf (zero imports),
// so effects.js → end-event.js stays acyclic and effects.js remains importable
// everywhere it is today.
import { END_WEAKEN_PCT } from './end-event.js'

// ── Helpers ────────────────────────────────────────────────────────────────

const MAX_STAT = { hp: 'maxHp', mp: 'maxMp' }

function clampToMax(entity, stat, value) {
  const maxKey = MAX_STAT[stat]
  const max    = maxKey ? (entity[maxKey] ?? value) : Infinity
  return Math.min(value, max)
}

function floorAtZero(value) {
  return Math.max(0, value)
}

// ── Instant effects ────────────────────────────────────────────────────────

const INSTANT_HANDLERS = {
  /**
   * heal — instant stat restore.
   * effectDef: { type: 'heal', stat: 'hp'|'mp', amount: number }
   */
  heal(entity, effectDef) {
    const { stat } = effectDef
    if (stat === 'stamina') {
      entity.stamina = entity.stamina ?? { current: 0, max: 30 }
      const before = entity.stamina.current
      const amount = effectDef.percent
        ? Math.max(1, Math.floor(entity.stamina.max * (effectDef.percent / 100)))
        : effectDef.amount
      entity.stamina.current = Math.min(before + amount, entity.stamina.max)
      return `⚡ Stamina: ${before} → ${entity.stamina.current} / ${entity.stamina.max}`
    }
    const maxKey = MAX_STAT[stat]
    const before = entity[stat] ?? 0
    const max    = entity[maxKey] ?? before
    // percent heals scale with the pool instead of a flat number, so they stay
    // meaningful at high level where a fixed +400 is a rounding error.
    const amount = effectDef.percent
      ? Math.max(1, Math.floor(max * (effectDef.percent / 100)))
      : effectDef.amount

    const after  = Math.max(before, Math.min(before + amount, max))
    entity[stat] = after
    const emoji  = stat === 'hp' ? '❤️' : '💙'
    return `${emoji} ${stat.toUpperCase()}: ${before} → ${after} / ${max}`
  },

  /**
   * cure — removes negative status effects.
   * effectDef: { type: 'cure', targets: string[] | 'all' }
   *   targets: array of effect types to strip (e.g. ['poison']), or the
   *   string 'all' to strip every negative (non-buff) effect at once.
   */
  cure(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    // 'tear' intentionally excluded from the default NEGATIVE_TYPES strip
    // list — see the 'tear' entry in the file-level doc comment above. A
    // cure item must explicitly name targets: ['tear'] (or list it inside
    // an explicit array) to remove it; targets: 'all' will NOT touch it.
    const NEGATIVE_TYPES = ['burn', 'poison', 'freeze', 'stun', 'blind', 'weaken', 'frostlock']
    const targets = effectDef.targets === 'all' ? NEGATIVE_TYPES : (effectDef.targets ?? [])

    const before = entity.activeEffects.length
    entity.activeEffects = entity.activeEffects.filter((e) => !targets.includes(e.type))
    const removed = before - entity.activeEffects.length

    if (removed === 0) return `✨ No matching ailments to cure.`
    return `✨ Cured *${removed}* negative effect${removed !== 1 ? 's' : ''}!`
  },

  /**
   * dispel_buffs — strips all `strengthen`/`shield`/`haste` entries from the
   * target (buff-only, mirror image of `cure`'s debuff-only default list).
   * effectDef: { type: 'dispel_buffs', target: 'self'|'enemy' }
   *   `target` is informational only — this handler always mutates whatever
   *   entity object it's called on; the skill runner is responsible for
   *   passing the correct entity (player vs enemy) based on `target`.
   */
  dispel_buffs(entity, _effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    const BUFF_TYPES = ['strengthen', 'shield', 'haste']
    const before = entity.activeEffects.length
    entity.activeEffects = entity.activeEffects.filter((e) => !BUFF_TYPES.includes(e.type))
    const removed = before - entity.activeEffects.length
    if (removed === 0) return `✨ No buffs to dispel.`
    return `💥 Dispelled *${removed}* buff${removed !== 1 ? 's' : ''}!`
  },

  /**
   * cleanse_debuffs — alias of `cure` with targets: 'all', kept as a
   * separate named instant so skill effects arrays can say what they mean
   * (self-cleanse) without reusing the item-oriented `cure` semantics.
   * effectDef: { type: 'cleanse_debuffs', target: 'self'|'enemy' }
   */
  cleanse_debuffs(entity, effectDef) {
    return INSTANT_HANDLERS.cure(entity, { targets: 'all', sourceId: effectDef.sourceId })
  },

  /**
   * knockback — no HP/stat effect in this text-combat engine (no positional
   * state exists). Stored as a no-op instant that returns a narration line
   * only, so the effect can't silently throw if a skill lists it, but also
   * doesn't fabricate mechanical behavior this codebase has no concept of.
   * effectDef: { type: 'knockback', distance: number }
   */
  knockback(_entity, effectDef) {
    return `💨 Knocked back ${effectDef.distance ?? 1} paces!`
  },

  /**
   * self_damage — instant recoil damage to the caster. Bypasses shield
   * absorption deliberately (recoil is a cost of casting, not an incoming
   * attack) — call directly against entity.hp, not absorbDamage().
   * effectDef: { type: 'self_damage', amount: number }
   */
  self_damage(entity, effectDef) {
    const before = entity.hp ?? 0
    const after  = floorAtZero(before - (effectDef.amount ?? 0))
    entity.hp    = after
    return `💢 Recoil: ${effectDef.amount ?? 0} damage to self (HP: ${before} → ${after})`
  },
}

// ── Duration-based effect initializers ────────────────────────────────────

const DURATION_INITIALIZERS = {
  /**
   * warcry — outgoing damage boost that burns down per HIT LANDED, not per turn.
   * Folded in by calcPlayerDamage (the single outgoing-damage funnel), so it
   * works in PvE, dungeons, bosses, normal PvP and wager duels alike.
   * Wager duels have no turn structure at all, which is exactly why these two
   * buffs count hits: a turn-duration buff would never expire there.
   * effectDef: { type: 'warcry', percent: number, hits: number }
   */
  warcry(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'warcry',
      remaining: effectDef.hits ?? effectDef.duration ?? 3,
      value:     effectDef.percent ?? 20,
      meta:      { hitCounted: true },
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * ironskin — incoming damage reduction that burns down per HIT TAKEN.
   * Applied inside absorbDamage (the single pre-hp funnel every struck hit
   * passes through) so no call site needs to know about it.
   * effectDef: { type: 'ironskin', percent: number, hits: number }
   */
  ironskin(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'ironskin',
      remaining: effectDef.hits ?? effectDef.duration ?? 3,
      value:     effectDef.percent ?? 30,
      meta:      { hitCounted: true },
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * regen — sustained heal per tick.
   * effectDef: { type: 'regen', stat: 'hp'|'mp', amount: number, duration: number }
   */
  regen(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'regen',
      remaining: effectDef.duration,
      value:     effectDef.amount,
      meta:      { stat: effectDef.stat },
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * burn — damage over time (fire/physical).
   * effectDef: { type: 'burn', amount: number, duration: number }
   */
  burn(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'burn',
      remaining: effectDef.duration,
      value:     effectDef.amount,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * poison — damage over time (tracked separately from burn).
   * effectDef: { type: 'poison', amount: number, duration: number }
   */
  poison(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'poison',
      remaining: effectDef.duration,
      value:     effectDef.amount,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * freeze — hard CC; entity cannot act.
   * effectDef: { type: 'freeze', duration: number }
   */
  freeze(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'freeze',
      remaining: effectDef.duration,
      value:     0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * stun — hard CC; conventionally duration: 1.
   * effectDef: { type: 'stun', duration: number }
   */
  stun(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'stun',
      remaining: effectDef.duration,
      value:     0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * frostlock — soft CC (Miyashi's Frostbind). Unlike freeze/stun, the
   * entity does NOT skip its turn — it can still act, but attack.js/pvp.js
   * must force that action down to a basic attack (no skills, no items, no
   * character/named abilities) for as long as this is active. See
   * hasEffect(entity, 'frostlock') at the action-resolution call site.
   * effectDef: { type: 'frostlock', duration: number }
   */
  frostlock(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'frostlock',
      remaining: effectDef.duration,
      value:     0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * shield — damage-absorption pool.
   * effectDef: { type: 'shield', amount: number, duration: number }
   */
  shield(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'shield',
      remaining: effectDef.duration,
      value:     effectDef.amount,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * weaken — stat debuff. Read lazily via getEffectiveStat().
   * effectDef: { type: 'weaken', stat: string, value: number, duration: number }
   */
  weaken(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'weaken',
      remaining: effectDef.duration,
      value:     effectDef.value,
      meta:      { stat: effectDef.stat },
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * strengthen — stat buff; inverse of weaken. Read lazily via getEffectiveStat().
   * Does NOT mutate entity.stats — value is added lazily on read.
   * Does NOT stack: a second application on the same stat replaces the entry
   * if the new value is larger, otherwise refreshes duration only.
   *
   * The skill runner pre-computes the flat delta:
   *   value = Math.round(entity.stats[stat] * multiplier)
   * and passes it here as effectDef.value.
   *
   * effectDef: { type: 'strengthen', stat: string, value: number, duration: number }
   */
  strengthen(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []

    // Find existing strengthen on the same stat
    const existing = entity.activeEffects.find(
      (e) => e.type === 'strengthen' && e.meta?.stat === effectDef.stat,
    )

    if (existing) {
      // Refresh duration; replace value only if the new buff is stronger
      existing.remaining = Math.max(existing.remaining, effectDef.duration)
      if (effectDef.value > existing.value) existing.value = effectDef.value
    } else {
      entity.activeEffects.push({
        type:      'strengthen',
        remaining: effectDef.duration,
        value:     effectDef.value,
        meta:      { stat: effectDef.stat },
        sourceId:  effectDef.sourceId ?? null,
      })
    }
  },

  /**
   * blind — accuracy CC.
   * While active, hasEffect(entity, 'blind') returns true and the combat
   * loop applies a 70% hit-chance penalty. No per-tick stat mutation.
   * effectDef: { type: 'blind', duration: number }
   */
  blind(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'blind',
      remaining: effectDef.duration,
      value:     0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * tear — percentage-of-maxHp damage over time (Season 1, Urahara).
   * effectDef: { type: 'tear', pctPerTick: number, duration: number }
   *   pctPerTick is a 0-1 fraction of maxHp (e.g. 0.20 for the in-battle
   *   20%/tick rate from spec §13.2). Stored as `value` for TICK_PROCESSORS
   *   to read directly against entity.maxHp each tick, rather than
   *   pre-computing a flat amount at apply time — keeps the tick accurate
   *   even if maxHp changes mid-duration (e.g. a buff/debuff lands between
   *   ticks).
   */
  tear(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'tear',
      remaining: effectDef.duration,
      value:     effectDef.pctPerTick,
      meta:      null,
      sourceId:  effectDef.sourceId ?? 'tear_reshape',
    })
  },

  /**
   * reflect — single/multi-turn counter stance. While active, the shared
   * combat damage-application path (attack.js enemy-hp mutation sites,
   * pvp.js pre-resolveActiveAbility() check) should redirect `percent`% of
   * the next incoming hit back onto the attacker instead of applying it to
   * this entity, then consume (decrement remaining by design of a single
   * hit, not a full turn) the effect. NOT YET WIRED into attack.js/pvp.js —
   * see reflect-wiring-patch.md. Distinct from the hardcoded Meliodas "Full
   * Counter" boss special in lib/boss-engine.js (case 'meliodas'), which is
   * a separate, non-activeEffects mechanism.
   * effectDef: { type: 'reflect', percent: number, duration: number }
   */
  reflect(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'reflect',
      remaining: effectDef.duration ?? 1,
      value:     effectDef.percent ?? 100,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * ignore_armor — instant-application flag consumed at attack-resolution
   * time (skill runner reads it off the skill's effects array directly, not
   * via activeEffects — armor mitigation happens once, at the moment the
   * hit lands). Included here as a duration-style entry only for skills
   * that grant a temporary "next N hits ignore armor" window; instant,
   * single-hit ignore_armor never needs an activeEffects entry at all — the
   * attack-resolution code should check the skill's own effects array
   * before applying defense mitigation.
   * effectDef: { type: 'ignore_armor', percent: number, duration?: number }
   */
  ignore_armor(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'ignore_armor',
      remaining: effectDef.duration ?? 1,
      value:     effectDef.percent ?? 100,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * pierce — like ignore_armor but stacks multiplicatively with existing
   * defense math rather than zeroing it outright (percent of defense
   * bypassed, not percent of damage ignored post-defense).
   * effectDef: { type: 'pierce', percent: number, duration?: number }
   */
  pierce(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'pierce',
      remaining: effectDef.duration ?? 1,
      value:     effectDef.percent ?? 0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * aoe_splash — instant-application flag read by the attack-resolution
   * code at hit time to also apply `percent`% of the hit's damage to any
   * secondary targets (group fights). No per-tick behavior; stored with
   * duration 1 so hasEffect() checks work the same way as other flags.
   * effectDef: { type: 'aoe_splash', percent: number }
   */
  aoe_splash(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'aoe_splash',
      remaining: 1,
      value:     effectDef.percent ?? 0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * haste — speed/turn-order buff. Read lazily via getEffectiveStat-style
   * access at turn-order resolution (not wired into any existing turn
   * scheduler in this codebase yet — combat here is strict player/enemy
   * alternation, so haste currently has no scheduler to hook; stored for
   * forward compatibility and so hasEffect(entity,'haste') can gate a
   * flavor line / minor bonus in the meantime).
   * effectDef: { type: 'haste', percent: number, duration: number }
   */
  haste(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'haste',
      remaining: effectDef.duration,
      value:     effectDef.percent ?? 0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * execute_multiplier — instant-application flag read at attack-resolution
   * time: if the target's hp (after this hit's base damage) is below
   * `thresholdPercent`% of maxHp, multiply total damage by `bonus`.
   * effectDef: { type: 'execute_multiplier', thresholdPercent: number, bonus: number }
   */
  execute_multiplier(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'execute_multiplier',
      remaining: 1,
      value:     effectDef.bonus ?? 1,
      meta:      { thresholdPercent: effectDef.thresholdPercent ?? 0 },
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * shred_res — resistance/defense-over-time debuff, distinct from `weaken`
   * so it can't be cleansed by a plain `cure` call targeting 'weaken' and so
   * UI can label it separately ("resistance shredded" vs "weakened").
   * effectDef: { type: 'shred_res', percent: number, duration: number }
   */
  shred_res(entity, effectDef) {
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'shred_res',
      remaining: effectDef.duration,
      value:     effectDef.percent ?? 0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },

  /**
   * stun_chance — like `stun` but probabilistic; the skill runner (not this
   * initializer) should roll `percent` before calling addStatusEffect with
   * a plain `stun` entry. This initializer exists so effects arrays can
   * name `stun_chance` directly and have the roll happen at apply time
   * inside this function rather than requiring every call site to
   * special-case it.
   * effectDef: { type: 'stun_chance', percent: number, duration: number }
   */
  stun_chance(entity, effectDef) {
    if (Math.random() * 100 >= (effectDef.percent ?? 0)) return
    entity.activeEffects = entity.activeEffects ?? []
    entity.activeEffects.push({
      type:      'stun',
      remaining: effectDef.duration ?? 1,
      value:     0,
      meta:      null,
      sourceId:  effectDef.sourceId ?? null,
    })
  },
}

// ── Tick processors ────────────────────────────────────────────────────────

const TICK_PROCESSORS = {
  regen(entity, entry) {
    const stat   = entry.meta?.stat ?? 'hp'
    const before = entity[stat] ?? 0
    const after  = clampToMax(entity, stat, before + entry.value)
    entity[stat] = after
    const emoji  = stat === 'hp' ? '💚' : '💙'
    return `${emoji} Regen: ${stat.toUpperCase()} ${before} → ${after}`
  },

  burn(entity, entry) {
    const before = entity.hp ?? 0
    const after  = floorAtZero(before - entry.value)
    entity.hp    = after
    return `🔥 Burn: ${entry.value} damage (HP: ${before} → ${after})`
  },

  poison(entity, entry) {
    const before = entity.hp ?? 0
    const after  = floorAtZero(before - entry.value)
    entity.hp    = after
    return `🟢 Poison: ${entry.value} damage (HP: ${before} → ${after})`
  },

  tear(entity, entry) {
    const before = entity.hp ?? 0
    const maxHp  = entity.maxHp ?? before
    const dmg    = Math.max(1, Math.round(maxHp * (entry.value ?? 0)))
    const after  = floorAtZero(before - dmg)
    entity.hp    = after
    return `🩸 Tear: ${dmg} damage (${Math.round((entry.value ?? 0) * 100)}% of max HP) (HP: ${before} → ${after})`
  },

  freeze(_entity, _entry) {
    return `❄️ Frozen: cannot act.`
  },

  stun(_entity, _entry) {
    return `💫 Stunned: cannot act.`
  },

  // Shield: duration ticks down but value only drains via absorbDamage()
  shield(_entity, _entry) {
    return null
  },

  // Weaken: duration ticks down; stat penalty read lazily, no mutation
  weaken(_entity, entry) {
    const stat = entry.meta?.stat ?? '?'
    return `⬇️ Weaken (${stat}): −${entry.value} for ${entry.remaining - 1} more turn(s).`
  },

  // Strengthen: duration ticks down; stat bonus read lazily, no mutation
  strengthen(_entity, entry) {
    const stat = entry.meta?.stat ?? '?'
    return `⬆️ Strengthen (${stat}): +${entry.value} for ${entry.remaining - 1} more turn(s).`
  },

  // Blind: no per-tick mutation, just report presence
  blind(_entity, _entry) {
    return `🌑 Blinded: hit chance severely reduced.`
  },

  // Reflect: no per-tick mutation — consumed by the damage-application
  // path on the next hit received, not by tickEffects. Duration ticking
  // down here just handles the "stance expires unused" case.
  reflect(_entity, entry) {
    return `🔁 Counter stance active: ${entry.value}% reflect (${entry.remaining - 1} turn(s) left).`
  },

  // ignore_armor / pierce: no per-tick mutation, read at attack-resolution
  // time by whatever computes defense mitigation for the next hit.
  ignore_armor(_entity, entry) {
    return `🗡️ Armor ignore active: ${entry.value}% (${entry.remaining - 1} turn(s) left).`
  },

  pierce(_entity, entry) {
    return `🗡️ Piercing active: ${entry.value}% defense bypass (${entry.remaining - 1} turn(s) left).`
  },

  // Haste: no per-tick mutation — no turn-order scheduler exists yet in
  // this codebase to actually act on it (see DURATION_INITIALIZERS.haste
  // doc comment). Ticking/expiry still tracked so hasEffect() is accurate.
  haste(_entity, entry) {
    return `⚡ Hasted: +${entry.value}% for ${entry.remaining - 1} more turn(s).`
  },

  // shred_res: duration ticks down; resistance penalty read lazily by
  // whatever computes defense/resist mitigation, no direct mutation here.
  shred_res(_entity, entry) {
    return `⬇️ Resistance shredded: −${entry.value}% for ${entry.remaining - 1} more turn(s).`
  },

  // aoe_splash / execute_multiplier: single-hit instant flags (remaining
  // seeded at 1 by their initializers) — consumed at the moment the next
  // hit resolves, not per-tick. No narration needed here since the
  // attack-resolution code produces its own line when it actually applies.
  aoe_splash(_entity, _entry) {
    return null
  },

  execute_multiplier(_entity, _entry) {
    return null
  },
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * applyEffect(entity, effectDef) → string
 *
 * Handles instant effects (currently: heal).
 * Mutates entity in place, returns a human-readable result line.
 * Throws for unknown or non-instant effect types.
 */
export function applyEffect(entity, effectDef) {
  const handler = INSTANT_HANDLERS[effectDef.type]
  if (!handler) {
    throw new Error(
      `applyEffect: "${effectDef.type}" is not an instant effect. ` +
      `Use addStatusEffect() for duration-based effects.`,
    )
  }
  return handler(entity, effectDef)
}

/**
 * NEGATIVE_EFFECT_TYPES — the hostile statuses (debuffs / DoTs / locks /
 * shred), as opposed to the buff types (strengthen, shield, haste, regen).
 * This is the superset of `cure`'s NEGATIVE_TYPES list plus 'tear' and the
 * shred/lock types: `cure` deliberately excludes 'tear' from its default
 * strip, but for "is this a hostile effect?" — which is what status immunity
 * turns on — tear absolutely counts.
 */
export const NEGATIVE_EFFECT_TYPES = new Set([
  'burn', 'poison', 'freeze', 'stun', 'stun_chance',
  'blind', 'weaken', 'frostlock', 'tear', 'shred_res',
])

/** True when `type` is a hostile (debuff/DoT/lock/shred) effect, not a buff. */
export function isNegativeEffect(type) {
  return NEGATIVE_EFFECT_TYPES.has(type)
}

/**
 * addStatusEffect(entity, effectDef) → void | { immune: true }
 *
 * Pushes a duration-based effect entry onto entity.activeEffects.
 * Throws for unknown effect types or instant-only types (e.g. heal).
 *
 * Status immunity: an entity flagged `statusImmune` (Shunya — The Empty
 * Vessel) cannot receive any NEGATIVE effect. It is refused here, at the one
 * funnel every duration debuff passes through, so immunity holds in PvE, PvP
 * and boss fights alike without each call site knowing about it — the same
 * way getEffectiveStat() honours the plain `endWeakened` flag. Buffs
 * (strengthen/shield/haste/regen) still apply normally; only hostile effects
 * are swallowed. Returns { immune: true } so a caller that wants to react
 * (e.g. the PvP rebound) can tell it was refused; existing callers ignore the
 * return value exactly as before.
 */
export function addStatusEffect(entity, effectDef) {
  if (entity?.statusImmune && isNegativeEffect(effectDef?.type)) {
    return { immune: true, type: effectDef.type }
  }
  const initializer = DURATION_INITIALIZERS[effectDef.type]
  if (!initializer) {
    throw new Error(
      `addStatusEffect: unknown or non-duration effect type "${effectDef.type}".`,
    )
  }
  initializer(entity, effectDef)
}

/**
 * resolveVoidRebound(target, caster, amount, label) → { rebounded, damage, message }
 *
 * The other half of `statusImmune` (Shunya — The Empty Vessel).
 * addStatusEffect() above covers every DURATION debuff, but a handful of
 * character abilities move HP directly and never pass through it: Miyashi's
 * Frostbind drain, Nisha's Absolute One siphon and Megumi's Thousand Shadows
 * swarm each mutate `target.hp` themselves, on purpose (ambient auras, not
 * mitigated "hits"). Against a void those drains have nothing to open — so they
 * open in the caster instead.
 *
 * Character-agnostic exactly like addStatusEffect: this file knows only the
 * `statusImmune` flag, and lib/character-abilities.js owns the
 * shunya ⇒ statusImmune mapping.
 *
 * Mutates NOTHING, deliberately. In a duel the caster and the target live in
 * two different updatePlayer() calls (plugins/pvp.js never nests them), so the
 * caller has to carry the returned amount across and apply it on the far side.
 *
 * The void does not feed on what it refuses: a rebounded drain restores nothing
 * to the target and nothing to the caster. Zero in both directions — that is
 * the whole character, and it's also what stops her having infinite sustain.
 */
export function resolveVoidRebound(target, caster, amount, label = 'the drain') {
  if (!target?.statusImmune) return { rebounded: false, damage: 0, message: '' }
  const back = Math.max(0, Math.floor(amount ?? 0))
  if (back <= 0) return { rebounded: false, damage: 0, message: '' }
  return {
    rebounded: true,
    damage: back,
    message:
      `⭕ *${target.name ?? 'The Empty Vessel'}* is zero — ${label} closes on nothing ` +
      `and opens in *${caster?.name ?? 'the caster'}* instead.`,
  }
}

/**
 * applyReboundEffect(entity, effectDef) → void | { immune: true }
 *
 * Applies a debuff that rebounded off a void onto the entity that cast it.
 * Same "replace, don't stack" rule the cumulative debuffs use (a second
 * rebound from the same sourceId supersedes the first rather than piling up),
 * then straight through addStatusEffect — so if the caster is somehow ALSO a
 * void, the central gate above voids it a second time and nobody carries it.
 */
export function applyReboundEffect(entity, effectDef) {
  if (!entity || !effectDef?.type) return
  if (effectDef.sourceId) {
    entity.activeEffects = (entity.activeEffects ?? []).filter(e => e.sourceId !== effectDef.sourceId)
  }
  return addStatusEffect(entity, effectDef)
}

/**
 * tickEffects(entity) → string[]
 *
 * Call once per turn/tick. Processes all active effects:
 *  - Applies per-tick mutations (regen heal, burn/poison damage, etc.)
 *  - Decrements `remaining` on each entry
 *  - Removes entries whose `remaining` reaches 0
 * Returns an array of human-readable result lines.
 */
export function tickEffects(entity) {
  entity.activeEffects = entity.activeEffects ?? []
  const lines = []

  for (const entry of entity.activeEffects) {
    const processor = TICK_PROCESSORS[entry.type]
    if (processor) {
      const line = processor(entity, entry)
      if (line) lines.push(line)
    }
    // Hit-counted buffs (warcry, ironskin) are spent by landing/taking hits,
    // never by the clock. Wager duels have no turns at all, so decrementing
    // them here would either expire them instantly or never.
    if (entry.meta?.hitCounted) continue
    entry.remaining -= 1
  }

  // Remove expired effects
  entity.activeEffects = entity.activeEffects.filter((e) => e.remaining > 0)

  return lines
}

/**
 * hasEffect(entity, type) → boolean
 *
 * Returns true if the entity currently has at least one active effect of the
 * given type. Used by the combat loop to check CC states.
 */
export function hasEffect(entity, type) {
  return (entity.activeEffects ?? []).some((e) => e.type === type && e.remaining > 0)
}

/**
 * absorbDamage(entity, incomingDamage) → number
 *
 * Drains active shield pool(s) before damage reaches hp.
 * Returns remaining damage after all shields are exhausted.
 */
export function absorbDamage(entity, incomingDamage) {
  entity.activeEffects = entity.activeEffects ?? []
  let remaining = incomingDamage

  // Ironskin first: flat percentage cut off the top, one charge per hit taken.
  // Sits here because absorbDamage is the one call every struck hit in the
  // game routes through on its way to hp.
  const ironskin = entity.activeEffects.find(e => e.type === 'ironskin' && e.remaining > 0)
  if (ironskin && remaining > 0) {
    const pct = Math.max(0, Math.min(90, ironskin.value ?? 30))
    remaining = Math.max(1, Math.floor(remaining * (1 - pct / 100)))
    ironskin.remaining -= 1
  }

  for (const entry of entity.activeEffects) {
    if (entry.type !== 'shield' || remaining <= 0) continue
    const absorbed = Math.min(entry.value, remaining)
    entry.value   -= absorbed
    remaining     -= absorbed
  }

  // Remove fully-depleted shields and spent ironskin charges
  entity.activeEffects = entity.activeEffects.filter(
    (e) => (e.type !== 'shield' || e.value > 0) && (e.type !== 'ironskin' || e.remaining > 0),
  )

  return remaining
}

/**
 * consumeWarcry(entity) → number
 *
 * Returns the outgoing damage multiplier from an active Warcry buff and burns
 * one charge. Called from calcPlayerDamage only, so every outgoing hit in the
 * game (basic, skill, ability, boss, PvP, wager) spends exactly one charge per
 * hit that actually lands. Returns 1 when no buff is up.
 */
export function consumeWarcry(entity) {
  const list = entity?.activeEffects
  if (!Array.isArray(list)) return 1
  const buff = list.find(e => e.type === 'warcry' && e.remaining > 0)
  if (!buff) return 1
  buff.remaining -= 1
  const mult = 1 + Math.max(0, Math.min(200, buff.value ?? 20)) / 100
  if (buff.remaining <= 0) {
    entity.activeEffects = list.filter(e => e !== buff)
  }
  return mult
}

/**
 * getEffectiveStat(entity, statKey) → number
 *
 * Returns the entity's base stat after applying all active weaken and
 * strengthen effects targeting that stat.
 * Does NOT mutate entity.stats — both modifiers are lazy read-time only.
 */
export function getEffectiveStat(entity, statKey) {
  const base = entity.stats?.[statKey] ?? entity[statKey] ?? 0

  const effects = entity.activeEffects ?? []

  const penalty = effects
    .filter((e) => e.type === 'weaken' && e.meta?.stat === statKey && e.remaining > 0)
    .reduce((sum, e) => sum + e.value, 0)

  const bonus = effects
    .filter((e) => e.type === 'strengthen' && e.meta?.stat === statKey && e.remaining > 0)
    .reduce((sum, e) => sum + e.value, 0)

  const effective = Math.max(0, base + bonus - penalty)

  // The End's aura: unbanded players carry player.endWeakened (a cached boolean
  // kept fresh by applyEndEventTick), which cuts every stat multiplicatively.
  // Monsters never carry the flag, so this is a no-op for them.
  if (entity.endWeakened) return Math.floor(effective * (1 - END_WEAKEN_PCT))

  return effective
}

/**
 * processStatusTurn(entity) → { stunned: boolean, frozen: boolean, msg: string|null }
 *
 * Convenience wrapper used at the start of a player's turn (before they act):
 *  - Runs tickEffects() (DoT damage, regen, duration countdown, expiry)
 *  - Reports whether the entity is still stunned/frozen *after* the tick,
 *    i.e. whether they're locked out of acting this turn
 *  - `msg` is a single human-readable line summarizing the tick, suitable
 *    for `reply()`-ing directly when stunned/frozen — or null if nothing
 *    happened and the entity is free to act.
 *
 * Does not replace tickEffects() for contexts that need every individual
 * log line (e.g. end-of-turn enemy summaries) — call tickEffects() directly
 * there instead.
 */
export function processStatusTurn(entity) {
  const lines   = tickEffects(entity)
  const stunned = hasEffect(entity, 'stun')
  const frozen  = hasEffect(entity, 'freeze')

  let msg = null
  if (lines.length) msg = lines.join('\n')
  if (stunned && !msg) msg = `💫 Stunned — cannot act this turn.`
  if (frozen  && !msg) msg = `❄️ Frozen — cannot act this turn.`

  return { stunned, frozen, msg }
}
