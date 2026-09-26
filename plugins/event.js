/**
 * event.js — `.event` : the current world event hub.
 *
 * Player-facing:
 *   .event                  — the featured world event, its clock, and your standing
 *                             (live event first, otherwise the NEWEST event in
 *                             lib/world-events.js — so new events show up here
 *                             automatically as soon as they are registered)
 *
 * Owner-only (lib/group-helpers.js's isOwnerJid). <event> defaults to the
 * newest registered event; name one to target an older event (e.g. `the end`):
 *   .event start [event] [days]   — open the event
 *   .event end   [event]          — close it now
 *   .event skip  [event] [days]   — test hook: move its clock forward
 *   .event list                   — every registered event and its state
 *
 * Every lifecycle flip is a single write inside updateAllPlayers, so it rides
 * the same serialized queue as every other mutation (lib/player-repo.js) and
 * can't race a concurrent command.
 */
import { config } from '../config.js'
import { updateAllPlayers, getPlayer } from '../lib/player-repo.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { formatTimeLeft } from '../lib/time-format.js'
import {
  COMPANIONS,
  GUARDIAN,
  REGIONS,
  REGION_MAP,
  TYPE_BADGE,
  dailyCap,
  ensureGuardianState,
  eventDay,
  getGuardianEvent,
  isGuardianActive,
  isRegionOpen,
  nextRenownRank,
  playerCompanion,
  renownRank,
  rescuesLeftToday,
} from '../lib/guardian-event.js'
import {
  getEndEvent, isEventActive, endPhase, endOpensAt,
  startEndEvent, forceEndEvent, skipEndEventWait, syncEndWeakenForAll,
  endStatusBadge,
  END_START_BROADCAST, END_FORCE_END_BROADCAST,
  END_WEAKEN_PCT, SLEEP_MAX_LEVEL, LUNA_GRACE_MS, THE_END_LOCATION_ID,
} from '../lib/end-event.js'
import {
  WORLD_EVENTS, WORLD_EVENT_MAP, featuredWorldEventKey, findWorldEvent, newestWorldEventKey,
} from '../lib/world-events.js'
import guardianPlugin from './guardian.js'

// ── Overview routing ───────────────────────────────────────────────────────
// Which event to show lives in lib/world-events.js (featuredWorldEventKey).

const RENDERERS = {
  guardian: (ctx) => renderGuardianStatus(ctx),
  end:      (ctx) => renderEndStatus(ctx),
}

function renderFeatured(ctx) {
  const key = featuredWorldEventKey(ctx.db)
  const render = RENDERERS[key]
  return render ? render(ctx) : `🌌 *No world event is running.*`
}

function renderList(ctx) {
  const p = config.prefix
  const featured = featuredWorldEventKey(ctx.db)
  const now = Date.now()
  const lines = ['🗓️ *WORLD EVENTS*', '']
  for (const ev of [...WORLD_EVENTS].reverse()) {
    const st = ev.state(ctx.db, now)
    const status = st.active ? '🟢 live' : st.startedAt ? '🔚 ended' : '🔒 not started'
    lines.push(`${ev.key === featured ? '⭐' : '•'} *${ev.name}* — ${status}  _(${ev.key})_`)
  }
  lines.push('', `_⭐ is what *${p}event* shows. Owner: *${p}event start <name>*._`)
  return lines.join('\n')
}

// ── Guardian of the Innocent ───────────────────────────────────────────────

