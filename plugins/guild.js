/**
 * guild.js — five fixed guilds based in Astral Town.
 *
 * Nobody "owns" a guild. Anyone can join one of the five. Leadership is
 * decided automatically: whoever in the guild has conquered the most
 * dungeon floors *since joining* is the leader. Leadership can change hands
 * the moment someone else in the guild out-conquers the current leader.
 *
 * TWO LADDERS, KEPT APART (see lib/guild-engine.js's header). Conquest
 * decides who leads. The treasury decides what the guild *is* — donations
 * raise a guild through Outpost → Hall → Bastion → Citadel, unlocking perks
 * for every member. Money buys comfort, never the crown.
 *
 * The current leader may:
 *   - upload the guild's banner / pfp image
 *   - set the message of the day
 *   - kick members out of the guild
 *
 * Usage:
 *   <prefix>guild                     — list all 5 guilds + member counts + leader
 *   <prefix>guild info <name>         — guild details, banner/pfp, member list
 *   <prefix>guild join <name>         — join a guild (leaves your current one)
 *   <prefix>guild leave               — leave your current guild
 *   <prefix>guild members [name]      — member list ranked by contribution
 *   <prefix>guild donate <amount>     — fund the treasury, raise your role
 *   <prefix>guild treasury [name]     — vault, tier progress, top donors
 *   <prefix>guild perks [name]        — what the guild's tier grants members
 *   <prefix>guild top                 — all 5 guilds ranked by standing
 *   <prefix>guild motd <text>         — (leader only) set the message of the day
 *   <prefix>guild kick <player>       — (leader only) remove a member
 *   <prefix>guild banner              — (leader only) attach/reply to an image to set it
 *   <prefix>guild pfp                 — (leader only) attach/reply to an image to set it
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { mkdir, writeFile, access } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join } from 'path'
import { config, logger } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  guildDefs,
  findGuildByQuery,
  getGuildDef,
  getGuildMembers,
  getGuildLeader,
  conquestSinceJoining,
  totalFloorsConquered,
  ensureGuildsInitialized,
  getGuildRecord,
  getGuildTag,
} from '../lib/guild-repo.js'
import {
  guildTier,
  nextGuildTier,
  treasuryToNextTier,
  contributionOf,
  roleFor,
  guildPower,
  rankMembers,
  shortSolars,
  GUILD_TIERS,
  MIN_DONATION,
  MERIT_PER_FLOOR,
} from '../lib/guild-engine.js'
import { sendImageTo } from '../lib/image.js'

import { getGroupMetadata } from '../lib/group-helpers.js'
import { pushNotification } from '../lib/notification-repo.js'

import { WAR_FORMATS } from '../lib/guild-war-engine.js'
import {
  MATCH_TYPES,
  MATCH_TYPE_IDS,
  DOMINANCE_TIERS,
  GUILD_WAR_TIERS,
  WAR_KIT_TIERS,
  createWarChallenge,
  acceptWarChallenge,
  cancelWar,
  ensureWarState,
  ensureDominance,
  dominanceTierFor,
  guildWarTierFor,
  ensureGuildWarStats,
  findWarByStatus,
  findLiveWarBetween,
  guildBusy,
  warsForGuild,
  getWar,
  startNextPairing,
  sweepGuildWars,
  canClaimPairing,
  settleWalkover,
  warBoard,
  warKitLabel,
  formatName,
} from '../lib/guild-war-repo.js'

/**
 * Official guild art (2026-09-21 owner-provided drop, keyed by guild id).
 * Shown on `.guild info` in PREFERENCE to any leader-uploaded banner: the
 * owner's art is the fixed branding for each of the five guilds. A guild
 * without an entry here still falls back to the leader's uploaded banner
 * (the `.guild banner` upload feature is preserved for that case).
 * Filenames resolve through lib/image.js's remote map.
 */
const GUILD_INFO_IMAGES = {
  astral_vanguard: 'guild-astral-vanguard.jpg',
  shadow_covenant: 'guild-shadow-covenant.jpg',
  gilded_order:    'guild-gilded-order.jpg',
  stormbreakers:   'guild-stormbreakers.jpg',
  emberwake:       'guild-emberwake.jpg',
}

export default {
  name:           'guild',
  aliases:        ['guilds'],
  category:       'social',
  requiresPlayer: false,
  description:    'Join, view, and manage Astral Town guilds',
  subcommands: [
    { cmd: 'join <name>', desc: 'sign up with one of the five' },
    { cmd: 'board', desc: 'today\'s three guild slips, the same list as .board' },
    { cmd: 'info <name>', desc: 'details, banner, and the member roll' },
    { cmd: 'donate <amount>', desc: 'fund the treasury and raise your role' },
    { cmd: 'treasury', desc: 'the vault, tier progress and top donors' },
    { cmd: 'perks', desc: 'what your guild tier grants every member' },
    { cmd: 'top', desc: 'all five guilds ranked by standing' },
    { cmd: 'motd <text>', desc: 'leader only — set the message of the day' },
    { cmd: 'kick <player>', desc: 'leader only — remove a member' },
    { cmd: 'war challenge <guild> <size> <format> @champs', desc: 'leader declares a real player-vs-player Guild War (1v1…4v4)' },
    { cmd: 'war accept @champs', desc: 'rival leader names their champions and starts the pairings' },
    { cmd: 'war status', desc: 'the live war board — scores, pairings, performance' },
    { cmd: 'war claim / forfeit / decline', desc: 'walkover, throw a pairing, or refuse a challenge' },
    { cmd: 'war leaderboard', desc: 'dominance score and the highest-tier players' },
    { cmd: 'war kits / record', desc: 'the five Preset 5 tiers · your guild\'s war history' },
  ],

  async run(ctx) {
    const { args, reply } = ctx
    const p = config.prefix
    const sub = args[0]?.toLowerCase()

    await ctx.db.read()
    await ensureGuildsInitialized(ctx.db)
    const allUsers = Object.values(ctx.db.data.users ?? {})

    if (!sub) return listGuilds(ctx, allUsers)
    if (sub === 'info')    return showGuildInfo(ctx, allUsers, args.slice(1).join(' '))
    if (sub === 'members') return showGuildInfo(ctx, allUsers, args.slice(1).join(' '), true)
    if (sub === 'join')    return joinGuild(ctx, args.slice(1).join(' '))
    if (sub === 'leave')   return leaveGuild(ctx)
    if (sub === 'kick')    return kickMember(ctx, allUsers, args.slice(1).join(' '))
    if (sub === 'banner')  return uploadImage(ctx, allUsers, 'banner')
    if (sub === 'pfp')     return uploadImage(ctx, allUsers, 'pfp')
    if (sub === 'donate' || sub === 'fund')     return donate(ctx, args[1])
    if (sub === 'treasury' || sub === 'vault' || sub === 'bank') return showTreasury(ctx, allUsers, args.slice(1).join(' '))
    if (sub === 'perks' || sub === 'tier' || sub === 'tiers')    return showPerks(ctx, allUsers, args.slice(1).join(' '))
    if (sub === 'top' || sub === 'rank' || sub === 'ranking' || sub === 'leaderboard') return guildTop(ctx, allUsers)
    if (sub === 'motd' || sub === 'notice')     return setMotd(ctx, allUsers, args.slice(1).join(' '))
    if (sub === 'war' || sub === 'wars' || sub === 'clash') return guildWarDispatch(ctx, allUsers, args.slice(1))
    // The job board, not the war board. .guild war board already left above.
    // .guild notice stays the motd, claimed further up.
    if (sub === 'board' || sub === 'jobs' || sub === 'slips') {
      const { runBoard } = await import('./board.js')
      return runBoard(ctx, args.slice(1))
    }

    return reply(
      `❓ Unknown guild command.\n\n` +
      `*${p}guild*: list guilds\n` +
      `*${p}guild info <name>*: guild details\n` +
      `*${p}guild join <name>*: join a guild\n` +
      `*${p}guild board*: today's three slips\n` +
      `*${p}guild leave*: leave your guild\n` +
      `*${p}guild donate <amount>*: fund the treasury\n` +
      `*${p}guild treasury*: vault and tier progress\n` +
      `*${p}guild perks*: what your tier grants\n` +
      `*${p}guild top*: rank all five guilds\n` +
      `*${p}guild war*: declare real player-vs-player wars (1v1 up to 4v4)\n` +
      `*${p}guild motd <text>*: (leader) set the notice\n` +
      `*${p}guild kick <player>*: (leader) remove a member\n` +
      `*${p}guild banner* / *${p}guild pfp*: (leader) attach an image`,
    )
  },
}

