/**
 * rank — Solo-Leveling-style hunter rank, derived from player level.
 *
 * Usage:
 *   <prefix>rank        — your current rank + next tier
 *   <prefix>rank list    — full Lv 1–100 rank table (E-Rank → Shadow Sovereign)
 */
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'
import { getRankForLevel, getNextRank, formatRankTable, getXpProgress, rankSlug } from '../lib/rank-engine.js'
import { playerLevelCap } from '../lib/reborn-engine.js'
import { progressBar } from '../lib/combat-engine.js'

export default {
  name:           'rank',
  aliases:        ['hunterrank', 'ranktier'],
  category:       'account',
  requiresPlayer: false,
  description:    'View your hunter rank, XP progress to next level, or the full Lv 1–100 rank table',

  async run(ctx) {
    const { args, reply, player } = ctx
    const p = config.prefix
    const sub = args[0]?.toLowerCase()

    if (sub === 'list' || sub === 'all' || sub === 'table') {
      return reply(
        `📜 *HUNTER RANK TABLE — Lv 1 to 100*\n` +
        `─────────────────────\n` +
        `${formatRankTable()}\n\n` +
        `_Ranks rise automatically with level — check yours with *${p}rank*._`,
      )
    }

    if (!player) {
      return reply(`⚠️ Register with *${p}register* first — or use *${p}rank list* to browse the full table.`)
    }

    const current  = getRankForLevel(player.level)
    const next     = getNextRank(player.level)
    const progress = getXpProgress(player.level, player.xp, playerLevelCap(player))

    const xpLine = progress.maxed
      ? `✨ *XP:* MAX LEVEL REACHED`
      : `✨ ${progressBar(progress.pct)} ${Math.round(progress.pct * 100)}%\n` +
        `   ${progress.intoLevel.toLocaleString()} / ${progress.forLevel.toLocaleString()} XP  _(${progress.xpToNext.toLocaleString()} to next level)_`

    const nextLine = next
      ? `📈 *Next rank:* ${next.emoji} ${next.title} at Level *${next.min}*`
      : `🌌 _You've reached the highest rank attainable._`

    const caption =
      `${current.emoji} *${current.title}*\n` +
      `_"${current.epithet}"_\n` +
      `─────────────────────\n` +
      `👤 *${player.name}*  •  Level *${player.level}*\n\n` +
      xpLine + `\n\n` +
      nextLine +
      `\n\n_Use *${p}rank list* to see the full Lv 1–100 rank table._`
    return sendImage(ctx, `rank_${rankSlug(current.title)}.jpg`,
      `*Astral Hunter Rank*\n${current.emoji} ${current.title} — Level ${player.level}\n\n${caption}`)
  },
}
