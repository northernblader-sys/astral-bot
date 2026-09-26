/**
 * community-link-command.js — factory behind .whatsapp / .telegram / .discord.
 *
 * Not a plugin itself (the loader only reads a file's default export, and
 * only one plugin, so three commands need three files — see
 * plugins/whatsapp-link.js, plugins/telegram-link.js, plugins/discord-link.js).
 * This just holds the one bit of logic all three share.
 *
 * Each command works no matter which platform it's *run from* — someone on
 * Discord can run .telegram to grab the Telegram link, someone on WhatsApp
 * can run .discord, etc. Which link it posts depends only on the command
 * name, not on ctx.platform; ctx.platform only picks which prefix character
 * the reply text suggests.
 */
import { config } from '../config.js'

const ENV_KEY = { communityWhatsappLink: 'COMMUNITY_WHATSAPP_LINK', communityTelegramLink: 'COMMUNITY_TELEGRAM_LINK', communityDiscordLink: 'COMMUNITY_DISCORD_LINK' }

/** Telegram autocompletes `/`, so showing `.` there teaches the wrong thing. */
function prefixFor(platform) {
  return platform === 'telegram' ? config.telegramPrefix : config.prefix
}

export function makeCommunityLinkCommand({ name, aliases, emoji, label, configKey }) {
  return {
    name,
    aliases,
    category: 'social',
    description: `Get the invite link for our ${label} community`,
    platforms: ['whatsapp', 'discord', 'telegram'],

    async run(ctx) {
      const link = config[configKey]
      const pr = prefixFor(ctx.platform)

      if (!link) {
        return ctx.reply(
          `${emoji} *${label} link isn't set up yet.*\n\n` +
          `Ask the bot owner to set *${ENV_KEY[configKey]}* in .env.`,
        )
      }

      return ctx.reply(
        `${emoji} *Join our ${label} community!*\n\n` +
        `${link}\n\n` +
        `_Looking for another platform? Try ${pr}whatsapp, ${pr}telegram, or ${pr}discord._`,
      )
    },
  }
}
