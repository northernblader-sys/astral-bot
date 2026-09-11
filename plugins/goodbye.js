/**
 * goodbye.js — .goodbye on|off
 * Toggles the departure announcement for this group. Message text itself
 * is set with .setgoodbye. Body shared with plugins/welcome.js — see
 * lib/group-settings.js's handleGreetingToggle().
 */
import { handleGreetingToggle } from '../lib/group-settings.js'

export default {
  name:        'goodbye',
  aliases:     [],
  category:    'utility',
  platforms:    ['whatsapp'],   // greetings fire from main.js's group-participants hook (WhatsApp only)
  description: 'Toggle goodbye messages for departing members (.goodbye on|off)',

  async run(ctx) {
    return handleGreetingToggle(ctx, 'goodbye', 'Goodbye', '👋')
  },
}
