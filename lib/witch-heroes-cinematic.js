/** Presentation only. Never decides HP, turns, winners or rewards.
 * Public scenes own both participants' presentation lock until delivery settles.
 * Combat adapters remain responsible for atomic turn/outcome settlement.
 * Pass the already committed final result; it is the same text restored at
 * the end of the glitch. A missing/failed edit falls back to readable text.
 */
import { ART } from './witch-heroes.js'
import { withBattleCinematic } from './battle-presentation.js'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function imageOrText(ctx, url, text) {
  if (typeof ctx.replyImage === 'function') {
    try { return await ctx.replyImage(url, text) } catch { /* readable fallback */ }
  }
  return ctx.reply(text)
}

export async function glitchResult(ctx, finalText, { sleep = wait, delay = 650 } = {}) {
  const text = String(finalText)
  const sent = await ctx.reply(text)
  if (typeof ctx.editReply !== 'function' || !sent) return sent
  let corrupted = false
  try {
    await sleep(delay)
    await ctx.editReply(sent, '▓▒░ W̷O̷R̷L̷D̷ / / 0x0000 ░▒▓\nS W O R D // S K Y // ∅\n[ R E S U L T   L O S T ]')
    corrupted = true
    await sleep(delay)
  } catch {
    // Still attempt restoration: a send can reach WhatsApp even if its ack
    // times out locally. Do not assume a rejected edit was never delivered.
  }
  try {
    await ctx.editReply(sent, text)
  } catch {
    // Platform/network recovery takes precedence over the one-message effect.
    // Retry the SAME message first; only a second failure uses a clean reply.
    try { await ctx.editReply(sent, text) } catch { return ctx.reply(text) }
  }
  return { sent, corrupted }
}

async function playEndworldClash(ctx, finalText, { sleep = wait, delay = 900 } = {}) {
  await imageOrText(ctx, ART.vortex, 'The beam vortex grows closer. The sky has nowhere left to run.')
  await sleep(delay)
  await imageOrText(ctx, ART.invisibleSword, 'The opponent smiles. Beside them, the Sword Maiden draws an invisible sword.\nSteel meets the end of the world.')
  await sleep(delay)
  return glitchResult(ctx, finalText, { sleep, delay })
}

/** Render only the resolved strikes supplied by the combat adapter. Never
 * fabricate another kill once the target is dead; a revival must be real.
 */
async function playCoordinate(ctx, strikes, finalText, { sleep = wait, delay = 900 } = {}) {
  const lines = ['“I hear your breath.”', '“I hear your heart.”', '“There you are.”']
  for (const [i, hit] of strikes.slice(0, 3).entries()) {
    await ctx.reply(`${lines[i]}\n⚔️ *${hit.damage}* damage.${hit.revived ? '\nA second life begins. She adjusts her grip.' : ''}`)
    await sleep(delay)
  }
  return imageOrText(ctx, ART.coordinate, String(finalText))
}

/** The public scenes own output for both combatants for their full duration.
 * Pass participants explicitly if settlement has already cleared battleState.
 */
export function showEndworldClash(ctx, finalText, options = {}) {
  return withBattleCinematic(ctx, () => playEndworldClash(ctx, finalText, options), options)
}
export function showCoordinate(ctx, strikes, finalText, options = {}) {
  return withBattleCinematic(ctx, () => playCoordinate(ctx, strikes, finalText, options), options)
}

/** Called at the actual generic turn-rendering boundary, before canvas work.
 * A combat adapter supplies a resolved cinematic, never untrusted command text.
 * It is still responsible for committing HP/results exactly once BEFORE this.
 */
export async function presentResolvedCinematic(ctx, opts) {
  const scene = opts.cinematic
  if (!scene) return false
  if (typeof scene.finalText !== 'string' || !scene.finalText.trim()) throw new Error('A cinematic requires a resolved final result')
  if (scene.type === 'coordinate' && (!Array.isArray(scene.strikes) || scene.strikes.length < 1 || scene.strikes.length > 3 ||
      scene.strikes.some(hit => !Number.isFinite(hit.damage) || hit.damage <= 0))) throw new Error('Invalid resolved Coordinate strikes')
  const options = { player: opts.player, participants: scene.participants }
  if (scene.type === 'endworld-clash') {
    await showEndworldClash(ctx, scene.finalText, options)
  } else if (scene.type === 'coordinate') {
    await showCoordinate(ctx, scene.strikes, scene.finalText, options)
  } else {
    throw new Error('Unknown resolved battle cinematic')
  }
  return true
}
