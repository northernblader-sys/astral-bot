/**
 * loop-lag.js — measures how long the event loop is actually blocked, so the
 * next "why is the bot slow" conversation starts from a number.
 *
 * THE AMBIGUITY THIS REMOVES
 *
 * Every symptom this bot has ever chased — replies arriving minutes late, the
 * whole group going unanswered for a minute and then recovering, Baileys
 * reporting `Connection was lost` out of nowhere — has two candidate causes
 * that look identical from the outside:
 *
 *   (a) the socket/network is broken, or
 *   (b) this process is fine but is so busy that it cannot service the socket.
 *
 * (b) is the one that gets blamed on Baileys. It is also unavoidable here by
 * construction: the database is one object that is `JSON.stringify`ed whole on
 * every flush (lib/fast-json-adapter.js), and a stringify of a multi-megabyte
 * db.json is synchronous — it holds the loop, so websocket frames, timers, and
 * every other player's command wait behind it. Baileys then sees "no frame
 * received in N seconds" and ends the connection, which is (a) pretending to
 * be (b).
 *
 * There was no way to tell them apart without instrumenting the process, so
 * `.health` now reports the loop delay directly. High lag + a backed-up
 * inbound queue = the app is starved, and reconnecting only throws the backlog
 * away. Low lag + a backed-up queue = something inside a handler is awaiting a
 * promise that never settles. Zero lag and no inbound at all = the network.
 *
 * The measurement is `perf_hooks.monitorEventLoopDelay()`, which counts real
 * scheduling delay (how late a timer fired vs. when it was due) — not CPU
 * usage, which is a much worse proxy. Where that histogram is unavailable
 * (older Node, unusual sandboxes) this degrades to raw timer drift, which
 * measures the same thing slightly less precisely and never crashes.
 *
 * Sampling happens on our own interval and the window is cached, so any number
 * of readers (`.health`, the stall watchdog, the API) can look at it without
 * stealing each other's measurement — `histogram.reset()` on read would have
 * made the first reader of each window win.
 *
 * A reader therefore gets BOTH views: the latest window, and the recency of the
 * last starve. The second one is not optional. A block that ended two windows
 * ago is gone from the latest window but is exactly the evidence a 60-second
 * watchdog tick needs — the first version of this module reported only the
 * current window, and its own test caught a 500ms stall that had already been
 * overwritten by the quiet window after it. `worstMs` since boot is the other
 * half: "has this process EVER blocked like that" is what distinguishes a
 * chronic problem from a one-off.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks'

/** One measurement window. Short enough that "slow for 2 minutes" is visible. */
const DEFAULT_WINDOW_MS = 5_000

/**
 * p99 loop delay above this is "starved", not "busy". 500ms is deliberately
 * loud: a normal command turn is single-digit milliseconds, and this threshold
 * only trips when something is genuinely holding the loop.
 */
const DEFAULT_STARVE_MS = 500

/** nanoseconds → milliseconds, rounded to one decimal. */
const nsToMs = ns => Math.round((Number(ns) / 100_000) * 10) / 10

export function createLoopLagMonitor({ windowMs = DEFAULT_WINDOW_MS, starveMs = DEFAULT_STARVE_MS } = {}) {
  const window = Math.max(250, Number(windowMs) || DEFAULT_WINDOW_MS)
  const starveThreshold = Math.max(1, Number(starveMs) || DEFAULT_STARVE_MS)

  let histogram = null
  try {
    histogram = monitorEventLoopDelay({ resolution: Math.min(20, Math.max(1, Math.floor(window / 50))) })
    if (typeof histogram?.enable !== 'function') histogram = null
    else {
      histogram.enable()
      // Never let the monitor itself be the reason the process stays alive.
      try { histogram.unref?.() } catch { /* optional in some runtimes */ }
    }
  } catch {
    histogram = null
  }

  // Fallback (and cross-check): drift of our own interval. If this is large
  // while the histogram says otherwise, the histogram is not working.
  let lastTickAt = Date.now()
  let driftMaxMs = 0
  let windows = 0
  let starvedWindows = 0
  let lastStarvedAt = 0
  let worstMs = 0
  // How long a starve stays "recent" for readers. Generous, because the
  // watchdog only looks once a minute.
  const recentMs = Math.max(30_000, window * 6)
  let cached = { meanMs: 0, p99Ms: 0, maxMs: 0, driftMaxMs: 0, windowMs: window, source: histogram ? 'histogram' : 'drift' }
  const startedAt = Date.now()

  function sample() {
    const now = Date.now()
    const drift = Math.max(0, now - lastTickAt - window)
    lastTickAt = now
    driftMaxMs = Math.max(driftMaxMs, drift)
    windows++

    let meanMs = 0
    let p99Ms = 0
    let maxMs = 0
    if (histogram) {
      try {
        meanMs = nsToMs(histogram.mean)
        p99Ms = nsToMs(histogram.percentile(99))
        maxMs = nsToMs(histogram.max)
        histogram.reset()
      } catch {
        p99Ms = drift
        meanMs = drift
        maxMs = driftMaxMs
      }
    } else {
      meanMs = drift
      p99Ms = drift
      maxMs = driftMaxMs
    }

    // Drift is always trustworthy, so treat the bigger of the two as the truth.
    p99Ms = Math.max(p99Ms, drift)
    maxMs = Math.max(maxMs, drift)
    worstMs = Math.max(worstMs, maxMs)

    if (p99Ms >= starveThreshold) {
      starvedWindows++
      lastStarvedAt = now
    }
    cached = { meanMs, p99Ms, maxMs, driftMaxMs, windowMs: window, source: histogram ? 'histogram' : 'drift' }
  }

  const timer = setInterval(sample, window)
  try { timer.unref?.() } catch { /* optional */ }

  return {
    /**
     * Latest completed window plus the history a 60-second reader needs.
     * Read-only: never resets the window, so any number of readers can share
     * one sampler.
     */
    snapshot() {
      const now = Date.now()
      return {
        ...cached,
        starved: cached.p99Ms >= starveThreshold,
        starveThresholdMs: starveThreshold,
        windows,
        starvedWindows,
        worstMs,
        // True when a starve happened within recentMs — the view a watchdog or
        // a human typing `.health` actually wants, since the current window may
        // already have drained.
        starvedRecently: lastStarvedAt > 0 && now - lastStarvedAt <= recentMs,
        lastStarvedAt,
        lastStarvedAgoMs: lastStarvedAt ? Math.max(0, now - lastStarvedAt) : null,
        recentMs,
        sinceAt: startedAt,
      }
    },
    stop() {
      clearInterval(timer)
      try { histogram?.disable?.() } catch { /* already gone */ }
    },
  }
}

/** Process-wide monitor, started once by main.js and read by `.health`. */
let active = null

export function startLoopLagMonitor(options) {
  if (active) return active
  active = createLoopLagMonitor(options)
  return active
}

export function getLoopLagSnapshot() {
  return active ? active.snapshot() : null
}

export function stopLoopLagMonitor() {
  if (!active) return
  try { active.stop() } catch { /* shutting down */ }
  active = null
}
