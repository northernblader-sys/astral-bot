/**
 * stream.js — Live Streaming, a Premium-only perk.
 *
 * Usage:
 *   .stream on|off  — GROUP ADMIN: allow/disallow streaming in this group
 *   .stream start   — go live (requires active Premium + 1,000+ fame)
 *   .stream chat     — engage viewers during a live stream (required to unlock each round's gifts)
 *   .stream end     — end your stream early
 *   .stream status  — check current stream stats
 *
 * Streaming is a GROUP-OPT-IN feature (streamingEnabled in
 * lib/group-settings.js, OFF by default), for the same reason .dungeon and
 * .waifu are: a live stream posts its own unprompted round messages into the
 * chat every few minutes, so a group has to ask for it first. `.stream start`
 * is refused outside a group and in any group that hasn't turned it on.
 *
 * Streaming is also a DUNGEON-COMBAT feature: you can only go live inside a
 * dungeon, the stream cuts out the moment you leave one (armDungeonCheck),
 * and the crowd grows every time you take a combat action while live
 * (rampStreamViewers, called from plugins/attack.js and plugins/skill.js).
 * That live viewer count is what powers the Streamer character's
 * `.live-blast` — see plugins/liveblast.js and getStreamViewers() below.
 *
 * Viewers are simulated NPCs. Gifts (Solars, rare Gems) only roll after the
 * streamer actively engages chat each round — see ENGAGE_WINDOW_MS below.
 * This is intentional: streaming used to auto-pay on a pure timer, which let
 * a player run `.stream start` and walk away entirely and still collect
 * currency every 5 minutes for doing nothing. Now each round posts a prompt
 * and requires a `.stream chat` reply within the window, or that round's
 * gifts are skipped; two skipped rounds in a row ends the stream.
 *
 * See lib/premium.js for isPremiumActive() and plugins/premium.js for the
 * purchase flow.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { roundGems } from '../lib/format.js'
import { getFameTier, formatFame } from '../lib/fame-engine.js'
import { isPremiumActive } from '../lib/premium.js'
import { jailPlayer } from '../lib/jail-repo.js'
import { getGroupSettings, handleBoolToggle } from '../lib/group-settings.js'

const STREAM_DURATION_MS = 20 * 60 * 1000
const TICK_INTERVAL_MS   =  5 * 60 * 1000
// Streaming is now a Premium perk (used to be fame-gated only). Fame still
// affects viewer count/crowd size once you're allowed to go live at all.
const MIN_FAME_TO_STREAM = 1_000

// How long the streamer has, after each tick's chat prompt, to reply with
// .stream chat before that round's gifts are forfeited.
const ENGAGE_WINDOW_MS = 90 * 1000
// Consecutive missed engage windows before the stream auto-ends for inactivity.
const MAX_MISSED_TICKS = 2

// If a player opens a stream and does nothing at all (no .stream chat, no
// commands) for this long, they're jailed for AFK_JAIL_MS.
const AFK_TIMEOUT_MS = 5 * 60 * 1000
const AFK_JAIL_MS    = 60 * 60 * 1000

// How often to check that the streamer is still in a dungeon and in battle.
const DUNGEON_CHECK_MS = 15 * 1000

const activeStreams = new Map() // playerId -> stream state

const NPC_NAMES = [
  'MoonlitArcher','VoidWalker_Z','SkyFalcon','StarlightMage','ShadowPulse',
  'FrostbiteAce','ThunderClaw','EchoStrike','VenomDash','RavenHex',
  'EmberReign','NeonSpectre','WarpLancer','MidnightRogue','CosmicBrawler',
  'HexBladeV2','TwilightProwler','GoldenThorn','IceCrusher88','RuneScribe',
  'WraithRunner','ArcaneBlood','DuskRaider','WildfireEcho','SilverFang',
]

const COMMENTS = [
  'POGGERS 🔥', "LET'S GOOO", 'W streamer', 'insane damage', 'no way',
  'GG', 'this is peak content', 'keep going!!', 'my guy just cooked',
  'the audacity 💀', 'real one', 'clip that 📎', 'unreal', 'W W W',
  'skill diff fr', 'floor diff real', 'BOSS FIGHT LETS GO 🔥', 'GOGOGO',
]

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function pickUnique(arr, n) {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length))
}

function calcMaxViewers(fame) {
  return Math.max(20, Math.floor((fame || 0) * 0.02))
}

// ── Live viewer count, read by combat ────────────────────────────────────
// activeStreams is module-private and in-memory (a stream doesn't survive a
// restart, by design), so combat can't reach into it. These three accessors
// are the whole public surface: plugins/liveblast.js reads the crowd to size
// its damage, and plugins/attack.js / plugins/skill.js grow it every turn.

/** Viewers currently watching `playerId`, or 0 if they aren't live. */
export function getStreamViewers(playerId) {
  return activeStreams.get(playerId)?.viewerCount ?? 0
}

