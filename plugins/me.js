/**
 * me.js — .me
 * Short profile summary: name, bio, rank, level, wallet, waifu, race.
 * Each line is star-marked and set in a monospace block (WhatsApp's only
 * distinct-font formatting) so it visually stands apart from the bot's
 * normal message style.
 *
 * For the full detailed profile (stats, gear, abilities, location, etc.),
 * see <prefix>profile / <prefix>stats (plugins/profile.js).
 */
import { fmtGems } from '../lib/format.js'
import { fmtMonds } from '../lib/monds.js'
import { getRankForLevel } from '../lib/rank-engine.js'
import { races } from '../lib/game-data.js'
import { getWaifu } from '../lib/card-engine.js'
import { renderProfileCard } from '../lib/profile-card-render.mjs'

export default {
  name: 'me',
  aliases: [],
  category: 'account',
  requiresPlayer: true,
  description: 'View a short summary of your profile (name, bio, rank, level, wallet, waifu, race)',

  async run(ctx) {
    const p = ctx.player
    const rank = getRankForLevel(p.level)
    const raceName = races[p.raceId]?.name ?? p.raceId
    const w = p.wallet ?? {}
    const waifuCard = getWaifu(p)
    const waifuLine = waifuCard ? `${waifuCard.title} (${waifuCard.series})` : 'none set'

    const lines = [
      `★ Name: ${p.name}`,
      `★ Title: ${p.title ?? 'none earned'}`,
      `★ Bio: ${p.bio ?? 'no bio set'}`,
      `★ Rank: ${rank.emoji} ${rank.title}`,
      `★ Level: ${p.level}`,
      `★ Wallet: ☀️ ${w.solars ?? 0}  💎 ${fmtGems(w.gems ?? 0)}  🪙 ${fmtMonds(w.monds ?? 0)}`,
      `★ Also: ✨ ${p.seasonPoints ?? 0} SP  🔒 ${w.vault ?? 0} vault`,
      `★ Waifu: ${waifuLine}`,
      `★ Race: ${raceName}`,
    ]
    const shortText = '```\n' + lines.join('\n') + '\n```'

    // Always render the composited profile card (pfp/banner or shared
    // defaults) rather than only when a custom pfp was set. The whole
    // player record goes in: the card draws name/handle/rank/wallet onto
    // the image itself now (see lib/profile-card-render.mjs).
    try {
      const cardBuffer = await renderProfileCard(p)
      await ctx.replyImage(cardBuffer, shortText)
    } catch (err) {
      // Render failing should never block .me entirely.
      await ctx.reply(shortText)
    }
  },
}
