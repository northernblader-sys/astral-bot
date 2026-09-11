/**
 * event.js — `.event` : The End / Blue Band world event.
 *
 * Player-facing:
 *   .event                  — what's happening, how long, and where you stand
 *
 * Owner-only (lib/group-helpers.js's isOwnerJid):
 *   .event start            — stamp the clock, flood the world, announce it
 *   .event end              — kill-switch: lift the aura for everyone, announce it
 *   .event skip             — test hook: open the End's rift right now
 *
 * Every lifecycle flip is a single write to db.data.endEvent inside
 * updateAllPlayers, so it rides the same serialized queue as every other
 * mutation (lib/player-repo.js) and can't race a concurrent command.
 */
import { config } from '../config.js'
import { updateAllPlayers, getPlayer } from '../lib/player-repo.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  getEndEvent, isEventActive, endPhase, endOpensAt,
  startEndEvent, forceEndEvent, skipEndEventWait, syncEndWeakenForAll,
  endStatusBadge,
  END_START_BROADCAST, END_FORCE_END_BROADCAST,
  END_WEAKEN_PCT, SLEEP_MAX_LEVEL, LUNA_GRACE_MS, THE_END_LOCATION_ID,
} from '../lib/end-event.js'

// ── Overview ──────────────────────────────────────────────────────────────

function renderStatus(ctx) {
  const p = config.prefix
  const db = ctx.db
  const e = getEndEvent(db)
  const phase = endPhase(db)

  // Never started.
  if (!e.startedAt) {
    return (
      `🌌 *No world event is running.*\n\n` +
      `_The air is clean. Whatever came through that Ender Pearl is still ` +
      `somewhere out there, sleeping._`
    )
  }

  // Over — leave the record standing as a monument.
  if (e.defeated) {
    const slayer = e.defeatedBy && e.defeatedBy !== 'owner' ? getPlayer(db, e.defeatedBy) : null
    const when = e.defeatedAt ? `${formatTimeLeft(Date.now() - e.defeatedAt)} ago` : 'some time ago'
    return (
      `🌅 *THE END — over.*\n\n` +
      (slayer
        ? `🗡️ Slain by *${slayer.name}* _(${when})_.\n\n`
        : `🌫️ The aura lifted _(${when})_.\n\n`) +
      `_The sky is clear. Keep your Blue Band anyway._`
    )
  }

  const you = ctx.player ? endStatusBadge(db, ctx.player) : null
  const header =
    `🌑 *THE END — ${phase === 'reckoning' ? 'THE RECKONING' : 'THE LONG SLEEP'}*\n\n`

  const aura =
    `🌫️ A concentrated magical air covers *Astral Town* and *every dungeon*.\n` +
    `• Unbanded: *−${Math.round(END_WEAKEN_PCT * 100)}%* to every stat.\n` +
    `• Unbanded and *Level ≤ ${SLEEP_MAX_LEVEL}*: *deep sleep*.\n` +
    `• *Blue Band* in your offhand: untouched.\n\n`

  const howTo =
    `🧿 *Getting a Blue Band*\n` +
    `1. Be in Astral Town — *${p}travel town*\n` +
    `2. Ask the old woman — *${p}shop buy blue band*\n` +
    `3. Answer her honestly — *${p}answer <your reply>*\n` +
    `4. Wear it — *${p}equip blue band*\n` +
    `_Answer wrong and her door shuts until you've been to a dungeon and back._\n\n` +
    `🍶 *${p}give-drink luna @player* — banded players can wake a sleeper for ` +
    `${Math.round(LUNA_GRACE_MS / 60000)} minutes.\n\n`

  const opensAt = endOpensAt(db)
  const clock = phase === 'reckoning'
    ? `⚔️ *The rift is open.* — *${p}enter ${THE_END_LOCATION_ID}*\n` +
      `☠️ _It does not care how strong you think you are._\n\n`
    : `⏳ *The rift opens in ${formatTimeLeft(Math.max(0, opensAt - Date.now()))}.*\n` +
      `☠️ _Enter *${THE_END_LOCATION_ID}* before then and the aura kills you on contact._\n\n`

  return header + aura + howTo + clock + (you ? `👤 *You:* ${you}` : '')
}

