/**
 * unlockspin.js — owner-only `.unlockspin <character>`.
 *
 * Opens a spin banner that `.lockspin` (plugins/lockspin.js) froze, so players
 * can pull the character again. Shares the lib/spin-locks.js store and resolves
 * the character the same way plugins/character.js does.
 */
import { config } from '../config.js'
import { isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { characters, characterMap } from '../lib/game-data.js'
import { unlockSpin, isSpinLocked } from '../lib/spin-locks.js'

function findCharacter(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  if (characterMap[q]) return characterMap[q]
  return characters.find(c => c.name.toLowerCase() === q)
    ?? characters.find(c => c.name.toLowerCase().includes(q))
    ?? null
}

export default {
  name:        'unlockspin',
  aliases:     [],
  category:    'account',
  description: 'Owner only: open a frozen character spin so players can pull it (.unlockspin <name>)',

  async run(ctx) {
    const pr = config.prefix
    if (!ctx.from || !isOwnerJid(ctx.from)) return ctx.reply(NOT_ALLOWED)

    const query = (ctx.args ?? []).join(' ').trim()
    if (!query) {
      return ctx.reply(`⚠️ Usage: *${pr}unlockspin <name>*. See what's locked with *${pr}lockspin*.`)
    }

    const character = findCharacter(query)
    if (!character) {
      return ctx.reply(`❌ *"${query}"* isn't a character. See *${pr}character* for the list.`)
    }

    if (!isSpinLocked(character.id)) {
      return ctx.reply(`🔓 *${character.name}'s* spin isn't locked.`)
    }

    unlockSpin(character.id)
    return ctx.reply(
      `🔓 *${character.emoji ? character.emoji + ' ' : ''}${character.name}'s* spin is now open.\n\n` +
      `_Players can pull ${character.name} again._`,
    )
  },
}
