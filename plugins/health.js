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
 *      messaging the bot. main.js's watchdog force-reconnects at 15 min.
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

      const s = inst.send
      if (s) {
        lines.push(`  send queue: *${s.pending}* waiting` +
          (s.pending ? `, oldest ${Math.round(s.oldestPendingMs / 1000)}s` : '') +
          (s.pendingReactions ? ` (+${s.pendingReactions} reactions)` : ''))
        lines.push(`  rate: ${s.sentLastMinute}/${s.limits.maxPerMinute} per min, ` +
          `min gap ${s.limits.minGapMs}ms`)
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

    lines.push('')
    lines.push(`_High "send queue"/"oldest" = replies are rate-limited (bot is behind)._`)
    lines.push(`_Climbing "last inbound msg" while people are messaging = inbound stalled; the watchdog reconnects at 15 min._`)

    return ctx.reply(lines.join('\n'))
  },
}
