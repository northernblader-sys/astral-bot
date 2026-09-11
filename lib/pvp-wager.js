/**
 * pvp-wager.js — wager duels: the no-turns, stake-on-the-line PvP mode.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT AN `isWager` FLAG THROUGH runPvpTurn():
 * plugins/pvp.js's runPvpTurn() is ~1,300 lines of character-ability machinery
 * (Cinder Verdict, Hollow Purple, Domain Expansion, Wild Card, Thief's Eye,
 * Unlimited Void, the Yoriichi auto-fight, Anastasia's Hypnosis rewind...).
 * Wager mode disables ALL of that by design, so threading a flag through it
 * would mean ~40 new branches in the most delicate function in the bot, all of
 * them dead weight for the mode that actually uses them. Instead this file
 * reuses only the shared engine primitives — calcPlayerDamage, applyDefense,
 * getEffectiveStat, absorbDamage, applyIncomingDamage, the durability helpers —
 * which is exactly "the same base combat math without the character-specific
 * ability layer on top". Normal PvP is left completely untouched.
 *
 * THE THREE RULES THAT MAKE IT FEEL LIKE CRYSTAL PVP:
 *   1. No turn gate. Either player may act at any moment.
 *   2. A 2-second per-player cooldown is the ONLY pacing mechanism.
 *   3. You may not use the same command twice in a row, so attack → attack is
 *      refused but attack → defend → attack is fine.
 * Rules 2 and 3 replace turn order. Item actions are exempt from rule 3 (but
 * not rule 2) so grabbing a totem never locks you out of swinging next.
 *
 * STATE lives on player.battleState, alongside the normal PvP fields:
 *   { type: 'pvp', wager: true, opponentJid, wagerAmount, turn, startedAt,
 *     lastMoveAt, defending, lastActions: string[], lastCommandAt: number,
 *     pp: { [skillId]: usesLeft } }
 *
 * type STAYS 'pvp' and the mode is marked by the separate `wager: true` flag.
 * That is deliberate and load-bearing: roughly twenty files across the bot gate
 * on `battleState?.type === 'pvp'` (plugins/attack.js, skill.js, defend.js and
 * flee.js redirect out of PvE combat; profile.js prints "in a duel"; every
 * signature-ability plugin hands off to pvp.js). A new type string would have
 * slipped past all of them at once, so `.attack` would have tried to swing at a
 * non-existent bs.enemy mid-duel. The ability layer is refused in exactly one
 * place instead: runPvpTurn() bails on isWagerState() before anything else.
 *
 * The kit (player.pvpKit) is a separate bounded store, NOT a view over
 * player.inventory. See lib/pvp-kit.js.
 */

import {
  calcPlayerDamage, applyDefense, calcPlayerHitChance, findSkill, applyEquipmentBonus,
} from './combat-engine.js'
import {
  absorbDamage, getEffectiveStat, hasEffect, tickEffects, addStatusEffect, applyEffect,
} from './effects.js'
import {
  wearWeaponOnTurn, wearArmorOnHit, breakMessage, repairItem, repairArmor,
  durabilityReadout, initDurability, clearDurability,
} from './durability.js'
import { checkTotemRevive } from './combat-handlers.js'
import { allItems, skills as allSkills } from './game-data.js'
import {
  ensureKit, findKitItem, consumeFromKit, kitItemInfo, kitContents, PVP_KIT_SLOTS,
} from './pvp-kit.js'

/* ─────────────────────────── tunables ─────────────────────────── */

/** Milliseconds a player must wait between any two wager commands. */
export const WAGER_COOLDOWN_MS = 2000

/**
 * How many of a player's own recent commands block a repeat.
 *
 * 1, deliberately: the only thing refused is the exact same move twice in a
 * row. A window of 2 forced a strict attack → defend → skill rotation, because
 * with three combat actions it left exactly one legal move at any moment, and a
 * duel should not be a dance step. At 1 there is always a real choice and the
 * deadlock branch in checkPacing can no longer be reached in practice, since
 * defend is always payable.
 */
export const WAGER_NO_REPEAT_WINDOW = 1

/**
 * Wager hits land harder than normal PvP's. Normal PvP caps a basic hit at 15%
 * of max HP and a skill at 25%; wager raises both because §7 asks for fights
 * that are "genuinely losable fast", and because there is no turn order to slow
 * the exchange down.
 */
export const WAGER_BASIC_HIT_MAX_HP_FRAC = 0.20
export const WAGER_SKILL_HIT_MAX_HP_FRAC = 0.32

/** A wager duel auto-expires if neither player acts for this long. */
export const WAGER_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Smallest stake worth a duel. A floor exists so the mode cannot be used to
 * farm the ladder for 1 solar a match, which is the same thing as farming it
 * for free.
 */
export const WAGER_MIN_STAKE = 100

/**
 * parseStake(raw, available) → positive integer, or null when it is not a stake.
 *
 * Accepts `all` / `max`, plain digits with commas, and the k/m shorthand people
 * actually type in chat (`5k`, `1.5m`). Returning null rather than 0 lets the
 * caller tell "you typed nonsense" apart from "you typed zero".
 */
