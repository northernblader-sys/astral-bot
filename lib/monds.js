/**
 * monds.js — the Mond, and the only rule that makes it worth having.
 *
 * A character can be bought with Monds. It cannot be bought with anything
 * else. Not Solars, not Gems, not Season Points. That is the whole point of
 * the currency, and it is enforced in exactly one place — handleBuy() in
 * plugins/character.js reads mondPriceFor() and spends wallet.monds, and the
 * old gemPrice branch it used to have is gone.
 *
 * The split between the two premium currencies is deliberate and should stay
 * legible from the outside:
 *
 *   Gems  (💎, data/topup-packages.json)  SPIN for a character. Every
 *         per-character *-spin.js plugin charges gems against a dead zone and
 *         a plateau chance, so a gem holder is buying attempts, never an
 *         outcome. Gems also buy relics and stat packs (plugins/gm.js).
 *   Monds (🪙, data/mond-packages.json)   BUY a character. Flat 5, guaranteed,
 *         no reel and no pity bar. Monds buy nothing else in the bot.
 *
 * Monds are never earned in play. No drop, no quest, no daily, no work payout
 * mints one — the only sources are a confirmed Naira pack (plugins/monds.js)
 * and an owner grant (`.admin givemonds`). They are also untradeable
 * (data/currency.json), so they cannot be laundered into the player economy
 * through `.pay` or the market the way Solars can.
 *
 * Integers only, unlike gems. Gems needed roundGems()/fmtGems() in
 * lib/format.js because the 0.5-per-spin plugins drift a wallet into
 * 0.44444444444; nothing here ever charges a fraction of a Mond, so the
 * rounding helper below exists to keep a hand-edited or legacy save honest
 * rather than to undo arithmetic drift.
 */
import { mondPackages } from './game-data.js'

/** Wallet symbol. Matches data/currency.json's `symbol` for id "monds". */
export const MOND = '🪙'

/**
 * The flat price of a character, in Monds. 5 because the Basic pack is 5 Monds
 * for ₦10,000, which makes "one pack, one character" the shape a buyer can hold
 * in their head without doing arithmetic.
 *
 * Per-character overrides are supported (see mondPriceFor) but nothing in
 * data/characters.json sets one today, on purpose: a 1-star and a 5-star cost
 * the same, and the roster's real scarcity is the one-of-one lock, not price.
 */
export const CHARACTER_MOND_PRICE = 5

/** Floor a Mond amount to a whole number. Use when WRITING wallet.monds. */
export function roundMonds(amount) {
  const n = Math.floor(Number(amount) || 0)
  return n > 0 ? n : 0
}

/** Format a Mond amount for display, with thousands separators. */
export function fmtMonds(amount) {
  return roundMonds(amount).toLocaleString()
}

/** A player's current Mond balance, safe on a save that predates the currency. */
export function getMonds(player) {
  return roundMonds(player?.wallet?.monds ?? 0)
}

/**
 * Whether a character can be bought with Monds at all.
 *
 * Yes for anything obtainable from a spin, which is both flavors of that:
 *   exclusive  one-of-one bot-wide. Buyable while the lock is OPEN, and the
 *              buyer takes the lock with it, so a Mond purchase is a way to
 *              win the race rather than a way around it. Once claimed, no
 *              amount of Monds gets it (the check lives in handleBuy, since
 *              only it has the db handle to read the lock).
 *   spinOnly   not one-of-one (Yato, Gojo). Any number of buyers.
 *
 * No for season characters. Those have their own three routes (`.season spin`,
 * `.season shop buy`, the battle pass at tier 50) and letting Monds skip a
 * battle pass would hollow out the season, which is a separate product.
 *
 * A character with neither flag is a stub with no route at all ("no way in yet"
 * in plugins/character.js). Those stay closed unless the data explicitly opts
 * in with a positive mondPrice, so an unfinished entry can never quietly become
 * purchasable just by existing.
 */
export function isMondBuyable(character) {
  if (!character || character.seasonId) return false
  return character.exclusive === true
    || character.spinOnly === true
    || (typeof character.mondPrice === 'number' && character.mondPrice > 0)
}

/**
 * What a given character costs in Monds, or null if Monds cannot buy it.
 * `mondPrice` in data/characters.json overrides the flat price; anything
 * missing, zero or negative falls back to CHARACTER_MOND_PRICE.
 */
export function mondPriceFor(character) {
  if (!isMondBuyable(character)) return null
  const override = Number(character.mondPrice)
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : CHARACTER_MOND_PRICE
}

/** Every Naira pack, in catalog order. */
export function mondPacks() {
  return mondPackages.mondPackages ?? []
}

/**
 * Resolve a pack from player input. Matches the id ("best") or the display
 * label ("Best Value"), case- and space-insensitively, because the pack list
 * shows the label in bold and a player who types what they see back at the bot
 * should not get "unknown package" for their trouble.
 */
export function findMondPack(query) {
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!q) return null
  return mondPacks().find(pk => pk.id === q)
    ?? mondPacks().find(pk => (pk.label ?? '').toLowerCase() === q)
    ?? mondPacks().find(pk => pk.id.startsWith(q))
    ?? null
}

/** Effective price per Mond, rounded to whole Naira, for the pack list. */
export function mondRate(pack) {
  return Math.round(pack.priceNaira / pack.monds)
}

/**
 * The pack catalog as display lines. One line per pack: label, what you get,
 * what it costs, and the free portion where there is one. The effective rate is
 * shown on the discounted packs only, since printing "₦2,000 each" next to the
 * two packs that ARE the baseline reads as a discount that isn't one.
 */
export function mondPackLines() {
  return mondPacks().map(pk => {
    const bonus = pk.bonus > 0
      ? `  ·  _+${pk.bonus} free, ₦${mondRate(pk).toLocaleString()} each_`
      : ''
    return `  *${pk.label}* · \`${pk.id}\`\n     ${MOND}*${pk.monds}* for ₦${pk.priceNaira.toLocaleString()}${bonus}`
  })
}
