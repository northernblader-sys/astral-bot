/**
 * admin.js — bulk owner-only cheat/dev commands, all under one plugin so
 * they stack together under .menu admin instead of being scattered as
 * separate top-level commands.
 *
 * Usage (all owner-only — same isOwnerJid gate used everywhere else in the
 * bot, so it recognizes both LID and phone-number owner JIDs):
 *   .admin givesolars <amount> [@mention | reply]   — grant Solars
 *   .admin givegems <amount> [@mention | reply]     — grant Gems
 *   .admin giveitem <itemId> [amount] [@mention | reply] — grant item(s)
 *   .admin givecharacter <character> [@mention | reply]  — grant a character
 *   .admin takecharacter <character> [@mention | reply]  — revoke a character
 *   .admin setlevel <level> [@mention | reply]       — force a player's level
 *   .admin resetplayer [@mention | reply]            — wipe a player's save
 *
 * Target resolution: if you reply to someone's message or @mention them,
 * that's the target. Otherwise it defaults to yourself.
 *
 * Every one of the above also exists as its own standalone top-level command
 * for convenience (.givesolars, .givegems, .giveitem, .setlevel,
 * .resetplayer) — see the matching plugins/*.js files, which all import and
 * call the exact same functions exported below so the two entry points can
 * never drift out of sync.
 */
import { config } from '../config.js'
import { isOwnerJid, extractTarget } from '../lib/group-helpers.js'
import { allItems, getTotalStats, levelsData, classes, races, characters, characterMap } from '../lib/game-data.js'
import { getPlayer, updatePlayer, updateAllPlayers } from '../lib/player-repo.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { ensureStatPoints, statPointCap } from '../lib/stat-progression.js'
import { applyLevelUps, applyEquipmentBonus } from '../lib/combat-engine.js'
import { syncEmptyVesselFlag } from '../lib/character-abilities.js'
import {
  endSeason, getActiveSeason, getSeasonById, getSeasonRuntime, startSeason,
  claimExclusiveSpinForPlayer, getExclusiveSpinWinner, releaseExclusiveSpinLock,
} from '../lib/season-engine.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

// Exported so standalone top-level aliases (plugins/givegems.js, giveitem.js)
// can reuse the exact same owner-gated logic instead of duplicating it.
export function resolveTargetId(ctx) {
  const mentioned = extractTarget(ctx)
  return mentioned ?? ctx.from
}

export default {
  name:           'admin',
  aliases:        ['cheat', 'give'],
  category:       'admin',
  requiresPlayer: false,
  description:    'Owner-only cheat commands: give solars/gems/items, set level, reset a player',

  async run(ctx) {
    const { args, reply } = ctx
    const p = config.prefix

    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return reply(`❌ This command is restricted to the bot owner.`)
    }

    const sub = args[0]?.toLowerCase()

    if (sub === 'givesolars' || sub === 'givesolar')  return giveCurrency(ctx, 'solars')
    if (sub === 'givegems'   || sub === 'givegem')    return giveCurrency(ctx, 'gems')
    if (sub === 'givemonds'  || sub === 'givemond')   return giveCurrency(ctx, 'monds')
    if (sub === 'giveitem'   || sub === 'gi')         return giveItem(ctx)
    if (sub === 'givecharacter' || sub === 'givechar' || sub === 'gc') return giveCharacter(ctx)
    if (sub === 'takecharacter' || sub === 'takechar' || sub === 'tc') return takeCharacter(ctx)
    if (sub === 'setlevel'   || sub === 'level')      return setLevel(ctx)
    if (sub === 'reconcile'  || sub === 'fixlevels')  return reconcileLevels(ctx)
    if (sub === 'heal'       || sub === 'restore')    return healPlayer(ctx)
    if (sub === 'resetplayer' || sub === 'reset')     return resetPlayer(ctx)
    if (sub === 'season')                              return manageSeason(ctx)

    return reply(
      `🛠️ *ADMIN COMMANDS* _(owner only)_\n` +
      `─────────────────────\n` +
      `▹ *${p}admin givesolars <amount> [@user]*\n` +
      `▹ *${p}admin givegems <amount> [@user]*\n` +
      `▹ *${p}admin givemonds <amount> [@user]*\n` +
      `▹ *${p}admin giveitem <itemId> [amount] [@user]*\n` +
      `▹ *${p}admin givecharacter <character> [@user]*\n` +
      `▹ *${p}admin takecharacter <character> [@user]*\n` +
      `▹ *${p}admin setlevel <level> [@user]*\n` +
      `▹ *${p}admin reconcile [@user|all]*\n` +
      `▹ *${p}admin heal [@user]*\n` +
      `▹ *${p}admin resetplayer [@user]*\n\n` +
      `▹ *${p}admin season status*\n` +
      `▹ *${p}admin season start <seasonId>*\n` +
      `▹ *${p}admin season end*\n\n` +
      `_No @mention/reply target given → defaults to yourself._`,
    )
  },
}

