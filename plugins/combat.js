/**
 * combat.js — Combat help command.
 *
 * Shows all available combat commands. The actual battle logic is split into:
 *   attack.js, skill.js, defend.js, flee.js
 */
import { config } from '../config.js'

export default {
  name: 'combat',
  aliases: ['battle'],
  category: 'combat',
  requiresPlayer: false,
  description: 'Show combat command reference',

  async run(ctx) {
    const p = config.prefix
    await ctx.reply(
      `⚔️ *COMBAT COMMANDS*\n\n` +
      `*${p}attack*  _(alias: atk, a)_\n  Basic attack using your primary stat.\n\n` +
      `*${p}skill <name>*  _(alias: sk, s)_\n  Use an active skill. Costs MP.\n  Type *${p}skill* alone to list your skills.\n\n` +
      `*${p}defend*  _(alias: def, d)_\n  Guard stance — doubles DEF, recovers 5% MP.\n\n` +
      `*${p}flee*  _(alias: run, escape)_\n  35%+LCK chance to escape. Cannot flee bosses.\n\n` +
      `*DUNGEON*\n` +
      `*${p}enter <dungeon>* — Enter a dungeon\n` +
      `*${p}dungeon* — Advance to next floor\n` +
      `*${p}dungeon leave* — Save and exit\n\n` +
      `*TOWN*\n` +
      `*${p}inn* — Restore HP/MP at Astral Town\n` +
      `*${p}ranking* — View leaderboards`,
    )
  },
}
