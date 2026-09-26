/**
 * pvpstats.js — the duel record and the ladder.
 *
 * Two commands out of one file because they read the same store: `.pvpstats`
 * is one player's card, `.pvptop` is everyone sorted by rating. Dispatch is
 * on ctx.cmd (the *invoked* name), the same alias-decides-the-action pattern
 * plugins/farm.js uses for harvest/plant.
 *
 * Nothing here writes. ensurePvp() is called on read only to give accounts
 * that predate the ladder a shape to display — the backfill lands for real
 * the next time pvpConclude() writes them, so there is no need to take the
 * player-repo write queue just to look at a leaderboard.
 */
import { config } from '../config.js'
import { getPlayer, playerExists } from '../lib/player-repo.js'
import {
  ensurePvp, ratingOf, rankFor, winRate, duelsPlayed, isProvisional,
  streakLabel, powerScore, RANKS, PLACEMENT_DUELS, BASE_RATING,
} from '../lib/pvp-engine.js'
import { getGuildDef } from '../lib/guild-repo.js'

function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = String(raw).replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

/** Every registered player, shape-guaranteed for display. */
function allDuellists(db) {
  return Object.values(db.data.users ?? {}).filter(Boolean).map((u) => {
    ensurePvp(u)
    return u
  })
}

/** How far into the current band, and what's next. Purely cosmetic. */
function bandProgress(player) {
  const rating = ratingOf(player)
  const band = rankFor(player)
  const next = RANKS.find(r => r.min > rating && r.min !== -Infinity)
  if (!next) return `${band.emoji} *${band.name}* — top of the ladder.`
  return `${band.emoji} *${band.name}* → ${next.emoji} ${next.name} in *${next.min - rating}* rating`
}

function statsCard(ctx, target, isSelf) {
  const pr = config.prefix
  const pvp = target.pvp
  const played = duelsPlayed(target)
  const guildDef = target.guildId ? getGuildDef(target.guildId) : null

  if (!played) {
    return ctx.reply(
      `🥊 *DUEL RECORD — ${target.name}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⬜ *Unranked* — no duels fought yet.\n` +
      `📊 Rating sits at the ${BASE_RATING} baseline until then.\n\n` +
      (isSelf
        ? `_Fight *${PLACEMENT_DUELS}* duels to get placed. Start with *${pr}pvp @someone*._`
        : `_They haven't been placed yet. *${PLACEMENT_DUELS}* duels does it._`),
    )
  }

  const net = (pvp.solarsWon ?? 0) - (pvp.solarsLost ?? 0)
  const lastLine = pvp.lastOpponent
    ? `🕐 Last duel: *${pvp.lastResult === 'win' ? 'beat' : 'lost to'}* ${pvp.lastOpponent}`
    : ''

  return ctx.reply(
    `🥊 *DUEL RECORD — ${target.name}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Lv.${target.level}${guildDef ? `  ·  ${guildDef.emoji ?? '🏰'} ${guildDef.name}` : ''}\n` +
    `${bandProgress(target)}` +
    (isProvisional(target) ? `\n⏳ _Unplaced — ${PLACEMENT_DUELS - played} more duel(s) to get a rank._` : '') + `\n\n` +

    `📊 *Rating* ${ratingOf(target)}   _(peak ${pvp.peak})_\n` +
    `🏆 *${pvp.wins}W* ${pvp.losses}L  ·  *${winRate(target)}%* win rate over ${played}\n` +
    `🔥 Streak *${streakLabel(target)}*  ·  best *W${pvp.bestStreak ?? 0}*\n` +
    `⚡ Power score *${powerScore(target).toLocaleString()}*\n\n` +

    `☀️ *SOLARS*\n` +
    `📥 Seized *${(pvp.solarsWon ?? 0).toLocaleString()}*  ·  📤 Lost *${(pvp.solarsLost ?? 0).toLocaleString()}*\n` +
    `${net >= 0 ? '📈' : '📉'} Net *${net >= 0 ? '+' : ''}${net.toLocaleString()}*\n` +
    (lastLine ? `\n${lastLine}\n` : '') +
    `\n_${isSelf ? `*${pr}pvptop* for the ladder · *${pr}scout @user* before you commit` : `*${pr}scout* on their message for the full matchup`}._`,
  )
}

function ladder(ctx) {
  const pr = config.prefix
  const ranked = allDuellists(ctx.db)
    .filter(u => duelsPlayed(u) > 0)
    .sort((a, b) => ratingOf(b) - ratingOf(a) || duelsPlayed(b) - duelsPlayed(a))

  if (!ranked.length) {
    return ctx.reply(
      `🏅 *DUEL LADDER*\n\n` +
      `_Nobody has fought a duel yet. Be the first: *${pr}pvp @someone*._`,
    )
  }

  const MEDALS = ['🥇', '🥈', '🥉']
  const top = ranked.slice(0, 10)
  const lines = top.map((u, i) => {
    const band = rankFor(u)
    const place = MEDALS[i] ?? `*${i + 1}.*`
    return `${place} ${band.emoji} *${u.name}* — ${ratingOf(u)}\n` +
      `      ${u.pvp.wins}W ${u.pvp.losses}L _(${winRate(u)}%)_ · ${streakLabel(u)}` +
      (isProvisional(u) ? ` · _unplaced_` : '')
  })

  const mine = ranked.findIndex(u => u.id === ctx.from)
  const myLine = mine === -1
    ? `_You're unranked — fight a duel to join the ladder._`
    : mine < top.length
      ? `_You're *#${mine + 1}* on the ladder._`
      : `_You're *#${mine + 1}* of ${ranked.length} — ${ratingOf(ranked[mine])} rating._`

  return ctx.reply(
    `🏅 *DUEL LADDER* — top ${top.length} of ${ranked.length}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines.join('\n')}\n\n` +
    `${myLine}\n\n` +
    `_*${pr}pvpstats* for your own card · *${pr}scout @user* to read a matchup._`,
  )
}

export default {
  name: 'pvpstats',
  aliases: ['duelstats', 'pvptop', 'duelrank', 'ladder'],
  category: 'pvp',
  requiresPlayer: true,
  description: 'Your duel record, or the rating ladder',
  subcommands: [
    { cmd: 'pvpstats [@user]', desc: 'a duel record — yours by default' },
    { cmd: 'pvptop', desc: 'the top of the rating ladder' },
  ],

  async run(ctx) {
    const invoked = (ctx.cmd ?? 'pvpstats').toLowerCase()
    if (invoked === 'pvptop' || invoked === 'duelrank' || invoked === 'ladder') return ladder(ctx)

    const targetJid = resolveTargetJid(ctx, ctx.args[0])
    if (!targetJid || targetJid === ctx.from) {
      ensurePvp(ctx.player)
      return statsCard(ctx, ctx.player, true)
    }
    if (!playerExists(ctx.db, targetJid)) {
      return ctx.reply(`❌ That player isn't registered yet.`)
    }
    const target = getPlayer(ctx.db, targetJid)
    ensurePvp(target)
    return statsCard(ctx, target, false)
  },
}