async function manageSeason(ctx) {
  const { args, reply } = ctx
  const action = (args[1] ?? 'status').toLowerCase()
  const active = getActiveSeason(ctx.db)

  if (action === 'status' || action === 'info') {
    const runtime = getSeasonRuntime(ctx.db)
    return reply(
      `🌞 *SEASON ADMIN STATUS*\n\n` +
      `Active: *${active ? `${active.id} — ${active.name}` : 'none'}*\n` +
      `Started: *${runtime.startedAt ? new Date(runtime.startedAt).toISOString() : '—'}*\n` +
      `Ends: *${runtime.endsAt ? new Date(runtime.endsAt).toISOString() : '—'}*\n` +
      `Last ended: *${runtime.lastEndedSeasonId ?? '—'}*`,
    )
  }

  if (action === 'start' || action === 'activate') {
    const seasonId = args[2]?.toLowerCase()
    if (!seasonId) {
      return reply(`Usage: *${config.prefix}admin season start <seasonId>*\nAvailable: *season_01*`)
    }
    try {
      const runtime = await startSeason(ctx.db, seasonId)
      const season = getSeasonById(seasonId)
      return reply(
        `✅ Started *${season.name}*.\n` +
        `⏳ Ends: *${new Date(runtime.endsAt).toLocaleString()}*\n` +
        `🔁 Duration: *${season.durationDays} days*`,
      )
    } catch (err) {
      return reply(`❌ Could not start season: ${err.message}`)
    }
  }

  if (action === 'end' || action === 'close') {
    if (!active) return reply(`ℹ️ There is no active season to end.`)
    const result = await endSeason(ctx.db)
    return reply(
      `✅ Ended *${result.season.name}*.\n` +
      `☀️ Converted *${result.converted.toLocaleString()} Season Points* at ` +
      `*${result.conversionRate}:1* into Solars.\n` +
      `_Players permanently keep content they already unlocked._`,
    )
  }

  return reply(`Usage: *${config.prefix}admin season status|start <seasonId>|end*`)
}

/**
 * Wallet keys this command can grant, with the subcommand and symbol each one
 * reports back. A table rather than the pair of `key === 'solars' ? ... : ...`
 * ternaries this used to hold: with a third currency those silently labelled
 * every non-Solar grant as gems, so Monds would have been credited correctly
 * and announced with the wrong symbol.
 */
const GRANTABLE = {
  solars: { sub: 'givesolars', emoji: '☀️' },
  gems:   { sub: 'givegems',   emoji: '💎' },
  monds:  { sub: 'givemonds',  emoji: '🪙' },
}

export async function giveCurrency(ctx, key) {
  const { args, reply, db } = ctx
  const meta = GRANTABLE[key] ?? GRANTABLE.solars
  const amount = Math.floor(Number(args[1]))
  if (!amount || amount <= 0) {
    return reply(`❌ Usage: *${config.prefix}admin ${meta.sub} <amount> [@user]*`)
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) {
    return reply(`❌ That player isn't registered yet.`)
  }

  await updatePlayer(db, targetId, (pl) => {
    pl.wallet = pl.wallet ?? {}
    pl.wallet[key] = (pl.wallet[key] ?? 0) + amount
  })

  const emoji = meta.emoji
  return reply(
    `✅ Granted *${amount.toLocaleString()} ${emoji} ${key}* to *${target.name}*.\n` +
    `New balance: ${((getPlayer(db, targetId).wallet ?? {})[key] ?? 0).toLocaleString()} ${emoji}`,
  )
}

export async function giveItem(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  const itemId = args[1]?.toLowerCase()
  if (!itemId) {
    return reply(`❌ Usage: *${p}admin giveitem <itemId> [amount] [@user]*`)
  }
  const item = itemMap[itemId]
  if (!item) {
    return reply(`❌ No item with id *"${itemId}"* found. Check the id in data/items.json, weapons.json, etc.`)
  }

  // amount is optional — args[2] is only an amount if it's numeric,
  // otherwise it's treated as part of the target mention/omitted.
  let amount = 1
  if (args[2] && /^\d+$/.test(args[2])) amount = Math.max(1, parseInt(args[2], 10))

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) {
    return reply(`❌ That player isn't registered yet.`)
  }

  let noRoom = false
  await updatePlayer(db, targetId, (pl) => {
    pl.inventory = pl.inventory ?? []
    if (!hasInventoryRoom(pl, amount)) {
      noRoom = true
      return pl
    }
    for (let i = 0; i < amount; i++) pl.inventory.push(item.id)
  })

  if (noRoom) {
    const fresh = getPlayer(db, targetId)
    return reply(
      `❌ *${target.name}'s* ${inventoryFullMessage(fresh)}\n` +
      `Can't grant *${item.name} x${amount}* — not enough room.`,
    )
  }

  return reply(
    `✅ Granted *${item.name}${amount > 1 ? ` x${amount}` : ''}* to *${target.name}*.\n` +
    `It'll stack with any copies already in their inventory.`,
  )
}

