/**
 * setgoodbye.js — .setgoodbye <text>
 * Sets the goodbye message text for this group. Use {user} anywhere in the
 * text to have it replaced with an @mention of the member who left.
 *
 * Body shared with plugins/setwelcome.js — see lib/group-settings.js's
 * handleSetGreetingMessage().
 */
import { handleSetGreetingMessage } from '../lib/group-settings.js'

export default {
  name:        'setgoodbye',
  aliases:     [],
  category:    'utility',
  platforms:    ['whatsapp'],   // greetings fire from main.js's group-participants hook (WhatsApp only)
  description: 'Set the goodbye message text ({user} = mention)',

  async run(ctx) {
    return handleSetGreetingMessage(
      ctx,
      'goodbyeMessage',
      'Goodbye',
      'Goodbye {user}, we\'ll miss you! 😢',
    )
  },
}
