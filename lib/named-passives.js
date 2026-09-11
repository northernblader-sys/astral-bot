/**
 * lib/named-passives.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Wires the named-weapon/item passives in data/named-weapon-passives.json
 * into real combat: the eighteen anime named weapons/armors, plus the ten
 * empire heirlooms in data/empire-heirlooms.json that townsfolk hand over
 * (see the EMPIRE HEIRLOOMS block in the handler table). Structurally mirrors
 * lib/boss-engine.js's applyBossSpecial(): one lookup table
 * (passiveId -> handler), a single dispatch function, event constants, and a
 * plain result object ({ modified, lines, ...overrides }) the caller folds
 * into the turn.
 *
 * IMPORTANT — this file only reads data/named-weapon-passives.json's specs
 * (via comments/behavior); it never modifies either data file.
 *
 * STRUCTURAL NOTE: despite the file name, data/named-weapons.json is NOT
 * weapon-only — several entries (One For All Gauntlets, Divine Protection
 * Aegis, Six Eyes Blindfold, Baryon Mode Headband, Dragon Sin Cuirass,
 * Ultra Ego Plate, Shunpo Greaves, Gate of Babylon Core) have
 * slot: "offhand" / "helmet" / "chestplate" / "boots" / "relic". Because
 * each of those is a *different* equip slot from "weapon", a player CAN
 * have several named passives active at once (one per slot they've
 * equipped a named item into) — the "only one named passive active at a
 * time" assumption in the task brief does not hold. getEquippedNamedItems()
 * below scans every equipped slot, not just `weapon`, and dispatch folds
 * across all of them.
 *
 * STRUCTURAL GAPS (flagged per task instructions, not fixed here):
 *  - flame_element_bonus's "fire-immune enemies resist" clause can't be
 *    honored — monsters (data/monsters.json) carry no element/resist
 *    field. The flat +20% bonus fire damage is applied unconditionally.
 *  - attack.js has no concept of "first hit vs. subsequent hits in the same
 *    turn" for multi-hit patterns (skills, boss guaranteedHits/doubleStrike).
 *    bankai_power_surge's "first hit each turn" is implemented as "the
 *    single basic-attack hit this turn" since that's the only hit that
 *    exists structurally; it will not distinguish further hits if/when
 *    multi-hit skills are added.
 *  - flash_step_dodge / divine_protection_block / ultra_ego_resolve /
 *    full_counter_armor are only wired into the *single-hit* enemy-attack
 *    path (regular monsters, and the boss branch's non-guaranteedHits /
 *    non-doubleStrike primary hit). Boss `guaranteedHits` arrays (Jotaro
 *    time-stop, etc.) and Deku's doubleStrike are intentionally left
 *    un-dodgeable/un-blockable by these passives, consistent with
 *    flash_step_dodge's own "does not apply to true-damage/%-HP effects"
 *    clause — those multi-hit boss patterns behave the same way.
 *
 * THE FOUR REBORN PASSIVES ARE NOT DISPATCHED FROM HERE.
 * data/named-weapon-passives.json also carries existence_ward,
 * glory_amplify, dragon_robe_negation and dragon_blade_wrath, for the four
 * relics the Reborn ritual hands out (see plugins/reborn.js). They have no
 * handler in the table below on purpose. applyAllNamedPassives() is only
 * invoked from plugins/attack.js and plugins/defend.js, which means a
 * passive registered here silently does nothing in skill turns, ability
 * turns, boss ultimates or PvP. A relic that a god personally handed over
 * has to work everywhere, so those four are implemented in the two central
 * damage funnels instead:
 *   outgoing -> calcPlayerDamage()      in lib/combat-engine.js
 *   incoming -> applyIncomingDamage()   in lib/character-abilities.js
 * both by way of lib/reborn-engine.js. Their entries in the JSON exist so
 * .iteminfo and the codex have text to show. Do not add handlers for them
 * here without first removing the funnel versions, or they will double up.
 */
