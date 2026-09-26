/**
 * <prefix>xiao-spin <amount>
 *
 * Xiao's global-exclusive spin command — structurally identical to
 * plugins/circe-spin.js and plugins/anastasia-spin.js (same global-lock pattern
 * via getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her.
 *
 * SHE IS THE FIRST SOLARS-PRICED SPIN IN THE BOT. Every other exclusive spin
 * charges Gems; this one charges ☀️ Solars (data/currency.json), which is why
 * there is no roundGems()/fmtGems() anywhere below — solars are whole integers,
 * so they are formatted with .toLocaleString() and a ☀️, the same way
 * lib/auction.js does. Do not "fix" this back to the gem helpers.
 *
 * Odds curve (via chanceForExclusiveSpin, the same helper yo-spin.js /
 * ni-spin.js / tyla-alya-spin.js / anastasia-spin.js / circe-spin.js use, just
 * different overrides):
 *   spins 1-70   -> 0%    (DEAD_ZONE_UNTIL = 70, a true dead zone — she cannot
 *                           be won at all before spin 71)
 *   spin 71+     -> 30%   (PLATEAU_CHANCE = 0.3, flat per-spin chance,
 *                           sustained all the way to the MAX_SPINS cap.
 *                           Deliberately NOT a pity-guarantee curve: PITY_AT is
 *                           set far past the real max spin count (100) so the
 *                           `spin >= pityAt` guaranteed-win branch in
 *                           chanceForExclusiveSpin() never fires, and spin 100
 *                           stays a flat 30% roll exactly like spin 71.)
 *
 * 1,000 Solars per spin, 100 spins lifetime — so the full run is 100,000
 * Solars. Because the dead zone runs to 70 and the per-command cap is 5, a
 * player needs 14 commands before their first live roll; that is intended, and
 * the pity bar is what tells them how far along they are. These numbers are
 * never shown in any display text — only the pity bar (progress toward the spin
 * cap) is. Do not print DEAD_ZONE_UNTIL / PLATEAU_CHANCE anywhere in
 * player-facing copy; that rule holds for every exclusive spin in the bot.
 *
 * Art handling: her card art is a static .jpg (data/characters.json), NOT an
 * animated GIF like Circe's or Anastasia's, so replyOverArt() below goes
 * straight to ctx.replyImage — there is no ctx.replyGif branch to make here.
 * Shown on the win message and on a player's very first-ever spin attempt as a
 * one-time preview; every other losing spin after that is text-only.
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

const CHARACTER_ID = 'xiao'
const SPIN_FIELD = 'xiaoSpins'
const COST_PER_SPIN = 1000    // ☀️ Solars, not Gems — see the doc comment above
const DEAD_ZONE_UNTIL = 70    // spins 1-70: 0%
const PLATEAU_CHANCE = 0.30   // spin 71+: flat 30%, sustained (no pity spike)
const PITY_AT = 9999          // set far past MAX_SPINS so the guaranteed-win
                              // branch in chanceForExclusiveSpin() never
                              // fires — flat 30% holds all the way to 100.
const MAX_SPINS_PER_PLAYER = 100 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

/** Solars are whole numbers — no fractional formatting, unlike gems. */
const sol = (n) => `☀️*${Math.floor(n).toLocaleString()}*`

const MISS_LINES = [
  'She looks straight at you, and takes nothing.',
  'Something of yours is missing. You will notice which one later.',
  'She was watching. She just was not interested.',
  'You feel studied, and then dismissed.',
  'A hand closes on empty air. Hers, or yours — hard to say.',
  'Whatever she came for, it was not you.',
]

function missLine(spin) {
  return `👁️ _${MISS_LINES[spin % MISS_LINES.length]}_`
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
    // Static .jpg — ctx.replyImage is correct here. No replyGif branch, unlike
    // circe-spin.js / anastasia-spin.js whose art is animated.
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'xiao-spin',
  aliases: ['xiaospin', 'xi-spin', 'thief-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Xiao — 1,000 Solars per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Xiao isn't configured yet.`)

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
        ? `👁️ *${character.name} already watches for you.*\n${RULE}\n_She has what she wants. There is nothing left to spin for._`
        : `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone else got their hands on her first. No solars were spent.`)
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
      let solars = Math.floor(player.wallet?.solars ?? 0)

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
        `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} was taken in the same moment you reached for her._\n\nAnother player got there first. No solars were spent.`)
    }
    if (outcome?.reason === 'solars') {
      return ctx.reply(
        `☀️ *Not enough Solars.*\n${RULE}\n` +
        `One spin costs ${sol(COST_PER_SPIN)}. You hold ${sol(outcome.solars)}.\n\n` +
        `_She does not work on credit. Come back heavier._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `👁️ *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. She watched every one of them and never once reached back._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = outcome.spinsUsed * COST_PER_SPIN
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `👁️🗝️ *SHE LOOKS UP* 🗝️👁️\n${RULE}\n` +
        `_Spin ${last.spin}. She has been watching the whole time — and this is the moment she decides you are worth following._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '👁️'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ${sol(spent)} this pull._\n\n` +
        `☀️ Remaining: ${sol(outcome.remaining)}\n\n` +
        `_Equip her with *${config.prefix}character equip ${CHARACTER_ID}*, then steal with *${config.prefix}thiefseye* in a fight._`,
      )
    }

    const lines = [
      `👁️ *NOTHING CHANGED HANDS*`,
      RULE,
      `_You spent ${sol(spent)}. She did not move._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${MAX_SPINS_PER_PLAYER}`,
      `☀️ Remaining: ${sol(outcome.remaining)}`,
    ]

    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command — run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Solars ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // Art preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive
    // spin's plain ctx.reply() on loss).
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
