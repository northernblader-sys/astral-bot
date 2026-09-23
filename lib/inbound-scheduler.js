/**
 * inbound-scheduler.js — keeps a slow command from holding the WhatsApp
 * message stream hostage.
 *
 * Baileys emits messages.upsert without waiting for application code. The
 * connection used to put every upsert on one promise chain, which looked safe
 * but meant one slow command (media download, API call, or a send waiting on
 * the rate limiter) stopped every later message from even reaching the
 * handler. The visible symptom was "the bot is loading" followed by old
 * reactions and replies arriving one at a time.
 *
 * This scheduler gives each sender a FIFO lane while allowing different
 * senders to be handled concurrently. Keeping one sender ordered protects
 * stateful commands (two quick .buy/.attack messages from the same player),
 * while a slow player or group member no longer blocks everybody else. The
 * global concurrency cap prevents an overspam burst from creating an
 * unbounded pile of active handlers and starving Baileys' websocket loop.
 */

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_PENDING = 512

/**
 * Return a stable player lane for a raw Baileys message.
 *
 * WhatsApp can address a sender by LID while also carrying their phone number
 * in participantPn/senderPn. Prefer the phone attribute when present so a
 * LID-addressed group message and a normal phone-addressed DM from the same
 * person cannot run their stateful commands concurrently.
 */
function phoneLane(value) {
  const digits = String(value).split('@')[0].split(':')[0].replace(/\D+/g, '')
  return digits.length >= 8 ? `phone:${digits}` : `sender:${String(value)}`
}

export function inboundMessageKey(msg) {
  const key = msg?.key ?? {}
  const remote = String(key.remoteJid ?? '')

  // The explicit *Pn fields are phone-number attributes even when the visible
  // participant is a LID. A normal @s.whatsapp.net participant is equivalent.
  if (key.participantPn) return phoneLane(key.participantPn)
  if (key.senderPn) return phoneLane(key.senderPn)
  if (String(key.participant ?? '').endsWith('@s.whatsapp.net')) return phoneLane(key.participant)
  if (key.participant) return `sender:${String(key.participant)}`
  if (remote) return `chat:${remote}`
  // Protocol events without a jid are rare. They should still be processed,
  // but should not accidentally serialize every malformed event together.
  return `message:${key.id ?? Math.random().toString(36).slice(2)}`
}

/**
 * Create a bounded, per-sender FIFO scheduler.
 *
 * `handle(payload)` may be async. `enqueue()` returns a promise that resolves
 * to the handler result, or `false` when the payload was shed because the
 * bounded pending queue was full / the scheduler was closed. Handler errors
 * are logged and resolved rather than rejected: the Baileys event emitter does
 * not observe returned promises, so a rejected promise here would become an
 * unhandled rejection and could make this exact outage harder to diagnose.
 */
export function createInboundScheduler({
  handle,
  concurrency = DEFAULT_CONCURRENCY,
  maxPending = DEFAULT_MAX_PENDING,
  keyFor = (_payload) => 'default',
  log = () => {},
} = {}) {
  if (typeof handle !== 'function') throw new TypeError('createInboundScheduler requires handle(payload)')

  const limit = Math.max(1, Number.isFinite(Number(concurrency)) ? Math.floor(Number(concurrency)) : DEFAULT_CONCURRENCY)
  const pendingLimit = Math.max(0, Number.isFinite(Number(maxPending)) ? Math.floor(Number(maxPending)) : DEFAULT_MAX_PENDING)
  const lanes = new Map()
  let active = 0
  let pending = 0
  let sequence = 0
  let closed = false
  const stats = {
    accepted: 0,
    completed: 0,
    failed: 0,
    dropped: 0,
  }

  function findReadyLane() {
    for (const lane of lanes.values()) {
      if (!lane.running && lane.jobs.length) return lane
    }
    return null
  }

  function pump() {
    while (!closed && active < limit) {
      const lane = findReadyLane()
      if (!lane) return

      const job = lane.jobs.shift()
      pending--
      lane.running = true
      active++

      Promise.resolve()
        .then(() => handle(job.payload))
        .then(result => {
          stats.completed++
          job.resolve(result)
        })
        .catch(err => {
          stats.failed++
          try {
            log({ err, payload: job.payload }, 'Inbound message handler failed')
          } catch {
            // Diagnostics must never take down the scheduler.
          }
          // The next message in this sender's lane must still run.
          job.resolve(undefined)
        })
        .finally(() => {
          active--
          lane.running = false
          if (!lane.jobs.length) lanes.delete(lane.key)
          pump()
        })
    }
  }

  function enqueue(payload, explicitKey) {
    if (closed || pending >= pendingLimit && active >= limit) {
      stats.dropped++
      try {
        log({ pending, active, maxPending: pendingLimit }, 'Inbound queue full or scheduler closed; dropping message')
      } catch {}
      return Promise.resolve(false)
    }

    let key
    try {
      key = String(explicitKey ?? keyFor(payload) ?? 'default')
    } catch {
      key = 'default'
    }

    let lane = lanes.get(key)
    if (!lane) {
      lane = { key, jobs: [], running: false, createdAt: sequence++ }
      lanes.set(key, lane)
    }

    const promise = new Promise(resolve => {
      lane.jobs.push({ payload, resolve })
      pending++
      stats.accepted++
    })
    pump()
    return promise
  }

  function close(reason = 'closed') {
    if (closed) return
    closed = true
    let dropped = 0
    for (const lane of lanes.values()) {
      // A running handler cannot be cancelled safely, but queued handlers have
      // not touched the database or socket yet and should not run on a retired
      // Baileys socket.
      while (lane.jobs.length) {
        const job = lane.jobs.shift()
        pending--
        dropped++
        stats.dropped++
        job.resolve(false)
      }
    }
    for (const [key, lane] of lanes) {
      if (!lane.running) lanes.delete(key)
    }
    if (dropped) {
      try { log({ dropped, reason }, 'Inbound queue cleared for retired socket') } catch {}
    }
  }

  return {
    enqueue,
    close,
    get closed() { return closed },
    get active() { return active },
    get pending() { return pending },
    get stats() { return { ...stats } },
    get laneCount() { return lanes.size },
    get limits() { return { concurrency: limit, maxPending: pendingLimit } },
  }
}
