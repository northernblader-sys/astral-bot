/**
 * <prefix>shunya-spin <amount>
 *
 * Shunya's globally-exclusive spin — structurally the Minna/Yoriichi pattern
 * (same one-winner lock via getExclusiveSpinWinner()/claimExclusiveSpinForPlayer()
 * in lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her.
 *
 * The one structural difference from every other exclusive spin: this one is
 * paid in ☀️ SOLARS, not 💎 Gems. Solars are whole numbers (see plugins/admin.js
 * giveCurrency), so there's no roundGems()/fmtGems() here — amounts are integers
 * shown with .toLocaleString(), the same way admin.js prints a solars grant.
 *
 * Odds curve (via chanceForExclusiveSpin, the same helper every exclusive spin
 * uses, just different overrides):
 *   spins 1-150  -> 0%    (DEAD_ZONE_UNTIL = 150, a true dead zone — she cannot
 *                           be won at all before spin 151)
 *   spin 151+    -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance, sustained
 *                           all the way to the MAX_SPINS cap. Deliberately NOT a
 *                           pity-guarantee curve: PITY_AT is set far past the real
 *                           max spin count (200) so the `spin >= pityAt`
 *                           guaranteed-win branch in chanceForExclusiveSpin()
 *                           never fires, and spin 200 stays a flat 80% roll
 *                           exactly like spin 151. There is no hard guarantee.)
 *
 * 1500 Solars per spin, 200 spins lifetime. The dead zone runs to 150 and the
 * per-command cap is 5, so a player needs 30 commands before their first live
 * roll — reaching spin 151 costs 226,500 Solars, and the 200 cap is 300,000.
 * That is intended; the pity bar is what tells them how far along they are.
 * These numbers are never shown in any display text — only the pity bar
 * (progress toward the spin cap) is. Do not print DEAD_ZONE_UNTIL /
 * PLATEAU_CHANCE anywhere in player-facing copy; that rule holds for every
 * exclusive spin in the bot.
 *
 * Art handling: her card art is a static JPG (data/characters.json), so
 * replyOverArt() below is Yoriichi's/Mei's — try ctx.replyImage, fall back to
 * plain text. Shown on the win message and on a player's very first-ever spin
 * attempt as a one-time preview; every other losing spin after that is
 * text-only, matching the other exclusive spins.
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
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'shunya'
const SPIN_FIELD = 'shunyaSpins'
const COST_PER_SPIN = 1500     // ☀️ Solars — whole numbers, no rounding
const DEAD_ZONE_UNTIL = 150    // spins 1-150: 0%
const PLATEAU_CHANCE = 0.80    // spin 151+: flat 80%, sustained (no pity spike)
const PITY_AT = 9999           // set far past MAX_SPINS so the guaranteed-win
                               // branch in chanceForExclusiveSpin() never
                               // fires — flat 80% holds all the way to 200.
const MAX_SPINS_PER_PLAYER = 200 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The offering falls into the void and makes no sound.',
  'You reach into the emptiness. The emptiness reaches back with nothing.',
  'Zero answers zero. The vessel stays empty.',
  'Something should have happened. Nothing did — and that is the point.',
  'The void weighs what you spent, finds it equal to nothing, and keeps it.',
  'No curse, no blessing, no answer. Only the space where she isn\'t yet.',
]

function missLine(spin) {
  return `⭕ _${MISS_LINES[spin % MISS_LINES.length]}_`
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
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'shunya-spin',
  aliases: ['shunyaspin', 'sh-spin', 'void-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Shunya — 1500 Solars per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Shunya isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this command
    // mutates their spin count? Read once, up front — used only to decide
    // whether to show the art on an otherwise-text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `⭕ *${character.name} is already yours.*\n${RULE}\n_The void has settled on you and no one else. There is nothing left to spin for._`
        : `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone reached the void first. No Solars were spent.`)
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      ensurePlayerSeasonState(player, season.id)

      // Re-check inside the write-serialized mutator — this is the actual
      // race-safe check; the one above is just a cheap pre-check.
      if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) {
        outcome = { reason: 'claimed' }
        return
      }

      const results = []
      let won = false
      let spinsUsed = 0
      player.wallet = player.wallet ?? {}
      let solars = player.wallet.solars ?? 0

      for (let i = 0; i < spinCount; i++) {
        if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) break
        if (solars < COST_PER_SPIN) break
        if ((player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER) break

        const nextSpin = (player[SPIN_FIELD] ?? 0) + 1
        const chance = chanceForExclusiveSpin(nextSpin, { deadZoneUntil: DEAD_ZONE_UNTIL, plateauChance: PLATEAU_CHANCE, pityAt: PITY_AT })
        const thisWon = nextSpin >= PITY_AT || Math.random() < chance

        solars -= COST_PER_SPIN
        player.wallet.solars = solars
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
        outcome = { reason: (player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER ? 'exhausted_lifetime' : 'solars', solars, cost: COST_PER_SPIN }
        return
      }

      outcome = {
        reason: won ? 'won' : 'exhausted',
        results,
        spinsUsed,
        remaining: player.wallet.solars,
      }
    })

    if (outcome?.reason === 'claimed') {
      return replyOverArt(ctx, character,
        `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} settled into another player in the same moment you reached for her._\n\nAnother player got there first. No Solars were spent.`)
    }
    if (outcome?.reason === 'solars') {
      return ctx.reply(
        `☀️ *Not enough Solars.*\n${RULE}\n` +
        `One spin costs ☀️*${COST_PER_SPIN.toLocaleString()}*. You hold ☀️*${outcome.solars.toLocaleString()}*.\n\n` +
        `_The void takes only Solars. Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `⭕ *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. Every one of them fell into the same emptiness._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = (outcome.spinsUsed * COST_PER_SPIN).toLocaleString()
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `⭕✨ *THE VESSEL IS EMPTY ENOUGH* ✨⭕\n${RULE}\n` +
        `_Spin ${last.spin}. The void looks back and, for once, recognizes one of its own._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '⭕'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ☀️${spent} this pull._\n\n` +
        `☀️ Remaining: ☀️*${outcome.remaining.toLocaleString()}*\n\n` +
        `_Equip her with *${config.prefix}character equip ${CHARACTER_ID}* — every curse, hex and debuff slides off, and in a duel they rebound onto the caster._`,
      )
    }

    const lines = [
      `⭕ *NOTHING TAKES ROOT*`,
      RULE,
      `_You spent ☀️${spent}. The void kept all of it and gave nothing back._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${MAX_SPINS_PER_PLAYER}`,
      `☀️ Remaining: ☀️*${outcome.remaining.toLocaleString()}*`,
    ]

    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command — run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Solars ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // Art preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive spin).
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