function listGuilds(ctx, allUsers) {
  const p = config.prefix
  const lines = guildDefs.map(g => {
    const members = getGuildMembers(g.id, allUsers)
    const leader  = getGuildLeader(g.id, allUsers)
    const record  = getGuildRecord(ctx.db, g.id)
    const tier    = guildTier(record)
    const leaderLine = leader ? `👑 ${leader.name}` : '_no members yet_'
    return (
      `${g.emoji} *${g.name}*  _(${members.length} member${members.length === 1 ? '' : 's'})_\n` +
      `   ${leaderLine}\n` +
      `   🏛️ ${tier.name}  ·  ☀️ ${shortSolars(record.treasury)} treasury`
    )
  })

  return ctx.reply(
    `🏰 *ASTRAL TOWN GUILDS*\n\n${lines.join('\n\n')}\n\n` +
    `_Leadership is earned, not given. The member who's conquered the most floors since joining leads._\n` +
    `_The treasury is separate: donations raise the guild's tier and buy perks for everyone, never the crown._\n` +
    `_The job board is the same in every hall. Sera nails three slips at dawn._\n\n` +
    `*${p}guild info <name>* · *${p}guild join <name>* · *${p}guild board* · *${p}guild top*`
  )
}

function resolveGuildOrOwn(query, player) {
  if (query) return findGuildByQuery(query)
  if (player?.guildId) return getGuildDef(player.guildId)
  return null
}

/**
 * True if this stored image path can actually be sent.
 *
 * Guild banners/pfps are written to `media/guilds/<id>/` as relative paths, but
 * the path outlives the file: a redeploy, a media cleanup, or moving db.json
 * between machines leaves the record pointing at nothing. A remote URL is
 * assumed sendable — only local paths are checked, since only those can be
 * checked cheaply.
 */
