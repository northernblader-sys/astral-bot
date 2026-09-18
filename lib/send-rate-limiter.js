/**
 * send-rate-limiter.js — wraps a Baileys sock so every sock.sendMessage()
 * call is queued and paced instead of firing immediately.
 *
 * Why this exists: bot2 (the second WhatsApp number) kept getting banned.
 * A freshly-paired number has none of the trust history the main number
 * built up, so WhatsApp's spam heuristics are much more sensitive to burst
 * sends on it — a plugin that fires 10 replies in the same tick (e.g. a
 * tournament bracket announcement, a leaderboard, a mass DM) reads as bot
 * behavior. Baileys itself has no built-in throttling; every one of the
 * ~140 call sites across plugins/*.js calls sock.sendMessage() directly and
 * expects it to just work.
 *
 * Rather than touching all 140 call sites, this wraps sock.sendMessage once
 * per bot instance, right after makeWASocket() in main.js. Every call is
 * pushed onto an in-memory FIFO queue and drained on an interval, so from
 * the caller's point of view sendMessage still returns a promise that
 * resolves with the same result Baileys would give — it just may resolve
 * a little later than it would have unthrottled.
 *
 * Two knobs, both per-instance (so bot1 and bot2 can run different limits):
 *   - minGapMs: minimum spacing between two sends, jittered a bit so the
 *     timing doesn't look robotically even.
 *   - maxPerMinute: hard ceiling on sends in any trailing 60s window, on
 *     top of the gap. Catches bursts that are individually spaced fine but
 *     collectively too dense (e.g. a loop with an awaited gap per message
 *     is still ~1 msg/sec, well past what a brand-new number should do).
 *
 * Defaults are deliberately conservative for a number with no send
 * history. Tune via config.js once bot2 has been stable for a while.
 *
 * ── Why there are two lanes and three drop rules ───────────────────────────
 *
 * Reported symptom: "the bot is online, we keep sending messages and it
 * won't answer, but the hourly card and the Pokémon spawns still arrive
 * normally." That is this file, and it was a design bug rather than a crash.
 *
 * Every command costs at least TWO sends: handler.js reacts ⚔️ to the
 * message, then the plugin replies. With maxPerMinute at 40 that is a
 * hard ceiling of ~20 commands a minute — and the queue was unbounded,
 * strictly FIFO, and never dropped anything. So one busy minute in one
 * group pushed the backlog past the ceiling, and from then on every reply
 * was served in submission order, minutes-to-hours late, while the interval
 * driven spawn sweeps looked perfectly healthy: they only send once an hour,
 * so their one message eventually came out of the same queue on time enough
 * to look normal. The bot wasn't frozen, it was 400 messages behind.
 *
 * Three changes, all about shedding load instead of raising the cap (raising
 * it is what got bot2 banned in the first place):
 *
 *   1. Reactions ride a LOW-PRIORITY lane, served only when nothing real is
 *      waiting, and skipped entirely the moment a backlog exists. The ⚔️ is
 *      decoration; it must never eat a reply's slot. This alone roughly
 *      doubles command throughput at the same send rate.
 *   2. Stale jobs are dropped. A reply that has sat in the queue for
 *      STALE_MS is worthless to the person who asked for it, and keeping it
 *      is what let the backlog compound forever. Dropped jobs reject with a
 *      clear message so the failure shows up in pm2-err.log.
 *   3. Every send is raced against SEND_TIMEOUT_MS. Before, one Baileys call
 *      that never settled left `draining` true forever — a permanent,
 *      silent, total send outage for that number with nothing in the logs.
 */

/** A send that has waited this long is stale — the conversation moved on. */
const STALE_MS = 90_000

/** Reactions are worthless if they aren't near-instant. */
const LOW_STALE_MS = 12_000

/** Never let one sendMessage() wedge the drain loop (see #3 above). */
const SEND_TIMEOUT_MS = 60_000

/**
 * Skip reactions once this many real sends are already waiting. Small on
 * purpose: two queued replies already means someone is waiting on the bot.
 */
const REACT_BACKLOG_LIMIT = 3