/**
 * Resolves a character from an id or a (partial) name, so the owner can type
 * `.givecharacter gojo` or `.givecharacter "demon lord anastasia"` rather than
 * having to remember exact ids. Mirrors findCharacter() in plugins/character.js.
 */
function findCharacterFor(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  if (characterMap[q]) return characterMap[q]
  return characters.find(c => c.name.toLowerCase() === q)
    ?? characters.find(c => c.name.toLowerCase().includes(q))
    ?? null
}

/**
 * giveCharacter(ctx) — `.admin givecharacter <character> [@user]`
 *
 * Grants a character outright, bypassing every normal route (season spin, the
 * per-character *-spin plugins, gems). This is the only way to hand someone a
 * character directly, which is why it also has to take care of the ONE-OF-ONE
 * LOCK: for an `exclusive` character, ownership lives in two places, the
 * player's ownedCharacters array and the bot-wide exclusiveSpinWinners record
 * that every "claimed by X" line reads from. Setting only the first would give
 * them the character while the roster still advertised it as unclaimed, and the
 * spin plugins would happily award it to somebody else afterwards.
 *
 * Refuses rather than stealing when a one-of-one is already held by a different
 * player: reassigning is a deliberate two-step through takeCharacter() below,
 * so a typo in a name cannot silently strip an exclusive off its winner.
 */
export async function giveCharacter(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  const query = args.slice(1).filter(a => a && !a.startsWith('@')).join(' ')
  if (!query) {
    return reply(
      `❌ Usage: *${p}admin givecharacter <character> [@user]*\n` +
      `_Example: *${p}givecharacter gojo @player*_\n` +
      `_Roster ids: ${characters.slice(0, 6).map(c => c.id).join(', ')}, …_`,
    )
  }

  const character = findCharacterFor(query)
  if (!character) {
    return reply(`❌ No character matches *"${query}"*. See *${p}character* for the roster.`)
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) return reply(`❌ That player isn't registered yet.`)

  // The one-of-one lock is checked BEFORE the write so a blocked grant changes
  // nothing at all, rather than adding the character and failing the claim.
  if (character.exclusive) {
    const holderId = getExclusiveSpinWinner(db, character.id)
    if (holderId && holderId !== targetId) {
      const holder = getPlayer(db, holderId)
      return reply(
        `🔒 *${character.name}* is one-of-one and already claimed by *${holder?.name ?? 'another player'}*.\n` +
        `_Revoke it first: *${p}admin takecharacter ${character.id}* while replying to or mentioning them._`,
      )
    }
  }

  let already = false
  await updatePlayer(db, targetId, (pl) => {
    pl.ownedCharacters = pl.ownedCharacters ?? []
    if (pl.ownedCharacters.includes(character.id)) { already = true; return }
    pl.ownedCharacters.push(character.id)
    // Same serialized write, so the claim and the ownership entry can never
    // land apart. Returns false when someone beat us to it, which the
    // pre-check above has already ruled out for a different player.
    if (character.exclusive) claimExclusiveSpinForPlayer(db, character.id, targetId)
  })

  if (already) {
    return reply(
      `✅ *${target.name}* already owns *${character.emoji} ${character.name}*.\n` +
      `_Nothing changed. They equip it with *${p}character equip ${character.id}*._`,
    )
  }

  const claimNote = character.exclusive
    ? `\n🔒 The one-of-one claim now reads *claimed by ${target.name}* for everyone.`
    : ''
  return reply(
    `🎁 Granted *${character.emoji} ${character.name}* ${'⭐'.repeat(character.stars ?? 1)} to *${target.name}*.\n` +
    `✨ Ability: *${character.ability?.name ?? 'none'}*${claimNote}\n\n` +
    `_They equip it with *${p}character equip ${character.id}*._`,
  )
}

