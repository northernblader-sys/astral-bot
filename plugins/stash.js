/**
 * plugins/stash.js — the .stash command: view the empire stash and move things
 * in and out of it.
 *
 * The stash is the empire's shared store of the raw materials its workers gather
 * (and players drop in) and the finished gear its blacksmith forges, kept
 * separate from the capped construction warehouse. The real logic lives in
 * plugins/empire.js so there is exactly one implementation; this plugin gives it
 * a top-level command name of its own and routes the verbs:
 *   .stash               → the view
 *   .stash drop <item>   → put loot/materials from your bag into the stash
 *   .stash take <item>   → claim materials/gear from the stash to your bag
 *   .stash invite <p>    → share the stash (alias of .tp)
 * Contributing (drop) is open to owner, citizens and invited guests; taking is
 * the ruler's and guests' only. Never broadcasts.
 */
import { stashView, dropCmd, takeCmd, inviteCmd } from './empire.js'

export default {
  name:           'stash',
  category:       'empire',
  requiresPlayer: true,
  description:    'View and manage your empire stash: drop, take, and forge stores',

  async run(ctx) {
    const verb = ctx.args[0]?.toLowerCase()
    if (verb === 'drop') return dropCmd(ctx)
    if (verb === 'take') return takeCmd(ctx)
    if (verb === 'invite' || verb === 'tp') {
      return (ctx.args[1]?.toLowerCase() === 'remove')
        ? inviteCmd(ctx, ctx.args[2], 'remove')
        : inviteCmd(ctx, ctx.args[1], 'add')
    }
    if (verb === 'uninvite') return inviteCmd(ctx, ctx.args[1], 'remove')
    return stashView(ctx)
  },
}
