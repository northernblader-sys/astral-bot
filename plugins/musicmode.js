/**
 * musicmode.js — .music on|off
 *
 * Turns a group into a music-listening room. When ON, regular members may run
 * ONLY the music command (.song / .mp3) and the group-directory commands
 * (category 'group'); every other command is refused with a reply. Group
 * admins, bot mods and the bot owner bypass the restriction entirely — they set
 * the mode and keep moderating, and can always run `.music off` to lift it.
 *
 * This file is only the switch. It does not play anything itself — .song
 * (plugins/music.js) is the actual music command. The flag is stored per-group
 * in data/group-settings.json (musicOnly) and enforced by the music-only gate
 * in handler.js (isMusicModeAllowed).
 */
import { config } from '../config.js'
import { handleBoolToggle } from '../lib/group-settings.js'

export default {
  name:        'music',
  aliases:     [],
  category:    'utility',
  platforms:   ['whatsapp'], // enforced by handler.js's WhatsApp command gate
  description: 'Restrict a group to music and group commands only (.music on/off)',

  async run(ctx) {
    const p = config.prefix
    return handleBoolToggle(
      ctx,
      'musicOnly',
      'Music-only mode',
      '🎵',
      `Only *${p}song* and group commands will work here now. ` +
      `Admins and mods are exempt, and can lift it with *${p}music off*.`,
    )
  },
}
