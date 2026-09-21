/**
 * rank-up.js — the rank promotion announcement, one image + one caption.
 *
 * Every XP source that can push a player across a rank boundary (dungeon
 * kills, daily claim, quest claims, duel wins) used to render its own copy
 * of the "RANK UP!" text — combat-handlers.js even attached a different
 * picture (the destination rank's tier thumbnail) from the text-only sites.
 * The 2026-09-21 art drop gave the promotion its own dedicated card
 * ('rank-up.jpg', lib/image.js), so every site now calls sendRankUp():
 * same image, same caption, everywhere a rank-up is announced.
 */
import { sendImage } from './image.js'

export const RANK_UP_IMAGE = 'rank-up.jpg'

/** The full promotion caption — the long-standing wording, unchanged. */
export function buildRankUpCaption(playerName, from, to) {
  return (
    `⚔️ *RANK UP!*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `${to.emoji} *${to.title}*\n` +
    `_"${to.epithet}"_\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `*${playerName}* has ascended beyond *${from.title}*.\n` +
    `_The System acknowledges your growth. A new tier of power awaits._`
  )
}

/**
 * sendRankUp(ctx, playerName, from, to) — the separate follow-up message
 * ("rank promotion — separate message so it stands out"). sendImage degrades
 * to the plain caption if the image can't be fetched, so a rank-up is never
 * silent.
 */
export async function sendRankUp(ctx, playerName, from, to) {
  return sendImage(
    ctx,
    RANK_UP_IMAGE,
    `*Astral Rank Up*\n${to.emoji} Ascended to ${to.title}\n\n${buildRankUpCaption(playerName, from, to)}`,
  )
}
