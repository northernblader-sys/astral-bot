/**
 * tourney-repo.js — realm-wide PvP bracket tournaments, stored independently
 * of the player record (db.data.tourneys, keyed by group JID) so that:
 *   - the bracket survives a bot restart (unlike plugins/auction.js's
 *     in-memory `lots` array — a tournament can run for hours/days across
 *     many real .pvp duels, so it needs to persist to disk like
 *     guild-repo.js/jail-repo.js do, not live in module state)
 *   - only one tournament can be active per group at a time (keyed by the
 *     group JID == ctx.sender for group chats)
 *
 * Record shape (db.data.tourneys[groupJid]):
 * {
 *   id:          string,          // groupJid, doubles as the lookup key
 *   name:        string,          // admin-chosen tournament name
 *   currency:    'solars'|'gems', // entry fee currency
 *   entryFee:    number,          // cost to join — collected and discarded,
 *                                 // does NOT fund the prize (see prizeCurrency/
 *                                 // prize1st/prize2nd below)
 *   prizeCurrency: 'solars'|'gems', // currency the prize is paid out in —
 *                                   // independent of entry-fee currency
 *   prize1st:    number,          // fixed 1st-place payout, set at creation
 *   prize2nd:    number,          // fixed 2nd-place payout, set at creation
 *   maxPlayers:  number,          // 6 or 8
 *   status:      'open'|'active'|'done'|'cancelled',
 *   players:     Array<{ jid, name }>,  // joined roster, open phase only
 *   rounds:      Array<Array<Match>>,   // rounds[0] = round 1 matchups, etc.
 *   currentRound: number,         // index into rounds[] that's still live
 *   createdBy:   string,          // jid of the owner who ran .tourney create
 *   createdAt:   number,
 * }
 *
 * Match shape: {
 *   p1: { jid, name } | null,     // null only for a bye slot
 *   p2: { jid, name } | null,
 *   winnerJid:  string|null,      // set once resolved
 *   byePassed:  boolean,          // true if this match auto-advanced p1 (no p2)
 * }
 *
 * A tourney match is NOT a separate battle system — it just tags a normal
 * .pvp duel. findActiveMatchFor(db, jid) is what plugins/pvp.js's
 * pvpConclude() calls to check "were these two paired in some group's
 * live tournament round?" and, if so, advanceMatch() records the result
 * and rolls the bracket forward.
 */

const VALID_SIZES = [6, 8]

/** Returns the tourney record for `groupJid`, or null if none exists. */
export function getTourney(db, groupJid) {
  return db.data.tourneys?.[groupJid] ?? null
}

/** True if `groupJid` has a tourney that's still accepting joiners. */
export function hasOpenTourney(db, groupJid) {
  return getTourney(db, groupJid)?.status === 'open'
}

/** True if `groupJid` has a tourney currently mid-bracket. */
export function hasActiveTourney(db, groupJid) {
  return getTourney(db, groupJid)?.status === 'active'
}

export function isValidBracketSize(n) {
  return VALID_SIZES.includes(n)
}

/**
 * Creates a new 'open' tourney for `groupJid`. Caller is responsible for
 * checking hasOpenTourney/hasActiveTourney first — this overwrites any
 * previous 'done'/'cancelled' record for the same group without asking.
 */
export async function createTourney(db, groupJid, opts) {
  if (!db.data.tourneys) db.data.tourneys = {}
  db.data.tourneys[groupJid] = {
    id: groupJid,
    name: opts.name,
    currency: opts.currency,
    entryFee: opts.entryFee,
    prizeCurrency: opts.prizeCurrency,
    prize1st: opts.prize1st,
    prize2nd: opts.prize2nd,
    maxPlayers: opts.maxPlayers,
    status: 'open',
    players: [],
    rounds: [],
    currentRound: 0,
    createdBy: opts.createdBy,
    createdAt: Date.now(),
  }
  await db.write()
  return db.data.tourneys[groupJid]
}

/**
 * Adds a joiner to an 'open' tourney. Caller (plugins/tourney.js) is
 * responsible for actually deducting the entry fee from the player's
 * wallet beforehand — this only updates the shared roster. The fee is
 * NOT tracked into a pool; prize payouts are fixed amounts set at
 * creation (prize1st/prize2nd), independent of fees collected. Returns
 * the updated tourney, or null if not joinable (no open tourney / already
 * full / jid already joined).
 */
export async function joinTourney(db, groupJid, jid, name) {
  const t = getTourney(db, groupJid)
  if (!t || t.status !== 'open') return null
  if (t.players.length >= t.maxPlayers) return null
  if (t.players.some(p => p.jid === jid)) return null

  t.players.push({ jid, name })
  await db.write()
  return t
}

