/**
 * profile — display the registered player's full stats.
 * Usage: <prefix>me                                    — short summary view
 *          (name, title, bio, rank, level, wallet, waifu, race)
 *        <prefix>profile (or <prefix>stats)             — your own full profile
 *        <prefix>profile @player (or reply)              — short public view:
 *          name, level, rank, and bio only — no full stats/gear/wallet.
 *
 * IMAGES: the composited profile card (lib/profile-card-render.mjs) is rendered
 * ONLY by <prefix>me. Every view in this file sends the player's own pfp
 * instead, via replyWithPfp below, so .me and .profile are visually distinct.
 */
import { config } from '../config.js'
import { fmtGems } from '../lib/format.js'
import { fmtMonds } from '../lib/monds.js'
import { rarityStars } from '../lib/rarity.js'
import { classes, races, levelsData, locationsMap, allItems, abilities as abilityDefs, premiumAbilityMap } from '../lib/game-data.js'
import { hpBar } from '../lib/combat-engine.js'
import { getRankForLevel } from '../lib/rank-engine.js'
import { isAsleep } from '../lib/sleep-engine.js'
import { hungerBar } from '../lib/hunger-engine.js'
import { formatTimeLeft } from '../lib/time-format.js'
import { getInventoryCap } from '../lib/inventory-limits.js'
import { beastMap } from '../lib/game-data.js'
import { getBeastStats } from '../lib/beast-engine.js'
import { extractTarget } from '../lib/group-helpers.js'
import { getPlayer } from '../lib/player-repo.js'
import { isPremiumActive } from '../lib/premium.js'
import { hasMod } from '../lib/mods.js'
import { getWaifu, tierStars } from '../lib/card-engine.js'
import { ensureStatPoints, statPointCap } from '../lib/stat-progression.js'
import { isReborn, playerLevelCap } from '../lib/reborn-engine.js'
import { endStatusBadge } from '../lib/end-event.js'
import { getGuildTag } from '../lib/guild-repo.js'

/**
 * Sends a player's OWN profile picture, never the composited profile card.
 *
 * The rendered card is now exclusive to `.me` (plugins/me.js) so the two
 * commands don't look identical: `.me` is the card, `.profile` is your plain
 * pfp with the profile text as the caption. renderProfileCard is deliberately
 * not imported here any more.
 *
 * Only http(s) pfps can be sent — a player's pfp is an ImgBB URL, but legacy
 * records can still hold a local filesystem path, and an unset pfp is empty.
 * Both of those, and any send failure, fall back to plain text so a missing
 * image can never swallow the whole reply.
 */
