/**
 * <prefix>mei-spin <amount>
 *
 * Replaces the old .season spin / .season draw gem-spin system entirely.
 * Costs 0.5 Gems per spin. Odds are a flat ~1% from spin 1-49, then ramp
 * linearly from spin 50 to spin 100, guaranteed by spin 100 — reusing
 * chanceForMajorSpin()'s exact shape with rampStart overridden to 50
 * (instead of season.json's gemSpin.rampStart of 80, which belonged to the
 * removed per-player system). Odds are hidden entirely for spins 1-50 (no
 * percentage shown in the reply); from spin 51 onward the odds are shown
 * normally.
 *
 * Global exclusivity: Mei can only ever be won by ONE player, bot-wide —
 * not owned per-player like other season content. The lock lives in
 * lib/season-engine.js's runtime object (db.data.seasonRuntime.meiWonBy),
 * the same season-wide (not per-player) state pattern activeSeasonId
 * already uses. The moment anyone wins her, every other player's spins are
 * locked immediately.
 *
 * PRESENTATION: the reply is sent as Mei's own artwork with the result as
 * the caption, so the thing you're chasing is on screen every time you pull.
 * The old reply printed one "Spin N/100 — no luck." line per spin, which for
 * a 50-spin pull was fifty identical lines and no sense of getting closer.
 * Now the batch is one reel, one flavour beat, and a pity bar — the bar is
 * the real information, since spin 100 is a guarantee and every spin spent
 * is progress toward it whether or not it hit.
 *
 * The odds blackout through spin 50 is deliberate and is preserved here:
 * during it the reply says the odds are sealed rather than printing a
 * number, because showing "1%" fifty times in a row reads as a bug report
 * waiting to happen. From spin 51 the real percentage is shown on every line.
 */
import { config } from '../config.js'
import { characterStars } from '../lib/rarity.js'
import {
  getActiveSeason,
  ensurePlayerSeasonState,
  chanceForMajorSpin,
  formatPercent,
  getMeiWinner,
  claimMeiForPlayer,
  addOwnedSeasonContent,
} from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { spinLockGate } from '../lib/spin-locks.js'

const COST_PER_SPIN = 0.5
const RAMP_START = 50
const PITY_AT = 100
const ODDS_HIDDEN_THROUGH_SPIN = 50 // no percentage shown for spins 1-50
const MAX_SPINS_PER_COMMAND = 5 // hard per-command cap — spam-proofs one giant pull (e.g. .mei-spin 69) into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

/**
 * Flavour for a batch that didn't hit. Indexed by the spin number rather than
 * randomised, so consecutive pulls read as a sequence instead of repeating the
 * same line twice by chance.
 */
const MISS_LINES = [
  'The incense burns down to ash. Nothing answers.',
  'Petals drift across the empty step. She does not come.',
  'The lantern gutters, steadies, and stays lit. Not yet.',
  'A bell somewhere behind the gate. It stops before you place it.',
  'The prayer leaves your hands and goes unread.',
  'Something moves past the paper screen — the wrong shape.',
  'The offering is taken. Nothing is given back.',
  'Cold air off the shrine steps. The gate stays shut.',
]

/** The last stretch before the guarantee gets its own, hungrier voice. */
const NEAR_LINES = [
  'The air pulls tight. She is close enough to feel.',
  'The gate shudders in its frame. Once more.',
  'Every lantern on the path is lit now. Something is coming.',
  'The petals are falling upward. That has never happened before.',
]

function missLine(spin, chance) {
  if (chance >= 0.5) return `🌫️ ${NEAR_LINES[spin % NEAR_LINES.length]}`
  return `🕯️ ${MISS_LINES[spin % MISS_LINES.length]}`
}

/** Progress toward the spin-100 guarantee — the one number that always moves. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / PITY_AT) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

/**
 * The batch as a strip of marks, ten to a row — a 40-spin pull reads as four
 * rows instead of forty lines. Capped because a 100-spin pull would otherwise
 * push the pity bar off the bottom of a phone screen; the count is stated
 * either way so nothing is hidden.
 */
function reel(results) {
  const MAX_ROWS = 5
  const marks = results.map(r => (r.won ? '✦' : '·'))
  const rows = []
  for (let i = 0; i < marks.length; i += 10) rows.push(marks.slice(i, i + 10).join(' '))
  if (rows.length <= MAX_ROWS) return rows.join('\n')
  // Keep the last rows — the tail is where the win, if any, lives.
  return [`_…${(rows.length - MAX_ROWS) * 10} earlier spins_`, ...rows.slice(-MAX_ROWS)].join('\n')
}

/** The odds line, or the blackout notice while odds are still sealed. */
function oddsLine(spin, chance) {
  if (spin > ODDS_HIDDEN_THROUGH_SPIN) return `🎯 Odds now *${formatPercent(chance)}* per spin`
  return `🎯 _Odds stay sealed until spin ${ODDS_HIDDEN_THROUGH_SPIN + 1}._`
}

