/**
 * bestiary.js — dungeon voices and monster families.
 *
 * Not 929 essays. One line for the place, one line for the family the name
 * already belongs to. Floor 100 is the master. The middle floors are not.
 */
import { config } from '../config.js'
import { locationsMap } from '../lib/game-data.js'
import { DUNGEON_NAMES, entryBrief, encounterLine, familyIndex, stratumFor } from '../lib/dungeon-lore.js'

const LORE_IDS = Object.keys(DUNGEON_NAMES)

function dungeonPage(locId, p) {
  const loc = locationsMap[locId]
  const name = loc?.name ?? DUNGEON_NAMES[locId] ?? locId
  const families = familyIndex().filter(f => f.locId === locId)
  const lines = [
    `📖 *${name.toUpperCase()}*`,
    loc?.description ? `_${loc.description}_` : '',
    '',
  ]
  const low = stratumFor(locId, 1)
  const high = stratumFor(locId, Math.max(1, (loc?.floors ?? 90) - 1))
  if (low) lines.push(`*Low:* ${low.name}. ${low.line}`)
  if (high && high !== low) lines.push(`*High:* ${high.name}. ${high.line}`)
  const brief = loc ? entryBrief(loc, 1, false) : ''
  if (brief) lines.push('', brief)
  if (families.length) {
    lines.push('', `*Families*`)
    for (const family of families) {
      lines.push(`  • *${family.words[0]}*: ${family.line}`)
    }
  }
  lines.push('', `*${p}bestiary* for the other places.`)
  return lines.filter(Boolean).join('\n')
}

export default {
  name: 'bestiary',
  aliases: ['beastiary', 'families'],
  category: 'dungeon',
  requiresPlayer: false,
  description: 'What the towers feel like, and the families that walk them',
  subcommands: [
    { cmd: '<dungeon or family>', desc: 'a place, or a family word like slime or wraith' },
  ],

  async run(ctx) {
    const p = config.prefix
    const query = ctx.args.join(' ').trim().toLowerCase()

    if (!query) {
      const lines = [
        `📖 *BESTIARY*`,
        `_One voice per tower. One line per family. The master is the last floor, not every tenth._`,
        '',
      ]
      for (const id of LORE_IDS) {
        lines.push(`  • *${DUNGEON_NAMES[id]}*  ·  *${p}bestiary ${id}*`)
      }
      lines.push('', `_Or name a family: *${p}bestiary slime*_`)
      return ctx.reply(lines.join('\n'))
    }

    const compact = query.replace(/\s+/g, '_')
    if (DUNGEON_NAMES[compact] || locationsMap[compact]) {
      return ctx.reply(dungeonPage(compact, p))
    }
    const byName = LORE_IDS.find(id => (DUNGEON_NAMES[id] ?? '').toLowerCase().includes(query))
    if (byName) return ctx.reply(dungeonPage(byName, p))

    const families = familyIndex().filter(f => f.words.some(w => w.includes(query) || query.includes(w)))
    if (families.length) {
      const lines = [`📖 *${query.toUpperCase()}*`, '']
      for (const family of families) {
        lines.push(`*${family.dungeon}*`)
        lines.push(family.line)
        lines.push('')
      }
      return ctx.reply(lines.join('\n').trim())
    }

    // A full monster name still gets the family line if one matches.
    for (const id of LORE_IDS) {
      const line = encounterLine(id, query)
      if (line && !line.startsWith('Another') && !line.startsWith('If it looks')) {
        return ctx.reply(`📖 *${query}*\n_${DUNGEON_NAMES[id]}_\n\n${line}`)
      }
    }

    return ctx.reply(
      `❓ Nothing in the book under *${query}*.\n` +
      `*${p}bestiary* lists the towers.`,
    )
  },
}