export function parseStake(raw, available = 0) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[, _]/g, '')
  if (!s) return null
  if (s === 'all' || s === 'max') {
    const v = Math.floor(Number(available) || 0)
    return v > 0 ? v : null
  }
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s)
  if (!m) return null
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1
  const v = Math.floor(Number(m[1]) * mult)
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Per-match PP by skill tier. Still an inverse ladder on purpose, so a mythic
 * skill is the scarcest thing in your kit, but every tier now has enough charges
 * to fight a whole duel with. The first pass ran 6 down to 1, which meant a
 * mythic skill was spent on its first cast and a legendary on its second: with a
 * 2 second cooldown and hits capped at a fifth of max HP, that put players out
 * of their best move before the fight had really started. MP is the resource
 * that is supposed to price a cast; PP only exists to stop one button being the
 * whole match.
 *
 * Derived rather than stored because data/skills.json holds 964 entries and none
 * of them carry a uses/cooldown/PP field today, and adding one to all 964 would
 * be 964 hand-tuned numbers to maintain for a mode-local resource.
 */
export const PP_BY_TIER = {
  common: 20, uncommon: 18, rare: 16, epic: 14, legendary: 12, mythic: 10,
}
export const PP_DEFAULT = 15

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

/* ─────────────────────────── PP ledger ─────────────────────────── */

/** Max PP for a skill, from its tier. */
export function maxPpFor(skill) {
  return PP_BY_TIER[skill?.tier] ?? PP_DEFAULT
}

/**
 * ppLeft(bs, skill) → number remaining this match. Lazily seeded: a skill that
 * has never been cast this match simply has no ledger entry yet, so the ledger
 * stays small instead of pre-filling every skill the player owns.
 */
export function ppLeft(bs, skill) {
  const ledger = bs?.pp ?? {}
  return ledger[skill.id] ?? maxPpFor(skill)
}

/** Spend one PP charge. Returns the new remaining count. */
export function spendPp(bs, skill) {
  bs.pp = bs.pp ?? {}
  const before = bs.pp[skill.id] ?? maxPpFor(skill)
  bs.pp[skill.id] = Math.max(0, before - 1)
  return bs.pp[skill.id]
}

/** Focus Vial: clear the whole ledger so every spent skill is full again. */
export function refillAllPp(bs) {
  const spent = Object.keys(bs?.pp ?? {}).length
  if (bs) bs.pp = {}
  return spent
}

/* ─────────────────────── pacing gate (§1.3) ─────────────────────── */

/**
 * Command families for the no-repeat rule. Item actions share the 'item'
 * family and are exempt from repeat-tracking entirely — swapping a totem must
 * never be the reason you can't attack next.
 */
export const COMBAT_ACTIONS = new Set(['attack', 'skill', 'defend'])

/**
 * True if the player could actually cast something right now: a known, active
 * skill they can pay for in both MP and match PP.
 *
 * This mirrors the four refusals in resolveWagerAction's skill branch exactly.
 * It exists because the no-repeat window counts 'skill' as an available move,
 * and that assumption is false for a player who cannot cast one.
 */
export function hasUsableSkill(player) {
  const bs = player?.battleState
  if (!bs) return false
  for (const id of player.skills ?? []) {
    const skill = allSkills.find((s) => s.id === id)
    if (!skill || skill.type === 'passive') continue
    if ((player.mp ?? 0) < (skill.mpCost ?? 0)) continue
    if (ppLeft(bs, skill) <= 0) continue
    return true
  }
  return false
}

/**
 * checkPacing(bs, action, opts) → { ok: true, forced? } | { ok: false, reason, waitMs? }
 *
 * The whole of wager mode's pacing. Called before any action resolves.
 * Read-only: it never mutates state, so a refused command costs nothing.
 *
 * `opts.hasUsableSkill` is the safety net that keeps the no-repeat window from
 * ever deadlocking a duel: 'skill' is only treated as an open alternative when
 * the caller says it is actually castable. At a window of 1 there is always at
 * least one other playable move (defend costs nothing), so the net should never
 * be needed. It stays because the window is a tunable, and if it is ever widened
 * again the rule must stand down for a turn (`forced: true`) rather than leave a
 * player with no legal command and hang the fight.
 */
export function checkPacing(bs, action, opts = {}) {
  const now = Date.now()
  const since = now - (bs.lastCommandAt ?? 0)
  if (since < WAGER_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', waitMs: WAGER_COOLDOWN_MS - since }
  }
  if (!COMBAT_ACTIONS.has(action)) return { ok: true }

  const recent = (bs.lastActions ?? []).slice(-WAGER_NO_REPEAT_WINDOW)
  if (recent.includes(action)) {
    // Is any OTHER combat action both outside the window and actually playable?
    // 'skill' only counts when the caller says it is castable; attack and defend
    // are always payable, so this is only ever false in a genuine deadlock.
    const canSkill = opts.hasUsableSkill === true
    const alternatives = [...COMBAT_ACTIONS].filter(
      (a) => !recent.includes(a) && (a !== 'skill' || canSkill),
    )
    if (alternatives.length) return { ok: false, reason: 'repeat', recent }
    return { ok: true, forced: true, recent }
  }
  return { ok: true }
}

