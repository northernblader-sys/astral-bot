/**
 * capabilities.js — what each chat platform can actually do.
 *
 * The game engine (lib/*-engine.js, all the renderers) is platform-blind and
 * stays that way. This file is where the differences live, so a plugin can ask
 * "can I send a sticker here?" instead of "am I on WhatsApp?".
 *
 * Plugins declare what they need via `requires: ['stickers']` in their default
 * export; lib/plugin-manager.js refuses to register a plugin on a platform
 * that can't satisfy it. That's how .antichannel stays a WhatsApp-only
 * command without any `if (platform === ...)` branching inside the plugin.
 */

/** Every capability name the loader will accept in a plugin's `requires`. */
export const CAPABILITIES = [
  'stickers',          // convert media → sticker (WhatsApp-native concept)
  'viewOnce',          // view-once / self-destructing media
  'messageRevoke',     // delete someone else's message for everyone
  'revokeEvents',      // be *notified* that a message was deleted (antidelete)
  'channelForwards',   // detect a forward from a broadcast channel (antichannel)
  'statusMentions',    // status/story mention notifications (antistatus)
  'groupKick',         // remove a member from the chat
  'groupMute',         // restrict a member from talking
  'richEmbeds',        // structured embed cards with fields
  'buttons',           // clickable components attached to a message
  'slashCommands',     // platform-registered command palette
  'threads',           // sub-conversations inside a channel
  'roles',             // assignable named roles with permissions
  'pinMessages',       // pin a message in the chat
  'nativePolls',       // first-class poll objects
  'inlineQuery',       // query the bot from any chat via @botname
  'linkPreviewCard',   // custom title/body/thumbnail preview card
  'fileUpload',        // arbitrary file attachments
  'reactions',         // emoji reactions on a message
]

/**
 * Per-platform limits and feature flags.
 *
 * `textLimit` is the hard per-message character cap the platform enforces —
 * exceed it and the send is rejected outright, so lib/platform/chunk.js splits
 * on it. WhatsApp's is generous enough that nothing in this bot has ever hit
 * it; Discord's 2000 is low enough that .menu and .profile genuinely need
 * splitting or embedding.
 */
export const PLATFORMS = {
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    textLimit: 65536,
    captionLimit: 1024,
    idPrefix: '',          // legacy: raw JIDs, see lib/platform/identity.js
    mentionStyle: 'jid',
    capabilities: new Set([
      'stickers', 'viewOnce', 'messageRevoke', 'revokeEvents',
      'channelForwards', 'statusMentions', 'groupKick', 'groupMute',
      'linkPreviewCard', 'fileUpload', 'reactions', 'nativePolls',
    ]),
  },

  discord: {
    id: 'discord',
    label: 'Discord',
    textLimit: 2000,
    captionLimit: 2000,
    idPrefix: 'dc',
    mentionStyle: 'snowflake',
    capabilities: new Set([
      'richEmbeds', 'buttons', 'slashCommands', 'threads', 'roles',
      'pinMessages', 'groupKick', 'groupMute', 'messageRevoke',
      'fileUpload', 'reactions', 'nativePolls',
    ]),
  },

  telegram: {
    id: 'telegram',
    label: 'Telegram',
    textLimit: 4096,
    captionLimit: 1024,
    idPrefix: 'tg',
    mentionStyle: 'html',
    capabilities: new Set([
      'buttons', 'slashCommands', 'threads', 'pinMessages',
      'groupKick', 'groupMute', 'messageRevoke', 'inlineQuery',
      'fileUpload', 'reactions', 'nativePolls',
    ]),
  },
}

/** Look up a platform descriptor, throwing on an unknown id. */
export function getPlatform(id) {
  const p = PLATFORMS[id]
  if (!p) {
    throw new Error(`Unknown platform '${id}' — expected one of ${Object.keys(PLATFORMS).join(', ')}`)
  }
  return p
}

/** True if `platformId` supports every capability in `required`. */
export function supportsAll(platformId, required = []) {
  const { capabilities } = getPlatform(platformId)
  return required.every(c => capabilities.has(c))
}

/** The subset of `required` that `platformId` cannot provide. */
export function missingCapabilities(platformId, required = []) {
  const { capabilities } = getPlatform(platformId)
  return required.filter(c => !capabilities.has(c))
}
