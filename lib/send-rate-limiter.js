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
 * ── The reaction lane's own pacing (2026-09: the overspam disconnect) ──────
 *
 * Reported symptom: "when the group overspams, the bot briefly loses its
 * WhatsApp connection." Reactions were the amplifier. Every command fires an
 * auto-react (handler.js), and the react lane was deliberately UNPACED
 * (invisible to the pacer, see the note in drain() below): a person typing
 * `.attack` ten times in a burst produced ten react stanzas on top of the ten
 * queued replies, and the reacts all landed inside the same second. WhatsApp's
 * spam heuristics read that burst as bot behaviour and answer with
 * rate-overlimit, and at the server's limit a device gets dropped for a beat
 * before it is allowed back: exactly the brief disconnect being reported.
 *
 * So the lane keeps everything it was built for (a react must stay near-
 * instant, must never reset a reply's gap, must never count against the reply
 * budget) and gains two decoration-only limits of its own:
 *
 *   - REACT_MIN_GAP_MS: the smallest spacing between two reactions. Far below
 *     the reply gap, so they still feel instant to one person typing normally,
 *     but a 20-command burst can no longer fire 20 reacts in one second.
 *   - REACT_MAX_PER_MINUTE: a hard per-minute budget on decoration. Past it,
 *     reactions are simply dropped (they resolve, not reject: a missing ⚔️ is
 *     never an error). Real replies have their own separate budget and are
 *     never touched by either limit.
 *
 * On top of that, decoration dies first whenever the bot is already in
 * trouble: a server-imposed backoff window (rate-overlimit) or a real
 * REACT_BACKLOG_LIMIT-deep reply queue both drop reactions on the floor
 * instead of sending them.
 */
const REACT_MIN_GAP_MS = 350
const REACT_WINDOW_MS = 60_000

/**
 * Burst allowance for interactive (quoted) replies.
 *
 * The configured gap exists to keep SUSTAINED volume safe, and it does. What
 * it should not do is make the first answer after a quiet minute wait 1.2s
 * because a spawn announcement went out 100ms earlier — that is pure latency,
 * not protection: no spam heuristic distinguishes two messages 300ms apart
 * from two messages 1.2s apart. So up to `burstMax` sends may go out spaced
 * `burstGapMs` inside any trailing BURST_WINDOW_MS window. After that the
 * configured gap takes over again until the window slides.
 *
 * The trailing-60s budget is untouched by this and still binds hard, so the
 * account's ceiling (maxPerMinute) is exactly what it was. Set burstMax to 0
 * (RATE_LIMIT_BURST=0) to disable.
 */
const BURST_WINDOW_MS = 10_000

/**
 * Bulk traffic (a spawn sweep, a mass DM, a welcome) normally yields to
 * replies, but must not be starved forever by a permanently deep reply queue.
 * Past this age a bulk job jumps the interactive ones.
 *
 * Kept short on purpose: it is also the worst-case delay a plugin's own
 * unquoted follow-up message can see while other chats are being answered.
 */
const BULK_STARVATION_MS = 3_000

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

/**
 * ── Reply latency, priority and the burst allowance (2026-09) ──────────────
 *
 * Reported symptom: "the tracking works fine, but when a player uses a command
 * the answer takes forever." Two things made that true, both about ORDERING
 * rather than about the send rate itself.
 *
 *   1. One FIFO for everything real. A spawn announcement, an AFK notice, a
 *      card broadcast and a player's reply all shared a single queue, so a
 *      reply queued behind whatever bulk traffic happened to be ahead of it.
 *      Now a *quoted* send — which is what ctx.reply() always is, and what
 *      every plugin reply goes through — is tagged interactive and is picked
 *      ahead of unquoted bulk traffic. Order of *delivery* changes; the total
 *      rate does not.
 *
 *   2. One chat could monopolise the lane. Ten rapid commands from one player
 *      (or one scripted test account) pushed every other player's answer
 *      behind all ten. Interactive jobs are now served round-robin between
 *      chats, so one chat's backlog costs another chat at most one slot.
 *
 * On top of that, interactive replies get a small BURST allowance: see
 * burstAvailable() below. It never raises the account's per-minute ceiling —
 * it only stops the very first reply after a quiet moment from waiting out a
 * full inter-send gap it has no reason to wait for.
 */
