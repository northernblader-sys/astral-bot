/**
 * <prefix>naruto <amount>
 *
 * Naruto Uzumaki (Baryon Mode) spin. Same shared odds curve as the other gem
 * spins (chanceForExclusiveSpin), the same batch reel and pity bar, paid in
 * GEMS. Three numbers set by design:
 *
 *   COST_PER_SPIN     = 1     one gem per spin, flat and whole. No roundGems
 *                             drift to worry about, but we still route through
 *                             roundGems so a legacy fractional wallet stays honest.
 *   DEAD_ZONE_UNTIL   = 240   spins 1-240 are a true 0% dead zone. He cannot be
 *                             won at all before spin 241.
 *   MAX_SPINS_PER_PLAYER = 300 hard lifetime cap.
 *
 * So the first live roll lands on spin 241 (240 gems paid to get there) and the
 * whole run costs 300 gems if it goes the distance. The live window is spins
 * 241-300, sixty rolls at a flat 80% each.
 *
 * Odds curve (chanceForExclusiveSpin, with overrides):
 *   spins 1-240 -> 0%    DEAD_ZONE_UNTIL. A pure wall, nothing lands.
 *   spin 241+   -> 80%   PLATEAU_CHANCE, flat per-spin to the cap. Sixty live
 *                        rolls at 80% makes reaching spin 241 a near-certain win
 *                        before the cap (P(miss all 60) is far below one in a
 *                        billion), so no one who pays the wall walks away empty.
 *                        PITY_AT sits far past the cap, so the guaranteed-win
 *                        branch inside chanceForExclusiveSpin() never fires and
 *                        every live spin is the same honest 80% roll.
 *
 * None of DEAD_ZONE_UNTIL / PLATEAU_CHANCE / the gem totals are ever printed in
 * player facing copy. Only the pity bar (progress toward the cap) is. That rule
 * holds for every spin in the bot.
 *
 * NOT one-of-one and no season requirement: like Yato and Red Rose, anyone who
 * clears the dead zone gets their own copy. He is ALSO buyable outright with
 * Monds (🪙5), which spinOnly:true in data/characters.json enables for free
 * (see isMondBuyable in lib/monds.js) — the spin is the gem route, the Mond buy
 * is the guaranteed one.
 */
import { config } from '../config.js'
import { chanceForExclusiveSpin } from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'naruto'
const SPIN_FIELD = 'narutoSpins'
const COST_PER_SPIN = 1          // gems, one whole gem per spin
const DEAD_ZONE_UNTIL = 240      // spins 1-240: 0%
const PLATEAU_CHANCE = 0.80      // spin 241+: flat 80%, sustained, no pity spike
const PITY_AT = 9999             // far past MAX_SPINS, so the guaranteed-win branch
                                 // in chanceForExclusiveSpin() can never fire
const MAX_SPINS_PER_PLAYER = 300 // hard lifetime cap
// 20 per command, matching the other gem spins. A 240 spin dead zone is 12 pulls
// of 20 before a player's first live roll; 20 still fits the reel (rows of 10)
// and stops one giant pull becoming a wall of text.
const MAX_SPINS_PER_COMMAND = 20

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The seal holds fast. Nothing stirs behind it.',
  'A flicker of orange chakra, then the wind takes it.',
  'The cage is quiet. The fox does not even look up.',
  'You reach for the ninth tail and come back with empty hands.',
  'A leaf drifts past on the wind and keeps going.',
  'A shadow clone pops in a puff of smoke. It was never him.',
]

function missLine(spin) {
  return `🍥 _${MISS_LINES[spin % MISS_LINES.length]}_`
}

