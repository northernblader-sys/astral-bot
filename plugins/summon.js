/**
 * summon.js — Summon Beasts roster viewer.
 *
 * Beasts are NOT bought or gacha-rolled. They're found rarely while
 * mining (see plugins/mine.js's beast-find roll) — always as a
 * low-level baby beast that's then trained up via awardBeastCp()
 * (lib/beast-engine.js) from kills, the same way the player levels.
 *
 * Usage:
 *   <prefix>summon              — show your owned beasts + CP/level
 *   <prefix>summon list         — same as above (alias)
 */
import { config } from '../config.js'
import { beastMap } from '../lib/game-data.js'
import { getBeastStats, BEAST_MAX_OWNED } from '../lib/beast-engine.js'
import { rarityStars } from '../lib/rarity.js'

function renderRoster(player) {
  const pr = config.prefix
  const owned = player.summonedBeasts ?? []
  if (!owned.length) {
    return (
      `🐲 You don't have any summoned beasts yet.\n` +
      `_They're rare finds while mining — keep at it! (${pr}mine)_`
    )
  }
  const activeId = player.activeBeast
  const lines = [`🐲 *Your Summoned Beasts* _(${owned.length}/${BEAST_MAX_OWNED})_\n`]
  for (const entry of owned) {
    const def = beastMap[entry.beastId]
    if (!def) continue
    const stats = getBeastStats(def, entry.cp)
    const active = entry.beastId === activeId ? '  ⭐ _active_' : ''
    const rar = rarityStars(def.rarity)
    lines.push(
      `${def.emoji} *${def.name}* ${rar}${active}\n` +
      `  Lv.${stats.level}  •  ${entry.cp} CP${stats.cpToNext != null ? ` _(${stats.cpToNext} to next level)_` : ' _(MAX)_'}\n` +
      `  ⚔️ ATK ${stats.atk}  🛡️ DEF ${stats.def}  ❤️ HP ${stats.maxHp}`,
    )
  }
  lines.push(
    `\nEquip: *${pr}equipbeast <name>*` +
    (activeId ? `  •  Unequip: *${pr}equipbeast unequip*` : ''),
  )
  return lines.join('\n')
}

export default {
  name: 'summon',
  aliases: ['summonbeast', 'beasts'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}summon — view your summoned beasts (found while mining)`,

  async run(ctx) {
    return ctx.reply(renderRoster(ctx.player))
  },
}
