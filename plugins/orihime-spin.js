/**
 * <prefix>orihime-spin <amount>
 *
 * Orihime Inoue's global-exclusive spin: the Guardian of the Innocent event
 * banner. Same one-of-one lock as every other exclusive (getExclusiveSpinWinner
 * / claimExclusiveSpinForPlayer in lib/season-engine.js, claimed inside the
 * updatePlayer write queue), but it is gated on the EVENT, not on a season:
 * the banner is only open while Guardian of the Innocent is running.
 *
 * Priced in ☀️ Solars like plugins/xiao-spin.js (whole integers, no gem math).
 *
 *   3,000 Solars per spin, 250 spins lifetime.
 *   spins 1-230   -> 0%   (DEAD_ZONE_UNTIL, she cannot be won at all)
 *   spin 231      -> 100% (PITY_AT, the first live spin is a guaranteed win)
 *
 * So the whole run to her is 231 × 3,000 = 693,000 Solars. The per-command cap
 * is 50 so the climb is five commands, not forty-six. As with every exclusive,
 * the dead-zone numbers are never printed in player-facing copy: only the pity
 * bar (progress toward the 250 cap) is.
 */
import { config } from '../config.js'
import {
  chanceForExclusiveSpin,
  getExclusiveSpinWinner,
  claimExclusiveSpinForPlayer,
  addOwnedSeasonContent,
} from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'
import { isGuardianActive } from '../lib/guardian-event.js'

export const CHARACTER_ID = 'orihime'
export const SPIN_FIELD = 'orihimeSpins'
export const COST_PER_SPIN = 3000     // ☀️ Solars
export const DEAD_ZONE_UNTIL = 230    // spins 1-230: 0%
export const PLATEAU_CHANCE = 1.0     // spin 231+: certain
export const PITY_AT = 231            // the first live spin is a guaranteed win
export const MAX_SPINS_PER_PLAYER = 250
export const MAX_SPINS_PER_COMMAND = 50

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const sol = (n) => `☀️*${Math.floor(n).toLocaleString()}*`

const MISS_LINES = [
  'A hairclip glints. Six small lights turn toward you, then away.',
  'She is busy mending someone else. She did not see you yet.',
  'Soft orange light brushes past you and settles on nothing.',
  'Somewhere a wound closes that was never yours.',
  'She smiles at you like an old friend. She does not come.',
  'The flowers hum, undecided.',
]
const missLine = (spin) => `🌸 _${MISS_LINES[spin % MISS_LINES.length]}_`

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

async function replyOverArt(ctx, character, text) {
  if (!character?.image || typeof ctx.replyImage !== 'function') return ctx.reply(text)
  try {
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

/** Pure roll for one spin number: exported for tests. */
export function orihimeSpinWins(spin, rng = Math.random) {
  if (spin >= PITY_AT) return true
  const chance = chanceForExclusiveSpin(spin, { deadZoneUntil: DEAD_ZONE_UNTIL, plateauChance: PLATEAU_CHANCE, pityAt: PITY_AT })
  return rng() < chance
}

export default {
  name: 'orihime-spin',
  aliases: ['orihimespin', 'ori-spin', 'inoue-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Orihime Inoue: 3,000 Solars per spin, Guardian of the Innocent event, one winner bot-wide',

  async run(ctx) {
    if (spinLockGate(ctx, CHARACTER_ID, 'Orihime')) return
    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Orihime isn't configured yet.`)

    if (!isGuardianActive(ctx.db)) {
      return replyOverArt(ctx, character,
        `🌸 *The banner is closed.*\n${RULE}\n` +
        `_Orihime only answers while *Guardian of the Innocent* is running._\n` +
        `Check *${p}guardian* for the event.`)
    }

    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0
    const requested = Math.floor(Number(ctx.args?.[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      return replyOverArt(ctx, character, existingWinner === ctx.from
        ? `🌸 *Orihime is already beside you.*\n${RULE}\n_She is not going anywhere. There is nothing left to spin for._`
        : `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her. No solars were spent.`)
    }

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) { outcome = { reason: 'claimed' }; return }
      player.wallet = player.wallet ?? {}

      const results = []
      let won = false
      let spinsUsed = 0
      let solars = Math.floor(player.wallet.solars ?? 0)

      for (let i = 0; i < spinCount; i++) {
        if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) break
        if (solars < COST_PER_SPIN) break
        if ((player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER) break

        const nextSpin = (player[SPIN_FIELD] ?? 0) + 1
        const thisWon = orihimeSpinWins(nextSpin)

        solars -= COST_PER_SPIN
        player.wallet.solars = solars
        player[SPIN_FIELD] = nextSpin
        spinsUsed++
        results.push({ spin: nextSpin, won: thisWon })

        if (thisWon) {
          if (claimExclusiveSpinForPlayer(ctx.db, CHARACTER_ID, ctx.from)) {
            addOwnedSeasonContent(player, 'character', character.id)
            won = true
          }
          break
        }
      }

      if (!results.length) {
        outcome = { reason: (player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER ? 'exhausted_lifetime' : 'solars', solars }
        return
      }
      outcome = { reason: won ? 'won' : 'exhausted', results, spinsUsed, remaining: player.wallet.solars }
    })

    if (outcome?.reason === 'claimed') {
      return replyOverArt(ctx, character,
        `🔒 *ALREADY TAKEN*\n${RULE}\n_${character.name} was taken in the same moment you reached for her._\n\nNo solars were spent.`)
    }
    if (outcome?.reason === 'solars') {
      return ctx.reply(
        `☀️ *Not enough Solars.*\n${RULE}\n` +
        `One spin costs ${sol(COST_PER_SPIN)}. You hold ${sol(outcome.solars)}.\n\n` +
        `_Rescues pay Solars. Try *${p}rescue*._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(`🌸 *No spins left.*\n${RULE}\n_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}._`)
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = outcome.spinsUsed * COST_PER_SPIN
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `🌸✨ *I REJECT IT* ✨🌸\n${RULE}\n` +
        `_Spin ${last.spin}. Six lights leave her hairclips and fold around you, and every hurt you are carrying simply stops having happened._\n\n` +
        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🌸'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ${sol(spent)} this pull._\n\n` +
        `☀️ Remaining: ${sol(outcome.remaining)}\n\n` +
        `_Equip her with *${p}character equip ${CHARACTER_ID}*. Shun Shun Rikka works on its own._`,
      )
    }

    const lines = [
      `🌸 *THE FLOWERS PASS YOU BY*`,
      RULE,
      `_You spent ${sol(spent)}._`,
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
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command, run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Solars ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }
    const text = lines.join('\n')
    return isFirstEverAttempt ? replyOverArt(ctx, character, text) : ctx.reply(text)
  },
}
