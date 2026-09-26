/**
 * spin-banners.js — the odds, the caps and the pull loop for spin banners that
 * are reachable from BOTH chat and the website.
 *
 * WHY THIS FILE EXISTS — every *-spin.js plugin has always kept its own copy of
 * the curve constants and its own copy of the pull loop, which was fine while a
 * banner had exactly one entry point. The website's spin (POST
 * /api/characters/:id/spin in lib/api-server.js) is a second entry point into
 * the same banner, and two copies of "how likely is spin 231" drift the first
 * time one of them is tuned. A player who pulls on the site and a player who
 * pulls in chat must be playing the same banner, so the numbers and the loop
 * live here and both callers import them.
 *
 * Only Gogeta is registered today. The other banners keep their own inlined
 * copies and can migrate one at a time; nothing here assumes it owns them, and
 * an id with no entry simply has no web spin (the API 404s it), which is the
 * correct default for a chat-only banner.
 *
 * WRITE DISCIPLINE — runSpinBatch() mutates the player record and claims the
 * bot-wide exclusive lock, so it MUST be called from inside an updatePlayer()
 * mutator. That is the same rule claimExclusiveSpinForPlayer() carries in
 * lib/season-engine.js, and for the same reason: db.data mutations have to run
 * on player-repo's serialized write queue or a second writer can clobber them.
 * It is deliberately synchronous so it can sit inside that mutator untouched.
 *
 * NEVER PRINT THE CURVE — deadZoneUntil and plateauChance are not player-facing
 * anywhere, in chat or on the site. Only progress toward maxSpinsPerPlayer (the
 * pity bar) is ever shown. Every banner in the bot follows this rule.
 */
import { roundGems } from './format.js'
import {
  chanceForExclusiveSpin,
  getExclusiveSpinWinner,
  claimExclusiveSpinForPlayer,
} from './season-engine.js'

/**
 * Banner definitions, keyed by character id.
 *
 * `exclusive: true` means one-of-one bot-wide — the first winner anywhere locks
 * the banner for everyone, and it must match `"exclusive": true` on the same
 * character in data/characters.json. The two are read by different code paths
 * (this module claims the lock, plugins/character.js renders the roster), so
 * they have to agree.
 */
export const SPIN_BANNERS = {
  gogeta: {
    id: 'gogeta',
    /** Per-player lifetime spin counter on the player record. */
    spinField: 'gogetaSpins',
    costPerSpin: 1.5,
    currency: 'gems',
    /** Spins 1-230 are a true dead zone: he cannot be won at all before 231. */
    deadZoneUntil: 230,
    /** Spin 231+: flat, sustained to the cap. */
    plateauChance: 0.80,
    /** Far past the cap, so chanceForExclusiveSpin()'s guaranteed-win branch
     *  can never fire. Spin 250 is the same flat roll as spin 231. */
    pityAt: 9999,
    maxSpinsPerPlayer: 250,
    maxSpinsPerCommand: 20,
    exclusive: true,
  },
}

/** The banner for a character id, or null when that character has no banner. */
export function getSpinBanner(id) {
  if (!id) return null
  return SPIN_BANNERS[String(id).toLowerCase()] ?? null
}

/** Spins this player has already burned on a banner. */
export function spinsUsed(player, banner) {
  return player?.[banner.spinField] ?? 0
}

/** Spins left before the lifetime cap. */
export function spinsLeft(player, banner) {
  return Math.max(0, banner.maxSpinsPerPlayer - spinsUsed(player, banner))
}

/** Clamps a requested batch size to the banner's per-command and lifetime caps. */
export function clampSpinCount(banner, requested) {
  const n = Math.floor(Number(requested) || 1)
  return Math.min(banner.maxSpinsPerCommand, banner.maxSpinsPerPlayer, Math.max(1, n))
}

/**
 * runSpinBatch(db, player, banner, playerId, requested) → outcome
 *
 * The pull loop. Read-modify-write on the player record; call only from inside
 * an updatePlayer() mutator (see the file header).
 *
 * Outcome shapes, all carrying `reason`:
 *   { reason: 'owned' }              already this player's, nothing spent
 *   { reason: 'claimed' }            won by someone else, nothing spent
 *   { reason: 'gems', gems, cost }   could not afford even one spin
 *   { reason: 'exhausted_lifetime' } no spins left on the lifetime cap
 *   { reason: 'won' | 'exhausted', results, spinsUsed, remaining, count }
 *
 * The loop stops the moment the banner is claimed, so a batch of 20 fired at
 * the same instant as another player's winning pull spends only the gems for
 * the spins that actually happened before the lock closed.
 */
export function runSpinBatch(db, player, banner, playerId, requested) {
  const count = clampSpinCount(banner, requested)

  player.ownedCharacters = player.ownedCharacters ?? []
  player.wallet = player.wallet ?? {}

  // Pre-check. Cheap, and it means a claimed banner costs nothing to bump into.
  if (banner.exclusive) {
    const winner = getExclusiveSpinWinner(db, banner.id)
    if (winner) return { reason: winner === playerId ? 'owned' : 'claimed' }
  } else if (player.ownedCharacters.includes(banner.id)) {
    return { reason: 'owned' }
  }

  let gems = roundGems(player.wallet.gems ?? 0)
  const results = []
  let won = false
  let used = 0

  for (let i = 0; i < count; i++) {
    // Re-read every iteration: a batch must not keep spending into a banner
    // that was claimed partway through it.
    if (banner.exclusive && getExclusiveSpinWinner(db, banner.id)) break
    if (gems < banner.costPerSpin) break
    if (spinsUsed(player, banner) >= banner.maxSpinsPerPlayer) break

    const nextSpin = spinsUsed(player, banner) + 1
    const chance = chanceForExclusiveSpin(nextSpin, {
      deadZoneUntil: banner.deadZoneUntil,
      plateauChance: banner.plateauChance,
      pityAt: banner.pityAt,
    })
    const rolledWin = nextSpin >= banner.pityAt || Math.random() < chance

    gems = roundGems(gems - banner.costPerSpin)
    player.wallet.gems = gems
    player[banner.spinField] = nextSpin
    used++

    if (!rolledWin) {
      results.push({ spin: nextSpin, won: false })
      continue
    }

    // A winning roll still has to take the lock. It can only fail if another
    // player claimed it in the same instant, which the serialized write queue
    // makes vanishingly unlikely — but a roll that did not end in ownership is
    // recorded as a loss, so the reel never shows a win marker for a spin the
    // player did not actually win.
    const claimed = !banner.exclusive || claimExclusiveSpinForPlayer(db, banner.id, playerId)
    results.push({ spin: nextSpin, won: claimed })
    if (claimed) {
      if (!player.ownedCharacters.includes(banner.id)) player.ownedCharacters.push(banner.id)
      won = true
    }
    break
  }

  if (!results.length) {
    return {
      reason: spinsUsed(player, banner) >= banner.maxSpinsPerPlayer ? 'exhausted_lifetime' : 'gems',
      gems,
      cost: banner.costPerSpin,
    }
  }

  return {
    reason: won ? 'won' : 'exhausted',
    results,
    spinsUsed: used,
    remaining: player.wallet.gems,
    count,
  }
}
