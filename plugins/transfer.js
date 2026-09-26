/**
 * transfer.js — now delegates to lib/astralpay.js / lib/transfer-guards.js.
 * .send solars → sendSolars() in lib/astralpay.js (same logic as .pay)
 * .send item   → unchanged, handled locally below
 * Guards (resolveTargetJid, MIN_LEVEL, cooldown) from lib/transfer-guards.js.
 *
 * DO NOT DELETE — kept so .send / .give / .transfer muscle-memory commands
 * keep working exactly as before. See plugins/astralpay.js for the hub.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import { allItems, characters, characterMap } from '../lib/game-data.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { sendSolars } from '../lib/astralpay.js'
import { rarityRank } from '../lib/rarity.js'
import {
  MIN_LEVEL,
  TRANSFER_COOLDOWN_MS,
  MAX_SOLARS_PER_TRANSFER,
  resolveTargetJid,
  runTransferGuards,
} from '../lib/transfer-guards.js'

// ── Character transfer ──────────────────────────────────────────────────
// Characters are one-per-account (plugins/character.js, every *-spin.js:
// `if (!ownedCharacters.includes(id)) push(id)`), never stacked like items.
// So "send character" isn't a quantity move like items/solars, it's a
// full handoff: the sender loses it entirely, the recipient gains it,
// guarded so neither side can end up in a state normal play can't reach.
//
// Capped at uncommon and below (rarityRank <= 2, see lib/rarity.js) on
// purpose: paid/rare pulls (epic, legendary, mythic, boundless) are the
// bot's monetization and reward layer. An uncapped character-send would
// let one account fund pulls, then gift every high-rarity hit to a second
// (or a paying customer's) account, laundering RNG the same way open gem
// transfers would launder currency — the exact risk transfer.js already
// blocks gems for. Uncommon and below are starter/low-value pulls, so
// gifting them costs the sender something (their only copy) without
// creating a duplication or resale path for anything worth protecting.
const MAX_SEND_RARITY_RANK = rarityRank('uncommon')

function findCharacterDef(query) {
  const q = query.toLowerCase().trim()
  return characters.find(c => c.id.toLowerCase() === q) ??
    characters.find(c => c.name.toLowerCase() === q) ??
    characters.find(c => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
}

async function sendCharacter(ctx, targetJid, query) {
  const p = config.prefix
  if (!query) {
    return ctx.reply(`❓ Usage: *${p}send character <@player> <character name>*\nExample: *${p}send character @friend willow*`)
  }

  let outcome = null // { ok:false } | { ok:true, charDef }

  // Same two-phase shape as sendItem above: validate + remove from sender
  // in one top-level updatePlayer call, credit the recipient in a second,
  // never nested — see the deadlock note on sendItem for why.
  await updatePlayer(ctx.db, ctx.from, async sender => {
    const guard = await runTransferGuards(ctx, sender, targetJid)
    if (guard) { outcome = { ok: false }; return sender }

    const charDef = findCharacterDef(query)
    if (!charDef) {
      await ctx.reply(`❌ No character matching *"${query}"* found.`)
      outcome = { ok: false }
      return sender
    }

    const owned = sender.ownedCharacters ?? []
    if (!owned.includes(charDef.id)) {
      await ctx.reply(`❌ You don't own *${charDef.name}*.`)
      outcome = { ok: false }
      return sender
    }

    if (rarityRank(charDef.rarity) > MAX_SEND_RARITY_RANK) {
      await ctx.reply(
        `❌ *${charDef.name}* is too rare to send (${charDef.rarity}). ` +
        `Only uncommon and below can be transferred between players.`
      )
      outcome = { ok: false }
      return sender
    }

    const recipientNow = getPlayer(ctx.db, targetJid)
    if ((recipientNow?.ownedCharacters ?? []).includes(charDef.id)) {
      await ctx.reply(`❌ They already own *${charDef.name}*.`)
      outcome = { ok: false }
      return sender
    }

    if (sender.equippedCharacter === charDef.id) sender.equippedCharacter = null
    sender.ownedCharacters = owned.filter(id => id !== charDef.id)
    sender.lastTransferAt = Date.now()

    outcome = { ok: true, charDef }
    return sender
  })

  if (!outcome?.ok) return

  const { charDef } = outcome

  await updatePlayer(ctx.db, targetJid, async recipient => {
    recipient.ownedCharacters = recipient.ownedCharacters ?? []
    if (!recipient.ownedCharacters.includes(charDef.id)) recipient.ownedCharacters.push(charDef.id)
    return recipient
  })

  const recipientName = getPlayer(ctx.db, targetJid)?.name ?? 'player'
  return ctx.reply(
    `🎭 *Sent ${charDef.name}* to *${recipientName}!*\n` +
    `_You no longer own this character._`
  )
}

function findItemDef(query) {
  const q = query.toLowerCase().trim()
  return allItems.find(i => i.id.toLowerCase() === q) ??
    allItems.find(i => i.name.toLowerCase() === q) ??
    allItems.find(i => i.id.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
}

async function sendItem(ctx, targetJid, query, qtyRaw) {
  const p = config.prefix
  if (!query) {
    return ctx.reply(`❓ Usage: *${p}send item <@player> <item name> [qty]*\nExample: *${p}send item @friend iron_ore 3*`)
  }
  const qty = Math.max(1, parseInt(qtyRaw, 10) || 1)

  // ── Phase 1: sender-side validation + deduction (top-level call). Never
  // call updatePlayer() again from inside this mutator — the shared write
  // queue in lib/player-repo.js serializes ALL updatePlayer calls onto one
  // chain, so a nested call ends up queued behind the very call it's
  // nested inside, deadlocking until the 20s safety timeout. ─────────────
  let outcome = null // { ok:false } | { ok:true, itemDef, owned }

  await updatePlayer(ctx.db, ctx.from, async sender => {
    const guard = await runTransferGuards(ctx, sender, targetJid)
    if (guard) { outcome = { ok: false }; return sender }

    const inv = sender.inventory ?? []
    const itemDef = findItemDef(query)
    if (!itemDef) {
      await ctx.reply(`❌ No item matching *"${query}"* found.`)
      outcome = { ok: false }
      return sender
    }

    const owned = inv.filter(id => id === itemDef.id).length
    if (owned < qty) {
      await ctx.reply(`❌ You only have *${owned}x ${itemDef.name}*, can't send *${qty}*.`)
      outcome = { ok: false }
      return sender
    }

    const recipientNow = getPlayer(ctx.db, targetJid)
    if (!hasInventoryRoom(recipientNow, qty)) {
      await ctx.reply(inventoryFullMessage(recipientNow.name ?? 'They'))
      outcome = { ok: false }
      return sender
    }

    // Remove items from sender
    let removed = 0
    sender.inventory = inv.filter(id => {
      if (id === itemDef.id && removed < qty) { removed++; return false }
      return true
    })
    sender.lastTransferAt = Date.now()

    outcome = { ok: true, itemDef, owned }
    return sender
  })

  if (!outcome?.ok) return

  const { itemDef, owned } = outcome

  // ── Phase 2: credit the recipient — separate top-level call, run only
  // after the sender's write has fully released the queue. ──────────────
  await updatePlayer(ctx.db, targetJid, async recipient => {
    for (let i = 0; i < qty; i++) (recipient.inventory = recipient.inventory ?? []).push(itemDef.id)
    return recipient
  })

  const recipientName = getPlayer(ctx.db, targetJid)?.name ?? 'player'
  return ctx.reply(
    `🎒 *Sent ${qty}x ${itemDef.name}* to *${recipientName}!*\n` +
    `_You have ${owned - qty}x ${itemDef.name} remaining._`
  )
}

export default {
  name: 'send',
  aliases: ['give', 'transfer'],
  category: 'economy',
  requiresPlayer: true,
  description: 'Send solars, items, or low-rarity characters to another player',

  async run(ctx) {
    const p = config.prefix
    const [type, targetRaw, ...rest] = ctx.args

    if (!type) {
      return ctx.reply(
        `💸 *TRANSFERS*\n\n` +
        `*${p}send solars <target> <amount>*\n` +
        `_Example: ${p}send solars @friend 100_\n\n` +
        `*${p}send item <target> <item> [qty]*\n` +
        `_Example: ${p}send item @friend iron_ore 3_\n\n` +
        `*${p}send character <target> <character>*\n` +
        `_Example: ${p}send character @friend willow_\n` +
        `_Uncommon and below only. You lose it, they gain it._\n\n` +
        `_Target can be a reply, an @mention, or a phone number._\n\n` +
        `⚠️ Gems can't be transferred — they're account-bound.\n` +
        `📋 Level ${MIN_LEVEL}+ · 5 min cooldown · Max ☀️${MAX_SOLARS_PER_TRANSFER.toLocaleString()} per transfer.\n\n` +
        `_Also try: *${p}pay* · *${p}tip* · *${p}apay* (AstralPay hub)_`
      )
    }

    const targetJid = resolveTargetJid(ctx, targetRaw)
    const sub = type.toLowerCase()

    if (sub === 'solars' || sub === 'solar' || sub === 'gold' || sub === '☀️') {
      return sendSolars(ctx, targetJid, rest[0], rest.slice(1).join(' ') || undefined)
    }
    if (sub === 'item' || sub === 'items') {
      return sendItem(ctx, targetJid, rest[0], rest[1])
    }
    if (sub === 'character' || sub === 'char') {
      return sendCharacter(ctx, targetJid, rest.join(' '))
    }
    if (sub === 'gems' || sub === 'gem' || sub === '💎') {
      return ctx.reply(`❌ Gems cannot be transferred — they're a bound, non-tradeable currency.`)
    }

    return ctx.reply(`❓ Unknown transfer type. Use *${p}send solars ...*, *${p}send item ...*, or *${p}send character ...*`)
  },
}
