/**
 * friend.js — mutual friends system.
 *
 * Two new fields on every player (lazily defaulted to [] if absent):
 *   player.friends:        string[]  — confirmed mutual friend JIDs
 *   player.friendRequests: string[]  — incoming pending request JIDs
 *
 * Both sides are always kept in sync via sequential updatePlayer calls,
 * same two-party-mutation pattern used by rob.js and pvp.js.
 *
 * Commands:
 *   .friend list           — view friends & pending requests
 *   .friend add @user      — send a friend request
 *   .friend accept @user   — accept an incoming request (both sides added)
 *   .friend decline @user  — decline an incoming request
 *   .friend remove @user   — unfriend (both sides removed)
 */
import { config } from '../config.js'
import { getPlayer, updatePlayer, playerExists } from '../lib/player-repo.js'

const MAX_FRIENDS = 50

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

export default {
  name:           'friend',
  aliases:        ['friends', 'fr'],
  category:       'social',
  requiresPlayer: true,
  description:    'Manage your friends list',

  async run(ctx) {
    const { player, args, db } = ctx
    const pr  = config.prefix
    const sub = (args[0] ?? 'list').toLowerCase()

    // ── LIST ──────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const friends  = player.friends        ?? []
      const requests = player.friendRequests ?? []

      const friendLines = friends.map(jid => {
        const f = getPlayer(db, jid)
        return f ? `  👤 *${f.name}* Lv.${f.level}` : `  ❓ Unknown (${jid.replace(/@.*/, '')})`
      })
      const reqLines = requests.map(jid => {
        const f = getPlayer(db, jid)
        return f
          ? `  📩 *${f.name}* — _${pr}friend accept @${f.name}_`
          : `  📩 Unknown (${jid.replace(/@.*/, '')})`
      })

      let msg = `👥 *YOUR FRIENDS* (${friends.length}/${MAX_FRIENDS})\n\n`
      msg += friends.length
        ? friendLines.join('\n')
        : `  _No friends yet. Use *${pr}friend add @player* to connect!_`
      if (requests.length) msg += `\n\n📬 *Pending requests (${requests.length}):*\n` + reqLines.join('\n')
      return ctx.reply(msg)
    }

    // ── ADD (send request) ────────────────────────────────────────────────
    if (sub === 'add' || sub === 'request') {
      const targetJid = resolveTargetJid(ctx, args[1])
      if (!targetJid)                     return ctx.reply(`❓ Usage: *${pr}friend add @player*`)
      if (targetJid === ctx.from)         return ctx.reply(`❌ You can't friend yourself.`)
      if (!playerExists(db, targetJid))  return ctx.reply(`❌ That player isn't registered yet.`)

      const target     = getPlayer(db, targetJid)
      const myFriends  = player.friends        ?? []
      const theirReqs  = target.friendRequests ?? []

      if (myFriends.includes(targetJid))
        return ctx.reply(`⚠️ *${target.name}* is already your friend.`)
      if (theirReqs.includes(ctx.from))
        return ctx.reply(`⏳ You already sent *${target.name}* a request — waiting on them.`)

      // If they already sent us a request, auto-accept instead of double-requesting
      if ((player.friendRequests ?? []).includes(targetJid))
        return handleAccept(ctx, targetJid)

      if (myFriends.length >= MAX_FRIENDS)
        return ctx.reply(`❌ You're at the friend limit (${MAX_FRIENDS}).`)

      await updatePlayer(db, targetJid, (t) => {
        t.friendRequests = [...(t.friendRequests ?? []), ctx.from]
      })

      return ctx.reply(
        `📩 Friend request sent to *${target.name}*!\n` +
        `_They'll see it when they type *${pr}friend list*._`,
      )
    }

    // ── ACCEPT ────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const targetJid = resolveTargetJid(ctx, args[1])
      if (!targetJid) return ctx.reply(`❓ Usage: *${pr}friend accept @player*`)
      return handleAccept(ctx, targetJid)
    }

    // ── DECLINE ───────────────────────────────────────────────────────────
    if (sub === 'decline') {
      const targetJid = resolveTargetJid(ctx, args[1])
      if (!targetJid) return ctx.reply(`❓ Usage: *${pr}friend decline @player*`)

      const requests = player.friendRequests ?? []
      if (!requests.includes(targetJid))
        return ctx.reply(`❌ No pending request from that player.`)

      const fromName = playerExists(db, targetJid) ? getPlayer(db, targetJid).name : 'them'
      await updatePlayer(db, ctx.from, (p) => {
        p.friendRequests = (p.friendRequests ?? []).filter(j => j !== targetJid)
      })
      return ctx.reply(`🚫 Declined friend request from *${fromName}*.`)
    }

    // ── REMOVE ────────────────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'unfriend' || sub === 'delete') {
      const targetJid = resolveTargetJid(ctx, args[1])
      if (!targetJid) return ctx.reply(`❓ Usage: *${pr}friend remove @player*`)

      if (!(player.friends ?? []).includes(targetJid))
        return ctx.reply(`❌ That player isn't in your friends list.`)

      const targetName = playerExists(db, targetJid) ? getPlayer(db, targetJid).name : 'them'

      await updatePlayer(db, ctx.from, (p) => {
        p.friends = (p.friends ?? []).filter(j => j !== targetJid)
      })
      await updatePlayer(db, targetJid, (t) => {
        t.friends = (t.friends ?? []).filter(j => j !== ctx.from)
      })

      return ctx.reply(`💔 Removed *${targetName}* from your friends list.`)
    }

    return ctx.reply(
      `👥 *Friends Commands:*\n` +
      `  *${pr}friend list*             — view friends & requests\n` +
      `  *${pr}friend add @player*      — send a request\n` +
      `  *${pr}friend accept @player*   — accept a request\n` +
      `  *${pr}friend decline @player*  — decline a request\n` +
      `  *${pr}friend remove @player*   — unfriend`,
    )
  },
}

// ── Shared accept handler ────────────────────────────────────────────────────
async function handleAccept(ctx, targetJid) {
  const { player, db } = ctx
  const pr = config.prefix

  const requests = player.friendRequests ?? []
  if (!requests.includes(targetJid))
    return ctx.reply(`❌ No pending friend request from that player.`)

  if (!playerExists(db, targetJid)) {
    await updatePlayer(db, ctx.from, (p) => {
      p.friendRequests = (p.friendRequests ?? []).filter(j => j !== targetJid)
    })
    return ctx.reply(`❌ That player is no longer registered.`)
  }

  const myFriends = player.friends ?? []
  if (myFriends.length >= MAX_FRIENDS)
    return ctx.reply(`❌ You're at the friend limit (${MAX_FRIENDS}).`)

  const target = getPlayer(db, targetJid)
  if ((target.friends ?? []).length >= MAX_FRIENDS)
    return ctx.reply(`❌ *${target.name}* is at the friend limit (${MAX_FRIENDS}).`)

  await updatePlayer(db, ctx.from, (p) => {
    p.friendRequests = (p.friendRequests ?? []).filter(j => j !== targetJid)
    p.friends = [...new Set([...(p.friends ?? []), targetJid])]
  })
  await updatePlayer(db, targetJid, (t) => {
    t.friends = [...new Set([...(t.friends ?? []), ctx.from])]
  })

  ctx.sock.sendMessage(targetJid, {
    text: `🤝 *${player.name}* accepted your friend request! You're now friends.`,
  }).catch(() => {})

  return ctx.reply(`🤝 *${target.name}* is now your friend!`)
}