async function imageIsSendable(p) {
  if (!p) return false
  if (/^https?:\/\//i.test(p)) return true
  try {
    await access(p, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function showGuildInfo(ctx, allUsers, query, membersOnly = false) {
  const p = config.prefix
  const guild = resolveGuildOrOwn(query, ctx.player)

  if (!guild) {
    const list = guildDefs.map(g => `  • ${g.emoji} *${g.name}*`).join('\n')
    return ctx.reply(
      query
        ? `❌ No guild matching *${query}*.\n\n${list}`
        : `❓ Specify a guild, or join one first.\n\n${list}\n\nUsage: *${p}guild info <name>*`,
    )
  }

  const members = getGuildMembers(guild.id, allUsers)
  const leader  = getGuildLeader(guild.id, allUsers)
  const guildRecord = getGuildRecord(ctx.db, guild.id)
  const tier = guildTier(guildRecord)

  const ranked = rankMembers(guildRecord, members)
    .map((entry, i) => {
      const m = entry.player
      const tag = getGuildTag(guild.id)
      const crown = leader?.id === m.id ? ' 👑' : ''
      return (
        `  ${i + 1}. ${entry.role.emoji} ${tag} *${m.name}*${crown}  _(Lv.${m.level})_\n` +
        `      ${entry.role.name} · ${conquestSinceJoining(m)} floor(s) · ☀️ ${shortSolars(entry.donated)} donated`
      )
    })
    .join('\n') || '  _No members yet._'

  if (membersOnly) {
    return ctx.reply(
      `${guild.emoji} *${guild.name} — MEMBERS*\n\n${ranked}\n\n` +
      `_Role comes from contribution: solars donated plus ${MERIT_PER_FLOOR.toLocaleString()} per floor cleared since joining._`,
    )
  }

  const motdBlock = guildRecord.motd
    ? `📜 _"${guildRecord.motd}"_\n\n`
    : ''

  const caption =
    `${guild.emoji} *${guild.name}*\n` +
    `📍 Astral Town  ·  🏛️ *${tier.name}*\n\n` +
    motdBlock +
    `${guild.description}\n\n` +
    `👥 *${members.length}* member(s)\n` +
    `👑 Leader: ${leader ? leader.name : '_none yet_'}\n` +
    `☀️ Treasury: *${guildRecord.treasury.toLocaleString()}*\n` +
    `📊 Standing: *${guildPower(guildRecord, members).toLocaleString()}*\n\n` +
    `*Members (ranked by contribution):*\n${ranked}\n\n` +
    `_*${p}guild join ${guild.name}* to sign up · *${p}guild perks* for what the tier grants._`

  // Guild badge (pfp) is shown as its own small image when set, separate
  // from the banner, since WhatsApp only lets one caption per image.
  if (guildRecord?.pfpPath && await imageIsSendable(guildRecord.pfpPath)) {
    await ctx.replyImage(guildRecord.pfpPath, `${guild.emoji} *${guild.name}* — guild badge`).catch(() => {})
  }

  // Official art first (see GUILD_INFO_IMAGES). sendImageTo degrades to the
  // plain caption if the image can't be fetched, so the info text always
  // lands — the same "never the only delivery attempt" rule as the banner
  // path below.
  const officialImage = GUILD_INFO_IMAGES[guild.id]
  if (officialImage) {
    return sendImageTo(ctx, officialImage, caption)
  }

  // The banner carries the caption, so it must NEVER be the only delivery
  // attempt: bannerPath is a path on the box that wrote it, and the file goes
  // away on redeploy, a media wipe, or a db.json copied between machines.
  // Baileys then rejects with ENOENT, dispatch() swallows it into pm2-err.log,
  // and the player sees only the reaction with no text at all — the exact
  // "guild info doesn't work, it just reacts" report. Fall through to text.
  if (guildRecord?.bannerPath && await imageIsSendable(guildRecord.bannerPath)) {
    try {
      return await ctx.replyImage(guildRecord.bannerPath, caption)
    } catch (err) {
      logger.error({ err: err.message, guild: guild.id, path: guildRecord.bannerPath },
        'Guild banner failed to send — falling back to text')
    }
  }
  return ctx.reply(caption)
}

async function joinGuild(ctx, query) {
  const p = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)

  const guild = findGuildByQuery(query)
  if (!guild) {
    const list = guildDefs.map(g => `  • ${g.emoji} *${g.name}*`).join('\n')
    return ctx.reply(`❌ No guild matching *${query}*.\n\n${list}\n\nUsage: *${p}guild join <name>*`)
  }

  let message = null
  await updatePlayer(ctx.db, ctx.from, player => {
    if (player.guildId === guild.id) {
      message = `⚠️ You're already in *${guild.name}*.`
      return player
    }
    player.guildId           = guild.id
    player.guildJoinedAt     = Date.now()
    player.guildJoinBaseline = totalFloorsConquered(player)
    message =
      `✅ Welcome to ${guild.emoji} *${guild.name}*!\n\n` +
      `_${guild.oath || 'The clerk writes your name in the hall book.'}_\n\n` +
      `Conquer floors to climb the ranks. The top conqueror leads the guild.\n` +
      `The board is already up: *${p}guild board*.`
    return player
  })

  return ctx.reply(message)
}

async function leaveGuild(ctx) {
  const p = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)

  let message = null
  await updatePlayer(ctx.db, ctx.from, player => {
    if (!player.guildId) {
      message = `⚠️ You're not in a guild.`
      return player
    }
    const guild = getGuildDef(player.guildId)
    player.guildId = null
    player.guildJoinedAt = null
    player.guildJoinBaseline = 0
    message = `👋 You've left ${guild?.emoji ?? ''} *${guild?.name ?? 'your guild'}*.`
    return player
  })

  return ctx.reply(message)
}

async function kickMember(ctx, allUsers, targetName) {
  const p = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)
  if (!ctx.player.guildId) return ctx.reply(`❌ You're not in a guild.`)
  if (!targetName) return ctx.reply(`Usage: *${p}guild kick <player name>*`)

  const expectedGuildId = ctx.player.guildId
  const leader = getGuildLeader(expectedGuildId, allUsers)
  if (leader?.id !== ctx.player.id) {
    return ctx.reply(`❌ Only the guild leader can kick members. Current leader: *${leader?.name ?? 'none'}*.`)
  }

  const target = getGuildMembers(expectedGuildId, allUsers)
    .find(m => m.name.toLowerCase() === targetName.toLowerCase() || m.name.toLowerCase().includes(targetName.toLowerCase()))

  if (!target) return ctx.reply(`❌ No member named *${targetName}* in your guild.`)
  if (target.id === ctx.player.id) return ctx.reply(`❌ You can't kick yourself — use *${p}guild leave* instead.`)

  const guild = getGuildDef(expectedGuildId)

  // Re-verify against fresh state right before mutating — closes the window
  // where the actor's leadership or the target's guild could have changed
  // between the check above and this write (e.g. target already left/was
  // kicked, or someone else out-conquered the actor in the meantime).
  await ctx.db.read()
  const freshUsers   = Object.values(ctx.db.data.users ?? {})
  const freshLeader  = getGuildLeader(expectedGuildId, freshUsers)
  if (freshLeader?.id !== ctx.player.id) {
    return ctx.reply(`❌ Leadership changed — *${freshLeader?.name ?? 'someone else'}* now leads this guild.`)
  }

  let message = null
  await updatePlayer(ctx.db, target.id, player => {
    if (player.guildId !== expectedGuildId) {
      message = `⚠️ *${target.name}* is no longer in *${guild?.name}* — nothing to kick.`
      return player
    }
    player.guildId = null
    player.guildJoinedAt = null
    player.guildJoinBaseline = 0
    message = `🥾 *${target.name}* was kicked from ${guild?.emoji ?? ''} *${guild?.name}*.`
    return player
  })

  return ctx.reply(message)
}

// ── Treasury ──────────────────────────────────────────────────────────────

/**
 * Donating moves solars out of the player's wallet into the guild record.
 * Two separate stores, so two separate writes: the wallet debit goes through
 * updatePlayer() (the only sanctioned path for a player mutation), and the
 * treasury credit is written to db.data.guilds afterwards — but ONLY if the
 * debit actually happened. Ordering matters: debit first, credit second. The
 * reverse would mint solars into the treasury whenever the wallet check
 * failed, which is exactly the class of bug lib/player-repo.js's queue
 * comment describes.
 *
 * `all` is accepted because typing a seven-digit figure into WhatsApp is how
 * people fat-finger a donation they can't undo.
 */
async function donate(ctx, rawAmount) {
  const p = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)
  if (!ctx.player.guildId) {
    return ctx.reply(`❌ You're not in a guild.\n\n*${p}guild join <name>* — pick one of the five.`)
  }

  const guild = getGuildDef(ctx.player.guildId)
  if (!guild) return ctx.reply(`❌ Your guild no longer exists.`)

  const held = ctx.player.wallet?.solars ?? 0
  const wantsAll = /^(all|max)$/i.test(String(rawAmount ?? '').trim())
  const parsed = wantsAll ? held : Math.floor(Number(String(rawAmount ?? '').replace(/[,_]/g, '')))

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ctx.reply(
      `❓ *Usage:* *${p}guild donate <amount>*  _(or_ *${p}guild donate all*_)_\n` +
      `Minimum donation is ☀️ *${MIN_DONATION.toLocaleString()}*.`,
    )
  }
  if (parsed < MIN_DONATION) {
    return ctx.reply(`❌ Minimum donation is ☀️ *${MIN_DONATION.toLocaleString()}*.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    if (solars < parsed) { outcome = { reason: 'poor', have: solars }; return player }
    if (player.guildId !== guild.id) { outcome = { reason: 'left' }; return player }
    wallet.solars = solars - parsed
    outcome = { reason: 'ok', balance: wallet.solars }
    return player
  })

  if (outcome.reason === 'poor') {
    return ctx.reply(
      `❌ *Not enough Solars.*\nYou tried to donate ☀️ *${parsed.toLocaleString()}* but hold ☀️ *${outcome.have.toLocaleString()}*.`,
    )
  }
  if (outcome.reason === 'left') {
    return ctx.reply(`⚠️ You left the guild before the donation went through — nothing was taken.`)
  }

  const record = getGuildRecord(ctx.db, guild.id)
  const tierBefore = guildTier(record)
  record.treasury += parsed
  record.donations += 1
  record.contributions[ctx.from] = (record.contributions[ctx.from] ?? 0) + parsed
  await ctx.db.write()

  const tierAfter = guildTier(record)
  const promoted = tierAfter.rank > tierBefore.rank
  const score = contributionOf(record, { ...ctx.player, id: ctx.from })
  const role = roleFor(score)
  const toNext = treasuryToNextTier(record)
  const next = nextGuildTier(record)

  return ctx.reply(
    `☀️ *Donated ${parsed.toLocaleString()} Solars to ${guild.emoji} ${guild.name}!*\n\n` +
    `🏛️ Treasury: *${record.treasury.toLocaleString()}*\n` +
    `👤 Your total: *${(record.contributions[ctx.from] ?? 0).toLocaleString()}*\n` +
    `${role.emoji} Your role: *${role.name}*\n` +
    `💰 Your balance: *${outcome.balance.toLocaleString()}*\n\n` +
    (promoted
      ? `🎉 *THE GUILD HAS GROWN!*\n${guild.name} is now a *${tierAfter.name}*.\n_${tierAfter.blurb}_\n` +
        `Every member now gets: ${perkSummary(tierAfter)}\n\n`
      : next
        ? `📈 *${shortSolars(toNext)}* more to reach *${next.name}*.\n\n`
        : `👑 *${guild.name} is a Citadel* — the top of the ladder.\n\n`) +
    `_*${p}guild treasury* to see the vault · *${p}guild perks* for the full list._`,
  )
}

function perkSummary(tier) {
  if (!tier.rank) return '_nothing yet_'
  const bits = []
  if (tier.spoilsPct) bits.push(`+${tier.spoilsPct}% duel spoils`)
  if (tier.duelSlots) bits.push(`+${tier.duelSlots} daily duel${tier.duelSlots === 1 ? '' : 's'}`)
  if (tier.restPct) bits.push(`+${tier.restPct}% home rest`)
  return bits.join(' · ')
}

function showTreasury(ctx, allUsers, query) {
  const p = config.prefix
  const guild = resolveGuildOrOwn(query, ctx.player)
  if (!guild) return ctx.reply(`❓ Specify a guild or join one.  *${p}guild treasury <name>*`)

  const record = getGuildRecord(ctx.db, guild.id)
  const members = getGuildMembers(guild.id, allUsers)
  const tier = guildTier(record)
  const next = nextGuildTier(record)

  const donors = Object.entries(record.contributions)
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([jid, amount], i) => {
      const member = allUsers.find(u => u.id === jid)
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
      const name = member?.name ?? jid.replace(/@.*/, '')
      const away = member && member.guildId !== guild.id ? ' _(left)_' : ''
      return `  ${medal} *${name}*${away} — ☀️ ${amount.toLocaleString()}`
    })

  return ctx.reply(
    `🏛️ *${guild.name.toUpperCase()} TREASURY*\n\n` +
    `☀️ Vault: *${record.treasury.toLocaleString()}*\n` +
    `🏛️ Tier: *${tier.name}*\n` +
    (next
      ? `📈 Next: *${next.name}* at ☀️ ${next.treasury.toLocaleString()}  _(${shortSolars(treasuryToNextTier(record))} to go)_\n`
      : `👑 _Top of the ladder._\n`) +
    `🎁 Perks now: ${perkSummary(tier)}\n` +
    `👥 ${members.length} member(s)  ·  ${record.donations} donation(s)\n\n` +
    (donors.length ? `*Top donors*\n${donors.join('\n')}\n\n` : `_Nobody has donated yet._\n\n`) +
    `*${p}guild donate <amount>* — add to the vault\n` +
    `_Donations are permanent. The vault has no withdrawals — it's the guild's, not a shared wallet._`,
  )
}

function showPerks(ctx, allUsers, query) {
  const p = config.prefix
  const guild = resolveGuildOrOwn(query, ctx.player)
  const record = guild ? getGuildRecord(ctx.db, guild.id) : null
  const current = record ? guildTier(record) : null

  const ladder = GUILD_TIERS.map(tier => {
    const marker = current && tier.rank === current.rank ? ' ← _you are here_' : ''
    const lock = current && tier.rank > current.rank ? '🔒 ' : ''
    return (
      `${lock}*${tier.name}*  _(☀️ ${shortSolars(tier.treasury)})_${marker}\n` +
      `   ${perkSummary(tier)}\n   _${tier.blurb}_`
    )
  }).join('\n\n')

  return ctx.reply(
    `🎁 *GUILD TIERS & PERKS*` +
    (guild ? `\n${guild.emoji} *${guild.name}* — ☀️ ${record.treasury.toLocaleString()} banked` : '') +
    `\n\n${ladder}\n\n` +
    `*Duel spoils* top up what you seize from a PvP win.\n` +
    `*Daily duels* raise your challenge cap — stacks with Premium.\n` +
    `*Home rest* deepens the HP/MP you recover with *${p}home rest*.\n\n` +
    `_Perks never touch damage. A Citadel makes duelling more rewarding, not easier to win._\n` +
    `*${p}guild donate <amount>* — climb the ladder`,
  )
}

function guildTop(ctx, allUsers) {
  const p = config.prefix
  const standings = guildDefs
    .map(g => {
      const members = getGuildMembers(g.id, allUsers)
      const record = getGuildRecord(ctx.db, g.id)
      return {
        def: g, members, record,
        tier: guildTier(record),
        power: guildPower(record, members),
        leader: getGuildLeader(g.id, allUsers),
        floors: members.reduce((sum, m) => sum + conquestSinceJoining(m), 0),
        wins: members.reduce((sum, m) => sum + (m.pvp?.wins ?? 0), 0),
      }
    })
    .sort((a, b) => b.power - a.power || b.record.treasury - a.record.treasury || a.def.name.localeCompare(b.def.name))

  const mine = ctx.player?.guildId
  const lines = standings.map((s, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `*${i + 1}.*`
    const you = s.def.id === mine ? ' ← _yours_' : ''
    return (
      `${medal} ${s.def.emoji} *${s.def.name}*${you}\n` +
      `   📊 ${s.power.toLocaleString()}  ·  🏛️ ${s.tier.name}  ·  👥 ${s.members.length}\n` +
      `   🗺️ ${s.floors} floors  ·  🥊 ${s.wins} duel wins  ·  ☀️ ${shortSolars(s.record.treasury)}`
    )
  })

  return ctx.reply(
    `🏆 *GUILD STANDINGS*\n\n${lines.join('\n\n')}\n\n` +
    `_Standing counts floors cleared, member levels, duel wins, and treasury — activity outweighs money on purpose._\n\n` +
    `*${p}guild join <name>* · *${p}guild donate <amount>*`,
  )
}

async function setMotd(ctx, allUsers, text) {
  const p = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)
  if (!ctx.player.guildId) return ctx.reply(`❌ You're not in a guild.`)

  const guild = getGuildDef(ctx.player.guildId)
  const leader = getGuildLeader(ctx.player.guildId, allUsers)
  if (leader?.id !== ctx.player.id) {
    return ctx.reply(`❌ Only the guild leader sets the notice. Current leader: *${leader?.name ?? 'none'}*.`)
  }

  const trimmed = text.trim().replace(/\s+/g, ' ')
  const record = getGuildRecord(ctx.db, guild.id)

  if (!trimmed) {
    return ctx.reply(
      record.motd
        ? `📜 *Current notice:*\n_"${record.motd}"_\n\n*${p}guild motd <text>* to change it · *${p}guild motd clear* to remove it.`
        : `📜 No notice set.\n\n*${p}guild motd <text>* — up to 140 characters.`,
    )
  }

  if (/^(clear|none|off)$/i.test(trimmed)) {
    record.motd = null
    record.motdBy = null
    record.motdAt = null
    await ctx.db.write()
    return ctx.reply(`📜 Notice cleared for ${guild.emoji} *${guild.name}*.`)
  }

  if (trimmed.length > 140) {
    return ctx.reply(`❌ Keep it under 140 characters — that was ${trimmed.length}.`)
  }

  record.motd = trimmed
  record.motdBy = ctx.player.id
  record.motdAt = Date.now()
  await ctx.db.write()

  return ctx.reply(
    `📜 *Notice set for ${guild.emoji} ${guild.name}:*\n\n_"${trimmed}"_\n\n` +
    `_Every member sees it on *${p}guild info*._`,
  )
}

/** Extracts a full Baileys message object pointing at an attached or replied-to image. */
function extractImageTarget(ctx) {
  const msg = ctx.msg
  if (msg.message?.imageMessage) return msg

  const info = msg.message?.extendedTextMessage?.contextInfo
  if (info?.quotedMessage?.imageMessage) {
    return {
      key: {
        remoteJid: msg.key.remoteJid,
        id: info.stanzaId,
        fromMe: false,
        participant: info.participant,
      },
      message: info.quotedMessage,
    }
  }
  return null
}

async function uploadImage(ctx, allUsers, kind) {
  const p = config.prefix
  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)
  if (!ctx.player.guildId) return ctx.reply(`❌ You're not in a guild.`)

  const leader = getGuildLeader(ctx.player.guildId, allUsers)
  if (leader?.id !== ctx.player.id) {
    return ctx.reply(`❌ Only the guild leader can set the guild ${kind}. Current leader: *${leader?.name ?? 'none'}*.`)
  }

  const target = extractImageTarget(ctx)
  if (!target) {
    return ctx.reply(
      `📎 Attach an image with the caption *${p}guild ${kind}*, or reply to an image with that caption.`,
    )
  }

  const guild = getGuildDef(ctx.player.guildId)

  try {
    const buffer = await downloadMediaMessage(
      target,
      'buffer',
      {},
      { logger, reuploadRequest: ctx.sock.updateMediaMessage },
    )

    const dir = join('media', 'guilds', guild.id)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${kind}.jpg`)
    await writeFile(filePath, buffer)

    await ensureGuildsInitialized(ctx.db)
    ctx.db.data.guilds[guild.id][`${kind}Path`] = filePath
    ctx.db.data.guilds[guild.id].updatedAt = Date.now()
    ctx.db.data.guilds[guild.id].updatedBy = ctx.player.id
    await ctx.db.write()

    return ctx.reply(`✅ Guild ${kind} updated for ${guild.emoji} *${guild.name}*!`)
  } catch (err) {
    logger.error({ err }, `Failed to download guild ${kind} image`)
    return ctx.reply(`❌ Couldn't download that image — try again.`)
  }
}

