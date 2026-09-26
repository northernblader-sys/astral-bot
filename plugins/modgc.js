/**
 * modgc.js — .modgc
 * Owner-only. Run INSIDE the group that should receive .submit requests
 * from now on. Replaces whatever group was previously set — there's only
 * ever one mod GC. See plugins/submit.js for handleModGc.
 */
import { handleModGc } from './submit.js'

export default {
  name:           'modgc',
  aliases:        [],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'],
  description:    'Owner-only: sets the current group as the destination for .submit requests',

  async run(ctx) {
    return handleModGc(ctx)
  },
}
