/**
 * <prefix>tyla-alya-spin <amount>
 *
 * Tyla & Alya's global-exclusive spin command — structurally identical to
 * plugins/yo-spin.js (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain them.
 *
 * Odds curve (via chanceForExclusiveSpin, same helper yo-spin.js/ni-spin.js
 * use, just different overrides):
 *   spins 1-160   -> 0%    (DEAD_ZONE_UNTIL = 160, true dead zone, no one
 *                            can win them yet)
 *   spin 161+     -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance,
 *                            sustained all the way to the MAX_SPINS cap —
 *                            deliberately NOT a pity-guarantee curve. PITY_AT
 *                            is set far past the actual max spin count
 *                            (200) so the `spin >= pityAt` guaranteed-win
 *                            branch in chanceForExclusiveSpin() never fires;
 *                            spin 200 stays at a flat 80% roll, same as
 *                            spin 161. This is a deliberate spec difference
 *                            from yo-spin.js's plateau-then-guarantee shape.)
 * These numbers are never shown in any display text — only the pity bar
 * (progress toward the spin cap) is shown, same as every other exclusive
 * spin's "never reveals the plateau" pattern. Do not print
 * DEAD_ZONE_UNTIL/PLATEAU_CHANCE anywhere in player-facing copy.
 *
 * 0.5 Gems per spin. Max 200 spins per player, bot-wide lock same as every
 * other exclusive.
 *
 * GIF handling: character.image is the Twin Bond reveal GIF (see
 * data/characters.json). sendImage()/replyOverArt() already sends it
 * unconditionally on `.character info tyla_alya` — nothing special needed
 * there. Inside THIS command, the GIF is shown on the win message (every
 * exclusive spin's reveal moment) and on a player's very first-ever spin
 * attempt (win or lose) as a one-time preview; every other losing spin
 * after that is text-only, via the same reel/pity-bar block ni-spin.js and
 * yo-spin.js already use.
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

const CHARACTER_ID = 'tyla_alya'
const SPIN_FIELD = 'tylaAlyaSpins'
const COST_PER_SPIN = 0.5
const DEAD_ZONE_UNTIL = 160  // spins 1-160: 0%
const PLATEAU_CHANCE = 0.80  // spin 161+: flat 80%, sustained (no pity spike)
const PITY_AT = 9999         // set far past MAX_SPINS so the guaranteed-win
                              // branch in chanceForExclusiveSpin() never
                              // fires — flat 80% holds all the way to 200.
const MAX_SPINS_PER_PLAYER = 200 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'Two shadows lean close, then pull apart unseen.',
  'A ripple in the rain that isn\'t rain at all. Not this time.',
  'Somewhere, a hand almost takes yours. Almost.',
  'The bond flickers — and stays just out of reach.',
  'Two heartbeats, one breath. It doesn\'t answer yet.',
  'The rain passes. Neither of them steps through.',
]

function missLine(spin) {
  return `🌗 ${MISS_LINES[spin % MISS_LINES.length]}`
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
    // Twin Bond's reveal art is an animated GIF (data/characters.json's
    // tyla_alya.image) — ctx.replyGif routes it through each platform's
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
  name: 'tyla-alya-spin',
  aliases: ['tyla-spin', 'tylaalyaspin', 'ta-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Tyla & Alya — 0.5 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Tyla & Alya aren't configured yet.`)

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
        ? `🌗 *${character.name} are already yours.*\n${RULE}\n_They're bonded to you, and no one else. There is nothing left to spin for._`
        : `🔒 *THE BOND IS SEALED*\n${RULE}\n_${character.name} have been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain them — and someone reached them first. No gems were spent.`)
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
        `🔒 *THE BOND IS SEALED*\n${RULE}\n_${character.name} were claimed while you reached for them._\n\nAnother player got there first this very moment. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_The rain only answers gems. Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🌗 *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for Tyla & Alya. The bond didn't answer this time._`,
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
        `🌗✨ *THEY ANSWER.* ✨🌘\n${RULE}\n` +
        `_Spin ${last.spin}. The rain parts, and ${character.name} step through together._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🌗'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain them.\n` +
        `_Taken on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip them with *${config.prefix}character equip tyla_alya*._`,
      )
    }

    const lines = [
      `🌗 *THE TWIN BARGAIN*`,
      RULE,
      `_You set 💎${spent} before them. They watch — for now._`,
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
