/**
 * <prefix>yato-spin <amount>
 *
 * Yato's spin. Structurally the Ariel/Shunya pattern (the same shared odds
 * curve via chanceForExclusiveSpin, the same batch reel and pity bar), with
 * two deliberate differences from the Solar spins:
 *
 *   1. Paid in GEMS, at 1 gem per spin, like plugins/gojo-spin.js at 1.5 and
 *      unlike the Solar spins that charge in the thousands. With the 190 spin
 *      dead zone below, that puts a player's first live roll at 190 gems and a
 *      full run at 240, the same shape as Gojo's 160 and 300.
 *
 *   2. NOT one-of-one. Every Solar spin locks its character to a single winner
 *      bot-wide via getExclusiveSpinWinner()/claimExclusiveSpinForPlayer().
 *      This one does not, so there is no exclusive lock here and no active
 *      season requirement either: he is not season content. Anyone who clears
 *      the dead zone gets their own copy. He is still not buyable at any price
 *      (see "spinOnly" in data/characters.json and handleBuy() in
 *      plugins/character.js).
 *
 * NO FAME GATE, deliberately. He was walled behind 500,000 fame until
 * 2026-08-24, on the reasoning that his ability reads the crowd his fame brings
 * in. That was wrong about which character the fame prize was: ARIEL is what
 * went to the player who reached 500,000, handed to them directly, and Yato was
 * never the reward for it. He is a spin character like any other. Do not re-add
 * the wall.
 *
 * Low fame makes him a weak pick rather than a broken one, and that is left to
 * sort itself out instead of being gated: Live Blast scales off viewers,
 * viewers scale off fame (calcMaxViewers = fame * 0.02 in plugins/stream.js),
 * and `.stream start` already refuses below 1,000 fame. A low fame owner gets a
 * small crowd and a small blast, which is the honest outcome.
 *
 * Odds curve (chanceForExclusiveSpin, with overrides):
 *   spins 1-190  -> 0%    DEAD_ZONE_UNTIL = 190, a true dead zone. He cannot
 *                         be won at all before spin 191.
 *   spin 191+    -> 80%   PLATEAU_CHANCE, flat per-spin, sustained all the way
 *                         to the MAX_SPINS cap. PITY_AT sits far past the 240
 *                         cap so the guaranteed-win branch inside
 *                         chanceForExclusiveSpin() never fires: spin 240 is
 *                         the same flat roll as spin 191, and there is no hard
 *                         guarantee anywhere on the curve.
 *
 * 240 spins lifetime, so the first live roll costs 190 gems and the whole run
 * costs 240. None of those numbers are ever printed in player facing copy.
 * Only the pity bar (progress toward the cap) is. That rule holds for every
 * spin in the bot: never reveal DEAD_ZONE_UNTIL or PLATEAU_CHANCE.
 *
 * Replaces the old one-command `.yato` fame claim (plugins/yato-claim.js, now
 * deleted). Its aliases live here, so `.yato` still answers.
 */
import { config } from '../config.js'
import { chanceForExclusiveSpin } from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'yato'
const SPIN_FIELD = 'yatoSpins'
const COST_PER_SPIN = 1         // gems, matching the other gem spin (gojo-spin.js at 1.5)
const DEAD_ZONE_UNTIL = 190     // spins 1-190: 0%
const PLATEAU_CHANCE = 0.80     // spin 191+: flat 80%, sustained, no pity spike
const PITY_AT = 9999            // far past MAX_SPINS, so the guaranteed-win branch
                                // in chanceForExclusiveSpin() can never fire
const MAX_SPINS_PER_PLAYER = 240 // hard lifetime cap
// 20 rather than the 5 every Solar spin uses. A 190 spin dead zone at 5 per
// command would be 38 commands before a player's first live roll, which reads
// as a broken command rather than a long grind. 20 still fits the reel display
// (rows of 10, 5 rows) and still stops one giant pull becoming one wall of text.
const MAX_SPINS_PER_COMMAND = 20

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The stream goes up. Nobody joins.',
  'Dead air, and the camera still recording it.',
  'Chat scrolls past without one name in it you know.',
  'Zero watching. The boy shrugs and keeps filming anyway.',
  'Somebody clips it. Nobody watches the clip.',
  'The signal holds fine. The audience never arrives.',
]

function missLine(spin) {
  return `📺 _${MISS_LINES[spin % MISS_LINES.length]}_`
}

/** Progress toward the spin cap. Never reveals the plateau. */
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
  if (!character?.image) return ctx.reply(text)
  try {
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'yato-spin',
  // The old claim command's names are kept so `.yato` still answers.
  aliases: ['yato', 'yatospin', 'ya-spin', 'stream-spin', 'yato-claim', 'yatoclaim', 'claimyato'],
  category: 'character',
  requiresPlayer: true,
  description: 'Spin for Yato at 1 gem per spin. Never for sale',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Yato isn't configured yet.`)

    if ((ctx.player.ownedCharacters ?? []).includes(CHARACTER_ID)) {
      return replyOverArt(ctx, character,
        `📺 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*, go live inside a dungeon with ` +
        `*${p}stream start*, let the crowd build, then fire *${p}live-blast*._`)
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
        `📺 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*._`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs 💎*${COST_PER_SPIN}*. You hold 💎*${fmtGems(outcome.gems)}*.\n\n` +
        `_Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `📺 *No spins left.*\n${RULE}\n` +
        `_You have used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. ` +
        `The camera never once turned your way._`,
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
        `📺🔴 *WE'RE LIVE* 🔴📺\n${RULE}\n` +
        `_Spin ${last.spin}. The room fills, and a boy who cannot remember being anything ` +
        `else points a camera at the dark._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '📺'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n_Taken on spin ${last.spin}, for 💎${spent} this pull._\n` +
        `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
        `*How to use him:*\n` +
        `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
        `2️⃣ Enter a dungeon where an admin has run *${p}stream on*\n` +
        `3️⃣ *${p}stream start*, then fight. The crowd grows every turn\n` +
        `4️⃣ *${p}live-blast*, once per battle, and the whole audience lands at once\n\n` +
        `💧 _*Tear of God* needs no command. Once a battle, the blow that would end him simply doesn't._`,
      )
    }

    const lines = [
      `📺 *NOBODY WATCHING*`,
      RULE,
      `_You spent 💎${spent}. The view count never moved._`,
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