// ── Owner controls ────────────────────────────────────────────────────────

async function handleStart(ctx) {
  const p = config.prefix

  if (isEventActive(ctx.db)) {
    return ctx.reply(
      `⚠️ The End's aura is *already live*.\n` +
      `_${p}event — status · ${p}event end — lift it_`,
    )
  }

  await updateAllPlayers(ctx.db, (users) => {
    startEndEvent(ctx.db)
    syncEndWeakenForAll(ctx.db, users)
    return true
  })

  // Announce ONLY here, in the group where the owner ran it. Fanning the same
  // message out to every group is exactly what gets a WhatsApp number banned
  // for spam; players in other groups learn of the aura through their own
  // .event / .profile / .stats status lines.
  const text = END_START_BROADCAST.replaceAll('{prefix}', p)
  return ctx.reply(
    text +
    `\n\n⏳ _The rift opens in ${formatTimeLeft(Math.max(0, endOpensAt(ctx.db) - Date.now()))}._`,
  )
}

async function handleEnd(ctx) {
  const p = config.prefix

  let result = null
  await updateAllPlayers(ctx.db, (users) => {
    result = forceEndEvent(ctx.db)
    // Sweep the cached flags either way — a failed force still shouldn't leave
    // stale weaken flags lying around.
    const swept = syncEndWeakenForAll(ctx.db, users)
    return result.ok || swept
  })

  if (!result.ok) {
    return ctx.reply(
      result.reason === 'not_started'
        ? `⚠️ The event was never started. _${p}event start_`
        : `⚠️ The End is already down. _${p}event — status_`,
    )
  }

  // Announce only in this group (see handleStart — no fan-out).
  return ctx.reply(
    END_FORCE_END_BROADCAST +
    `\n\n✅ _Every sleeper is awake and every stat is back to normal._`,
  )
}

async function handleSkip(ctx) {
  const p = config.prefix

  let result = null
  await updateAllPlayers(ctx.db, () => {
    result = skipEndEventWait(ctx.db)
    return result.ok
  })

  if (!result.ok) {
    return ctx.reply(`⚠️ Nothing to skip — the event isn't running. _${p}event start_`)
  }
  return ctx.reply(
    `⏩ *Clock pulled forward.* The rift is open now.\n` +
    `_${p}enter ${THE_END_LOCATION_ID}_ — good luck.`,
  )
}

// ── Plugin export ─────────────────────────────────────────────────────────

export default {
  name:           'event',
  aliases:        ['endevent', 'theend', 'worldevent'],
  category:       'event',
  requiresPlayer: false,
  description:    `${config.prefix}event — the current world event (The End / Blue Band)`,
  subcommands: [
    { cmd: 'event',       desc: 'Current world event, how long it lasts, and your status' },
    { cmd: 'event start', desc: 'Owner — begin the End\'s rampage and announce it' },
    { cmd: 'event end',   desc: 'Owner — lift the aura server-wide (kill-switch)' },
    { cmd: 'event skip',  desc: 'Owner — open the End\'s rift immediately (testing)' },
  ],

  async run(ctx) {
    const action = String(ctx.args?.[0] ?? 'status').toLowerCase()

    if (action === 'status' || action === 'info') {
      return ctx.reply(renderStatus(ctx))
    }

    if (['start', 'begin', 'end', 'stop', 'skip', 'ff', 'fastforward'].includes(action)) {
      if (!isOwnerJid(ctx.from)) return ctx.reply('❌ Owner only.')
      if (action === 'start' || action === 'begin') return handleStart(ctx)
      if (action === 'end' || action === 'stop') return handleEnd(ctx)
      return handleSkip(ctx)
    }

    return ctx.reply(
      `❌ Unknown option *${action}*.\n` +
      `_Try_ *${config.prefix}event* _for the current world event._`,
    )
  },
}