/**
 * ── rate-overlimit (2026-09) ───────────────────────────────────────────────
 *
 * `rate-overlimit` is not this file talking — it's WhatsApp's own server
 * rejecting the stanza (the 429 equivalent). Baileys surfaces it as a plain
 * error out of sendMessage(), and before this change nothing handled it:
 *
 *   - the job was rejected, so ctx.reply() threw, so the plugin's run()
 *     aborted mid-command ("Plugin threw an error during run()"), leaving
 *     the player charged/moved with no reply;
 *   - and the drain loop carried straight on to the next job at the same
 *     pace, straight back into a server that had just said "too fast",
 *     which is how one rejection turns into a run of them.
 *
 * So a server-side throttle now: pause the whole real lane, slow the pacer
 * down, and retry the job instead of throwing it at the plugin. The bot
 * gets quieter on its own exactly when WhatsApp says it's too loud, which
 * is also the behaviour that keeps a young number from being banned.
 */
const OVERLIMIT_BASE_BACKOFF_MS = 20_000
const OVERLIMIT_MAX_BACKOFF_MS = 120_000

/** Widen the inter-send gap this much per overlimit, up to the ceiling. */
const OVERLIMIT_GAP_MULTIPLIER = 1.5
const OVERLIMIT_MAX_GAP_MS = 8_000

/** Clean sends needed before the pacer starts relaxing back to configured. */
const RECOVERY_SENDS = 10

/** A job gets this many goes before the caller is told it failed. */
const MAX_SEND_ATTEMPTS = 3

/** Baileys reports the server throttle in a few shapes depending on version. */
function isRateOverlimit(err) {
  if (!err) return false
  const text = `${err.message ?? ''} ${err.data ?? ''} ${err.output?.payload?.message ?? ''}`
  if (/rate[- ]?overlimit/i.test(text)) return true
  const code = err.output?.statusCode ?? err.status ?? err.code
  return code === 429 || code === '429'
}

/** True for sends that are pure decoration and safe to drop under load. */
function isLowPriority(args) {
  const content = args?.[1]
  return Boolean(content && typeof content === 'object' && content.react)
}