// ── Guild Wars — real player-vs-player, leader-run, up to 4v4 ────────────────
//
// A war is a SERIES OF PAIRED 1v1 DUELS between champions the two guild
// LEADERS name. Combat itself is the ordinary `.pvp` engine — two real
// players, real turns, real abilities — so a war can never be fought by
// proxies. Every pairing isolates both fighters behind Preset 5 (lib/war-kit.js),
// every 1v1 win adds a point, and the bot stamps the 500k/1M prize pool.
// See lib/guild-war-repo.js for the full state machine.

const pfx = () => config.prefix

/** Tokens that are options, never part of a guild name. */
const WAR_OPTION_TOKENS = new Set([
  ...MATCH_TYPE_IDS,
  ...Object.keys(WAR_FORMATS),
  'normal', 'wager', 'wagered', 'stake', 'stakes', 'standard',
  'kit', 'preset', 'tier', 'kits', 'presets',
])

/** @mentions on this message, in the order they were typed. */
function mentionedJids(ctx) {
  const info = ctx.msg?.message?.extendedTextMessage?.contextInfo
    ?? ctx.msg?.message?.imageMessage?.contextInfo
    ?? ctx.msg?.message?.buttonsResponseMessage?.contextInfo
  return [...(info?.mentionedJid ?? [])]
}

/**
 * The @mentions from this message that are actually IN THIS GROUP. Tagging a
 * guildmate who isn't in the chat renders as a raw number, so filter against
 * group metadata when we can get it; if metadata is unavailable, fall back to
 * mentioning at most the first few so the message still reads cleanly.
 */
async function mentionsInGroup(ctx, jids) {
  const list = [...new Set((jids ?? []).filter(Boolean))]
  if (!list.length) return []
  if (!ctx.isGroup || typeof ctx.sock?.groupMetadata !== 'function') return list
  try {
    const meta = await getGroupMetadata(ctx.sock, ctx.sender)
    const inside = new Set()
    for (const p of meta?.participants ?? []) {
      if (p?.id) inside.add(p.id)
      if (p?.jid) inside.add(p.jid)
      if (p?.lid) inside.add(p.lid)
    }
    const filtered = list.filter(j => inside.has(j))
    return filtered.length ? filtered : list.slice(0, 8)
  } catch {
    return list.slice(0, 8)
  }
}

