/** Staged banner helpers; not registered as commands until combat adapters ship.
 * pullBanner MUST run inside updatePlayer's serialized mutator, just like the
 * existing exclusive banners. Media is sent after that mutator, never inside it.
 */
import { BANNERS, ART, spinChance } from './witch-heroes.js'
import { getExclusiveSpinWinner, claimExclusiveSpinForPlayer, addOwnedSeasonContent } from './season-engine.js'

export const NEW_CHARACTERS = [
  {
    id: 'scarlett', name: 'Scarlett, the Witch of Lust', emoji: '🌹', stars: 5,
    rarity: 'boundless', exclusive: true, gemPrice: null, image: ART.scarlett, spinImage: ART.scarlett,
    description: 'She hears a threat and smiles as though it were a promise.',
    ability: { name: 'My Desire', flavor: 'Passive: randomly turns a landed enemy attack back on its attacker at equal damage, at most four times per battle. Ronova is immune.' },
  },
  {
    id: 'ronova', name: 'Ronova, the Witch of Life and Death', emoji: '☠️', stars: 5,
    rarity: 'boundless', exclusive: true, gemPrice: null, image: ART.ronova, spinImage: ART.ronovaSpin,
    description: 'The other witches wield power. She decides where it ends.',
    ability: { name: 'The End of the World', flavor: '.endworld unlocks after five completed battle turns. Three more turns end the enemy; Sword Maiden alone can cut a refuge through phase one. Other witches cannot affect Ronova with their powers.' },
  },
  {
    id: 'sword_maiden', name: 'Sword Maiden', series: 'The Heroes', emoji: '⚔️', stars: 5,
    rarity: 'boundless', exclusive: true, gemPrice: null, image: ART.maiden, spinImage: ART.maiden,
    description: 'Blind, curvy and entirely too cheerful about the sound of a blade leaving its sheath. She finds the opening by listening to you breathe.',
    ability: { name: 'Absolute Sword', flavor: 'Five physical techniques: .sword. Charge and MP status: .ss. Her cuts do not miss, cannot be intercepted by pets and never resolve to zero damage. Transcended Sword waits for a defensive turn; The Coordinate is her three-strike cinematic finisher.' },
  },
]
export const SPIN_FIELDS = { scarlett: 'scarlettSpins', ronova: 'ronovaSpins', sword_maiden: 'swordMaidenSpins' }

export function pullBanner(db, player, playerId, characterId, requested = 1) {
  const banner = BANNERS[characterId]
  if (!banner) throw new Error('Unknown exclusive banner')
  const field = SPIN_FIELDS[characterId]
  if (getExclusiveSpinWinner(db, characterId)) return { reason: 'claimed', spent: 0, results: [] }
  const n = Number(requested)
  const count = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.floor(n))) : 1
  const results = []
  let won = false
  for (let i = 0; i < count; i++) {
    if ((player[field] ?? 0) >= banner.cap || (player.wallet?.gems ?? 0) < banner.cost) break
    const spin = (player[field] ?? 0) + 1
    won = spinChance(characterId, spin) === 1
    if (won && !claimExclusiveSpinForPlayer(db, characterId, playerId)) break
    player.wallet.gems -= banner.cost
    player[field] = spin
    results.push({ spin, won })
    if (won) {
      addOwnedSeasonContent(player, 'character', characterId)
      break // Never charge the unused remainder of a batch after winning.
    }
  }
  return { reason: won ? 'won' : results.length ? 'miss' : (player[field] ?? 0) >= banner.cap ? 'cap' : 'gems',
    results, spent: results.length * banner.cost, remaining: player.wallet?.gems ?? 0 }
}

export async function sendBannerArt(ctx, character, text, { win = false } = {}) {
  const url = win ? character.image : (character.spinImage ?? character.image)
  const animated = /\.gif(?:[?#]|$)/i.test(url)
  const method = animated ? 'replyGif' : 'replyImage'
  if (typeof ctx[method] === 'function') {
    try { return await ctx[method](url, text) } catch { /* Never flatten the GIF. */ }
  }
  return ctx.reply(text)
}
