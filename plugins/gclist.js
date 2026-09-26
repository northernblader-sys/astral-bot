/**
 * gclist.js — .gclist
 * Owner/mod-only. Lists every group the bot is currently in, sorted by
 * member count. See plugins/submit.js for handleGcList.
 */
import { handleGcList } from './submit.js'

export default {
  name:           'gclist',
  aliases:        ['groups', 'gcs'],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'], // sock.groupFetchAllParticipating — Baileys-only
  description:    'Owner/mod: list every group the bot is currently in',

  async run(ctx) {
    return handleGcList(ctx)
  },
}
