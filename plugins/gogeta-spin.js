/**
 * <prefix>gogeta-spin <amount>
 *
 * Gogeta's spin. Same shared odds curve (chanceForExclusiveSpin), batch reel
 * and pity bar as Gojo's and Yato's, but a DIFFERENT ownership model to either:
 * he is one-of-one bot-wide. The first player anywhere to land him takes the
 * lock through claimExclusiveSpinForPlayer() and the banner closes for
 * everybody, in chat and on the website alike — the same model Alexa, Circe and
 * every other `"exclusive": true` character in data/characters.json uses (see
 * plugins/alexa-spin.js for the reference implementation, and handleBuy() in
 * plugins/character.js for the buy-side refusal).
 *
 * Odds curve, caps and the pull loop itself all live in lib/spin-banners.js,
 * NOT here. The website spins the same banner through POST
 * /api/characters/gogeta/spin, and two copies of the curve would drift the
 * first time one was tuned. This file owns the copy, the art and the replies;
 * the module owns the numbers and the mutation.
 *
 * 250 spins lifetime at 1.5 gems each, with a dead zone that eats the first
 * 230 of them: 345 gems in before a first live roll, 375 gems for the whole
 * run, the longest and most expensive banner in the bot. None of those numbers
 * are ever printed in player facing copy. Only the pity bar (progress toward
 * the cap) is, the same rule every spin in the bot follows: never reveal
 * deadZoneUntil or plateauChance.
 *
 * The banner ships OPEN. spinLockGate() below is still wired, so the owner can
 * freeze it at any time with `.lockspin gogeta` and reopen it with
 * `.unlockspin gogeta`; there is simply no entry for him in
 * data/spin-locks.json to begin with, unlike Gojo's banner.
 */
import { config } from '../config.js'
import { getExclusiveSpinWinner } from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { getPlayer, updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'
import { getSpinBanner, runSpinBatch } from '../lib/spin-banners.js'

const CHARACTER_ID = 'gogeta'
const BANNER = getSpinBanner(CHARACTER_ID)

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'Two fighters raise their arms, the poses match, and nothing happens.',
  'The ki gathers, holds, and goes out.',
  'Close. The light meets, and refuses to hold a shape.',
  'One of them moved a fraction early. That is the whole difference.',
  'The air pulls in toward a point, and then thinks better of it.',
  'A flash, a shape, and then two shadows walking away separately.',
]

function missLine(spin) {
  return `🔵 _${MISS_LINES[spin % MISS_LINES.length]}_`
}

/** Progress toward the spin cap. Never reveals the plateau. */
function pityBar(spin, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((spin / BANNER.maxSpinsPerPlayer) * width)))
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

/** Display name of whoever holds the one-of-one, for the refusal copy. */
function holderName(ctx, jid) {
  try {
    return getPlayer(ctx.db, jid)?.name ?? null
  } catch {
    return null
  }
}

export default {
  name: 'gogeta-spin',
  aliases: ['gogeta', 'gogetaspin', 'gg-spin', 'fusion-spin', 'gogeta-claim'],
  category: 'character',
  requiresPlayer: true,
  description: 'Spin for Gogeta at 1.5 gems per spin. One-of-one, bot-wide, never for sale',

  async run(ctx) {
    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Gogeta isn't configured yet.`)

    // Owner spin lock. Nothing is read or spent past this until it is open.
    if (spinLockGate(ctx, CHARACTER_ID, character.name)) return

    // One-of-one pre-check, before a single gem is at risk. The authoritative
    // re-check happens inside runSpinBatch() on the serialized write queue.
    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      if (existingWinner === ctx.from) {
        return replyOverArt(ctx, character,
          `🔵 *${character.name} is already yours.*\n${RULE}\n` +
          `_He answers to you and to nobody else, and there is nothing left to spin for. ` +
          `Equip him with *${p}character equip ${CHARACTER_ID}*. Fusion of Equals arms itself at the ` +
          `opening bell, Instant Transmission needs no command, and *${p}soulpunisher* and ` +
          `*${p}kamehameha* are yours in every fight._`)
      }
      const who = holderName(ctx, existingWinner)
      return replyOverArt(ctx, character,
        `🔒 *THE FUSION IS SPOKEN FOR*\n${RULE}\n` +
        `_${character.name} has been claimed by ${who ? `*${who}*` : 'another player'}._\n\n` +
        `Only one player, bot-wide, could ever win him, and someone got there first. ` +
        `No gems were spent.`)
    }

    // First ever attempt, read before this command mutates the spin count. Only
    // decides whether a losing reply carries the art as a one time preview.
    const isFirstEverAttempt = (ctx.player[BANNER.spinField] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      outcome = runSpinBatch(ctx.db, player, BANNER, ctx.from, requested)
    })

    if (outcome?.reason === 'owned') {
      return replyOverArt(ctx, character,
        `🔵 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*._`)
    }
    if (outcome?.reason === 'claimed') {
      return replyOverArt(ctx, character,
        `🔒 *THE FUSION IS SPOKEN FOR*\n${RULE}\n` +
        `_${character.name} was claimed while you were still reaching._\n\n` +
        `Another player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs 💎*${BANNER.costPerSpin}*. You hold 💎*${fmtGems(outcome.gems)}*.\n\n` +
        `_Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🔵 *No spins left.*\n${RULE}\n` +
        `_You have used all *${BANNER.maxSpinsPerPlayer}* of your spins for ${character.name}. ` +
        `The two of them never once matched._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = roundGems(outcome.spinsUsed * BANNER.costPerSpin)
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `🔵✨ *FU... SION... HA!* ✨🔵\n${RULE}\n` +
        `_Spin ${last.spin}. Two fighters who never agreed on anything agree on this: ` +
        `the poses land together, the light closes over both of them, and what stands up is neither one._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🔵'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain him.\n` +
        `_Taken on spin ${last.spin}, for 💎${spent} this pull._\n` +
        `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
        `*How to use him:*\n` +
        `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
        `2️⃣ *Fusion of Equals* arms itself at the opening bell: more strength, more speed, and a clock. When it runs out the boost leaves and the ultimate leaves with it\n` +
        `3️⃣ *Instant Transmission* needs no command. Blows arrive at empty air, cooldowns sometimes never start, and a duel he did not call can still open on his turn\n` +
        `4️⃣ *${p}soulpunisher*: a ranged ki blast on a short cooldown, no MP, no weapon wear\n` +
        `5️⃣ *${p}kamehameha*: needs a full energy bar and spends all of it. Ignores armour, cannot miss, and only works while the fusion holds\n`,
      )
    }

    const lines = [
      `🔵 *THE FUSION FAILS*`,
      RULE,
      `_You spent 💎${spent}. Nothing held._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${BANNER.maxSpinsPerPlayer}`,
      `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*`,
    ]

    if (requested > BANNER.maxSpinsPerCommand) {
      lines.push(``, `_Capped at *${BANNER.maxSpinsPerCommand}* spins per command. Run it again for more._`)
    } else if (outcome.spinsUsed < outcome.count) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${outcome.count}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // Art preview only on a player's very first ever spin attempt. Every losing
    // spin after that is text only, matching the other spins.
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