/**
 * notePacing(bs, action) — record a command that actually went through. Item
 * actions bump the cooldown clock but are deliberately NOT pushed onto
 * lastActions, which is what exempts them from the no-repeat window.
 */
export function notePacing(bs, action) {
  bs.lastCommandAt = Date.now()
  if (!COMBAT_ACTIONS.has(action)) return
  bs.lastActions = [...(bs.lastActions ?? []), action].slice(-WAGER_NO_REPEAT_WINDOW)
}

/**
 * Appended to a turn that only went through because the no-repeat window had
 * nothing left to offer. Without it, a player who was just refused for repeating
 * would see the same move accepted a moment later and read the rule as broken.
 */
export const PACING_FORCED_NOTE =
  `\n\n_🔁 Nothing else was open to you, so the no-repeat rule stood down for that one._`

/** Human-readable refusal for a failed checkPacing(). */
export function pacingMessage(gate, prefix) {
  if (gate.reason === 'cooldown') {
    return `⏱️ *Too fast.* ${(gate.waitMs / 1000).toFixed(1)}s left on your cooldown.\n` +
      `_Wager duels have no turns, only a 2 second breath between moves._`
  }
  const recent = (gate.recent ?? []).join(' → ')
  return `🚫 *No repeats.* You just used _${recent}_.\n` +
    `Mix it up: the same move cannot be used twice in a row.\n` +
    `_Free anytime:_ ${prefix}pvp dr · ${prefix}pvp tot · ${prefix}pvp mnd · ${prefix}pvp status`
}

/* ───────────────────────── state helpers ───────────────────────── */

/**
 * True if this battleState is a wager duel.
 *
 * Keyed on the `wager` flag, never on `type`, because `type` stays 'pvp' on
 * purpose (see the file header): the whole bot's "are you in a duel" guards read
 * type, and only this mode's own branches read the flag.
 */
export function isWagerState(bs) {
  return !!(bs?.wager && bs?.type === 'pvp')
}

/** Build a fresh wager battleState for one side of the duel. */
export function makeWagerState(opponentJid, wagerAmount) {
  return {
    type: 'pvp',
    wager: true,
    opponentJid,
    wagerAmount,
    // Kept true on BOTH sides so every existing `battleState.myTurn` read
    // elsewhere in the bot sees a truthy value instead of undefined. Wager mode
    // never gates on it: either player may act at any moment.
    myTurn: true,
    defending: false,
    turn: 1,
    startedAt: Date.now(),
    lastMoveAt: Date.now(),
    lastCommandAt: 0,
    lastActions: [],
    pp: {},
  }
}

/** Idle milliseconds since the last move in this duel. */
export function wagerIdleMs(bs) {
  return Date.now() - (bs?.lastMoveAt ?? bs?.startedAt ?? Date.now())
}


/* ─────────────────────── combat resolution ─────────────────────── */

/**
 * resolveWagerAction(actor, opp, action, query) → result
 *
 * Resolves one wager action against two in-memory player objects, mutating
 * both. The CALLER owns persistence: it must write `actor` and `opp` back with
 * two separate, sequentially-awaited updatePlayer() calls. Never nest them —
 * lib/player-repo.js serialises every write on one global queue, so a
 * updatePlayer() inside another updatePlayer() waits forever on its own parent.
 *
 * Returns { ok, msg, oppDefeated, actorDefeated } — `ok: false` means nothing
 * was mutated and `msg` explains why.
 *
 * Deliberately absent, per §1's "no characters": Cinder Verdict, Hollow
 * Purple/Exchange, Domain Expansion, Wild Card, Thief's Eye, Unlimited Void,
 * Yoriichi's cat form, Anastasia's Hypnosis, Circe, Shunya's rebound, equipped
 * Beast summons, and applyIncomingDamage()'s character-passive mitigation
 * layer. Damage goes straight through the base formula to hp so both sides can
 * do the arithmetic in their head mid-fight.
 */