/**
 * takeCharacter(ctx) — `.admin takecharacter <character> [@user]`
 *
 * The undo for giveCharacter, and the only way to move a one-of-one to a
 * different player. Three things have to come apart together:
 *   1. the ownedCharacters entry,
 *   2. the equipped slot AND its stat bonuses, if they had it equipped — a bare
 *      delete would leave the bonuses banked on their stats permanently, and
 *      leave Shunya's statusImmune flag set on someone no longer holding it,
 *   3. the bot-wide one-of-one claim, so the roster stops naming them.
 */
export async function takeCharacter(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  const query = args.slice(1).filter(a => a && !a.startsWith('@')).join(' ')
  if (!query) return reply(`❌ Usage: *${p}admin takecharacter <character> [@user]*`)

  const character = findCharacterFor(query)
  if (!character) {
    return reply(`❌ No character matches *"${query}"*. See *${p}character* for the roster.`)
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) return reply(`❌ That player isn't registered yet.`)

  let owned = false
  let wasEquipped = false
  let releasedFrom = null
  await updatePlayer(db, targetId, (pl) => {
    pl.ownedCharacters = pl.ownedCharacters ?? []
    const at = pl.ownedCharacters.indexOf(character.id)
    if (at === -1) return
    owned = true
    pl.ownedCharacters.splice(at, 1)

    if (pl.equippedCharacter === character.id) {
      wasEquipped = true
      if (character.statBonuses) applyEquipmentBonus(pl, character, -1)
      pl.equippedCharacter = null
      syncEmptyVesselFlag(pl)
    }
    if (character.exclusive) releasedFrom = releaseExclusiveSpinLock(db, character.id)
  })

  if (!owned) {
    return reply(`ℹ️ *${target.name}* does not own *${character.name}*. Nothing changed.`)
  }
  return reply(
    `🗑️ Removed *${character.emoji} ${character.name}* from *${target.name}*.\n` +
    (wasEquipped ? `_It was equipped, so its stat bonuses were stripped back off._\n` : '') +
    (releasedFrom ? `🔓 The one-of-one claim is free again and can be granted to someone else.\n` : '') +
    `_Grant it onward with *${p}admin givecharacter ${character.id}*._`,
  )
}

export async function setLevel(ctx) {
  const { args, reply, db } = ctx
  const p = config.prefix
  const level = Math.floor(Number(args[1]))
  if (!level || level <= 0 || level > 100) {
    return reply(`❌ Usage: *${p}admin setlevel <level> [@user]*`)
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) {
    return reply(`❌ That player isn't registered yet.`)
  }

  await updatePlayer(db, targetId, (pl) => {
    const state = ensureStatPoints(pl)
    const { maxHp, maxMp, ...canonical } = getTotalStats(pl.classId, pl.raceId, level)
    const cap = statPointCap(level, pl)
    const spent = Math.min(state.spent ?? 0, cap)
    let remainingSpent = spent
    const stats = Object.fromEntries(
      ['str', 'agi', 'int', 'def', 'lck'].map((key) => {
        const allocation = Math.min(
          state.allocations?.[key] ?? 0,
          Math.max(0, remainingSpent),
        )
        remainingSpent -= allocation
        return [key, canonical[key] + allocation]
      }),
    )
    pl.level  = level
    pl.stats  = stats
    pl.maxHp  = maxHp
    pl.maxMp  = maxMp
    pl.hp     = maxHp
    pl.mp     = maxMp
    pl.baseStats = { ...stats, maxHp, maxMp }
    pl.statPoints.earned = cap
    pl.statPoints.spent = spent
    pl.statPoints.unallocated = cap - spent
  })

  return reply(`✅ Set *${target.name}*'s level to *${level}* and recalculated stats.`)
}

/**
 * reconcileLevels — the make-good for the banked-XP bug.
 *
 * player.xp is CUMULATIVE and is only turned into levels by applyLevelUps(),
 * which has to be CALLED. Several XP grant sites (PvP wins, roaming, Battle Pass
 * XP tiers) used to add to player.xp without calling it, so a player could farm
 * past the next xpTable threshold and simply never level: no notification, and
 * profile.js rendered the leftover as a negative "to next". Those call sites are
 * fixed now, but players who already banked XP while it was broken are still
 * sitting on levels they earned and never received. This hands them over.
 *
 * applyLevelUps is a catch-up while-loop, so it awards EVERY owed level in one
 * pass, and it full-heals (hp = maxHp, mp = maxMp) on each one. That is why this
 * doubles as the fix for a player left on low HP/MP: crossing even one owed
 * level restores them. Someone with nothing owed is a no-op, so this is safe to
 * run repeatedly and safe to run bot-wide.
 *
 *   admin reconcile          just the @mentioned/replied player (or yourself)
 *   admin reconcile all     every registered player
 */
