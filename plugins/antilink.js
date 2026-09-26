/**
 * antilink.js — .antilink on|off
 * Toggles auto delete+kick on link posts for this group. The actual scan runs
 * in lib/moderation-scan.js on every message; this plugin only flips the
 * setting. Detection itself is containsLink() in lib/group-helpers.js.
 *
 * Body is lib/group-settings.js's handleBoolToggle(), which reports a failed
 * write instead of letting dispatch() swallow it and reply nothing.
 */
import { handleBoolToggle } from '../lib/group-settings.js'

export default {
  name:        'antilink',
  // WhatsApp-only: Discord uses AutoMod and Telegram uses admin permissions
  // for this. See plugins-discord/automod.js and plugins-telegram/guard.js.
  platforms:   ['whatsapp'],
  aliases:     [],
  category:    'utility',
  description: 'Toggle auto delete+kick on link posts (.antilink on|off)',

  async run(ctx) {
    return handleBoolToggle(
      ctx,
      'antilink',
      'Antilink',
      '🔗',
      '_Any link gets deleted and the sender removed, along with their other recent messages. ' +
      'Covers invite links, shorteners, bare domains and obfuscated forms like "foo (dot) com", ' +
      'in captions as well as plain text. Admins and the bot owner are exempt._',
    )
  },
}
