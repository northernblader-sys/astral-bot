/**
 * welcome.js — .welcome on|off
 * Toggles the welcome-new-member announcement for this group. Message text
 * itself is set with .setwelcome.
 *
 * The body lives in lib/group-settings.js's handleGreetingToggle() rather than
 * here. This file used to carry its own inline copy, which meant it also
 * carried its own bug: a bare `await updateGroupSettings(...)` whose rejection
 * was swallowed by dispatch(), so a failed write sent the group no reply at
 * all. The shared handler reports the outcome either way and quotes the value
 * it read back off disk.
 */
import { handleGreetingToggle } from '../lib/group-settings.js'

export default {
  name:        'welcome',
  aliases:     [],
  category:    'utility',
  platforms:    ['whatsapp'],   // greetings fire from main.js's group-participants hook (WhatsApp only)
  description: 'Toggle welcome messages for new members (.welcome on|off)',

  async run(ctx) {
    return handleGreetingToggle(ctx, 'welcome', 'Welcome', '👋')
  },
}
