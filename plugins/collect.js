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
import { addCardToPlayer, tierStars, cardSellPrice, hasCardSeries } from '../lib/card-engine.js'
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

/**
 * Claim whichever spawn in `sender`'s group matches `code`.
 *
 * Exported so plugins/claim.js (`.claim <code>`) and plugins/daily.js — which
 * owns the `.claim` alias for the daily reward, see the alias note on the
 * plugin below — can route a typed claim code here instead of each
 * re-implementing the three-way card/series/Pokémon match, the collision guard
 * and the per-type payout. There is exactly one implementation of "spend this
 * code", so a change to how a claimed series is stored can never leave
 * `.claim` and `.collect` paying out differently.
 *
 * Returns the reply promise, exactly as a plugin's run() would.
 */
export async function claimActiveSpawn(ctx, code) {
  const { reply, sender, player } = ctx

  const cardSpawn    = getActiveSpawn(sender)
  const seriesSpawn  = getActiveSeriesSpawn(sender)
  const pokemonSpawn = getActivePokemonSpawn(sender)

  const cardMatches    = cardSpawn    && cardSpawn.claim.toLowerCase()      === code.toLowerCase()
  const seriesMatches  = seriesSpawn  && seriesSpawn.claimCode.toLowerCase() === code.toLowerCase()
  const pokemonMatches = pokemonSpawn && pokemonSpawn.claim.toLowerCase()   === code.toLowerCase()

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
      (hasCardSeries(cardSpawn.series) ? `📺 _${cardSpawn.series}_\n` : '') +
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
}

/**
 * True when `code` looks like a spawn claim code rather than free text: both
 * card and series codes are 6 chars from a 31-char A–Z/2–9 alphabet (see
 * CODE_CHARS in lib/card-engine.js and lib/series-engine.js). Used by
 * plugins/daily.js to decide whether a `.claim XYZ123` is a spawn claim or a
 * daily-reward claim with junk after it.
 */
export function looksLikeClaimCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{6}$/i.test(code.trim())
}

export default {
  name: 'collect',
  // NOTE: 'claim' is intentionally NOT an alias here — plugins/daily.js
  // already uses 'claim' as an alias for the daily-reward command, and the
  // plugin loader resolves same-platform alias collisions by letting the LAST
  // plugin to register win (see lib/plugin-manager.js resolvePlugin), which for
  // 'claim' is daily.js by file-load order. Registering 'claim' here too would
  // not give it to us — it would just leave the winner dependent on load order.
  // Instead daily.js routes a typed claim code to claimActiveSpawn() above, so
  // `.claim <code>` works regardless of who wins the key. 'grab' is
  // unambiguous and kept.
  aliases: ['grab'],
  category: 'cards',
  requiresPlayer: true,
  description: 'Collect a spawned anime card, anime series, or wild Pokémon with its claim code',
  subcommands: [
    { cmd: '<code>', desc: 'claim whichever active spawn (card, series, or wild Pokémon) matches this code' },
  ],

  async run(ctx) {
    const { args, reply } = ctx
    const code = (args[0] ?? '').trim()
    if (!code) return reply(`❌ *Usage:* *${config.prefix}collect <code>*`)
    return claimActiveSpawn(ctx, code)
  },
}