import { allItems } from './game-data.js'
import { addStatusEffect } from './effects.js'
import { getPrimaryStat } from './combat-engine.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

export const NP_EVENT = {
  FIGHT_INIT:        'fight_init',        // once, first action of the fight
  TURN_START:        'turn_start',        // before the player's chosen action resolves
  PRE_DAMAGE:        'pre_damage',        // player's own hit, before DEF is applied
  PLAYER_HIT:        'player_hit',        // player's own hit, after damage lands on enemy
  ENEMY_DEAL_DAMAGE: 'enemy_deal_damage', // enemy/boss counter-hit, before it lands on player
  PLAYER_DEFEND:     'player_defend',     // Defend action specifically
  TURN_END:          'turn_end',
}

/**
 * Every equipped item that is `named` and carries a `passiveId`, across
 * every equip slot (see STRUCTURAL NOTE above) — not just `weapon`.
 */
export function getEquippedNamedItems(player) {
  const eq = player.equipped ?? {}
  const out = []
  for (const slotId of Object.keys(eq)) {
    const itemId = eq[slotId]
    if (!itemId) continue
    const item = itemMap[itemId]
    if (item?.named && item?.passiveId) out.push(item)
  }
  return out
}

function ensureState(bs) {
  if (!bs.namedPassive) bs.namedPassive = {}
  return bs.namedPassive
}

