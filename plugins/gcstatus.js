/**
 * gcstatus.js — .gcstatus <submission id>
 * Anyone can check where their (or any) submission stands. See
 * plugins/submit.js for handleGcStatus.
 */
import { handleGcStatus } from './submit.js'

export default {
  name:           'gcstatus',
  aliases:        [],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'],
  description:    'Check the status of a group submission by id',

  async run(ctx) {
    return handleGcStatus(ctx)
  },
}
