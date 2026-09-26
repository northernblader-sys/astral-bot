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

/**
 * The COMMAND that fires an ability, on its own — the one thing every list in
 * this file was missing. A player reading `.ability` or `.ability all` could see
 * "Jack of All Trades" or "Crown's Favor" and had no way to tell from that line
 * what to actually type, so the natural next move was `.ability equip <name>` —
 * which, for the five one-of-ones, never takes a slot at all. Every rendering
 * below now carries its command beside the name.
 */
export function commandFor(def, p = config.prefix) {
  return def.activeCommand
    ? `*${p}${def.activeCommand}*` +
      ((def.activeAliases ?? []).length ? ` _(${(def.activeAliases ?? []).map(a => `${p}${a}`).join(' / ')})_` : '')
    : '_no command: passive, always on_'
}

/** Same idea for a slot ability from data/abilities.json. */
function genericCommandFor(def, p = config.prefix) {
  return def.type === 'active'
    ? `*${p}useability ${def.name}*`
    : `_no command: passive, applies itself in battle_`
}

/** Who holds a one-of-one right now, bot-wide, in player-facing words. */
function holderLine(db, def, player = null) {
  // The player's OWN record wins over the registry: a one-of-one can be sitting
  // on player.premiumAbility with no registry claim behind it (an early grant, a
  // hand-written save), and reading "unclaimed" on the detail page of an ability
  // the page itself says is yours is the kind of contradiction a player reads as
  // the grant never landing.
  if (player?.premiumAbility === def.id) {
    return `👑 *Holder:* *${player.name ?? 'you'}* — that's you. One of only 5 in the whole game, one holder each.`
  }
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
    `👑 *One-of-one premium* — _already on, takes no slot_\n` +
    `  ${def.emoji ?? '✨'} *${def.name}* — _1 of only 5 in the game_\n` +
    `  ${def.passiveDesc ?? def.flavor ?? ''}\n` +
    `  ${activeLine(def)}\n` +
    `  ▸ *In battle:* ${commandFor(def)}\n`
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
    return `  ${rarityStars(ab.rarity)} *${ab.name}* _[${ab.rarity}, ${ab.type}${cd}]_\n     ▸ ${genericCommandFor(ab, p)}`
  }).join('\n')

  const bagLines = bagOnly.length
    ? bagOnly.map(ab =>
        `  • *${ab.name}* _[${ab.rarity}, ${ab.type}]_\n     ▸ equip with *${p}ability equip ${ab.name}*`).join('\n')
    : `  _Nothing waiting._`

  return (
    `✨ *Your Abilities*\n\n` +
    `🎯 *Equipped (${equippedDefs.length}/${slots} slots)*\n${slotLines}\n\n` +
    (premium ? `${premium}\n` : '') +
    `🎒 *Owned, not equipped*\n${bagLines}\n\n` +
    `*${p}ability <name>* for detail · *${p}ability equip <name>* to fill a slot\n` +
    `*${p}useability <name>* fires an equipped active in battle.\n` +
    `_One-of-ones never take a slot: yours is already on, and its battle command is the one printed above._`
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
    `▸ *In battle:* ${genericCommandFor(def)}\n\n` +
    (equipped
      ? `🎯 Equipped. Use it in battle with *${config.prefix}useability ${def.name}*.`
      : owned
        ? `🎒 In your bag. Put it in a slot with *${config.prefix}ability equip ${def.name}*.`
        : `_Not yours yet. Owner grants and Premium are the ways in._`)
  )
}

/** Full detail on one of the 5 one-of-one premium abilities. */
function premiumDetail(db, def, isYours, player = null) {
  return (
    `${def.emoji ?? '✨'} *${def.name}*\n` +
    `_one-of-one premium ability — 1 of only 5 in the whole game_\n\n` +
    `${def.flavor ?? ''}\n\n` +
    `🛡️ *Passive*\n${def.passiveDesc ?? '_None._'}\n\n` +
    `${activeLine(def)}\n` +
    (def.activeDesc ? `   ${def.activeDesc}\n` : '') +
    `▸ *In battle:* ${commandFor(def)}\n` +
    `\n${holderLine(db, def, player)}\n` +
    (isYours
      ? `\n✅ *It's yours.* It lives while your Premium does, and it takes no slot — there is nothing to equip.`
      : `\n_${config.prefix}premium buy monthly_ gifts one of the unclaimed five.`)
  )
}

