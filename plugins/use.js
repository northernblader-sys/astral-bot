/**
 * <prefix>use <item id or partial name>
 * Consumes a consumable item from inventory, applying its effect.
 *
 * Effect dispatch is handled by lib/effects.js: applyEffect() for instant
 * effects (heal/cure), addStatusEffect() for duration-based effects (regen,
 * shield, burn, poison, weaken, strengthen, freeze, stun, blind) — see
 * applyItemEffect() below. The updatePlayer race-guard pattern is preserved
 * exactly as before.
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { applyEffect, addStatusEffect } from '../lib/effects.js'
import { buildWillowReadout } from '../lib/character-abilities.js'
import { repairItem, repairArmor } from '../lib/durability.js'
import { refillAllPp } from '../lib/pvp-wager.js'

// Effect types lib/effects.js treats as instant (handled by applyEffect).
// Everything else is duration-based and must go through addStatusEffect.
const INSTANT_TYPES = new Set(['heal', 'cure'])

const DURATION_LABEL = {
  regen:      (eff) => `💚 Regen: +${eff.amount} ${eff.stat?.toUpperCase() ?? 'HP'} for ${eff.duration} turn(s).`,
  shield:     (eff) => `🛡️ Shield: absorbs up to ${eff.amount} damage for ${eff.duration} turn(s).`,
  strengthen: (eff) => `✨ Strengthen: +${eff.value ?? eff.amount} ${eff.stat?.toUpperCase() ?? ''} for ${eff.duration} turn(s).`,
  weaken:     (eff) => `💔 Weaken applied for ${eff.duration} turn(s).`,
  burn:       (eff) => `🔥 Burn applied for ${eff.duration} turn(s).`,
  poison:     (eff) => `☠️ Poison applied for ${eff.duration} turn(s).`,
  freeze:     (eff) => `❄️ Freeze applied for ${eff.duration} turn(s).`,
  stun:       (eff) => `💫 Stun applied for ${eff.duration} turn(s).`,
  blind:      (eff) => `🌑 Blind applied for ${eff.duration} turn(s).`,
  // Hit-counted, not turn-counted: these burn down per hit landed / taken, so
  // saying "for N turns" would be flatly wrong. See DURATION_INITIALIZERS in
  // lib/effects.js — they are the two entries there with meta.hitCounted.
  warcry:     (eff) => `🔥 Warcry: +${eff.percent}% damage on your next ${eff.hits} landed hit(s).`,
  ironskin:   (eff) => `🪨 Ironskin: -${eff.percent}% damage from your next ${eff.hits} hit(s) taken.`,
}

/** Apply a single item effect, routing to the correct effects.js entry point. */
function applyItemEffect(entity, eff) {
  if (eff.type === 'river_charm') {
    entity.activeBoosts = entity.activeBoosts ?? {}
    entity.activeBoosts.riverCharm = {
      percent: Math.max(0, Number(eff.percent) || 15),
      fightsRemaining: Math.max(1, Number(eff.fights) || 5),
    }
    return `🌊 River Charm active: +${entity.activeBoosts.riverCharm.percent}% Fame/Solars for ${entity.activeBoosts.riverCharm.fightsRemaining} victories.`
  }
  if (eff.type === 'prayer_bead') {
    if (entity.equippedCharacter !== 'mei' || !entity.inBattle || !entity.battleState) {
      return `⚠️ Mei's Prayer Bead only works while Mei is equipped and you are in battle.`
    }
    entity.battleState.finalFormThreshold = Math.max(0.7, Number(eff.finalFormThreshold) || 0.8)
    return `🌸 Mei's Final Form can now awaken at ${Math.round(entity.battleState.finalFormThreshold * 100)}% HP this battle.`
  }
  if (eff.type === 'sightline_lens') {
    if (!entity.inBattle || !entity.battleState?.enemy) return `⚠️ Use the Sightline Lens during a fight.`
    return buildWillowReadout(entity, entity.battleState.enemy)
  }
  // ── mend (Honed Whetstone / Cracked Warplate) ──────────────────────────
  // Repairs gear, so it is neither an instant stat effect nor a status: it goes
  // through lib/durability.js's own primitives rather than effects.js, which has
  // no concept of durability at all. Both paths are shared with the wager kit's
  // `.pvp mnd` (lib/pvp-wager.js's mendFromKit), so the numbers cannot drift.
  if (eff.type === 'mend') {
    const wantWeapon = String(eff.target ?? 'weapon') === 'weapon'
    const pct = Math.max(1, Number(eff.percent) || 50)
    const res = wantWeapon ? repairItem(entity, 'weapon', pct) : repairArmor(entity, pct)
    if (!res.repaired) {
      if (res.reason === 'empty')     return `⚠️ Nothing equipped in that slot to mend.`
      if (res.reason === 'untracked') return `⚠️ *${res.itemName}* does not wear down, so there is nothing to mend.`
      if (res.reason === 'full')      return `✅ *${res.itemName}* is already at full durability.`
      return `⚠️ Nothing to mend right now.`
    }
    return `🔧 *${res.itemName}* +${res.restored} durability _(${res.remaining}/${res.max})_`
  }

  // ── restore_pp (Focus Vial) ────────────────────────────────────────────
  // PP is a wager-duel resource and lives on battleState.pp, so outside one there
  // is no ledger to clear. Refuse rather than silently consuming the vial.
  if (eff.type === 'restore_pp') {
    if (!entity.inBattle || !entity.battleState?.wager) {
      return `⚠️ A Focus Vial only does something in a wager duel, where skills have PP.`
    }
    const spent = refillAllPp(entity.battleState)
    return spent
      ? `🌀 PP restored on *${spent}* spent skill(s).`
      : `🌀 Nothing was depleted, but the head clears anyway.`
  }

  // ── prevent_death (Totem of Undying / Phoenix Clasp) ───────────────────
  // Passive while equipped, checked by lib/combat-handlers.js's
  // checkTotemRevive() at the moment of a lethal hit. Drinking it does nothing.
  if (eff.type === 'prevent_death') {
    return `⚠️ That works while *equipped*, not when used. Put it in your off hand with *${config.prefix}equip*.`
  }

  if (INSTANT_TYPES.has(eff.type)) {
    return applyEffect(entity, eff)
  }
  addStatusEffect(entity, eff)
  const label = DURATION_LABEL[eff.type]
  return label ? label(eff) : `✨ ${eff.type} effect applied.`
}

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

