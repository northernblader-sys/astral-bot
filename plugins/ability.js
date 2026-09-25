/**
 * ability.js — .ability, the one place every ability you hold is written down.
 *
 * Why this exists: abilities live in TWO systems and, until now, no command
 * showed both. Generic abilities (data/abilities.json — Crown's Favor, the
 * standard Premium grant) sit in player.abilityInventory/equippedAbilities and
 * render on .profile and .useability. The 5 one-of-one Premium abilities
 * (data/premium-abilities.json) live on player.premiumAbility with their own
 * engine (lib/premium-abilities.js) and their own active commands, and showed
 * up nowhere except one line on .profile. So a monthly buyer who was GIFTED
 * Freeze Touch checked their abilities and saw an empty slot, which reads
 * exactly like "the bot never gave me what I paid for".
 *
 * Usage:
 *   .ability                    — everything you hold: slots, bag, one-of-one
 *   .ability <name|id>          — full detail on one ability
 *   .ability equip <name>       — put an owned ability into a free slot
 *   .ability unequip <name>     — take one back out of a slot
 *   .ability all                — the whole catalogue, one-of-one holders named
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { abilities as abilityDefs, premiumAbilityMap } from '../lib/game-data.js'
import { getAbilityDef } from '../lib/ability-engine.js'
import { getPlayerAbility, abilityRegistryKey } from '../lib/premium-abilities.js'
import { getExclusiveSpinWinner } from '../lib/season-engine.js'
import { rarityStars } from '../lib/rarity.js'

const PREMIUM_ABILITIES = Object.values(premiumAbilityMap)

/** Case- and separator-insensitive, so "crown's favor" == crown_s_favor. */
const fold = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Match one of `defs` by id or name, exactly first and then by substring. */
function findDef(defs, query) {
  const q = fold(query)
  if (!q) return null
  const exact = defs.find(a => fold(a.id) === q || fold(a.name) === q)
  if (exact) return exact
  const partial = defs.filter(a => fold(a.id).includes(q) || fold(a.name).includes(q))
  if (!partial.length) return null
  return partial.reduce((best, a) => (fold(a.name).length < fold(best.name).length ? a : best))
}

/** One ability effect as a single readable line. */
function effectLine(effect) {
  const stat = effect.stat ? ` ${String(effect.stat).toUpperCase()}` : ''
  switch (effect.type) {
    case 'strengthen': return `+${effect.value ?? 0}${stat} in battle`
    case 'weaken':     return `-${Math.abs(effect.value ?? 0)}${stat} to the enemy`
    case 'regen':      return `Regen ${effect.value ?? effect.amount ?? 0} HP a turn`
    case 'attack':     return `${effect.hits ?? 1} strike(s) at ${effect.multiplier ?? 1}x power`
    case 'heal':       return `Heal ${effect.amount ?? effect.value ?? 0} HP`
    default: {
      const amount = effect.amount ?? effect.value ?? ''
      return `${String(effect.type).replace(/_/g, ' ')}${stat}${amount ? ` ${amount}` : ''}`.trim()
    }
  }
}

/** The active-move line for a one-of-one, or '' when it has none. */
function activeLine(def) {
  if (!def.activeCommand) return '⚡ *Active:* _none, this one is passive only._'
  const aliases = (def.activeAliases ?? []).map(a => `*${config.prefix}${a}*`).join(' / ')
  return `⚡ *Active: ${def.activeName ?? def.name}* — use *${config.prefix}${def.activeCommand}* in battle` +
    (aliases ? ` _(${aliases})_` : '')
}

/** Who holds a one-of-one right now, bot-wide, in player-facing words. */
function holderLine(db, def) {
  const holderId = getExclusiveSpinWinner(db, abilityRegistryKey(def.id))
  if (!holderId) return `👑 *Holder:* _unclaimed._ It comes with a monthly Premium plan.`
  const holder = getPlayer(db, holderId)
  return `👑 *Holder:* *${holder?.name ?? 'a player'}* — one of only 5 in the whole game, one holder each.`
}

// ── Views ───────────────────────────────────────────────────────────────────

function premiumBlock(player) {
  const def = getPlayerAbility(player)
  if (!def) return ''
  return (
    `👑 *One-of-one premium*\n` +
    `  ${def.emoji ?? '✨'} *${def.name}* — _1 of only 5 in the game_\n` +
    `  ${def.passiveDesc ?? def.flavor ?? ''}\n` +
    `  ${activeLine(def)}\n`
  )
}