/** True while `playerId` has an open stream. */
export function isStreaming(playerId) {
  return activeStreams.has(playerId)
}

/**
 * Grows the crowd by one combat action's worth, capped at maxViewers (which
 * is fame-scaled — see calcMaxViewers). Called once per player turn from the
 * generic attack/skill paths so the crowd builds up over a fight instead of
 * only on the 5-minute tick; that's what makes "go live before the boss and
 * let it fill" a real decision rather than a formality.
 *
 * Returns the new viewer count (0 if not live). Never throws — combat calls
 * this mid-turn and a viewer counter must never be able to break a fight.
 */
export function rampStreamViewers(playerId) {
  const s = activeStreams.get(playerId)
  if (!s) return 0
  const growth = Math.max(1, Math.floor(s.maxViewers * (0.10 + Math.random() * 0.10)))
  s.viewerCount = Math.min(s.maxViewers, s.viewerCount + growth)
  if (s.viewerCount > s.peakViewers) s.peakViewers = s.viewerCount
  return s.viewerCount
}

function clearStreamTimers(s) {
  clearTimeout(s._timeout)
  clearTimeout(s._engageTimer)
  clearTimeout(s._afkTimer)
  clearInterval(s._dungeonCheck)
}

/**
 * Arms/resets the AFK-ban timer. Called on stream start and cleared the
 * moment the streamer does anything (currently: .stream chat). If it ever
 * fires, the player did nothing for AFK_TIMEOUT_MS straight after going
 * live and gets jailed for AFK_JAIL_MS.
 */
function armAfkTimer(playerId, ctx) {
  const s = activeStreams.get(playerId)
  if (!s) return
  clearTimeout(s._afkTimer)
  s._afkTimer = setTimeout(async () => {
    const live = activeStreams.get(playerId)
    if (!live) return
    clearStreamTimers(live)
    activeStreams.delete(playerId)
    try {
      await jailPlayer(ctx.db, playerId, AFK_JAIL_MS, 'afk_streaming', 'Went live and did nothing for 5 minutes')
    } catch {}
    try {
      await ctx.sock.sendMessage(live.jid, {
        text:
`🚫 *BANNED — 1 HOUR*\n\n` +
`📺 You opened a stream and went AFK for *5 minutes*.\n` +
`⏱️ You're locked out for *1 hour*.`,
      })
    } catch {}
  }, AFK_TIMEOUT_MS)
}

/**
 * Polls that the streamer is still both inDungeon and inBattle. Streaming
 * requires you to be locked in a dungeon battle; if either flag goes false
 * (won, fled, died, left) the stream ends automatically.
 */
function armDungeonCheck(playerId, ctx) {
  const s = activeStreams.get(playerId)
  if (!s) return
  clearInterval(s._dungeonCheck)
  s._dungeonCheck = setInterval(async () => {
    const live = activeStreams.get(playerId)
    if (!live) return
    let player
    try { player = await getPlayer(ctx.db, playerId) } catch { return }
    if (!player) return
    if (!player.inDungeon) {
      await endStream(playerId, true, ctx, 'You left the dungeon, so the stream cut out.')
    }
  }, DUNGEON_CHECK_MS)
}