function renderGuardianStatus(ctx) {
  const p = config.prefix
  const db = ctx.db
  const player = ctx.player ?? null
  const now = Date.now()
  const e = getGuardianEvent(db)
  const active = isGuardianActive(db, now)
  const totalDays = e.startedAt && e.endsAt
    ? Math.max(1, Math.round((e.endsAt - e.startedAt) / 86400000))
    : GUARDIAN.durationDays
  const openRegions = REGIONS.filter(region => isRegionOpen(db, region, now))
  const nextRegion = active ? REGIONS.find(region => !isRegionOpen(db, region, now)) : null
  const unclaimed = COMPANIONS.filter(companion => !e.companions?.[companion.id]?.owner)

  const lines = [
    '🕊️ *GUARDIAN OF THE INNOCENT*',
    '',
    `_${GUARDIAN.intro}_`,
    '',
  ]

  if (active) {
    lines.push(`📅 Day *${eventDay(db, now)}*/${totalDays}  ·  ⏳ Ends in *${formatTimeLeft(Math.max(0, e.endsAt - now))}*`)
  } else if (e.startedAt && (e.endedAt || now >= (e.endsAt ?? 0))) {
    const endedAt = e.endedAt ?? e.endsAt ?? now
    lines.push(`🔚 _This run has ended (${formatTimeLeft(Math.max(0, now - endedAt))} ago). Companions stay with their players._`)
  } else {
    lines.push('🔒 _This event has not started yet._')
    if (isOwnerJid(ctx.from)) lines.push(`👑 _Owner: *${p}event start* to open it (${GUARDIAN.durationDays} days by default)._`)
  }

  lines.push('')
  if (active) {
    lines.push(`🗺️ Open locations: *${openRegions.length}/${REGIONS.length}*`)
    if (openRegions.length) lines.push(`📍 Open now: *${openRegions.map(region => region.name).join('*, *')}*`)
    if (nextRegion) {
      lines.push(`⏳ Next opening: *${nextRegion.name}* in *${formatTimeLeft(Math.max(0, (e.startedAt + (nextRegion.opensOnDay - 1) * 86400000) - now))}*`)
    }
    lines.push(`⚔️ No level gate. Slavers size themselves to whoever walks in.`)
  } else {
    lines.push(`🗺️ Event locations: *${REGIONS.length}* total  ·  💞 One-of-one companions: *${COMPANIONS.length}*`)
  }

  if (player) {
    const g = ensureGuardianState(player)
    const rank = renownRank(g.freed)
    const next = nextRenownRank(g.freed)
    const companion = playerCompanion(player)

    lines.push('', '👤 *Your standing*')
    lines.push(
      `🕊️ Freed: *${g.freed}*  ·  ${rank.emoji} *${rank.label}*` +
      (next ? ` _(next: ${next.label} at ${next.min})_` : ''),
    )
    if (active) {
      lines.push(
        `🗺️ Location: *${g.region ? REGION_MAP[g.region]?.name ?? g.region : 'none yet'}*  ·  ` +
        `Rescues left today: *${rescuesLeftToday(db, player, now)}*/${dailyCap(player)}`,
      )
    }
    if (companion) {
      lines.push(`💞 Companion: *${companion.name}*  ·  ${TYPE_BADGE[companion.type] ?? '🕊️ No type'}`)
    }
  }

  lines.push('')
  lines.push(`⛓️ Unclaimed companions: *${unclaimed.length}/${COMPANIONS.length}*`)
  if (unclaimed.length) {
    lines.push(`_The first player to free each captor and accept the request is the only one who can take that companion home._`)
  }
  lines.push('')
  lines.push(`🗺️ *${p}guardian map*  ·  🚶 *${p}guardian travel <name>*`)
  lines.push(`⚔️ *${p}rescue*  ·  💞 *${p}companion*  ·  🏆 *${p}guardian top*`)

  return lines.join('\n')
}

// ── The End / Blue Band ────────────────────────────────────────────────────

function renderEndStatus(ctx) {
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

// ── Guardian owner controls (delegated to plugins/guardian.js) ─────────────

function runGuardianOwner(ctx, sub, number) {
  const args = number != null ? [sub, String(number)] : [sub]
  return guardianPlugin.run({ ...ctx, args })
}

// ── Plugin export ─────────────────────────────────────────────────────────

const OWNER_ACTIONS = {
  start: 'start', begin: 'start', open: 'start',
  end: 'end', stop: 'end', close: 'end',
  skip: 'skip', ff: 'skip', fastforward: 'skip',
}

export default {
  name:           'event',
  aliases:        ['endevent', 'theend', 'worldevent', 'events'],
  category:       'event',
  requiresPlayer: false,
  description:    `${config.prefix}event — the latest world event and your standing in it`,
  subcommands: [
    { cmd: 'event',                 desc: 'Current world event, how long it lasts, and your status' },
    { cmd: 'event list',            desc: 'Every world event and whether it is live' },
    { cmd: 'event start [event]',   desc: 'Owner — open the newest event (or the one named)' },
    { cmd: 'event end [event]',     desc: 'Owner — close the newest event (or the one named)' },
    { cmd: 'event skip [event] [n]', desc: 'Owner — move an event clock forward (testing)' },
  ],

  async run(ctx) {
    const args = ctx.args ?? []
    const action = String(args[0] ?? 'status').toLowerCase()

    if (action === 'status' || action === 'info') return ctx.reply(renderFeatured(ctx))
    if (action === 'list' || action === 'all') return ctx.reply(renderList(ctx))

    const op = OWNER_ACTIONS[action]
    if (op) {
      if (!isOwnerJid(ctx.from)) return ctx.reply('❌ Owner only.')
      const p = config.prefix
      const rest = args.slice(1).map(String)
      const numArg = rest.find(a => /^\d+$/.test(a))
      const nameStr = rest.filter(a => !/^\d+$/.test(a)).join(' ').trim()
      const key = nameStr ? findWorldEvent(nameStr) : newestWorldEventKey()
      if (!key) {
        return ctx.reply(
          `❌ No event called *${nameStr}*.\n` +
          `_Events: ${WORLD_EVENTS.map(ev => `*${ev.key}*`).join(', ')} — see *${p}event list*._`,
        )
      }
      if (key === 'guardian') return runGuardianOwner(ctx, op, numArg != null ? Number(numArg) : null)
      if (key === 'end') {
        if (op === 'start') return handleStart(ctx)
        if (op === 'end') return handleEnd(ctx)
        return handleSkip(ctx)
      }
      return ctx.reply(`⚠️ *${WORLD_EVENT_MAP[key]?.name ?? key}* has no owner controls here yet.`)
    }

    // `.event guardian` / `.event theend` — peek at a specific event.
    // (Checked after owner actions: `.event end` means "close", not "show The End".)
    const peek = findWorldEvent(args.join(' '))
    if (peek && RENDERERS[peek]) return ctx.reply(RENDERERS[peek](ctx))

    return ctx.reply(
      `❌ Unknown option *${action}*.\n` +
      `_Try_ *${config.prefix}event* _for the current world event, or_ *${config.prefix}event list*.`,
    )
  },
}
