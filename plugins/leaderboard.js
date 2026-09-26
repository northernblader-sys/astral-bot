/**
 * leaderboard.js — Player rankings.
 *
 * .ranking            — top 10 by player level (default)
 * .ranking floor       — overall top 10 by highest floor reached (any dungeon)
 * .ranking <dungeon>   — top 10 for a specific dungeon
 */
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'
import { locationsMap } from '../lib/game-data.js'
import { getRankForLevel } from '../lib/rank-engine.js'
import { playerLevelCap } from '../lib/reborn-engine.js'
import { isTitled, ensurePrestige, getTierForXp } from '../lib/title-engine.js'

export default {
  name:           'ranking',
  aliases:        ['leaderboard', 'ranks'],
  category:       'social',
  requiresPlayer: false,
  description:    'View dungeon floor rankings',

  async run(ctx) {
    const { args, reply, db } = ctx
    const p = config.prefix

    await db.read()
    // hiddenFromLeaderboard — opt a specific account (e.g. an owner/admin test
    // account) out of every ranking view below. The flag only affects ranking
    // visibility; it doesn't touch the account's actual stats or progress.
    const users = Object.values(db.data.users ?? {}).filter(u => !u.hiddenFromLeaderboard)

    const sub = args[0]?.toLowerCase()

    // Default (no args): top by level
    if (!sub || sub === 'level' || sub === 'lv') {
      // Once a player is titled, level (200) can no longer distinguish
      // standing among them, and neither can raw cumulative xp: it just
      // keeps climbing after the cap with nothing to do with it (see
      // lib/title-engine.js's header) rather than reflecting real
      // post-cap progress the way prestige.xp does. Sort titled players by
      // that instead, so the board actually orders them by who's closer to
      // Ⓛ🅜 rather than by an incidental leftover number.
      const sortKey = (u) => {
        const cap = (() => { try { return playerLevelCap(u) } catch { return 200 } })()
        return isTitled(u, cap) ? ensurePrestige(u).xp : u.xp
      }
      const sorted = users
        .sort((a, b) => b.level - a.level || sortKey(b) - sortKey(a))
        .slice(0, 10)
      const rows = sorted.map((u, i) => {
        const cap = (() => { try { return playerLevelCap(u) } catch { return 200 } })()
        if (isTitled(u, cap)) {
          const tier = getTierForXp(ensurePrestige(u).xp)
          return `${medal(i)} ${tier.glyph} *${u.name}* — Lv.*${u.level}* _(${tier.name})_  (${u.classId ?? '?'})`
        }
        const r = getRankForLevel(u.level)
        return `${medal(i)} ${r.emoji} *${u.name}* — Lv.*${u.level}* _(${r.title})_  (${u.classId ?? '?'})`
      })
      const caption = `🏅 *TOP ADVENTURERS — LEVEL*\n\n${rows.join('\n') || '_No players yet._'}\n\n` +
        `_Use *${p}ranking floor* for overall floor rankings, or *${p}ranking <dungeon>* for a specific tower._`
      return sendImage(ctx, 'leaderboard_card.jpg',
        `*Astral Leaderboard*\nTop adventurers by level, right now\n\n${caption}`)
    }

    // Specific dungeon
    const dungeons = Object.values(locationsMap).filter(l => l.type === 'dungeon')

    if (sub !== 'floor' && sub !== 'all') {
      const loc = locationsMap[sub] ?? dungeons.find(l => l.name.toLowerCase().includes(sub))
      if (!loc) {
        const list = dungeons.map(l => `  • *${l.id}* — ${l.name}`).join('\n')
        return reply(`❌ Unknown dungeon *${sub}*.\n\nAvailable:\n${list}\n\nUsage: *${p}ranking <dungeon_id>*`)
      }

      const sorted = users
        .filter(u => u.dungeonProgress?.[loc.id]?.highestFloor > 0)
        .sort((a, b) => (b.dungeonProgress[loc.id]?.highestFloor ?? 0) - (a.dungeonProgress[loc.id]?.highestFloor ?? 0))
        .slice(0, 10)

      const rows = sorted.map((u, i) => {
        const prog = u.dungeonProgress[loc.id]
        const conquered = prog.conquered ? ' 👑' : ''
        return `${medal(i)} *${u.name}* — Floor *${prog.highestFloor}*${conquered}  Lv.${u.level}`
      })

      return reply(
        `🗺️ *${loc.name.toUpperCase()} — TOP FLOORS*\n\n` +
        `${rows.join('\n') || '_No one has entered this dungeon yet._'}\n\n` +
        `👑 = conquered`,
      )
    }

    // Overall: best floor across all dungeons
    const scored = users.map(u => {
      let best = 0; let bestLoc = null
      for (const [locId, prog] of Object.entries(u.dungeonProgress ?? {})) {
        if ((prog.highestFloor ?? 0) > best) { best = prog.highestFloor; bestLoc = locId }
      }
      return { name: u.name, level: u.level, classId: u.classId, best, bestLoc }
    }).filter(u => u.best > 0).sort((a, b) => b.best - a.best).slice(0, 10)

    const rows = scored.map((u, i) => {
      const locName = locationsMap[u.bestLoc]?.name ?? u.bestLoc ?? '?'
      return `${medal(i)} *${u.name}* — Floor *${u.best}* _(${locName})_  Lv.${u.level}`
    })

    return reply(
      `🏆 *WORLD OF ASTRAL — TOP FLOOR RANKINGS*\n\n` +
      `${rows.join('\n') || '_No dungeon records yet._'}\n\n` +
      `_Use *${p}ranking <dungeon>* for per-dungeon boards.\n${p}ranking for level rankings._`,
    )
  },
}

function medal(i) {
  return ['🥇', '🥈', '🥉'][i] ?? `*${i + 1}.*`
}
