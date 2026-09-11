/**
 * setwelcome.js — .setwelcome <text>
 * Sets the welcome message text for this group. Use {user} anywhere in the
 * text to have it replaced with an @mention of the new member.
 *
 * Body shared with plugins/setgoodbye.js — see lib/group-settings.js's
 * handleSetGreetingMessage(), which also warns when the text is saved while
 * `.welcome` is still off.
 */
import { handleSetGreetingMessage } from '../lib/group-settings.js'

export default {
  name:        'setwelcome',
  aliases:     [],
  category:    'utility',
  platforms:    ['whatsapp'],   // greetings fire from main.js's group-participants hook (WhatsApp only)
  description: 'Set the welcome message text ({user} = mention)',

  async run(ctx) {
    return handleSetGreetingMessage(
      ctx,
      'welcomeMessage',
      'Welcome',
      'Welcome {user} to the group! 🎉',
    )
  },
}
