/**
 * rob.js — risk/reward theft attempt against another registered player.
 *
 * Usage: <prefix>rob (reply to or @mention the target)
 *
 * Design notes:
 *  - Mirrors plugins/jobs.js's `.work` cooldown shape exactly: a single
 *    epoch-ms timestamp field (`lastRobAt`) checked against a fixed
 *    duration (`ROB_COOLDOWN_MS`), same updatePlayer + Date.now() pattern.
 *  - Target resolution reuses transfer.js's `resolveTargetJid` pattern
 *    (reply -> @mention -> raw phone number) since, like `.send`, `.rob`
 *    targets another *registered player*, not a group member generically
 *    (which is what kick.js's simpler extractTarget is for).
 *  - Amount is 25% of the ROBBER's own last `.work` payout, never the
 *    victim's balance — this is deliberate (see spec): robbing a rich
 *    player nets exactly the same as robbing a poor one, so there's no
 *    incentive to single out wealthy targets.
 *  - No check for "is the target asleep at the inn" — lib/sleep-engine.js
 *    and handler.js's inn lockout only ever gate the *actor's own* asleep
 *    state (see handler.js), there is no existing precedent anywhere in
 *    this codebase for blocking an action because of another player's
 *    (the target's) state in that way, so this assumption is intentionally
 *    not enforced here.
 */
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'
import { updatePlayer, getPlayer, playerExists } from '../lib/player-repo.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { jailPlayer } from '../lib/jail-repo.js'

const ROB_COOLDOWN_MS = 60 * 60 * 1000 // 60 minutes
const SUCCESS_CHANCE = 0.60
const HP_SCRAPE_PCT = 0.05

// ── Jail sentence ─────────────────────────────────────────────────────────
// TUNABLE: how long a caught robber is locked out for (first-offence baseline).
// Adjust freely — 20 min is a punchy but not punishing starting point.
const ROB_JAIL_MS = 20 * 60 * 1000 // 20 minutes