export function resolveWagerAction(actor, opp, action, query = '') {
  const bs = actor.battleState
  const oppBs = opp.battleState

  if (action === 'defend') {
    bs.defending = true
    const mpBack = Math.max(1, Math.floor(actor.maxMp * 0.10))
    const before = actor.mp
    actor.mp = Math.min(actor.maxMp, actor.mp + mpBack)
    const ticks = finishWagerAction(actor, opp, action)
    const selfDown = settleSelfTicks(actor)
    return {
      ok: true,
      oppDefeated: false,
      actorDefeated: selfDown.defeated,
      msg: `🛡️ *${actor.name}* braces behind their guard.\n` +
        `_Next hit taken is halved._\n` +
        `💧 MP ${before} → ${actor.mp}/${actor.maxMp}` + ticks + selfDown.line,
    }
  }

  let skill = null
  if (action === 'skill') {
    const found = findSkill(query, actor.skills ?? [], allSkills)
    if (!found) return { ok: false, msg: `❌ You don't know a skill called *${query}*.` }
    if (found.type === 'passive') return { ok: false, msg: `❌ *${found.name}* is passive, it fires on its own.` }
    if ((actor.mp ?? 0) < (found.mpCost ?? 0)) {
      return { ok: false, msg: `💧 *Not enough MP.* *${found.name}* costs ${found.mpCost}, you have ${actor.mp}.` }
    }
    const left = ppLeft(bs, found)
    if (left <= 0) {
      return {
        ok: false,
        msg: `🚫 *${found.name}* is out of PP for this match. _(0/${maxPpFor(found)})_\n` +
          `_Drink a Focus Vial to refill every spent skill._`,
      }
    }
    skill = found
  }

  return resolveWagerHit(actor, opp, action, skill)
}

/**
 * The damage pipeline, mirroring normal PvP's order of operations exactly minus
 * the ability layer: accuracy → base damage → target DEF → defend halving →
 * max-HP hit cap → shields and Ironskin → hp → totem check.
 */
function resolveWagerHit(actor, opp, action, skill) {
  const bs = actor.battleState
  const oppBs = opp.battleState
  const lines = []

  // ── accuracy ──
  const hitChance = calcPlayerHitChance(actor, opp)
  if (Math.random() > hitChance) {
    if (skill) {
      // A miss still costs the resource. Skills are committed, not free rolls.
      actor.mp = Math.max(0, actor.mp - (skill.mpCost ?? 0))
      spendPp(bs, skill)
    }
    const ticks = finishWagerAction(actor, opp, action)
    const selfDown = settleSelfTicks(actor)
    return {
      ok: true, oppDefeated: false, actorDefeated: selfDown.defeated, missed: true,
      // A whiff can still be lethal: your own burn ticks at the end of the
      // action, so the totem can fire on a turn you never connected on.
      revived: selfDown.revived ? 'actor' : null,
      msg: `💨 *${actor.name}* ${skill ? `unleashes *${skill.name}* and` : 'swings and'} *MISSES!*` +
        (skill ? `\n_${skill.mpCost} MP burned for nothing._` : '') + ticks + selfDown.line,
    }
  }

  // ── base damage, no character multipliers ──
  const { rawDmg, isCrit } = calcPlayerDamage(actor, skill, 1)
  let dmg = applyDefense(rawDmg, getEffectiveStat(opp, 'def'))

  if (oppBs?.defending) {
    dmg = Math.max(1, Math.floor(dmg * 0.5))
    oppBs.defending = false
    lines.push(`🛡️ *${opp.name}* absorbs it on their guard, damage halved.`)
  }

  // Hit cap keeps a single exchange from being a one-shot even at a huge stat
  // gap, the same way normal PvP does, just looser.
  const cap = Math.max(
    1,
    Math.floor(opp.maxHp * (action === 'skill' ? WAGER_SKILL_HIT_MAX_HP_FRAC : WAGER_BASIC_HIT_MAX_HP_FRAC)),
  )
  if (dmg > cap) dmg = cap

  // ── shields + Ironskin, then hp ──
  const beforeAbsorb = dmg
  const landed = absorbDamage(opp, dmg)
  if (landed < beforeAbsorb) lines.push(`✨ ${beforeAbsorb - landed} damage soaked before it reached them.`)
  opp.hp = Math.max(0, opp.hp - landed)

  // ── costs ──
  if (skill) {
    actor.mp = Math.max(0, actor.mp - (skill.mpCost ?? 0))
    const left = spendPp(bs, skill)
    lines.push(`💧 MP ${actor.mp}/${actor.maxMp}  ·  🎯 ${skill.name} PP ${left}/${maxPpFor(skill)}`)
  }

  // ── gear wear: attacker's weapon, defender's armour ──
  const weaponWear = wearWeaponOnTurn(actor)
  const armorWear  = wearArmorOnHit(opp)
  const wearLines = [breakMessage(weaponWear), breakMessage(armorWear)].filter(Boolean).join('')

  // ── death check, totem first ──
  // `revived` names WHO the totem saved, so the caller can play the animation.
  // The narrative line alone is not enough to key off: the plugin would have to
  // regex chat copy to find out, and copy changes.
  let oppDefeated = false
  let totemLine = ''
  let revived = null
  if (opp.hp <= 0) {
    totemLine = checkTotemRevive(opp)
    if (totemLine) revived = 'opponent'
    else oppDefeated = true
  }

  const ticks = finishWagerAction(actor, opp, action)
  const selfDown = settleSelfTicks(actor)
  if (selfDown.revived) revived = 'actor'

  const head = skill
    ? `✨ *${actor.name}* unleashes *${skill.name}*!${isCrit ? ' ⚡ *CRIT!*' : ''}`
    : `⚔️ *${actor.name}* strikes *${opp.name}*!${isCrit ? ' ⚡ *CRIT!*' : ''}`

  return {
    ok: true,
    oppDefeated,
    actorDefeated: selfDown.defeated,
    revived,
    damage: landed,
    isCrit,
    skillName: skill?.name ?? null,
    msg: [
      head,
      `💥 *${landed}* damage!`,
      ...lines,
    ].join('\n') + wearLines + totemLine + ticks + selfDown.line,
  }
}

