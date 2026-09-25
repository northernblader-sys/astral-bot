/**
 * health.js — owner-only readout of the two things that make the bot look
 * frozen while it is still "online".
 *
 * Written for a specific bug report: "the bot is online, we're all sending
 * messages and it won't answer, but the hourly card and the Pokémon spawns
 * still arrive normally." Both halves of that are possible at once, and there
 * are two very different causes:
 *
 *   1. OUTBOUND. Commands are received and run fine, but the replies are
 *      sitting in lib/send-rate-limiter.js's queue behind a hard sends-per-
 *      minute cap. Spawn sweeps only send once an hour, so their single
 *      message still gets out looking normal. Tell-tale: `pending` is high
 *      and `oldest` is tens of seconds or minutes.
 *
 *   2. INBOUND. The socket is open and can send, but WhatsApp messages have
 *      stopped arriving at all (usually Baileys failing to decrypt them —
 *      those errors are filtered out of the logs by main.js's SPAM_PATTERNS).
 *      Tell-tale: `last inbound` keeps climbing while people are actively
 *      messaging the bot. Genuine socket closes still use the normal reconnect
 *      path; this readout helps distinguish delivery trouble from a work queue.
 *
 * Everything here is read from live counters — no network calls, no database
 * reads — so it answers even when the bot is busy or backed up.
 */
import { getHealthSnapshot } from '../lib/bot-health.js'
import { queueStats } from '../lib/player-repo.js'
import { isOwnerJid } from '../lib/group-helpers.js'

function ago(ts) {
  if (!ts) return 'never'
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m ago`
}

export default {
  name:           'health',
  aliases:        ['diag', 'queues'],
  category:       'admin',
  platforms:      ['whatsapp'],
  requiresPlayer: false,
  description:    'Owner-only: inbound/outbound queue diagnostics for "bot is online but not answering"',

  async run(ctx) {
    if (!ctx.from || !isOwnerJid(ctx.from)) {
      return ctx.reply(`❌ This command is restricted to the bot owner.`)
    }

    const snap = getHealthSnapshot()
    if (!snap) {
      return ctx.reply('⚠️ No WhatsApp health data — main.js has not registered its instances yet.')
    }

    const lines = [`🩺 *Bot Health*`, `⏱️ Uptime: *${Math.floor(snap.uptimeSec / 60)}m*`, '']

    for (const inst of snap.instances) {
      lines.push(`*${inst.botName}* — ${inst.online ? '🟢 online' : '🔴 offline'}`)
      lines.push(`  connected: ${ago(inst.openedAt)}`)
      lines.push(`  last inbound msg: ${ago(inst.lastInboundAt)} (${inst.inboundCount} this session)`)
      if (inst.lastForcedReconnectAt) {
        lines.push(`  watchdog reconnect: ${ago(inst.lastForcedReconnectAt)}`)
      }
      if (inst.reconnectPending) lines.push(`  reconnect pending ⏳`)
      if (inst.transientCloseStreak) {
        lines.push(`  ⚠️ ${inst.transientCloseStreak} transient close(s) in a row — the link is flapping or the loop is too busy to answer the keepalive`)
      }

      const inbound = inst.inbound
      if (inbound) {
        lines.push(`  inbound work: *${inbound.active}* active, ${inbound.pending} waiting, ${inbound.lanes} sender lanes`)
        lines.push(`  inbound handled ${inbound.stats.completed} · dropped ${inbound.stats.dropped} · failed ${inbound.stats.failed}`)
      }

      const s = inst.send
      if (s) {
        lines.push(`  send queue: *${s.pending}* waiting` +
          (s.pending ? ` (${s.pendingReplies ?? 0} replies, ${s.pendingBulk ?? 0} bulk, oldest ${Math.round(s.oldestPendingMs / 1000)}s)` : '') +
          (s.pendingReactions ? ` (+${s.pendingReactions} reactions)` : ''))
        const eff = s.effectiveLimits
        lines.push(`  rate: ${s.sentLastMinute}/${s.limits.maxPerMinute} per min, ` +
          `min gap ${s.limits.minGapMs}ms` +
          (eff && (eff.minGapMs !== s.limits.minGapMs || eff.maxPerMinute !== s.limits.maxPerMinute)
            ? ` (throttled to ${eff.minGapMs}ms / ${eff.maxPerMinute} per min${s.throttledForMs ? `, extra pause ${Math.round(s.throttledForMs / 1000)}s` : ''})`
            : '') +
          `, burst ${s.burstReady ? 'ready' : 'spent'} of ${s.limits.burstMax ?? 0}`)
        const c = s.counters
        lines.push(`  sent ${c.sent} · failed ${c.failed} · timeouts ${c.timeouts}`)
        lines.push(`  dropped: ${c.dropStale} stale, ${c.dropOverflow} overflow, ${c.dropReact} reactions`)
        if (!s.draining && s.pending) lines.push(`  ⚠️ queue not draining!`)
      } else {
        lines.push(`  send queue: (socket down)`)
      }
      lines.push('')
    }

    const q = queueStats
    lines.push(`💾 *DB write queue*`)
    lines.push(`  depth: ${q.currentQueueDepth}`)
    lines.push(`  running: ${q.lastTaskStartedAt ? `${q.lastTaskLabel} (${ago(q.lastTaskStartedAt)})` : 'idle'}`)
    lines.push(`  last task: ${q.lastTaskLabel ?? '—'} took ${q.lastTaskDurationMs ?? '—'}ms`)
    lines.push(`  slow tasks (>3s): ${q.slowTaskCount}`)

    const lag = snap.loopLag
    lines.push('')
    lines.push(`🐌 *Event loop*`)
    if (lag) {
      lines.push(`  p99 delay: ${Math.round(lag.p99Ms)}ms (worst ${Math.round(lag.worstMs)}ms ever, in ${lag.windows} windows)`)
      lines.push(lag.starved
        ? `  🔴 BLOCKED NOW — the process cannot service the socket this fast; Baileys reads that as a dead link and self-kills it. Not a Baileys bug.`
        : lag.starvedRecently
          ? `  🟠 was blocked ${Math.round((lag.lastStarvedAgoMs ?? 0) / 1000)}s ago (threshold ${lag.starveThresholdMs}ms, ${lag.starvedWindows} starved window(s))`
          : `  🟢 responsive (starves above ${lag.starveThresholdMs}ms)`)
    } else {
      lines.push(`  (not sampling — started by main.js only in the WhatsApp process)`)
    }

    lines.push('')
    lines.push(`_High "send queue"/"oldest" = replies are rate-limited (bot is behind)._`)
    lines.push(`_Climbing "inbound waiting" = command work is backed up; different senders still run concurrently, and the queue is bounded._`)
    lines.push(`_A stale "last inbound msg" while people are messaging points to delivery/decryption trouble rather than a command queue._`)
    lines.push(`_A red "Event loop" line means the bot is starved by its own work — reconnecting would only discard the queued commands._`)

    return ctx.reply(lines.join('\n'))
  },
}
