/**
 * top.js — compact multi-category snapshot.
 *
 * Shows the top 3 from three categories (level, wealth, fame) in one message.
 * Intentionally lighter than .ranking: no dungeon breakdowns, no 10-entry
 * lists — just a quick "who's on top right now" across the three axes that
 * matter most to players.
 *
 * Reads the same db.data.users source as leaderboard.js, but filters and
 * sorts inline here since the logic is too compact to warrant a shared helper.
 *
 * Usage: .top
 */
import { config } from '../config.js'
import { getRankForLevel } from '../lib/rank-engine.js'
import { getFameTier } from '../lib/fame-engine.js'
import { renderTopPodium } from '../lib/top-render.mjs'
import { playerLevelCap } from '../lib/reborn-engine.js'
import { isTitled, ensurePrestige, getTierForXp } from '../lib/title-engine.js'

function medal(i) {
  return ['🥇', '🥈', '🥉'][i] ?? `*${i + 1}.*`
}

export default {
  name:           'top',
  aliases:        ['snapshot'],
  category:       'social',
  requiresPlayer: false,
  description:    'Quick top-3 snapshot across level, wealth, and fame',

  async run(ctx) {
    const { db, reply } = ctx
    const p = config.prefix

    await db.read()
    const users = Object.values(db.data.users ?? {}).filter(u => !u.hiddenFromLeaderboard)
    if (!users.length) return reply('_No players registered yet._')

    // ── Top 3 by level ────────────────────────────────────────────────────
    // Titled players (level 200, the cap) tiebreak on prestige.xp rather
    // than raw xp — see plugins/leaderboard.js's identical fix for why
    // cumulative xp stops meaning anything once a player is capped.
    const levelSortKey = (u) => {
      const cap = (() => { try { return playerLevelCap(u) } catch { return 200 } })()
      return isTitled(u, cap) ? ensurePrestige(u).xp : u.xp
    }
    const byLevel = [...users]
      .sort((a, b) => b.level - a.level || levelSortKey(b) - levelSortKey(a))
      .slice(0, 3)
    const levelLines = byLevel.map((u, i) => {
      const cap = (() => { try { return playerLevelCap(u) } catch { return 200 } })()
      if (isTitled(u, cap)) {
        const tier = getTierForXp(ensurePrestige(u).xp)
        return `  ${medal(i)} *${u.name}* — Lv.*${u.level}* ${tier.glyph} _(${tier.name})_`
      }
      const r = getRankForLevel(u.level)
      return `  ${medal(i)} *${u.name}* — Lv.*${u.level}* ${r.emoji} _(${r.title})_`
    })

    // ── Top 3 by wealth (wallet.solars) ───────────────────────────────────
    const byWealth = [...users]
      .sort((a, b) => (b.wallet?.solars ?? 0) - (a.wallet?.solars ?? 0))
      .slice(0, 3)
    const wealthLines = byWealth.map((u, i) =>
      `  ${medal(i)} *${u.name}* — ☀️ ${(u.wallet?.solars ?? 0).toLocaleString()} solars`
    )

    // ── Top 3 by fame ─────────────────────────────────────────────────────
    const byFame = [...users]
      .sort((a, b) => (b.fame ?? 0) - (a.fame ?? 0))
      .slice(0, 3)
    const fameLines = byFame.map((u, i) => {
      const tier = getFameTier(u.fame ?? 0)
      return `  ${medal(i)} *${u.name}* — ${tier.emoji} ${(u.fame ?? 0).toLocaleString()} fame _(${tier.label})_`
    })

    const caption =
      `🏆 *WORLD OF ASTRAL — TOP SNAPSHOT*\n\n` +
      `⚔️ *Highest Level*\n${levelLines.join('\n')}\n\n` +
      `💰 *Wealthiest*\n${wealthLines.join('\n')}\n\n` +
      `🌟 *Most Famous*\n${fameLines.join('\n')}\n\n` +
      `_Podium shows the top 3 by level. Full rankings: *${p}ranking* · *${p}ranking floor*_`

    // ── Podium image (top 3 by level) — falls back to text on render error ──
    try {
      const podiumEntries = byLevel.map(u => {
        const cap = (() => { try { return playerLevelCap(u) } catch { return 200 } })()
        const titled = isTitled(u, cap)
        const tier = titled ? getTierForXp(ensurePrestige(u).xp) : null
        return {
          name:       u.name,
          level:      u.level ?? 1,
          rankTitle:  tier ? tier.name : getRankForLevel(u.level).title,
          // Only set for a titled player — see lib/top-render.mjs's
          // drawColumn for why the glyph needs its own font segment
          // (same @napi-rs/canvas fallback limitation as the profile card;
          // see lib/title-glyphs.js's header for the full explanation).
          titleGlyph: tier ? tier.glyph : null,
          idImage:    u.idImage ?? null,
          pfp:        u.pfp ?? null,
        }
      })
      const buf = await renderTopPodium(podiumEntries)
      return ctx.replyImage(buf, caption)
    } catch (err) {
      return reply(caption)
    }
  },
}