/**
 * A burn/poison tick can finish the acting player off. That is a legal way to
 * lose a wager, so it needs the same totem courtesy an enemy hit gets.
 */
function settleSelfTicks(actor) {
  if (actor.hp > 0) return { defeated: false, line: '', revived: false }
  const totem = checkTotemRevive(actor)
  if (totem) return { defeated: false, line: totem, revived: true }
  return { defeated: true, line: `\n☠️ *${actor.name}* drops from their own wounds.`, revived: false }
}

/**
 * Bookkeeping every resolved action shares: bump the pacing clock, advance the
 * shared turn counter, tick the actor's own status effects. Status ticks are
 * driven by the acting player rather than a global clock because wager mode has
 * no shared turn boundary to hang them on — you burn while you fight, and a
 * player who stops acting stops burning, which is a fair trade for having no
 * turn order. Hit-counted buffs (warcry/ironskin) are skipped by tickEffects
 * itself, so drinking a tonic and then not attacking does not waste it.
 *
 * Returns a chat-ready string of tick lines, or ''.
 */
function finishWagerAction(actor, opp, action) {
  const bs = actor.battleState
  notePacing(bs, action)
  bs.lastMoveAt = Date.now()
  bs.turn = (bs.turn ?? 1) + 1
  if (opp.battleState) opp.battleState.turn = bs.turn
  if (action !== 'defend') bs.defending = false

  const tickLines = tickEffects(actor)
  if (!tickLines.length) return ''
  return `\n` + tickLines.join('\n')
}

/* ──────────────── mid-battle item actions (§4 / §8) ──────────────── */
/*
 * All of these are FREE and PARALLEL: they do not consume a wager action and do
 * not count toward the no-repeat window (they are not in COMBAT_ACTIONS, so
 * notePacing only bumps the 2-second clock). They are wager-only by design —
 * normal turn-based PvP and dungeons have no mid-turn interrupt today, and
 * giving them one would silently change the pacing of every existing fight.
 * Everything they touch comes out of the kit, never the main inventory.
 */

/** Potion families the drink command accepts, in the order they are searched. */
const DRINKABLE = (item) => item?.type === 'consumable' &&
  ['heal', 'warcry', 'ironskin', 'regen', 'shield', 'strengthen', 'cure'].some(
    (t) => asEffects(item).some((e) => e?.type === t),
  )

/** An item's effect list, normalised to an array. */
function asEffects(item) {
  if (!item?.effect) return []
  return Array.isArray(item.effect) ? item.effect : [item.effect]
}

/**
 * drinkFromKit(player, query) → { ok, msg }
 * Consumes one potion from the kit and applies every effect on it. Routes
 * instant effects through applyEffect and duration/hit-counted ones through
 * addStatusEffect, which is the same split plugins/use.js uses.
 */
export function drinkFromKit(player, query) {
  const hit = findKitItem(player, query, DRINKABLE)
  if (!hit) {
    return {
      ok: false,
      msg: `❌ No drinkable potion matching *${query || '(nothing)'}* in your PvP kit.\n` +
        `_Stock one first, outside a duel:_ \`pvp stock <item>\``,
    }
  }
  const lines = []
  for (const eff of asEffects(hit.item)) {
    if (eff.type === 'heal' || eff.type === 'cure') {
      lines.push(applyEffect(player, eff))
    } else {
      addStatusEffect(player, eff)
      lines.push(effectBlurb(eff))
    }
  }
  consumeFromKit(player, hit.id)
  return {
    ok: true,
    msg: `🧪 *${player.name}* downs a *${hit.item.name}*!\n` + lines.filter(Boolean).join('\n'),
  }
}

/** Short player-facing description of a buff that was just applied. */
function effectBlurb(eff) {
  if (eff.type === 'warcry')   return `🔥 +${eff.percent}% damage on your next ${eff.hits} landed hits.`
  if (eff.type === 'ironskin') return `🪨 -${eff.percent}% damage from your next ${eff.hits} hits taken.`
  if (eff.type === 'shield')   return `🛡️ Shield absorbs up to ${eff.amount}.`
  if (eff.type === 'regen')    return `💚 +${eff.amount} ${String(eff.stat ?? 'hp').toUpperCase()} per turn.`
  if (eff.type === 'strengthen') return `✨ +${eff.value ?? eff.amount} ${String(eff.stat ?? '').toUpperCase()}.`
  return `✨ ${eff.type} applied.`
}

