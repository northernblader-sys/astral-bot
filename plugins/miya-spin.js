/**
 * <prefix>miya-spin <amount>
 *
 * Miyashi's global-exclusive spin command — structurally identical to
 * plugins/mei-spin.js (same global-lock pattern, same batch/pity-bar
 * presentation), with two differences:
 *
 *   1. Cost is 0.8 Gems/spin (not 0.5).
 *   2. Odds follow chanceForExclusiveSpin()'s flat-plateau shape (not
 *      chanceForMajorSpin()'s linear ramp): spins 1-79 are a true 0% dead
 *      zone, spins 80-149 are a flat 80% per spin, spin 150 is a guarantee.
 *      See lib/season-engine.js's chanceForExclusiveSpin() doc comment.
 *
 * ODDS ARE NEVER SHOWN — no percentage, no mention of spin 80 or spin 150
 * being special, at any point. Unlike mei-spin.js (which reveals the real
 * percentage from spin 51 onward), this command shows only the pity bar
 * (progress toward the spin-150 guarantee) and win/no-win — the plateau
 * breakpoints stay invisible always, by design.
 *
 * Global exclusivity: same bot-wide one-winner-ever lock as Mei, via the
 * generic getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() pair in
 * lib/season-engine.js (Mei keeps her own dedicated field for backward
 * compatibility; every character after her uses the generic map).
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
import { characterMap, petMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'miyashi'
const BONUS_PET_ID = 'rime_kit' // granted free alongside the character on a win — see data/pets.json
const SPIN_FIELD = 'miyashiSpins'
const COST_PER_SPIN = 0.8
const DEAD_ZONE_UNTIL = 79   // spins 1-79: 0%
const PLATEAU_CHANCE = 0.80  // spins 80-149: flat 80%
const PITY_AT = 150          // spin 150: guaranteed
const MAX_SPINS_PER_COMMAND = 5 // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The frost creeps across the glass and fades. Nothing answers.',
  'A cold wind passes, and is gone.',
  'The ice holds its shape. It does not open.',
  'Something glints in the white, then is only snow.',
  'The air sharpens, then eases. Not yet.',
  'Your breath fogs the air. The stillness does not break.',
]

function missLine(spin) {
  return `❄️ ${MISS_LINES[spin % MISS_LINES.length]}`
}

/** Progress toward the spin-150 guarantee — never reveals the plateau. */
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
  name: 'miya-spin',
  aliases: ['miyaspin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Miyashi — 0.8 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Miyashi isn't configured yet.`)

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, PITY_AT, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `❄️ *${character.name} is already yours.*\n${RULE}\n_The frost answers to you, and no one else. There is nothing left to spin for._`
        : `🔒 *THE FROST HAS SETTLED*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone reached her first. No gems were spent.`)
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

            // Bonus: winning Miyashi also grants the Rime Kit pet for free
            // (data/pets.json — price 0, seasonId-gated, not sold in the pet
            // store). addOwnedSeasonContent('pet', ...) already pushes into
            // player.pets itself (lib/season-engine.js) — no manual push needed.
            addOwnedSeasonContent(player, 'pet', BONUS_PET_ID)

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
        `🔒 *THE FROST HAS SETTLED*\n${RULE}\n_${character.name} was claimed while you reached for her._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_The frost takes only gems. Come back with more._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = (outcome.spinsUsed * COST_PER_SPIN).toFixed(1).replace(/\.0$/, '')
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      const bonusPet = petMap[BONUS_PET_ID]
      return replyOverArt(ctx, character,
        `❄️✨ *SHE ANSWERS.* ✨❄️\n${RULE}\n` +
        `_Spin ${last.spin}. The frost parts — and ${character.name} steps through._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '❄️'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        (bonusPet
          ? `\n${bonusPet.emoji} *${bonusPet.name}* came with her — check *${config.prefix}pet* to equip it.\n`
          : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*`,
      )
    }

    const lines = [
      `❄️ *THE FROST GATE*`,
      RULE,
      `_You set 💎${spent} against the ice. It holds — for now._`,
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