function _noop() {
  return { modified: false, lines: [] }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers — one per passiveId. Each receives (player, event, ctx) and must
// check `event` itself (a handler may care about more than one event, e.g.
// full_counter_on_crit tracks incoming damage on ENEMY_DEAL_DAMAGE *and*
// reflects it on PLAYER_HIT).
// ─────────────────────────────────────────────────────────────────────────────
const HANDLERS = {
  // Wado Ichimonji — second physical strike, 50% of base ATK, no crit.
  bonus_attack_per_turn(player, event, ctx) {
    if (event !== NP_EVENT.PLAYER_HIT || !ctx.isHit) return _noop()
    const bonus = Math.floor(getPrimaryStat(player) * 0.5)
    if (bonus <= 0) return _noop()
    ctx.enemy.hp = Math.max(0, ctx.enemy.hp - bonus)
    return { modified: true, lines: [`✨ *Wado Ichimonji* strikes again! _(+${bonus} bonus dmg)_`] }
  },

  // Tensa Zangetsu — first (only, structurally) hit each turn deals x1.5.
  bankai_power_surge(player, event, ctx) {
    if (event !== NP_EVENT.PRE_DAMAGE) return _noop()
    const dmg = Math.floor((ctx.damage ?? 0) * 1.5)
    return { modified: true, damage: dmg, lines: [`⚡ *Tensa Zangetsu* erupts with Bankai power!`] }
  },

  // Kubikiribocho — heal 15% of physical damage dealt, clamp to maxHp.
  lifesteal_on_hit(player, event, ctx) {
    if (event !== NP_EVENT.PLAYER_HIT || !ctx.isHit || ctx.finalDmg <= 0) return _noop()
    const heal = Math.floor(ctx.finalDmg * 0.15)
    if (heal <= 0) return _noop()
    const before = player.hp
    player.hp = Math.min(player.maxHp, player.hp + heal)
    const gained = player.hp - before
    if (gained <= 0) return _noop()
    return { modified: true, lines: [`🩸 *Kubikiribocho* drains life! _(+${gained} HP)_`] }
  },

  // Nichirin Blade — +20% bonus fire damage, ignores DEF (true damage add-on).
  // Fire-immune-enemy resist clause: see STRUCTURAL GAPS at top of file.
  flame_element_bonus(player, event, ctx) {
    if (event !== NP_EVENT.PLAYER_HIT || !ctx.isHit || ctx.rawDmg <= 0) return _noop()
    const bonus = Math.floor(ctx.rawDmg * 0.2)
    if (bonus <= 0) return _noop()
    ctx.enemy.hp = Math.max(0, ctx.enemy.hp - bonus)
    return { modified: true, lines: [`🔥 *Nichirin Blade* sears an extra *${bonus}* fire damage!`] }
  },

  // Lostvayne — on crit, reflect 50% of the enemy's last dealt damage as
  // true damage. Tracks "enemy's last dealt damage" in battleState.
  full_counter_on_crit(player, event, ctx) {
    const state = ensureState(ctx.bs)
    if (event === NP_EVENT.ENEMY_DEAL_DAMAGE) {
      state.lastEnemyDamage = ctx.damage ?? 0
      return _noop()
    }
    if (event !== NP_EVENT.PLAYER_HIT || !ctx.isCrit) return _noop()
    const last = state.lastEnemyDamage ?? 0
    if (last <= 0) return _noop()
    const reflect = Math.floor(last * 0.5)
    if (reflect <= 0) return _noop()
    ctx.enemy.hp = Math.max(0, ctx.enemy.hp - reflect)
    return { modified: true, lines: [`🔁 *Lostvayne* Full Counter! *${reflect}* true damage reflected!`] }
  },

  // Venuzdonoa — all player attacks bypass DEF entirely (true damage).
  concept_destruction(player, event, ctx) {
    if (event !== NP_EVENT.PRE_DAMAGE) return _noop()
    return { modified: true, bypassDefense: true, lines: [`💀 *Venuzdonoa* erases the concept of defense!`] }
  },

  // Sovereign's Blade — 20% chance/attack, extra strike at 40% ATK true dmg.
  shadow_monarch_strike(player, event, ctx) {
    if (event !== NP_EVENT.PLAYER_HIT || !ctx.isHit) return _noop()
    if (Math.random() >= 0.20) return _noop()
    const bonus = Math.floor(getPrimaryStat(player) * 0.4)
    if (bonus <= 0) return _noop()
    ctx.enemy.hp = Math.max(0, ctx.enemy.hp - bonus)
    return { modified: true, lines: [`👤 *Sovereign's Blade* summons a shadow soldier! _(+${bonus} true dmg)_`] }
  },

  // Bisento of Storms — every 3rd turn, true damage = 30% of enemy's
  // *current* HP, floor at 1 HP (cannot kill).
  quake_shockwave(player, event, ctx) {
    if (event !== NP_EVENT.TURN_END) return _noop()
    if (!ctx.bs.turn || ctx.bs.turn % 3 !== 0) return _noop()
    const dmg = Math.floor(ctx.enemy.hp * 0.30)
    if (dmg <= 0) return _noop()
    ctx.enemy.hp = Math.max(1, ctx.enemy.hp - dmg)
    return { modified: true, lines: [`🌋 *Bisento of Storms* splits the ground! *${dmg}* true damage!`] }
  },

  // Kyoka Suigetsu — at combat start only, -25% enemy ATK for 3 turns via
  // the existing `weaken` effect (lib/effects.js), not a parallel system.
  complete_hypnosis(player, event, ctx) {
    if (event !== NP_EVENT.FIGHT_INIT) return _noop()
    const state = ensureState(ctx.bs)
    if (state.hypnosisApplied) return _noop()
    state.hypnosisApplied = true
    const atkBase = ctx.enemy.stats?.atk ?? ctx.enemy.atk ?? 0
    const value = Math.max(1, Math.round(atkBase * 0.25))
    addStatusEffect(ctx.enemy, { type: 'weaken', stat: 'atk', value, duration: 3, sourceId: 'kyoka_suigetsu' })
    return { modified: true, lines: [`🌸 *Kyoka Suigetsu* clouds ${ctx.enemy.name}'s senses! _(-25% ATK, 3 turns)_`] }
  },

  // Death Scythe — drain 10 MP from enemy (if tracked), add to player MP
  // capped at maxMp. Enemies with 0/no MP take bonus true damage instead.
  mp_drain_on_hit(player, event, ctx) {
    if (event !== NP_EVENT.PLAYER_HIT || !ctx.isHit) return _noop()
    const DRAIN = 10
    const enemyMp = ctx.enemy.mp
    if (enemyMp == null || enemyMp <= 0) {
      ctx.enemy.hp = Math.max(0, ctx.enemy.hp - DRAIN)
      return { modified: true, lines: [`💧 *Death Scythe* finds no mana to drain, so it bites for *${DRAIN}* bonus damage instead!`] }
    }
    const drained = Math.min(DRAIN, enemyMp)
    ctx.enemy.mp = enemyMp - drained
    const before = player.mp ?? 0
    player.mp = Math.min(player.maxMp, before + drained)
    const gained = player.mp - before
    return { modified: true, lines: [`💧 *Death Scythe* drains *${drained}* MP! _(+${gained} MP)_`] }
  },

  // One For All Gauntlets — +5% ATK at end of each player turn, stacks to
  // +25% max; the stack itself lives in battleState so it resets for free
  // when battleState is discarded at fight end.
  one_for_all_stack(player, event, ctx) {
    const state = ensureState(ctx.bs)
    if (event === NP_EVENT.TURN_END) {
      state.oneForAllStacks = Math.min(5, (state.oneForAllStacks ?? 0) + 1)
      return { modified: true, lines: [`💪 *One For All* surges! _(+${state.oneForAllStacks * 5}% ATK, stack ${state.oneForAllStacks}/5)_`] }
    }
    if (event === NP_EVENT.PRE_DAMAGE && state.oneForAllStacks) {
      const mult = 1 + state.oneForAllStacks * 0.05
      return { modified: true, damage: Math.floor((ctx.damage ?? 0) * mult) }
    }
    return _noop()
  },

  // Divine Protection Aegis — 20% chance/incoming hit to fully nullify it.
  divine_protection_block(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    if (Math.random() >= 0.20) return _noop()
    return { modified: true, damage: 0, lines: [`🛡️ *Divine Protection Aegis* nullifies the attack completely!`] }
  },

  // Six Eyes Blindfold — Defend-only, 35% chance to nullify the counter.
  infinity_nullify_on_defend(player, event, ctx) {
    if (event !== NP_EVENT.PLAYER_DEFEND) return _noop()
    if (Math.random() >= 0.35) return _noop()
    return { modified: true, damage: 0, lines: [`👁️ *Six Eyes Blindfold* nullifies the counter-attack entirely!`] }
  },

  // Baryon Mode Headband — end of turn, permanently cut enemy maxHp by 5%.
  life_expenditure_counter(player, event, ctx) {
    if (event !== NP_EVENT.TURN_END) return _noop()
    const cut = Math.floor(ctx.enemy.maxHp * 0.05)
    if (cut <= 0) return _noop()
    ctx.enemy.maxHp = Math.max(1, ctx.enemy.maxHp - cut)
    if (ctx.enemy.hp > ctx.enemy.maxHp) ctx.enemy.hp = ctx.enemy.maxHp
    return { modified: true, lines: [`⏳ *Baryon Mode Headband* erodes ${ctx.enemy.name}'s lifespan! _(Max HP -${cut})_`] }
  },

  // Dragon Sin Cuirass — a single hit > 30% of player maxHp reflects 100%
  // of that hit's damage back as true damage, once per hit.
  full_counter_armor(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    const dmg = ctx.damage ?? 0
    if (dmg < player.maxHp * 0.30) return _noop()
    ctx.enemy.hp = Math.max(0, ctx.enemy.hp - dmg)
    return { modified: true, lines: [`🐉 *Dragon Sin Cuirass* reflects the full blow! *${dmg}* true damage back!`] }
  },

  // Ultra Ego Plate — -5% incoming damage per 10% of maxHp missing, capped
  // at -50% (reached at 100% missing). Read from current HP at hit-time.
  ultra_ego_resolve(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    const missingPct = 1 - (player.hp / player.maxHp)
    const reduction = Math.min(0.50, Math.floor(missingPct * 10) * 0.05)
    if (reduction <= 0) return _noop()
    const reduced = Math.max(0, Math.floor((ctx.damage ?? 0) * (1 - reduction)))
    return { modified: true, damage: reduced, lines: [`😤 *Ultra Ego Plate* resolve hardens! _(-${Math.round(reduction * 100)}% dmg taken)_`] }
  },

  // Shunpo Greaves — 15% dodge/incoming hit; skipped for true-damage hits
  // (caller marks ctx.trueDamage for guaranteedHits/doubleStrike/etc).
  flash_step_dodge(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE || ctx.trueDamage) return _noop()
    if (Math.random() >= 0.15) return _noop()
    return { modified: true, damage: 0, lines: [`💨 *Shunpo Greaves* dodge the attack entirely!`] }
  },

  // Gate of Babylon Core — start of each player turn, before the player's
  // action resolves, 1-3 random projectiles at 10% ATK true damage each.
  gate_of_babylon_summon(player, event, ctx) {
    if (event !== NP_EVENT.TURN_START) return _noop()
    const count = 1 + Math.floor(Math.random() * 3)
    const perHit = Math.floor(getPrimaryStat(player) * 0.10)
    if (perHit <= 0) return _noop()
    let total = 0
    for (let i = 0; i < count; i++) {
      ctx.enemy.hp = Math.max(0, ctx.enemy.hp - perHit)
      total += perHit
    }
    return { modified: true, lines: [`🗝️ *Gate of Babylon* fires *${count}* Noble Phantasm(s)! *${total}* true damage!`] }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // EMPIRE HEIRLOOMS (data/empire-heirlooms.json) — the ten armor pieces a
  // resident of your realm hands over at full favor. Deliberately built from
  // the SAME seven events the anime passives above use, so wiring these needed
  // no change to attack.js/defend.js at all. Consequences of that, both stated
  // in each item's own description so nobody is misled:
  //   - like every passive in this table, they are live in .attack and .defend
  //     and inert in skill/ability turns and PvP (see the header note),
  //   - ENEMY_DEAL_DAMAGE fires BEFORE the hit lands on the player, so a
  //     passive that has to read the wearer's post-hit HP (second_wind_once)
  //     checks it at TURN_END instead of mid-hit.
  // Each one occupies a mechanical axis none of the eighteen above use: a
  // one-shot threshold heal, a reactive debuff, stacking mitigation earned by
  // being hit, damage soaked into MP, flat regen, a reward for a clean turn,
  // stacking mitigation earned by defending, a guaranteed first-hit negation,
  // an underdog damage bonus, and an opening burn.
  // ───────────────────────────────────────────────────────────────────────────

  // Thresher's Coif — the first turn that ENDS with the wearer under 30% HP,
  // heal 25% of max HP. Once per fight. Checked at TURN_END because the
  // incoming-damage event runs before the damage is actually applied.
  second_wind_once(player, event, ctx) {
    if (event !== NP_EVENT.TURN_END) return _noop()
    const state = ensureState(ctx.bs)
    if (state.secondWindUsed) return _noop()
    if (!player.maxHp || player.hp > player.maxHp * 0.30) return _noop()
    const heal = Math.floor(player.maxHp * 0.25)
    if (heal <= 0) return _noop()
    const before = player.hp
    player.hp = Math.min(player.maxHp, player.hp + heal)
    const gained = player.hp - before
    if (gained <= 0) return _noop()
    state.secondWindUsed = true
    return { modified: true, lines: [`🌾 *Thresher's Coif* finds one more hour in you! _(+${gained} HP, once per fight)_`] }
  },

  // Fisher's Netted Cowl — 20% chance per incoming hit to tangle the attacker,
  // cutting its ATK by 20% for 2 turns through the existing `weaken` effect
  // rather than a parallel system (same route complete_hypnosis takes).
  snare_on_hit(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    if (Math.random() >= 0.20) return _noop()
    const atkBase = ctx.enemy?.stats?.atk ?? ctx.enemy?.atk ?? 0
    const value = Math.max(1, Math.round(atkBase * 0.20))
    addStatusEffect(ctx.enemy, { type: 'weaken', stat: 'atk', value, duration: 2, sourceId: 'netted_cowl' })
    return { modified: true, lines: [`🐟 *Fisher's Netted Cowl* tangles ${ctx.enemy.name}! _(-20% ATK, 2 turns)_`] }
  },

  // Tanner's Layered Jerkin — 3% less incoming damage per hit already taken,
  // capped at 30%. The reduction is applied BEFORE the counter increments, so
  // the first hit of a fight lands in full and the leather learns from it.
  hide_thickening(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    const state = ensureState(ctx.bs)
    const stacks = state.hideStacks ?? 0
    state.hideStacks = Math.min(10, stacks + 1)
    if (stacks <= 0) return _noop()
    const reduction = Math.min(0.30, stacks * 0.03)
    const reduced = Math.max(0, Math.floor((ctx.damage ?? 0) * (1 - reduction)))
    return {
      modified: true,
      damage: reduced,
      lines: [`🐂 *Tanner's Layered Jerkin* has hardened! _(-${Math.round(reduction * 100)}% dmg taken)_`],
    }
  },

  // Miner's Ironback Plate — 10% of every incoming hit is soaked out of the
  // damage and into the wearer's MP pool (clamped to maxMp).
  oreblood_conversion(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    const dmg = ctx.damage ?? 0
    const soak = Math.floor(dmg * 0.10)
    if (soak <= 0) return _noop()
    const before = player.mp ?? 0
    player.mp = Math.min(player.maxMp ?? before, before + soak)
    const gained = player.mp - before
    return {
      modified: true,
      damage: Math.max(0, dmg - soak),
      lines: [`⛏️ *Miner's Ironback Plate* drinks the blow! _(-${soak} dmg${gained > 0 ? `, +${gained} MP` : ''})_`],
    }
  },

  // Herbalist's Greenstep Boots — flat 3% of max HP back at the end of every
  // turn, no condition and no cap on how many times it happens.
  steady_bloom(player, event, ctx) {
    if (event !== NP_EVENT.TURN_END) return _noop()
    const heal = Math.floor((player.maxHp ?? 0) * 0.03)
    if (heal <= 0 || player.hp >= player.maxHp) return _noop()
    const before = player.hp
    player.hp = Math.min(player.maxHp, player.hp + heal)
    const gained = player.hp - before
    if (gained <= 0) return _noop()
    return { modified: true, lines: [`🌿 *Greenstep Boots* keep growing! _(+${gained} HP)_`] }
  },

  // Courier's Longstride Boots — if nothing damaged the wearer during the
  // previous turn, this turn's hit lands 25% harder. The "clean turn" flag is
  // rolled over at TURN_END, so turn one never qualifies (nothing has happened
  // yet) and a turn where every hit was dodged or nullified does.
  untouched_momentum(player, event, ctx) {
    const state = ensureState(ctx.bs)
    if (event === NP_EVENT.ENEMY_DEAL_DAMAGE) {
      if ((ctx.damage ?? 0) > 0) state.momentumHitThisTurn = true
      return _noop()
    }
    if (event === NP_EVENT.TURN_END) {
      state.momentumClean = !state.momentumHitThisTurn
      state.momentumHitThisTurn = false
      return _noop()
    }
    if (event !== NP_EVENT.PRE_DAMAGE || !state.momentumClean) return _noop()
    const dmg = Math.floor((ctx.damage ?? 0) * 1.25)
    return { modified: true, damage: dmg, lines: [`📜 *Longstride Boots* carry the road with you! _(+25% dmg)_`] }
  },

  // Mason's Keystone Boots — every Defend action settles the footing for the
  // rest of the fight: 8% less incoming damage per Defend taken, capped at 40%.
  // PLAYER_DEFEND resolves before the counter-attack, so the stack earned this
  // turn already protects against this turn's counter.
  keystone_stance(player, event, ctx) {
    const state = ensureState(ctx.bs)
    if (event === NP_EVENT.PLAYER_DEFEND) {
      const before = state.keystoneStacks ?? 0
      if (before >= 5) return _noop()   // already capped: stay quiet rather than repeat "5/5" every turn
      state.keystoneStacks = before + 1
      return {
        modified: true,
        lines: [`🧱 *Keystone Boots* plant firm! _(-${state.keystoneStacks * 8}% dmg taken, stack ${state.keystoneStacks}/5)_`],
      }
    }
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    const stacks = state.keystoneStacks ?? 0
    if (stacks <= 0) return _noop()
    const reduction = Math.min(0.40, stacks * 0.08)
    return { modified: true, damage: Math.max(0, Math.floor((ctx.damage ?? 0) * (1 - reduction))) }
  },

  // Glassblower's Lantern Shield — the first incoming hit of each fight is
  // reduced to nothing, guaranteed. Distinct from Divine Protection Aegis's
  // per-hit chance: this one always happens, and only once.
  first_guard_shatter(player, event, ctx) {
    if (event !== NP_EVENT.ENEMY_DEAL_DAMAGE) return _noop()
    const state = ensureState(ctx.bs)
    if (state.glassSpent) return _noop()
    state.glassSpent = true
    if ((ctx.damage ?? 0) <= 0) return _noop()
    return { modified: true, damage: 0, lines: [`🫧 *Lantern Shield* shatters the first blow! _(0 damage)_`] }
  },

  // Watchman's Bell Buckler — while the enemy has more HP left than the wearer,
  // every hit lands 12% harder. Checked fresh on each swing, so it switches
  // itself off the moment the wearer pulls ahead.
  underdog_rally(player, event, ctx) {
    if (event !== NP_EVENT.PRE_DAMAGE) return _noop()
    if ((ctx.enemy?.hp ?? 0) <= (player.hp ?? 0)) return _noop()
    const dmg = Math.floor((ctx.damage ?? 0) * 1.12)
    return { modified: true, damage: dmg, lines: [`🔔 *Bell Buckler* rings the alarm! _(+12% dmg while behind)_`] }
  },

  // Chandler's Waxlight Buckler — one opening burn at fight start for 5% of the
  // enemy's MAX HP, which makes it scale with the target rather than the wearer.
  waxlight_flare(player, event, ctx) {
    if (event !== NP_EVENT.FIGHT_INIT) return _noop()
    // Guarded like complete_hypnosis: FIGHT_INIT is once-per-fight by contract,
    // and this keeps that true even if a boss phase ever re-initialises.
    const state = ensureState(ctx.bs)
    if (state.waxlightSpent) return _noop()
    state.waxlightSpent = true
    const burn = Math.floor((ctx.enemy?.maxHp ?? 0) * 0.05)
    if (burn <= 0) return _noop()
    ctx.enemy.hp = Math.max(0, ctx.enemy.hp - burn)
    return { modified: true, lines: [`🕯️ *Waxlight Buckler* flares as the fight opens! *${burn}* damage!`] }
  },
}

/** Dispatch a single named item's passive for one event. */
export function applyNamedPassive(player, item, event, context = {}) {
  const handler = HANDLERS[item?.passiveId]
  if (!handler) return _noop()
  return handler(player, event, context)
}

/**
 * Dispatch every equipped named item's passive for one event, folding
 * damage/bypassDefense overrides across all of them (in equip-slot order)
 * and concatenating narrative lines. This is the function combat plugins
 * should call — not applyNamedPassive directly — since a player may have
 * several named items equipped at once (see STRUCTURAL NOTE at top).
 */
export function applyAllNamedPassives(player, event, context = {}) {
  const items = getEquippedNamedItems(player)
  const lines = []
  let modified = false
  let damage = context.damage
  let bypassDefense = false

  for (const item of items) {
    const result = applyNamedPassive(player, item, event, { ...context, damage })
    if (!result.modified) continue
    modified = true
    if (result.lines?.length) lines.push(...result.lines)
    if (result.damage !== undefined) damage = result.damage
    if (result.bypassDefense) bypassDefense = true
  }

  return { modified, lines, damage, bypassDefense }
}