/** `.ability all` — the whole catalogue, so the list is never a mystery. */
function catalogue(db) {
  const generic = abilityDefs.map(a =>
    `  • ${rarityStars(a.rarity)} *${a.name}* (${a.id}) _[${a.type}]_\n     ▸ ${genericCommandFor(a)}`)
  const premium = PREMIUM_ABILITIES.map(a =>
    `  • ${a.emoji ?? '✨'} *${a.name}* (${a.id}) — one-of-one\n     ▸ ${commandFor(a)}`)
  return (
    `✨ *Every ability in the game*\n\n` +
    `*Slot abilities* — take a slot, equipped with *${config.prefix}ability equip <name>*\n` +
    `${generic.join('\n') || '  _None._'}\n\n` +
    `*One-of-one premium* — no slot, always on, gifted with a monthly Premium plan\n` +
    `${premium.join('\n')}\n\n` +
    `_${PREMIUM_ABILITIES.length} exist and each has exactly one holder at a time._\n` +
    `Detail with *${config.prefix}ability <name>*.`
  )
}

/**
 * Everything the caller actually holds, in one line — the answer to "then what
 * DO I own?", which `.ability` used to make the player go and look up.
 */
export function ownedLine(player) {
  const p = config.prefix
  const held = getPlayerAbility(player)
  const bag = (player.abilityInventory ?? []).map(id => getAbilityDef(id)).filter(Boolean)
  const equipped = (player.equippedAbilities ?? [])

  const parts = []
  if (held) parts.push(`${held.emoji ?? '✨'} *${held.name}* — in battle: ${commandFor(held, p)}`)
  for (const ab of bag) {
    const state = equipped.includes(ab.id) ? 'equipped' : 'in your bag'
    parts.push(`• *${ab.name}* _(${state})_ — ${genericCommandFor(ab, p)}`)
  }
  return parts.length
    ? parts.join('\n')
    : `_Nothing yet. Every Premium plan leaves you holding one: *${p}premium*._`
}

// ── equip / unequip ─────────────────────────────────────────────────────────

/**
 * A one-of-one named on `.ability equip`. The five are NOT slot abilities: they
 * live on player.premiumAbility with their own engine (lib/premium-abilities.js),
 * they are on from the moment they are granted, and their battle move is its own
 * command (.freezeup, .heatwave, .nighteyes, .daylight — Jack of All Trades has
 * none, it is passive only).
 *
 * This branch is the whole reason `.ability equip jack_of_all_trades` used to
 * answer "You don't own an ability matching jack_of_all_trades" to the player
 * who was holding it: handleEquip() only ever searched abilityInventory, where a
 * one-of-one never is. Nothing was ever going to match, and the reply sent them
 * to `.ability` — which then showed them the ability they had just been told
 * they didn't own.
 */
function premiumEquipReply(ctx, def) {
  const p = config.prefix
  if (ctx.player.premiumAbility === def.id) {
    return ctx.reply(
      `👑 *${def.emoji ?? '✨'} ${def.name} is already on you.*\n` +
      `It's a one-of-one: it never takes a slot, so there's nothing to equip — ` +
      `its passive is live in every fight, duel, dungeon and boss you walk into.\n\n` +
      `▸ *In battle:* ${commandFor(def, p)}\n` +
      (def.activeDesc ? `   ${def.activeDesc}\n` : '') +
      `\n_${p}ability — everything you hold. Slot abilities are the only thing ${p}ability equip moves._`
    )
  }

  const holderId = getExclusiveSpinWinner(ctx.db, abilityRegistryKey(def.id))
  const holder = holderId ? getPlayer(ctx.db, holderId) : null
  return ctx.reply(
    `🔒 *${def.emoji ?? '✨'} ${def.name}* isn't yours to equip.\n` +
    `It's one of only *5* one-of-ones, and ${holder ? `*${holder.name}* holds it right now` : 'nobody holds it yet'}. ` +
    `It comes with a *monthly* Premium plan, and a player holds at most one.\n\n` +
    // Either way the reader leaves with a next step: buy one, or wait for the
    // holder's Premium to lapse and put it back on the shelf.
    `▸ ${holderId
      ? `It goes back on the shelf if their Premium lapses. *${p}premium buy monthly* takes whichever one is free.`
      : `*${p}premium buy monthly* gifts one of the unclaimed five.`}\n` +
    `▸ What you DO hold:\n${ownedLine(ctx.player)}`
  )
}