async function endStream(playerId, auto, ctx, reasonText) {
  const s = activeStreams.get(playerId)
  if (!s) return
  clearStreamTimers(s)
  activeStreams.delete(playerId)

  try {
    await ctx.sock.sendMessage(s.jid, {
      text:
`📴 *STREAM ${auto ? 'ENDED' : 'ENDED EARLY'}*${reasonText ? `\n_${reasonText}_` : ''}

📺 *${s.playerName}*'s stream is over!
👁️ Peak viewers: *${s.peakViewers.toLocaleString()}*
☀️ Total Solars gifted: *${s.totalSolars.toLocaleString()}*
💎 Total Gems gifted: *${s.totalGems}*`,
    })
  } catch {}
}

/**
 * One round of the stream loop. Two phases per stream, alternating:
 *  1) Post viewer chatter + a prompt, then arm awaitingEngage and wait
 *     ENGAGE_WINDOW_MS for a `.stream chat` reply (handled in cmdChat).
 *  2) If that reply never came, this function fires again on timeout,
 *     sees awaitingEngage still true, counts a missed tick, and either
 *     warns + reschedules or ends the stream for inactivity.
 * Gifts are never rolled in here — only cmdChat rolls/pays gifts, and
 * only when it's actually invoked by the player during an open window.
 */
async function tick(playerId, ctx) {
  const s = activeStreams.get(playerId)
  if (!s) return

  if (s.awaitingEngage) {
    s.missedTicks += 1
    s.awaitingEngage = false

    if (s.missedTicks >= MAX_MISSED_TICKS) {
      return endStream(playerId, true, ctx, "Chat went quiet and you didn't respond in time.")
    }

    try {
      await ctx.sock.sendMessage(s.jid, {
        text:
`⚠️ *${s.playerName}* went quiet — viewers are leaving!\n` +
`_Reply *${config.prefix}stream chat* within ${Math.round(ENGAGE_WINDOW_MS / 1000)}s or the stream ends._`,
      })
    } catch {}

    s._engageTimer = setTimeout(() => tick(playerId, ctx), ENGAGE_WINDOW_MS)
    return
  }

  s.viewerCount = Math.min(s.maxViewers, s.viewerCount + Math.floor(s.maxViewers * (0.1 + Math.random() * 0.3)))
  if (s.viewerCount > s.peakViewers) s.peakViewers = s.viewerCount

  const names = pickUnique(NPC_NAMES, 3 + Math.floor(Math.random() * 3))
  const lines = names.map(n => `💬 *${n}*: ${pickRandom(COMMENTS)}`)
  const remaining = Math.max(0, 20 - Math.floor((Date.now() - s.startTime) / 60000))

  try {
    await ctx.sock.sendMessage(s.jid, {
      text:
`📺 *${s.playerName}* is LIVE — 👁️ *${s.viewerCount.toLocaleString()}* viewers
${lines.join('\n')}
💬 _Reply *${config.prefix}stream chat* to hype up viewers and unlock this round's gifts!_
⏱️ _${remaining} min remaining_`,
    })
  } catch {}

  s.awaitingEngage = true
  s._engageTimer = setTimeout(() => tick(playerId, ctx), ENGAGE_WINDOW_MS)
}