/** Reply WITH @mentions — this is how both guilds get tagged for a war. */
async function replyTagged(ctx, text, jids) {
  const mentions = await mentionsInGroup(ctx, jids)
  if (!mentions.length) return ctx.reply(text)
  return ctx.sock.sendMessage(ctx.sender, { text: String(text), mentions }, { quoted: ctx.msg })
    .catch(err => {
      logger.error({ err: err.message }, 'guild war tagged reply failed — falling back to plain text')
      return ctx.reply(text)
    })
}

/** The guild leader, or a refusal message. Returns { leader, error }. */
function requireLeader(ctx, allUsers) {
  if (!ctx.player?.guildId) return { error: `❌ You're not in a guild.` }
  const guild = getGuildDef(ctx.player.guildId)
  const leader = getGuildLeader(ctx.player.guildId, allUsers)
  if (leader?.id !== ctx.player.id) {
    return {
      error: `👑 Only *${guild?.name}'s* leader can do that. Current leader: *${leader?.name ?? 'none'}*.`,
    }
  }
  return { leader, guild }
}

/**
 * Parse a challenge query into options + the leftover guild name.
 * Order-free: `.guild war challenge 2v2 emberwake kit 5 wager @a @b` and
 * `.guild war challenge emberwake 2v2 standard @a` both work.
 */
function parseWarChallengeArgs(args, mentioned) {
  const tokens = [...(args ?? [])]
  const opts = { matchType: null, formatId: null, stakes: null, kitTier: null, guildTokens: [] }

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]
    const t = String(raw ?? '').toLowerCase().replace(/[^\w|]/g, '')

    if (MATCH_TYPE_IDS.includes(t)) { opts.matchType = t; continue }
    if (Object.keys(WAR_FORMATS).includes(t)) { opts.formatId = t; continue }
    if (t === 'normal') { opts.stakes = 'normal'; continue }
    if (t === 'wager' || t === 'wagered' || t === 'stake' || t === 'stakes') { opts.stakes = 'wager'; continue }
    if (t === 'kit' || t === 'preset' || t === 'tier') {
      const next = tokens[i + 1]
      const n = Math.floor(Number(String(next ?? '').replace(/[^\d]/g, '')))
      if (n >= 1 && n <= 5) { opts.kitTier = n; i += 1; continue }
      opts.kitTier = opts.kitTier ?? 3
      continue
    }
    const presetMatch = /^t([1-5])$/i.exec(String(raw ?? '')) ?? /^kit([1-5])$/i.exec(String(raw ?? ''))
    if (presetMatch) { opts.kitTier = Number(presetMatch[1]); continue }
    // A mention token is never part of the guild name — match it with or
    // without the leading `@` so `@ga2` can't leak into the query.
    const bare = String(raw ?? '').replace(/^@+/, '')
    if (mentioned?.has?.(raw) || mentioned?.has?.(bare)) continue
    if (bare !== raw) continue
    if (WAR_OPTION_TOKENS.has(t)) continue
    opts.guildTokens.push(raw)
  }

  opts.matchType = opts.matchType ?? '1v1'
  opts.formatId = opts.formatId ?? 'standard'
  opts.stakes = opts.stakes ?? 'normal'
  opts.kitTier = opts.kitTier ?? 3
  opts.guildQuery = opts.guildTokens.join(' ').trim()
  return opts
}

/** Register + in the right guild + not already busy. Returns player or error. */
function resolveChampion(db, allUsers, jid, myGuildId, slotLabel) {
  const p = allUsers.find(u => u.id === jid)
  if (!p) return { error: `❌ Mentioned player *${slotLabel}* isn't registered yet.` }
  if (p.guildId !== myGuildId) {
    const g = getGuildDef(p.guildId)
    return { error: `❌ *${p.name}* ${g ? `fights for *${g.name}*` : 'is guildless'} — champions must be in *your* guild.` }
  }
  if (p.inBattle) return { error: `⚔️ *${p.name}* is already in a battle.` }
  if (p.inDungeon) return { error: `🗺️ *${p.name}* is deep in a dungeon right now.` }
  return { player: p }
}

// ── .guild war challenge ─────────────────────────────────────────────────────

async function handleWarChallenge(ctx, allUsers, warArgs) {
  const p = config.prefix
  const usage = () => ctx.reply(
    `⚔️ *DECLARE A GUILD WAR*\n\n` +
    `*${p}guild war challenge <guild> <1v1|2v2|3v3|4v4> <format> [normal|wager] [kit <1-5>] @champ1 [@champ2 …]*\n\n` +
    `👑 Leaders only — you name the champions who represent your guild.\n` +
    `💰 The bot stamps the pool: *500,000* for 1v1/2v2, *1,000,000* for 3v3/4v4.\n` +
    `🎒 *kit 1-5* picks the Preset 5 tier both sides fight on.\n\n` +
    `*Formats:* ${Object.keys(WAR_FORMATS).map(k => `${WAR_FORMATS[k].emoji} ${k}`).join(' · ')}\n` +
    `*Stakes:* \`normal\` (war only) · \`wager\` (each champion also stakes solars)\n\n` +
    `_Example:_ *${p}guild war challenge emberwake 2v2 mcpvp kit 4 @hero @ace*`
  )

  const { error } = requireLeader(ctx, allUsers)
  if (error) return ctx.reply(error)

  const myGuildId = ctx.player.guildId
  const myGuild = getGuildDef(myGuildId)
  const mentionedSet = new Set(mentionedJids(ctx))
  const opts = parseWarChallengeArgs(warArgs, mentionedSet)

  if (!opts.guildQuery) return usage()
  const targetGuild = findGuildByQuery(opts.guildQuery)
  if (!targetGuild) return ctx.reply(`❌ No guild matching *${opts.guildQuery}*.\n\n${guildDefs.map(g => `  • ${g.emoji} *${g.name}*`).join('\n')}`)
  if (targetGuild.id === myGuildId) return ctx.reply(`❌ You cannot wage war against your own guild.`)

  const size = MATCH_TYPES[opts.matchType] ?? 1
  const format = WAR_FORMATS[opts.formatId] ?? WAR_FORMATS.standard

  // ── Busyness: one live war per guild, ever. ──
  await ensureWarState(ctx.db)
  const live = findLiveWarBetween(ctx.db, myGuildId, targetGuild.id)
  if (live) {
    return ctx.reply(
      live.status === 'pending'
        ? `📩 A war between *${myGuild.name}* and *${targetGuild.name}* is already waiting for an answer. *${p}guild war status*.`
        : `⚔️ *${myGuild.name}* and *${targetGuild.name}* are already at war! *${p}guild war status*.`
    )
  }
  if (guildBusy(ctx.db, myGuildId)) return ctx.reply(`⚔️ *${myGuild.name}* already has a live war. Finish it first — *${p}guild war status*.`)
  if (guildBusy(ctx.db, targetGuild.id)) return ctx.reply(`⚔️ *${targetGuild.name}* is already tied up in a war. Try another rival.`)

  // ── Champions: your OWN guild members, exactly `size` of them ──
  const mentioned = mentionedJids(ctx)
  const picked = []
  const seen = new Set()
  for (const jid of mentioned) {
    if (seen.has(jid)) continue
    seen.add(jid)
    const res = resolveChampion(ctx.db, allUsers, jid, myGuildId, `#${picked.length + 1}`)
    if (res.error) return ctx.reply(res.error)
    if (res.player) picked.push(res.player)
  }
  if (picked.length !== size) {
    return ctx.reply(
      `❌ *${opts.matchType}* needs *${size}* champion${size === 1 ? '' : 's'} from *${myGuild.name}* — you named *${picked.length}*.\n\n` +
      `*@-mention them in the command*, e.g.\n` +
      `> *${p}guild war challenge ${targetGuild.name} ${opts.matchType} ${opts.formatId} ${picked.concat(allUsers.filter(u => u.guildId === myGuildId && !seen.has(u.id))).slice(0, size).map(u => '@' + u.name).join(' ')}*`
    )
  }

  // ── Wager wars: every champion must be able to cover the stake ──
  const stakeSolars = opts.stakes === 'wager'
    ? (opts.kitTier >= 4 ? 250_000 : opts.kitTier >= 3 ? 100_000 : 50_000)
    : 0
  if (stakeSolars) {
    const short = picked.find(pl => (pl.wallet?.solars ?? 0) < stakeSolars)
    if (short) {
      return ctx.reply(
        `☀️ *Wager war:* every champion stakes *${stakeSolars.toLocaleString()} solars*.\n` +
        `*${short.name}* only holds *${(short.wallet?.solars ?? 0).toLocaleString()}*.`
      )
    }
  }

  // ── Supporters: everyone else in your guild rides along ──
  const supportsA = allUsers
    .filter(u => u.guildId === myGuildId && !seen.has(u.id))
    .map(u => ({ id: u.id, name: u.name }))

  const war = await createWarChallenge(ctx.db, {
    guildAId: myGuildId,
    guildBId: targetGuild.id,
    challengerId: ctx.player.id,
    matchType: opts.matchType,
    formatId: format.id,
    stakes: opts.stakes,
    stakeSolars,
    kitTier: opts.kitTier,
    groupJid: ctx.isGroup ? ctx.sender : null,
    teamA: picked.map(pl => ({ id: pl.id, name: pl.name })),
    supportsA,
  })

  const targetMembers = getGuildMembers(targetGuild.id, allUsers)
  const myMembers = getGuildMembers(myGuildId, allUsers)
  const tagJids = [...targetMembers.map(m => m.id), ...myMembers.map(m => m.id)]
  const targetLeader = getGuildLeader(targetGuild.id, allUsers)

  const kit = warKitLabel(war.kitTier)
  const stakeLine = war.stakes === 'wager'
    ? `💰 *WAGER WAR* — each champion stakes *${war.stakeSolars.toLocaleString()} solars* on every pairing.`
    : `⚖️ *Normal stakes* — only the bot's pool is on the line.`

  const msg = [
    `⚔️🔥 *GUILD WAR DECLARED!* 🔥⚔️`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${myGuild.emoji} *${myGuild.name}*  VS  ${targetGuild.emoji} *${targetGuild.name}*`,
    ``,
    `📏 Format: *${war.matchType}* — ${size} duels, each one a real 1v1, points add up.`,
    `📜 Ruleset: ${format.emoji} *${format.name}* — _${format.description}_`,
    `🎒 Preset: ${kit} — the ONLY gear on the field. Real inventories are set aside and return intact after each duel.`,
    `💰 Prize pool: *☀️ ${war.prizePool.toLocaleString()} SOLARS* — generated by the bot. Nobody funds it.`,
    stakeLine,
    ``,
    `🛡️ *${myGuild.name} champions:*`,
    ...war.teamA.map((c, i) => `   ${i + 1}. ⚔️ *${c.name}*`),
    ``,
    `📣 *${myGuild.name} supporters* — you're tagged: rally them in chat, you earn XP and solars if they take it.`,
    ``,
    `🚨 *${targetGuild.name}* — your leader ${targetLeader ? `*${targetLeader.name}*` : 'whoever leads'} has *24 hours* to answer:`,
    `> *${p}guild war accept ${Array.from({ length: size }, (_, i) => '@champ' + (i + 1)).join(' ')}*`,
    `> (name YOUR ${size} champion${size === 1 ? '' : 's'} — @-mention them. Example above is literal: replace the placeholders.)`,
    ``,
    `_Check the board: *${p}guild war status* · Withdraw: *${p}guild war decline*_`,
  ].join('\n')

  await replyTagged(ctx, msg, tagJids)

  await pushNotification(ctx.db, targetLeader?.id, {
    kind: 'battle',
    title: `⚔️ ${myGuild.name} declared Guild War!`,
    body: `${myGuild.name} challenges ${targetGuild.name} to a ${war.matchType}. Answer within 24h with ${p}guild war accept @yourchampions.`,
  }).catch(() => {})
  return undefined
}

