/**
 * <prefix>montana-spin <amount>
 *
 * Montana's spin — Reverie's sister. Same shared odds curve every exclusive
 * spin uses (chanceForExclusiveSpin), the same batch reel and pity bar, but
 * paid in ☀️ SOLARS, not 💎 Gems. Solars are whole numbers (see plugins/admin.js
 * giveCurrency), so there is no roundGems()/fmtGems() here — amounts are
 * integers shown with .toLocaleString(), the same way admin.js prints a grant.
 *
 * Three numbers set by design:
 *   COST_PER_SPIN     = 1500  ☀️ Solars per spin.
 *   DEAD_ZONE_UNTIL   = 160   spins 1-160 are a true 0% dead zone. She cannot
 *                             be won at all before spin 161.
 *   PITY_AT           = 161   the first live spin is a GUARANTEED win. The
 *                             player pays through the dead zone (160 x 1500 =
 *                             240,000 Solars) and spin 161 hands her over, no
 *                             roll. MAX_SPINS_PER_PLAYER sits above that as a
 *                             ceiling that a normal run never reaches.
 *
 * Because PITY_AT is exactly one past DEAD_ZONE_UNTIL, PLATEAU_CHANCE is never
 * actually consulted (spin 161 hits the `spin >= pityAt` guaranteed branch
 * inside chanceForExclusiveSpin() before any plateau roll) — it is set to 1.0
 * so the intent reads clearly regardless.
 *
 * None of DEAD_ZONE_UNTIL / the solar totals are ever printed in player facing
 * copy. Only the pity bar (progress toward the cap) is. That rule holds for
 * every spin in the bot.
 *
 * Exclusive and NOT for sale at any price (see "spinOnly" in
 * data/characters.json). Not one-of-one: like Red Rose, anyone who pays through
 * the dead zone earns their own copy — so this uses the per-player ownership
 * path (ownedCharacters), NOT the single-winner season lock.
 */
import { config } from '../config.js'
import { chanceForExclusiveSpin } from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'montana'
const SPIN_FIELD = 'montanaSpins'
const COST_PER_SPIN = 1500     // ☀️ Solars — whole numbers, no rounding
const DEAD_ZONE_UNTIL = 160    // spins 1-160: 0%
const PITY_AT = 161            // spin 161: guaranteed win (first live spin)
const PLATEAU_CHANCE = 1.0     // never consulted — PITY_AT lands first; see header
const MAX_SPINS_PER_PLAYER = 250 // hard lifetime ceiling (a normal run wins at 161)
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'Nothing answers the call. The stillness is unbroken.',
  'You spend, and the moment stays exactly as slow as it was.',
  'No one steps out of the frozen air this time.',
  'The offering lands and the clock keeps its own counsel.',
  'She is not here yet. Only the waiting is.',
  'Time closes over the gap where she should have been.',
]

function missLine(spin) {
  return `🕰️ _${MISS_LINES[spin % MISS_LINES.length]}_`
}

/** Progress toward the spin cap — never reveals the plateau. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / MAX_SPINS_PER_PLAYER) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

function reel(results) {
  const MAX_ROWS = 5
  const marks = results.map(r => (r.won ? '🕰️' : '·'))
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
  name: 'montana-spin',
  aliases: ['montana', 'montanaspin', 'mont-spin', 'montspin'],
  category: 'character',
  requiresPlayer: true,
  description: 'Spin for Montana at 1500 Solars per spin. Never for sale',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Montana isn't configured yet.`)

    if ((ctx.player.ownedCharacters ?? []).includes(CHARACTER_ID)) {
      return replyOverArt(ctx, character,
        `🕰️ *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip her with *${p}character equip ${CHARACTER_ID}*. She fights on her own from there._`)
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
      let solars = player.wallet.solars ?? 0
      const results = []
      let won = false
      let spinsUsed = 0

      for (let i = 0; i < spinCount; i++) {
        if (solars < COST_PER_SPIN) break
        if ((player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER) break

        const nextSpin = (player[SPIN_FIELD] ?? 0) + 1
        const chance = chanceForExclusiveSpin(nextSpin, {
          deadZoneUntil: DEAD_ZONE_UNTIL,
          plateauChance: PLATEAU_CHANCE,
          pityAt: PITY_AT,
        })
        const thisWon = nextSpin >= PITY_AT || Math.random() < chance

        solars -= COST_PER_SPIN
        player.wallet.solars = solars
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
          reason: (player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER ? 'exhausted_lifetime' : 'solars',
          solars,
        }
        return
      }

      outcome = {
        reason: won ? 'won' : 'exhausted',
        results,
        spinsUsed,
        remaining: player.wallet.solars,
      }
    })

    if (outcome?.reason === 'owned') {
      return replyOverArt(ctx, character,
        `🕰️ *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip her with *${p}character equip ${CHARACTER_ID}*._`)
    }
    if (outcome?.reason === 'solars') {
      return ctx.reply(
        `☀️ *Not enough Solars.*\n${RULE}\n` +
        `One spin costs ☀️*${COST_PER_SPIN.toLocaleString()}*. You hold ☀️*${outcome.solars.toLocaleString()}*.\n\n` +
        `_Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🕰️ *No spins left.*\n${RULE}\n` +
        `_You have used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}._`,
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
        `🕰️✨ *SHE STEPS OUT OF THE STILLNESS* ✨🕰️\n${RULE}\n` +
        `_Spin ${last.spin}. Between one tick and the next, she is simply there, already moving._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🕰️'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n_Taken on spin ${last.spin}, for ☀️${spent} this pull._\n` +
        `☀️ Remaining: ☀️*${outcome.remaining.toLocaleString()}*\n\n` +
        `*How to use her:*\n` +
        `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
        `2️⃣ That is all. She is automatic: she hits as hard as you do, breaks you out of freeze, stun, sleep and every status the moment it lands, and when anyone stops time she moves faster than the frozen moment to strike back.`,
      )
    }

    const lines = [
      `🕰️ *THE STILLNESS STAYS EMPTY*`,
      RULE,
      `_You spent ☀️${spent}. No one stepped out of it._`,
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
