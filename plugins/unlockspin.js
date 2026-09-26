/**
 * unlockspin.js — owner-only `.unlockspin <character>`.
 *
 * Opens a character that `.lockspin` (plugins/lockspin.js) froze, so players can
 * pull it on the banner or buy it with Monds again. There is one store and one
 * switch behind both doors — lib/spin-locks.js — so an unlock can't open the
 * spin while leaving the shop closed, or the other way round.
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
  description: 'Owner only: open a frozen character so players can pull or buy it (.unlockspin <name>)',

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
      return ctx.reply(`🔓 *${character.name}* isn't locked — the spin and the buy price are both open already.`)
    }

    unlockSpin(character.id)
    return ctx.reply(
      `🔓 *${character.emoji ? character.emoji + ' ' : ''}${character.name}* is now open.\n\n` +
      `_Players can pull ${character.name} on the banner or buy it with Monds again._`,
    )
  },
}