export function wrapSendWithRateLimit(sock, {
  botName,
  minGapMs = 2_500,
  maxPerMinute = 20,
  burstMax = 3,
  burstGapMs = 350,
  bulkStarvationMs = BULK_STARVATION_MS,
  log = () => {},
} = {}) {
  const originalSendMessage = sock.sendMessage.bind(sock)

  // Real sends (replies, spawns, moderation deletes) in one array so the
  // diagnostics, the overflow rule and the stale clock all stay in one place.
  // `job.interactive` marks the quoted ones; takeNextJob() picks the order.
  const queue = []
  const lowQueue = []         // reactions only
  const sentTimestamps = []   // trailing-60s window for maxPerMinute
  let draining = false
  let lastSendAt = 0

  // Round-robin bookkeeping for interactive jobs: chat → how many of that
  // chat's jobs have already been served. takeReplyJob() always picks the
  // waiting job from the chat with the FEWEST served, so a chat with a deep
  // backlog cannot starve everyone else. Bounded by pruneServed().
  const servedFromChat = new Map()
  const SERVED_MAP_MAX = 500

  // Hard ceiling on the real lane. Past this the bot is so far behind that
  // the oldest entries are already useless, so they make room for the new
  // ones instead of delaying them further.
  const maxQueue = Math.max(60, maxPerMinute * 3)

  const stats = {
    dropStale: 0, dropOverflow: 0, dropReact: 0, timeouts: 0, failed: 0, sent: 0,
    overlimit: 0, retried: 0, burstSends: 0,
  }
  let lastBacklogWarnAt = 0

  // Pacing is adaptive: these start at the configured values and tighten
  // whenever the server says rate-overlimit, then relax back after a clean
  // run. The configured values are the FLOOR on how fast we'll ever go.
  let currentGapMs = minGapMs
  let currentMaxPerMinute = maxPerMinute
  // Burst allowance, halved on every overlimit and earned back one at a time.
  let currentBurstMax = Math.max(0, burstMax)
  let backoffUntil = 0
  let consecutiveOverlimit = 0
  let cleanSends = 0

  function nextGapMs(base = currentGapMs) {
    // +/- 20% jitter around the gap so sends don't land on a perfectly
    // even beat, which is itself a signal spam filters key on.
    const jitter = base * 0.2
    return base + (Math.random() * jitter * 2 - jitter)
  }

  /**
   * True while an interactive reply may use the burst pacing (burstGapMs)
   * instead of the configured gap.
   *
   * Counts EVERY real send in the trailing burst window, bulk included, so a
   * spawn sweep can't leave the allowance looking unspent. Suppressed entirely
   * while the server has asked us to slow down — that is not the moment to
   * spend a faster-than-configured cadence.
   */
  function burstAvailable(now) {
    if (!currentBurstMax) return false
    if (now < backoffUntil) return false
    let recent = 0
    for (let i = sentTimestamps.length - 1; i >= 0; i--) {
      if (now - sentTimestamps[i] > BURST_WINDOW_MS) break
      recent++
    }
    return recent < currentBurstMax
  }

  /**
   * Keep the round-robin scoreboard from growing one entry per chat forever.
   * Subtracting the current floor keeps the relative order (which is all the
   * scheduler reads) and drops everything already at that floor.
   */
  function pruneServed() {
    if (servedFromChat.size <= SERVED_MAP_MAX) return
    let floor = Infinity
    for (const n of servedFromChat.values()) if (n < floor) floor = n
    for (const [chat, n] of [...servedFromChat]) {
      if (n <= floor) servedFromChat.delete(chat)
      else servedFromChat.set(chat, n - floor)
    }
  }

  function dropStaleJob(job, now) {
    stats.dropStale++
    job.reject(new Error(
      `send dropped: waited ${Math.round((now - job.queuedAt) / 1000)}s in ${botName}'s send queue ` +
      `(rate limit ${maxPerMinute}/min reached — the bot is behind, not frozen)`,
    ))
  }

  /**
   * Next interactive job: the waiting reply whose chat has been served the
   * fewest times, oldest first within that. A chat with ten queued commands
   * therefore gets one slot, then other chats get theirs, then it comes back
   * around — instead of all ten landing before anyone else's answer.
   */
  function takeReplyJob(now) {
    while (true) {
      let bestIndex = -1
      let bestServed = Infinity
      let bestQueuedAt = Infinity
      for (let i = 0; i < queue.length; i++) {
        const job = queue[i]
        if (!job.interactive) continue
        const served = servedFromChat.get(job.chat) ?? 0
        if (served < bestServed || (served === bestServed && job.queuedAt < bestQueuedAt)) {
          bestIndex = i
          bestServed = served
          bestQueuedAt = job.queuedAt
        }
      }
      if (bestIndex === -1) return null

      const [job] = queue.splice(bestIndex, 1)
      servedFromChat.set(job.chat, (servedFromChat.get(job.chat) ?? 0) + 1)
      pruneServed()

      // Stale jobs are dropped on the way out, whichever lane they came from.
      if (now - job.queuedAt > STALE_MS) { dropStaleJob(job, now); continue }
      return job
    }
  }

  /** Next bulk job, oldest first. */
  function takeBulkJob(now) {
    let bestIndex = -1
    let bestQueuedAt = Infinity
    for (let i = 0; i < queue.length; i++) {
      const job = queue[i]
      if (job.interactive) continue
      if (job.queuedAt < bestQueuedAt) { bestIndex = i; bestQueuedAt = job.queuedAt }
    }
    if (bestIndex === -1) return null

    const [job] = queue.splice(bestIndex, 1)
    if (now - job.queuedAt > STALE_MS) { dropStaleJob(job, now); return takeBulkJob(now) }
    return job
  }

  /**
   * Pops the next REAL job worth sending, discarding anything that has gone
   * stale on the way. Reactions no longer ride this lane at all: they have
   * their own drainLow() with their own pacing (see REACT_MIN_GAP_MS above),
   * which is what keeps a reaction from ever pushing a reply's send back.
   *
   * Order: a bulk job that has waited past bulkStarvationMs first (so
   * spawns/announcements still get out), then interactive replies, then bulk.
   */
  function takeNextJob(now) {
    const headBulkAt = oldestBulkQueuedAt()
    if (headBulkAt !== Infinity && now - headBulkAt > bulkStarvationMs) return takeBulkJob(now)
    return takeReplyJob(now) ?? takeBulkJob(now)
  }

  function oldestQueuedAt() {
    let oldest = Infinity
    for (const job of queue) if (job.queuedAt < oldest) oldest = job.queuedAt
    return oldest === Infinity ? 0 : oldest
  }

  function oldestBulkQueuedAt() {
    let oldest = Infinity
    for (const job of queue) if (!job.interactive && job.queuedAt < oldest) oldest = job.queuedAt
    return oldest
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
    // Throttled numbers don't get the fast cadence either.
    currentBurstMax = Math.max(0, Math.floor(currentBurstMax / 2))

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
    if (
      currentGapMs === minGapMs &&
      currentMaxPerMinute === maxPerMinute &&
      currentBurstMax === Math.max(0, burstMax)
    ) return
    if (++cleanSends < RECOVERY_SENDS) return
    cleanSends = 0
    currentGapMs = Math.max(minGapMs, currentGapMs / OVERLIMIT_GAP_MULTIPLIER)
    currentMaxPerMinute = Math.min(maxPerMinute, Math.ceil(currentMaxPerMinute * 1.25))
    currentBurstMax = Math.min(Math.max(0, burstMax), currentBurstMax + 1)
  }

  function pruneWindow(now) {
    const cutoff = now - 60_000
    while (sentTimestamps.length && sentTimestamps[0] < cutoff) sentTimestamps.shift()
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
      while (queue.length) {
        // Real jobs only. Reactions have their own lane below (drainLow),
        // split out so a reaction can never sit in front of a reply, reset a
        // reply's gap, or spend the reply budget. Everything this loop
        // paces is a message somebody is actually waiting on.
        const job = takeNextJob(Date.now())
        if (!job) continue

        const now = Date.now()
        pruneWindow(now)

        // An interactive reply may spend the burst allowance; bulk traffic and
        // replies past the allowance pace at the configured (adaptive) gap.
        const useBurst = job.interactive && burstAvailable(now)
        const sinceLast = now - lastSendAt
        const gapWait = Math.max(0, nextGapMs(useBurst ? burstGapMs : currentGapMs) - sinceLast)
        if (useBurst) stats.burstSends++

        let capWait = 0
        if (sentTimestamps.length >= currentMaxPerMinute) {
          // Wait until the oldest send in the window ages out.
          capWait = Math.max(0, sentTimestamps[0] + 60_000 - now)
        }

        // Server-imposed pause from a previous rate-overlimit.
        const backoffWait = Math.max(0, backoffUntil - now)

        let wait = Math.max(gapWait, capWait, backoffWait)

        // A bulk job that is about to hit its starvation deadline must not sit
        // behind a pacing wait already in progress — otherwise the wait the
        // job never got to preempt is what starves it. Wake at the deadline and
        // let takeNextJob() pick it then.
        const bulkAt = oldestBulkQueuedAt()
        if (bulkAt && bulkAt !== Infinity) {
          const bulkWait = Math.max(0, bulkAt + bulkStarvationMs - now)
          if (bulkWait < wait) wait = bulkWait
        }

        if (wait > 0) await new Promise(r => setTimeout(r, wait))

        const sendTime = Date.now()
        lastSendAt = sendTime
        sentTimestamps.push(sendTime)

        try {
          const result = await sendWithTimeout(job.args)
          stats.sent++
          noteCleanSend()
          job.resolve(result)
        } catch (err) {
          if (isRateOverlimit(err)) {
            applyOverlimitBackoff()

            // Don't hand a server throttle to the plugin — it has already
            // mutated the player and has no way to recover. Put the job back
            // at the FRONT (it's the oldest real work) and try again after
            // the pause.
            job.attempts = (job.attempts ?? 1) + 1
            if (job.attempts <= MAX_SEND_ATTEMPTS) {
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
      if (queue.length) setTimeout(drain, 0)
    }
  }

  // ── The reaction lane ──────────────────────────────────────────────────────
  // Own loop, own pacing, own per-minute budget (REACT_MIN_GAP_MS /
  // REACT_WINDOW_MS above). The structural split is what keeps the three
  // guarantees test/react-no-delay.test.mjs enforces: a reaction never delays
  // a reply, never resets a reply's gap, and never counts toward the reply
  // budget (react sends never touch sentTimestamps). On top of the pacing,
  // decoration dies first whenever the bot is in trouble: a server backoff
  // (rate-overlimit) or a deep reply backlog drops the ⚔️ instead of sending
  // it. Under command overspam this is the difference between "reactions get
  // shed" and "WhatsApp drops the connection for a beat".
  const reactTimestamps = []
  let lastReactAt = 0
  let lowDraining = false
  // Half the real budget, floored at 6/min for very tight configs so a slow
  // leak of decoration still survives single commands.
  const reactMaxPerMinute = Math.max(6, Math.floor(maxPerMinute / 2))

  function pruneReactWindow(now) {
    const cutoff = now - REACT_WINDOW_MS
    while (reactTimestamps.length && reactTimestamps[0] < cutoff) reactTimestamps.shift()
  }

  function dropReact(job) {
    stats.dropReact++
    job.resolve(undefined) // a dropped reaction is not an error
  }

  async function drainLow() {
    if (lowDraining) return
    lowDraining = true
    try {
      while (lowQueue.length) {
        const job = lowQueue.shift()

        if (Date.now() < backoffUntil || queue.length >= REACT_BACKLOG_LIMIT) {
          dropReact(job)
          continue
        }

        const now = Date.now()
        pruneReactWindow(now)
        if (reactTimestamps.length >= reactMaxPerMinute) {
          dropReact(job)
          continue
        }

        const gapWait = Math.max(0, (lastReactAt + REACT_MIN_GAP_MS) - now)
        if (gapWait > 0) await new Promise(r => setTimeout(r, gapWait))

        if (Date.now() - job.queuedAt > LOW_STALE_MS) {
          dropReact(job)
          continue
        }

        try {
          await sendWithTimeout(job.args)
          stats.sent++
          lastReactAt = Date.now()
          reactTimestamps.push(lastReactAt)
          job.resolve(undefined)
        } catch (err) {
          // A server throttle pauses the WHOLE bot (applyOverlimitBackoff
          // holds the real lane too — the 429 is account-wide), and the
          // decoration itself is simply dropped. Reactions are never
          // retried: a stale ⚔️ is worth nothing.
          if (isRateOverlimit(err)) applyOverlimitBackoff()
          dropReact(job)
        }
      }
    } finally {
      lowDraining = false
      if (lowQueue.length) setTimeout(drainLow, 0)
    }
  }

  sock.sendMessage = function rateLimitedSendMessage(...args) {
    return new Promise((resolve, reject) => {
      // A quoted send is a reply to something someone just said — every
      // ctx.reply() in the codebase quotes the command message, and the bulk
      // senders (spawn sweeps, hourly cards, welcomes, mass DMs) don't.
      const quoted = Boolean(args?.[2]?.quoted)
      const chat = typeof args?.[0] === 'string' ? args[0] : 'unknown'
      const job = {
        args, resolve, reject, queuedAt: Date.now(),
        low: isLowPriority(args),
        interactive: quoted,
        chat,
      }

      if (isLowPriority(args)) {
        // Decoration. Never queue it behind real work, and never let it
        // consume send budget the replies need.
        if (queue.length >= REACT_BACKLOG_LIMIT) {
          stats.dropReact++
          resolve(undefined)
          return
        }
        lowQueue.push(job)
        drainLow()
        return
      }

      // Real send: queue it and wake the real lane.
      {
        queue.push(job)

        while (queue.length > maxQueue) {
          // Oldest first, bulk before replies: a stale announcement is worth
          // less than a player's answer, and the newest job is the one the
          // person asking is still waiting for.
          let victimIndex = 0
          for (let i = 1; i < queue.length; i++) {
            const candidate = queue[i]
            const victim = queue[victimIndex]
            const rank = candidate.interactive ? 1 : 0
            const victimRank = victim.interactive ? 1 : 0
            if (rank < victimRank || (rank === victimRank && candidate.queuedAt < victim.queuedAt)) {
              victimIndex = i
            }
          }
          const [victim] = queue.splice(victimIndex, 1)
          stats.dropOverflow++
          victim.reject(new Error(
            `send dropped: ${botName}'s send queue is full (${maxQueue}) — ` +
            `sends are capped at ${maxPerMinute}/min and the bot is that far behind`,
          ))
        }

        const now = Date.now()
        if (queue.length > currentMaxPerMinute && now - lastBacklogWarnAt > 60_000) {
          lastBacklogWarnAt = now
          const oldest = Math.round((now - oldestQueuedAt()) / 1000)
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
    get pendingReplies() { return queue.reduce((n, job) => n + (job.interactive ? 1 : 0), 0) },
    get pendingBulk() { return queue.reduce((n, job) => n + (job.interactive ? 0 : 1), 0) },
    get pendingReactions() { return lowQueue.length },
    get oldestPendingMs() { const at = oldestQueuedAt(); return at ? Date.now() - at : 0 },
    get sentLastMinute() { pruneWindow(Date.now()); return sentTimestamps.length },
    get draining() { return draining },
    get burstReady() { return burstAvailable(Date.now()) },
    get limits() { return { minGapMs, maxPerMinute, maxQueue, burstMax, burstGapMs } },
    get effectiveLimits() {
      return {
        minGapMs: Math.round(currentGapMs),
        maxPerMinute: currentMaxPerMinute,
        burstMax: currentBurstMax,
        burstGapMs,
      }
    },
    get throttledForMs() { return Math.max(0, backoffUntil - Date.now()) },
    get counters() { return { ...stats } },
  }

  return sock
}
