/**
 * collect.js — grab a spawned anime card, anime series, OR wild Pokémon by
 * its claim code.
 *
 * Checks card spawns first, then series, then Pokémon. If more than one is
 * simultaneously active in the same group with colliding codes, priority
 * follows that order and a warning is logged — this should be extremely
 * rare given 6-char random codes from a 31-character alphabet, but we
 * defend against it.
 *
 * Usage: .collect <code>
 * See handler.js for the spawn hook and lib/card-engine.js / lib/series-engine.js /
 * lib/pokemon-engine.js for storage details.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { addCardToPlayer, tierStars, cardSellPrice } from '../lib/card-engine.js'
import { getActiveSpawn, clearActiveSpawn } from '../lib/card-spawn-state.js'
import {
  addSeriesToPlayer,
  seriesTierStars,
  seriesTierEmoji,
} from '../lib/series-engine.js'
import { getActiveSeriesSpawn, clearActiveSeriesSpawn } from '../lib/series-spawn-state.js'
import { addPokemonToPlayer, formatTypes } from '../lib/pokemon-engine.js'
import { getActiveSpawn as getActivePokemonSpawn, clearActiveSpawn as clearActivePokemonSpawn } from '../lib/pokemon-spawn-state.js'
import { recordQuestEvent } from '../lib/quest-engine.js'

export default {
  name: 'collect',
  // NOTE: 'claim' is intentionally NOT an alias here — plugins/daily.js
  // already uses 'claim' as an alias for the daily-reward command, and the
  // plugin loader resolves alias collisions by silently letting whichever
  // plugin loads last win (see lib/plugin-manager.js). Reusing 'claim' here
  // would make this card command randomly swallow or lose to .claim
  // depending on file load order. 'grab' is unambiguous and kept.
  aliases: ['grab'],
  category: 'cards',
  requiresPlayer: true,
  description: 'Collect a spawned anime card, anime series, or wild Pokémon with its claim code',
  subcommands: [
    { cmd: '<code>', desc: 'claim whichever active spawn (card, series, or wild Pokémon) matches this code' },
  ],

  async run(ctx) {
    const { args, reply, sender, player } = ctx
    const code = (args[0] ?? '').trim()
    if (!code) return reply(`❌ *Usage:* *${config.prefix}collect <code>*`)

    const cardSpawn    = getActiveSpawn(sender)
    const seriesSpawn  = getActiveSeriesSpawn(sender)
    const pokemonSpawn = getActivePokemonSpawn(sender)

    const cardMatches    = cardSpawn    && cardSpawn.claim.toLowerCase()     === code.toLowerCase()
    const seriesMatches  = seriesSpawn  && seriesSpawn.claimCode.toLowerCase() === code.toLowerCase()
    const pokemonMatches = pokemonSpawn && pokemonSpawn.claim.toLowerCase()  === code.toLowerCase()

    // ── Collision guard: more than one active AND matching the same code ─
    const matchCount = [cardMatches, seriesMatches, pokemonMatches].filter(Boolean).length
    if (matchCount > 1) {
      console.warn(
        `[collect] Claim-code collision in group ${sender} for code "${code}" — ` +
        `card=${cardMatches} series=${seriesMatches} pokemon=${pokemonMatches}. ` +
        `Priority order (card > series > pokemon) applies.`
      )
    }

    // ── Card spawn claim (highest priority) ─────────────────────────────
    if (cardMatches) {
      clearActiveSpawn(sender)
      await updatePlayer(ctx.db, player.id, p => {
        addCardToPlayer(p, cardSpawn)
        return p
      })
      return reply(
        `🎉 *${player.name}* collected the card!\n\n` +
        `${tierStars(cardSpawn.tier)} *${cardSpawn.title}*\n` +
        `📺 _${cardSpawn.series}_\n` +
        `☀️ Worth: *${cardSellPrice(cardSpawn.tier)}* Solars _(if sold)_\n\n` +
        `_Set as your waifu with *${config.prefix}setwaifu ${cardSpawn.title}*, or sell with *${config.prefix}sellcard ${cardSpawn.title}*._`
      )
    }

    // ── Series spawn claim ───────────────────────────────────────────────
    if (seriesMatches) {
      clearActiveSeriesSpawn(sender)
      // Capture the entry that addSeriesToPlayer() pushes so the claim message
      // shows the SAME sell price that is stored on the record — never re-roll.
      let claimedEntry = null
      await updatePlayer(ctx.db, player.id, p => {
        addSeriesToPlayer(p, seriesSpawn)
        claimedEntry = p.seriesCollection[p.seriesCollection.length - 1]
        return p
      })

      const tier  = claimedEntry?.tier      ?? seriesSpawn.tier
      const price = claimedEntry?.sellPrice ?? 0
      const score = seriesSpawn.score != null ? `${Number(seriesSpawn.score).toFixed(1)} ⭐` : 'Unrated'

      return reply(
        `🎉 *${player.name}* claimed the series!\n\n` +
        `${seriesTierEmoji(tier)} ${seriesTierStars(tier)} *${seriesSpawn.title}*\n` +
        `🏅 Score: ${score} · Tier: *${tier}*\n` +
        `☀️ Worth: *${price.toLocaleString()}* Solars _(if sold)_\n\n` +
        `_Inspect with *${config.prefix}series ${seriesSpawn.title}*, or sell with *${config.prefix}series sell ${seriesSpawn.title}*._`
      )
    }

    // ── Wild Pokémon claim ────────────────────────────────────────────────
    if (pokemonMatches) {
      clearActivePokemonSpawn(sender)
      let caught = null
      await updatePlayer(ctx.db, player.id, p => {
        caught = addPokemonToPlayer(p, pokemonSpawn)
        recordQuestEvent(p, 'catch', 1)
        return p
      })

      const shinyTag = caught.shiny ? '✨ *SHINY* ' : ''
      return reply(
        `🎉 *${player.name}* caught the wild Pokémon!\n\n` +
        `${shinyTag}*${caught.name}* [Lvl ${caught.level}]\n` +
        `${formatTypes(caught.types)}\n\n` +
        `_View it with *${config.prefix}pokemon dex*, or set it as your main with *${config.prefix}pokemon main ${caught.name}*._`
      )
    }

    // ── Nothing matched ──────────────────────────────────────────────────
    if (!cardSpawn && !seriesSpawn && !pokemonSpawn) {
      return reply(`❌ *No card, series, or wild Pokémon is currently spawned here.*`)
    }
    return reply(`❌ *Wrong code!* That spawn is still up for grabs.`)
  },
}
