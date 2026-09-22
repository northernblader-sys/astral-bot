/**
 * dungeon-reset.js — .dungeon-reset all   (owner-only, server-wide)
 *
 * Wipes every player's dungeon progress (highestFloor + conquered on every
 * dungeon), drops anyone out of an in-progress run, and relocks the dungeon
 * chain so the whole server climbs again from scratch.
 *
 * The relock is enforced by a per-player `dungeonsRelocked` flag that
 * isDungeonUnlocked (plugins/dungeon.js) reads: while it is set, the level
 * bypass is suspended and a dungeon only opens once its prerequisite is
 * conquered again. entry_tower and season_01_ruins have no prerequisite, so
 * they stay open; every other tower must be re-earned.
 *
 * The literal `all` argument is required as a confirmation: this is a
 * one-command wipe of every account's dungeon progress, so a bare
 * `.dungeon-reset` only prints a warning and does nothing.
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { updateAllPlayers } from '../lib/player-repo.js'
import { clearDungeonSlots } from '../lib/dungeon-slots.js'

export default {
  name:           'dungeon-reset',
  aliases:        ['dungeonreset', 'resetdungeons'],
  category:       'admin',
  requiresPlayer: false,
  description:    "Owner-only: wipe every player's dungeon progress and relock the dungeons",

  async run(ctx) {
    const p = config.prefix

    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    if ((ctx.args?.[0] ?? '').toLowerCase() !== 'all') {
      return ctx.reply(
        `⚠️ *Dungeon reset (server-wide)*\n\n` +
        `This wipes *every* player's dungeon progress. Highest floors and conquered towers are cleared, anyone mid-run is dropped out, and every dungeon past the first is relocked until its tower is conquered again.\n\n` +
        `_Type_ *${p}dungeon-reset all* _to confirm._`,
      )
    }

    let count = 0
    await updateAllPlayers(ctx.db, (users) => {
      for (const player of Object.values(users ?? {})) {
        if (!player) continue
        player.dungeonProgress = {}
        // Drop any active run so nobody is stranded in a now-reset dungeon,
        // mirroring the exit-to-town state handleLeave leaves behind.
        player.inDungeon         = false
        player.inBattle          = false
        player.battleState       = null
        player.dungeonFloor      = 0
        player.dungeonCheckpoint = 0
        // Relock: suspend the level bypass in isDungeonUnlocked until each
        // tower's prerequisite is conquered again.
        player.dungeonsRelocked  = true
        count++
      }
      return count > 0
    })
    clearDungeonSlots()

    return ctx.reply(
      `✅ *Dungeon reset complete.*\n\n` +
      `🗺️ *${count}* player${count === 1 ? '' : 's'} reset.\n` +
      `All dungeon progress wiped and every tower past the first relocked. Each tower must be conquered again to reopen the next.`,
    )
  },
}
