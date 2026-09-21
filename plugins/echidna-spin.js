/**
 * <prefix>echidna-spin <amount>
 *
 * Echidna, the Witch of Greed - global-exclusive spin. Same shape as
 * plugins/alexa-spin.js / plugins/envy-spin.js (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her - she is theirs forever.
 *
 * Odds curve (via chanceForExclusiveSpin):
 *   spins 1-250   -> 0%    (DEAD_ZONE_UNTIL = 250, a true dead zone: she does
 *                           NOT accept you, no matter how many gems burn)
 *   spin 251+     -> 100%  (PLATEAU_CHANCE = 1.0 and PITY_AT = 251 agree: the
 *                           FIRST spin past the dead zone is a guaranteed
 *                           accept. She cannot be missed once the wall is paid)
 *   MAX_SPINS_PER_PLAYER = 275 is the lifetime ceiling; in practice she is
 *   always taken on spin 251 (225.9 gems at 0.9 per spin).
 * These numbers are never printed in player-facing copy, only the pity bar
 * (progress toward the spin cap) is shown, matching every other exclusive
 * spin's "never reveals the plateau" rule. Do not surface DEAD_ZONE_UNTIL,
 * PLATEAU_CHANCE or the 251 guarantee anywhere in a reply.
 *
 * 0.9 Gems per spin - fractional on purpose, roundGems() keeps two decimals
 * so 0.9 subtracts cleanly with no drift (same discipline reverie-spin.js's
 * 0.7 uses). Bot-wide lock same as every other exclusive.
 *
 * ART: two pieces, two roles (per her reveal):
 *   character.image     - her giphy GIF portrait (data/characters.json).
 *                         Shown on the WIN message through ctx.replyGif, so
 *                         it rides each platform's real animated-media path
 *                         (WhatsApp transcodes the raw GIF to a looping video
 *                         with gifPlayback - handler.js's replyGif - Discord:
 *                         raw .gif attachment, Telegram: sendAnimation).
 *   character.spinImage - the static spin-card webp. Shown on a player's
 *                         very first-ever attempt (one-time preview) and on
 *                         the "already bound" replies, through replyImage.
 * Every losing spin after the first attempt is text-only, same as every
 * other exclusive spin.
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

export const CHARACTER_ID = 'echidna'
export const SPIN_FIELD = 'echidnaSpins'
export const COST_PER_SPIN = 0.9    // gems, fractional; roundGems() keeps two decimals
export const DEAD_ZONE_UNTIL = 250  // spins 1-250: 0% - she does not accept you yet
export const PLATEAU_CHANCE = 1.00  // spin 251+: 100% (same result as PITY_AT below)
export const PITY_AT = 251          // the FIRST spin past the dead zone is a guaranteed accept
export const MAX_SPINS_PER_PLAYER = 275 // hard lifetime cap
export const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap, spam-proofs one giant pull

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'She weighs you on a scale only she can see, and does not record the result.',
  'The tea is still warm. She does not pour you a cup.',
  '"Curious," she says, in a tone that means you were not.',
  'Something in your pocket grows lighter - then it is returned. Not yet, she decides.',
  'She turns a page of the Gospel without looking up at you.',
  'Almost accepted. Almost is a coin that buys nothing here.',
]

function missLine(spin) {
  return `🍵 ${MISS_LINES[spin % MISS_LINES.length]}`
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

/**
 * The spin-card art (her static spinImage webp). Used for the first-attempt
 * preview and the already-bound replies; the WIN reveal uses the GIF below.
 */
async function replyOverSpinCard(ctx, character, text) {
  const art = character?.spinImage || character?.image
  if (!art) return ctx.reply(text)
  try {
    if (typeof ctx.replyImage === 'function') {
      return await ctx.replyImage(art, text)
    }
    return await ctx.reply(text)
  } catch {
    return ctx.reply(text)
  }
}

/**
 * The win reveal over her animated GIF portrait. ctx.replyGif routes it
 * through each platform's real animated-media path (WhatsApp: raw GIF
 * transcoded to a looping video with gifPlayback - see handler.js's
 * replyGif - Discord: raw .gif attachment, Telegram: sendAnimation) instead
 * of landing as one still frame the way replyImage renders a .gif URL.
 * Falls back to the static spin card, then plain text.
 */
async function replyOverGif(ctx, character, text) {
  if (character?.image && typeof ctx.replyGif === 'function') {
    try { return await ctx.replyGif(character.image, text) } catch { /* fall through */ }
  }
  return replyOverSpinCard(ctx, character, text)
}

export default {
  name: 'echidna-spin',
  aliases: ['echidnaspin', 'greed-spin', 'witch-of-greed-spin', 'eg-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Echidna, the Witch of Greed. 0.9 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ The Witch of Greed isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this command
    // mutates their spin count? Read once, up front, and used only to decide
    // whether the spin card rides along on an otherwise text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverSpinCard(ctx, character, isSelf
        ? `🍵 *She has already accepted you.*\n${RULE}\n_The Witch of Greed keeps her tea warm for you and only you. There is nothing left to offer._`
        : `🔒 *SHE HAS CHOSEN ALREADY*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever be accepted by the witch, and someone got there first. No gems were spent.`)
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
      return replyOverSpinCard(ctx, character,
        `🔒 *SHE HAS CHOSEN ALREADY*\n${RULE}\n_${character.name} accepted another while you were still reaching._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_Greed is patient. It still expects to be paid._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🍵 *No spins left.*\n${RULE}\n` +
        `_You've spent all *${MAX_SPINS_PER_PLAYER}* of your spins offering gems to the Witch of Greed. She never once accepted you._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = fmtGems(roundGems(outcome.spinsUsed * COST_PER_SPIN))
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverGif(ctx, character,
        `🍵🖤 *SHE ACCEPTS YOU.* 🖤🍵\n${RULE}\n` +
        `_Spin ${last.spin}. Out of every offering laid at her tea table, yours is the one she finally keeps._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🍵'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* She is yours forever - no other player can ever claim her.\n` +
        `_Accepted on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip her with *${config.prefix}character equip echidna*, then open the Gospel in battle with *${config.prefix}greed* - and speak to her anytime with *${config.prefix}echidna*._`,
      )
    }

    const lines = [
      `🍵 *THE WITCH'S JUDGEMENT*`,
      RULE,
      `_You lay 💎${spent} at her feet. She hasn't accepted you yet._`,
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
    // Spin-card preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive
    // spin's plain ctx.reply() on loss).
    return isFirstEverAttempt ? replyOverSpinCard(ctx, character, lossText) : ctx.reply(lossText)
  },
}
