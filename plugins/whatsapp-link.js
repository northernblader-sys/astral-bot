/**
 * whatsapp-link.js — .whatsapp posts the WhatsApp community invite link.
 * Shared across all three platforms — see lib/community-link-command.js.
 */
import { makeCommunityLinkCommand } from '../lib/community-link-command.js'

export default makeCommunityLinkCommand({
  name: 'whatsapp',
  aliases: ['wa', 'wagroup'],
  emoji: '🟢',
  label: 'WhatsApp',
  configKey: 'communityWhatsappLink',
})