export default {
  name:           'stream',
  aliases:        ['live'],
  category:       'social',
  requiresPlayer: true,
  description:    'Go live and let Astral Town watch you play',

  async run(ctx) {
    const { player, args, reply, sender, isGroup } = ctx
    const p   = config.prefix
    const sub = (args[0] || 'status').toLowerCase()

    // Admin toggle first — `.stream on|off` is a GROUP setting, not a player
    // action, so it routes to the shared read-back-verified toggle (which
    // does its own group + admin/mod permission checks) before any of the
    // player subcommands below.
    if (sub === 'on' || sub === 'off') {
      return handleBoolToggle(ctx, 'streamingEnabled', 'Live streaming', '📺',
        `_Members can now go live inside a dungeon with *${p}stream start*._`)
    }

    if (sub === 'end')    return cmdEnd(ctx)
    if (sub === 'status') return cmdStatus(ctx)
    if (sub === 'chat')   return cmdChat(ctx)
    if (sub !== 'start') {
      return reply(
        `📺 *Usage:*\n` +
        `*${p}stream start* — go live\n` +
        `*${p}stream chat* — engage viewers during a live stream\n` +
        `*${p}stream status* — check stats\n` +
        `*${p}stream end* — stop early\n` +
        `*${p}stream on|off* — _admin:_ allow streaming in this group`
      )
    }

    if (activeStreams.has(player.id)) {
      const s = activeStreams.get(player.id)
      const elapsed = Math.floor((Date.now() - s.startTime) / 60000)
      return reply(`⚠️ You're already live! *(${elapsed} min in)*\nUse *${p}stream end* to stop.`)
    }

    // Group opt-in. A stream posts its own messages into this chat every few
    // minutes for 20 minutes, so it needs the group's consent — and there's
    // no group to broadcast to in a DM.
    if (!isGroup) {
      return reply(
        `📺 *Streaming only works in a group chat.*\n\n` +
        `_Your stream posts viewer chatter and gift rounds into the chat, so it needs an audience. ` +
        `Join a group where an admin has enabled streaming with *${p}stream on*._`
      )
    }

    const gs = await getGroupSettings(sender)
    if (!gs.streamingEnabled) {
      return reply(
        `📴 *Streaming isn't enabled in this group.*\n\n` +
        `_A group admin can turn it on with *${p}stream on*._`
      )
    }

    if (!isPremiumActive(player)) {
      return reply(
        `👑 *Streaming is a Premium perk!*\n\n` +
        `Go live, collect viewer gifts, and grow your fame — available to Premium members only.\n\n` +
        `_Check plans with *${p}premium*._`
      )
    }

    const fame = player.fame || 0
    if (fame < MIN_FAME_TO_STREAM) {
      return reply(
        `❌ You need at least *${formatFame(MIN_FAME_TO_STREAM)} fame* to stream!\n` +
        `📊 You have: *${formatFame(fame)}* fame\n\n` +
        `_Earn fame by winning battles, clearing floors, and beating bosses. Check *${p}fame*._`
      )
    }

    if (!player.inDungeon) {
      return reply(
        `🗺️ *You must be inside a dungeon to go live!*\n\n` +
        `_Use *${p}enter <dungeon_id>* to enter a dungeon, ` +
        `then try *${p}stream start* again._`
      )
    }

    const tier         = getFameTier(fame)
    const maxViewers   = calcMaxViewers(fame)
    const startViewers = Math.max(5, Math.floor(maxViewers * 0.1))

    const stream = {
      jid: sender, playerId: player.id, playerName: player.name,
      maxViewers, viewerCount: startViewers, peakViewers: startViewers,
      totalSolars: 0, totalGems: 0, startTime: Date.now(),
      awaitingEngage: false, missedTicks: 0,
      _timeout: null, _engageTimer: null,
    }

    stream._timeout     = setTimeout(() => endStream(player.id, true, ctx), STREAM_DURATION_MS)
    stream._engageTimer = setTimeout(() => tick(player.id, ctx), TICK_INTERVAL_MS)

    activeStreams.set(player.id, stream)
    armAfkTimer(player.id, ctx)
    armDungeonCheck(player.id, ctx)

    return reply(
      `🔴 *YOU'RE LIVE!*\n\n` +
      `📺 *${player.name}* is now streaming!\n` +
      `${tier.emoji} *${formatFame(fame)}* fame drawing the crowd in\n` +
      `👁️ Early viewers: *${startViewers}*\n` +
      `🎯 Max viewers: *~${maxViewers.toLocaleString()}*\n` +
      `⏱️ Ends automatically in *20 minutes*\n\n` +
      `_The crowd grows every time you attack — fight to fill the room._\n` +
      `_Stay engaged — reply *${p}stream chat* whenever prompted to keep gifts flowing!_\n` +
      `_Use *${p}stream end* to stop early · *${p}stream status* to check stats_`
    )
  },
}

