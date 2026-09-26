/**
 * giveability.js — .giveability <ability name or id> [@mention | reply | player name]
 * Standalone owner-only command (same family as .givegems/.giveitem). Grants an
 * ability to a target player (defaults to yourself if no target is given).
 *
 * Two families, resolved in this order:
 *   1. Generic abilities (data/abilities.json — e.g. Crown's Favor, the
 *      standard premium grant). Land in abilityInventory and, when a slot is
 *      free, equipped into equippedAbilities — same shape as
 *      grantPremiumAbility() in lib/premium-abilities.js.
 *   2. The 5 one-of-one premium abilities (data/premium-abilities.json —
 *      Freeze Touch, Heat Blaze, …). Routed through the shared exclusive-spin
 *      claim registry, exactly like the monthly premium gift and the
 *      .givecharacter exclusive path: already claimed by ANOTHER player →
 *      refused (these are one-of-one bot-wide); target already holds one →
 *      refused (a player holds at most one).
 *
 * ARGUMENT SHAPE. handler.js hands a plugin args WITHOUT the command word, so
 * for `.giveability heat_blaze Yochan` args is ['heat_blaze', 'Yochan']. This
 * used to read args.slice(1) — a shape copied from plugins/admin.js's sub-flow,
 * where args[0] really is the subcommand — which threw the ability away and
 * answered `No ability matching "yochan"`. parseGiveArgs() below fixes that and
 * also accepts the shifted shape, so both call styles work.
 *
 * Example: .giveability crown's favor @player
 *          .giveability heat_blaze @player
 *          .giveability jack_of_all_trades Yochan   (name instead of a tag)
 *          .giveability Yochan heat_blaze           (either order)
 */
import { config } from '../config.js'
import { isOwnerJid, extractTarget } from '../lib/group-helpers.js'
import { abilities, premiumAbilityMap } from '../lib/game-data.js'
import { updatePlayer, getPlayer, findPlayerByName } from '../lib/player-repo.js'
import { getExclusiveSpinWinner, claimExclusiveSpinForPlayer } from '../lib/season-engine.js'
import { abilityRegistryKey } from '../lib/premium-abilities.js'

const PREMIUM_ABILITIES = Object.values(premiumAbilityMap)

/** Case- and separator-insensitive key, so "Jack of All Trades" == jack_of_all_trades. */
const fold = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The closest def in `list` for key `q`: exact first, then a unique partial,
 * then a prefix match, then the shortest name that merely contains it. Null
 * when nothing is even close, so the caller can list the catalogue instead.
 */
function bestMatch(list, q) {
  if (!list.length) return null
  const exact = list.find((a) => fold(a.id) === q || fold(a.name) === q)
  if (exact) return exact

  const partial = list.filter((a) => fold(a.id).includes(q) || fold(a.name).includes(q))
  if (!partial.length) return null
  if (partial.length === 1) return partial[0]

  const prefixed = partial.filter((a) => fold(a.name).startsWith(q) || fold(a.id).startsWith(q))
  const pool = prefixed.length ? prefixed : partial
  return pool.reduce((best, a) => (fold(a.name).length < fold(best.name).length ? a : best))
}

/** Resolves an ability query to { kind: 'generic'|'premium', def }. */
export function findAbilityDef(query) {
  const q = fold(query)
  if (!q) return null

  // The one-of-ones are checked first: their names are the distinctive ones
  // ("Jack of All Trades"), and a generic partial like "jack" must not be
  // swallowed by a loose contains-match on the generic list.
  const premium = bestMatch(PREMIUM_ABILITIES, q)
  if (premium) return { kind: 'premium', def: premium }

  const generic = bestMatch(abilities, q)
  if (generic) return { kind: 'generic', def: generic }

  return null
}

/** Every grantable ability, for the "not found" listing. */
export function listGrantableAbilities() {
  return [
    ...abilities.map(a => `  • *${a.name}* (${a.id})`),
    ...PREMIUM_ABILITIES.map(a => `  • *${a.name}* (${a.id}) — one-of-one premium`),
  ].join('\n')
}

/** The command words this plugin answers to, tolerated at the head of args. */
const COMMAND_WORDS = new Set(['giveability', 'giveabilities', 'giveab'])

/**
 * parseGiveArgs(args) -> { found, query, targetName }
 *
 * Splits the line into "which ability" and "who gets it" without demanding an
 * order or an @mention. The longest run of leading words that names an ability
 * wins and whatever is left over is the target, so multi-word names survive:
 *
 *   ['jack_of_all_trades', 'Yochan']  -> Jack of All Trades, target "Yochan"
 *   ['jack', 'of', 'all', 'trades', 'Yochan'] -> same, typed with spaces
 *   ['Yochan', 'heat_blaze']          -> Heat Blaze, target "Yochan" (flipped)
 *   ['crown\'s favor']                -> Crown's Favor, target null (= yourself)
 *
 * @mentions are stripped out first: they are targeting, never part of a name,
 * and extractTarget() reads them off the message itself.
 */
export function parseGiveArgs(args) {
  const words = (Array.isArray(args) ? args : [])
    .map(a => String(a ?? '').trim())
    .filter(Boolean)
    .filter(a => !a.startsWith('@'))
  // Tolerate a caller that leaves the command word in args[0] (admin.js's
  // sub-flow shape) instead of mistaking it for the ability.
  const parts = COMMAND_WORDS.has(fold(words[0])) ? words.slice(1) : words

  if (!parts.length) return { found: null, query: '', targetName: null }

  for (let n = parts.length; n >= 1; n--) {
    const found = findAbilityDef(parts.slice(0, n).join(' '))
    if (found) {
      const rest = parts.slice(n).join(' ').trim()
      return { found, query: parts.slice(0, n).join(' '), targetName: rest || null }
    }
  }
  // Nothing matched from the left — try the target-first order, where the
  // ability is whatever trails the name.
  for (let start = 1; start < parts.length; start++) {
    const found = findAbilityDef(parts.slice(start).join(' '))
    if (found) {
      return { found, query: parts.slice(start).join(' '), targetName: parts.slice(0, start).join(' ').trim() }
    }
  }
  return { found: null, query: parts.join(' '), targetName: null }
}

export async function giveAbility(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  const { found, query, targetName } = parseGiveArgs(args)

  if (!query) {
    return reply(
      `❌ Usage: *${p}giveability <ability name or id> [@user | player name]*\n` +
      `_Example: *${p}giveability crown's favor @player* or *${p}giveability heat_blaze Yochan*_`,
    )
  }

  if (!found) {
    return reply(`❌ No ability matching *"${query}"*.\n\n${listGrantableAbilities()}`)
  }

  // Target: an @mention or a reply beats a typed name, which beats yourself.
  let targetId = extractTarget(ctx) ?? null
  if (!targetId && targetName) {
    if (typeof db?.read === 'function') await db.read().catch(() => {})
    const named = findPlayerByName(Object.values(db?.data?.users ?? {}), targetName)
    if (!named) {
      return reply(
        `❌ No player found matching *"${targetName}"*.\n` +
        `_Tag them with @ or reply to one of their messages instead._`,
      )
    }
    targetId = named.id
  }
  targetId = targetId ?? ctx.from

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
