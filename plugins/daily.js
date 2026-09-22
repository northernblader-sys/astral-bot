/**
 * daily — claim a once-per-day reward of Solars, XP, and stamina.
 *
 * Usage: <prefix>daily
 *
 * Resets at midnight (local server time). Consecutive-day claims build a
 * streak (bonus grows daily, caps at 7 days); missing a full day resets the
 * streak back to 1 on the next claim.
 *
 * ALSO the live owner of the `.claim` key: 'claim' is this plugin's alias, and
 * the loader hands a same-platform alias collision to the LAST plugin
 * registered (lib/plugin-manager.js resolvePlugin), which by file-load order is
 * this one rather than plugins/claim.js. So `.claim` lands here. Since `.claim
 * <code>` is how a spawned card/series gets grabbed, a typed claim code is
 * routed on to the shared spawn-claim helper below instead of being ignored —
 * otherwise a player's code silently buys them a daily reward and the spawn
 * stays on the floor. A bare `.claim`/`.daily` is the daily reward, unchanged.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { levelsData, classes, races, getTotalStats } from '../lib/game-data.js'
import { applyLevelUps } from '../lib/combat-engine.js'
import { hasMod } from '../lib/mods.js'
import { sendRankUp } from '../lib/rank-up.js'
import { claimActiveSpawn, looksLikeClaimCode } from './collect.js'

const BASE_SOLARS        = 50
const PER_LEVEL_SOLARS   = 3
const STREAK_BONUS_PER_DAY = 15
const STREAK_CAP         = 7
const STAMINA_RESTORE    = 10
const BASE_XP            = 20
const XP_PER_LEVEL       = 2

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export default {
  name:           'daily',
  aliases:        ['claim'],
  category:       'economy',
  requiresPlayer: true,
  description:    'Claim your daily Solars, XP, and stamina reward',

  async run(ctx) {
    const p = config.prefix

    // ── `.claim <code>` — a spawn claim, not a daily claim ──────────────
    // Card and series spawns both print "type .collect <code>", and `.claim`
    // is the obvious synonym, so this is the single most-typed variant of the
    // command. Gated on the code SHAPE (6 chars of A–Z/2–9, see
    // looksLikeClaimCode) rather than just "any argument", so `.daily extra`
    // and other stray text still fall through to the daily reward instead of
    // being answered with "no card is spawned here".
    const codeArg = (ctx.args?.[0] ?? '').trim()
    if (looksLikeClaimCode(codeArg)) return claimActiveSpawn(ctx, codeArg)

    let outcome = null

    await updatePlayer(ctx.db, ctx.from, player => {
      const now          = Date.now()
      const todayStart   = startOfDay(now)
      const last         = player.lastDailyClaim ?? 0
      const lastDayStart = last ? startOfDay(last) : null

      if (lastDayStart === todayStart) {
        // Cheat mod: Double Dawn (extra_daily_claim) — grants exactly one
        // bonus claim per day, tracked separately from lastDailyClaim so
        // this branch can't be re-entered a second time the same day.
        // bonusDailyClaimedOn stores the same startOfDay() value so it's
        // comparable the same way lastDayStart is.
        const bonusAlreadyUsed = player.bonusDailyClaimedOn === todayStart
        if (hasMod(player, 'extra_daily_claim') && !bonusAlreadyUsed) {
          player.bonusDailyClaimedOn = todayStart
          // Falls through to the normal claim logic below by NOT
          // returning here — streak logic still uses lastDayStart/
          // lastDailyClaim as normal, this claim just doesn't update
          // lastDailyClaim a second time (see bonus branch below).
        } else {
          const next = new Date(todayStart + 24 * 60 * 60 * 1000)
          outcome = { already: true, next }
          return player
        }
      }

      const isBonusClaim = lastDayStart === todayStart // only true when the branch above let a bonus claim through

      const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
      const isConsecutive  = lastDayStart === yesterdayStart

      // Bonus claim keeps the existing streak as-is (it's not a new day,
      // so it neither extends nor resets the streak) and does NOT
      // overwrite lastDailyClaim — tomorrow's claim still compares
      // against the ORIGINAL claim time for its own consecutive-day check.
      if (!isBonusClaim) {
        player.dailyStreak    = isConsecutive ? (player.dailyStreak ?? 0) + 1 : 1
        player.lastDailyClaim = now
      }

      const streakDays   = Math.min(player.dailyStreak ?? 1, STREAK_CAP)
      const solarsReward = BASE_SOLARS + player.level * PER_LEVEL_SOLARS + streakDays * STREAK_BONUS_PER_DAY
      const xpReward     = BASE_XP + player.level * XP_PER_LEVEL

      if (!player.wallet) player.wallet = {}
      player.wallet.solars = (player.wallet.solars ?? 0) + solarsReward
      player.xp = (player.xp ?? 0) + xpReward

      const { msgs: lvlMsgs, rankChange } = applyLevelUps(player, levelsData, classes, races, getTotalStats)

      let staminaAfter = player.stamina?.current ?? 0
      if (player.stamina) {
        player.stamina.current = Math.min(player.stamina.max, player.stamina.current + STAMINA_RESTORE)
        staminaAfter = player.stamina.current
      }

      outcome = {
        already: false,
        solarsReward,
        xpReward,
        streak: player.dailyStreak,
        staminaAfter,
        staminaMax: player.stamina?.max ?? '?',
        lvlMsgs,
        rankChange,
        playerName: player.name,
      }
      return player
    })

    if (outcome.already) {
      return ctx.reply(
        `⏳ You've already claimed today's reward.\nCome back after *${outcome.next.toLocaleTimeString()}*.`,
      )
    }

    const caption =
      `☀️ Solars: *+${outcome.solarsReward}*\n` +
      `✨ XP: *+${outcome.xpReward}*\n` +
      `⚡ Stamina: *+${STAMINA_RESTORE}* _(now ${outcome.staminaAfter}/${outcome.staminaMax})_\n\n` +
      `🔥 Streak: *${outcome.streak} day${outcome.streak === 1 ? '' : 's'}*` +
      (outcome.streak < STREAK_CAP ? ` _(bonus grows until day ${STREAK_CAP})_` : ` _(max streak bonus)_`) +
      (outcome.lvlMsgs.length ? `\n\n${outcome.lvlMsgs.join('\n')}` : '') +
      `\n\n_Come back tomorrow to keep your streak alive!_`

    await ctx.reply(`🎁 *Daily Reward Claimed!*\n\n${caption}`)

    // Rank promotion — separate message so it stands out (dedicated rank-up card)
    if (outcome.rankChange) {
      await sendRankUp(ctx, outcome.playerName ?? 'Hunter', outcome.rankChange.from, outcome.rankChange.to)
    }
  },
}
