/**
 * <prefix>alexa-spin <amount>
 *
 * Alexa (the Witch of Love) global-exclusive spin — a direct copy of
 * plugins/tyla-alya-spin.js's shape (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation, same
 * flat-plateau odds curve). Only ONE player, bot-wide, can ever obtain her.
 *
 * Odds curve (via chanceForExclusiveSpin):
 *   spins 1-170   -> 0%    (DEAD_ZONE_UNTIL = 170, true dead zone, nobody
 *                            can win her yet no matter how many gems burn)
 *   spin 171+     -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance,
 *                            sustained all the way to the 200-spin cap.
 *                            PITY_AT is parked far past the real max so the
 *                            `spin >= pityAt` guaranteed-win branch inside
 *                            chanceForExclusiveSpin() never fires — spin 200
 *                            is still a flat 80% roll, exactly like spin 171.
 *                            Same deliberate "no pity spike" shape as
 *                            tyla-alya-spin.js.)
 * These numbers are never printed in player-facing copy — only the pity bar
 * (progress toward the spin cap) is shown, matching every other exclusive
 * spin's "never reveals the plateau" rule. Do not surface DEAD_ZONE_UNTIL or
 * PLATEAU_CHANCE anywhere in a reply.
 *
 * 1 Gem per spin. Max 200 spins per player, bot-wide lock same as every other
 * exclusive.
 *
 * GIF handling: character.image is her reveal GIF (data/characters.json).
 * Shown on the win message and on a player's very first-ever attempt as a
 * one-time preview; every losing spin after that is text-only, same as
 * tyla-alya-spin.js.
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

const CHARACTER_ID = 'alexa'
const SPIN_FIELD = 'alexaSpins'
const COST_PER_SPIN = 1
const DEAD_ZONE_UNTIL = 170  // spins 1-170: 0%
const PLATEAU_CHANCE = 0.80  // spin 171+: flat 80%, sustained (no pity spike)
const PITY_AT = 9999         // parked past MAX_SPINS so the guaranteed-win
                             // branch in chanceForExclusiveSpin() never fires
const MAX_SPINS_PER_PLAYER = 200 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap, spam-proofs one giant pull

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'She looks past you, at something you cannot see.',
  'A warmth in your chest that leaves as quickly as it came.',
  'Someone laughs softly, and it is not for you.',
  'You reach for her name and forget it halfway.',
  'The room smells faintly of roses. She was never in it.',
  'Almost. Almost is where most people stop.',
]

function missLine(spin) {
  return `💗 ${MISS_LINES[spin % MISS_LINES.length]}`
}

/** Progress toward the spin cap, never reveals the plateau. */
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
    // Her reveal art is an animated GIF (data/characters.json's alexa.image),
    // so ctx.replyGif routes it through each platform's real animated-media
    // path (WhatsApp: video+gifPlayback, Discord: raw .gif attachment,
    // Telegram: sendAnimation) instead of landing as one still frame the way
    // ctx.replyImage renders a .gif URL. Falls back to replyImage, then plain
    // text, exactly like tyla-alya-spin.js.
    if (typeof ctx.replyGif === 'function') {
      return await ctx.replyGif(character.image, text)
    }
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'alexa-spin',
  aliases: ['alexaspin', 'al-spin', 'witch-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Alexa, the Witch of Love — 1 Gem per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Alexa isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this command
    // mutates their spin count? Read once, up front, and used only to decide
    // whether the GIF rides along on an otherwise text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `💗 *She is already yours.*\n${RULE}\n_The Witch of Love answers to you and to nobody else. There is nothing left to spin for._`
        : `🔒 *HER HEART IS TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever win her, and someone got there first. No gems were spent.`)
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
        if ((player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER) break

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
            won = true
          }
          break
        }
      }

      if (!results.length) {
        outcome = { reason: (player[SPIN_FIELD] ?? 0) >= MAX_SPINS_PER_PLAYER ? 'exhausted_lifetime' : 'gems', gems, cost: COST_PER_SPIN }
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
        `🔒 *HER HEART IS TAKEN*\n${RULE}\n_${character.name} was claimed while you were still reaching._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_Love is patient. It is not, however, free._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `💗 *No spins left.*\n${RULE}\n` +
        `_You've spent all *${MAX_SPINS_PER_PLAYER}* of your spins on Alexa. She never once looked your way._`,
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
        `💗✨ *SHE LOOKS AT YOU.* ✨💗\n${RULE}\n` +
        `_Spin ${last.spin}. Out of every hand reaching for her, she takes yours._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '💗'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip her with *${config.prefix}character equip alexa*._`,
      )
    }

    const lines = [
      `💗 *THE WITCH'S FAVOUR*`,
      RULE,
      `_You lay 💎${spent} at her feet. She hasn't decided about you yet._`,
      ``,
      range,
      reel(outcome.results),
      ``,
      missLine(last.spin),
      ``,
      `📿 Pity  ${pityBar(last.spin)}  *${last.spin}*/${MAX_SPINS_PER_PLAYER}`,
      `💎 Remaining: *${outcome.remaining}*`,
    ]

    if (requested > MAX_SPINS_PER_COMMAND) {
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command, run it again for more._`)
    } else if (outcome.spinsUsed < spinCount) {
      lines.push(``, `_Gems ran out after *${outcome.spinsUsed}* of *${spinCount}* requested spins._`)
    }

    const lossText = lines.join('\n')
    // GIF preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive
    // spin's plain ctx.reply() on loss).
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
