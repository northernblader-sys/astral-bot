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
 *
 * ── Job timeout (2026-09: the "bot goes deaf" outage) ─────────────────────
 *
 * The concurrency cap has a dark side: `active` only goes back down when a
 * handler's promise SETTLES. A handler that hangs forever — an external API
 * call with no timeout, a stuck db flush, a Baileys send that never
 * resolves — holds its slot forever. Once `concurrency` such jobs accumulate
 * (8 by default), pump() stops dispatching, every new message sits in the
 * pending queue, and the bot permanently stops answering everyone while all
 * the background sweeps (card/series/pokémon spawns, dungeon slots, tags)
 * keep firing on their timers. Outbound works, inbound is dead, and nothing
 * notices — that is exactly the reported outage.
 *
 * The fix: every job gets a timer (jobTimeoutMs). When it fires, the job is
 * DETACHED — the slot is taken back, the sender's lane is released, and a
 * loud log line names the lane. The abandoned handler keeps running in the
 * background (a promise cannot be cancelled), but its result is thrown away
 * and it can no longer hold the stream hostage. The bot keeps answering
 * everyone else in the meantime, and main.js's stall watchdog (see
 * runStallWatchdog there) sees the detached count and force-reconnects if
 * the wedge persists.
 */

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_PENDING = 512
// 3 minutes: far longer than any real command (the send rate limiter itself
// times out individual sends at 60s), far shorter than "forever".
const DEFAULT_JOB_TIMEOUT = 180_000

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
 *
 * Jobs that run longer than `jobTimeoutMs` are detached (see the header note):
 * they stop counting toward concurrency, their lane moves on, and the count of
 * detached-but-unsettled jobs is exposed as `stuck` for main.js's stall
 * watchdog.
 */
export function createInboundScheduler({
  handle,
  concurrency = DEFAULT_CONCURRENCY,
  maxPending = DEFAULT_MAX_PENDING,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT,
  keyFor = (_payload) => 'default',
  log = () => {},
} = {}) {
  if (typeof handle !== 'function') throw new TypeError('createInboundScheduler requires handle(payload)')

  const limit = Math.max(1, Number.isFinite(Number(concurrency)) ? Math.floor(Number(concurrency)) : DEFAULT_CONCURRENCY)
  const pendingLimit = Math.max(0, Number.isFinite(Number(maxPending)) ? Math.floor(Number(maxPending)) : DEFAULT_MAX_PENDING)
  // config.js already floors the production value at 10s; the small floor
  // here is only so tests can run on realistic (hundred-ms) timeouts.
  const timeoutLimit = Math.max(50, Number.isFinite(Number(jobTimeoutMs)) ? Math.floor(Number(jobTimeoutMs)) : DEFAULT_JOB_TIMEOUT)
  const lanes = new Map()
  // Jobs detached by the timeout but whose (abandoned) promise has not yet
  // settled. `stuck` reads this live count for the watchdog.
  const detached = new Set()
  let active = 0
  let pending = 0
  let sequence = 0
  let closed = false
  const stats = {
    accepted: 0,
    completed: 0,
    failed: 0,
    dropped: 0,
    stuck: 0,
  }

  function findReadyLane() {
    for (const lane of lanes.values()) {
      if (!lane.running && lane.jobs.length) return lane
    }
    return null
  }

  /**
   * The timeout path. Runs when a job has been executing longer than
   * jobTimeoutMs — i.e. it will not finish in any reasonable time. Take the
   * concurrency slot back and release the lane so the rest of the bot keeps
   * working; the abandoned handler continues in the background but its
   * outcome is thrown away (job.resolve() may only be called once, and this
   * call is the one the system acts on).
   */
  function detachJob(job) {
    if (job.settled) return
    job.settled = true
    stats.stuck++
    detached.add(job)

    const lane = job.lane
    if (lane) {
      active--
      lane.running = false
    }
    try {
      log(
        { laneKey: job.lane?.key ?? 'unknown', elapsedMs: Date.now() - job.startedAt, timeoutMs: timeoutLimit },
        'Inbound handler exceeded the job timeout — detaching so it cannot wedge the stream',
      )
    } catch {
      // Diagnostics must never take down the scheduler.
    }
    job.resolve(undefined)
    pump()
  }

  /**
   * The normal settle path. Mirrors detachJob's accounting but for a job
   * that finished (or failed) before its timer. A job that already detached
   * late here must NOT decrement active again or evict a lane that was
   * recreated for the same sender in the meantime.
   */
  function releaseJob(job) {
    clearTimeout(job.timer)
    if (job.settled) {
      // The timeout already took this slot back; the promise settling now is
      // just the abandoned tail finishing. Stop tracking it, change nothing
      // else.
      if (detached.has(job)) detached.delete(job)
      return
    }
    job.settled = true
    active--
    const lane = job.lane
    if (lane) {
      lane.running = false
      // Identity check: after a detach, a new lane object for the same key
      // may already exist with its own running job. Deleting by key would
      // evict the wrong lane and orphan its running state.
      if (lanes.get(lane.key) === lane && !lane.jobs.length) lanes.delete(lane)
    }
    pump()
  }

  function pump() {
    while (!closed && active < limit) {
      const lane = findReadyLane()
      if (!lane) return

      const job = {
        payload: lane.jobs[0].payload,
        resolve: lane.jobs[0].resolve,
        lane,
        startedAt: Date.now(),
        settled: false,
        timer: null,
      }
      lane.jobs.shift()
      pending--
      lane.running = true
      active++
      job.timer = setTimeout(() => detachJob(job), timeoutLimit)

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
          releaseJob(job)
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
    // Detached (timed out) jobs that have not finished yet. Sustained > 0 is
    // evidence for main.js's stall watchdog that something is wedged.
    get stuck() { return detached.size },
    get stats() { return { ...stats } },
    get laneCount() { return lanes.size },
    get limits() { return { concurrency: limit, maxPending: pendingLimit, jobTimeoutMs: timeoutLimit } },
  }
}
