/**
 * claim.js — grab a spawned anime card OR anime series by its claim code.
 * Usage: .claim <code>
 *
 * Two things about this plugin that are easy to get wrong:
 *
 * 1. It claims cards AND series. Both spawn types advertise a 6-char code and
 *    players reach for `.claim` for either, so a series code must not come back
 *    "no card is currently spawned here". The actual match/payout lives in
 *    plugins/collect.js's exported claimActiveSpawn() so `.claim` and
 *    `.collect` can never drift apart — that shared helper also covers wild
 *    Pokémon, which costs nothing here and keeps one code path.
 *
 * 2. `.claim` may not actually be dispatched here. plugins/daily.js registers
 *    'claim' as an alias of the daily reward, and the loader gives a
 *    same-platform alias collision to the LAST plugin registered
 *    (lib/plugin-manager.js resolvePlugin) — currently daily.js, by file-load
 *    order. daily.js therefore routes `.claim <code>` into claimActiveSpawn()
 *    itself. This plugin is kept correct so the command works either way:
 *    whoever holds the 'claim' key, a typed code claims the spawn.
 *
 * See handler.js for the spawn hook and lib/card-engine.js / lib/series-engine.js
 * for storage.
 */
import { config } from '../config.js'
import { claimActiveSpawn } from './collect.js'

export default {
  name: 'claim',
  aliases: [],
  category: 'cards',
  requiresPlayer: true,
  description: 'Claim a spawned anime card or series with its claim code',

  async run(ctx) {
    const { args, reply } = ctx
    const code = (args[0] ?? '').trim()
    if (!code) return reply(`❌ *Usage:* *${config.prefix}claim <code>*`)
    return claimActiveSpawn(ctx, code)
  },
}
