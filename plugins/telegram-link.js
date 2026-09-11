/**
 * telegram-link.js — .telegram posts the Telegram community invite link.
 * Shared across all three platforms — see lib/community-link-command.js.
 */
import { makeCommunityLinkCommand } from '../lib/community-link-command.js'

export default makeCommunityLinkCommand({
  name: 'telegram',
  aliases: ['tg', 'tggroup'],
  emoji: '🔵',
  label: 'Telegram',
  configKey: 'communityTelegramLink',
})