// ── .guild war accept ────────────────────────────────────────────────────────

async function handleWarAccept(ctx, allUsers) {
  const p = config.prefix
  const { error } = requireLeader(ctx, allUsers)
  if (error) return ctx.reply(error)

  const myGuildId = ctx.player.guildId
  await ensureWarState(ctx.db)

  const pending = findWarByStatus(ctx.db, myGuildId, 'pending')
  if (!pending) {
    return ctx.reply(`🛡️ No Guild War challenge is waiting for *${getGuildDef(myGuildId)?.name ?? 'you'}*.`)
  }
  if ((pending.acceptUntil ?? 0) < Date.now()) {
    await cancelWar(ctx.db, pending.id)
    return ctx.reply(`⌛ That war challenge from *${getGuildDef(pending.guildAId)?.name}* expired unanswered.`)
  }

  const size = pending.size
  const mentioned = mentionedJids(ctx)
  const picked = []
  const seen = new Set()
  for (const jid of mentioned) {
    if (seen.has(jid)) continue
    seen.add(jid)
    const res = resolveChampion(ctx.db, allUsers, jid, myGuildId, `#${picked.length + 1}`)
    if (res.error) return ctx.reply(res.error)
    if (res.player) picked.push(res.player)
  }
  if (picked.length !== size) {
    const suggestions = getGuildMembers(myGuildId, allUsers).slice(0, size)
    return ctx.reply(
      `❌ *${getGuildDef(pending.guildAId)?.name}* named ${size} champion${size === 1 ? '' : 's'} — you must answer with *exactly ${size}* of your own.\n\n` +
      `> *${p}guild war accept ${suggestions.map(u => '@' + u.name).join(' ')}*`
    )
  }

  if (pending.stakes === 'wager' && pending.stakeSolars > 0) {
    const short = picked.find(pl => (pl.wallet?.solars ?? 0) < pending.stakeSolars)
    if (short) {
      return ctx.reply(
        `☀️ *Wager war:* each champion must hold *${pending.stakeSolars.toLocaleString()} solars*.\n` +
        `*${short.name}* holds *${(short.wallet?.solars ?? 0).toLocaleString()}*.`
      )
    }
  }

  const supportsB = allUsers
    .filter(u => u.guildId === myGuildId && !seen.has(u.id))
    .map(u => ({ jid: u.id, name: u.name }))

  const res = await acceptWarChallenge(ctx.db, pending.id, picked.map(pl => ({ id: pl.id, name: pl.name })))
  if (res.error) return ctx.reply(`❌ That war can't be accepted (${res.error}).`)
  const war = res.error ? null : getWar(ctx.db, pending.id)
  if (war) { war.supportsB = supportsB; await ctx.db.write() }

  const aDef = getGuildDef(war.guildAId)
  const bDef = getGuildDef(war.guildBId)

  const tagJids = [
    ...war.teamA.map(c => c.jid),
    ...war.teamB.map(c => c.jid),
    ...(war.supportsA ?? []).map(c => c.jid),
    ...(war.supportsB ?? []).map(c => c.jid),
  ]

  const msg = [
    `🔥⚔️ *THE BATTLE LINES ARE DRAWN!* ⚔️🔥`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${aDef.emoji} *${aDef.name}*  VS  ${bDef.emoji} *${bDef.name}*`,
    ``,
    `📏 *${war.matchType}*  ·  📜 ${formatName(war.formatId)}  ·  🎒 ${warKitLabel(war.kitTier)}`,
    `💰 Pool: *☀️ ${war.prizePool.toLocaleString()}* — bot-stamped.`,
    ``,
    `*${aDef.name}:* ${war.teamA.map(c => `⚔️ *${c.name}*`).join(', ')}`,
    `*${bDef.name}:* ${war.teamB.map(c => `⚔️ *${c.name}*`).join(', ')}`,
    ``,
    `🔔 *PAIRING 1 starts now* — the two first-named champions duel.`,
    `> *${p}pvp accept* (defender) · *${p}pvp @<opponent>* (challenger)`,
    ``,
    `🎒 Preset 5 isolates your gear: your inventory is stored, the war kit loads, and everything returns when the duel ends.`,
    `📣 Supporters — every cheer counts: you're paid XP and solars if your guild takes it.`,
    ``,
    `_Board: *${p}guild war status* · Claim a stalled pairing: *${p}guild war claim*_`,
  ].join('\n')

  await replyTagged(ctx, msg, tagJids)

  // Open pairing 1 (issues the ready-to-accept .pvp challenge + tags the pair).
  await startNextPairing(ctx.db, war, ctx)
  return undefined
}

// ── .guild war decline / withdraw / cancel ───────────────────────────────────

