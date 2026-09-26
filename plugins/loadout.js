/**
 * plugins/loadout.js — Save, list, view, and instantly switch gear and skill loadouts.
 *
 * Usage:
 *   .loadout save <name>      — save currently equipped items and active abilities/skills
 *   .loadout equip <name>     — equip saved loadout (or .loadout load <name>)
 *   .loadout list             — view all your saved loadouts
 *   .loadout view <name>      — inspect gear inside a specific loadout
 *   .loadout delete <name>    — remove a saved loadout
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import { initDurability, clearDurability } from '../lib/durability.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))
const VALID_SLOTS = ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic']

export default {
  name: 'loadout',
  aliases: ['loadouts', 'preset', 'presets'],
  category: 'inventory',
  requiresPlayer: true,
  description: 'Save and swap gear and ability presets (.loadout save/equip/list)',
  subcommands: [
    { cmd: 'save <name>', desc: 'save your current gear as a loadout' },
    { cmd: 'equip <name>', desc: 'switch to a saved loadout' },
    { cmd: 'list', desc: 'view all your saved loadouts' },
    { cmd: 'view <name>', desc: 'inspect items in a saved loadout' },
    { cmd: 'delete <name>', desc: 'delete a saved loadout' },
  ],

  async run(ctx) {
    const p = config.prefix
    const sub = ctx.args[0]?.toLowerCase()
    const nameArg = ctx.args.slice(1).join(' ').trim().toLowerCase()

    if (!sub || sub === 'list') {
      return listLoadouts(ctx)
    }
    if (sub === 'save') {
      return saveLoadout(ctx, nameArg)
    }
    if (sub === 'equip' || sub === 'load' || sub === 'use') {
      return equipLoadout(ctx, nameArg)
    }
    if (sub === 'view' || sub === 'info') {
      return viewLoadout(ctx, nameArg)
    }
    if (sub === 'delete' || sub === 'del' || sub === 'rm') {
      return deleteLoadout(ctx, nameArg)
    }

    return ctx.reply(
      `❓ *Loadout Management*\n\n` +
      `*${p}loadout save <name>* — save your current gear setup\n` +
      `*${p}loadout equip <name>* — quickly switch into that setup\n` +
      `*${p}loadout list* — view your saved presets\n` +
      `*${p}loadout view <name>* — inspect items inside a preset\n` +
      `*${p}loadout delete <name>* — remove a preset\n\n` +
      `⚔️ *Guild War Preset 5:* save your war gear with *${p}loadout save war* ` +
      `_(or_ *${p}loadout save 5*_) — it loads on top of the bot's war kit, slot by slot, ` +
      `every pairing of a Guild War, and lifts the moment the duel ends. ` +
      `_See the five kit tiers with *${p}guild war kits*._`,
    )
  },
}

function listLoadouts(ctx) {
  const p = config.prefix
  const loadouts = ctx.player.loadouts || {}
  const names = Object.keys(loadouts)

  if (!names.length) {
    return ctx.reply(
      `🎒 *No saved loadouts yet.*\n\n` +
      `Equip your favorite gear and type:\n` +
      `> *${p}loadout save pvp*\n` +
      `> *${p}loadout save boss*\n` +
      `> *${p}loadout save war*  ⚔️ _your Guild War Preset 5 — overrides the bot kit slot by slot_`,
    )
  }

  const list = names.map(name => {
    const l = loadouts[name]
    const count = Object.values(l.equipped || {}).filter(Boolean).length
    const isWar = ['war', '5', 'preset 5', 'preset5'].includes(name)
    return `• *${name}* — ${count} gear items equipped${isWar ? '  ⚔️ _war preset (Preset 5)_' : ''}`
  }).join('\n')

  return ctx.reply(
    `🎒 *YOUR SAVED LOADOUTS*\n\n${list}\n\n` +
    `Equip one with *${p}loadout equip <name>*\n` +
    `Inspect with *${p}loadout view <name>*`,
  )
}

async function saveLoadout(ctx, name) {
  const p = config.prefix
  if (!name) {
    return ctx.reply(`❌ Specify a name for this loadout.\nUsage: *${p}loadout save <name>* (e.g. pvp, boss, speed)`)
  }
  if (name.length > 20) {
    return ctx.reply(`❌ Loadout name must be 20 characters or fewer.`)
  }

  const currentEq = { ...(ctx.player.equipped || {}) }
  const hasItems = Object.values(currentEq).some(Boolean)
  if (!hasItems) {
    return ctx.reply(`⚠️ You don't have any gear equipped right now! Equip items with *${p}equip* first.`)
  }

  await updatePlayer(ctx.db, ctx.player.id, player => {
    if (!player.loadouts) player.loadouts = {}
    player.loadouts[name] = {
      name,
      equipped: currentEq,
      savedAt: Date.now(),
    }
  })

  return ctx.reply(`✅ Loadout *${name}* saved successfully! Equip it anytime with *${p}loadout equip ${name}*.`)
}

async function viewLoadout(ctx, name) {
  const p = config.prefix
  if (!name) return ctx.reply(`Usage: *${p}loadout view <name>*`)
  const loadouts = ctx.player.loadouts || {}
  const l = loadouts[name]
  if (!l) return ctx.reply(`❌ No loadout named *${name}* found.`)

  const eqLines = VALID_SLOTS.map(slot => {
    const id = l.equipped?.[slot]
    const item = id ? itemMap[id] : null
    return `  • *${slot}*: ${item ? item.name : '— none —'}`
  }).join('\n')

  return ctx.reply(`🎒 *LOADOUT: ${name.toUpperCase()}*\n\n${eqLines}\n\n*${p}loadout equip ${name}* to equip.`)
}

async function deleteLoadout(ctx, name) {
  const p = config.prefix
  if (!name) return ctx.reply(`Usage: *${p}loadout delete <name>*`)
  const loadouts = ctx.player.loadouts || {}
  if (!loadouts[name]) return ctx.reply(`❌ No loadout named *${name}* found.`)

  await updatePlayer(ctx.db, ctx.player.id, player => {
    if (player.loadouts) delete player.loadouts[name]
  })

  return ctx.reply(`🗑️ Loadout *${name}* has been deleted.`)
}

async function equipLoadout(ctx, name) {
  const p = config.prefix
  if (!name) return ctx.reply(`Usage: *${p}loadout equip <name>*`)

  const loadouts = ctx.player.loadouts || {}
  const targetLoadout = loadouts[name]
  if (!targetLoadout) {
    return ctx.reply(`❌ No loadout named *${name}* found. Check *${p}loadout list*.`)
  }

  let equippedCount = 0
  let missingItems = []

  await updatePlayer(ctx.db, ctx.player.id, player => {
    const inv = player.inventory ?? []
    const eq = player.equipped ?? (player.equipped = {})

    // First: unequip all currently equipped valid slots back to inventory
    for (const slot of VALID_SLOTS) {
      const curId = eq[slot]
      if (curId) {
        const item = itemMap[curId]
        if (item) applyEquipmentBonus(player, item, -1)
        inv.push(curId)
        eq[slot] = null
        clearDurability(player, slot)
      }
    }

    // Second: equip desired items from inventory
    const targetEq = targetLoadout.equipped || {}
    for (const slot of VALID_SLOTS) {
      const wantId = targetEq[slot]
      if (!wantId) continue

      const invIndex = inv.indexOf(wantId)
      if (invIndex !== -1) {
        inv.splice(invIndex, 1)
        eq[slot] = wantId
        const item = itemMap[wantId]
        if (item) {
          applyEquipmentBonus(player, item, 1)
          // The item ID, not the item object: initDurability() looks the id up
          // in its own map (`itemMap[itemId]`) and bails out when it finds
          // nothing, so passing the object meant loadout-equipped gear was
          // never durability-tracked at all — it could not wear out or break,
          // unlike the same piece equipped with .equip (plugins/equip.js).
          initDurability(player, slot, wantId)
        }
        equippedCount += 1
      } else {
        const item = itemMap[wantId]
        missingItems.push(item?.name || wantId)
      }
    }

    player.inventory = inv
    player.equipped = eq
  })

  let msg = `⚡ *Loadout ${name} equipped!* (${equippedCount} item${equippedCount === 1 ? '' : 's'} equipped)`
  if (missingItems.length) {
    msg += `\n⚠️ *Could not find in inventory:* ${missingItems.join(', ')}`
  }
  return ctx.reply(msg)
}
