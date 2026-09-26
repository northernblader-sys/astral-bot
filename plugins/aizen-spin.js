/**
 * <prefix>aizen-spin <amount>
 *
 * Aizen Sosuke's global-exclusive spin — the alexa-spin.js/anastasia-spin.js
 * shape (same bot-wide lock via getExclusiveSpinWinner()/
 * claimExclusiveSpinForPlayer() in lib/season-engine.js, same batch/pity-bar
 * presentation) with the gojo-spin.js gems handling (roundGems on every read
 * and write). Only ONE player, bot-wide, can ever obtain him: the moment
 * anyone wins, the claim lands and every later pull is refused with "already
 * taken" before a single gem is spent. He is NOT season content and NOT gated
 * on an active season — the claim registry is generic (admin.js's
 * .givecharacter uses the same one for every `exclusive: true` character).
 *
 * Odds curve (via chanceForExclusiveSpin, with overrides):
 *   spins 1-254   -> 0%    (DEAD_ZONE_UNTIL = 254, a true dead zone — he
 *                           cannot be won at all before spin 255)
 *   spin 255+     -> 100%  (PLATEAU_CHANCE = 1.0, and PITY_AT = 255, so the
 *                           guaranteed-win branch and the plateau coincide:
 *                           spin 255 is a certainty, and the 300-spin lifetime
 *                           cap exists as the outer bound the pity bar draws
 *                           progress toward, never as a real cliff — the run
 *                           is over the moment it reaches 255.)
 * These numbers are never printed in player-facing copy — only the pity bar
 * (progress toward the spin cap) is, matching every other exclusive spin's
 * "never reveals the plateau" rule. Do not surface DEAD_ZONE_UNTIL or
 * PLATEAU_CHANCE anywhere in a reply.
 *
 * 0.7 Gems per spin. Max 300 spins per player (the run is always won at 255),
 * 50 spins per command — bigger than the 5 the Solar exclusives use and the 20
 * Gojo uses, because a 254-spin dead zone at 20 per command is 13 commands of
 * pure loss before the first live roll. 50 still fits the reel (rows of 10,
 * five rows shown) and keeps one pull to a single readable reply.
 *
 * Art handling: character.image is his portrait (data/characters.json). Shown
 * on the win message and on a player's very first-ever attempt as a one-time
 * preview; every losing spin after that is text-only, same as every other
 * spin in the bot.
 */
import { config } from '../config.js'
import {
  chanceForExclusiveSpin,
  getExclusiveSpinWinner,
  claimExclusiveSpinForPlayer,
} from '../lib/season-engine.js'
import { characterMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { roundGems, fmtGems } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'aizen'
const SPIN_FIELD = 'aizenSpins'
const COST_PER_SPIN = 0.7       // gems per spin
const DEAD_ZONE_UNTIL = 254     // spins 1-254: 0%
const PLATEAU_CHANCE = 1.0      // spin 255+: 100%
const PITY_AT = 255             // guaranteed from 255 — plateau and pity coincide
const MAX_SPINS_PER_PLAYER = 300 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 50 // fits the reel's five rows of ten

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The man in the chair never looked up. The one you swung at was never there.',
  'A gentle smile, somewhere to your left. You were never sure where.',
  'You rehearsed the whole fight. He edited it.',
  'Everything you perceived was accurate. None of it was true.',
  'The distance was always his decision, never yours.',
  'You reach for him and find only the shape of the air he left behind.',
]

function missLine(spin) {
  return `👁️ _${MISS_LINES[spin % MISS_LINES.length]}_`
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
  name: 'aizen-spin',
  aliases: ['aizenspin', 'aizen', 'sosuke', 'aizen-claim'],
  category: 'character',
  requiresPlayer: true,
  description: 'Spin for Aizen Sosuke at 0.7 gems per spin. Globally exclusive to one winner bot-wide',

  async run(ctx) {
    const p = config.prefix
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${p}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Aizen isn't configured yet.`)

    // Owner spin lock (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID, character.name)) return

    // The bot-wide one-of-one claim. Checked before anything is spent — once
    // he has been taken the spin "won't work" for anyone else, exactly as
    // designed: no gems, no spin count, nothing.
    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `🔮 *${character.name} is already yours.*\n${RULE}\n_Kyōka Suigetsu answers to you and to nobody else. There is nothing left to spin for._`
        : `🔒 *THE THRONE IS TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain him, and someone reached that throne first. No gems were spent.`)
    }

    // First ever attempt, read before this command mutates the spin count. Only
    // decides whether a losing reply carries the art as a one time preview.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    let outcome = null
    await updatePlayer(ctx.db, ctx.from, (player) => {
      // Re-checked inside the write-serialized mutator. The check above is a
      // cheap pre-check; these are the race-safe ones.
      if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) {
        outcome = { reason: 'claimed' }
        return
      }

      player.wallet = player.wallet ?? {}
      let gems = roundGems(player.wallet.gems ?? 0)
      const results = []
      let won = false
      let spinsUsed = 0

      for (let i = 0; i < spinCount; i++) {
        if (getExclusiveSpinWinner(ctx.db, CHARACTER_ID)) break
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
          const claimed = claimExclusiveSpinForPlayer(ctx.db, CHARACTER_ID, ctx.from)
          if (claimed) {
            player.ownedCharacters = player.ownedCharacters ?? []
            if (!player.ownedCharacters.includes(CHARACTER_ID)) player.ownedCharacters.push(CHARACTER_ID)
            won = true
          }
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

    if (outcome?.reason === 'claimed') {
      return replyOverArt(ctx, character,
        `🔒 *THE THRONE IS TAKEN*\n${RULE}\n_${character.name} was claimed while you were still reaching._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs 💎*${fmtGems(COST_PER_SPIN)}*. You hold 💎*${fmtGems(outcome.gems)}*.\n\n` +
        `_He is patient. You will need to be._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🔮 *No spins left.*\n${RULE}\n` +
        `_You have used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. He never once looked your way._`,
      )
    }

    const last = outcome.results[outcome.results.length - 1]
    const spent = fmtGems(roundGems(outcome.spinsUsed * COST_PER_SPIN))
    const range = outcome.spinsUsed === 1
      ? `Spin *${last.spin}*`
      : `Spins *${outcome.results[0].spin}* → *${last.spin}*`

    if (outcome.reason === 'won') {
      const ability = character.ability
      return replyOverArt(ctx, character,
        `🔮⬛ *KYŌKA SUIGETSU* ⬛🔮\n${RULE}\n` +
        `_Spin ${last.spin}. The blade was never pointed at you. Your five senses were._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🔮'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain him.\n` +
        `_Taken on spin ${last.spin}, for 💎${spent} this pull._\n` +
        `💎 Remaining: 💎*${fmtGems(outcome.remaining)}*\n\n` +
        `*How to use him:*\n` +
        `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
        `2️⃣ *Kyōka Suigetsu* needs no command. Blows aimed at him land on phantoms, and every one that misses teaches him another of the enemy's five senses. Five taken and the hypnosis is complete\n` +
        `3️⃣ *${p}kurohitsugi*, once per battle: the black coffin of distorted time seals over the enemy — the closer to death they are, the tighter it crushes, and no armour has any part in it\n` +
        `4️⃣ *${p}hougyoku*, once per battle: the Hōgyoku answers — his body reforges, all five senses fall at once, and his strength steps out of reach\n`,
      )
    }

    const lines = [
      `🔮 *THE WORLD IS HIS*`,
      RULE,
      `_You spent 💎${spent}. He was somewhere else the entire time._`,
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
