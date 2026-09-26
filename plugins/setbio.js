/**
 * setbio.js — .setbio <text>
 * Sets a short bio/description shown on .me / .profile and on the short
 * public .profile @mention view. Capped at 9 words — trims silently rather
 * than rejecting, so "just a few words too long" still works.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'

const MAX_WORDS = 9

export default {
  name:           'setbio',
  aliases:        ['setdesc', 'setdescription', 'bio'],
  category:       'account',
  requiresPlayer: true,
  description:    `Set your profile bio (max ${MAX_WORDS} words)`,

  async run(ctx) {
    const { args, db, from, reply } = ctx
    const text = args.join(' ').trim()

    if (!text) {
      return reply(
        `❌ *Usage:* ${config.prefix}setbio <text>\n` +
        `Max ${MAX_WORDS} words. Example: ${config.prefix}setbio Wandering blade for hire, seeking glory`,
      )
    }

    const words = text.split(/\s+/)
    const trimmed = words.slice(0, MAX_WORDS).join(' ')

    await updatePlayer(db, from, (p) => { p.bio = trimmed })

    const note = words.length > MAX_WORDS
      ? `\n_(trimmed to ${MAX_WORDS} words)_`
      : ''

    return reply(`✅ Bio set:\n_${trimmed}_${note}`)
  },
}
