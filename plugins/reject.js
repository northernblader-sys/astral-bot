/**
 * reject.js — .reject <submission id> [reason]
 * Owner/mod-only. Declines a pending .submit request and tells the
 * submitter why. See plugins/submit.js for handleReject.
 */
import { handleReject } from './submit.js'

export default {
  name:           'reject',
  aliases:        [],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'],
  description:    'Owner/mod: reject a pending group submission',

  async run(ctx) {
    return handleReject(ctx)
  },
}
