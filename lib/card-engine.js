/**
 * card-engine.js — anime card spawns + waifu selection.
 *
 * Cards randomly spawn in groups (see main.js's runCardSpawnSweep). First
 * player to `.collect <code>` (or `.grab`) the shown claim code gets it
 * added to their card collection. Players can then `.setwaifu <name>` to
 * pick one of their own caught cards as their waifu, and `.waifu` to show
 * it off.
 *
 * Source: the Cards API (https://cards-api-seven.vercel.app) — a live,
 * read-only, paginated card pool (~22k+ cards). Replaces the old static
 * data/cards.json pool entirely; that file and the local `readFileSync`
 * load are gone. Claim codes aren't part of the API data, so they're
 * generated locally at spawn time — same pattern and charset as
 * lib/series-engine.js's generateSeriesClaimCode().
 *
 * Random selection mirrors lib/series-engine.js's AniList approach: since
 * the API has no dedicated /random endpoint, we read the total count from
 * /api/stats and request a uniformly random page with limit=1 from
 * /api/cards. /api/stats is cached briefly (see STATS_CACHE_MS) so a spawn
 * sweep across many groups doesn't refetch it every time.
 */

const API_BASE = 'https://cards-api-seven.vercel.app'

// Claim-code charset: strips visually confusable glyphs (0/O, 1/I/l).
// Same convention as lib/series-engine.js's CODE_CHARS.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateCardClaimCode() {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

// ── /api/stats cache ─────────────────────────────────────────────────────
// Total card count changes rarely (only when the API's data/cards.json is
// redeployed), so caching this avoids an extra round trip on every spawn.
const STATS_CACHE_MS = 10 * 60_000 // 10 minutes
let _statsCache = null       // { total, byTier, fetchedAt }
let _statsInFlight = null    // in-flight promise, so concurrent spawns share one fetch

async function getTotalCardCount() {
  if (_statsCache && Date.now() - _statsCache.fetchedAt < STATS_CACHE_MS) {
    return _statsCache.total
  }
  if (_statsInFlight) return _statsInFlight

  _statsInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/stats`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return _statsCache?.total ?? null
      const json = await res.json()
      // Confirmed live shape: { totalCards, totalSeries, byTier: {...} }
      const total = json?.totalCards ?? null
      if (typeof total === 'number' && total > 0) {
        _statsCache = { total, byTier: json?.byTier ?? null, fetchedAt: Date.now() }
        return total
      }
      console.error('[card-engine] /api/stats returned an unexpected shape:', JSON.stringify(json))
      return _statsCache?.total ?? null
    } catch (err) {
      console.error('[card-engine] Failed to fetch /api/stats:', err.message)
      return _statsCache?.total ?? null
    } finally {
      _statsInFlight = null
    }
  })()

  return _statsInFlight
}

/**
 * Per-tier card counts from the same cached /api/stats read as
 * getTotalCardCount() — `{ "1": 8123, "2": 5044, … }` or null if the upstream
 * has never answered. Used by api-server.js's /api/cards/prices so the shop
 * can say how deep each tier's pool is without a second round trip.
 */
export async function getCardTierCounts() {
  await getTotalCardCount()  // populates/refreshes the shared cache
  return _statsCache?.byTier ?? null
}

/** One in-flight guard per spawn call — same rationale as series-engine.js. */
async function fetchOneRandomCard(retry = true) {
  async function doFetch() {
    try {
      const total = await getTotalCardCount()
      if (!total) return null

      // /api/cards is 1-indexed pagination; page N with limit=1 returns
      // exactly the Nth card in the underlying dataset.
      const page = Math.floor(Math.random() * total) + 1
      const url = `${API_BASE}/api/cards?page=${page}&limit=1`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null

      const json = await res.json()
      const raw = Array.isArray(json?.results) ? json.results[0] : (json?.results ?? null)
      if (!raw) return null

      return {
        title:    raw.title ?? 'Unknown',
        imageUrl: raw.imageUrl ?? raw.image ?? null,
        tier:     String(raw.tier ?? '1'),
        series:   raw.series ?? raw.origin ?? 'Unknown',
        claim:    generateCardClaimCode(),
      }
    } catch (err) {
      console.error('[card-engine] Failed to fetch card from API:', err.message)
      return null
    }
  }

  const first = await doFetch()
  if (first) return first
  // Retry once — a single failed request (timeout, transient 5xx) shouldn't
  // silently kill a spawn sweep for the whole hour.
  if (retry) return doFetch()
  return null
}

/**
 * Same random-page approach as fetchOneRandomCard(), but scoped to a single
 * tier via the API's own ?tier= filter — used by the direct-purchase shop
 * flow (api-server.js's /api/cards/buy-tier), where the player is buying a
 * guaranteed tier, not a fully random card.
 *
 * Needs the tier-scoped total count (not the global one from getTotalCardCount),
 * so it reads /api/stats.byTier directly rather than sharing that cache.
 */
async function fetchOneCardOfTier(tier, retry = true) {
  async function doFetch() {
    try {
      const statsRes = await fetch(`${API_BASE}/api/stats`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!statsRes.ok) return null
      const stats = await statsRes.json()
      const tierTotal = stats?.byTier?.[String(tier)] ?? stats?.byTier?.[tier] ?? null
      if (!tierTotal) return null

      const page = Math.floor(Math.random() * tierTotal) + 1
      const params = new URLSearchParams({ page: String(page), limit: '1', tier: String(tier) })
      const res = await fetch(`${API_BASE}/api/cards?${params}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null

      const json = await res.json()
      const raw = Array.isArray(json?.results) ? json.results[0] : (json?.results ?? null)
      if (!raw) return null

      return {
        title:    raw.title ?? 'Unknown',
        imageUrl: raw.imageUrl ?? raw.image ?? null,
        tier:     String(raw.tier ?? tier),
        series:   raw.series ?? raw.origin ?? 'Unknown',
        claim:    generateCardClaimCode(),
      }
    } catch (err) {
      console.error('[card-engine] Failed to fetch card of tier from API:', err.message)
      return null
    }
  }

  const first = await doFetch()
  if (first) return first
  if (retry) return doFetch()
  return null
}