/** Find first matching item id in the player's inventory (exact id or partial name). */
function findInInventory(inventory, query) {
  const q = query.toLowerCase()
  if (inventory.includes(q)) return q
  for (const id of inventory) {
    const item = itemMap[id]
    if (item && item.name.toLowerCase().includes(q)) return id
  }
  return null
}

export default {
  name: 'use',
  aliases: ['consume', 'drink'],
  category: 'inventory',
  description: `${config.prefix}use <item> — consume a potion or consumable item.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player, args, db } = ctx

    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${config.prefix}use <item id or name>*`)
    }

    const query = args.join(' ')

    const foundId = findInInventory(player.inventory ?? [], query)

    if (!foundId) {
      return ctx.reply(
        `❌ *"${query}"* not found in your inventory.\n` +
        `Use *${config.prefix}inventory* to see what you're carrying.`,
      )
    }

    const item = itemMap[foundId]
    if (!item) {
      return ctx.reply(`❌ Item data for *${foundId}* is missing. Please report this bug.`)
    }

    if (item.type !== 'consumable') {
      return ctx.reply(
        `❌ *${item.name}* can't be consumed.\n` +
        `Use *${config.prefix}equip ${foundId}* to equip it instead.`,
      )
    }

    if (!item.effect) {
      return ctx.reply(`❌ *${item.name}* has no effect defined. This is a bug — please report it.`)
    }

    let resultLines = []
    let raceAborted = false
    let refusal = ''

    await updatePlayer(db, player.id, (p) => {
      // Re-validate against the fresh store before mutating.
      const store = p.inventory ?? []
      const idx = store.indexOf(foundId)
      if (idx === -1) {
        raceAborted = true
        return // item no longer present, abort without mutation
      }

       // Apply the effect(s) via the shared effects engine (mutates p in place).
      // item.effect can be a single effect object or an array of them.
      const effectList = Array.isArray(item.effect) ? item.effect : [item.effect]
       for (const eff of effectList) {
         const result = applyItemEffect(p, eff)
         // A failed contextual effect should not consume the item.
         if (result.startsWith('⚠️')) {
           raceAborted = true
           refusal = result
           return
         }
         resultLines.push(result)
      }

      // Remove one instance of the consumed item.
      store.splice(idx, 1)
      p.inventory = store
    })

    if (raceAborted) {
      return ctx.reply(
        refusal ||
        `❌ *${item.name}* is no longer available. Your inventory state changed, please try again.`,
      )
    }

    return ctx.reply(
      `✨ You used *${item.name}*!\n` +
      resultLines.join('\n'),
    )
  },
}
