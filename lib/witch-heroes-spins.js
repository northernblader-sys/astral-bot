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
    description: 'The Witch of Lust has never needed to win a fight, because her enemies keep losing their own. Desire bends toward her the way water bends downhill: kings have emptied thrones for a single evening at her table, and blades raised against her have a way of coming home to the hands that held them. She takes every attempt on her life as a compliment, and she answers each one in person.',
    ability: { name: 'My Desire', flavor: 'Passive: no command, no cost. A direct attack that lands on her may be returned to its sender in full, up to four times per battle. To strike Scarlett is to confess, and she accepts every confession at equal damage. Ronova alone is immune; there is nothing left in the Witch of Life and Death that wants, and want is the only door Scarlett opens.' },
  },
  {
    id: 'ronova', name: 'Ronova, the Witch of Life and Death', emoji: '☠️', stars: 5,
    rarity: 'boundless', exclusive: true, gemPrice: null, image: ART.ronova, spinImage: ART.ronovaSpin,
    description: 'The other witches wield power. Ronova decides where it ends, and her answer always arrives as a place and a time. She does not quarrel, gloat or hurry; she writes an ending and waits for the world to catch up to it. When she begins the count, the sky dims one turn at a time, and nothing that has ever been born has talked her down from three.',
    ability: { name: 'The End of the World', flavor: 'Use .endworld after five completed battle turns. Three charging turns follow, the world going dark with each one, and on the third the enemy simply ends, past every save and every revival. Only one blade has ever cut a refuge through the first phase. Other witches cannot affect Ronova with their powers.' },
  },
  {
    id: 'sword_maiden', name: 'Sword Maiden', series: 'The Heroes', emoji: '⚔️', stars: 6,
    rarity: 'boundless', exclusive: true, gemPrice: null, image: ART.maiden, spinImage: ART.maiden,
    description: 'Blind since before anyone thought to ask how, she reads a fight through breath, balance and the tiny sound a heel makes before it slips. She does not need to see an opening; she hears one being born. When the witches write an ending, her blade can make the world hesitate.',
    ability: { name: 'Absolute Sword', flavor: 'Use .sword to wield five techniques. Each completed non-sword turn builds 1 charge, up to 6, including PvP turns; using a technique spends its listed charge AND MP, consumes your turn, and does not recharge itself. .ss shows live costs. Sever parts a guard, Wrong Foot breaks balance, Return Stroke waits to answer a direct hit, Transcended Sword is released by defending, and The Coordinate lands three cinematic strikes. Her cuts cannot miss or be intercepted. Only her holder may speak to her with .maiden <message>.' },
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