async function replyWithPfp(ctx, target, caption) {
  const pfp = typeof target?.pfp === 'string' ? target.pfp.trim() : ''
  if (!/^https?:\/\//i.test(pfp)) return ctx.reply(caption)
  try {
    return await ctx.replyImage(pfp, caption)
  } catch (err) {
    return ctx.reply(caption)
  }
}

/**
 * Short public view for `.profile @player` — name, level, rank, bio only.
 * Deliberately omits stats/gear/wallet/location so players can't scout
 * each other's full loadout via mention.
 */
async function replyShortProfile(ctx, targetId) {
  const { db, reply, replyImage } = ctx
  const target = getPlayer(db, targetId)
  if (!target) {
    return reply(`❌ That player isn't registered yet.`)
  }

  const rank = getRankForLevel(target.level)
  const bioLine = target.bio ? `📝 _${target.bio}_` : `📝 _(no bio set)_`
  const targetTag = getGuildTag(target)
  const targetName = targetTag ? `${targetTag} ${target.name}` : target.name

  const shortText =
    `👤 *${targetName}*\n` +
    `🏅 Level ${target.level}  •  ${rank.emoji} ${rank.title}\n` +
    bioLine

  // Send the target's own pfp, not a rendered card. The composited card is
  // exclusive to .me. Text stays restricted to name/level/rank/bio so nobody
  // can scout another player's wallet or loadout off a mention.
  return replyWithPfp(ctx, target, shortText)
}

export default {
  name: 'profile',
  aliases: [],
  category: 'account',
  requiresPlayer: true,
  description: 'View your full player profile and stats (or <prefix>profile @player for a short view)',

  async run(ctx) {
    // .profile @player or a reply → short public view of someone else.
    const mentionedId = extractTarget(ctx)
    if (mentionedId && mentionedId !== ctx.from) {
      return replyShortProfile(ctx, mentionedId)
    }

    const p = ctx.player
    const pr = config.prefix
    const statPoints = ensureStatPoints(p)

    const className = classes[p.classId]?.name  ?? p.classId
    const raceName  = races[p.raceId]?.name     ?? p.raceId

    const nextLevel   = p.level + 1
    const nextLevelXp = levelsData.xpTable[String(nextLevel)]
    // Clamped at 0. player.xp is CUMULATIVE, so any path that banks XP without
    // running applyLevelUps leaves xp past the next threshold and this line used
    // to render as a negative ("-17 to next"). The real fix is at the grant
    // sites, but the display must never show a negative regardless — same clamp
    // lib/rank-engine.js already uses. "ready" is shown instead, because at that
    // point the level genuinely is owed.
    const xpToNext    = nextLevelXp != null ? nextLevelXp - p.xp : null
    const xpNeeded    = nextLevelXp == null
      ? 'MAX'
      : xpToNext > 0 ? `${xpToNext} to next` : 'level up ready'

    // Equipped (5 slots)
    const eq     = p.equipped ?? {}
    const slots  = ['weapon', 'offhand', 'helmet', 'chestplate', 'boots', 'relic']
    const eqLines = slots.map(slot => {
      const id    = eq[slot]
      const item  = id ? allItems.find(i => i.id === id) : null
      const name  = item ? item.name : '— empty —'
      // Star-rating badge instead of a raw text label like "[legendary]" —
      // matches how rarity is shown everywhere else (see lib/rarity.js).
      const rar   = item ? ` ${rarityStars(item.rarity)}` : ''
      return `  ${slotEmoji(slot)} ${padSlot(slot)} ${name}${rar}`
    }).join('\n')

    // Abilities — slot display. equippedAbilities resolves against
    // data/abilities.json (now includes Crown's Favor, the standard premium
    // grant). The one-of-one premium ability lives in player.premiumAbility
    // (its own engine, lib/premium-abilities.js) rather than the slot list, so
    // it gets its own line under the slots — spin winners used to look at
    // "Abilities (0/1)" and think their purchase never granted the ability.
    const abilitySlots      = p.abilitySlots ?? 1
    const equippedAbilities = p.equippedAbilities ?? []
    const abilityLines = Array.from({ length: abilitySlots }, (_, i) => {
      const id  = equippedAbilities[i]
      const ab  = id ? abilityDefs.find(a => a.id === id) : null
      if (!ab) return `  ☆☆☆☆☆ — empty slot —`
      const rar = rarityStars(ab.rarity)
      const cd  = ab.type === 'active' ? `, ${ab.cooldownTurns}-turn CD` : ''
      return `  ${rar} *${ab.name}* [${ab.rarity}, ${ab.type}${cd}]`
    }).join('\n')
    const premiumAbilityDef = p.premiumAbility ? premiumAbilityMap[p.premiumAbility] : null
    const premiumAbilityLine = premiumAbilityDef
      ? `\n  👑 *${premiumAbilityDef.name}* _[premium one-of-one]_`
      : ''

    // Location / dungeon status
    let locationLine = `📍 *Location:* ${locationsMap[p.location]?.name ?? p.location ?? 'Astral Town'}`
    if (p.inDungeon && p.dungeonFloor) {
      locationLine += ` — Floor *${p.dungeonFloor}*`
    }
    if (p.inBattle && (p.battleState?.enemy || p.battleState?.type === 'pvp')) {
      locationLine += p.battleState?.type === 'pvp' ? `  🥊 _(in a duel)_` : `  ⚔️ _(in battle)_`
    }
    if (isAsleep(p)) {
      locationLine += `  😴 _(wakes up in ${formatTimeLeft(p.sleepUntil - Date.now())})_`
    }

    // Stamina
    const st = p.stamina ?? { current: 30, max: 30 }
    const stLine = `⚡ Stamina: ${st.current}/${st.max}`

    // Wallet
    const w = p.wallet ?? {}

    // Skills count
    const skillCount = p.skills?.length ?? 0

    // Hunter rank (Solo-Leveling-style tier derived from level)
    const rank = getRankForLevel(p.level)

    // Summon Beast — active beast summary (see lib/beast-engine.js)
    const activeBeastEntry = p.activeBeast
      ? (p.summonedBeasts ?? []).find((b) => b.beastId === p.activeBeast)
      : null
    const activeBeastDef = activeBeastEntry ? beastMap[activeBeastEntry.beastId] : null
    const beastLine = activeBeastDef
      ? `${activeBeastDef.emoji} *${activeBeastDef.name}* _(Lv.${getBeastStats(activeBeastDef, activeBeastEntry.cp).level})_`
      : `— none — _(${config.prefix}summon)_`

    const bioLine = p.bio ? `📝 _${p.bio}_\n\n` : ''

    // The End's aura — shown with the stats because that's where a −40% cut is
    // actually felt. Null whenever the event isn't running (lib/end-event.js).
    const endLine = endStatusBadge(ctx.db, p)

    const waifuCard = getWaifu(p)
    const waifuLine = waifuCard
      ? `${tierStars(waifuCard.tier)} *${waifuCard.title}* _(${waifuCard.series})_`
      : `— none set — _(${config.prefix}waifu)_`

    const pTag = getGuildTag(p)
    const pDisplayName = pTag ? `${pTag} ${p.name}` : p.name

    const fullText =
      `👤 *${pDisplayName}*` + (isPremiumActive(p) ? `  👑 *PREMIUM*` : '') + (isReborn(p) ? `  🌟 *REBORN*` : '') + (hasMod(p, 'cosmetic_badge') ? `  🧩` : '') + (p.title ? `  [${p.title}]` : '') + `\n` +
      `⚔️ ${className}  |  🧬 ${raceName}\n\n` +
      bioLine +

      `${rank.emoji} *${rank.title}* _(${rank.epithet})_\n` +
      `🏅 *Level ${p.level}*/${playerLevelCap(p)}  ✨ XP: ${p.xp}  _(${xpNeeded})_\n` +
      `❤️ ${hpBar(p.hp, p.maxHp)}\n` +
      `💧 MP: ${p.mp}/${p.maxMp}\n` +
      stLine + `\n` +
      hungerBar(p) + `\n\n` +

      `📊 *Stats*\n` +
      (endLine ? `${endLine}\n` : '') +
      `  💪 STR ${p.stats.str}  🏃 AGI ${p.stats.agi}  🧠 INT ${p.stats.int}\n` +
      `  🛡️ DEF ${p.stats.def}  🍀 LCK ${p.stats.lck}\n\n` +
      `✨ *Stat Points:* ${statPoints.unallocated} unallocated / ${statPoints.earned}/${statPointCap(p.level, p)} earned\n` +
      `_${pr}stats add <stat> <amount> · ${pr}train [amount]_ \n\n` +

      `💰 *Wallet*\n` +
      `  ☀️ Solars: ${w.solars ?? 0}  💎 Gems: ${fmtGems(w.gems ?? 0)}  🪙 Monds: ${fmtMonds(w.monds ?? 0)}\n` +
      `  ✨ Season Points: ${p.seasonPoints ?? 0}  🔒 Vault: ${w.vault ?? 0}\n\n` +

      `🐲 *Active Beast:* ${beastLine}\n\n` +

      `💘 *Waifu:* ${waifuLine}\n\n` +

      `🗡️ *Equipped*\n${eqLines}\n\n` +

      `✨ *Abilities (${equippedAbilities.length}/${abilitySlots} slots)*\n${abilityLines}${premiumAbilityLine}\n\n` +

      `🎒 Inventory: ${p.inventory?.length ?? 0}/${getInventoryCap(p)}\n` +
      `✨ Skills: ${skillCount} learned\n\n` +

      locationLine +
      `\n_Type *${pr}inventory* · *${pr}skills* · *${pr}dungeon* to continue._`

    // Your plain pfp, with the full stat text as the caption. The composited
    // card belongs to .me only.
    await replyWithPfp(ctx, p, fullText)
  },
}


function slotEmoji(slot) {
  return { weapon: '⚔️', offhand: '🛡️', helmet: '🪖', chestplate: '🧥', boots: '👢', relic: '💍' }[slot] ?? '•'
}
function padSlot(slot) {
  const labels = { weapon: 'Weapon    ', offhand: 'Offhand   ', helmet: 'Helmet    ', chestplate: 'Chestplate', boots: 'Boots     ', relic: 'Relic     ' }
  return labels[slot] ?? slot
}
