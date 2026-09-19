/**
 * <prefix>envy-spin <amount>
 *
 * Tella, the Witch of Envy — global-exclusive spin. A direct copy of
 * plugins/alexa-spin.js's shape (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation, same flat-plateau
 * odds curve). Only ONE player, bot-wide, can ever obtain her.
 *
 * Odds curve (via chanceForExclusiveSpin):
 *   spins 1-235   -> 0%    (DEAD_ZONE_UNTIL = 235, a true dead zone: nobody
 *                            can win her in the first 235 spins no matter how
 *                            many gems burn)
 *   spin 236+     -> 100%  (PITY_AT = 236, so the FIRST spin past the dead
 *                            zone is a guaranteed win, and PLATEAU_CHANCE = 1.0
 *                            lands on the same result. She cannot be missed
 *                            once the grind is paid. MAX_SPINS_PER_PLAYER = 250
 *                            is only a ceiling: in practice she is always taken
 *                            on spin 236, for 236 gems.)
 * These numbers are never printed in player-facing copy, only the pity bar
 * (progress toward the spin cap) is shown, matching every other exclusive
 * spin's "never reveals the plateau" rule. Do not surface DEAD_ZONE_UNTIL,
 * PLATEAU_CHANCE or the 236 guarantee anywhere in a reply.
 *
 * 1 Gem per spin. Max 250 spins per player (she is guaranteed on spin 236),
 * bot-wide lock same as every other exclusive. Or skip the grind entirely:
 * 5 Monds buys her outright with .character buy tella.
 *
 * ART: character.image is her still portrait (data/characters.json's
 * witch_of_envy.image, a .jpg, NOT a GIF), so replyOverArt below sends it as a
 * normal image rather than routing through the animated-GIF path alexa-spin
 * uses. Shown on the win message and on a player's very first-ever attempt as a
 * one-time preview; every losing spin after that is text-only.
 */
import { config } from '../config.js'
import { characterStars } from '../lib/rarity.js'
import {
  getActiveSeason,
  ensurePlayerSeasonState,
  chanceForExclusiveSpin,
  getExclusiveSpinWinner,
  claimExclusiveSpinForPlayer,
  addOwnedSeasonContent,
} from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'witch_of_envy'
const SPIN_FIELD = 'envySpins'
const COST_PER_SPIN = 1
const DEAD_ZONE_UNTIL = 235  // spins 1-235: 0%, a true dead zone
const PLATEAU_CHANCE = 1.00  // spin 236+: 100% (same result as PITY_AT below)
const PITY_AT = 236          // the FIRST spin past the dead zone is a guaranteed win
const MAX_SPINS_PER_PLAYER = 250 // hard lifetime cap; she is taken on spin 236 in practice
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap, spam-proofs one giant pull

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'She does not look at you. She looks at what you have.',
  'Something you love feels colder for a moment, then it passes.',
  'A shadow leans close, decides you are not worth the envy, and withdraws.',
  'You had it, whatever it was, and now you are not sure you ever did.',
  'The air goes thin with wanting. None of it is hers to give you.',
  'Almost. She almost minded you. Almost is not enough.',
]

function missLine(spin) {
  return `🖤 ${MISS_LINES[spin % MISS_LINES.length]}`
}

