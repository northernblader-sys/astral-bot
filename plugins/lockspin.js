/**
 * lockspin.js — owner-only `.lockspin <character>`.
 *
 * Freezes a character outright until the owner runs `.unlockspin <character>`
 * (plugins/unlockspin.js). The lock is stored in lib/spin-locks.js
 * (data/spin-locks.json) and checked on BOTH ways a character can be obtained:
 * every *-spin plugin through spinLockGate(), and the Mond shop
 * (`.character buy`) through shopLockGate(). This is how a brand-new character
 * ships with its plugins live but closed, then goes public the moment the owner
 * flips it open.
 *
 * The shop half is not decoration. Characters have two prices — gems for
 * attempts on the banner, 5 Monds for the character outright — and freezing
 * only the banner left the second door open: a locked character was still
 * purchasable the moment anyone typed `.character buy <name>`. If a third
 * acquisition route ever appears (a fame claim, a shop catalog row), it has to
 * call the same gate or `.lockspin` stops meaning what it says.
 *
 * `.lockspin` with no argument lists whatever is currently locked. The character
 * is resolved the same way plugins/character.js resolves it (id, then exact
 * name, then partial name), so `.lockspin gojo`, `.lockspin Gojo` and
 * `.lockspin satoru` all land on the same id.
 */
import { config } from '../config.js'
import { isOwnerJid, NOT_ALLOWED } from '../lib/group-helpers.js'
import { characters, characterMap } from '../lib/game-data.js'
import { MOND } from '../lib/monds.js'
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
  description: 'Owner only: freeze a character so nobody can pull or buy it (.lockspin <name>)',

  async run(ctx) {
    const pr = config.prefix
    if (!ctx.from || !isOwnerJid(ctx.from)) return ctx.reply(NOT_ALLOWED)

    const query = (ctx.args ?? []).join(' ').trim()

    // No argument: show what is currently locked.
    if (!query) {
      const locked = listSpinLocks()
      if (!locked.length) {
        return ctx.reply(
          `🔓 *No characters are locked.*\n\n` +
          `_A freeze closes the spin banner and the ${MOND} buy price. Freeze one with *${pr}lockspin <name>*, open it with *${pr}unlockspin <name>*._`,
        )
      }
      const lines = locked.map(l => {
        const c = characterMap[l.id]
        return `  🔒 ${c?.emoji ? c.emoji + ' ' : ''}*${c?.name ?? l.id}*`
      })
      return ctx.reply(
        `🔒 *Locked characters* _(${locked.length})_ · _banner + ${MOND} buy both closed_\n\n${lines.join('\n')}\n\n` +
        `_Open one with *${pr}unlockspin <name>*._`,
      )
    }

    const character = findCharacter(query)
    if (!character) {
      return ctx.reply(`❌ *"${query}"* isn't a character. See *${pr}character* for the list.`)
    }

    if (isSpinLocked(character.id)) {
      return ctx.reply(`🔒 *${character.name}* is already locked — the spin and the buy price are both closed. Open it with *${pr}unlockspin ${character.id}*.`)
    }

    lockSpin(character.id, ctx.from)
    return ctx.reply(
      `🔒 *${character.emoji ? character.emoji + ' ' : ''}${character.name}* is now locked.\n\n` +
      `_Nobody can pull ${character.name} or buy it with Monds until you run *${pr}unlockspin ${character.id}*._\n` +
      `👀 _The banner still shows on the site and in *${pr}character*, badged as frozen._`,
    )
  },
}
