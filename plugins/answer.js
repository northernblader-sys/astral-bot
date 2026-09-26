/**
 * answer.js — `.answer <text>` : reply to the old woman's riddle.
 *
 * The Blue Band arc (The End event) hinges on one question — "Are you from this
 * world, young boy?" — asked by `.shop buy blue band`. This is a real command
 * rather than a free-text capture so it works identically in DMs and in groups,
 * and can never be triggered by accident mid-conversation.
 *
 * Honest answer ("no") → she hands over the Blue Band.
 * Anything else        → her door locks until the player leaves Astral Town and
 *                        comes back (the lock is cleared by applyEndEventTick,
 *                        see lib/end-event.js).
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import {
  BLUE_BAND_ID, hasBlueBand,
  RIDDLE_CORRECT, RIDDLE_WRONG, RIDDLE_ALREADY_BANDED,
} from '../lib/end-event.js'

/**
 * Is this an honest "I am not from this world"?
 *
 * Generous on purpose — she's reading magical energy, not grading grammar — but
 * an explicit "yes" (or "I am from...") always loses, even when padded with a
 * stray "not", so a contradictory answer can never sneak through.
 */
function isHonestNo(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return false
  if (/\byes\b/.test(t) || /\byeah\b/.test(t) || /\bhai\b/.test(t)) return false
  if (/\bi am from\b/.test(t) || /\bi'm from\b/.test(t)) return false
  return /\b(no|nope|nah|naw|iie|not|isekai|another)\b/.test(t)
}

export default {
  name: 'answer',
  aliases: ['ans', 'respond'],
  category: 'event',
  requiresPlayer: true,
  description: `${config.prefix}answer <your reply> — answer the old woman's riddle in Astral Town (The End event)`,

  async run(ctx) {
    const p = config.prefix
    const text = (ctx.args ?? []).join(' ').trim()

    if (!text) {
      return ctx.reply(
        `❌ *Usage:* *${p}answer <your reply>*\n` +
        `_Example:_ *${p}answer no*`,
      )
    }

    // Read the pending riddle off the live record, not ctx.player, so two fast
    // messages can't both be answered.
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      if (player.blueBandRiddle?.state !== 'awaiting_answer') {
        outcome = { kind: 'nothing' }
        return player
      }

      if (hasBlueBand(player) || (player.inventory ?? []).includes(BLUE_BAND_ID)) {
        player.blueBandRiddle = null
        outcome = { kind: 'already' }
        return player
      }

      if (!isHonestNo(text)) {
        player.blueBandRiddle = { state: 'locked', lockedAt: Date.now() }
        outcome = { kind: 'wrong' }
        return player
      }

      // Honest. Room is checked inside the mutator so a full bag can't eat the
      // band — the riddle stays pending and they can answer again after tidying.
      if (!hasInventoryRoom(player, 1)) {
        outcome = { kind: 'full', message: inventoryFullMessage(player) }
        return player
      }

      player.inventory.push(BLUE_BAND_ID)
      player.blueBandRiddle = null
      outcome = { kind: 'granted' }
      return player
    })

    if (outcome.kind === 'nothing') {
      return ctx.reply(
        `🤔 *Nobody asked you anything.*\n` +
        `_If you're after a Blue Band, ask the old woman in Astral Town:_ *${p}shop buy blue band*`,
      )
    }
    if (outcome.kind === 'already') return ctx.reply(RIDDLE_ALREADY_BANDED)
    if (outcome.kind === 'wrong')   return ctx.reply(RIDDLE_WRONG)
    if (outcome.kind === 'full') {
      return ctx.reply(
        `❌ ${outcome.message}\n` +
        `👵 _"Hands full, hands full. Come back when you can carry it, child."_\n` +
        `_Her question still stands — answer again once you've made room._`,
      )
    }

    return ctx.reply(RIDDLE_CORRECT.replaceAll('{prefix}', p))
  },
}
