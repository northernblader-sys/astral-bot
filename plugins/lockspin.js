/**
 * lockspin.js — owner-only `.lockspin <character>`.
 *
 * Freezes a character's spin banner so nobody can pull it until the owner runs
 * `.unlockspin <character>` (plugins/unlockspin.js). The lock is stored in
 * lib/spin-locks.js (data/spin-locks.json) and checked by every *-spin plugin
 * through spinLockGate() before a pull is allowed. This is how a brand-new
 * character ships with its spin plugin live but closed, then goes public the
 * moment the owner flips it open.
 *
 * `.lockspin` with no argument lists whatever is currently locked. The character
 * is resolved the same way plugins/character.js resolves it (id, then exact
 * name, then partial name), so `.lockspin gojo`, `.lockspin Gojo` and
 * `.lockspin satoru` all land on the same id.
 */
import { config } from '../config.js'
import { isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { characters, characterMap } from '../lib/game-data.js'
import { lockSpin, listSpinLocks, isSpinLocked } from '../lib/spin-locks.js'

function findCharacter(query) {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return null
  if (characterMap[q]) return characterMap[q]
  return characters.find(c => c.name.toLowerCase() === q)
    ?? characters.find(c => c.name.toLowerCase().includes(q))
    ?? null
}

export default {
  name:        'lockspin',
  aliases:     [],
  category:    'account',
  description: 'Owner only: freeze a character spin so nobody can pull it (.lockspin <name>)',

  async run(ctx) {
    const pr = config.prefix
    if (!ctx.from || !isOwnerJid(ctx.from)) return ctx.reply(NOT_ALLOWED)

    const query = (ctx.args ?? []).join(' ').trim()

    // No argument: show what is currently locked.
    if (!query) {
      const locked = listSpinLocks()
      if (!locked.length) {
        return ctx.reply(
          `🔓 *No spins are locked.*\n\n_Freeze one with *${pr}lockspin <name>*, open it with *${pr}unlockspin <name>*._`,
        )
      }
      const lines = locked.map(l => {
        const c = characterMap[l.id]
        return `  🔒 ${c?.emoji ? c.emoji + ' ' : ''}*${c?.name ?? l.id}*`
      })
      return ctx.reply(
        `🔒 *Locked spins* _(${locked.length})_\n\n${lines.join('\n')}\n\n` +
        `_Open one with *${pr}unlockspin <name>*._`,
      )
    }

    const character = findCharacter(query)
    if (!character) {
      return ctx.reply(`❌ *"${query}"* isn't a character. See *${pr}character* for the list.`)
    }

    if (isSpinLocked(character.id)) {
      return ctx.reply(`🔒 *${character.name}'s* spin is already locked. Open it with *${pr}unlockspin ${character.id}*.`)
    }

    lockSpin(character.id, ctx.from)
    return ctx.reply(
      `🔒 *${character.emoji ? character.emoji + ' ' : ''}${character.name}'s* spin is now locked.\n\n` +
      `_Nobody can pull ${character.name} until you run *${pr}unlockspin ${character.id}*._`,
    )
  },
}
