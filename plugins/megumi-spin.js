/**
 * <prefix>megumi-spin <amount>
 *
 * Megumi Fushiguro's global-exclusive spin command — structurally identical
 * to plugins/circe-spin.js / anastasia-spin.js (same global-lock pattern via
 * getExclusiveSpinWinner()/claimExclusiveSpinForPlayer() in
 * lib/season-engine.js, same batch/pity-bar presentation). Only ONE player,
 * bot-wide, can ever obtain him.
 *
 * Odds curve (via chanceForExclusiveSpin, the same helper yo-spin.js /
 * ni-spin.js / circe-spin.js use, just different overrides):
 *   spins 1-190   -> 0%    (DEAD_ZONE_UNTIL = 190, a true dead zone — he
 *                            cannot be won at all before spin 191)
 *   spin 191+     -> 80%   (PLATEAU_CHANCE = 0.8, flat per-spin chance,
 *                            sustained all the way to the MAX_SPINS cap.
 *                            Deliberately NOT a pity-guarantee curve: PITY_AT
 *                            is set far past the real max spin count (250) so
 *                            the `spin >= pityAt` guaranteed-win branch in
 *                            chanceForExclusiveSpin() never fires, and spin
 *                            250 stays a flat 80% roll exactly like spin 191.)
 * Same curve as Circe's and Anastasia's, deliberately — Megumi is the bot's
 * third Boundless character (a full Domain + Mahoraga), so he shares their
 * rarity ceiling and their price of entry. These numbers are never shown in
 * any display text — only the pity bar (progress toward the spin cap) is
 * shown, matching every other exclusive spin's "never reveals the plateau"
 * rule. Do not print DEAD_ZONE_UNTIL / PLATEAU_CHANCE anywhere in
 * player-facing copy.
 *
 * 0.5 Gems per spin. Max 250 spins per player, bot-wide lock same as every
 * other exclusive.
 *
 * IMAGE handling: Megumi's card art (data/characters.json's megumi.image) is a
 * STATIC .jpg, not a GIF — so replyOverArt() uses ctx.replyImage directly
 * rather than circe-spin/tyla-spin's ctx.replyGif branch. Shown on the win
 * message and on a player's very first-ever spin attempt as a one-time
 * preview; every other losing spin after that is text-only.
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

const CHARACTER_ID = 'megumi'
const SPIN_FIELD = 'megumiSpins'
const COST_PER_SPIN = 0.5
const DEAD_ZONE_UNTIL = 190  // spins 1-190: 0%
const PLATEAU_CHANCE = 0.80  // spin 191+: flat 80%, sustained (no pity spike)
const PITY_AT = 9999         // set far past MAX_SPINS so the guaranteed-win
                             // branch in chanceForExclusiveSpin() never
                             // fires — flat 80% holds all the way to 250.
const MAX_SPINS_PER_PLAYER = 250 // hard lifetime cap for this exclusive
const MAX_SPINS_PER_COMMAND = 5  // hard per-command cap — spam-proofs one giant pull into a single reply

const RULE = '━━━━━━━━━━━━━━━━━━━━'

const MISS_LINES = [
  'A shadow stretches across the floor, then pulls back empty.',
  'Something stirs in the dark — a hound\'s shape — and sinks away again.',
  'The shadow ripples. Nothing steps out of it. Not yet.',
  'You reach into the dark and your hand closes on nothing.',
  'A pair of eyes opens in the shadow, considers you, and shuts.',
  'The Ten Shadows stay silent. He does not answer to you.',
]

function missLine(spin) {
  return `🌑 _${MISS_LINES[spin % MISS_LINES.length]}_`
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
    // Megumi's reveal art is a STATIC .jpg (data/characters.json's
    // megumi.image), so — unlike circe-spin/tyla-spin, whose art is animated —
    // ctx.replyImage is the correct path and there is no ctx.replyGif branch
    // to fall through. Falls back to plain text only if replyImage throws.
    return await ctx.replyImage(character.image, text)
  } catch {
    return ctx.reply(text)
  }
}

export default {
  name: 'megumi-spin',
  aliases: ['me-spin', 'megumispin', 'fushiguro-spin'],
  category: 'season',
  requiresPlayer: true,
  description: 'Spin for Megumi Fushiguro — 0.5 Gems per spin, globally exclusive to one winner bot-wide',

  async run(ctx) {
    // Owner freeze (.lockspin / .unlockspin, lib/spin-locks.js). Checked
    // before anything is read or spent, so a locked banner costs nothing.
    if (spinLockGate(ctx, CHARACTER_ID)) return

    const season = activeSeasonOrReply(ctx)
    if (!season) return
    if (!ctx.player) return ctx.reply(`⚠️ Register first with *${config.prefix}register*.`)

    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Megumi Fushiguro isn't configured yet.`)

    // Was this the player's very first spin attempt ever, before this
    // command mutates their spin count? Read once, up front — used only to
    // decide whether to show the image on an otherwise-text-only loss reply.
    const isFirstEverAttempt = (ctx.player[SPIN_FIELD] ?? 0) === 0

    const requested = Math.floor(Number(ctx.args[0]) || 1)
    const spinCount = Math.min(MAX_SPINS_PER_COMMAND, MAX_SPINS_PER_PLAYER, Math.max(1, requested))

    const existingWinner = getExclusiveSpinWinner(ctx.db, CHARACTER_ID)
    if (existingWinner) {
      const isSelf = existingWinner === ctx.from
      return replyOverArt(ctx, character, isSelf
        ? `🌑 *${character.name} already fights at your side.*\n${RULE}\n_The Ten Shadows answer to you, and no one else. There is nothing left to spin for._`
        : `🔒 *THE SHADOWS ARE CLAIMED*\n${RULE}\n_${character.name} has been claimed by another player._\n\nOnly one player, bot-wide, could ever obtain him — and someone reached into the dark first. No gems were spent.`)
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
        `🔒 *THE SHADOWS ARE CLAIMED*\n${RULE}\n_${character.name} slipped into another's shadow in the same moment you reached for him._\n\nAnother player got there first. No gems were spent.`)
    }
    if (outcome?.reason === 'gems') {
      return ctx.reply(
        `💎 *Not enough Gems.*\n${RULE}\n` +
        `One spin costs *${COST_PER_SPIN}*. You hold *${fmtGems(outcome.gems)}*.\n\n` +
        `_The dark does not give freely. Come back with more._`,
      )
    }
    if (outcome?.reason === 'exhausted_lifetime') {
      return ctx.reply(
        `🌑 *No spins left.*\n${RULE}\n` +
        `_You've used all *${MAX_SPINS_PER_PLAYER}* of your spins for ${character.name}. The shadows never once stirred for you._`,
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
        `🌑✨ *THE SHADOW OPENS* ✨🌑\n${RULE}\n` +
        `_Spin ${last.spin}. The dark peels back, and *${character.name}* steps out of it onto your side._\n\n` +

        `🏆 *${character.name.toUpperCase()} OBTAINED*\n` +
        `${character.emoji ?? '🌑'} *${characterStars(character.stars)}*` +
        (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
        (ability?.flavor ? `_${ability.flavor}_\n` : '') +
        (character.description ? `\n_${character.description}_\n` : '') +

        `\n🔒 *GLOBALLY LOCKED.* No other player can ever obtain him.\n` +
        `_Called on spin ${last.spin}, for ${spent} gems this pull._\n\n` +
        `💎 Remaining: *${outcome.remaining}*\n\n` +
        `_Equip him with *${config.prefix}character equip ${CHARACTER_ID}*, then open his Domain with *${config.prefix}domain-expansion* in a fight._`,
      )
    }

    const lines = [
      `🌑 *THE DARK STAYS SHUT*`,
      RULE,
      `_You offer 💎${spent} to the shadow. It watches — and keeps him._`,
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
    // Image preview only on a player's very first-ever spin attempt; every
    // losing spin after that is text-only (matches every other exclusive
    // spin's plain ctx.reply() on loss).
    return isFirstEverAttempt ? replyOverArt(ctx, character, lossText) : ctx.reply(lossText)
  },
}
