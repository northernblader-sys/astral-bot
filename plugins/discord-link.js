/**
 * discord-link.js — .discord posts the Discord community invite link.
 * Shared across all three platforms — see lib/community-link-command.js.
 */
import { makeCommunityLinkCommand } from '../lib/community-link-command.js'

export default makeCommunityLinkCommand({
  name: 'discord',
  aliases: ['dc', 'discordserver'],
  emoji: '🟣',
  label: 'Discord',
  configKey: 'communityDiscordLink',
})