/** Progress toward the spin cap. Never reveals the plateau. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / MAX_SPINS_PER_PLAYER) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

function reel(results) {
  const MAX_ROWS = 5
  const marks = results.map(r => (r.won ? '🦊' : '·'))
  const rows = []
  for (let i = 0; i < marks.length; i += 10) rows.push(marks.slice(i, i + 10).join(' '))
  if (rows.length <= MAX_ROWS) return rows.join('\n')
  return [`_…${(rows.length - MAX_ROWS) * 10} earlier spins_`, ...rows.slice(-MAX_ROWS)].join('\n')
}

async function replyOverArt(ctx, character, text) {
  const art = character?.spinImage || character?.image
  if (!art) return ctx.reply(text)
  try {
    return await ctx.replyImage(art, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'naruto-spin',
  aliases: ['naruto', 'narutospin', 'uzumaki', 'baryonspin', 'baryon-spin'],
  category: 'character',
  requiresPlayer: true,
  description: 'Spin for Naruto Uzumaki (Baryon Mode) at 1 gem per spin, or buy him outright for 5 monds',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Naruto isn't configured yet.`)

    if ((ctx.player.ownedCharacters ?? []).includes(CHARACTER_ID)) {
      return replyOverArt(ctx, character,
        `🦊 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*, then in any fight summon the Nine Tails once with *${p}kurama*._`)
    }

    // First ever attempt, read before this command mutates the spin count. Only
    // decides whether a losing reply carries the art as a one time preview.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      // Re-checked inside the write-serialized mutator. The checks above are
      // cheap pre-checks; these are the race-safe ones.
      player.ownedCharacters = player.ownedCharacters ?? []
      if (player.ownedCharacters.includes(CHARACTER_ID)) {
        outcome = { reason: 'owned' }
        return
      }

      player.wallet = player.wallet ?? {}
      let gems = roundGems(player.wallet.gems ?? 0)
      const results = []
      let won = false
      let spinsUsed = 0

      for (let i = 0; i < spinCount; i++) {
        if (gems < COST_PER_SPIN) break
        if ((player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER) break

        const nextSpin = (player[SPIN_FIELD] ?? 0) + 1
        const chance = chanceForExclusiveSpin(nextSpin, {
          deadZoneUntil: DEAD_ZONE_UNTIL,
          plateauChance: PLATEAU_CHANCE,
          pityAt: PITY_AT,
        })
        const thisWon = nextSpin >= PITY_AT || Math.random() < chance

        gems = roundGems(gems - COST_PER_SPIN)
        player.wallet.gems = gems
        player[SPIN_FIELD] = nextSpin
        spinsUsed++
        results.push({ spin: nextSpin, won: thisWon })

        if (thisWon) {
          player.ownedCharacters.push(CHARACTER_ID)
          won = true
          break
        }
      }

      if (!results.length) {
        outcome = {
          reason: (player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER ? 'exhausted_lifetime' : 'gems',
          gems,
        }
        return
      }

      outcome = {
        reason: won ? 'won' : 'exhausted',
        results,
        spinsUsed,
        remaining: player.wallet.gems,
      }
    })

    if (outcome?.reason === 'owned') {
      return replyOverArt(ctx, character,
        `🦊 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*._`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs 💎*${fmtGems(COST_PER_SPIN)}*. You hold 💎*${fmtGems(outcome.gems)}*.\n\n` +
        `_Come back with more, or buy him outright with 🪙*5* via *${p}character buy ${CHARACTER_ID}*._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🍥 *No spins left.*\n${RULE}\n` +
        `_You have used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. ` +
        `The fox never once answered._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = roundGems(outcome.spinsUsed * COST_PER_SPIN)
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `🦊🌀 *THE NINE TAILS ANSWERS* 🌀🦊\n${RULE}\n` +
        `_Spin ${last.spin}. Orange chakra floods the seal, the cage swings open, ` +
        `and for the first time the fox and the boy look the same way at once._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🦊'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n_Taken on spin ${last.spin}, for 💎${fmtGems(spent)} this pull._\n` +
        `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
        `*How to use him:*\n` +
        `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
        `2️⃣ In any fight, dungeon or duel, summon the Nine Tails with *${p}kurama* (once per battle, no MP)\n` +
        `3️⃣ Baryon Mode burns his own lifespan to land one overwhelming strike, and whatever it touches has its lifespan torn away on top of the hit.`,
      )
    }

    const lines = [
      `🍥 *THE SEAL STAYS SHUT*`,
      RULE,
      `_You spent 💎${fmtGems(spent)}. The fox has not answered yet._`,
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
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command. Run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // Art preview only on a player's very first ever spin attempt. Every losing
    // spin after that is text only, matching the other spins.
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
