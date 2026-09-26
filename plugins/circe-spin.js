/**
 * <prefix>circe-spin <amount>
 *
 * Circe, the Jester's global-exclusive spin command — structurally identical
 * to plugins/anastasia-spin.js (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain her.
 *
 * Odds curve (via chanceForExclusiveSpin, the same helper yo-spin.js /
 * ni-spin.js / tyla-alya-spin.js / anastasia-spin.js use, just different
 * overrides):
 *   spins 1-175   -> 0%    (DEAD_ZONE_UNTIL = 175, a true dead zone — she
 *                            cannot be won at all before spin 176)
 *   spin 176+     -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance,
 *                            sustained all the way to the MAX_SPINS cap.
 *                            Deliberately NOT a pity-guarantee curve: PITY_AT
 *                            is set far past the real max spin count (200) so
 *                            the `spin >= pityAt` guaranteed-win branch in
 *                            chanceForExclusiveSpin() never fires, and spin
 *                            200 stays a flat 80% roll exactly like spin 176.)
 * Same curve as Anastasia's, deliberately — they're the bot's only two
 * Boundless characters and share a rarity ceiling, so they share a price of
 * entry. These numbers are never shown in any display text — only the pity bar
 * (progress toward the spin cap) is shown, matching every other exclusive
 * spin's "never reveals the plateau" rule. Do not print DEAD_ZONE_UNTIL /
 * PLATEAU_CHANCE anywhere in player-facing copy.
 *
 * 0.5 Gems per spin. Max 200 spins per player, bot-wide lock same as every
 * other exclusive. Because the dead zone runs to 175 and the per-command cap
 * is 5, a player needs 35 commands before their first live roll — that is
 * intended, and the pity bar is what tells them how far along they are.
 *
 * GIF handling: character.image is her card-flourish GIF (see
 * data/characters.json). replyOverArt() routes it through ctx.replyGif so it
 * genuinely animates rather than landing as a still frame — WhatsApp gets
 * video+gifPlayback, Discord a raw .gif attachment, Telegram sendAnimation.
 * Shown on the win message and on a player's very first-ever spin attempt as
 * a one-time preview; every other losing spin after that is text-only.
 *
 * No custom font here, unlike Anastasia's fraktur() copy — Circe has no
 * `fontStyle` in data/characters.json, so her copy stays plain ASCII and can
 * safely use WhatsApp's bold/italic markers (which do not apply to the
 * non-ASCII letters a font transform produces).
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
import { roundGems, fmtGems } from '../lib/format.js'
import { characterStars } from '../lib/rarity.js'
import { spinLockGate } from '../lib/spin-locks.js'

const CHARACTER_ID = 'circe'
const SPIN_FIELD = 'circeSpins'
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
  'The card turns over. It is a two of nothing.',
  'Somewhere just out of sight, someone laughs at you. Politely.',
  'The wheel slows, points at an empty seat, and stops.',
  'A card lands face-down in the dust. You already know what it is not.',
  'You hear applause. It is not for you.',
  'The house wins. The house always wins.',
]

function missLine(spin) {
  return `🃏 _${MISS_LINES[spin % MISS_LINES.length]}_`
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
    // Her reveal art is an animated GIF (data/characters.json's circe.image)
    // — ctx.replyGif routes it through each platform's actual animated-media
    // path (WhatsApp: video+gifPlayback, Discord: raw .gif attachment,
    // Telegram: sendAnimation) so it truly autoplays instead of landing as a
    // single still frame the way ctx.replyImage would render a .gif URL.
    // Falls back to ctx.replyImage if replyGif isn't available on this ctx
    // for any reason (older adapter, etc.), then to plain text if even that
    // fails.
    if (typeof ctx.replyGif === 'function') {
      return await ctx.replyGif(character.image, text)
    }
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'circe-spin',
  aliases: ['ci-spin', 'circespin', 'jester-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Circe, the Jester — 0.5 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Circe, the Jester isn't configured yet.`)

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
        ? `🃏 *${character.name} already deals for you.*\n${RULE}\n_You're the house now. There's nothing left to spin for._`
        : `🔒 *THE TABLE IS CLOSED*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain her — and someone else drew her first. No gems were spent.`)
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
        `🔒 *THE TABLE IS CLOSED*\n${RULE}\n_${character.name} was dealt out in the same moment you reached for her._\n\nAnother player got there first. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_No credit at this table. Come back with chips._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🃏 *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. She never once looked up from her cards._`,
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
        `🃏✨ *STEP RIGHT UP — THE HOUSE FOLDS* ✨🃏\n${RULE}\n` +
        `_Spin ${last.spin}. Six cards go up, one comes down face-first on the table, and *${character.name}* is sitting on your side of it._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🃏'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain her.\n` +
        `_Drawn on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip her with *${config.prefix}character equip ${CHARACTER_ID}*, then draw with *${config.prefix}wildcard* in a fight._`,
      )
    }

    const lines = [
      `🃏 *THE CARD THAT WASN'T HERS*`,
      RULE,
      `_You put 💎${spent} on the table. She doesn't even look up._`,
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