async function handleEquip(ctx, query) {
  const p = config.prefix
  if (!String(query ?? '').trim()) {
    return ctx.reply(
      `Usage: *${p}ability equip <name>*\n\n` +
      `▸ What you can equip right now:\n${ownedLine(ctx.player)}`
    )
  }

  // One-of-ones first: they are the distinctive names, and they route to the
  // "already on / not yours" page above instead of the slot machinery.
  const premium = findDef(PREMIUM_ABILITIES, query)
  if (premium) return premiumEquipReply(ctx, premium)

  const owned = (ctx.player.abilityInventory ?? []).map(id => getAbilityDef(id)).filter(Boolean)
  const def = findDef(owned, query)
  if (!def) {
    // Never a bare "you don't own that" — the player asked what to type, so
    // answer with what they actually hold and the command for each.
    const known = findDef(abilityDefs, query)
    return ctx.reply(
      `❌ You don't own an ability matching *"${query}"*.\n` +
      (known ? `_It exists, it just isn't in your bag yet._\n` : '') +
      `\n▸ *What you hold:*\n${ownedLine(ctx.player)}\n\n` +
      `_Every ability in the game: *${p}ability all*._`
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

  // Same trap as equip: a one-of-one is never in equippedAbilities, so naming
  // one here gets the honest answer instead of "isn't in one of your slots".
  const premium = findDef(PREMIUM_ABILITIES, query)
  if (premium) {
    if (ctx.player.premiumAbility === premium.id) {
      return ctx.reply(
        `👑 *${premium.emoji ?? '✨'} ${premium.name}* can't be unequipped — it was never in a slot.\n` +
        `It stays on you for as long as your Premium does. In battle: ${commandFor(premium, p)}`
      )
    }
    return ctx.reply(`🔒 *${premium.name}* isn't yours — it's one of the 5 one-of-ones, and you don't hold it.`)
  }

  const equipped = (ctx.player.equippedAbilities ?? []).map(id => getAbilityDef(id)).filter(Boolean)
  const def = findDef(equipped, query)
  if (!def) {
    const inSlots = equipped.length
      ? equipped.map(a => `  • *${a.name}*`).join('\n')
      : '  _No slot abilities equipped._'
    return ctx.reply(
      `❌ *"${query}"* isn't in one of your slots.\n\n` +
      `▸ *In your slots:*\n${inSlots}\n\n` +
      `_${p}ability unequip <name> takes one out. One-of-ones never sit in a slot: *${p}ability*._`
    )
  }

  await updatePlayer(ctx.db, ctx.from, (player) => {
    player.equippedAbilities = (player.equippedAbilities ?? []).filter(id => id !== def.id)
  })
  return ctx.reply(`⚪ *${def.name} taken out of its slot.* It stays in your bag: *${p}ability equip ${def.name}* puts it back.`)
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default {
  name: 'ability',
  // `.equipability` / `.unequipability` are how a player naturally types it, and
  // before these existed they landed on "Unknown command" even though the same
  // work sat one word away under `.ability equip`. They are aliases of this
  // plugin, so both spellings reach the same code path.
  aliases: ['abilities', 'myabilities', 'equipability', 'unequipability'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}ability — every ability you hold, with the command that fires each one`,
  subcommands: [
    { cmd: '<name>',       desc: 'full detail on one ability, and how to use it' },
    { cmd: 'equip <name>', desc: 'put an owned slot ability into a free slot' },
    { cmd: 'unequip <name>', desc: 'take a slot ability back out' },
    { cmd: 'all',          desc: 'every ability in the game, with its command' },
  ],

  async run(ctx) {
    const { args } = ctx
    const p = config.prefix
    // The aliases carry the subcommand inside the command word itself, so
    // `.equipability crown's favor` and `.ability equip crown's favor` are the
    // same call by the time they get here.
    const aliasSub = ctx.cmd === 'equipability' ? 'equip'
      : ctx.cmd === 'unequipability' ? 'unequip'
      : null
    const sub = (aliasSub ?? args[0] ?? '').toLowerCase()
    const rest = aliasSub ? args : args.slice(1)

    if (aliasSub && !args.length) {
      return ctx.reply(
        `Usage: *${p}${ctx.cmd} <name>*\n\n` +
        `▸ What you can ${aliasSub === 'equip' ? 'equip' : 'take out'} right now:\n${ownedLine(ctx.player)}`
      )
    }
    if (!args.length) return ctx.reply(describePlayerAbilities(ctx.player))
    if (sub === 'all' || sub === 'list') return ctx.reply(catalogue(ctx.db))
    if (sub === 'equip') return handleEquip(ctx, rest.join(' '))
    if (sub === 'unequip' || sub === 'remove') return handleUnequip(ctx, rest.join(' '))

    const query = args.join(' ')
    const generic = findDef(abilityDefs, query)
    if (generic) return ctx.reply(genericDetail(ctx.player, generic))

    const premium = findDef(PREMIUM_ABILITIES, query)
    if (premium) return ctx.reply(premiumDetail(ctx.db, premium, ctx.player.premiumAbility === premium.id, ctx.player))

    return ctx.reply(
      `❌ No ability matching *"${query}"*.\n\n${catalogue(ctx.db)}`
    )
  },
}
