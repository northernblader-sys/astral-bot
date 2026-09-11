/**
 * armor — show the armor pieces currently equipped (helmet, chestplate,
 * boots, offhand/shield), their rarity, durability, and stat bonuses.
 *
 * Usage: <prefix>armor
 *
 * WHY A SEPARATE COMMAND FROM .profile: profile.js already lists every
 * equip slot (weapon, offhand, helmet, chestplate, boots, relic) in one
 * compact line each as part of the full stat sheet. This is a focused view
 * for "what am I wearing right now" — armor slots only, with the stat
 * bonuses and durability spelled out per piece instead of packed into one
 * line, and a total DEF/HP/MP roll-up at the bottom.
 *
 * "Armor" here means the four defensive slots — helmet, chestplate, boots,
 * offhand (shield). Weapon and relic are excluded on purpose: they're not
 * armor, and .profile already covers them.
 */
import { config } from '../config.js'
import { rarityStars } from '../lib/rarity.js'
import { allItems } from '../lib/game-data.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

// Order matches profile.js's slot ordering (minus weapon/relic).
const ARMOR_SLOTS = ['helmet', 'chestplate', 'boots', 'offhand']

const SLOT_EMOJI = { helmet: '🪖', chestplate: '🧥', boots: '👢', offhand: '🛡️' }
const SLOT_LABEL = { helmet: 'Helmet', chestplate: 'Chestplate', boots: 'Boots', offhand: 'Offhand' }

/** Sum every statBonuses field across the equipped armor pieces. */
function sumBonuses(pieces) {
  const total = {}
  for (const item of pieces) {
    const bonuses = item?.statBonuses ?? {}
    for (const [stat, val] of Object.entries(bonuses)) {
      if (!val) continue
      total[stat] = (total[stat] ?? 0) + val
    }
  }
  return total
}

const STAT_LABEL = { str: 'STR', agi: 'AGI', int: 'INT', def: 'DEF', lck: 'LCK', maxHp: 'Max HP', maxMp: 'Max MP' }

function formatBonuses(bonuses) {
  const parts = Object.entries(bonuses)
    .filter(([, v]) => v)
    .map(([stat, v]) => `${STAT_LABEL[stat] ?? stat} +${v}`)
  return parts.length ? parts.join(', ') : 'no stat bonuses'
}

export default {
  name: 'armor',
  aliases: ['myarmor', 'armour', 'gear'],
  category: 'inventory',
  description: `${config.prefix}armor — show the armor you currently have equipped.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player } = ctx
    const eq = player.equipped ?? {}
    const durability = player.equippedDurability ?? {}

    const equippedPieces = []
    const lines = ARMOR_SLOTS.map(slot => {
      const id = eq[slot]
      const item = id ? itemMap[id] : null

      if (!item) {
        return `${SLOT_EMOJI[slot]} *${SLOT_LABEL[slot]}:* — empty —`
      }

      equippedPieces.push(item)

      const rar = rarityStars(item.rarity)
      const durLine = item.maxDurability
        ? ` (${durability[slot] ?? item.maxDurability}/${item.maxDurability} durability)`
        : ''
      const bonusLine = formatBonuses(item.statBonuses ?? {})

      return (
        `${SLOT_EMOJI[slot]} *${SLOT_LABEL[slot]}:* ${item.name} ${rar}${durLine}\n` +
        `   ${bonusLine}`
      )
    })

    if (equippedPieces.length === 0) {
      return ctx.reply(
        `🧥 *Your Armor*\n\n` +
        `${lines.join('\n')}\n\n` +
        `You're not wearing any armor. Check *${config.prefix}shop* or *${config.prefix}craft* to gear up, ` +
        `then *${config.prefix}equip <item>*.`,
      )
    }

    const totals = sumBonuses(equippedPieces)
    const totalLine = formatBonuses(totals)

    return ctx.reply(
      `🧥 *Your Armor*\n\n` +
      `${lines.join('\n\n')}\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `📊 *Total from armor:* ${totalLine}\n\n` +
      `_Use ${config.prefix}equip <item> to change a piece, ${config.prefix}profile for your full loadout._`,
    )
  },
}