/**
 * refillPpFromKit(player) → { ok, msg }
 * Focus Vial: wipes the match's PP ledger so every spent skill is full again.
 */
export function refillPpFromKit(player) {
  const hit = findKitItem(player, 'focus_vial',
    (item) => asEffects(item).some((e) => e?.type === 'restore_pp'))
  if (!hit) {
    return { ok: false, msg: `❌ No *Focus Vial* in your PvP kit.\n_Stock one before the duel:_ \`pvp stock focus vial\`` }
  }
  const bs = player.battleState
  const spent = refillAllPp(bs)
  consumeFromKit(player, hit.id)
  if (!spent) {
    return {
      ok: true,
      msg: `🌀 *${player.name}* cracks a *Focus Vial*.\n_Nothing was depleted, but the head clears anyway._`,
    }
  }
  return {
    ok: true,
    msg: `🌀 *${player.name}* cracks a *Focus Vial*!\n🎯 PP restored on *${spent}* spent skill${spent === 1 ? '' : 's'}.`,
  }
}

/**
 * mendFromKit(player, target) → { ok, msg }
 * target: 'weapon' | 'armor'. Repairs half the durability already lost, so a
 * near-broken piece gets a big top-up and a scratched one gets almost nothing.
 */
export function mendFromKit(player, target) {
  const wantWeapon = /^(w|wpn|weap)/i.test(target ?? '')
  const wantedId = wantWeapon ? 'honed_whetstone' : 'cracked_warplate'
  const hit = findKitItem(player, wantedId,
    (item, id) => id === wantedId && asEffects(item).some((e) => e?.type === 'mend'))
  if (!hit) {
    const label = wantWeapon ? 'Honed Whetstone' : 'Cracked Warplate'
    return { ok: false, msg: `❌ No *${label}* in your PvP kit.\n_Stock one before the duel._` }
  }

  const pct = asEffects(hit.item).find((e) => e.type === 'mend')?.percent ?? 50
  const res = wantWeapon ? repairItem(player, 'weapon', pct) : repairArmor(player, pct)

  if (!res.repaired) {
    if (res.reason === 'empty')     return { ok: false, msg: `❌ Nothing equipped in that slot to mend.` }
    if (res.reason === 'untracked') return { ok: false, msg: `❌ *${res.itemName}* does not wear down, nothing to mend.` }
    if (res.reason === 'full')      return { ok: false, msg: `✅ *${res.itemName}* is already at full durability. Vial kept.` }
    return { ok: false, msg: `❌ Nothing to mend right now.` }
  }

  consumeFromKit(player, hit.id)
  return {
    ok: true,
    msg: `🔧 *${player.name}* works fast with a *${hit.item.name}*!\n` +
      `⚙️ *${res.itemName}* +${res.restored} durability _(${res.remaining}/${res.max})_`,
  }
}

/**
 * equipFromKit(player, itemId, slot) — the exact equip sequence
 * plugins/equip.js:99-118 performs (strip the outgoing item's bonuses, clear its
 * durability, fold the incoming item's bonuses in, start tracking it), with one
 * difference: the swapped-out piece goes back into the KIT, not the main
 * inventory, because the kit is the store this duel is being fought out of.
 * Extracted here rather than duplicated so the two can never drift.
 */
function equipFromKit(player, itemId, slot) {
  const kit = ensureKit(player)
  const idx = kit.indexOf(itemId)
  if (idx === -1) return { ok: false, reason: 'gone' }

  const item = kitItemInfo(itemId)
  const equipped = player.equipped ?? {}
  let displaced = null

  const existing = equipped[slot]
  if (existing) {
    const oldItem = kitItemInfo(existing)
    if (oldItem) applyEquipmentBonus(player, oldItem, -1)
    displaced = oldItem?.name ?? existing
    kit.push(existing)
    clearDurability(player, slot)
  }

  kit.splice(kit.indexOf(itemId), 1)
  equipped[slot] = itemId
  applyEquipmentBonus(player, item, +1)
  initDurability(player, slot, itemId)

  player.equipped = equipped
  player.pvpKit = kit
  return { ok: true, itemName: item?.name ?? itemId, displaced, slot }
}

/**
 * swapTotemFromKit(player) → { ok, msg }
 * Puts a fresh life-saver in the off hand. Accepts the Phoenix Clasp too, since
 * it lives in the same slot and does the same job with an auto-restock rider.
 * Never rescues a hit that has already landed: the totem must be in the slot
 * BEFORE the killing blow.
 */
export function swapTotemFromKit(player) {
  const hit = findKitItem(player, 'totem',
    (item, id) => id === 'totem_of_undying' || id === 'phoenix_clasp' || id === 'emberheart_core')
    ?? findKitItem(player, 'phoenix_clasp')
    ?? findKitItem(player, 'emberheart_core')
  if (!hit) {
    return {
      ok: false,
      msg: `❌ No totem stocked in your PvP kit.\n_Stock one before the duel:_ \`pvp stock totem of undying\``,
    }
  }
  const res = equipFromKit(player, hit.id, 'offhand')
  if (!res.ok) return { ok: false, msg: `❌ That totem is no longer in your kit.` }
  return {
    ok: true,
    msg: `🪬 *${player.name}* slots a *${res.itemName}* into their off hand!` +
      (res.displaced ? `\n↩️ *${res.displaced}* goes back into the kit.` : '') +
      `\n_It only works if it is worn before the killing blow._`,
  }
}

