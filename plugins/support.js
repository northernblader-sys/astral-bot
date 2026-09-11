/**
 * support — quick help/contact info for players who need assistance.
 * Usage: <prefix>support
 */
import { config } from '../config.js'

export default {
  name: 'support',
  aliases: [],
  category: 'utility',
  description: 'Get help or report an issue',

  async run(ctx) {
    const pr = config.prefix
    const groupLine = config.supportGroupLink
      ? `\n\n👥 *Support Group:* ${config.supportGroupLink}`
      : ''
    return ctx.reply(
      `🛟 *Need help?*\n\n` +
      `If something's broken, you found a bug, or you're stuck on anything, ` +
      `reach out with *${pr}contactteam* and describe what happened.` +
      groupLine +
      `\n\nTip: include what command you ran and what you expected vs what happened — it helps us fix it faster.`,
    )
  },
}
