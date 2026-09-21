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
import { isTitled, ensurePrestige, getPrestigeProgress, MAX_PRESTIGE_TIER } from '../lib/title-engine.js'

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

    const cap = playerLevelCap(player)

    // Level-200 prestige titles (lib/title-engine.js) replace the ordinary
    // rank readout once a player is titled — checking your "rank" is exactly
    // where this belongs, since data/ranks.json has nothing left to say past
    // Shadow Sovereign (level 100) and a titled player is always well past
    // that. Uses Shadow Sovereign's own flavor image as a fallback visual
    // (sendImage already degrades to plain text if even that's missing —
    // see lib/image.js) since there's no per-title artwork, but the caption
    // carries the actual information regardless of whether the image loads.
    if (isTitled(player, cap)) {
      const state = ensurePrestige(player)
      const progress = getPrestigeProgress(state.xp)
      const { tier, next } = progress

      const xpLine = progress.maxed
        ? `✨ *Prestige XP:* MAX TITLE REACHED`
        : `✨ ${progressBar(progress.pct)} ${Math.round(progress.pct * 100)}%\n` +
          `   ${progress.intoTier.toLocaleString()} / ${progress.forTier.toLocaleString()} XP  _(${progress.xpToNext.toLocaleString()} to next title)_`

      const nextLine = next
        ? `📈 *Next title:* ${next.glyph} *${next.name}*`
        : `🌌 _You've reached the highest title attainable — ${MAX_PRESTIGE_TIER.glyph} ${MAX_PRESTIGE_TIER.name}._`

      const shadowSovereignSlug = rankSlug('Shadow Sovereign')
      const caption =
        `${tier.glyph} *${tier.name}*\n` +
        `_"Beyond Level ${cap}"_\n` +
        `─────────────────────\n` +
        `👤 *${player.name}*  •  Level *${player.level}* (maxed)\n\n` +
        xpLine + `\n\n` +
        nextLine +
        `\n\n_Ordinary levelling stopped at ${cap} — this is the endgame title ladder that replaced it._`
      return sendImage(ctx, `rank_${shadowSovereignSlug}.jpg`,
        `*Astral Hunter Rank*\n${tier.glyph} ${tier.name} — Level ${player.level} (Titled)\n\n${caption}`)
    }

    const current  = getRankForLevel(player.level)
    const next     = getNextRank(player.level)
    const progress = getXpProgress(player.level, player.xp, cap)

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
