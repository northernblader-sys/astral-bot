/**
 * botadmin.js — .botadmin
 * Checks whether the bot itself is an admin in the current group. No
 * permission gate — anyone can run this, it's read-only.
 */
import { checkBotAdmin } from '../lib/group-helpers.js'

export default {
  name:        'botadmin',
  aliases:     [],
  category:    'utility',
  description: 'Check if the bot is an admin in this group',

  async run(ctx) {
    const { reply, sock, sender, isGroup } = ctx
    if (!isGroup) return reply('❌ This command only works in groups.')

    try {
      // maxAgeMs: 0 — this is the command people run straight after promoting
      // the bot, so it must never answer from the metadata cache. allowStale
      // false too: if WhatsApp won't say, reporting that beats a confident
      // answer built from a copy taken before the promotion.
      const { isAdmin } = await checkBotAdmin(sock, sender, { maxAgeMs: 0, allowStale: false })
      return reply(isAdmin ? '✅ I am an admin in this group.' : '❌ I am *not* an admin in this group.')
    } catch (e) {
      return reply(`❌ Couldn't check admin status: ${e.message}`)
    }
  },
}
