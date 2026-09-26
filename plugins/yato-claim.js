/**
 * yato-claim.js — the 500,000-fame unlock for Yato.
 *
 * Not a spin and not exclusive: fame is earned, not rolled, so anyone who
 * actually reaches 500k can claim him. It is the first thing in the bot that
 * fame does beyond a leaderboard title — lib/fame-engine.js's tiers top out at
 * 250k, so this sits deliberately above the last tier as the reason to keep
 * going.
 *
 * The grant is the same block plugins/character.js and every *-spin.js use:
 * push the id onto player.ownedCharacters, guarded by an includes() check so
 * running the command twice can't duplicate it. Equipping stays where it
 * belongs — `.character equip yato`.
 *
 * Usage: <prefix>yato
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { characterMap } from '../lib/game-data.js'
import { rarityLabel } from '../lib/rarity.js'
import { getFameTier, formatFame } from '../lib/fame-engine.js'

const CHARACTER_ID = 'yato'
const REQUIRED_FAME = 500_000

const RULE = '━━━━━━━━━━━━━━━━━━━━'

function progressBar(fame, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((fame / REQUIRED_FAME) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
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
  name: 'yato',
  aliases: ['yato-claim', 'yatoclaim', 'claimyato'],
  category: 'character',
  requiresPlayer: true,
  description: 'Claim Yato — unlocks at 500,000 fame',

  async run(ctx) {
    const p = config.prefix
    const character = characterMap[CHARACTER_ID]
    if (!character) return ctx.reply(`⚠️ Yato isn't configured yet.`)

    const fame = ctx.player?.fame ?? 0

    if ((ctx.player?.ownedCharacters ?? []).includes(CHARACTER_ID)) {
      return replyOverArt(ctx, character,
        `📺 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*, go live inside a dungeon with *${p}stream start*, ` +
        `let the crowd build, then fire *${p}live-blast*._`)
    }

    if (fame < REQUIRED_FAME) {
      const tier = getFameTier(fame)
      const short = REQUIRED_FAME - fame
      return ctx.reply(
        `📺 *YATO — LOCKED*\n${RULE}\n` +
        `_Fame is the whole unlock. Nothing else opens this one._\n\n` +
        `${tier.emoji} Your fame: *${formatFame(fame)}*\n` +
        `🎯 Required: *${formatFame(REQUIRED_FAME)}*\n` +
        `${progressBar(fame)}  *${Math.floor((fame / REQUIRED_FAME) * 100)}%*\n\n` +
        `_You need *${formatFame(short)}* more. Earn it by winning battles, clearing floors and beating bosses — check *${p}fame*._`
      )
    }

    let granted = false
    await updatePlayer(ctx.db, ctx.from, (player) => {
      player.ownedCharacters = player.ownedCharacters ?? []
      // Re-check inside the write-serialized mutator: this is the race-safe
      // guard, the one above is just a cheap pre-check.
      if (!player.ownedCharacters.includes(CHARACTER_ID)) {
        player.ownedCharacters.push(CHARACTER_ID)
        granted = true
      }
      return player
    })

    if (!granted) {
      return replyOverArt(ctx, character,
        `📺 *${character.name} is already yours.*\n${RULE}\n` +
        `_Equip him with *${p}character equip ${CHARACTER_ID}*._`)
    }

    const ability = character.ability
    return replyOverArt(ctx, character,
      `📺🔴 *WE'RE LIVE* 🔴📺\n${RULE}\n` +
      `_${formatFame(fame)} fame. Enough people know your name that pointing a camera at a boss is now a weapon._\n\n` +

      `🏆 *${character.name.toUpperCase()} UNLOCKED*\n` +
      `${character.emoji ?? '📺'} *${rarityLabel(character.rarity).toUpperCase()}*` +
      (ability?.name ? `  ·  *${ability.name}*` : '') + `\n` +
      (ability?.flavor ? `_${ability.flavor}_\n` : '') +
      (character.description ? `\n_${character.description}_\n` : '') +

      `\n*How to use him:*\n` +
      `1️⃣ *${p}character equip ${CHARACTER_ID}*\n` +
      `2️⃣ Enter a dungeon where an admin has run *${p}stream on*\n` +
      `3️⃣ *${p}stream start* — then fight, and the crowd grows every turn\n` +
      `4️⃣ *${p}live-blast* — once per battle, the whole audience hits at once\n\n` +
      `💧 _*Tear of God* needs no command. Once a battle, the blow that would end him simply doesn't._`
    )
  },
}
