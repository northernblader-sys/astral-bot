/**
 * p-use.js — Pokémon overhaul §4.1: consume a data/pokemon-items.json
 * "battle" item on one of your Pokémon, mid-battle or out of battle.
 *
 * Named `.p-use` (short form) rather than `.pokemon useitem` — every other
 * Pokémon command in this overhaul has a long canonical form buried under
 * `.pokemon <subcommand>`, but this one gets called constantly mid-battle
 * under a 60s turn clock, so it gets its own short top-level command,
 * same reasoning as why `.move` (not `.pokemon move`) exists standalone.
 *
 * Mirrors plugins/use.js's item-consumption pattern (find in inventory →
 * validate → applyItemEffect via lib/effects.js → splice one copy →
 * updatePlayer) but targets an owned Pokémon (mon.currentHp/mon.maxHp/
 * mon.activeEffects) instead of the player object itself. Only items from
 * data/pokemon-items.json with category: "battle" are usable here —
 * cosmetic items are never "used", they're purely display (see
 * .p-poke info / plugins/pokeshop.js).
 *
 * Usage:
 *   .p-use <item> <mon>   — consume a battle item on that Pokémon
 *
 * <mon> resolution: same query the rest of the Pokémon system already uses
 * (lib/pokemon-engine.js's findOwnedPokemon — exact id, nickname, or name/
 * partial-name match).
 */
import { config } from '../config.js'
import { createRequire } from 'module'
import { updatePlayer } from '../lib/player-repo.js'
import { findOwnedPokemon } from '../lib/pokemon-engine.js'
import { applyEffect, addStatusEffect } from '../lib/effects.js'

const require = createRequire(import.meta.url)
const pokemonItems = require('../data/pokemon-items.json')

const pokeItemMap = new Map(pokemonItems.map((i) => [i.id, i]))

// Effect types lib/effects.js treats as instant (handled by applyEffect) —
// same split plugins/use.js already uses for the general item system.
const INSTANT_TYPES = new Set(['heal', 'cure'])

/**
 * Thin shim so lib/effects.js's entity-agnostic heal/regen/shield handlers
 * (which read/write entity.hp / entity.maxHp) work against an owned
 * Pokémon's actual field names (currentHp / maxHp). Only 'hp' is ever a
 * valid `stat` for a Pokémon item's heal effect — there's no MP on a
 * Pokémon — so this only needs to shim that one field, applied both ways
 * around the call.
 */
function applyItemEffectToMon(mon, eff) {
  if (eff.stat === 'hp') {
    const shim = { hp: mon.currentHp, maxHp: mon.maxHp, activeEffects: mon.activeEffects ?? [] }
    const line = INSTANT_TYPES.has(eff.type) ? applyEffect(shim, eff) : (addStatusEffect(shim, eff), null)
    mon.currentHp = shim.hp
    mon.activeEffects = shim.activeEffects
    return line ?? `✨ ${eff.type} effect applied.`
  }

  // Non-hp effects (strengthen/cure targeting non-hp stats/status types)
  // only ever touch activeEffects, which already exists directly on mon —
  // no field-name shim needed.
  if (INSTANT_TYPES.has(eff.type)) {
    return applyEffect(mon, eff)
  }
  addStatusEffect(mon, eff)
  return `✨ ${eff.type === 'strengthen' ? `${eff.stat?.toUpperCase()} rose` : eff.type} for ${eff.duration} turn(s).`
}

/** Find a Pokémon-shop item in the player's inventory by exact id or partial name (battle items only). */
function findBattleItemInInventory(inventory, query) {
  const q = String(query ?? '').toLowerCase().trim()
  const withPrefix = q.startsWith('poke_') ? q : `poke_${q.replace(/\s+/g, '_')}`

  for (const candidate of [q, withPrefix]) {
    if (inventory.includes(candidate) && pokeItemMap.get(candidate)?.category === 'battle') {
      return candidate
    }
  }
  for (const id of inventory) {
    const item = pokeItemMap.get(id)
    if (item?.category === 'battle' && item.name.toLowerCase().includes(q)) return id
  }
  return null
}

export default {
  name: 'p-use',
  aliases: ['puse', 'pokeuse'],
  category: 'pokemon',
  requiresPlayer: true,
  description: `${config.prefix}p-use <item> <mon> — use a Pokémon item (potion, X Attack, etc.) on one of your Pokémon`,
  subcommands: [
    { cmd: '<item> <mon>', desc: 'consume a battle item on that Pokémon' },
  ],

  async run(ctx) {
    const { player, args, db, reply } = ctx
    const pr = config.prefix

    if (args.length < 2) {
      return reply(`❓ Usage: *${pr}p-use <item> <mon>*\n_e.g._ *${pr}p-use oran berry pikachu*`)
    }

    // Item name can itself be multiple words ("super potion") and so can the
    // Pokémon query — same ambiguity plugins/pokemon.js's rename command
    // already has to deal with. Resolve by trying the mon match against the
    // trailing token(s), same convention pokeshop.js's buy/sell use for its
    // own <item> [qty] parsing: try progressively shorter item spans.
    const full = args.join(' ')
    let itemId = null
    let monQuery = null

    for (let split = args.length - 1; split >= 1; split--) {
      const itemCandidate = args.slice(0, split).join(' ')
      const monCandidate  = args.slice(split).join(' ')
      const found = findBattleItemInInventory(player.inventory ?? [], itemCandidate)
      if (found) {
        itemId = found
        monQuery = monCandidate
        break
      }
    }

    if (!itemId) {
      return reply(
        `❌ Couldn't find a battle item matching that in *"${full}"*.\n` +
        `Check *${pr}inventory* or buy one with *${pr}p-shop battle*.`,
      )
    }

    const item = pokeItemMap.get(itemId)
    const mon = findOwnedPokemon(player, monQuery)
    if (!mon) {
      return reply(`🚫 You don't own a Pokémon matching *"${monQuery}"*.`)
    }

    let resultLines = []
    let outcome = null

    await updatePlayer(db, player.id, (p) => {
      const inv = p.inventory ?? []
      const idx = inv.indexOf(itemId)
      if (idx === -1) { outcome = { ok: false, reason: 'gone' }; return }

      const freshMon = findOwnedPokemon(p, monQuery)
      if (!freshMon) { outcome = { ok: false, reason: 'no_mon' }; return }

      const effectList = Array.isArray(item.effect) ? item.effect : [item.effect]
      for (const eff of effectList) {
        resultLines.push(applyItemEffectToMon(freshMon, eff))
      }

      inv.splice(idx, 1)
      p.inventory = inv
      outcome = { ok: true, mon: freshMon }
    })

    if (!outcome?.ok) {
      if (outcome?.reason === 'no_mon') return reply(`🚫 You don't own a Pokémon matching *"${monQuery}"*.`)
      return reply(`❌ *${item.name}* is no longer in your inventory — please try again.`)
    }

    return reply(
      `✨ You used *${item.name}* on *${outcome.mon.nickname ?? outcome.mon.name}*!\n` +
      resultLines.join('\n'),
    )
  },
}
