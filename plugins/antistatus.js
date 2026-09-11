/**
 * antistatus.js — .antistatus on|off
 *
 * Deletes the in-group "mentioned you in their status" notification. Delete
 * only, NEVER a kick — see the note on the setting in lib/group-settings.js.
 *
 * Body is handleBoolToggle(), which reports a failed write instead of letting
 * dispatch() swallow it and reply nothing at all.
 */
import { handleBoolToggle } from '../lib/group-settings.js'

export default {
  name:        'antistatus',
  platforms:   ['whatsapp'],   // status-mention notifications are WhatsApp-only
  aliases:     ['antistatusmention'],
  category:    'utility',
  description: 'Delete status-mention notifications in this group (.antistatus on|off)',

  async run(ctx) {
    return handleBoolToggle(
      ctx,
      'antistatus',
      'Antistatus',
      '📵',
      '_Status-mention notifications will be deleted. Nobody is kicked for one._\n' +
      '_This catches the in-group notification only — the status itself lives on status@broadcast and can\'t be touched._',
    )
  },
}
