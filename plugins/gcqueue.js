/**
 * gcqueue.js — .gcqueue [pending|accepted|rejected]
 * Owner/mod-only. Shows the full group-submission queue with mini ids and
 * status — everything by default, or filtered to one bucket. See
 * plugins/submit.js for handleGcQueue.
 */
import { handleGcQueue } from './submit.js'

export default {
  name:           'gcqueue',
  aliases:        ['gcq', 'submissions'],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'],
  description:    'Owner/mod: view the group-submission queue (pending/accepted/rejected)',

  async run(ctx) {
    return handleGcQueue(ctx)
  },
}
