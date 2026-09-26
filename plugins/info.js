/**
 * info.js — alias surface for character info.
 *
 * `.info season <name>` and `.info <name>` both resolve to exactly the same
 * output as `.character info <name>` (plugins/character.js), which already
 * sends the character's image plus full ability/ownership details for every
 * character including Season 1's — sendImage(ctx, character.image, ...) runs
 * regardless of seasonId.
 *
 * This file deliberately contains NO rendering logic of its own: it rewrites
 * the args and delegates straight into the character plugin's run(), so the
 * two commands can never drift apart.
 */
import { config } from '../config.js'
import characterPlugin from './character.js'

export default {
  name: 'info',
  aliases: ['charinfo'],
  category: 'account',
  requiresPlayer: true,
  description: `${config.prefix}info season <name> — alias for ${config.prefix}character info <name>`,

  async run(ctx) {
    const pr = config.prefix
    const args = [...(ctx.args ?? [])]

    // `.info season <name>` — drop the optional "season" keyword; character
    // lookup is by id/name and doesn't care which season a character is from.
    if ((args[0] ?? '').toLowerCase() === 'season') args.shift()

    if (!args.length) {
      return ctx.reply(
        `ℹ️ Usage: *${pr}info season <name>*\n` +
        `_Example: ${pr}info season wither_\n\n` +
        `Same as *${pr}character info <name>*. Browse everyone with *${pr}character*.`,
      )
    }

    return characterPlugin.run({ ...ctx, args: ['info', ...args] })
  },
}
