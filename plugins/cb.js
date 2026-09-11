/**
 * cb.js — "Clear Battle": emergency escape hatch for players stuck in a
 * broken battle state.
 *
 * Why this exists: a handful of bugs (missing enemy on battleState, a
 * plugin throwing mid-turn, etc.) can leave player.inBattle === true with
 * a battleState that no in-battle command can safely resolve. When that
 * happens the player is locked out of every command by handler.js's
 * BATTLE_ALLOWED_COMMANDS gate and has no way back in — flee/attack/skill
 * just throw the same error again. `cb` forces player.inBattle/battleState
 * back to a clean, empty state regardless of what shape it's currently in,
 * so the player can leave and try again.
 *
 * IMPORTANT: `cb` must itself be added to handler.js's
 * BATTLE_ALLOWED_COMMANDS set, otherwise the same in-battle gate that
 * traps the player would also block `cb`.
 *
 * Design notes:
 *  - Never throws: reads battleState defensively (optional chaining
 *    everywhere) since the whole point is to recover from a corrupted or
 *    unexpected shape.
 *  - PvP-aware: if the stuck state is a live PvP duel, forfeits it and
 *    best-effort notifies the opponent so *their* side doesn't end up
 *    waiting on a battle that no longer exists. The opponent's own
 *    battleState is only cleared if they were actually still bound to
 *    this duel (their opponentJid still points back at the caller) —
 *    cb never touches an unrelated battle.
 *  - Does not refund/reward/penalize anything and does not touch HP/MP,
 *    inventory, or dungeon progress — it only unsticks battle flags. This
 *    is a bug-recovery tool, not a "give up for a reward" button.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'

export default {
  name: 'cb',
  aliases: ['clearbattle', 'resetbattle', 'unstuck'],
  category: 'combat',
  requiresPlayer: true,
  description: 'Force-clear a stuck/broken battle state so you can act again.',

  async run(ctx) {
    const p = config.prefix
    let wasInBattle = false
    let battleType = null
    let opponentJid = null

    await updatePlayer(ctx.db, ctx.from, (player) => {
      wasInBattle = !!player.inBattle || !!player.battleState
      battleType  = player.battleState?.type ?? null
      opponentJid = player.battleState?.opponentJid ?? null

      player.inBattle    = false
      player.battleState = null

      return player
    })

    if (!wasInBattle) {
      await ctx.reply(`✅ *You're not in battle* — nothing to clear.`)
      return
    }

    // Best-effort: if this was a PvP duel, let the opponent's side go too,
    // but only if they're still actually paired with this player (don't
    // clobber an opponent who has already moved on to something else).
    if (battleType === 'pvp' && opponentJid) {
      try {
        await updatePlayer(ctx.db, opponentJid, (opp) => {
          if (opp.battleState?.opponentJid === ctx.from) {
            opp.inBattle    = false
            opp.battleState = null
          }
          return opp
        })
        await ctx.reply(
          `🧹 *Battle state cleared.*\n` +
          `⚔️ Your PvP duel was forfeited — your opponent has also been freed from it.\n` +
          `_You're free to use other commands again._`,
        )
      } catch {
        await ctx.reply(
          `🧹 *Battle state cleared.*\n` +
          `⚔️ Your PvP duel was forfeited. _(Couldn't reach your opponent's data to clear their side — if they're stuck, they can run *${p}cb* themselves.)_`,
        )
      }
      return
    }

    await ctx.reply(
      `🧹 *Battle state cleared.*\n` +
      `_If a bug caused this, please let the bot owner know what command you ran right before getting stuck — that helps get it fixed for good._\n` +
      `_You're free to use other commands again._`,
    )
  },
}
