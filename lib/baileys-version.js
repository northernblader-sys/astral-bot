/**
 * baileys-version.js — a bounded way to ask "which WhatsApp Web version should
 * I advertise?", for use on the connect path.
 *
 * WHY THIS EXISTS (2026-09: "the bot is online but nobody gets an answer")
 *
 * main.js used to do this, inline, on every single connect and every reconnect:
 *
 *     const { version, isLatest } = await fetchLatestBaileysVersion()
 *
 * Two problems, one of them capable of producing exactly the reported outage:
 *
 *  1. IT CAN HANG FOREVER. `fetchLatestBaileysVersion()` is a plain
 *     `axios.get('https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json')`
 *     with NO timeout (Baileys passes no `timeout` option, so axios waits on
 *     the OS/TCP default, which on a VPS with a blackholed route or a broken
 *     IPv6 path is measured in minutes, not seconds — and a TLS handshake
 *     that never completes can sit there indefinitely). Because that await
 *     sits BEFORE `makeWASocket()`, a hang there means: no socket is ever
 *     built, no `connection.update` fires, nothing is logged, and PM2 still
 *     reports the process as online. The process is alive, the sweeps'
 *     setInterval timers keep firing with the last socket they were handed,
 *     and inbound is permanently dead. The reconnect path is the ONLY place
 *     this runs, and it runs on the path you need to work after a network
 *     blip — which is precisely when raw.githubusercontent.com is most likely
 *     to be unreachable (the same blip that dropped the websocket usually
 *     drops the REST call too).
 *
 *  2. IT BUYS NOTHING. The endpoint is a 26-byte file on the library's
 *     `master` branch. As of the v6.7.24 release that this repo pins, the
 *     value it returns — [2, 3000, 1043857760] — is byte-for-byte identical to
 *     the copy already shipped INSIDE the package at
 *     `@whiskeysockets/baileys/lib/Defaults/baileys-version.json`, which is
 *     what `DEFAULT_CONNECTION_CONFIG.version` falls back to when `version` is
 *     not passed at all. So the network round-trip exists only to re-fetch a
 *     number we already have, on a code path where blocking is catastrophic.
 *     Worse: `master` is where the 7.0 line is developed. Fetching the version
 *     file from `master` while running the 6.7.x protocol is how a bot ends up
 *     advertising a WhatsApp build its own frame handling can't match.
 *
 * The fix: keep the remote check (it is genuinely useful the day WhatsApp
 * refuses the baked-in version and you want to bump it without upgrading the
 * library) but make it impossible for it to hold the connect path hostage:
 *
 *   • hard deadline (timeoutMs, default 5s) via AbortController AND a
 *     Promise.race, because an implementation that ignores its signal still
 *     cannot delay us;
 *   • never rejects, never throws — every failure mode resolves with
 *     `version: null`, which tells the caller "omit the option and let
 *     Baileys use its own baked-in value" (the correct answer for the version
 *     actually installed);
 *   • says out loud which of those two happened, so a degraded network shows
 *     up as a log line instead of as silence.
 *
 * Note `version: null` must never be forwarded as `{ version: undefined }` to
 * makeWASocket: DEFAULT_CONNECTION_CONFIG is merged with a spread, so an
 * explicit undefined OVERWRITES the library's default rather than falling back
 * to it. Callers must OMIT the key. `buildSocketVersionOption()` below does
 * that so no caller has to remember.
 */

/** Default deadline for the remote read. Generous for a 26-byte file. */
export const DEFAULT_VERSION_FETCH_TIMEOUT_MS = 5_000

/**
 * Resolve the WhatsApp version to advertise, with a hard deadline.
 *
 * @param {object} [opts]
 * @param {(opts?: object) => Promise<{version?: number[], isLatest?: boolean, error?: unknown}>} [opts.fetchVersion]
 *   the remote probe. Injectable so tests (and a future swap of the source)
 *   don't need network access. Defaults to Baileys' own fetcher.
 * @param {number} [opts.timeoutMs] deadline for that probe.
 * @param {(msg: string, detail?: unknown) => void} [opts.log] optional logger.
 * @returns {Promise<{version: number[]|null, source: 'remote'|'timeout'|'error'|'unavailable', waitedMs: number, note?: string}>}
 *   always resolves; never rejects.
 */
