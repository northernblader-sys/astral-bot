/**
 * waifu.js — show your currently set waifu card, or toggle card auto-spawn
 * for this group.
 * Usage: .waifu             — show your waifu card
 *        .waifu on / off    — group admins/owner only, toggles hourly
 *                              card auto-spawn in this group
 */
import { config } from '../config.js'
import { getWaifu, tierStars, cardSellPrice, fetchSpawnCard, hasCardSeries } from '../lib/card-engine.js'
import { isGifUrl } from '../lib/card-media.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { addCardSpawnGroup, removeCardSpawnGroup } from '../lib/card-spawn-groups.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { setActiveSpawn } from '../lib/card-spawn-state.js'
import { CARD_SPAWN_INTERVAL_MS, humanInterval } from '../lib/spawn-intervals.js'

const SPAWN_EVERY = humanInterval(CARD_SPAWN_INTERVAL_MS)

export default {
  name: 'waifu',
  aliases: ['wife'],
  category: 'cards',
  requiresPlayer: true,
  description: 'Show your current waifu card, or toggle card auto-spawn (.waifu on/off)',

  async run(ctx) {
    const { args, reply, replyImage, replyGif, player } = ctx
    const sub = (args[0] ?? '').toLowerCase()

    // ── SPAWN (bot owner only) — manually force a card spawn right now ────
    if (sub === 'spawn') {
      if (!ctx.isGroup) return reply(NOT_GROUP)
      if (!isOwnerJid(ctx.from)) return reply(NOT_ALLOWED)

      const card = await fetchSpawnCard()
      if (!card) return reply(`❌ Couldn't reach the card API — try again shortly.`)

      setActiveSpawn(ctx.sender, card)
      // GIF cards loop via replyGif (MP4 transcode + gifPlayback), stills via
      // replyImage — same split lib/card-media.js makes for the auto-spawns.
      const send = isGifUrl(card.imageUrl) ? replyGif : replyImage
      return send(
        card.imageUrl,
        `🎴 *A WILD CARD APPEARED!*\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `✨ *${card.title}*\n` +
        (hasCardSeries(card.series) ? `📺 _${card.series}_\n` : '') +
        `${tierStars(card.tier)}  ·  💰 *${cardSellPrice(card.tier).toLocaleString()}* Solars\n\n` +
        `🎯 First to type *${config.prefix}collect ${card.claim}* claims it!`
      )
    }

    // ── ON / OFF (group admins only) — toggles hourly card auto-spawn ────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return reply(NOT_ALLOWED)

      const enable = sub === 'on'
      // Save FIRST and bail if it didn't land. The spawn-group list and this
      // flag have to agree — registering the group for spawns after a failed
      // settings write leaves cards spawning in a group whose saved setting
      // says they're off, which is unfixable from chat.
      const res = await saveGroupSettings(ctx.sender, (s) => { s.cardsEnabled = enable })
      if (!res.ok) return reply(saveFailedMessage('card auto-spawn', res.error))

      const stored = res.settings.cardsEnabled === true
      if (stored) await addCardSpawnGroup(ctx.sender)
      else await removeCardSpawnGroup(ctx.sender)

      return reply(
        stored
          ? `🎴 *Card Auto-Spawn — ON*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `⏱️ A card appears here every *${SPAWN_EVERY}*.\n` +
            `🎯 Catch it with *${config.prefix}collect <code>*.`
          : `🚫 *Card Auto-Spawn — OFF*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `No more cards will appear in this group.`
      )
    }

    // ── Group gate — viewing/using waifu cards also requires .waifu on ────
    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.cardsEnabled) {
        return reply(
          `🚫 Cards are disabled in this group.\n` +
          `_A group admin can turn them on with *${config.prefix}waifu on*._`,
        )
      }
    }

    // ── Show current waifu ────────────────────────────────────────────────
    const card = getWaifu(player)

    if (!card) {
      return reply(
        `💔 *You haven't set a waifu yet.*\n\n` +
        `_Collect cards as they spawn with *${config.prefix}collect <code>*, then_\n` +
        `_*${config.prefix}setwaifu <card name>* to pick one._`
      )
    }

    const caption =
      `💘 *${player.name}'s Waifu*\n\n` +
      `${tierStars(card.tier)} *${card.title}*\n` +
      (hasCardSeries(card.series) ? `📺 _${card.series}_` : '')

    if (card.imageUrl) {
      const send = isGifUrl(card.imageUrl) ? replyGif : replyImage
      return send(card.imageUrl, caption)
    }
    return reply(caption)
  },
}
