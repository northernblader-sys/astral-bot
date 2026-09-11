/**
 * <prefix>minna-spin <amount>
 *
 * Minna's global-exclusive spin command — structurally identical to
 * plugins/tyla-alya-spin.js and plugins/circe-spin.js (same global-lock pattern
 * via getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her.
 *
 * Odds curve (via chanceForExclusiveSpin, the same helper every other exclusive
 * spin uses, just different overrides):
 *   spins 1-170  -> 0%    (DEAD_ZONE_UNTIL = 170, a true dead zone — she cannot
 *                           be won at all before spin 171)
 *   spin 171+    -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance, sustained
 *                           all the way to the MAX_SPINS cap. Deliberately NOT a
 *                           pity-guarantee curve: PITY_AT is set far past the real
 *                           max spin count (200) so the `spin >= pityAt`
 *                           guaranteed-win branch in chanceForExclusiveSpin()
 *                           never fires, and spin 200 stays a flat 80% roll
 *                           exactly like spin 171.)
 *
 * 0.7 Gems per spin, 200 spins lifetime — so the full run is 140 Gems. Because
 * the dead zone runs to 170 and the per-command cap is 5, a player needs 34
 * commands before their first live roll; that is intended, and the pity bar is
 * what tells them how far along they are. These numbers are never shown in any
 * display text — only the pity bar (progress toward the spin cap) is. Do not
 * print DEAD_ZONE_UNTIL / PLATEAU_CHANCE anywhere in player-facing copy; that
 * rule holds for every exclusive spin in the bot.
 *
 * Art handling: her card art is an animated GIF (data/characters.json), so
 * replyOverArt() below is Tyla & Alya's — try ctx.replyGif, fall back to
 * ctx.replyImage, fall back to plain text. ctx.replyImage's static
 * { image: { url } } shape renders a .gif as one still frame, which is why the
 * replyGif branch has to come first. Shown on the win message and on a player's
 * very first-ever spin attempt as a one-time preview; every other losing spin
 * after that is text-only.
 */
import { config } from '../config.js'
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
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'minna'
const SPIN_FIELD = 'minnaSpins'
const COST_PER_SPIN = 0.7      // 💎 Gems — fractional, hence roundGems() below
const DEAD_ZONE_UNTIL = 170    // spins 1-170: 0%
const PLATEAU_CHANCE = 0.80    // spin 171+: flat 80%, sustained (no pity spike)
const PITY_AT = 9999           // set far past MAX_SPINS so the guaranteed-win
                               // branch in chanceForExclusiveSpin() never
                               // fires — flat 80% holds all the way to 200.
const MAX_SPINS_PER_PLAYER = 200 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'She weighs what you have against what you need, and finds them equal.',
  'Nothing moves. Nothing evens out.',
  'You offered. There was no one on the other side of it.',
  'The space between you two stays exactly as wide as it was.',
  'She waits for you to be emptier than this.',
  'An even trade of nothing for nothing.',
]

function missLine(spin) {
  return `🕳️ _${MISS_LINES[spin % MISS_LINES.length]}_`
}

/** Progress toward the spin cap — never reveals the plateau. */
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
    if (typeof ctx.replyGif === 'function') {
      return await ctx.replyGif(character.image, text)
    }
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'minna-spin',
  aliases: ['minnaspin', 'mi-spin', 'hollow-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Minna — 0.7 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Minna isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this
    // command mutates their spin count? Read once, up front — used only to
    // decide whether to show the art on an otherwise-text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `🕳️ *${character.name} is already yours.*\n${RULE}\n_The exchange has been made. There is nothing left to spin for._`
        : `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone else traded for her first. No gems were spent.`)
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
      let gems = roundGems(player.wallet?.gems ?? 0)

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
        `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} was traded away in the same moment you reached for her._\n\nAnother player got there first. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs 💎*${COST_PER_SPIN}*. You hold 💎*${fmtGems(outcome.gems)}*.\n\n` +
        `_An exchange needs something on both sides. Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🕳️ *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. Every one of them was an even trade of nothing for nothing._`,
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
        `🕳️✨ *THE EXCHANGE IS MADE* ✨🕳️\n${RULE}\n` +
        `_Spin ${last.spin}. You had almost nothing left to offer, and that turned out to be exactly the price._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🕳️'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for 💎${spent} this pull._\n\n` +
        `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
        `_Equip her with *${config.prefix}character equip ${CHARACTER_ID}*, then trade with *${config.prefix}hollowexchange* in a fight._`,
      )
    }

    const lines = [
      `🕳️ *AN EVEN TRADE OF NOTHING*`,
      RULE,
      `_You spent 💎${spent}. Nothing evened out._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${MAX_SPINS_PER_PLAYER}`,
      `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*`,
    ]

    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command — run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // Art preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive
    // spin's plain ctx.reply() on loss).
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
