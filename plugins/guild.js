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

import {
  WAR_FORMATS,
  GUILD_AURAS,
  createWarSession,
  resolveWarTurn,
} from '../lib/guild-war-engine.js'

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
    { cmd: 'info <name>', desc: 'details, banner, and the member roll' },
    { cmd: 'donate <amount>', desc: 'fund the treasury and raise your role' },
    { cmd: 'treasury', desc: 'the vault, tier progress and top donors' },
    { cmd: 'perks', desc: 'what your guild tier grants every member' },
    { cmd: 'top', desc: 'all five guilds ranked by standing' },
    { cmd: 'motd <text>', desc: 'leader only — set the message of the day' },
    { cmd: 'kick <player>', desc: 'leader only — remove a member' },
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

    return reply(
      `❓ Unknown guild command.\n\n` +
      `*${p}guild* — list guilds\n` +
      `*${p}guild info <name>* — guild details\n` +
      `*${p}guild join <name>* — join a guild\n` +
      `*${p}guild leave* — leave your guild\n` +
      `*${p}guild donate <amount>* — fund the treasury\n` +
      `*${p}guild treasury* — vault and tier progress\n` +
      `*${p}guild perks* — what your tier grants\n` +
      `*${p}guild top* — rank all five guilds\n` +
      `*${p}guild war* — intense 1v1 / 2v2 guild clashes with format kits & teammate auras\n` +
      `*${p}guild motd <text>* — (leader) set the notice\n` +
      `*${p}guild kick <player>* — (leader) remove a member\n` +
      `*${p}guild banner* / *${p}guild pfp* — (leader) attach an image`,
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
    `_Leadership is earned, not given — the member who's conquered the most floors since joining leads._\n` +
    `_The treasury is separate: donations raise the guild's tier and buy perks for everyone, never the crown._\n\n` +
    `*${p}guild info <name>* · *${p}guild join <name>* · *${p}guild top*`,
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
    message = `✅ Welcome to ${guild.emoji} *${guild.name}*!\n\nConquer floors to climb the ranks — the top conqueror leads the guild.`
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

// ── Guild Wars (1v1 & 2v2 with Format Kits & Teammate Aura) ─────────────────

async function guildWarDispatch(ctx, allUsers, warArgs) {
  const p = config.prefix
  const sub = warArgs[0]?.toLowerCase()

  if (!ctx.player) return ctx.reply(`⚠️ Register with *${p}register* first.`)
  if (!ctx.player.guildId) return ctx.reply(`❌ You're not in a guild. Join one with *${p}guild join <name>*.`)

  if (!ctx.db.data.guildWars) ctx.db.data.guildWars = {}

  if (sub === 'challenge' || sub === 'declare') {
    return handleWarChallenge(ctx, allUsers, warArgs.slice(1))
  }
  if (sub === 'accept') {
    return handleWarAccept(ctx, allUsers, warArgs.slice(1))
  }
  if (sub === 'decline' || sub === 'cancel') {
    return handleWarCancel(ctx, allUsers)
  }
  if (sub === 'status' || sub === 'view') {
    return handleWarStatus(ctx, allUsers)
  }
  if (sub === 'attack' || sub === 'atk' || sub === 'skill' || sub === 'defend' || sub === 'drink') {
    return handleWarAction(ctx, allUsers, sub, warArgs.slice(1))
  }

  // Help menu
  const formatList = Object.values(WAR_FORMATS)
    .filter((f, idx, arr) => arr.findIndex(x => x.id === f.id) === idx)
    .map(f => `  • ${f.emoji} *${f.name}* (${f.id}): ${f.description}`)
    .join('\n')

  const auraList = Object.entries(GUILD_AURAS)
    .map(([gid, a]) => {
      const g = getGuildDef(gid)
      return `  • ${a.emoji} *${g?.name ?? gid}* [${a.name}]: ${a.description}`
    })
    .join('\n')

  return ctx.reply(
    `⚔️ *INTENSE GUILD WARS (1v1 & 2v2)*\n\n` +
    `Battle rival guilds for supremacy, treasury bounties, and guild pride!\n\n` +
    `*Commands:*\n` +
    `• *${p}guild war challenge <guild> [1v1|2v2] [format]* — issue war challenge\n` +
    `• *${p}guild war accept* — accept pending war challenge\n` +
    `• *${p}guild war decline* — decline / cancel challenge\n` +
    `• *${p}guild war status* — inspect current war board\n` +
    `• *${p}guild war attack* — basic strike\n` +
    `• *${p}guild war skill* — high-tier skill strike\n` +
    `• *${p}guild war defend* — defensive stance (+MP, 50% dmg cut)\n` +
    `• *${p}guild war drink* — quick recovery potion\n\n` +
    `*Battle Formats & Custom Kits:*\n${formatList}\n\n` +
    `*Teammate Aura Synergy (2v2 Mode):*\n${auraList}`,
  )
}

async function handleWarChallenge(ctx, allUsers, args) {
  const p = config.prefix
  const myGuildId = ctx.player.guildId
  const myGuild = getGuildDef(myGuildId)

  const targetQuery = args[0]
  if (!targetQuery) {
    return ctx.reply(`❌ Specify a target guild to challenge.\nUsage: *${p}guild war challenge <targetGuild> [1v1|2v2] [standard|mcpvp|unrestricted]*`)
  }

  const targetGuild = findGuildByQuery(targetQuery)
  if (!targetGuild) {
    return ctx.reply(`❌ No guild matching *${targetQuery}*.`)
  }
  if (targetGuild.id === myGuildId) {
    return ctx.reply(`❌ You cannot wage war against your own guild!`)
  }

  const matchType = args[1]?.toLowerCase() === '2v2' ? '2v2' : '1v1'
  const rawFormat = args[2]?.toLowerCase() || 'standard'
  const format = WAR_FORMATS[rawFormat] || WAR_FORMATS.standard

  // Check if either guild is already in an active war
  const activeWars = Object.values(ctx.db.data.guildWars || {})
  const ongoing = activeWars.find(w => w.status === 'active' && (w.guildAId === myGuildId || w.guildBId === myGuildId || w.guildAId === targetGuild.id || w.guildBId === targetGuild.id))
  if (ongoing) {
    return ctx.reply(`⚔️ A guild war involving one of these guilds is already raging! Use *${p}guild war status*.`)
  }

  // Create pending challenge
  const warId = `war_${Date.now()}`
  ctx.db.data.guildWars[warId] = {
    id: warId,
    status: 'pending',
    challengerId: ctx.player.id,
    guildAId: myGuildId,
    guildBId: targetGuild.id,
    matchType,
    formatId: format.id,
    createdAt: Date.now(),
  }
  await ctx.db.write()

  return ctx.reply(
    `⚔️ *GUILD WAR CHALLENGE ISSUED!*\n\n` +
    `${myGuild.emoji} *${myGuild.name}* has declared war upon ${targetGuild.emoji} *${targetGuild.name}*!\n\n` +
    `🥊 Mode: *${matchType}*\n` +
    `📜 Format / Kit: ${format.emoji} *${format.name}*\n` +
    `_${format.description}_\n\n` +
    `Any warrior of *${targetGuild.name}* can accept with:\n` +
    `> *${p}guild war accept*`,
  )
}

async function handleWarAccept(ctx, allUsers, args) {
  const p = config.prefix
  const myGuildId = ctx.player.guildId
  const myGuild = getGuildDef(myGuildId)

  const activeWars = ctx.db.data.guildWars || {}
  const pendingEntry = Object.entries(activeWars).find(([, w]) => w.status === 'pending' && w.guildBId === myGuildId)

  if (!pendingEntry) {
    return ctx.reply(`❌ No pending war challenge waiting for ${myGuild.emoji} *${myGuild.name}*.`)
  }

  const [warId, pending] = pendingEntry
  const opponentGuild = getGuildDef(pending.guildAId)

  // Assemble teams
  const challengerPlayer = allUsers.find(u => u.id === pending.challengerId) || ctx.player
  const teamAPlayers = [challengerPlayer]
  const teamBPlayers = [ctx.player]

  if (pending.matchType === '2v2') {
    // Pick highest active teammates
    const guildAMembers = getGuildMembers(pending.guildAId, allUsers).filter(u => u.id !== challengerPlayer.id)
    if (guildAMembers.length) teamAPlayers.push(guildAMembers[0])
    else teamAPlayers.push({ ...challengerPlayer, id: `${challengerPlayer.id}_ally`, name: `${challengerPlayer.name} [Shadow]` })

    const guildBMembers = getGuildMembers(myGuildId, allUsers).filter(u => u.id !== ctx.player.id)
    if (guildBMembers.length) teamBPlayers.push(guildBMembers[0])
    else teamBPlayers.push({ ...ctx.player, id: `${ctx.player.id}_ally`, name: `${ctx.player.name} [Vanguard]` })
  }

  const session = createWarSession({
    id: warId,
    guildAId: pending.guildAId,
    guildBId: myGuildId,
    formatId: pending.formatId,
    matchType: pending.matchType,
    teamA: teamAPlayers,
    teamB: teamBPlayers,
  })

  ctx.db.data.guildWars[warId] = session
  await ctx.db.write()

  const auraA = GUILD_AURAS[session.guildAId]
  const auraB = GUILD_AURAS[session.guildBId]
  const auraNote = session.matchType === '2v2'
    ? `\n✨ *Teammate Auras Activated!*\n` +
      `• ${opponentGuild.emoji} ${opponentGuild.name}: *${auraA?.name}*\n` +
      `• ${myGuild.emoji} ${myGuild.name}: *${auraB?.name}*\n`
    : ''

  return ctx.reply(
    `🔥 *THE BATTLE LINES ARE DRAWN!*\n\n` +
    `${opponentGuild.emoji} *${opponentGuild.name}*  ⚔️  ${myGuild.emoji} *${myGuild.name}*\n\n` +
    `Mode: *${session.matchType}*  |  Format: *${WAR_FORMATS[session.formatId]?.name}*\n` +
    auraNote + `\n` +
    `Strike with *${p}guild war attack* or *${p}guild war skill*!`
  )
}

async function handleWarCancel(ctx, allUsers) {
  const myGuildId = ctx.player.guildId
  const activeWars = ctx.db.data.guildWars || {}
  const pending = Object.entries(activeWars).find(([, w]) => w.status === 'pending' && (w.guildAId === myGuildId || w.guildBId === myGuildId))

  if (!pending) return ctx.reply(`❌ No pending war challenge to cancel.`)
  delete ctx.db.data.guildWars[pending[0]]
  await ctx.db.write()
  return ctx.reply(`🏳️ The pending guild war challenge has been withdrawn.`)
}

async function handleWarStatus(ctx, allUsers) {
  const p = config.prefix
  const activeWars = ctx.db.data.guildWars || {}
  const liveWar = Object.values(activeWars).find(w => w.status === 'active')

  if (!liveWar) {
    return ctx.reply(`🛡️ No active guild war currently in progress. Issue one with *${p}guild war challenge*.`)
  }

  const guildA = getGuildDef(liveWar.guildAId)
  const guildB = getGuildDef(liveWar.guildBId)
  const format = WAR_FORMATS[liveWar.formatId] || WAR_FORMATS.standard

  const formatTeam = (team) => team.map(f => {
    const status = f.alive ? `❤️ ${f.hp}/${f.maxHp} HP  💧 ${f.mp}/${f.maxMp} MP` : `💀 _Fallen_`
    return `  • *${f.name}*: ${status}`
  }).join('\n')

  const lastLogs = liveWar.combatLog.slice(-5).join('\n') || '_Battle commencing..._'

  return ctx.reply(
    `⚔️ *GUILD WAR ARENA — LIVE CLASH*\n\n` +
    `${guildA.emoji} *${guildA.name}* vs ${guildB.emoji} *${guildB.name}*\n` +
    `Mode: *${liveWar.matchType}* | Format: *${format.name}*\n\n` +
    `*${guildA.name} Lineup:*\n${formatTeam(liveWar.teamA)}\n\n` +
    `*${guildB.name} Lineup:*\n${formatTeam(liveWar.teamB)}\n\n` +
    `📜 *Recent Clashes:*\n${lastLogs}\n\n` +
    `*Commands:* *${p}guild war attack* · *${p}guild war skill* · *${p}guild war defend* · *${p}guild war drink*`,
  )
}

async function handleWarAction(ctx, allUsers, action, extraArgs) {
  const p = config.prefix
  const activeWars = ctx.db.data.guildWars || {}
  const liveEntry = Object.entries(activeWars).find(([, w]) => w.status === 'active')

  if (!liveEntry) {
    return ctx.reply(`❌ No active guild war in progress. Start one with *${p}guild war challenge*.`)
  }

  const [warId, session] = liveEntry
  const isTeamA = session.teamA.some(f => f.id === ctx.player.id)
  const isTeamB = session.teamB.some(f => f.id === ctx.player.id)

  if (!isTeamA && !isTeamB) {
    return ctx.reply(`❌ You are not a combatant in this active guild war! Spectate with *${p}guild war status*.`)
  }

  const res = resolveWarTurn(session, ctx.player.id, action)
  if (!res.ok) {
    return ctx.reply(res.msg)
  }

  if (res.finished) {
    const winningGuild = getGuildDef(res.winnerGuildId)
    // Reward winning guild treasury with 50,000 solars
    const guildRec = getGuildRecord(ctx.db, res.winnerGuildId)
    guildRec.treasury += 50000
    delete ctx.db.data.guildWars[warId]
    await ctx.db.write()

    return ctx.reply(
      `${res.logs.join('\n')}\n\n` +
      `🏆━━━━━━━━━━━━━━━━━━━━🏆\n` +
      `👑 *VICTORY TO ${winningGuild.emoji} ${winningGuild.name.toUpperCase()}!*\n` +
      `Through sheer grit, tactics, and unbreakable teammate aura, they have triumphed!\n` +
      `💰 Treasury Award: +50,000 Solars added to *${winningGuild.name}*'s vault!`
    )
  }

  await ctx.db.write()
  return ctx.reply(`${res.logs.join('\n')}\n\n_Next warrior may take their move: *${p}guild war attack|skill|defend|drink*._`)
}