/** Same reply-quote -> @mention -> raw-number resolution used by .send. */
function resolveTargetJid(ctx, raw) {
  const contextInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo
  if (contextInfo?.participant) return contextInfo.participant
  if (contextInfo?.mentionedJid?.length) return contextInfo.mentionedJid[0]
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

const SUCCESS_LINES = [
  'You slip in, lift the pouch, and vanish into the crowd.',
  'A quick hand and a sharp eye — nobody even noticed.',
  'You lift their coin purse clean before they can react.',
]
const FAIL_LINES = [
  'They catch your wrist mid-reach and things get ugly fast.',
  'Your hand freezes on their pocket — they were already watching.',
  'A shout goes up before you can even grab anything.',
]

// Shown immediately after the failed-rob narrative, before the player
// discovers they're sentenced. Same rotation style as FAIL_LINES.
const ARREST_LINES = [
  'A guard materialises from the shadows — your wrist is in irons before you can blink.',
  'Turns out the "easy mark" was a plainclothes enforcer. The judge is not amused.',
  'The Watch was waiting the whole time. A whistle, a net, and suddenly the world is a cell.',
  "You're halfway down the alley when a crossbow bolt buries itself in the wall beside your ear. \"Hands where I can see 'em.\"",
]

export default {
  name: 'rob',
  aliases: [],
  category: 'economy',
  requiresPlayer: true,
  description: 'Attempt to rob another player (60 min cooldown)',

  async run(ctx) {
    const p = config.prefix
    const targetJid = resolveTargetJid(ctx, ctx.args?.[0])

    await updatePlayer(ctx.db, ctx.from, async robber => {
      if (!targetJid) {
        await ctx.reply(
          `❓ Usage: *${p}rob* — reply to or @mention the player you want to rob.\n` +
          `Example: *${p}rob @target*`,
        )
        return robber
      }
      if (targetJid === ctx.from) {
        await ctx.reply(`❌ You can't rob yourself.`)
        return robber
      }
      if (isOwnerJid(targetJid)) {
        await ctx.reply(`❌ You wouldn't dare rob the bot owner.`)
        return robber
      }
      if (!playerExists(ctx.db, targetJid)) {
        await ctx.reply(`❌ That player isn't registered yet.`)
        return robber
      }
      if (robber.inDungeon) {
        await ctx.reply(`⚠️ You can't rob anyone while in a dungeon!`)
        return robber
      }
      if (robber.inBattle) {
        await ctx.reply(`⚠️ You can't rob anyone during a battle!`)
        return robber
      }

      const victim = getPlayer(ctx.db, targetJid)
      if (victim.inDungeon) {
        await ctx.reply(`⚠️ *${victim.name}* is deep in a dungeon — you can't reach them right now.`)
        return robber
      }
      if (victim.inBattle) {
        await ctx.reply(`⚠️ *${victim.name}* is mid-battle — too risky to try right now.`)
        return robber
      }

      if (!robber.lastWorkAmount) {
        await ctx.reply(
          `❌ *You've never worked a shift.*\n\n` +
          `Use *${p}work* first — robbing requires knowing the streets, and a job is how you learn them.`,
        )
        return robber
      }

      const now = Date.now()
      const nextAvailable = robber.lastRobAt ? robber.lastRobAt + ROB_COOLDOWN_MS : 0
      if (now < nextAvailable) {
        const remainMs = nextAvailable - now
        const mins = Math.ceil(remainMs / 60000)
        await ctx.reply(
          `⏳ *Still laying low from your last attempt.*\n\n` +
          `Next shift available in: *${mins} min*\n\n` +
          `_Rest up, then try again._ 🕶️`,
        )
        return robber
      }

      robber.lastRobAt = now
      robber.wallet = robber.wallet ?? {}

      const amount = Math.max(1, Math.floor(robber.lastWorkAmount * 0.25))
      const success = Math.random() < SUCCESS_CHANCE

      if (success) {
        let stolen = 0
        await updatePlayer(ctx.db, targetJid, async v => {
          v.wallet = v.wallet ?? {}
          const victimSolars = v.wallet.solars ?? 0
          stolen = Math.min(amount, victimSolars)
          v.wallet.solars = Math.max(0, victimSolars - stolen)
          return v
        })

        robber.wallet.solars = (robber.wallet.solars ?? 0) + stolen
        const narrative = SUCCESS_LINES[Math.floor(Math.random() * SUCCESS_LINES.length)]

        let msg = `┌─────────────────────┐\n`
        msg += `│   🥷 *ROB SUCCESS*   │\n`
        msg += `└─────────────────────┘\n\n`
        msg += `_${narrative}_\n\n`
        msg += `🎯 Target: *${victim.name}*\n`
        msg += `☀️ Stolen: *+${stolen} solars*\n`
        msg += `💰 Your balance: *${robber.wallet.solars.toLocaleString()} solars*\n\n`
        msg += `⏳ _Next attempt available in 60 minutes_`
        await sendImage(ctx, 'rob_success_card.jpg',
          `*Astral Heist*\nAnother mark, lighter pockets\n\n${msg}`)
      } else {
        const fine = Math.min(amount, robber.wallet.solars ?? 0)
        robber.wallet.solars = Math.max(0, (robber.wallet.solars ?? 0) - fine)

        const scrape = Math.max(1, Math.floor(robber.maxHp * HP_SCRAPE_PCT))
        const hpBefore = robber.hp
        robber.hp = Math.max(1, robber.hp - scrape)
        const hpLost = hpBefore - robber.hp

        const narrative = FAIL_LINES[Math.floor(Math.random() * FAIL_LINES.length)]

        let msg = `┌─────────────────────┐\n`
        msg += `│   🚨 *ROB FAILED*   │\n`
        msg += `└─────────────────────┘\n\n`
        msg += `_${narrative}_\n\n`
        msg += `🎯 Target: *${victim.name}*\n`
        msg += `💸 Fine: *-${fine} solars*\n`
        msg += `🩸 You take a scrape: *-${hpLost} HP*\n`
        msg += `💰 Your balance: *${robber.wallet.solars.toLocaleString()} solars*\n`
        msg += `❤️ HP: *${robber.hp}/${robber.maxHp}*\n\n`
        msg += `⏳ _Next attempt available in 60 minutes_`

        // ── Jail ─────────────────────────────────────────────────────────
        const arrest = ARREST_LINES[Math.floor(Math.random() * ARREST_LINES.length)]
        msg += `\n\n🔒 *ARRESTED* — _${arrest}_\n_Sentence: ${ROB_JAIL_MS / 60000} min. No commands until you're released._`
        await sendImage(ctx, 'rob_fail_card.jpg',
          `*Astral Heist Gone Wrong*\nCaught red-handed and thrown in a cell\n\n${msg}`)
        await jailPlayer(ctx.db, ctx.from, ROB_JAIL_MS, 'robbery')
      }

      return robber
    })
  },
}