/**
 * Returns one random card of the given tier from the live Cards API, shaped
 * for spawning (title, imageUrl, tier, series, claim) — same shape as
 * fetchSpawnCard(). Returns null if both the primary attempt and the retry
 * fail, or if the tier has no cards.
 */
export async function fetchCardOfTier(tier) {
  return fetchOneCardOfTier(tier, /* retry= */ true)
}

/**
 * Fetches one page of the live Cards API catalog directly — for a
 * player-browsable catalog (as opposed to fetchSpawnCard()'s single random
 * pick used by spawn sweeps). Same API_BASE, same field normalization as
 * fetchOneRandomCard() above, so catalog cards and spawned cards always
 * look identical to the rest of the app.
 *
 * Returns { cards, total } — total is /api/stats's totalCards, used by the
 * frontend to know whether a "load more" page exists. Returns
 * { cards: [], total: 0 } on any upstream failure rather than throwing, so
 * a flaky catalog page never 500s the whole endpoint.
 */
export async function fetchCardCatalogPage({ page = 1, limit = 20, tier } = {}) {
  try {
    const total = await getTotalCardCount()
    const params = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (tier) params.set('tier', String(tier))

    const res = await fetch(`${API_BASE}/api/cards?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { cards: [], total: total ?? 0 }

    const json = await res.json()
    const rawResults = Array.isArray(json?.results) ? json.results : []

    const cards = rawResults.map(raw => ({
      // Catalog entries have no owner, so no toOwnedCard() id — the Cards
      // API's own id (if present) is stable across pages/requests, unlike
      // a freshly-generated one, so prefer it; fall back to a composite
      // key so React's key prop is still stable across re-renders.
      id: raw.id ?? `${raw.title ?? 'card'}-${page}-${rawResults.indexOf(raw)}`,
      title: raw.title ?? 'Unknown',
      imageUrl: raw.imageUrl ?? raw.image ?? null,
      tier: String(raw.tier ?? '1'),
      series: raw.series ?? raw.origin ?? 'Unknown',
    }))

    return { cards, total: total ?? cards.length }
  } catch (err) {
    console.error('[card-engine] Failed to fetch catalog page from API:', err.message)
    return { cards: [], total: 0 }
  }
}

/**
 * Returns one random card from the live Cards API, shaped for spawning
 * (title, imageUrl, tier, series, claim). Returns null if both the
 * primary attempt and the retry fail.
 */
export async function fetchSpawnCard() {
  return fetchOneRandomCard(/* retry= */ true)
}

// Owned-card id charset/length — distinct from the 6-char claim code so the
// two ids can never be confused; ids just need to be unique within one
// player's collection, not globally, so this length is generous margin.
const OWNED_ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateOwnedCardId() {
  let id = ''
  for (let i = 0; i < 10; i++) {
    id += OWNED_ID_CHARS[Math.floor(Math.random() * OWNED_ID_CHARS.length)]
  }
  return id
}

/** Player-facing card shape stored in player.cards[]. */
function toOwnedCard(raw) {
  return {
    // raw.id only exists for cards that already came from an external API
    // (kept so any already-owned cards on disk stay stable); freshly
    // spawned cards have no id, so one is generated here.
    id: raw.id ?? generateOwnedCardId(),
    title: raw.title,
    imageUrl: raw.imageUrl,
    tier: raw.tier,
    series: raw.series,
    claimedAt: Date.now(),
  }
}

/** Adds a spawned card to a player's collection (mutates in place). */
export function addCardToPlayer(player, rawCard) {
  if (!Array.isArray(player.cards)) player.cards = []
  player.cards.push(toOwnedCard(rawCard))
}

/** Finds a card in the player's collection by exact id or case-insensitive title match. */
export function findOwnedCard(player, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const cards = player.cards ?? []
  return cards.find(c => c.id === query)
    ?? cards.find(c => c.title.toLowerCase() === q)
    ?? cards.find(c => c.title.toLowerCase().includes(q))
    ?? null
}

/** Sets a player's waifu to an owned card by id. Returns the card or null if not owned. */
export function setWaifu(player, query) {
  const card = findOwnedCard(player, query)
  if (!card) return null
  player.waifuId = card.id
  return card
}

/** Returns the player's currently-set waifu card, or null if none set / no longer owned. */
export function getWaifu(player) {
  if (!player.waifuId) return null
  return (player.cards ?? []).find(c => c.id === player.waifuId) ?? null
}

// Cards API includes tiers 6 and 'S' above the old 1-5 range — both kept
// here so those (rarer) cards don't silently fall back to the tier-1 display/price.
const TIER_STARS = {
  1: '★☆☆☆☆', 2: '★★☆☆☆', 3: '★★★☆☆', 4: '★★★★☆', 5: '★★★★★',
  6: '★★★★★✦', S: '✦✦✦✦✦',
}
export function tierStars(tier) {
  return TIER_STARS[tier] ?? TIER_STARS[String(tier)] ?? '☆☆☆☆☆'
}

// Sell value by tier — higher tier (rarer) cards are worth more Solars.
// 2026-09-22 reprice (owner-set, same day): S-tier sells for 50k, tier 6
// for 43k, stepping down the ladder from there. S was first set to 150k
// earlier the same day, then the owner scaled the WHOLE ladder to 1/3
// (150k → 50k) because prices felt too high — keep the shape if you ever
// re-scale again (strictly increasing by tier rank, buy > sell, ~1.6x).
// Every tier the Cards API can return has an entry so nothing silently
// falls back to the tier-1 price.
const TIER_SELL_PRICE = {
  1: 1500, 2: 4000, 3: 8000, 4: 18000, 5: 30000,
  6: 43000, S: 50000,
}
export function cardSellPrice(tier) {
  return TIER_SELL_PRICE[tier] ?? TIER_SELL_PRICE[String(tier)] ?? TIER_SELL_PRICE[1]
}

// Direct-purchase price by tier — what a player pays in the shop to buy a
// guaranteed-tier card outright (api-server.js /api/cards/prices, /buy-tier).
// MUST stay above cardSellPrice for every tier (~1.6x here) so
// buying-then-selling is never a profitable loop. Every tier the Cards API
// can return has an entry: tier 5 used to be missing, which made
// cardBuyPrice(5) fall through the `?? [1]` default and quietly sell a
// tier-5 card for the tier-1 price. Scaled down alongside the 50k sell
// reprice above (S shop price 80k, was 240k).
const TIER_BUY_PRICE = {
  1: 2500, 2: 6500, 3: 13000, 4: 29000, 5: 48000,
  6: 70000, S: 80000,
}
export function cardBuyPrice(tier) {
  return TIER_BUY_PRICE[tier] ?? TIER_BUY_PRICE[String(tier)] ?? TIER_BUY_PRICE[1]
}

/**
 * True when a card carries a real series name worth displaying.
 * Cards whose upstream record has no series fall back to the literal
 * placeholder 'Unknown' at fetch time — every player-facing render should
 * gate its 📺 series line on this helper so a card never shows
 * "📺 Unknown" (owner request, 2026-09-22).
 */
export function hasCardSeries(series) {
  const s = String(series ?? '').trim()
  return s.length > 0 && s.toLowerCase() !== 'unknown'
}

// Numeric ranking for sort/stat purposes — 'S' tier ranks above numeric 6.
// Single source of truth; plugins/card.js's own sort and other stat
// generation call this instead of keeping separate copies.
export function tierRank(tier) {
  if (tier === 'S') return 7
  const n = Number(tier)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * Derives battle stats from a card's tier. Ported from Marin's
 * battlemechanic.js, fixed for the 'S'-tier bug: the original did
 * `card.tier || 1` and multiplied directly, so a string tier of 'S'
 * produced `'S' * 200 → NaN` and silently broke battles for S-tier cards.
 * Using tierRank() here gives 'S' a real numeric rank (7) instead.
 */
export function getCardStats(card) {
  const t = tierRank(card?.tier)
  const hp  = t * 200 + Math.floor(Math.random() * 50)
  return {
    hp,
    maxHp: hp,
    atk:   t * 50 + Math.floor(Math.random() * 20),
    def:   t * 20 + Math.floor(Math.random() * 10),
    speed: t * 10 + Math.floor(Math.random() * 5),
  }
}