/** Progress toward the spin cap, never reveals the plateau. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / MAX_SPINS_PER_PLAYER) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

function reel(results) {
  const MAX_ROWS = 5
  const marks = results.map(r => (r.won ? '✦' : '·'))
  const rows = []
  for (let i = 0; i < marks.length; i += 10) rows.push(marks.slice(i, i + 10).join(' '))
  if (rows.length <= MAX_ROWS) return rows.join('\n')
  return [`_…${(rows.length - MAX_ROWS) * 10} earlier spins_`, ...rows.slice(-MAX_ROWS)].join('\n')
}

function activeSeasonOrReply(ctx) {
  const season = getActiveSeason(ctx.db)
  if (!season) {
    ctx.reply(`🌙 There is no active season right now.`)
    return null
  }
  return season
}

async function replyOverArt(ctx, character, text) {
  if (!character?.image) return ctx.reply(text)
  try {
    // Her reveal art is a STILL image (data/characters.json's witch_of_envy.image
    // is a .jpg, not a GIF), so send it through the normal image path rather
    // than replyGif's animated-media route (which would try to loop a still as
    // video). Falls back to plain text if the media send fails, same as every
    // other exclusive spin.
    if (typeof ctx.replyImage === 'function') {
      return await ctx.replyImage(character.image, text)
    }
    return await ctx.reply(text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'envy-spin',
  aliases: ['envyspin', 'envy', 'witch-of-envy-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Tella, the Witch of Envy. 1 Gem per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ The Witch of Envy isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this command
    // mutates their spin count? Read once, up front, and used only to decide
    // whether the portrait rides along on an otherwise text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `🖤 *She is already yours.*\n${RULE}\n_The first witch stands at your side and no one else's. There is nothing left to envy for._`
        : `🔒 *SHE IS ALREADY BOUND*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever bind the first witch, and someone got there first. No gems were spent.`)
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      ensurePlayerSeasonState(player, season.id)

      if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) {
        outcome = { reason: 'claimed' }
        return
      }

      const results = []
      let won = false
      let spinsUsed = 0
      let gems = player.wallet?.gems ?? 0

      for (let i = 0; i < spinCount; i++) {
        if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) break
        if (gems < COST_PER_SPIN) break
        if ((player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER) break

        const nextSpin = (player[SPIN_FIELD] ?? 0) + 1
        const chance = chanceForExclusiveSpin(nextSpin, { deadZoneUntil: DEAD_ZONE_UNTIL, plateauChance: PLATEAU_CHANCE, pityAt: PITY_AT })
        const thisWon = nextSpin >= PITY_AT || Math.random() < chance

        gems = roundGems(gems - COST_PER_SPIN)
        player.wallet.gems = gems
        player[SPIN_FIELD] = nextSpin
        spinsUsed++
        results.push({ spin: nextSpin, won: thisWon })

        if (thisWon) {
          const claimed = claimExclusiveSpinForPlayer(ctx.db, CHARACTER_ID, ctx.from)
          if (claimed) {
            player.ownedCharacters = player.ownedCharacters ?? []
            if (!player.ownedCharacters.includes(character.id)) player.ownedCharacters.push(character.id)
            addOwnedSeasonContent(player, 'character', character.id)
            won = true
          }
          break
        }
      }

      if (!results.length) {
        outcome = { reason: (player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER ? 'exhausted_lifetime' : 'gems', gems, cost: COST_PER_SPIN }
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
      return replyOverArt(ctx, character,
        `🔒 *SHE IS ALREADY BOUND*\n${RULE}\n_${character.name} was bound while you were still reaching._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_Envy is patient. It still expects to be paid._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🖤 *No spins left.*\n${RULE}\n` +
        `_You've spent all *${MAX_SPINS_PER_PLAYER}* of your spins reaching for the first witch. She never once envied you._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = (outcome.spinsUsed * COST_PER_SPIN).toFixed(1).replace(/\.0$/, '')
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `🖤✨ *SHE MINDS YOU NOW.* ✨🖤\n${RULE}\n` +
        `_Spin ${last.spin}. Out of everyone who ever stood too close, it is you she cannot look away from._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🖤'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever bind her.\n` +
        `_Taken on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip her with *${config.prefix}character equip tella*._`,
      )
    }

    const lines = [
      `🖤 *THE FIRST WITCH'S NOTICE*`,
      RULE,
      `_You lay 💎${spent} at her feet. She has not decided whether you are worth minding._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${MAX_SPINS_PER_PLAYER}`,
      `💎 Remaining: *${outcome.remaining}*`,
    ]

    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command, run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // Portrait preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive
    // spin's plain ctx.reply() on loss).
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
