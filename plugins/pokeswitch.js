/**
 * pokeswitch.js — toggle wild Pokémon auto-spawn for this group, or force
 * an immediate spawn (bot owner only).
 *
 * Usage: .pokeswitch on / off    — group admins/owner only, toggles the
 *                                  wild Pokémon spawn sweep (cadence lives in
 *                                  lib/spawn-intervals.js)
 *        .pokeswitch spawn       — bot owner only, forces one right now
 *
 * Mirrors plugins/waifu.js's on/off/spawn shape (that file does the same
 * job for the anime-card spawn system) so the two toggles behave
 * identically from an admin's perspective.
 */
import { config } from '../config.js'
import { fetchRandomPokemon, formatTypes } from '../lib/pokemon-engine.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { addPokemonSpawnGroup, removePokemonSpawnGroup } from '../lib/pokemon-spawn-groups.js'
import { NOT_GROUP, NOT_ALLOWED, isOwnerJid } from '../lib/group-helpers.js'
import { setActiveSpawn } from '../lib/pokemon-spawn-state.js'
import { POKEMON_SPAWN_INTERVAL_MS, humanInterval } from '../lib/spawn-intervals.js'

const SPAWN_EVERY = humanInterval(POKEMON_SPAWN_INTERVAL_MS)

export default {
  name: 'pokeswitch',
  aliases: ['pokemonswitch', 'wildpoke'],
  category: 'pokemon',
  requiresPlayer: false,
  description: 'Toggle wild Pokémon auto-spawn for this group (.pokeswitch on/off), or force one now',
  subcommands: [
    { cmd: 'on',    desc: 'enable wild Pokémon auto-spawn here (admins only)' },
    { cmd: 'off',   desc: 'disable it (admins only)' },
    { cmd: 'spawn', desc: 'force one right now (bot owner only)' },
  ],

  async run(ctx) {
    const { args, reply, replyImage } = ctx
    const sub = (args[0] ?? '').toLowerCase()

    // ── SPAWN (bot owner only) — manually force a spawn right now ────────
    if (sub === 'spawn') {
      if (!ctx.isGroup) return reply(NOT_GROUP)
      if (!isOwnerJid(ctx.from)) return reply(NOT_ALLOWED)

      const pokemon = await fetchRandomPokemon()
      if (!pokemon) return reply(`❌ Couldn't reach the Pokémon API — try again shortly.`)

      setActiveSpawn(ctx.sender, pokemon)
      const shinyTag = pokemon.isShiny ? '✨ *SHINY ENCOUNTER!* ✨\n' : ''
      return replyImage(
        pokemon.image,
        `${shinyTag}🐾 *A WILD POKÉMON APPEARED!*\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `*${pokemon.name}*  ·  ${formatTypes(pokemon.types)}\n\n` +
        `🎯 First to type *${config.prefix}collect ${pokemon.claim}* catches it!`
      )
    }

    // ── ON / OFF (group admins only) — toggles the spawn sweep ───────────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return reply(NOT_ALLOWED)

      const enable = sub === 'on'
      // Save FIRST and bail if it didn't land — see plugins/waifu.js for why
      // the spawn-group list must not be touched after a failed write.
      const res = await saveGroupSettings(ctx.sender, (s) => { s.pokemonEnabled = enable })
      if (!res.ok) return reply(saveFailedMessage('wild Pokémon spawns', res.error))

      const stored = res.settings.pokemonEnabled === true
      if (stored) await addPokemonSpawnGroup(ctx.sender)
      else await removePokemonSpawnGroup(ctx.sender)

      return reply(
        stored
          ? `🐾 *Wild Pokémon Spawn — ON*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `⏱️ A wild Pokémon appears here every *${SPAWN_EVERY}*.\n` +
            `🎯 Catch it with *${config.prefix}collect <code>*.`
          : `🚫 *Wild Pokémon Spawn — OFF*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `No more wild Pokémon will appear in this group.`
      )
    }

    // ── STATUS (default) ──────────────────────────────────────────────────
    const settings = ctx.isGroup ? await getGroupSettings(ctx.sender) : null
    const status = settings?.pokemonEnabled ? 'ON 🟢' : 'OFF 🔴'
    return reply(
      `🐾 *Wild Pokémon Spawn*\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      (ctx.isGroup ? `▸ Status:  *${status}*\n` : '') +
      `▸ Rate:    every *${SPAWN_EVERY}*\n` +
      `▸ Catch:   *${config.prefix}collect <code>*\n\n` +
      `⚙️ *${config.prefix}pokeswitch on* / *off* — _admins only_`
    )
  },
}
