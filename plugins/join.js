/**
 * join.js — .join <invite link or submission id>
 * Owner/mod-only. Bot joins the given group. See plugins/submit.js for the
 * full pipeline this is part of (handleJoin lives there so it can share
 * state with .submit/.reject without duplicating logic).
 */
import { handleJoin } from './submit.js'

export default {
  name:           'join',
  aliases:        [],
  category:       'group',
  requiresPlayer: false,
  platforms:      ['whatsapp'], // sock.groupAcceptInvite — Baileys-only
  description:    'Owner/mod: bot joins a group (by invite link or submission id)',

  async run(ctx) {
    return handleJoin(ctx)
  },
}
