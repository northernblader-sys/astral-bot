/**
 * unstick.js — .unstick [@mention | reply]
 *
 * Owner-only escape hatch for players wedged in a state the normal commands
 * won't let them out of: a battle whose message got deleted, an `inDungeon`
 * flag left true by a crash mid-floor, a party whose leader vanished, an Aura
 * trial the process never finished. Clears every activity lock on the target
 * in one write and puts them back in town.
 *
 * WHAT IT CLEARS — locks only
 *   inBattle / battleState, inDungeon / dungeonFloor, activeEffects,
 *   pvpChallenge, sleepUntil, pendingTrade, hypnosis, reborn.trial +
 *   reborn.offer, party membership (disbanding the party if the target led
 *   it), and location → astral_town.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *   - wallet, inventory, chest, level, xp, stats, statPoints, skills,
 *     dungeonProgress, seasonProgress, ownedCharacters — this is an unstick,
 *     not a reset. Use `.resetplayer` to wipe a save.
 *   - `player.reborn` itself. Only the transient `trial` and `offer` keys go,
 *     exactly as lib/reborn-engine.js drops them when a trial resolves, so a
 *     player who already earned the 150 ceiling keeps it.
 *   - stamina and hunger. They're spent resources, not locks — refilling them
 *     here would make this a cheat command.
 *   - bans, mutes and jail. Those are moderation decisions living in their own
 *     stores, and an unstick must never quietly undo one.
 */
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { resolveTargetId } from './admin.js'
import { getPlayer, updatePlayer } from '../lib/player-repo.js'

const TOWN_ID = 'astral_town'

/**
 * Parties live in db.data.parties keyed by leaderId, and plugins/party.js keeps
 * its own lookup helpers private — so this walks the store directly. Returns
 * the ids of any OTHER members who also need their partyId nulled (a leader
 * being unstuck disbands the party, which frees everyone, mirroring the
 * `dparty leave` path in plugins/party.js).
 */
function clearPartyState(db, targetId, cleared) {
  const parties = db.data?.parties
  if (!parties) return []

  const party = Object.values(parties).find(pt => pt?.members?.includes(targetId))
  if (!party) return []

  if (party.leaderId === targetId) {
    const others = party.members.filter(m => m !== targetId)
    delete parties[party.leaderId]
    cleared.push(others.length
      ? `disbanded their party (they led it — freed ${others.length} other member${others.length === 1 ? '' : 's'})`
      : 'disbanded their party (they led it)')
    return others
  }

  party.members = party.members.filter(m => m !== targetId)
  // A party battle holding a reference to someone who just left would wedge
  // the members left behind, so the encounter goes too.
  if (party.battle) {
    party.battle = null
    cleared.push('cleared party membership + the party\'s active battle')
  } else {
    cleared.push('cleared party membership')
  }
  return []
}

export default {
  name:           'unstick',
  aliases:        ['clearstate', 'freeplayer'],
  category:       'admin',
  requiresPlayer: false,
  description:    `${config.prefix}unstick [@user] — owner-only: clear every activity lock (battle, dungeon, party, trial, sleep) on a player without touching their progress.`,

  async run(ctx) {
    const { db, reply } = ctx
    const p = config.prefix

    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return reply(`❌ This command is restricted to the bot owner.`)
    }

    const targetId = resolveTargetId(ctx)
    const target = getPlayer(db, targetId)
    if (!target) {
      return reply(`❌ That player isn't registered yet — nothing to unstick.`)
    }

    const cleared = []

    // Party store lives outside the player record, so it's handled first. The
    // mutation is persisted by the updatePlayer() call below, which flushes the
    // whole db through the shared write queue.
    const alsoFreed = clearPartyState(db, targetId, cleared)

    await updatePlayer(db, targetId, (pl) => {
      if (pl.inBattle || pl.battleState) {
        const foe = pl.battleState?.enemy?.name
        pl.inBattle    = false
        pl.battleState = null
        cleared.push(foe ? `cleared battle vs *${foe}*` : 'cleared battle flag')
      }

      if (pl.inDungeon || (pl.dungeonFloor ?? 0) > 0) {
        const floor = pl.dungeonFloor ?? 0
        pl.inDungeon   = false
        pl.dungeonFloor = 0
        cleared.push(`cleared dungeon state${floor > 0 ? ` (was Floor ${floor})` : ''}`)
      }

      if (pl.activeEffects?.length) {
        cleared.push(`cleared ${pl.activeEffects.length} status effect${pl.activeEffects.length === 1 ? '' : 's'}`)
        pl.activeEffects = []
      }

      if (pl.pvpChallenge) {
        pl.pvpChallenge = null
        cleared.push('cleared pending PvP challenge')
      }

      if (pl.sleepUntil) {
        pl.sleepUntil = null
        cleared.push('cleared sleep timer')
      }

      if (pl.pendingTrade) {
        pl.pendingTrade = null
        cleared.push('cleared pending roam trade')
      }

      if (pl.hypnosis) {
        delete pl.hypnosis
        cleared.push('cleared hypnosis snapshot')
      }

      // Only the transient trial keys — never player.reborn itself.
      if (pl.reborn?.trial || pl.reborn?.offer) {
        delete pl.reborn.trial
        delete pl.reborn.offer
        cleared.push('cleared unfinished Aura trial')
      }

      if (pl.partyId) pl.partyId = null

      if (pl.location !== TOWN_ID) {
        cleared.push(`moved to town (was in \`${pl.location}\`)`)
        pl.location = TOWN_ID
      }

      return pl
    })

    for (const memberId of alsoFreed) {
      await updatePlayer(db, memberId, (mp) => { mp.partyId = null; return mp })
    }

    if (!cleared.length) {
      return reply(
        `✨ *${target.name}* wasn't stuck on anything — no locks found.\n` +
        `_Already free to act._`,
      )
    }

    return reply(
      `🔓 *UNSTUCK — ${target.name}*\n` +
      `─────────────────────\n` +
      cleared.map(c => `▹ ${c}`).join('\n') + `\n\n` +
      `_Progress, gear and currency untouched. Use *${p}resetplayer* to wipe a save instead._`,
    )
  },
}
