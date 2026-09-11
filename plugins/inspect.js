/**
 * <prefix>inspect <item id or partial name>
 * Shows full details for an item the player owns.
 * Only items in the player's inventory can be inspected.
 */

import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { rarityBadge } from '../lib/rarity.js'
import { sendImage } from '../lib/image.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

const STAT_LABEL = {
  str: 'STR', agi: 'AGI', int: 'INT', def: 'DEF', lck: 'LCK',
  maxHp: 'Max HP', maxMp: 'Max MP',
}

/**
 * Defensive effect formatter — handles every effect shape lib/effects.js supports
 * so that future consumables with non-heal shapes don't throw on display.
 */
function formatEffectLine(effect) {
  if (!effect || !effect.type) return '⚗️ *Effect:* (unknown)'

  const stat     = effect.stat     ?? '?'
  const amount   = effect.amount   ?? 0
  const duration = effect.duration ?? 0
  const value    = effect.value    ?? 0

  switch (effect.type) {
    case 'heal':
      return `⚗️ *Effect:* ❤️ Restores ${amount} ${String(stat).toUpperCase()}`

    case 'regen': {
      const durPart = duration ? ` for ${duration} turn(s)` : ''
      return `⚗️ *Effect:* 💚 Regenerate ${amount} ${String(stat).toUpperCase()} per turn${durPart}`
    }

    case 'burn':
      return `⚗️ *Effect:* 🔥 ${amount} damage per turn for ${duration} turn(s)`

    case 'poison':
      return `⚗️ *Effect:* 🟢 ${amount} damage per turn for ${duration} turn(s)`

    case 'freeze':
      return `⚗️ *Effect:* ❄️ Target cannot act for ${duration} turn(s)`

    case 'stun':
      return `⚗️ *Effect:* 💫 Target cannot act for ${duration} turn(s)`

    case 'shield':
      return `⚗️ *Effect:* 🛡️ Absorbs up to ${amount} damage for ${duration} turn(s)`

    case 'weaken':
      return `⚗️ *Effect:* ⬇️ ${String(stat).toUpperCase()} −${value} for ${duration} turn(s)`

    case 'strengthen':
      return `⚗️ *Effect:* ⬆️ ${String(stat).toUpperCase()} +${value} for ${duration} turn(s)`

    case 'blind':
      return `⚗️ *Effect:* 🌑 Accuracy reduced for ${duration} turn(s)`

    default:
      // Unknown future effect type — show type name without assuming any fields.
      return `⚗️ *Effect:* ${effect.type}`
  }
}

export default {
  name: 'inspect',
  aliases: ['item', 'iteminfo'],
  category: 'inventory',
  description: `${config.prefix}inspect <item> — view details of an item in your inventory.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player, args } = ctx

    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${config.prefix}inspect <item id or name>*`)
    }

    const query = args.join(' ').toLowerCase()
    const { inventory = [] } = player

    // Find a matching item id the player actually owns.
    // Priority: exact id match, then partial name match.
    let foundId = null

    // Exact id match first.
    if (inventory.includes(query)) {
      foundId = query
    }

    // Partial name match against items the player owns.
    if (!foundId) {
      const ownedUnique = [...new Set(inventory)]
      for (const id of ownedUnique) {
        const item = itemMap[id]
        if (item && item.name.toLowerCase().includes(query)) {
          foundId = id
          break
        }
      }
    }

    if (!foundId) {
      return ctx.reply(
        `❌ You don't have *"${args.join(' ')}"* in your inventory.\n` +
        `Use *${config.prefix}inventory* to see what you're carrying.`,
      )
    }

    const item = itemMap[foundId]
    if (!item) {
      return ctx.reply(`❌ Item data for *${foundId}* not found. This is a bug — please report it.`)
    }

    // Build stat bonus lines (skip zero values).
    const bonusLines = Object.entries(item.statBonuses ?? {})
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `  ${STAT_LABEL[k] ?? k}: ${v > 0 ? '+' : ''}${v}`)

    // Build effect line for consumables.
    const effectLine = item.effect ? `\n${formatEffectLine(item.effect)}` : ''

    const lines = [
      `📦 *${item.name}*`,
      `${rarityBadge(item.rarity)}  •  ${item.type.charAt(0).toUpperCase() + item.type.slice(1)}`,
      item.levelReq > 1 ? `🔒 Requires level ${item.levelReq}` : `🔓 No level requirement`,
      '',
      item.description,
    ]

    if (bonusLines.length > 0) {
      lines.push('', '📊 *Stat Bonuses:*', ...bonusLines)
    }

    if (effectLine) lines.push(effectLine)

    if (item.auctionOnly) lines.push(`\n🏛️ _Auction House exclusive — cannot be bought, sold, or crafted in the shop._`)

    lines.push(`\n💰 Sell price: ${item.sellPrice} solars`)

    return sendImage(ctx, item.image || `https://play.astral.qzz.io/assets/items/${item.id}.jpg`,
      `*${item.name}*\n${rarityBadge(item.rarity)} ${item.type.charAt(0).toUpperCase() + item.type.slice(1)}${item.levelReq > 1 ? ` · Lv.${item.levelReq}` : ''}\n\n${lines.join('\n')}`)
  },
}