async function handleWarCancel(ctx, allUsers) {
  const p = config.prefix
  const { error } = requireLeader(ctx, allUsers)
  if (error) return ctx.reply(error)

  const myGuildId = ctx.player.guildId
  await ensureWarState(ctx.db)
  const mine = warsForGuild(ctx.db, myGuildId)
    .find(w => w.status === 'pending' || w.status === 'active')
  if (!mine) return ctx.reply(`🏳️ Nothing to cancel — *${getGuildDef(myGuildId)?.name}* has no open Guild War.`)

  const iAmChallenger = mine.challengerId === ctx.player.id
  if (mine.status === 'active' && iAmChallenger) {
    return ctx.reply(
      `❌ A war that has *started* cannot be withdrawn — that would strand the champions mid-duel.\n` +
      `_Fight it out, or wait for the pairings to conclude._`
    )
  }

  await cancelWar(ctx.db, mine.id)
  const a = getGuildDef(mine.guildAId)
  const b = getGuildDef(mine.guildBId)
  const other = mine.guildAId === myGuildId ? b : a
  return replyTagged(
    ctx,
    `🏳️ *GUILD WAR CALLED OFF*\n\n${a?.emoji} *${a?.name}* and ${b?.emoji} *${b?.name}* stand down. ` +
    `${iAmChallenger ? '*Their* challenge was withdrawn' : `*${other?.name}'s* challenge was declined`}. Nobody was paid, nobody lost anything.\n\n` +
    `_New challenge: *${p}guild war challenge <guild> <1v1..4v4> <format> @champs*_`,
    allCombatantJids(mine),
  )
}

function allCombatantJids(war) {
  return [
    ...(war.teamA ?? []).map(c => c.jid),
    ...(war.teamB ?? []).map(c => c.jid),
    ...(war.supportsA ?? []).map(c => c.jid),
    ...(war.supportsB ?? []).map(c => c.jid),
  ]
}

// ── .guild war status ────────────────────────────────────────────────────────

async function handleWarStatus(ctx, allUsers) {
  const p = config.prefix
  if (!ctx.player?.guildId) return ctx.reply(`❌ You're not in a guild.`)
  await ensureWarState(ctx.db)

  // Read-path hygiene: lapses, voided pairings, stale wars. No scheduler.
  const sweepNote = await sweepGuildWars(ctx.db, Date.now(), ctx)
  if (sweepNote) await ctx.reply(sweepNote).catch(() => {})

  const mine = warsForGuild(ctx.db, ctx.player.guildId)
    .find(w => w.status === 'pending' || w.status === 'active' || w.status === 'finished')
  if (!mine) {
    return ctx.reply(
      `🛡️ *No Guild War on the board.*\n\n` +
      `Leaders declare one with:\n` +
      `> *${p}guild war challenge <guild> <1v1|2v2|3v3|4v4> <format> @champ1 [@champ2 …]*\n\n` +
      `_See everything: *${p}guild war*_`
    )
  }
  return ctx.reply(warBoard(mine, ctx.db))
}

// ── .guild war claim (walkover on a stalled pairing) ─────────────────────────

async function handleWarClaim(ctx, allUsers) {
  const p = config.prefix
  if (!ctx.player?.guildId) return ctx.reply(`❌ You're not in a guild.`)
  await ensureWarState(ctx.db)

  const war = warsForGuild(ctx.db, ctx.player.guildId).find(w => w.status === 'active')
  if (!war) return ctx.reply(`❌ *${getGuildDef(ctx.player.guildId)?.name}* has no active Guild War to claim in.`)

  const match = war.matches?.[war.currentMatch]
  if (!match || match.winnerJid) return ctx.reply(`❌ No open pairing to claim — run *${p}guild war status*.`)

  const iAmA = match.aJid === ctx.player.id
  const iAmB = match.bJid === ctx.player.id
  if (!iAmA && !iAmB) return ctx.reply(`❌ You're not in the live pairing — only the waiting champion can claim.`)

  const opponentJid = iAmA ? match.bJid : match.aJid

  // If the duel is actually running, the normal `.pvp claim` covers it.
  const opp = allUsers.find(u => u.id === opponentJid)
  if (opp?.inBattle && opp?.battleState?.opponentJid === ctx.player.id) {
    return ctx.reply(`⚔️ Your duel with *${opp.name}* is live — the win claim there is *${p}pvp claim*.`)
  }

  const verdict = canClaimPairing(war, match)
  if (!verdict.ok) {
    if (verdict.why === 'too_early') {
      const mins = Math.max(1, Math.ceil(verdict.ms / 60000))
      return ctx.reply(`⏳ The pairing is only just open — give them *${mins} minute(s)* to answer, then claim.`)
    }
    if (verdict.why === 'void') return ctx.reply(`🕳️ That pairing has timed out entirely — *${p}guild war status* to see the sweep result.`)
    return ctx.reply(`❌ That pairing is already settled.`)
  }

  await settleWalkover(ctx.db, war, match.i, ctx.player.id, ctx,
    `_The opposing champion never answered the pairing (${Math.round(verdict.ms / 60000)} minutes idle)._`)
  return undefined
}

// ── .guild war forfeit ───────────────────────────────────────────────────────

async function handleWarForfeit(ctx, allUsers) {
  const p = config.prefix
  if (!ctx.player?.guildId) return ctx.reply(`❌ You're not in a guild.`)
  await ensureWarState(ctx.db)

  const war = warsForGuild(ctx.db, ctx.player.guildId).find(w => w.status === 'active')
  if (!war) return ctx.reply(`❌ No active Guild War.`)

  const match = war.matches?.[war.currentMatch]
  if (!match || match.winnerJid) return ctx.reply(`❌ No open pairing.`)

  const iAmA = match.aJid === ctx.player.id
  const iAmB = match.bJid === ctx.player.id
  if (!iAmA && !iAmB) {
    return ctx.reply(`❌ Only the two champions in the live pairing can forfeit it. *${p}guild war status* to see who.`);
  }

  const winnerJid = iAmA ? match.bJid : match.aJid
  const me = ctx.player.name
  await settleWalkover(ctx.db, war, match.i, winnerJid, ctx,
    `_*${me}* forfeits the pairing — their guild eats the point._`)
  return undefined
}

// ── .guild war leaderboard / kits / history ──────────────────────────────────

async function handleWarLeaderboard(ctx, allUsers) {
  const p = config.prefix
  await ensureWarState(ctx.db)

  const players = allUsers
    .filter(u => (u.dominance?.score ?? 0) > 0)
    .map(u => {
      ensureDominance(u)
      return { u, tier: dominanceTierFor(u.dominance.score) }
    })
    .sort((a, b) => b.u.dominance.score - a.u.dominance.score)
    .slice(0, 12)

  const guilds = guildDefs
    .map(g => {
      const { war: gw } = ensureGuildWarStats(ctx.db, g.id)
      return { g, gw, tier: guildWarTierFor(gw.dominance) }
    })
    .sort((a, b) => b.gw.dominance - a.gw.dominance)

  const pLines = players.length
    ? players.map((row, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `*${i + 1}.*`
        const tag = getGuildTag(row.u.guildId)
        const mvp = row.u.dominance.mvp > 0 ? ` · 🥇×${row.u.dominance.mvp}` : ''
        return (
          `${medal} ${row.tier.emoji} ${tag} *${row.u.name}* — ${row.tier.name}\n` +
          `     ☀️ dominance *${row.u.dominance.score.toLocaleString()}* · ${row.u.dominance.wins}W/${row.u.dominance.losses}L · ${row.u.dominance.wars} war(s)${mvp}`
        )
      }).join('\n')
    : `  _Nobody has fought a Guild War yet — be the first._`

  const gLines = guilds.map((row, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `*${i + 1}.*`
    return (
      `${medal} ${row.tier.emoji} ${row.g.emoji} *${row.g.name}* — ${row.tier.name}\n` +
      `     war dominance *${row.gw.dominance.toLocaleString()}* · ${row.gw.wins}W/${row.gw.losses}L/${row.gw.draws}D · 🏆${row.gw.trophies} · streak ${row.gw.streak}`
    )
  }).join('\n')

  const topTier = DOMINANCE_TIERS[DOMINANCE_TIERS.length - 1]
  const guildTop = GUILD_WAR_TIERS[GUILD_WAR_TIERS.length - 1]

  return ctx.reply(
    `🎖️ *GUILD WAR DOMINANCE* 🎖️\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*PLAYERS — top ${players.length}*  _(${DOMINANCE_TIERS.map(t => `${t.emoji}${t.name}`).join(' → ')})_\n` +
    `${pLines}\n\n` +
    `*GUILDS — war rank*\n` +
    `${gLines}\n\n` +
    `${topTier.emoji} *${topTier.name}* unlocks at ${topTier.min.toLocaleString()} dominance.\n` +
    `${guildTop.emoji} *${guildTop.name}* unlocks at ${guildTop.min.toLocaleString()} guild war dominance.\n\n` +
    `_Dominance comes ONLY from wars and war duels — it cannot be bought. ` +
    `Guild war rank is separate from the donation treasury ladder._\n\n` +
    `_Full ladder: *${p}guild war tiers* · kits: *${p}guild war kits*_`,
  )
}

