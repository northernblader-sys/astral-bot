/**
 * work.js — thin command wrapper around jobs.js's shift logic.
 * Kept as a separate file because the plugin loader only registers one
 * command name (+ aliases) per file's default export, and `.work` needs to
 * be its own top-level command rather than a subcommand of `.jobs`.
 */
import { work } from './jobs.js'

export default {
  name: 'work',
  aliases: [],
  category: 'economy',
  requiresPlayer: true,
  description: 'Do a shift at your job (30 min cooldown)',

  async run(ctx) {
    return work(ctx)
  },
}