/** Armour slots the swap command will target. */
const ARMOR_SLOT_ALIASES = {
  helmet: 'helmet', helm: 'helmet', head: 'helmet', hat: 'helmet',
  chestplate: 'chestplate', chest: 'chestplate', body: 'chestplate', plate: 'chestplate',
  boots: 'boots', boot: 'boots', feet: 'boots', shoes: 'boots',
  offhand: 'offhand', shield: 'offhand', off: 'offhand',
}

/**
 * swapArmorFromKit(player, slotQuery, itemQuery) → { ok, msg }
 * Swaps in a stocked piece for one slot. With no item named it takes the best
 * stocked candidate for that slot, since naming an item mid-duel costs time the
 * 2-second clock does not give you.
 */
export function swapArmorFromKit(player, slotQuery, itemQuery = '') {
  const slot = ARMOR_SLOT_ALIASES[String(slotQuery ?? '').toLowerCase()]
  if (!slot) {
    return {
      ok: false,
      msg: `❓ Which slot? *helmet* · *chestplate* · *boots* · *offhand*\n_Example:_ \`pvp arm chest\``,
    }
  }
  const fits = (item, id) => item?.slot === slot && (item?.type === 'armor' || item?.type === 'relic')

  let chosen = itemQuery ? findKitItem(player, itemQuery, fits) : null
  if (itemQuery && !chosen) {
    return { ok: false, msg: `❌ No *${itemQuery}* stocked for your ${slot}.` }
  }
  if (!chosen) {
    // Best stocked candidate = highest total stat bonus for that slot.
    const candidates = ensureKit(player)
      .map((id) => ({ id, item: kitItemInfo(id) }))
      .filter(({ item, id }) => fits(item, id))
      .sort((a, b) => statWeight(b.item) - statWeight(a.item))
    if (!candidates.length) {
      return { ok: false, msg: `❌ Nothing stocked for your ${slot}.\n_Stock a spare before the duel._` }
    }
    chosen = candidates[0]
  }

  const res = equipFromKit(player, chosen.id, slot)
  if (!res.ok) return { ok: false, msg: `❌ That piece is no longer in your kit.` }
  return {
    ok: true,
    msg: `🛡️ *${player.name}* swaps in a fresh *${res.itemName}* _(${slot})_!` +
      (res.displaced ? `\n↩️ *${res.displaced}* goes back into the kit.` : ''),
  }
}

/**
 * swapWeaponFromKit(player, itemQuery) → { ok, msg }
 * The answer to a weapon breaking mid-exchange: put the backup in your hand
 * without leaving the fight.
 */
export function swapWeaponFromKit(player, itemQuery = '') {
  const fits = (item) => item?.slot === 'weapon' || item?.type === 'weapon'

  let chosen = itemQuery ? findKitItem(player, itemQuery, fits) : null
  if (itemQuery && !chosen) {
    return { ok: false, msg: `❌ No weapon called *${itemQuery}* in your PvP kit.` }
  }
  if (!chosen) {
    const candidates = ensureKit(player)
      .map((id) => ({ id, item: kitItemInfo(id) }))
      .filter(({ item }) => fits(item))
      .sort((a, b) => statWeight(b.item) - statWeight(a.item))
    if (!candidates.length) {
      return { ok: false, msg: `❌ No spare weapon stocked.\n_Stock a backup before the duel._` }
    }
    chosen = candidates[0]
  }

  const res = equipFromKit(player, chosen.id, 'weapon')
  if (!res.ok) return { ok: false, msg: `❌ That weapon is no longer in your kit.` }
  return {
    ok: true,
    msg: `⚔️ *${player.name}* brings up a *${res.itemName}*!` +
      (res.displaced ? `\n↩️ *${res.displaced}* goes back into the kit.` : ''),
  }
}

/** Crude "which of these is better" score for auto-picking a swap target. */
function statWeight(item) {
  const b = item?.statBonuses ?? {}
  return Object.values(b).reduce((sum, v) => sum + (Number(v) || 0), 0) + (item?.maxDurability ?? 0) / 100
}

/* ─────────────────────── escrow + settlement ─────────────────────── */

/**
 * ESCROW, NOT VERIFY-AT-END. Both stakes leave both wallets the moment the duel
 * is accepted, and the pot is paid out at the end. The alternative (check the
 * balance now, take it later) loses to the obvious exploit: spend your solars
 * mid-duel and there is nothing left to collect. Escrowed solars are held on
 * battleState.wagerAmount, so an interrupted duel can always be refunded from
 * the state itself without a separate ledger.
 */