/** The `.ability` overview: slots, one-of-one, and what is sitting unequipped. */
export function describePlayerAbilities(player) {
  const p = config.prefix
  const slots = player.abilitySlots ?? 1
  const equippedIds = player.equippedAbilities ?? []
  const equippedDefs = equippedIds.map(id => getAbilityDef(id)).filter(Boolean)
  const bagOnly = (player.abilityInventory ?? [])
    .filter(id => !equippedIds.includes(id))
    .map(id => getAbilityDef(id))
    .filter(Boolean)

  const premium = premiumBlock(player)

  if (!equippedDefs.length && !bagOnly.length && !premium) {
    return (
      `✨ *Your Abilities*\n\n` +
      `_No abilities yet._\n\n` +
      `👑 Every Premium plan leaves you holding one: Crown's Favor is the floor, and the ` +
      `*monthly* plan gifts one of only *5* one-of-ones instead. See *${p}premium*.\n\n` +
      `_Check again here any time with_ *${p}ability*.`
    )
  }

  const slotLines = Array.from({ length: slots }, (_, i) => {
    const ab = equippedDefs[i]
    if (!ab) return `  ☆☆☆☆☆ — empty slot —`
    const cd = ab.type === 'active' ? `, ${ab.cooldownTurns}-turn CD` : ''
    return `  ${rarityStars(ab.rarity)} *${ab.name}* _[${ab.rarity}, ${ab.type}${cd}]_`
  }).join('\n')

  const bagLines = bagOnly.length
    ? bagOnly.map(ab => `  • *${ab.name}* _[${ab.rarity}, ${ab.type}]_`).join('\n')
    : `  _Nothing waiting._`

  return (
    `✨ *Your Abilities*\n\n` +
    `🎯 *Equipped (${equippedDefs.length}/${slots} slots)*\n${slotLines}\n\n` +
    (premium ? `${premium}\n` : '') +
    `🎒 *Owned, not equipped*\n${bagLines}\n\n` +
    `*${p}ability <name>* for detail · *${p}ability equip <name>* to fill a slot\n` +
    `*${p}useability <name>* fires an equipped active in battle.`
  )
}

/** Full detail on one generic ability. */
function genericDetail(player, def) {
  const equipped = (player.equippedAbilities ?? []).includes(def.id)
  const owned = (player.abilityInventory ?? []).includes(def.id)
  const cd = def.type === 'active' ? ` · ${def.cooldownTurns}-turn cooldown` : ''
  const effects = (def.effects ?? []).map(e => `  • ${effectLine(e)}`).join('\n')
  return (
    `${rarityStars(def.rarity)} *${def.name}*\n` +
    `_[${def.rarity} · ${def.type}${cd}]_\n\n` +
    `${def.description ?? ''}\n\n` +
    (effects ? `⚙️ *Effects*\n${effects}\n\n` : '') +
    (equipped
      ? `🎯 Equipped. Use it in battle with *${config.prefix}useability ${def.name}*.`
      : owned
        ? `🎒 In your bag. Put it in a slot with *${config.prefix}ability equip ${def.name}*.`
        : `_Not yours yet. Owner grants and Premium are the ways in._`)
  )
}

/** Full detail on one of the 5 one-of-one premium abilities. */
function premiumDetail(db, def, isYours) {
  return (
    `${def.emoji ?? '✨'} *${def.name}*\n` +
    `_one-of-one premium ability — 1 of only 5 in the whole game_\n\n` +
    `${def.flavor ?? ''}\n\n` +
    `🛡️ *Passive*\n${def.passiveDesc ?? '_None._'}\n\n` +
    `${activeLine(def)}\n` +
    (def.activeDesc ? `   ${def.activeDesc}\n` : '') +
    `\n${holderLine(db, def)}\n` +
    (isYours
      ? `\n✅ *It's yours.* It lives while your Premium lives.`
      : `\n_${config.prefix}premium buy monthly_ gifts one of the unclaimed five.`)
  )
}

