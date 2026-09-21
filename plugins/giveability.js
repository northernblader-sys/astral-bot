/**
 * giveability.js — .giveability <ability name or id> [@mention | reply]
 * Standalone owner-only command (same family as .givegems/.giveitem). Grants an
 * ability to a target player (defaults to yourself if no @mention/reply given).
 *
 * Two families, resolved in this order:
 *   1. Generic abilities (data/abilities.json — e.g. Crown's Favor, the
 *      standard premium grant). Land in abilityInventory and, when a slot is
 *      free, equipped into equippedAbilities — same shape as
 *      grantPremiumAbility() in lib/premium-abilities.js.
 *   2. The 5 one-of-one premium abilities (data/premium-abilities.json —
 *      Freeze Touch, Heat Blaze, …). Routed through the shared exclusive-spin
 *      claim registry, exactly like the weekly premium spin and the
 *      .givecharacter exclusive path: already claimed by ANOTHER player →
 *      refused (these are one-of-one bot-wide); target already holds one →
 *      refused (a player holds at most one).
 *
 * Example: .giveability crown's favor @player
 *          .giveability heat_blaze @player
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { abilities, premiumAbilityMap } from '../lib/game-data.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { getExclusiveSpinWinner, claimExclusiveSpinForPlayer } from '../lib/season-engine.js'
import { abilityRegistryKey } from '../lib/premium-abilities.js'
import { resolveTargetId } from './admin.js'

/** Resolves an ability query to { kind: 'generic'|'premium', def }. */
export function findAbilityDef(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  const byId = premiumAbilityMap[q]
  if (byId) return { kind: 'premium', def: byId }
  // "Heat Blaze" / "heat blaze" / "heat_blaze" all work for one-of-ones.
  const byName = Object.values(premiumAbilityMap).find(a =>
    a.name.toLowerCase() === q || a.name.toLowerCase().replace(/\s+/g, '_') === q)
  if (byName) return { kind: 'premium', def: byName }
  const generic = abilities.find(a => a.id === q)
    ?? abilities.find(a => a.name.toLowerCase() === q)
    ?? abilities.find(a => a.name.toLowerCase().includes(q))
  if (generic) return { kind: 'generic', def: generic }
  return null
}

/** Every grantable ability, for the "not found" listing. */
export function listGrantableAbilities() {
  return [
    ...abilities.map(a => `  • *${a.name}* (${a.id})`),
    ...Object.values(premiumAbilityMap).map(a => `  • *${a.name}* (${a.id}) — one-of-one premium`),
  ].join('\n')
}

export async function giveAbility(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  // Anything that looks like a mention belongs to the targeting, not the name.
  const query = args.slice(1).filter(a => a && !a.startsWith('@')).join(' ').trim()
  if (!query) {
    return reply(`❌ Usage: *${p}giveability <ability name or id> [@user]*\n_Example: *${p}giveability crown's favor @player*_`)
  }

  const found = findAbilityDef(query)
  if (!found) {
    return reply(`❌ No ability matching *"${query}"*.\n\n${listGrantableAbilities()}`)
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) return reply(`❌ That player isn't registered yet.`)

  // ── One-of-one premium abilities: shared claim registry ──────────────────
  if (found.kind === 'premium') {
    const key = abilityRegistryKey(found.def.id)
    const holderId = getExclusiveSpinWinner(db, key)
    if (holderId && holderId !== targetId) {
      const holder = getPlayer(db, holderId)
      return reply(
        `🔒 *${found.def.name}* is one-of-one and already claimed by *${holder?.name ?? 'another player'}* — ` +
        `_each of the 5 can be held by exactly one player, ever._`,
      )
    }
    if (target.premiumAbility === found.def.id) {
      return reply(`⚠️ *${target.name}* already holds *${found.def.name}*.`)
    }
    if (target.premiumAbility) {
      return reply(
        `❌ *${target.name}* already holds *${premiumAbilityMap[target.premiumAbility]?.name ?? target.premiumAbility}* — ` +
        `_a player can only ever hold one one-of-one._`,
      )
    }

    let claimed = false
    await updatePlayer(db, targetId, (pl) => {
      // Re-check inside the mutator: a concurrent grant (or the weekly spin)
      // could have claimed the registry between the pre-check and this write.
      if (pl.premiumAbility) return pl
      if (claimExclusiveSpinForPlayer(db, key, targetId)) {
        pl.premiumAbility = found.def.id
        claimed = true
      }
    })
    if (!claimed) {
      return reply(`⚠️ *${target.name}* already holds a one-of-one ability — nothing changed.`)
    }
    return reply(
      `✅ Granted ${found.def.emoji} *${found.def.name}* (one-of-one premium ability) to *${target.name}*\.\n` +
      `_It's theirs forever now — the registry reads "claimed by ${target.name}" for everyone._`,
    )
  }

  // ── Generic abilities (data/abilities.json) ──────────────────────────────
  const id = found.def.id
  let outcome = null
  await updatePlayer(db, targetId, (pl) => {
    pl.abilityInventory = pl.abilityInventory ?? []
    pl.equippedAbilities = pl.equippedAbilities ?? []
    if (pl.abilityInventory.includes(id)) { outcome = { reason: 'owned' }; return pl }
    pl.abilityInventory.push(id)
    if (pl.equippedAbilities.length < (pl.abilitySlots ?? 1)) {
      pl.equippedAbilities.push(id)
      outcome = { reason: 'ok', equipped: true }
    } else {
      outcome = { reason: 'ok', equipped: false }
    }
    return pl
  })

  if (outcome.reason === 'owned') {
    return reply(`⚠️ *${target.name}* already owns *${found.def.name}*.`)
  }
  const eqLine = outcome.equipped
    ? `It's equipped in their ability slot already.`
    : `All their ability slots are full — it's in their inventory.`
  return reply(
    `✅ Granted *${found.def.name}* (${found.def.rarity}, ${found.def.type}) to *${target.name}*. ${eqLine}`,
  )
}

export default {
  name:        'giveability',
  aliases:     ['giveabilities', 'giveab'],
  category:    'admin',
  requiresPlayer: false,
  description: 'Owner-only: grant an ability (generic or one-of-one premium) to a player',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }
    return giveAbility(ctx)
  },
}
