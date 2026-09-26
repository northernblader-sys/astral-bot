/**
 * antichannel.js — .antichannel on|off
 *
 * Deletes WhatsApp Channel (newsletter) forwards and kicks the sender.
 * Detection lives in handler.js: Channel-origin content carries
 * contextInfo.forwardedNewsletterMessageInfo, which nothing else sets.
 *
 * Body is handleBoolToggle(), which reports a failed write instead of letting
 * dispatch() swallow it and reply nothing at all.
 */
import { handleBoolToggle } from '../lib/group-settings.js'

export default {
  name:        'antichannel',
  platforms:   ['whatsapp'],   // Channel/newsletter forwards are WhatsApp-only
  requires:    ['channelForwards', 'messageRevoke'],
  aliases:     ['antinewsletter'],
  category:    'utility',
  description: 'Delete + kick on WhatsApp Channel forwards (.antichannel on|off)',

  async run(ctx) {
    return handleBoolToggle(
      ctx,
      'antichannel',
      'Antichannel',
      '📢',
      '_Channel forwards will be deleted and the sender removed. Admins and the bot owner are exempt._',
    )
  },
}