/** `.ability all` — the whole catalogue, so the list is never a mystery. */
function catalogue(db) {
  const generic = abilityDefs.map(a => `  • ${rarityStars(a.rarity)} *${a.name}* (${a.id}) _[${a.type}]_`)
  const premium = PREMIUM_ABILITIES.map(a => `  • ${a.emoji ?? '✨'} *${a.name}* (${a.id}) — one-of-one`)
  return (
    `✨ *Every ability in the game*\n\n` +
    `*Slot abilities*\n${generic.join('\n') || '  _None._'}\n\n` +
    `*One-of-one premium*\n${premium.join('\n')}\n\n` +
    `_${PREMIUM_ABILITIES.length} exist and each has exactly one holder at a time._\n` +
    `Detail with *${config.prefix}ability <name>*.`
  )
}

// ── equip / unequip ─────────────────────────────────────────────────────────

async function handleEquip(ctx, query) {
  const p = config.prefix
  const owned = (ctx.player.abilityInventory ?? []).map(id => getAbilityDef(id)).filter(Boolean)
  const def = findDef(owned, query)
  if (!def) {
    return ctx.reply(
      `❌ You don't own an ability matching *"${query}"*.\n` +
      `_Yours are listed under_ *${p}ability*.`
    )
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, (player) => {
    player.equippedAbilities = player.equippedAbilities ?? []
    if (player.equippedAbilities.includes(def.id)) { outcome = { reason: 'already' }; return }
    const slots = player.abilitySlots ?? 1
    if (player.equippedAbilities.length >= slots) {
      outcome = { reason: 'full', slots, equipped: player.equippedAbilities.map(id => getAbilityDef(id)).filter(Boolean) }
      return
    }
    player.equippedAbilities.push(def.id)
    outcome = { reason: 'ok', slots }
  })

  if (outcome.reason === 'already') return ctx.reply(`🎯 *${def.name}* is already equipped.`)
  if (outcome.reason === 'full') {
    // A slot can be occupied by an id that no longer resolves (an ability
    // retired from data/abilities.json), so the name list may come back empty.
    const names = outcome.equipped.map(a => a.name).join(', ')
    const held = names ? ` (${names})` : ''
    return ctx.reply(
      `❌ All *${outcome.slots}* ability slot(s) are full${held}.\n` +
      `Free one with *${p}ability unequip <name>* first.`
    )
  }
  return ctx.reply(
    `🎯 *${def.name} equipped.*\n` +
    (def.type === 'active'
      ? `Fire it in battle with *${p}useability ${def.name}*.`
      : `It's passive: it applies itself the moment your next battle starts.`)
  )
}

async function handleUnequip(ctx, query) {
  const p = config.prefix
  const equipped = (ctx.player.equippedAbilities ?? []).map(id => getAbilityDef(id)).filter(Boolean)
  const def = findDef(equipped, query)
  if (!def) {
    return ctx.reply(`❌ *"${query}"* isn't in one of your slots.\n_Equipped:_ *${p}ability*`)
  }

  await updatePlayer(ctx.db, ctx.from, (player) => {
    player.equippedAbilities = (player.equippedAbilities ?? []).filter(id => id !== def.id)
  })
  return ctx.reply(`⚪ *${def.name} taken out of its slot.* It stays in your bag: *${p}ability equip ${def.name}* puts it back.`)
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default {
  name: 'ability',
  aliases: ['abilities', 'myabilities'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}ability — every ability you hold: slots, bag, and your one-of-one`,
  subcommands: [
    { cmd: '<name>',       desc: 'full detail on one ability' },
    { cmd: 'equip <name>', desc: 'put an owned ability into a free slot' },
    { cmd: 'unequip <name>', desc: 'take an ability back out of its slot' },
    { cmd: 'all',          desc: 'every ability in the game' },
  ],

  async run(ctx) {
    const { args } = ctx
    const sub = (args[0] ?? '').toLowerCase()

    if (!args.length) return ctx.reply(describePlayerAbilities(ctx.player))
    if (sub === 'all' || sub === 'list') return ctx.reply(catalogue(ctx.db))
    if (sub === 'equip') return handleEquip(ctx, args.slice(1).join(' '))
    if (sub === 'unequip' || sub === 'remove') return handleUnequip(ctx, args.slice(1).join(' '))

    const query = args.join(' ')
    const generic = findDef(abilityDefs, query)
    if (generic) return ctx.reply(genericDetail(ctx.player, generic))

    const premium = findDef(PREMIUM_ABILITIES, query)
    if (premium) return ctx.reply(premiumDetail(ctx.db, premium, ctx.player.premiumAbility === premium.id))

    return ctx.reply(
      `❌ No ability matching *"${query}"*.\n\n${catalogue(ctx.db)}`
    )
  },
}
