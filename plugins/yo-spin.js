/**
 * <prefix>yo-spin <amount>
 *
 * Yoriichi's global-exclusive spin command — structurally identical to
 * plugins/ni-spin.js (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her — this replaces the earlier 200-copy
 * finite-stock model.
 *
 * Odds curve (via chanceForExclusiveSpin, same helper ni-spin.js uses, just
 * different overrides):
 *   spins 1-120   -> 0%    (DEAD_ZONE_UNTIL = 120, true dead zone, no one
 *                            can win her yet)
 *   spins 121-159 -> 50%   (PLATEAU_CHANCE = 0.5, flat per-spin chance)
 *   spin 160+     -> guaranteed (PITY_AT = 160)
 * These numbers are never shown in any display text — only the pity bar
 * (progress toward spin 160) is shown, same as ni-spin.js's "never reveals
 * the plateau" pattern. Do not print DEAD_ZONE_UNTIL/PLATEAU_CHANCE/PITY_AT
 * anywhere in player-facing copy.
 *
 * 0.5 Gems per spin (unchanged from the old stock model).
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

const CHARACTER_ID = 'yoriichi'
const SPIN_FIELD = 'yoriichiSpins'
const COST_PER_SPIN = 0.5
const DEAD_ZONE_UNTIL = 120  // spins 1-120: 0%
const PLATEAU_CHANCE = 0.50  // spins 121-159: flat 50%
const PITY_AT = 160          // spin 160: guaranteed
const MAX_SPINS_PER_COMMAND = 5 // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'A cat\'s shadow flicks across the wall, and vanishes.',
  'Somewhere close, claws retract. Not this time.',
  'A low purr, then silence. She does not step forward.',
  'The offering goes unanswered. Something watches, unmoved.',
  'A pair of eyes opens in the dark, and closes again.',
  'The bond does not open. She is still out there, waiting.',
]

function missLine(spin) {
  return `🐈‍⬛ ${MISS_LINES[spin % MISS_LINES.length]}`
}

/** Progress toward the spin-160 guarantee — never reveals the plateau. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / PITY_AT) * width)))
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
  name: 'yo-spin',
  aliases: ['yospin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Yoriichi — 0.5 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Yoriichi isn't configured yet.`)

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, PITY_AT, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `🐈‍⬛ *${character.name} is already yours.*\n${RULE}\n_She's bonded to you, and no one else. There is nothing left to spin for._`
        : `🔒 *THE BOND IS SEALED*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone reached her first. No gems were spent.`)
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
            player.yoriichiExp = player.yoriichiExp ?? 0
            won = true
          }
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
      return replyOverArt(ctx, character,
        `🔒 *THE BOND IS SEALED*\n${RULE}\n_${character.name} was claimed while you reached for her._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_She only answers gems. Come back with more._`,
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
        `🐈‍⬛✨ *SHE ANSWERS.* ✨🐈‍⬛\n${RULE}\n` +
        `_Spin ${last.spin}. Eyes open in the dark — and ${character.name} steps through._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🐈‍⬛'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip her with *${config.prefix}character equip yoriichi*._`,
      )
    }

    const lines = [
      `🐈‍⬛ *THE CAT'S BARGAIN*`,
      RULE,
      `_You set 💎${spent} before her. She watches — for now._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${PITY_AT}`,
      `💎 Remaining: *${outcome.remaining}*`,
    ]

    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command — run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    return replyOverArt(ctx, character, lines.join('\n'))
  },
}
