/**
 * cb.js — "Clear Battle": emergency escape hatch for players stuck in a
 * broken battle state. OWNER-ONLY since the abuse lockdown: regular players
 * can no longer run it (it was a free "leave any fight, no penalty" button
 * in practice, and party battles made it worse — clearing your own flags
 * mid-party left the shared fight inconsistent for everyone else). The bot
 * owner runs it instead, on themselves or ON A TAGGED PLAYER:
 *
 *   .cb              — clear YOUR OWN stuck battle state (owner only)
 *   .cb @player      — clear a TAGGED player's stuck state (owner only);
 *                      also replies to / numbers work as the target
 *
 * Why this exists: a handful of bugs (missing enemy on battleState, a
 * plugin throwing mid-turn, a stuck party battle) can leave a player
 * inBattle === true with state no in-battle command can safely resolve.
 * `cb` forces the flags back to a clean, empty state regardless of what
 * shape they're currently in, and repairs the target's party side too
 * (settles a won-but-unsettled party battle, clears orphaned inBattle
 * flags — see repairPartyState in plugins/party.js).
 *
 * IMPORTANT: `cb` must stay in handler.js's BATTLE_ALLOWED_COMMANDS set,
 * otherwise the same in-battle gate that traps the player would also block
 * the owner from reaching this command. Non-owners are refused here in the
 * plugin itself, so keeping it gate-legal doesn't reopen the loophole.
 *
 * Design notes:
 *  - Never throws: reads battleState defensively (optional chaining
 *    everywhere) since the whole point is to recover from a corrupted or
 *    unexpected shape.
 *  - PvP-aware: if the cleared state was a live PvP duel, forfeits it and
 *    best-effort notifies the opponent so THEIR side doesn't end up
 *    waiting on a battle that no longer exists.
 *  - The self-clear keeps the live-boss-fight guard (you can't .cb out of
 *    a boss you're losing). Clearing a TAGGED player bypasses it — that's
 *    the owner's rescue tool for a softlocked player, the owner decides.
 *  - Does not refund/reward/penalize anything and does not touch HP/MP,
 *    inventory, or dungeon progress — it only unsticks battle flags.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { isLiveBossFight } from '../lib/boss-engine.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { repairPartyState } from './party.js'

/** Resolve a tagged/replied/typed target jid, or null when none given. */
function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

export default {
  name: 'cb',
  aliases: ['clearbattle', 'resetbattle', 'unstuck'],
  category: 'combat',
  requiresPlayer: true,
  description: '(Owner only) Force-clear a stuck battle state — yours or a tagged player\'s.',

  async run(ctx) {
    const p = config.prefix

    // ── Owner gate ──────────────────────────────────────────────────────────
    // .cb is owner-only now. Regular players are told who to ask. (The
    // command stays in handler.js's BATTLE_ALLOWED_COMMANDS so the OWNER can
    // still reach it while in-battle; this plugin-level gate is what keeps
    // everyone else out.)
    if (!isOwnerJid(ctx.from)) {
      await ctx.reply(
        `🚫 *.cb* is restricted to the bot owner.\n` +
        `_If you're stuck in a battle, try *${p}flee* — or contact the owner to get your state cleared._`,
      )
      return
    }

    const targetRaw = ctx.args[0]
    const targetJid = resolveTargetJid(ctx, targetRaw)

    // ── Tagged target: clear SOMEONE ELSE's stuck state ────────────────────
    // Owner override — the live-boss guard does not apply here: an owner
    // clearing a tagged player is a deliberate rescue, not a fight escape.
    if (targetJid && targetJid !== ctx.from) {
      const targetPlayer = ctx.db.data.users[targetJid]
      if (!targetPlayer) {
        await ctx.reply(`❌ That player isn't registered — nothing to clear.`)
        return
      }
      const targetName = targetPlayer.name ?? targetJid.split('@')[0]

      let wasInBattle = false
      let battleType = null
      let opponentJid = null

      await updatePlayer(ctx.db, targetJid, (player) => {
        wasInBattle = !!player.inBattle || !!player.battleState
        battleType = player.battleState?.type ?? null
        opponentJid = player.battleState?.opponentJid ?? null

        player.inBattle = false
        player.battleState = null
        return player
      })

      // Repair their party side too: settle a won-but-unsettled party battle
      // and drop any stale inBattle flag left on them by it.
      const party = ctx.db.data.parties
        ? (ctx.db.data.parties[targetJid] ??
          Object.values(ctx.db.data.parties).find(pt => pt.members?.includes(targetJid)) ??
          null)
        : null
      if (party) {
        try { await repairPartyState(ctx, party) } catch {}
        if (party.battle) {
          // Battle is live (not settleable) — just pull the tagged player out
          // of it so they're not flagged into a fight they can't act in.
          await updatePlayer(ctx.db, targetJid, (player) => {
            player.inBattle = false
            return player
          })
        }
      }

      // Free the other side of a live PvP duel, best-effort.
      if (battleType === 'pvp' && opponentJid) {
        try {
          await updatePlayer(ctx.db, opponentJid, (opp) => {
            if (opp.battleState?.opponentJid === targetJid) {
              opp.inBattle = false
              opp.battleState = null
            }
            return opp
          })
        } catch {}
      }

      await ctx.reply(
        `🧹 *${targetName}'s battle state cleared.*\n` +
        (wasInBattle
          ? `⚔️ Their in-battle flags were reset and any stuck party battle was settled.\n`
          : `✅ They weren't flagged in battle — party state checked anyway.\n`) +
        `_They can use commands normally again._`,
      )
      return
    }

    // ── Self-clear (owner, no target) ────────────────────────────────────────
    // Defense in depth: handler.js's in-battle gate already blocks .cb during a
    // LIVE boss fight, so this rarely fires — but it keeps the rule local and
    // bulletproof for the owner's own fights. A CORRUPTED boss state (no enemy
    // / dead HP) is NOT a live boss fight, so .cb still clears it below and no
    // one is ever left softlocked.
    if (isLiveBossFight(ctx.player)) {
      await ctx.reply(
        `👑 *You can't clear out of a boss fight.*\n` +
        `Defeat it, fall, or wait out your 5 minute turn timer.`,
      )
      return
    }

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

    // Repair the owner's own party side while we're here.
    const ownParty = ctx.db.data.parties
      ? (ctx.db.data.parties[ctx.from] ??
        Object.values(ctx.db.data.parties).find(pt => pt.members?.includes(ctx.from)) ??
        null)
      : null
    if (ownParty) {
      try { await repairPartyState(ctx, ownParty) } catch {}
    }

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
          `⚔️ Your PvP duel was forfeited. _(Couldn't reach your opponent's data to clear their side — if they're stuck, tag them with *${p}cb @player*.)_`,
        )
      }
      return
    }

    await ctx.reply(
      `🧹 *Battle state cleared.*\n` +
      `_If a bug caused this, please note what command was run right before getting stuck — that helps get it fixed for good._\n` +
      `_You're free to use other commands again._`,
    )
  },
}
