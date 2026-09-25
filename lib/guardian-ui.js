/**
 * lib/guardian-ui.js — shared presentation for Guardian of the Innocent.
 * Kept apart from lib/guardian-event.js (pure logic) so the combat handlers
 * and the three plugins render the companion request and card identically.
 *
 * Companions speak in lowercase with no punctuation (data rule); everything
 * the BOT narrates around them uses the bot's normal formatting.
 */
import { config } from '../config.js'
import { GUARDIAN, TYPE_BADGE, companionStoryChapters } from './guardian-event.js'

export const RULE = '━━━━━━━━━━━━━━━━━━━━'

export async function replyOverImage(ctx, url, text) {
  if (!url || typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage(url, text)
  } catch {
    return ctx.reply(text)
  }
}

/** The request a freed companion makes after her captor falls. */
export function companionOfferText(c) {
  const p = config.prefix
  const pron = c.pronoun === 'they' ? 'They' : c.pronoun === 'he' ? 'He' : 'She'
  const obj = c.pronoun === 'they' ? 'them' : c.pronoun === 'he' ? 'him' : 'her'
  return (
    `⛓️ *SOMEONE IS ASKING FOR YOU*\n${RULE}\n` +
    `*${c.name}*  ·  ${TYPE_BADGE[c.type] ?? ''}\n` +
    `_${c.tagline}_\n\n` +
    `🗣️ _${c.request}_\n\n` +
    `✨ *${c.perk.name}:* ${c.perk.description}\n\n` +
    `✅ *${p}guardian accept*   ·   ❌ *${p}guardian reject*\n` +
    `_${pron} will wait ${GUARDIAN.offerTtlMinutes} minutes. Only one player in the whole world can ever have ${obj}._`
  )
}

export function sendCompanionOffer(ctx, c) {
  return replyOverImage(ctx, c.image, companionOfferText(c))
}

/** `.companion` card. */
export function companionCardText(c, player) {
  const p = config.prefix
  const g = player.guardian ?? {}
  const chapters = companionStoryChapters(c, player)
  const trustLabel = c.id === 'yenisei' ? 'Trust' : 'Bond'
  const lines = [
    `🕊️ *${c.name}*  ·  ${TYPE_BADGE[c.type] ?? ''}`,
    RULE,
    `_${c.tagline}_`,
    ``,
    `✨ *${c.perk.name}:* ${c.perk.description}`,
    `💞 ${trustLabel}: *${g.trust ?? 0}*/100  ·  Talks: *${g.talks ?? 0}*`,
    `📖 Story: *${chapters}/${c.backstory.length}* chapters` + (chapters < c.backstory.length ? ` _(talk to ${c.pronoun === 'they' ? 'them' : 'her'} more)_` : ''),
    ``,
    `💬 *${p}companion talk <message>*  ·  📖 *${p}companion story*`,
  ]
  return lines.join('\n')
}
