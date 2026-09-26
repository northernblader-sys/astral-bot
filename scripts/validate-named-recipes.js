/**
 * validate-named-recipes.js
 *
 * Sanity-checks the named-weapon forging system:
 *   1. Every material itemId in named-category recipes exists in boss-trophies.json
 *   2. Every recipe output id in named-category recipes exists in named-weapons.json
 *
 * Run from the project root:
 *   node scripts/validate-named-recipes.js
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const recipes      = require('../data/recipes.json')
const bossTrophies = require('../data/boss-trophies.json')
const namedWeapons = require('../data/named-weapons.json')

const trophyIds     = new Set(bossTrophies.map(t => t.id))
const namedItemIds  = new Set(namedWeapons.map(w => w.id))
const namedRecipes  = recipes.filter(r => r.category === 'named')

let errors = 0

console.log(`\n🔍 Validating ${namedRecipes.length} named-weapon recipes...\n`)

for (const recipe of namedRecipes) {
  // Check output id
  if (!namedItemIds.has(recipe.output)) {
    console.error(`❌ [${recipe.id}] output "${recipe.output}" NOT FOUND in named-weapons.json`)
    errors++
  } else {
    console.log(`✅ [${recipe.id}] output "${recipe.output}" — OK`)
  }

  // Check each material
  for (const { itemId, qty } of recipe.materials) {
    if (!trophyIds.has(itemId)) {
      console.error(`   ❌ material "${itemId}" (qty ${qty}) NOT FOUND in boss-trophies.json`)
      errors++
    } else {
      const trophy = bossTrophies.find(t => t.id === itemId)
      console.log(`   ✅ material "${itemId}" (boss: ${trophy.sourceBoss}, rarity: ${trophy.rarity})`)
    }
  }
}

console.log('\n' + '─'.repeat(60))
if (errors === 0) {
  console.log(`✅  All ${namedRecipes.length} recipes passed validation — no mismatches found.\n`)
} else {
  console.error(`❌  ${errors} mismatch(es) found — fix the ids above before shipping.\n`)
  process.exit(1)
}