/** True if `jid` is already in the roster of `groupJid`'s open tourney. */
export function isJoined(db, groupJid, jid) {
  return !!getTourney(db, groupJid)?.players.some(p => p.jid === jid)
}

/**
 * Removes `jid` from an 'open' tourney's roster and refunds their entry
 * fee. Caller (plugins/tourney.js) is responsible for actually crediting
 * the refund back to the player's wallet — this only updates the shared
 * record. Returns { tourney, refund } or null if not kickable (no open
 * tourney / jid never joined).
 */
export async function kickFromOpenTourney(db, groupJid, jid) {
  const t = getTourney(db, groupJid)
  if (!t || t.status !== 'open') return null
  const idx = t.players.findIndex(p => p.jid === jid)
  if (idx === -1) return null

  t.players.splice(idx, 1)
  const refund = t.entryFee
  await db.write()
  return { tourney: t, refund }
}

/**
 * Removes `jid` from a live 'active' tournament by forcing a loss in their
 * current unresolved match (if they have one) — same cascade path a real
 * .pvp loss would take, so their opponent auto-advances and byes cascade
 * forward exactly as advanceMatch() already handles. If `jid` has no live
 * match this round (already eliminated, or waiting on a bye), nothing to
 * resolve — returns { tourney, matchForfeited: false }.
 * Returns null if there's no active tournament for this group at all.
 */
export async function kickFromActiveTourney(db, groupJid, jid) {
  const t = getTourney(db, groupJid)
  if (!t || t.status !== 'active') return null

  const round = t.rounds[t.currentRound]
  const matchIdx = round?.findIndex(m => !m.winnerJid && [m.p1?.jid, m.p2?.jid].includes(jid))

  if (matchIdx === undefined || matchIdx === -1) {
    return { tourney: t, matchForfeited: false, opponentJid: null }
  }

  const match = round[matchIdx]
  const opponent = match.p1?.jid === jid ? match.p2 : match.p1
  if (!opponent) {
    // jid was the only side of a not-yet-bye-resolved slot — shouldn't
    // normally happen post round-1 pairing, but guard anyway by just
    // clearing the match entirely rather than crowning a null winner.
    return { tourney: t, matchForfeited: false, opponentJid: null }
  }

  const result = await advanceMatch(db, groupJid, t.currentRound, matchIdx, opponent.jid)
  return {
    tourney: result.tourney,
    matchForfeited: true,
    opponentJid: opponent.jid,
    finished: result.finished,
    championJid: result.championJid,
    runnerUpJid: result.runnerUpJid,
  }
}

