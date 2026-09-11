/**
 * series-engine.js — Anime Series collectible system.
 *
 * Pulls live anime metadata from the AniList GraphQL API (no key required).
 * Score comes back as an integer 0–100; we divide by 10 so the tier table
 * keeps its familiar 0–10 scale identical to the old MAL/Jikan scale.
 *
 * Random selection: AniList paginates scored anime to a hard cap of 5 000
 * pages (perPage=1). We pick a uniformly random page on each spawn so the
 * full library — not just the popular end — gets represented.
 *
 * Mirrors lib/card-engine.js structurally so the two systems stay easy to
 * reason about side-by-side.
 */

const ANILIST_URL   = 'https://graphql.anilist.co'
const ANILIST_QUERY = `
  query ($page: Int) {
    Page(page: $page, perPage: 1) {
      pageInfo { hasNextPage }
      media(type: ANIME, format_not_in: [MUSIC], averageScore_greater: 0, isAdult: false) {
        id
        title { romaji english }
        averageScore
        coverImage { extraLarge large }
      }
    }
  }
`

// AniList paginates scored anime to exactly 5 000 pages at perPage=1.
// Verified live: page 5000 returns data; page 8000 returns empty.
const ANILIST_MAX_PAGE = 5000

// One in-flight guard — spawn sweeps fire infrequently but could theoretically
// overlap with a manual owner spawn. A single boolean is sufficient.
let fetchInFlight = false

/**
 * Fetches one random anime entry from AniList.
 * Returns null on any network failure, non-200 response, or empty result.
 * Score is normalised to a 0–10 float (AniList returns 0–100 integers).
 */
export async function fetchRandomSeries() {
  if (fetchInFlight) return null
  fetchInFlight = true
  try {
    return await _fetchOnce(/* retry= */ true)
  } finally {
    fetchInFlight = false
  }
}

async function _fetchOnce(retry = true) {
  async function doFetch() {
    try {
      const page = Math.floor(Math.random() * ANILIST_MAX_PAGE) + 1
      const res  = await fetch(ANILIST_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:    JSON.stringify({ query: ANILIST_QUERY, variables: { page } }),
        signal:  AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null
      const json = await res.json()
      const media = json?.data?.Page?.media?.[0]
      if (!media?.id) return null
      const rawScore = media.averageScore   // 0–100 integer or null
      return {
        anilistId: media.id,
        title:     media.title?.romaji ?? media.title?.english ?? 'Unknown Title',
        imageUrl:  media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
        score:     typeof rawScore === 'number' ? rawScore / 10 : null,
      }
    } catch {
      return null
    }
  }

  const first = await doFetch()
  if (!first) return null
  // averageScore_greater:0 filter should guarantee a score, but retry once
  // as a safety net in case a null slips through.
  if (first.score === null && retry) {
    const second = await doFetch()
    if (second?.score !== null) return second
  }
  return first
}

// ── Tier table ───────────────────────────────────────────────────────────────
// Thresholds use the same 0–10 scale as before; AniList scores normalised
// to that scale map naturally (e.g. AniList 86 → 8.6 → Mythic tier).

const TIERS = [
  { name: 'Ascendant', min: 9.0,        sellMin: 3000, sellMax: 5000 },
  { name: 'Mythic',    min: 8.5,        sellMin: 1800, sellMax: 3000 },
  { name: 'Legendary', min: 8.0,        sellMin: 1000, sellMax: 1800 },
  { name: 'Epic',      min: 7.0,        sellMin:  500, sellMax: 1000 },
  { name: 'Rare',      min: 6.0,        sellMin:  250, sellMax:  500 },
  { name: 'Uncommon',  min: 5.0,        sellMin:  100, sellMax:  250 },
  { name: 'Common',    min: -Infinity,  sellMin:   40, sellMax:  100 },
]

/** Returns the tier descriptor for a given normalised score (0–10). */
export function getSeriesTier(score) {
  const s = typeof score === 'number' ? score : -Infinity
  return TIERS.find(t => s >= t.min) ?? TIERS[TIERS.length - 1]
}

/**
 * Rolls a stable sell price within the tier's range.
 * Called once at claim time and stored on the owned entry — the quoted sell
 * price never re-rolls between claim and sell.
 */
export function rollSeriesSellPrice(tier) {
  const { sellMin, sellMax } = typeof tier === 'string'
    ? (TIERS.find(t => t.name === tier) ?? TIERS[TIERS.length - 1])
    : tier
  return Math.floor(Math.random() * (sellMax - sellMin + 1)) + sellMin
}

// ── Tier formatting ──────────────────────────────────────────────────────────

const TIER_DISPLAY = {
  Common:    { stars: '☆☆☆☆☆', emoji: '⬜' },
  Uncommon:  { stars: '★☆☆☆☆', emoji: '🟩' },
  Rare:      { stars: '★★☆☆☆', emoji: '🟦' },
  Epic:      { stars: '★★★☆☆', emoji: '🟪' },
  Legendary: { stars: '★★★★☆', emoji: '🟨' },
  Mythic:    { stars: '★★★★✦', emoji: '💠' },
  Ascendant: { stars: '✦✦✦✦✦', emoji: '🌟' },
}

export function seriesTierStars(tierName) {
  return TIER_DISPLAY[tierName]?.stars ?? '☆☆☆☆☆'
}

export function seriesTierEmoji(tierName) {
  return TIER_DISPLAY[tierName]?.emoji ?? '⬜'
}

// ── Claim code ───────────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateSeriesClaimCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return code
}

// ── Player collection helpers ────────────────────────────────────────────────

/** Adds a fetched series to player.seriesCollection (mutates in place). */
export function addSeriesToPlayer(player, raw) {
  if (!Array.isArray(player.seriesCollection)) player.seriesCollection = []
  const tier = getSeriesTier(raw.score)
  player.seriesCollection.push({
    anilistId: raw.anilistId,
    title:     raw.title,
    imageUrl:  raw.imageUrl,
    score:     raw.score,
    tier:      tier.name,
    sellPrice: rollSeriesSellPrice(tier),
    claimedAt: Date.now(),
  })
}

/**
 * Finds an owned series by anilistId (exact) or case-insensitive title.
 * Also checks legacy `malId` field so old collection entries keep working.
 */
export function findOwnedSeries(player, query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  const col = player.seriesCollection ?? []
  return col.find(s => String(s.anilistId ?? s.malId) === String(query))
    ?? col.find(s => s.title.toLowerCase() === q)
    ?? col.find(s => s.title.toLowerCase().includes(q))
    ?? null
}

/** Total sell-value of all series a player owns (used by .series top). */
export function getSeriesCollectionValue(player) {
  return (player.seriesCollection ?? []).reduce((sum, s) => sum + (s.sellPrice ?? 0), 0)
}
