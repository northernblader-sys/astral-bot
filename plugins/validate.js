/**
 * validate — Data integrity checker.
 * Owner-only command. Also exports runValidation() for boot-time use.
 *
 * Checks (without exception):
 *   1. Every class's startingItems resolve to a real item with a valid slot.
 *   2. Every recipe's materials reference items/materials that actually exist.
 *   3. Every armor/weapon item has a real, non-generic slot (never 'armor').
 *   4. Every recipe material is obtainable (via mine drop or monster drop).
 *
 * Usage: <prefix>validate  (owner only)
 */
import { config } from '../config.js'
import { allItems, classes, recipes, materials, monsters } from '../lib/game-data.js'
import { ALL_BOSSES } from '../bosses/index.js'
import { isOwnerJid } from '../lib/group-helpers.js'

const VALID_SLOTS   = new Set(['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic'])
const itemMap       = Object.fromEntries(allItems.map(i => [i.id, i]))

// Build the set of obtainable material IDs from mine + monster drops
const MINE_IDS = new Set([
  'iron_ore','wood_plank','leather_scrap','silver_ore',
  'mythril_ore','diamond_ore','titanium_ore','celestial_ore',
])
const DROP_IDS = new Set()
for (const m of [...(monsters.regular ?? []), ...(monsters.bosses ?? [])]) {
  for (const d of m.drops ?? []) DROP_IDS.add(d.itemId)
}
// Anime bosses (bosses/*.js, spawned via plugins/dungeon.js's spawnBoss())
// are the actual boss roster used in dungeons — monsters.json's own
// `bosses` array is only a fallback for unmapped slots. Their `drops`
// field is a flat string[] of itemIds (normalized to {itemId,chance} at
// spawn time in dungeon.js), not the {itemId,chance} shape used above.
for (const b of ALL_BOSSES) {
  for (const itemId of b.drops ?? []) DROP_IDS.add(itemId)
}
const OBTAINABLE = new Set([...MINE_IDS, ...DROP_IDS])

/**
 * Run all validation checks. Returns { passed: boolean, errors: string[] }.
 * Does not throw — all failures are collected and returned.
 */
export function runValidation() {
  const errors = []

  // ── 1. Class startingItems ─────────────────────────────────────────────────
  for (const [classId, cls] of Object.entries(classes)) {
    for (const itemId of cls.startingItems ?? []) {
      const item = itemMap[itemId]
      if (!item) {
        errors.push(`[class:${classId}] startingItem "${itemId}" not found in allItems`)
        continue
      }
      // Consumables have slot=null — that's valid.
      if (item.type !== 'consumable' && item.slot !== null) {
        if (!VALID_SLOTS.has(item.slot)) {
          errors.push(`[class:${classId}] startingItem "${itemId}" has invalid slot "${item.slot}"`)
        }
      }
    }
  }

  // ── 2. Recipe materials exist ──────────────────────────────────────────────
  for (const recipe of recipes) {
    for (const { itemId } of recipe.materials ?? []) {
      if (!itemMap[itemId]) {
        errors.push(`[recipe:${recipe.id}] material "${itemId}" not found in allItems`)
      }
    }
    if (!itemMap[recipe.output]) {
      errors.push(`[recipe:${recipe.id}] output "${recipe.output}" not found in allItems`)
    }
  }

  // ── 3. No armor item with generic slot "armor" ─────────────────────────────
  for (const item of allItems) {
    if (item.type === 'armor' && item.slot === 'armor') {
      errors.push(`[item:${item.id}] still has generic slot "armor" — must be helmet/chestplate/boots`)
    }
    if ((item.type === 'armor' || item.type === 'weapon') && item.slot !== null && !VALID_SLOTS.has(item.slot)) {
      errors.push(`[item:${item.id}] has unrecognised slot "${item.slot}"`)
    }
  }

  // ── 4. No dead-end recipes (all materials obtainable via mine or monster drop) ──
  for (const recipe of recipes) {
    for (const { itemId } of recipe.materials ?? []) {
      if (itemMap[itemId] && !OBTAINABLE.has(itemId)) {
        errors.push(`[recipe:${recipe.id}] material "${itemId}" is not obtainable (not in mine pool or monster drops)`)
      }
    }
  }

  return { passed: errors.length === 0, errors }
}

export default {
  name:           'validate',
  aliases:        ['checkdata'],
  category:       'admin',
  requiresPlayer: false,
  description:    'Run data integrity validation (owner only)',

  async run(ctx) {
    // Owner gate — was only checking config.ownerNumbers (phone-number JIDs)
    // and never config.ownerLid, so LID-based owner accounts were incorrectly
    // rejected. Now uses the same shared check as every other owner gate.
    const isOwner = ctx.from ? isOwnerJid(ctx.from) : false
    if (!isOwner) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    const { passed, errors } = runValidation()

    if (passed) {
      return ctx.reply(
        `✅ *Validation passed!*\n` +
        `All class startingItems, recipe materials, item slots, and recipe obtainability checks are clean.\n` +
        `Items: ${allItems.length}  |  Recipes: ${recipes.length}  |  Classes: ${Object.keys(classes).length}`,
      )
    }

    const lines = errors.map((e, i) => `  ${i + 1}. ${e}`)
    return ctx.reply(
      `❌ *Validation FAILED — ${errors.length} error(s)*\n\n` +
      lines.join('\n') +
      `\n\n_Fix all errors above before deploying._`,
    )
  },
}
