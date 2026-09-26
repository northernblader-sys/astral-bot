/**
 * leave.js — .leave
 * Owner/mod-only. Run INSIDE the group the bot should leave. See
 * plugins/submit.js for handleLeave.
 */
import { handleLeave } from './submit.js'

export default {
  name:           'leave',
  aliases:        [],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'], // sock.groupLeave — Baileys-only
  description:    'Owner/mod: bot leaves the current group',

  async run(ctx) {
    return handleLeave(ctx)
  },
}
