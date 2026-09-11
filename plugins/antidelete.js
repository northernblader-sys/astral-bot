/**
 * antidelete.js — .antidelete on|off
 *
 * Reposts a deleted message with the sender tagged. The revoke handling itself
 * lives in handler.js (a deletion arrives as a protocolMessage, not as text);
 * this plugin only flips the setting.
 *
 * Body is handleBoolToggle(), which reports a failed write instead of letting
 * dispatch() swallow it and reply nothing at all.
 */
import { handleBoolToggle } from '../lib/group-settings.js'

export default {
  name:        'antidelete',
  platforms:   ['whatsapp'],   // message revoke + repost — Baileys-only
  aliases:     ['antidel'],
  category:    'utility',
  description: 'Repost deleted messages with the sender tagged (.antidelete on|off)',

  async run(ctx) {
    return handleBoolToggle(
      ctx,
      'antidelete',
      'Antidelete',
      '♻️',
      '_Deleted messages will be reposted here with the sender tagged._',
    )
  },
}