export function escrowStake(player, amount) {
  player.wallet = player.wallet ?? {}
  const have = player.wallet.solars ?? 0
  if (have < amount) return { ok: false, have }
  player.wallet.solars = have - amount
  return { ok: true, remaining: player.wallet.solars }
}

/** Give an escrowed stake back, used when a duel dies without a winner. */
export function refundStake(player, amount) {
  player.wallet = player.wallet ?? {}
  player.wallet.solars = (player.wallet.solars ?? 0) + amount
  return player.wallet.solars
}

/**
 * payWagerPot(winner, amount) — the winner collects both stakes: their own
 * escrowed one back, plus the loser's. Net swing is +amount for the winner and
 * -amount for the loser, which is what "loser pays the full stake" means.
 */
export function payWagerPot(winner, amount) {
  winner.wallet = winner.wallet ?? {}
  winner.wallet.solars = (winner.wallet.solars ?? 0) + amount * 2
  return winner.wallet.solars
}

/**
 * clearWagerState(player) — end-of-duel cleanup, matching what pvpConclude does
 * for normal PvP: full heal, no lingering effects, no battle state. The kit is
 * deliberately left alone; what you did not spend stays packed for next time.
 */
export function clearWagerState(player) {
  player.battleState = null
  player.inBattle = false
  player.activeEffects = []
  player.hp = player.maxHp
  player.mp = player.maxMp
}

/* ───────────────────────── text panels ───────────────────────── */

/** A 10-cell bar, used by the wager board. */
function bar(cur, max) {
  const filled = Math.max(0, Math.min(10, Math.round((cur / Math.max(1, max)) * 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

/**
 * wagerBoard(me, them, prefix) — the no-cost status check. Reading the board
 * never touches the cooldown or the no-repeat window; it is not a battle action.
 */
export function wagerBoard(me, them, prefix) {
  const bs = me.battleState ?? {}
  const gear = durabilityReadout(me)
  const gearLine = gear.length
    ? gear.map((g) => `${g.frac <= 0.25 ? '🔴' : g.frac <= 0.5 ? '🟠' : '🟢'} ${g.itemName} ${g.current}/${g.max}`).join('\n')
    : '_nothing that wears out equipped_'

  const buffs = (me.activeEffects ?? [])
    .filter((e) => e.remaining > 0)
    .map((e) => e.meta?.hitCounted ? `${e.type} ×${e.remaining} hits` : `${e.type} ×${e.remaining}`)
  const spentPp = Object.entries(bs.pp ?? {}).filter(([, v]) => v <= 2)

  const cd = Math.max(0, WAGER_COOLDOWN_MS - (Date.now() - (bs.lastCommandAt ?? 0)))
  const blocked = (bs.lastActions ?? []).join(' → ')

  return [
    `╭─────────────────────────╮`,
    `│  💰 *WAGER DUEL*  ·  ☀️ ${(bs.wagerAmount ?? 0).toLocaleString()}`,
    `╰─────────────────────────╯`,
    ``,
    `👤 *${me.name}*`,
    `❤️ ${bar(me.hp, me.maxHp)} ${me.hp}/${me.maxHp}`,
    `💧 ${bar(me.mp, me.maxMp)} ${me.mp}/${me.maxMp}`,
    ``,
    `🎯 *${them.name}*`,
    `❤️ ${bar(them.hp, them.maxHp)} ${them.hp}/${them.maxHp}`,
    ``,
    `🧰 *Gear*`,
    gearLine,
    ``,
    buffs.length ? `✨ *Active:* ${buffs.join(', ')}` : `✨ *Active:* none`,
    spentPp.length ? `🎯 *Running low:* ${spentPp.map(([id, v]) => `${id} (${v})`).join(', ')}` : '',
    ``,
    cd > 0 ? `⏱️ Cooldown: ${(cd / 1000).toFixed(1)}s` : `⏱️ Ready`,
    blocked ? `🚫 Cannot repeat: ${blocked}` : `🚫 Nothing blocked`,
    ``,
    `_${prefix}pvp atk · ${prefix}pvp sk <name> · ${prefix}pvp def · ${prefix}pvp inv_`,
  ].filter((l) => l !== '').join('\n')
}

/**
 * kitPanel(player, prefix) — the text fallback for the kit view, used when the
 * rendered grid image cannot be produced.
 */
export function kitPanel(player, prefix) {
  const rows = kitContents(player)
  const used = ensureKit(player).length
  const body = rows.length
    ? rows.map((r) => `${r.count > 1 ? `*${r.count}×* ` : '     '}${r.item?.name ?? r.id}`).join('\n')
    : `_empty — nothing packed_`
  return [
    `🎒 *PVP KIT*  ·  ${used}/${PVP_KIT_SLOTS} slots`,
    ``,
    body,
    ``,
    `_This is a separate store from your main inventory._`,
    `_Pack it outside a duel:_ \`${prefix}pvp stock <item> [amount]\``,
  ].join('\n')
}
