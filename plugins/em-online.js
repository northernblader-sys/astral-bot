/**
 * plugins/em-online.js — a bare .em-online alias onto the empire roster view.
 *
 * Shows who lives under the empire's banner: the sworn players (owner and
 * citizens) named one by one, and the NPC townsfolk as a headcount. The real
 * view lives in plugins/empire.js (onlineView) so there is exactly one
 * implementation; this plugin just gives it a top-level command name of its
 * own, the same way plugins/stash.js hangs a .stash alias off the stash view.
 * Read-only: it mutates nothing and never broadcasts.
 */
import { onlineView } from './empire.js'

export default {
  name:           'em-online',
  aliases:        ['emonline', 'empire-online'],
  category:       'empire',
  requiresPlayer: true,
  description:    'See who lives in your empire: sworn players and townsfolk',

  async run(ctx) {
    return onlineView(ctx)
  },
}