export async function reconcileLevels(ctx) {
  const { args, reply, db } = ctx
  const wantsAll = (args[1] ?? '').toLowerCase() === 'all'

  if (wantsAll) {
    const levelled = []
    await updateAllPlayers(db, (users) => {
      let changed = false
      for (const pl of Object.values(users ?? {})) {
        if (!pl || typeof pl.level !== 'number') continue
        const before = pl.level
        const lvl = applyLevelUps(pl, levelsData, classes, races, getTotalStats)
        if (lvl.levelled) {
          levelled.push(`${pl.name ?? 'Unknown'}: ${before} → ${pl.level}`)
          changed = true
        }
      }
      return changed
    })

    if (!levelled.length) {
      return reply(`✅ Swept every player. Nobody was owed a level, so nothing changed.`)
    }
    // Capped so a large save can't blow the message length limit.
    const shown = levelled.slice(0, 25)
    return reply(
      `✅ *Level reconcile complete.*\n` +
      `Handed out owed levels to *${levelled.length}* player${levelled.length === 1 ? '' : 's'}, ` +
      `and each one was healed to full as part of levelling.\n\n` +
      `${shown.map((l) => `• ${l}`).join('\n')}` +
      (levelled.length > shown.length ? `\n_...and ${levelled.length - shown.length} more._` : ''),
    )
  }

  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) return reply(`❌ That player isn't registered yet.`)

  let result = null
  await updatePlayer(db, targetId, (pl) => {
    const before = pl.level
    const lvl = applyLevelUps(pl, levelsData, classes, races, getTotalStats)
    result = {
      before,
      after: pl.level,
      msgs: lvl.msgs,
      xp: pl.xp ?? 0,
      hp: pl.hp,
      maxHp: pl.maxHp,
      mp: pl.mp,
      maxMp: pl.maxMp,
    }
  })

  if (result.before === result.after) {
    return reply(
      `ℹ️ *${target.name}* is not owed a level. Level *${result.before}*, ✨${result.xp} XP banked.\n` +
      `_Nothing changed. To top up HP/MP instead, use *${config.prefix}admin heal*._`,
    )
  }
  return reply(
    `✅ *${target.name}* collected owed levels: *${result.before} → ${result.after}*.\n` +
    `❤️ ${result.hp}/${result.maxHp}  💧 ${result.mp}/${result.maxMp} _(levelling heals to full)_\n\n` +
    `${result.msgs.join('\n')}`,
  )
}

/**
 * healPlayer — restore a player's current HP/MP to their maximum, and nothing
 * else. Deliberately narrow: it touches hp/mp only, never maxHp/maxMp, stats,
 * level or XP, so it cannot be used to sidestep the stat rules.
 *
 * This exists because dying sets current hp/mp to 50% of max (handleDeath in
 * lib/combat-handlers.js) and a player who cannot afford or reach the inn has no
 * other way back to full. Note what death does NOT do: it never permanently cuts
 * maxHp/maxMp. It floors stats UP to the baseStats anchor, so there is no
 * "deducted max HP" to give back, only current HP to refill.
 */
export async function healPlayer(ctx) {
  const { reply, db } = ctx
  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) return reply(`❌ That player isn't registered yet.`)

  let after = null
  await updatePlayer(db, targetId, (pl) => {
    pl.hp = pl.maxHp
    pl.mp = pl.maxMp
    after = { hp: pl.hp, maxHp: pl.maxHp, mp: pl.mp, maxMp: pl.maxMp }
  })

  return reply(
    `❤️‍🩹 *${target.name}* restored to full.\n` +
    `❤️ HP: *${after.hp}/${after.maxHp}*\n` +
    `💧 MP: *${after.mp}/${after.maxMp}*`,
  )
}

export async function resetPlayer(ctx) {
  const { reply, db } = ctx
  const targetId = resolveTargetId(ctx)
  const target = getPlayer(db, targetId)
  if (!target) {
    return reply(`❌ That player isn't registered yet — nothing to reset.`)
  }

  // Routed through updateAllPlayers (the same shared write queue as
  // updatePlayer) instead of a raw db.write() — this used to write out
  // whatever db.data happened to be in memory at that moment, which
  // could silently discard an unrelated player's in-flight purchase or
  // stat change if the two writes overlapped.
  await updateAllPlayers(db, (users) => {
    if (!users[targetId]) return false
    delete users[targetId]
    return true
  })

  return reply(`✅ Wiped *${target.name}*'s save. They'll need to *${config.prefix}register* again.`)
}
