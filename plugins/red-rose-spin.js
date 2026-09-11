/**
 * <prefix>red-rose-spin <amount>
 *
 * Red Rose's spin. Same shared odds curve as the other gem spins
 * (chanceForExclusiveSpin), the same batch reel and pity bar, paid in GEMS.
 * Three numbers set by design:
 *
 *   COST_PER_SPIN     = 0.7   fractional on purpose. roundGems() keeps two
 *                             decimals, so 0.7 subtracts cleanly with no drift.
 *   DEAD_ZONE_UNTIL   = 239   spins 1-239 are a true 0% dead zone. She cannot
 *                             be won at all before spin 240.
 *   MAX_SPINS_PER_PLAYER = 250 hard lifetime cap.
 *
 * So the first live roll lands on spin 240 (239 x 0.7 = 167.3 gems paid to get
 * there) and the whole run costs 250 x 0.7 = 175 gems. That is the cheapest
 * full run of any gem spin (Yato 240, Gojo 300), which is the point: she is
 * meant to be one everyone can reach, not a whale wall. She is still NOT
 * buyable at any price (see "spinOnly" in data/characters.json).
 *
 * Odds curve (chanceForExclusiveSpin, with overrides):
 *   spins 1-239 -> 0%    DEAD_ZONE_UNTIL.
 *   spin 240+   -> 80%   PLATEAU_CHANCE, flat per-spin to the cap. With only 11
 *                        live spins in the 240-250 window, 80% flat makes
 *                        reaching spin 240 a near-certain win before the cap
 *                        (P(miss all 11) is about two in a hundred million), so
 *                        no one who pays the wall walks away empty. PITY_AT sits
 *                        far past the cap, so the guaranteed-win branch inside
 *                        chanceForExclusiveSpin() never fires and every live
 *                        spin is the same honest 80% roll.
 *
 * None of DEAD_ZONE_UNTIL / PLATEAU_CHANCE / the gem totals are ever printed in
 * player facing copy. Only the pity bar (progress toward the cap) is. That rule
 * holds for every spin in the bot.
 *
 * NOT one-of-one and no season requirement: like Yato, anyone who clears the
 * dead zone gets their own copy.
 */
import { config } from '../config.js'
import { chanceForExclusiveSpin } from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'red_rose'
const SPIN_FIELD = 'redRoseSpins'
const COST_PER_SPIN = 0.7        // gems, fractional; roundGems() keeps two decimals
const DEAD_ZONE_UNTIL = 239      // spins 1-239: 0%
const PLATEAU_CHANCE = 0.80      // spin 240+: flat 80%, sustained, no pity spike
const PITY_AT = 9999             // far past MAX_SPINS, so the guaranteed-win branch
                                 // in chanceForExclusiveSpin() can never fire
const MAX_SPINS_PER_PLAYER = 250 // hard lifetime cap
// 20 per command, matching the other gem spin. A 239 spin dead zone is ~12
// pulls of 20 before a player's first live roll; 20 still fits the reel (rows
// of 10) and stops one giant pull becoming a wall of text.
const MAX_SPINS_PER_COMMAND = 20

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The strings hang slack. Nothing on the other end of them.',
  'A doll on the shelf, and it stays a doll.',
  'She sets a place at the table. No one sits.',
  'The garden party goes quiet. Her hand closes on empty air.',
  'A curtsy to no one. The music plays on regardless.',
  'The flintlock stays holstered. There was nothing to point it at.',
]

function missLine(spin) {
  return `🎭 _${MISS_LINES[spin % MISS_LINES.length]}_`
}

/** Progress toward the spin cap. Never reveals the plateau. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / MAX_SPINS_PER_PLAYER) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

function reel(results) {
  const MAX_ROWS = 5
  const marks = results.map(r => (r.won ? '🌹' : '·'))
  const rows = []
  for (let i = 0; i < marks.length; i += 10) rows.push(marks.slice(i, i + 10).join(' '))
  if (rows.length <= MAX_ROWS) return rows.join('\n')
  return [`_…${(rows.length - MAX_ROWS) * 10} earlier spins_`, ...rows.slice(-MAX_ROWS)].join('\n')
}

async function replyOverArt(ctx, character, text) {
  // Spin card uses the static portrait (spinImage: the silver-palace jpg), not
  // the animated gif that character.image carries for her .character info card.
  // replyImage wants a still frame; the gif is for the info view's sendGif path.
  const art = character?.spinImage || character?.image
  if (!art) return ctx.reply(text)
  try {
    return await ctx.replyImage(art, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'red-rose-spin',
  aliases: ['redrose', 'red-rose', 'rose', 'rosespin', 'rrspin', 'rr-spin', 'redrosespin'],
  category: 'character',
  requiresPlayer: true,
  description: 'Spin for Red Rose at 0.7 gems per spin. Never for sale',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Red Rose isn't configured yet.`)

    if ((ctx.player.ownedCharacters ?? []).includes(CHARACTER_ID)) {
      return replyOverArt(ctx, character,
        `🌹 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip her with *${p}character equip ${CHARACTER_ID}*, then in any fight cut the strings once with *${p}puppet*._`)
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
        `🌹 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip her with *${p}character equip ${CHARACTER_ID}*._`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs 💎*${fmtGems(COST_PER_SPIN)}*. You hold 💎*${fmtGems(outcome.gems)}*.\n\n` +
        `_Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🎭 *No spins left.*\n${RULE}\n` +
        `_You have used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. ` +
        `She never once reached for your strings._`,
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
        `🌹🎀 *SHE TAKES A BOW* 🎀🌹\n${RULE}\n` +
        `_Spin ${last.spin}. She looks up from the garden party like she always knew you would come, ` +
        `and holds out one gloved hand._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🌹'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n_Taken on spin ${last.spin}, for 💎${fmtGems(spent)} this pull._\n` +
        `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
        `*How to use her:*\n` +
        `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
        `2️⃣ In any fight, dungeon or duel, cut the strings with *${p}puppet* (once per battle, no MP)\n` +
        `3️⃣ The enemy turns its own weapon on itself and hangs tangled for a turn. In a duel, their companion hangs with them.`,
      )
    }

    const lines = [
      `🎭 *THE STRINGS STAY SLACK*`,
      RULE,
      `_You spent 💎${fmtGems(spent)}. Nothing on the other end of them yet._`,
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