function activeSeasonOrReply(ctx) {
  const season = getActiveSeason(ctx.db)
  if (!season) {
    ctx.reply(`🌙 There is no active season right now.`)
    return null
  }
  return season
}

/**
 * Sends `text` over Mei's artwork, falling back to a plain reply if she has no
 * image on file or the send fails. A spin that resolved must always be
 * reported — gems have already been spent by this point, so an image problem
 * can never be allowed to swallow the result.
 */
async function replyOverArt(ctx, mei, text) {
  if (!mei?.image) return ctx.reply(text)
  try {
    return await ctx.replyImage(mei.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'mei-spin',
  aliases: ['meispin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Mei — 0.5 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const mei = characterMap[season.characters.major]

    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Placed after
    // Mei is resolved rather than at the top of run() because this plugin has
    // no CHARACTER_ID constant: the season's major character is whoever
    // season.characters.major points at, so the id has to be read off her.
    if (spinLockGate(ctx, mei?.id, mei?.name)) return

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, 100, Math.max(1, requested))

    // Global check before spending anything — if Mei is already claimed
    // (by anyone, including this player racing an earlier win), no gems
    // are spent and no spin happens.
    const existingWinner = getMeiWinner(ctx.db)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, mei, isSelf
        ? `🌸 *${mei.name} is already yours.*\n${RULE}\n_She stepped through the gate for you and no one else. There is nothing left to spin for._`
        : `🔒 *THE GATE IS SEALED*\n${RULE}\n_${mei.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone reached her first. No gems were spent.`)
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      ensurePlayerSeasonState(player, season.id)

      // Re-check inside the write-serialized mutator — this is the actual
      // race-safe check; the earlier one above is just a fast, cheap
      // pre-check to avoid spending gems for nothing on the common path.
      if (getMeiWinner(ctx.db)) {
        outcome = { reason: 'claimed', winner: getMeiWinner(ctx.db) }
        return
      }

      const results = []
      let won = false
      let spinsUsed = 0
      let gems = player.wallet?.gems ?? 0

      for (let i = 0; i < spinCount; i++) {
        if (getMeiWinner(ctx.db)) break // someone else claimed her mid-loop — stop immediately
        if (gems < COST_PER_SPIN) {
          outcome = outcome ?? null
          break
        }
        const nextSpin = (player.meiSpins ?? 0) + 1
        const chance = chanceForMajorSpin(nextSpin, season, { rampStart: RAMP_START, pityAt: PITY_AT })
        const thisWon = nextSpin >= PITY_AT || Math.random() < chance

        gems = roundGems(gems - COST_PER_SPIN)
        player.wallet.gems = gems
        player.meiSpins = nextSpin
        spinsUsed++
        results.push({ spin: nextSpin, chance, won: thisWon })

        if (thisWon) {
          const claimed = claimMeiForPlayer(ctx.db, ctx.from)
          if (claimed) {
            addOwnedSeasonContent(player, 'character', mei.id)
            player.seasonProgress.majorCharacter = mei.id
            won = true
          }
          // Whether or not this call actually won the race, stop spinning —
          // either we won, or someone else beat us to it this same tick.
          break
        }
      }

      if (!results.length) {
        outcome = { reason: 'gems', gems, cost: COST_PER_SPIN }
        return
      }

      outcome = {
        reason: won ? 'won' : 'exhausted',
        results,
        spinsUsed,
        remaining: player.wallet.gems,
      }
    })

    if (outcome?.reason === 'claimed') {
      return replyOverArt(ctx, mei,
        `🔒 *THE GATE IS SEALED*\n${RULE}\n_${mei.name} was claimed while you reached for her._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_The altar takes only gems. Come back with more._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = (outcome.spinsUsed * COST_PER_SPIN).toFixed(1).replace(/\.0$/, '')
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = mei.ability
      return replyOverArt(ctx, mei,
        `🌸✨ *SHE TURNS.* ✨🌸\n${RULE}\n` +
        `_Spin ${last.spin}. The lantern flares white — and ${mei.name} steps through the gate._\n\n` +

        `🏆 *${mei.name.toUpperCase()} OBTAINED*\n` +
        `${mei.emoji ?? '🌸'} *${characterStars(mei.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (mei.description ? `\n_${mei.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin} of ${PITY_AT}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*`,
      )
    }

    const lines = [
      `🌸 *THE PRAYER GATE*`,
      RULE,
      `_You set 💎${spent} on the altar. The incense takes._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin, last.chance),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${PITY_AT}`,
      oddsLine(last.spin, last.chance),
      `💎 Remaining: *${outcome.remaining}*`,
    ]

    if (last.spin >= PITY_AT - 10 && last.spin < PITY_AT) {
      lines.push(``, `⚡ _Spin ${PITY_AT} is a guarantee. She is ${PITY_AT - last.spin} away._`)
    }
    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command — run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    return replyOverArt(ctx, mei, lines.join('\n'))
  },
}