export async function resolveBaileysVersion({
  fetchVersion,
  timeoutMs = DEFAULT_VERSION_FETCH_TIMEOUT_MS,
  log,
} = {}) {
  const startedAt = Date.now()
  let probe = fetchVersion
  if (typeof probe !== 'function') {
    try {
      // Imported lazily on purpose: this module is unit-tested without
      // node_modules being complete, and a top-level import of Baileys would
      // make `lib/baileys-version.js` unimportable in that state.
      ;({ fetchLatestBaileysVersion: probe } = await import('@whiskeysockets/baileys'))
    } catch (err) {
      return {
        version: null,
        source: 'unavailable',
        waitedMs: Date.now() - startedAt,
        note: `Baileys could not be imported (${err?.message ?? err}) — using the library default.`,
      }
    }
  }

  const limit = Math.max(0, Number(timeoutMs) || 0)
  let timer
  // The abort controller is courtesy: Baileys' fetcher does not accept a
  // signal, so the race below is what actually enforces the deadline. A
  // fetcher that DOES honour it gets cancelled instead of left running.
  const controller = new AbortController()
  try {
    const result = await Promise.race([
      probe({ signal: controller.signal, timeout: limit }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('version fetch timed out'), { __baileysVersionTimeout: true })), limit)
      }),
    ])

    // `[].every(...)` is vacuously true, so an EMPTY array has to be rejected
    // explicitly: Baileys joins the version into the Hello node, and an empty
    // one is a malformed handshake rather than a fallback.
    const version = Array.isArray(result?.version) && result.version.length && result.version.every(n => Number.isFinite(Number(n)))
      ? result.version.map(Number)
      : null

    if (!version) {
      // A resolved-but-useless payload. Still not worth blocking a reconnect
      // over — fall back, and say so.
      finish(log, '⚠️ WhatsApp version probe returned no usable version — using the library default.')
      return { version: null, source: 'error', waitedMs: Date.now() - startedAt, note: 'malformed payload' }
    }

    return { version, source: 'remote', waitedMs: Date.now() - startedAt, isLatest: result?.isLatest !== false }
  } catch (err) {
    if (err?.__baileysVersionTimeout) {
      // The important branch: a slow/unreachable endpoint used to wedge
      // connect() indefinitely. Now it costs `timeoutMs` and we move on.
      finish(log, `⚠️ WhatsApp version probe timed out after ${limit}ms (github raw is slow or unreachable) — using the library default. Inbound is NOT affected.`)
      return { version: null, source: 'timeout', waitedMs: Date.now() - startedAt, note: `timed out after ${limit}ms` }
    }
    const note = String(err?.message ?? err ?? 'unknown error')
    finish(log, `⚠️ WhatsApp version probe failed (${note}) — using the library default.`)
    return { version: null, source: 'error', waitedMs: Date.now() - startedAt, note }
  } finally {
    clearTimeout(timer)
    try { controller.abort() } catch { /* already settled */ }
  }
}

function finish(log, message) {
  if (typeof log !== 'function') return
  try {
    log(message)
  } catch {
    // A diagnostic must never become the reason a connect failed.
  }
}

/**
 * Turn a resolveBaileysVersion() result into the `version` option for
 * makeWASocket — or into NO key at all, which is what "use the library's own
 * baked-in version" has to mean given how the config is merged.
 *
 * @returns {{version?: number[]}}
 */
export function buildSocketVersionOption(resolved) {
  const version = resolved?.version
  if (Array.isArray(version) && version.length && version.every(n => Number.isFinite(Number(n)))) {
    return { version: version.map(Number) }
  }
  return {}
}
