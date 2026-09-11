/**
 * gcinfo.js — .gcinfo
 *
 * Everything WhatsApp knows about this group in one card: name, id, creator,
 * age, member/admin counts, the native send/edit locks, and whether the bot is
 * an admin.
 *
 * Deliberately NOT aliased to `groupinfo` — plugins-telegram/chatinfo.js
 * already claims that alias, and in combined mode (main-all.js) all three
 * platforms share one registry, so reusing it would clobber Telegram's command
 * and log an alias collision at boot.
 *
 * Read-only, so any member can run it. It exposes nothing a member can't
 * already see by opening the group info screen — unlike plugins/gclink.js,
 * which hands out the invite link and is admin-gated for that reason.
 */
import { NOT_GROUP, checkBotAdmin } from '../lib/group-helpers.js'
import { getGroupSettings } from '../lib/group-settings.js'
import { config, logger } from '../config.js'

/** Unix seconds → "12 Mar 2024". WhatsApp reports `creation` in seconds. */
function fmtDate(secs) {
  if (!secs) return 'unknown'
  const d = new Date(Number(secs) * 1000)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default {
  name:           'gcinfo',
  aliases:        ['gcdetails', 'groupdetails'],
  category:       'utility',
  requiresPlayer: false,
  platforms:      ['whatsapp'],   // sock.groupMetadata — Baileys-only
  description:    'Show this group\'s details (.gcinfo)',

  async run(ctx) {
    const { reply, sender, isGroup, sock, msg } = ctx
    const p = config.prefix
    if (!isGroup) return reply(NOT_GROUP)

    let meta, botIsAdmin = false
    try {
      const res = await checkBotAdmin(sock, sender)
      meta = res.meta
      botIsAdmin = res.isAdmin
    } catch (err) {
      logger.warn({ err: err.message, jid: sender }, 'gcinfo: groupMetadata failed')
      return reply(`❌ Couldn't read this group's details: _${err.message}_`)
    }

    const parts   = meta.participants ?? []
    const admins  = parts.filter(pt => pt.admin === 'admin' || pt.admin === 'superadmin')
    const creator = meta.owner ?? meta.subjectOwner ?? null
    const s       = await getGroupSettings(sender)

    // Which bot features this group has opted into — the same flags .gcsettings
    // lists in full, summarised here as the one line people actually ask about.
    const on = [
      s.pvpEnabled     && 'PvP',
      s.miningEnabled  && 'Mining',
      s.dungeonEnabled && 'Dungeons',
      s.cardsEnabled   && 'Cards',
      s.seriesEnabled  && 'Series',
      s.pokemonEnabled && 'Pokémon',
    ].filter(Boolean)

    const lines = [
      `📋 *GROUP INFO*`,
      `─────────────────────`,
      `*${meta.subject ?? 'Unnamed group'}*`,
      ``,
      `🆔 \`${meta.id ?? sender}\``,
      `👥 Members: *${parts.length}*  (admins: *${admins.length}*)`,
      `📅 Created: *${fmtDate(meta.creation)}*`,
      creator ? `👑 Creator: @${String(creator).replace(/@.*$/, '')}` : null,
      ``,
      `💬 Messages: *${meta.announce ? 'admins only 🔒' : 'everyone 🔓'}*`,
      `✏️ Edit info: *${meta.restrict ? 'admins only 🔐' : 'everyone 🔓'}*`,
      meta.joinApprovalMode ? `✅ Join approval: *on*` : null,
      meta.memberAddMode ? `➕ Add members: *${meta.memberAddMode === 'admin_add' ? 'admins only' : 'everyone'}*` : null,
      `🤖 Bot is admin: *${botIsAdmin ? 'yes' : 'no'}*`,
      ``,
      `🎮 Features on: *${on.length ? on.join(', ') : 'none'}*`,
      `🛡️ Antilink: *${s.antilink ? 'ON' : 'OFF'}*  ·  Welcome: *${s.welcome ? 'ON' : 'OFF'}*`,
      meta.desc ? `\n📝 *Description*\n${String(meta.desc).slice(0, 500)}` : null,
      ``,
      `_${p}gcsettings for every saved setting._`,
    ].filter(l => l !== null)

    return sock.sendMessage(
      sender,
      { text: lines.join('\n'), mentions: creator ? [creator] : [] },
      { quoted: msg },
    )
  },
}