async function handleWarKits(ctx) {
  const p = config.prefix
  const lines = Object.values(WAR_KIT_TIERS).map(t =>
    `  ${t.emoji} *Tier ${t.tier} — ${t.name}*\n` +
    `     ${Object.values(t.equipped).filter(Boolean).length} gear slots + ${t.bag.length} pouch item(s)` +
    (t.totem ? ` + totem` : '') +
    `\n     _${t.blurb}_`
  ).join('\n\n')

  return ctx.reply(
    `🎒 *GUILD WAR PRESET 5 — KIT TIERS* 🎒\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Every war pairing isolates both fighters: their REAL inventory and gear move into storage, ` +
    `and the preset below loads instead. The moment the duel ends the preset vanishes and their things return — ` +
    `nothing of theirs can break, burn or be lost inside a war.\n\n` +
    `${lines}\n\n` +
    `*Which tier?* The war's kit tier, chosen by the declaring leader (\`kit 1..5\`). Both sides get the SAME kit — fairness by construction.\n\n` +
    `*Bring your OWN gear?* Save a personal war loadout and it overrides the bot kit, slot by slot:\n` +
    `> *${p}loadout save war*  _(or_ *${p}loadout save 5*_) — save your current gear as Preset 5_\n` +
    `> *${p}loadout view war* — inspect it before you march\n\n` +
    `_MCPVP/No-Totem formats strip the totem even from tiers that carry one._`,
  )
}

async function handleWarHistory(ctx, allUsers) {
  if (!ctx.player?.guildId) return ctx.reply(`❌ You're not in a guild.`)
  await ensureWarState(ctx.db)
  const g = getGuildDef(ctx.player.guildId)
  const { war: gw } = ensureGuildWarStats(ctx.db, g.id)
  const tier = guildWarTierFor(gw.dominance)

  const hist = (gw.history ?? []).slice(0, 6)
  const lines = hist.length
    ? hist.map(h => {
        const other = getGuildDef(h.vs)
        const icon = h.result === 'win' ? '🏆' : h.result === 'loss' ? '💀' : '🤝'
        const when = `${Math.max(1, Math.round((Date.now() - h.at) / 3600000))}h ago`
        return `  ${icon} ${other?.emoji} *${other?.name ?? h.vs}* — ${h.score}  _(${when})_`
      }).join('\n')
    : `  _No wars recorded yet._`

  return ctx.reply(
    `${g.emoji} *${g.name.toUpperCase()} — WAR RECORD*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${tier.emoji} *Rank:* ${tier.name}  ·  ☀️ war dominance *${gw.dominance.toLocaleString()}*\n` +
    `🏆 ${gw.wins}W — 💀 ${gw.losses}L — 🤝 ${gw.draws}D  ·  🏆 trophies *${gw.trophies}*  ·  🔥 streak *${gw.streak}* (best ${gw.bestStreak})\n` +
    `🥇 MVP awards: *${gw.mvpAwards}*\n\n` +
    `*RECENT WARS*\n${lines}\n\n` +
    `_Leadership ladder: *${pfx()}guild top* · dominance ladder: *${pfx()}guild war leaderboard*_`,
  )
}

// ── The dispatcher ───────────────────────────────────────────────────────────

async function guildWarDispatch(ctx, allUsers, warArgs) {
  const p = config.prefix
  const sub = warArgs[0]?.toLowerCase()
  const rest = warArgs.slice(1)

  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)
  if (!ctx.player.guildId) return ctx.reply(`❌ You're not in a guild. Join one with *${p}guild join <name>*.`)

  if (sub === 'challenge' || sub === 'declare' || sub === 'start') {
    return handleWarChallenge(ctx, allUsers, rest)
  }
  if (sub === 'accept' || sub === 'answer') {
    return handleWarAccept(ctx, allUsers)
  }
  if (sub === 'decline' || sub === 'cancel' || sub === 'withdraw') {
    return handleWarCancel(ctx, allUsers)
  }
  if (sub === 'status' || sub === 'view' || sub === 'board') {
    return handleWarStatus(ctx, allUsers)
  }
  if (sub === 'claim') {
    return handleWarClaim(ctx, allUsers)
  }
  if (sub === 'forfeit' || sub === 'surrender') {
    return handleWarForfeit(ctx, allUsers)
  }
  if (sub === 'leaderboard' || sub === 'top' || sub === 'dominance' || sub === 'ranks') {
    return handleWarLeaderboard(ctx, allUsers)
  }
  if (sub === 'kits' || sub === 'presets' || sub === 'kit' || sub === 'preset' || sub === 'preset5') {
    return handleWarKits(ctx)
  }
  if (sub === 'record' || sub === 'history' || sub === 'log') {
    return handleWarHistory(ctx, allUsers)
  }
  if (sub === 'attack' || sub === 'atk' || sub === 'skill' || sub === 'defend' || sub === 'drink') {
    return ctx.reply(
      `⚔️ *Guild War combat is a real duel now.*\n\n` +
      `Every pairing is fought with your own two hands through the normal duel commands:\n` +
      `> *${p}pvp attack* · *${p}pvp skill <name>* · *${p}pvp ability <name>* · *${p}pvp defend*\n` +
      `> *${p}pvp moves* — everything you can do this turn\n\n` +
      `If you're mid-pairing, *${p}pvp status* shows the board.`,
    )
  }

  const formatList = Object.values(WAR_FORMATS)
    .filter((f, idx, arr) => arr.findIndex(x => x.id === f.id) === idx)
    .map(f => `  ${f.emoji} *${f.name}* (${f.id}) — ${f.description}`)
    .join('\n')

  const sizeList = MATCH_TYPE_IDS.map(id =>
    `  • *${id}* — ${MATCH_TYPES[id]} duel${MATCH_TYPES[id] === 1 ? '' : 's'} per side, pool ☀️ ${(id === '3v3' || id === '4v4' ? 1_000_000 : 500_000).toLocaleString()}`
  ).join('\n')

  const tierList = Object.values(WAR_KIT_TIERS).map(t =>
    `  ${t.emoji} *Tier ${t.tier} ${t.name}*`
  ).join('\n')

  const domList = DOMINANCE_TIERS.map((t, i) =>
    `  ${i + 1}. ${t.emoji} *${t.name}* — from ${t.min.toLocaleString()}`
  ).join('\n')

  return ctx.reply(
    `⚔️🔥 *GUILD WARS — REAL PLAYERS, REAL DUELS* 🔥⚔️\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Your guild LEADER declares war and names the champions. Their rival's leader answers with their own. ` +
    `Then every pairing is a *real 1v1 duel* between those players — points add up, highest score takes the bot's prize pool.\n\n` +
    `*COMMANDS*\n` +
    `  *${p}guild war challenge <guild> <size> <format> [normal|wager] [kit 1-5] @champs*\n` +
    `      — leader declares, naming ${'your champions'}\n` +
    `  *${p}guild war accept @champ1 [@champ2 …]* — rival leader answers\n` +
    `  *${p}guild war status* — the live board (also sweeps stale pairings)\n` +
    `  *${p}guild war claim* — take the point if they never show\n` +
    `  *${p}guild war forfeit* — throw your pairing (point to the enemy)\n` +
    `  *${p}guild war decline* — withdraw / refuse a challenge\n` +
    `  *${p}guild war leaderboard* — dominance score + highest-tier players\n` +
    `  *${p}guild war kits* — the five Preset 5 tiers\n` +
    `  *${p}guild war record* — your guild's war history and rank\n\n` +
    `*SIZES & POOLS* (pool stamped by the BOT, never by players)\n${sizeList}\n\n` +
    `*FORMATS*\n${formatList}\n\n` +
    `*PRESET 5 KIT TIERS*\n${tierList}\n\n` +
    `*DOMINANCE LADDER*\n${domList}\n\n` +
    `🏷️ Supporters are tagged for every war and paid when their guild wins.\n` +
    `🎒 *Preset 5 isolates your gear* — real inventory aside during the duel, restored intact after.\n` +
    `💰 *Wager wars* put each champion's own solars on the line too.`,
  )
}
