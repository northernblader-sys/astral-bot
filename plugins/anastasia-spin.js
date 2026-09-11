/**
 * <prefix>anastasia-spin <amount>
 *
 * Demon Lord Anastasia's global-exclusive spin command — structurally
 * identical to plugins/tyla-alya-spin.js (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her.
 *
 * Odds curve (via chanceForExclusiveSpin, the same helper yo-spin.js /
 * ni-spin.js / tyla-alya-spin.js use, just different overrides):
 *   spins 1-175   -> 0%    (DEAD_ZONE_UNTIL = 175, a true dead zone — she
 *                            cannot be won at all before spin 176)
 *   spin 176+     -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance,
 *                            sustained all the way to the MAX_SPINS cap.
 *                            Deliberately NOT a pity-guarantee curve: PITY_AT
 *                            is set far past the real max spin count (200) so
 *                            the `spin >= pityAt` guaranteed-win branch in
 *                            chanceForExclusiveSpin() never fires, and spin
 *                            200 stays a flat 80% roll exactly like spin 176.
 *                            Same shape as tyla-alya-spin.js, just a longer
 *                            dead zone — 175 of her 200 spins are silent.)
 * These numbers are never shown in any display text — only the pity bar
 * (progress toward the spin cap) is shown, matching every other exclusive
 * spin's "never reveals the plateau" rule. Do not print DEAD_ZONE_UNTIL /
 * PLATEAU_CHANCE anywhere in player-facing copy.
 *
 * 0.5 Gems per spin. Max 200 spins per player, bot-wide lock same as every
 * other exclusive. Because the dead zone runs to 175 and the per-command cap
 * is 5, a player needs 35 commands before their first live roll — that is
 * intended, and the pity bar is what tells them how far along they are.
 *
 * GIF handling: character.image is her Hypnosis clock GIF (see
 * data/characters.json). replyOverArt() routes it through ctx.replyGif so it
 * genuinely animates rather than landing as a still frame — WhatsApp gets
 * video+gifPlayback, Discord a raw .gif attachment, Telegram sendAnimation.
 * Shown on the win message and on a player's very first-ever spin attempt as
 * a one-time preview; every other losing spin after that is text-only.
 *
 * FONT: her copy is rendered in Mathematical Bold Fraktur via fraktur()
 * (lib/format.js), matching the script her in-battle rewind message uses.
 * Applied to headings and single-line beats only — never to the character
 * name used for lookups, and never wrapped in WhatsApp's bold or italic
 * markers, which it will not apply to non-ASCII letters.
 */
import { config } from '../config.js'
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
import { roundGems, fmtGems, fraktur } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'anastasia'
const SPIN_FIELD = 'anastasiaSpins'
const COST_PER_SPIN = 0.5
const DEAD_ZONE_UNTIL = 175  // spins 1-175: 0%
const PLATEAU_CHANCE = 0.80  // spin 176+: flat 80%, sustained (no pity spike)
const PITY_AT = 9999         // set far past MAX_SPINS so the guaranteed-win
                             // branch in chanceForExclusiveSpin() never
                             // fires — flat 80% holds all the way to 200.
const MAX_SPINS_PER_PLAYER = 200 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'The clock ticks once. Nothing behind it moves.',
  'An hour passes that no one will remember. Not hers.',
  'You hear the mechanism turn. It turns away from you.',
  'A door closes somewhere in the last minute. She was not on this side of it.',
  'The second hand hesitates — then goes on without her.',
  'Time keeps its own counsel tonight.',
]

function missLine(spin) {
  return `🕰️ ${fraktur(MISS_LINES[spin % MISS_LINES.length])}`
}

/** Progress toward the spin cap — never reveals the plateau. */
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
    // Her reveal art is an animated GIF (data/characters.json's
    // anastasia.image) — ctx.replyGif routes it through each platform's
    // actual animated-media path (WhatsApp: video+gifPlayback, Discord:
    // raw .gif attachment, Telegram: sendAnimation) so it truly autoplays
    // instead of landing as a single still frame the way ctx.replyImage
    // would render a .gif URL. Falls back to ctx.replyImage if replyGif
    // isn't available on this ctx for any reason (older adapter, etc.),
    // then to plain text if even that fails.
    if (typeof ctx.replyGif === 'function') {
      return await ctx.replyGif(character.image, text)
    }
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'anastasia-spin',
  aliases: ['ana-spin', 'anastasiaspin', 'demonlord-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Demon Lord Anastasia — 0.5 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Demon Lord Anastasia isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this
    // command mutates their spin count? Read once, up front — used only to
    // decide whether to show the GIF on an otherwise-text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `🕰️ *${character.name} already answers to you.*\n${RULE}\n_The hour is yours. There is nothing left to spin for._`
        : `🔒 *THE HOUR IS TAKEN*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone reached that hour first. No gems were spent.`)
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
        `🔒 *THE HOUR IS TAKEN*\n${RULE}\n_${character.name} was claimed in the same moment you reached for her._\n\nAnother player got there first. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_The clock does not run on promises. Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🕰️ *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. The hour never turned for you._`,
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
        `🕰️✨ ${fraktur('THE HOUR TURNS TO YOU')} ✨🕰️\n${RULE}\n` +
        `_Spin ${last.spin}. The clock stops mid-stroke, and ${character.name} steps out of the minute that never happened._\n\n` +

        `🏆 ${fraktur(`${character.name} OBTAINED`)}\n` +
        `${character.emoji ?? '🕰️'} ${characterStars(character.stars)}` +
        (ability?.name ? `  ·  ${fraktur(ability.name)}` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Taken on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip her with *${config.prefix}character equip ${CHARACTER_ID}*._`,
      )
    }

    const lines = [
      `🕰️ ${fraktur('THE HOUR THAT DID NOT TURN')}`,
      RULE,
      `_You set 💎${spent} against the clock. It does not look up._`,
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
      lines.push(``, `_Capped at *${MAX_SPINS_PER_COMMAND}* spins per command — run it again for more._`)
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