export function wrapSendWithRateLimit(sock, { botName, minGapMs = 2_500, maxPerMinute = 20, log = () => {} } = {}) {
  const originalSendMessage = sock.sendMessage.bind(sock)

  const queue = []            // real sends: replies, spawns, moderation deletes
  const lowQueue = []         // reactions only
  const sentTimestamps = []   // trailing-60s window for maxPerMinute
  let draining = false
  let lastSendAt = 0

  // Hard ceiling on the real lane. Past this the bot is so far behind that
  // the oldest entries are already useless, so they make room for the new
  // ones instead of delaying them further.
  const maxQueue = Math.max(60, maxPerMinute * 3)

  const stats = {
    dropStale: 0, dropOverflow: 0, dropReact: 0, timeouts: 0, failed: 0, sent: 0,
    overlimit: 0, retried: 0,
  }
  let lastBacklogWarnAt = 0

  // Pacing is adaptive: these start at the configured values and tighten
  // whenever the server says rate-overlimit, then relax back after a clean
  // run. The configured values are the FLOOR on how fast we'll ever go.
  let currentGapMs = minGapMs
  let currentMaxPerMinute = maxPerMinute
  let backoffUntil = 0
  let consecutiveOverlimit = 0
  let cleanSends = 0

  function nextGapMs() {
    // +/- 20% jitter around the gap so sends don't land on a perfectly
    // even beat, which is itself a signal spam filters key on.
    const jitter = currentGapMs * 0.2
    return currentGapMs + (Math.random() * jitter * 2 - jitter)
  }

  /** Server said slow down: hold the lane, widen the gap, lower the ceiling. */
  function applyOverlimitBackoff() {
    stats.overlimit++
    consecutiveOverlimit++
    cleanSends = 0

    const wait = Math.min(
      OVERLIMIT_BASE_BACKOFF_MS * 2 ** (consecutiveOverlimit - 1),
      OVERLIMIT_MAX_BACKOFF_MS,
    )
    backoffUntil = Math.max(backoffUntil, Date.now() + wait)
    currentGapMs = Math.min(currentGapMs * OVERLIMIT_GAP_MULTIPLIER, OVERLIMIT_MAX_GAP_MS)
    currentMaxPerMinute = Math.max(6, Math.floor(currentMaxPerMinute * 0.6))

    log(
      `⚠️ [${botName}] WhatsApp returned rate-overlimit (x${consecutiveOverlimit}). ` +
      `Pausing sends for ${Math.round(wait / 1000)}s, gap now ${Math.round(currentGapMs)}ms, ` +
      `ceiling now ${currentMaxPerMinute}/min. This is the server throttling us, not the local limiter.`,
    )
    return wait
  }

  /** A clean run earns the pacing back, slowly, never past the config floor. */
  function noteCleanSend() {
    consecutiveOverlimit = 0
    if (currentGapMs === minGapMs && currentMaxPerMinute === maxPerMinute) return
    if (++cleanSends < RECOVERY_SENDS) return
    cleanSends = 0
    currentGapMs = Math.max(minGapMs, currentGapMs / OVERLIMIT_GAP_MULTIPLIER)
    currentMaxPerMinute = Math.min(maxPerMinute, Math.ceil(currentMaxPerMinute * 1.25))
  }

  function pruneWindow(now) {
    const cutoff = now - 60_000
    while (sentTimestamps.length && sentTimestamps[0] < cutoff) sentTimestamps.shift()
  }

  /**
   * Pops the next job worth sending, discarding anything that has gone
   * stale on the way. Real sends always win; reactions only go out when the
   * real lane is empty.
   */
  function takeNextJob(now) {
    while (queue.length) {
      const job = queue.shift()
      if (now - job.queuedAt <= STALE_MS) return job
      stats.dropStale++
      job.reject(new Error(
        `send dropped: waited ${Math.round((now - job.queuedAt) / 1000)}s in ${botName}'s send queue ` +
        `(rate limit ${maxPerMinute}/min reached — the bot is behind, not frozen)`,
      ))
    }
    while (lowQueue.length) {
      const job = lowQueue.shift()
      if (now - job.queuedAt <= LOW_STALE_MS) return job
      stats.dropReact++
      job.resolve(undefined) // a dropped reaction is not an error
    }
    return null
  }

  /** Races a send so a never-settling Baileys call can't wedge the loop. */
  function sendWithTimeout(args) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        stats.timeouts++
        reject(new Error(`sendMessage did not settle within ${SEND_TIMEOUT_MS / 1000}s`))
      }, SEND_TIMEOUT_MS)

      originalSendMessage(...args).then(
        result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        },
        err => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length || lowQueue.length) {
        // Take the job FIRST, then pace it — because pacing depends on what
        // kind of job it is. A reaction is decoration: it must never wait out
        // the inter-send gap, and it must never count against it. The old code
        // computed the gap before knowing the job type, so a ⚔️ react fired on
        // a command reset lastSendAt and shoved that command's actual reply
        // ~a full gap into the future. That was the whole "it reacts, then the
        // reply lags" symptom. Reactions now send immediately and invisibly to
        // the pacer; only real replies are spaced (which is the ban-safety the
        // limiter exists for).
        const job = takeNextJob(Date.now())
        if (!job) continue

        if (!job.low) {
          const now = Date.now()
          pruneWindow(now)

          const sinceLast = now - lastSendAt
          const gapWait = Math.max(0, nextGapMs() - sinceLast)

          let capWait = 0
          if (sentTimestamps.length >= currentMaxPerMinute) {
            // Wait until the oldest send in the window ages out.
            capWait = Math.max(0, sentTimestamps[0] + 60_000 - now)
          }

          // Server-imposed pause from a previous rate-overlimit.
          const backoffWait = Math.max(0, backoffUntil - now)

          const wait = Math.max(gapWait, capWait, backoffWait)
          if (wait > 0) await new Promise(r => setTimeout(r, wait))

          const sendTime = Date.now()
          lastSendAt = sendTime
          sentTimestamps.push(sendTime)
        }

        try {
          const result = await sendWithTimeout(job.args)
          stats.sent++
          if (!job.low) noteCleanSend()
          job.resolve(result)
        } catch (err) {
          if (isRateOverlimit(err)) {
            applyOverlimitBackoff()

            // Don't hand a server throttle to the plugin — it has already
            // mutated the player and has no way to recover. Put the job back
            // at the FRONT (it's the oldest real work) and try again after the
            // pause. Reactions are decoration; drop them instead of retrying.
            job.attempts = (job.attempts ?? 1) + 1
            if (!job.low && job.attempts <= MAX_SEND_ATTEMPTS) {
              stats.retried++
              // It was already counted against the window/gap even though it
              // never landed; that's deliberate, it keeps us conservative.
              // Reset the stale clock, or a backoff longer than STALE_MS would
              // bin the job on the way back in and the retry would be a lie.
              job.firstQueuedAt ??= job.queuedAt
              job.queuedAt = Date.now()
              queue.unshift(job)
              continue
            }
            if (job.low) { stats.dropReact++; job.resolve(undefined); continue }
          }

          // Before this fix: job.reject(err) alone. If the plugin that
          // called sock.sendMessage() didn't .catch() its own await (most
          // of the ~140 call sites don't), that became an unhandled
          // rejection — the reply just vanished with nothing in the logs
          // to say why, while unrelated setInterval-driven sends (hourly
          // card spawn) kept working fine since they don't go through a
          // caller awaiting this same promise chain. Logging here makes
          // every dropped reply visible instead of silent.
          stats.failed++
          log(
            `⚠️ [${botName}] sendMessage failed after ${job.attempts ?? 1} attempt(s) ` +
            `(queued ${new Date(job.firstQueuedAt ?? job.queuedAt).toISOString()}): ${err.message}`,
          )
          job.reject(err)
        }
      }
    } finally {
      draining = false
      // Belt and braces: if anything arrived while we were on the way out,
      // re-arm rather than waiting for the next caller to wake us. A lost
      // wakeup here would look exactly like the outage this file documents.
      if (queue.length || lowQueue.length) setTimeout(drain, 0)
    }
  }

  sock.sendMessage = function rateLimitedSendMessage(...args) {
    return new Promise((resolve, reject) => {
      const job = { args, resolve, reject, queuedAt: Date.now(), low: isLowPriority(args) }

      if (isLowPriority(args)) {
        // Decoration. Never queue it behind real work, and never let it
        // consume send budget the replies need.
        if (queue.length >= REACT_BACKLOG_LIMIT) {
          stats.dropReact++
          resolve(undefined)
          return
        }
        lowQueue.push(job)
      } else {
        queue.push(job)

        while (queue.length > maxQueue) {
          const victim = queue.shift()
          stats.dropOverflow++
          victim.reject(new Error(
            `send dropped: ${botName}'s send queue is full (${maxQueue}) — ` +
            `sends are capped at ${maxPerMinute}/min and the bot is that far behind`,
          ))
        }

        const now = Date.now()
        if (queue.length > currentMaxPerMinute && now - lastBacklogWarnAt > 60_000) {
          lastBacklogWarnAt = now
          const oldest = Math.round((now - queue[0].queuedAt) / 1000)
          log(
            `⚠️ [${botName}] send queue backing up: ${queue.length} pending, oldest ${oldest}s old, ` +
            `${sentTimestamps.length}/${currentMaxPerMinute} sent this minute. ` +
            `Replies are being delayed and stale ones dropped — raise maxPerMinute in config.js only if this number is well trusted.`,
          )
        }
      }

      drain()
    })
  }

  // Exposed for diagnostics — read by plugins/health.js and reported by the
  // stall watchdog in main.js. Cheap getters only; no side effects.
  sock.__rateLimiter = {
    get pending() { return queue.length },
    get pendingReactions() { return lowQueue.length },
    get oldestPendingMs() { return queue.length ? Date.now() - queue[0].queuedAt : 0 },
    get sentLastMinute() { pruneWindow(Date.now()); return sentTimestamps.length },
    get draining() { return draining },
    get limits() { return { minGapMs, maxPerMinute, maxQueue } },
    get effectiveLimits() { return { minGapMs: Math.round(currentGapMs), maxPerMinute: currentMaxPerMinute } },
    get throttledForMs() { return Math.max(0, backoffUntil - Date.now()) },
    get counters() { return { ...stats } },
  }

  return sock
}