async function cmdEnd(ctx) {
  const { player, reply } = ctx
  const p = config.prefix
  if (!activeStreams.has(player.id)) {
    return reply(`❌ You're not currently streaming.\n_Use *${p}stream start* to go live._`)
  }
  return endStream(player.id, false, ctx)
}

async function cmdStatus(ctx) {
  const { player, reply } = ctx
  const p = config.prefix
  const stream = activeStreams.get(player.id)

  if (!stream) {
    let hint
    if (!isPremiumActive(player)) {
      hint = `👑 Streaming is a Premium perk — check plans with *${p}premium*.`
    } else if ((player.fame || 0) < MIN_FAME_TO_STREAM) {
      hint = `Streaming unlocks at *${formatFame(MIN_FAME_TO_STREAM)} fame*.`
    } else {
      hint = `Use *${p}stream start* to go live!`
    }
    return reply(`📺 *STREAM STATUS*\n\n_You're not currently live._\n\n${hint}`)
  }

  const elapsed   = Math.floor((Date.now() - stream.startTime) / 60000)
  const remaining = Math.max(0, 20 - elapsed)
  const engageLine = stream.awaitingEngage
    ? `\n💬 _Waiting on your *${p}stream chat* reply to unlock this round's gifts!_`
    : ''

  return reply(
    `🔴 *YOU'RE LIVE!*\n\n` +
    `⏱️ *${elapsed} min elapsed · ${remaining} min remaining*\n` +
    `👁️ Current viewers: *${stream.viewerCount.toLocaleString()}*\n` +
    `📈 Peak viewers: *${stream.peakViewers.toLocaleString()}*\n` +
    `☀️ Solars gifted so far: *${stream.totalSolars.toLocaleString()}*\n` +
    `💎 Gems gifted so far: *${stream.totalGems}*${engageLine}\n\n` +
    `_Use *${p}stream end* to end early_`
  )
}

/**
 * .stream chat — the only place gifts are rolled and paid. Requires an
 * open engage window (s.awaitingEngage) so it can't be spammed for extra
 * payouts; one reply unlocks exactly one round's gifts.
 */
async function cmdChat(ctx) {
  const { player, reply } = ctx
  const p = config.prefix
  const s = activeStreams.get(player.id)

  if (!s) {
    return reply(`❌ You're not currently streaming.\n_Use *${p}stream start* to go live._`)
  }
  if (!s.awaitingEngage) {
    return reply(`💬 Viewers are already hyped — no gifts waiting to be unlocked right now.`)
  }

  clearTimeout(s._afkTimer)
  s.awaitingEngage = false
  s.missedTicks = 0

  let solarGain = 0, gemGain = 0
  const giftLines = []
  const rolls = 1 + (s.viewerCount > 500 ? 1 : 0)
  for (let i = 0; i < rolls; i++) {
    const roll = Math.random()
    if (roll < 0.03) {
      giftLines.push(`💎 *${pickRandom(NPC_NAMES)}* gifted *1 💎*! 🎁`)
      gemGain += 1
    } else if (roll < 0.45) {
      const amount = 20 + Math.floor(Math.random() * 81)
      giftLines.push(`☀️ *${pickRandom(NPC_NAMES)}* gifted *${amount} Solars*! 🎁`)
      solarGain += amount
    }
  }

  if (solarGain > 0 || gemGain > 0) {
    await updatePlayer(ctx.db, player.id, pl => {
      pl.wallet.solars = (pl.wallet.solars ?? 0) + solarGain
      pl.wallet.gems   = roundGems((pl.wallet.gems   ?? 0) + gemGain)
      return pl
    }).catch(() => {})
  }
  s.totalSolars += solarGain
  s.totalGems   += gemGain

  const giftBlock = giftLines.length ? `\n\n${giftLines.join('\n')}` : '\n\n_Chat loved the energy, but no gifts this round — better luck next time!_'
  const earnBlock = (solarGain > 0 || gemGain > 0)
    ? `\n\n💰 You received: *+${solarGain} ☀️*${gemGain > 0 ? ` · *+${gemGain} 💎*` : ''}`
    : ''

  return reply(
    `🎤 *You hype up the chat!*${giftBlock}${earnBlock}`
  )
}
