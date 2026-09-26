/**
 * market-repo.js — the single source of truth for db.data.market access
 * (the global card marketplace: players listing owned cards for other
 * players to buy). No plugin should read/write db.data.market directly.
 *
 * Mirrors lib/player-repo.js's write-queue pattern exactly (same
 * runExclusive/withTimeout rationale — see that file's comments for the
 * full explanation of why a serialized queue is required with lowdb).
 * This is a SEPARATE queue from player-repo.js's, since listings and
 * player records are different top-level db.data keys — see
 * plugins/card.js's buy/list/delist handlers for how a market mutation
 * and a player mutation are sequenced together (list/delist only touch
 * one of the two; buy touches market then both players' records, in that
 * order, same "sequential calls" convention used by plugins/friend.js,
 * plugins/rob.js, and plugins/pvp.js for any multi-party mutation).
 *
 * Listing shape:
 * {
 *   id:        string,   // unique listing id, independent of card id
 *   sellerId:  string,   // player.id (WhatsApp JID) of the lister
 *   card:      object,   // full owned-card object (see lib/card-engine.js's
 *                         // toOwnedCard shape) — snapshotted at list time so
 *                         // the market listing survives even if the schema
 *                         // for owned cards changes later
 *   price:     number,   // asking price in Solars
 *   listedAt:  number,   // Date.now()
 * }
 */

let writeQueue = Promise.resolve()

function runExclusive(task) {
  const run = writeQueue.then(task, task)
  writeQueue = run.catch(() => {})
  return run
}

const QUEUE_TASK_TIMEOUT_MS = 20_000

function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${QUEUE_TASK_TIMEOUT_MS}ms`)),
      QUEUE_TASK_TIMEOUT_MS,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const LISTING_ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateListingId() {
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += LISTING_ID_CHARS[Math.floor(Math.random() * LISTING_ID_CHARS.length)]
  }
  return id
}

/** Returns all current market listings, sorted by price ascending (cheapest first — matches Marin's cardmarket.js ordering). */
export async function getMarketListings(db) {
  await db.read()
  const listings = Array.isArray(db.data.market) ? db.data.market : []
  return [...listings].sort((a, b) => a.price - b.price)
}

/** Creates a new listing. Returns the created listing object. */
export async function createListing(db, sellerId, card, price) {
  return runExclusive(() => withTimeout((async () => {
    await db.read()
    if (!Array.isArray(db.data.market)) db.data.market = []
    const listing = {
      id: generateListingId(),
      sellerId,
      card,
      price,
      listedAt: Date.now(),
    }
    db.data.market.push(listing)
    await db.write()
    return listing
  })(), `createListing(${sellerId})`))
}

/** Removes a listing by id. Returns the removed listing, or null if not found. */
export async function removeListing(db, listingId) {
  return runExclusive(() => withTimeout((async () => {
    await db.read()
    if (!Array.isArray(db.data.market)) db.data.market = []
    const idx = db.data.market.findIndex(l => l.id === listingId)
    if (idx === -1) return null
    const [removed] = db.data.market.splice(idx, 1)
    await db.write()
    return removed
  })(), `removeListing(${listingId})`))
}

/** Reads a single listing by id without removing it. */
export async function findListing(db, listingId) {
  await db.read()
  const listings = Array.isArray(db.data.market) ? db.data.market : []
  return listings.find(l => l.id === listingId) ?? null
}