/** Fisher-Yates shuffle — used by startTourney() to randomize seeding. */
function shuffled(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Builds round 1 from a shuffled player list. If the roster is short of a
 * power-of-two (e.g. 6 players -> next power of two is 8), the extra slots
 * become byes — a bye match has p2: null and is treated as already won by
 * p1 (no real .pvp duel needed for that pairing).
 */
function buildRound1(players) {
  const shuffledPlayers = shuffled(players)
  const bracketSlots = shuffledPlayers.length <= 4 ? 4 : 8
  const matches = []
  for (let i = 0; i < bracketSlots; i += 2) {
    const p1 = shuffledPlayers[i] ?? null
    const p2 = shuffledPlayers[i + 1] ?? null
    matches.push({
      p1,
      p2,
      winnerJid: p2 ? null : (p1 ? p1.jid : null),
      byePassed: !!p1 && !p2,
    })
  }
  return matches
}

/**
 * Locks the roster and builds the full bracket skeleton. Only round 1's
 * matchups are populated with real players; later rounds are filled in as
 * `advanceMatch()` resolves the round before them (each later round starts
 * as an array of { p1: null, p2: null, winnerJid: null } placeholders sized
 * for how many winners will feed into it).
 * Returns the updated tourney, or null if not startable (no open tourney /
 * fewer than 2 players joined).
 */
export async function startTourney(db, groupJid) {
  const t = getTourney(db, groupJid)
  if (!t || t.status !== 'open') return null
  if (t.players.length < 2) return null

  const round1 = buildRound1(t.players)
  t.rounds = [round1]

  // Pre-build empty placeholder rounds down to the final.
  let feedCount = round1.length / 2
  while (feedCount >= 1) {
    t.rounds.push(
      Array.from({ length: feedCount }, () => ({ p1: null, p2: null, winnerJid: null, byePassed: false })),
    )
    feedCount = feedCount / 2
  }

  t.status = 'active'
  t.currentRound = 0
  await resolveAutoAdvances(db, groupJid)
  await db.write()
  return db.data.tourneys[groupJid]
}

/**
 * Pushes bye winners (and any newly-resolved match's winner) into the next
 * round's empty slot. Called after startTourney() and after every
 * advanceMatch() so byes and completed rounds cascade forward without a
 * separate admin step.
 */
async function resolveAutoAdvances(db, groupJid) {
  const t = getTourney(db, groupJid)
  if (!t) return

  for (let r = 0; r < t.rounds.length - 1; r++) {
    const round = t.rounds[r]
    const nextRound = t.rounds[r + 1]
    for (let i = 0; i < round.length; i++) {
      const match = round[i]
      if (!match.winnerJid) continue
      const winner = match.p1?.jid === match.winnerJid ? match.p1 : match.p2
      const nextMatch = nextRound[Math.floor(i / 2)]
      const slot = i % 2 === 0 ? 'p1' : 'p2'
      if (nextMatch[slot] === null && winner) {
        nextMatch[slot] = winner

        // Auto-resolve nextMatch as a bye ONLY if its OTHER feeder match
        // (the sibling in `round` that fills the other slot) can never
        // produce an opponent — i.e. that sibling is itself a genuine bye
        // with no p2 seeded at all. A sibling that simply hasn't been
        // played yet (both players present, no winnerJid yet) must NOT
        // trigger this: the previous version keyed off "is the other slot
        // currently empty", which is also true mid-round while the
        // sibling match is still in progress, and was overwriting
        // nextMatch.winnerJid with whichever side happened to fill first
        // — silently skipping real matches and corrupting results.
        const siblingIdx = i % 2 === 0 ? i + 1 : i - 1
        const sibling = round[siblingIdx]
        const siblingIsDeadBye = !sibling || (!sibling.p2 && !!sibling.p1 && sibling.byePassed) || (!sibling.p1 && !sibling.p2)

        if (siblingIsDeadBye && r + 1 < t.rounds.length - 1) {
          nextMatch.winnerJid = winner.jid
          nextMatch.byePassed = true
        }
      }
    }
  }
  await db.write()
}

/**
 * Finds a live, unresolved bracket match anywhere across all groups'
 * active tournaments where `jidA` and `jidB` are paired against each other
 * in the current round. Returns { groupJid, tourney, roundIdx, matchIdx,
 * match } or null. This is what pvp.js's pvpConclude() calls on every duel
 * conclusion to check "was this actually a tourney match?" — cheap enough
 * to run unconditionally since active tournaments are rare and short-lived.
 */
export function findActiveMatchFor(db, jidA, jidB) {
  const all = db.data.tourneys ?? {}
  for (const groupJid of Object.keys(all)) {
    const t = all[groupJid]
    if (t.status !== 'active') continue
    const round = t.rounds[t.currentRound]
    if (!round) continue
    for (let matchIdx = 0; matchIdx < round.length; matchIdx++) {
      const match = round[matchIdx]
      if (match.winnerJid) continue // already resolved
      const jids = [match.p1?.jid, match.p2?.jid].filter(Boolean)
      if (jids.includes(jidA) && jids.includes(jidB)) {
        return { groupJid, tourney: t, roundIdx: t.currentRound, matchIdx, match }
      }
    }
  }
  return null
}

/**
 * Records a match result, cascades any newly-possible auto-advances, and
 * bumps currentRound once every match in it has a winnerJid. Returns
 * { tourney, finished, championJid, runnerUpJid } — finished is true once
 * the final's winner has been recorded.
 */
export async function advanceMatch(db, groupJid, roundIdx, matchIdx, winnerJid) {
  const t = getTourney(db, groupJid)
  if (!t) return null
  const match = t.rounds[roundIdx][matchIdx]
  match.winnerJid = winnerJid
  await db.write()
  await resolveAutoAdvances(db, groupJid)

  // Advance currentRound past any fully-resolved rounds.
  while (
    t.currentRound < t.rounds.length - 1 &&
    t.rounds[t.currentRound].every(m => m.winnerJid)
  ) {
    t.currentRound += 1
  }

  const finalRound = t.rounds[t.rounds.length - 1]
  const finalMatch = finalRound[0]
  let finished = false
  let championJid = null
  let runnerUpJid = null

  if (finalMatch.winnerJid) {
    finished = true
    championJid = finalMatch.winnerJid
    runnerUpJid = finalMatch.p1?.jid === championJid ? finalMatch.p2?.jid : finalMatch.p1?.jid
    t.status = 'done'
  }

  await db.write()
  return { tourney: t, finished, championJid, runnerUpJid }
}

/** Cancels an 'open' or 'active' tourney. Caller handles any refunds. */
export async function cancelTourney(db, groupJid) {
  const t = getTourney(db, groupJid)
  if (!t || t.status === 'done' || t.status === 'cancelled') return null
  t.status = 'cancelled'
  await db.write()
  return t
}
