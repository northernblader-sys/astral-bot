/**
 * decrypt-forensics.js — turns Baileys/libsignal's "failed to decrypt message"
 * noise into something an operator can actually act on.
 *
 * ── The problem this solves (2026-09) ──────────────────────────────────────
 *
 * A wedged Signal session produces, per affected message:
 *
 *   1. libsignal (node_modules/libsignal/src/session_cipher.js) printing
 *      `Failed to decrypt message with any known session...` followed by
 *      `Session error:<reason>` + a stack — with a bare console.error(), NOT
 *      through Baileys' logger. main.js's SPAM_PATTERNS matches the stack
 *      tokens (`SessionCipher`, `verifyMAC`, `decryptWithSessions`), so the
 *      ONLY line carrying the reason was thrown away by the stream filter.
 *   2. Baileys logging `failed to decrypt message` with `{ key, err }` —
 *      through the per-instance logger, so this one DOES know which bot and
 *      which sender it belongs to, but `err.message` is only ever the
 *      generic wrapper (`No matching sessions found for message`); the real
 *      cause lives in the stack libsignal already printed in (1).
 *   3. A retry receipt, the sender re-sending, and up to maxMsgRetryCount=5
 *      rounds of the same thing. One stuck message ≈ 5+ log lines.
 *   4. Baileys still emitting the message to `messages.upsert` as a
 *      CIPHERTEXT stub with no `.message`, which is why main.js's watchdog
 *      could never fire: it measured "no inbound" but the failed messages
 *      kept the inbound clock fresh (see the lastDecryptOkAt notes there).
 *
 * So the pieces are all present but split across two logging systems that
 * never meet. This module bridges them:
 *
 *   • `captureLibsignalLine()` recognises libsignal's console output, pulls
 *     the sender/device/reason out of it and hands it back for the console
 *     wrapper in main.js to stash (stashSignalReason/takeSignalReason).
 *     Libsignal prints the reason BEFORE Baileys logs the failure, so the
 *     stashed reason is still waiting when recordSignalFailure() runs with
 *     the instance + sender — that is what lets the log line name both the
 *     bot and the real cause.
 *
 *   • `createDecryptLedger()` is the per-instance counter with the alarm
 *     behaviour the watchdog and the log need: a sliding window, deduped
 *     per-sender forensic lines, and an aggregate alert that fires on the
 *     first crossing of the threshold and then only every `logEveryN` above
 *     the last one it printed. (The old `n % 25 === 0` fired again every time
 *     the window pruned back below 50 and the next failure pushed it over —
 *     hours of repeated `#50 in 10 min` lines and no way to tell the first
 *     crossing from the tenth.)
 *
 *   • `decryptFailureHint()` says what to do about it, because "Bad MAC" and
 *     "52 senders failing at once" are two different incidents: the first is
 *     a stale per-sender session, the second is almost always the same
 *     number logged in twice.
 *
 * Everything here is pure — no fs, no network, no globals — so it can be
 * unit-tested without booting a socket (test/decrypt-forensics.test.mjs).
 */

/** Same matcher main.js has always used: "this is a decryption failure". */
export const DECRYPT_FAIL_RE = /fail(ed)? to decrypt|bad mac|session error|bad session|invalid session/i

/** libsignal's first line — printed with a bare console.error(). */
export const LIBSIGNAL_NO_SESSION_RE = /failed to decrypt message with any known session/i

/** libsignal's second line, carrying the actual reason: `Session error:<err>`. */
export const LIBSIGNAL_REASON_RE = /session error:/i

/** A stack frame from session_cipher.js — proves the line came from libsignal. */
export const LIBSIGNAL_STACK_RE = /session_cipher|session_builder|libsignal|verifyMAC|decryptWithSessions|asyncQueueExecutor/i

/**
 * libsignal's `at async <user>.<device> [as awaitable] (…/session_cipher.js)`
 * frame names the Signal protocol address that failed, e.g.
 * `223472198410327.0` = that number's primary device. It is the only place
 * the DEVICE is visible at all — Baileys' WAMessageKey carries the jid but
 * not the device — so it is worth pulling out.
 */
const ADDRESS_FRAME_RE = /(?:async\s+)?([0-9]{5,20})(?:[_:.](\d{1,2}))?\s+\[as awaitable\]/

/** Fallback: a jid anywhere in the text. */
const JID_RE = /([0-9]{5,20})(?::(\d{1,2}))?@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)/i

const REASON_PATTERNS = [
  {
    re: /bad mac/i,
    reason: 'Bad MAC — stored Signal session does not match that device',
    kind: 'mac',
  },
  {
    re: /messagecountererror|key used already|never filled/i,
    reason: 'MessageCounterError — ciphertext already consumed (duplicate / replayed)',
    kind: 'counter',
  },
  {
    re: /no matching sessions found|no sessions available|no session record|no sessions\b/i,
    reason: 'no Signal session matches that sender device',
    kind: 'nosession',
  },
  {
    re: /untrusted identity|identity key/i,
    reason: 'untrusted / rotated identity key',
    kind: 'identity',
  },
  {
    re: /incompatible version/i,
    reason: 'incompatible Signal message version (peer on an older protocol)',
    kind: 'version',
  },
  {
    re: /invalid key ?id|registrationid|prekey/i,
    reason: 'bad or expired prekey message',
    kind: 'prekey',
  },
  {
    re: /over 2000 messages/i,
    reason: 'ratchet too far ahead (2000+ skipped messages)',
    kind: 'ratchet',
  },
  {
    re: /chain closed/i,
    reason: 'receiving chain already closed',
    kind: 'chain',
  },
]

/**
 * Human-readable cause for one failure. Falls back to the first useful line of
 * whatever we were given, so an unknown libsignal error still shows *something*
 * in the log instead of being swallowed.
 */
export function classifyDecryptReason(text = '') {
  const raw = String(text ?? '')
  for (const p of REASON_PATTERNS) if (p.re.test(raw)) return p.reason

  const line = raw
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !/^at\s/.test(l)) ?? ''
  const cleaned = line.replace(/^session error:\s*/i, '').replace(/^error:\s*/i, '').trim()
  return cleaned ? cleaned.slice(0, 160) : 'unknown decryption failure'
}

/** Coarse bucket used by decryptFailureHint()/snapshot() — never shown raw. */
export function classifyDecryptKind(text = '') {
  const raw = String(text ?? '')
  for (const p of REASON_PATTERNS) if (p.re.test(raw)) return p.kind
  return 'other'
}

function isObject(v) {
  return v !== null && typeof v === 'object'
}

/**
 * Pulls the failing sender (and device, when the stack exposes it) out of a
 * failure. Two shapes are handled because main.js has two sources:
 *
 *   • Baileys' logger: recordSignalFailure(inst, [{ key: WAMessageKey, err }, 'failed to decrypt message'])
 *   • libsignal's console line: { text } (+ optional pending text)
 *
 * The key wins when both exist: it is the message's own addressing.
 */
export function extractDecryptContext({ args = [], text = '', pendingText = '' } = {}) {
  const key = args.map(a => (isObject(a) ? (a.key ?? a.msg?.key) : null)).find(Boolean) ?? null

  const fromKey = key ? (key.participant || key.remoteJid || key.senderLid || key.senderPn || null) : null
  const blob = `${text}\n${pendingText}`
  const addr = blob.match(ADDRESS_FRAME_RE)
  const jidMatch = blob.match(JID_RE)

  const jid = fromKey || (jidMatch ? `${jidMatch[1]}@${jidMatch[3]}` : null)
  // Device from the key (`user:device`), else from libsignal's stack frame.
  const keyDevice = typeof fromKey === 'string' && fromKey.includes(':')
    ? fromKey.split(':')[1]?.replace(/@.*$/, '')
    : null
  const device = keyDevice ?? (addr?.[2] ?? (jidMatch?.[2] ?? null))

  return {
    jid: jid ?? null,
    // libsignal's stack names the bare Signal protocol address
    // (`223472198410327.0`) with no jid suffix. The Baileys key that follows
    // supplies the jid; when only the console line is available this is still
    // worth reporting — it names the number — so keep it separately rather
    // than guessing @lid vs @s.whatsapp.net.
    address: jid ? null : (addr?.[1] ?? jidMatch?.[1] ?? null),
    device: device == null ? null : String(device),
    group: key?.remoteJid && String(key.remoteJid).endsWith('@g.us') ? String(key.remoteJid) : null,
    fromMe: key?.fromMe === true,
  }
}

/** The part of a jid before '@' — what the logs elsewhere use for players. */
export function senderLabel(jid) {
  if (!jid) return 'unknown sender'
  const s = String(jid)
  const at = s.lastIndexOf('@')
  return at === -1 ? s : s.slice(0, at)
}

/**
 * Recognises libsignal's raw console output and returns the reason text to
 * stash, or null when the line is not a decryption failure. main.js's console
 * wrapper uses this to (a) keep the reason and (b) drop the line, since it
 * would otherwise be eaten by SPAM_PATTERNS anyway.
 */
export function captureLibsignalLine(...args) {
  const text = args
    .map(a => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.message} ${a.stack ?? ''}`
      if (isObject(a)) {
        try { return JSON.stringify(a) } catch { return '' }
      }
      return String(a ?? '')
    })
    .join(' ')
    .trim()

  if (!text) return null
  const isNoSession = LIBSIGNAL_NO_SESSION_RE.test(text)
  const isReasonLine = LIBSIGNAL_REASON_RE.test(text) && LIBSIGNAL_STACK_RE.test(text)
  if (!isNoSession && !isReasonLine) return null

  // "Failed to decrypt message with any known session..." carries no reason by
  // itself — keep it as a placeholder so the count still lines up when the
  // reason line never arrives (e.g. the prekey path throws before printing).
  if (isNoSession && !isReasonLine) return { reason: 'no known Signal session', kind: 'nosession', placeholder: true }
  return { reason: classifyDecryptReason(text), kind: classifyDecryptKind(text), placeholder: false }
}

/**
 * One short, actionable line for an operator. The two shapes that matter in
 * practice: failures concentrated in a few senders (stale sessions — a
 * reconnect renegotiates them) versus a broad storm across many senders
 * (almost always the same number logged in twice, fighting over one Signal
 * state).
 */
export function decryptFailureHint({ distinctSenders = 0, dominantKind = null, sawSessionConflict = false } = {}) {
  if (sawSessionConflict) {
    return 'This number was ALSO closed by WhatsApp with statusCode 440 (session conflict) — ' +
      'it is logged in somewhere else. Two sockets on one auth folder produce exactly this ' +
      'much Bad MAC. Stop the other instance (a local run, an old Railway deploy, a stale PM2 app).'
  }
  if (dominantKind === 'nosession') {
    return 'No Signal session at all for those senders — the reconnect rebuilds them on the next message they send.'
  }
  if (dominantKind === 'counter') {
    return 'Ciphertext already-consumed errors are usually duplicate/replayed deliveries, not a broken link — ' +
      'harmless unless the same sender keeps hitting it.'
  }
  if (distinctSenders >= 8) {
    return 'Failures span many senders at once, which is not a normal stale session. The usual cause is this ' +
      'number being logged in twice (a second deployment, or a local run sharing the auth folder) — check that ' +
      'exactly one instance is running before re-pairing.'
  }
  if (distinctSenders <= 3 && distinctSenders > 0) {
    return 'Failures are concentrated in a few sender devices — stale sessions for those senders. ' +
      'A forced reconnect renegotiates them; if it survives the reconnect, those devices must re-send.'
  }
  return null
}

/**
 * Bridge state between libsignal's console line and Baileys' logger call.
 *
 * libsignal prints, in order:
 *   "Failed to decrypt message with any known session..."   ← header, no reason
 *   "Session error:<err>" + stack                           ← the reason
 * then throws; only then does Baileys log `failed to decrypt message` with the
 * WAMessageKey. So the reason has to be parked for a moment, and the two
 * libsignal lines belong to ONE failure — if the header were queued as its own
 * entry, the reason would be reported against the NEXT failure and every line
 * in the log would name the previous incident's cause. Hence the in-place
 * upgrade below.
 */
export function createReasonStash({ ttlMs = 5_000, max = 32 } = {}) {
  /** @type {{ at:number, text:string, placeholder:boolean }[]} */
  let items = []

  function prune(now) {
    while (items.length && now - items[0].at > ttlMs) items.shift()
    while (items.length > max) items.shift()
  }

  return {
    remember(text, placeholder = false, now = Date.now()) {
      const last = items[items.length - 1]
      if (!placeholder && last?.placeholder && now - last.at <= ttlMs) {
        last.text = text
        last.at = now
        last.placeholder = false
        return
      }
      items.push({ at: now, text, placeholder })
      prune(now)
    },
    /** Oldest still-fresh entry, or null. Failures are handled in order. */
    take(now = Date.now()) {
      prune(now)
      return items.shift() ?? null
    },
    get size() {
      prune(Date.now())
      return items.length
    },
    clear() {
      items = []
    },
  }
}

function pruneInPlace(entries, now, windowMs) {
  const cutoff = now - windowMs
  let drop = 0
  while (drop < entries.length && entries[drop].at < cutoff) drop++
  if (drop) entries.splice(0, drop)
  return entries
}

function tally(entries, field) {
  const m = new Map()
  for (const e of entries) {
    const k = e[field] ?? 'unknown'
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

function topList(map, n = 3) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => (k === 'unknown' ? `unknown×${v}` : `${k}×${v}`))
    .join(', ')
}

/**
 * Formats the lines main.js logs for one recorded failure — kept here (rather
 * than inline in main.js) so the exact operator-facing wording is covered by
 * tests. Returns [] when there is nothing worth printing (the common case: a
 * repeat failure from a sender already reported in this window).
 *
 * @param {object}  o
 * @param {string}  o.botName
 * @param {object}  o.outcome   what createDecryptLedger().record() returned
 * @param {object}  o.context   what extractDecryptContext() returned
 * @param {number}  o.windowMs
 */
export function formatDecryptLog({ botName, outcome, context = {}, windowMs = 60_000 } = {}) {
  const lines = []
  const who = context.jid
    ? `${senderLabel(context.jid)}${context.device ? `:${context.device}` : ''}`
    : (context.address
      ? `${context.address}${context.device ? `:${context.device}` : ''} (jid not in the log line)`
      : 'an unknown sender')

  if (outcome?.logForensic) {
    lines.push(
      `🔓 [${botName}] could not decrypt a message from ${who} — ${outcome.reason}` +
      `${context.group ? ` (group ${context.group})` : ''}` +
      ` · ${outcome.total} failure(s) in the last ${Math.round(windowMs / 1000)}s.` +
      ` This message was DROPPED: no reply will be sent for it.`,
    )
  }

  if (outcome?.alert) {
    const a = outcome.alert
    lines.push(
      `🚨 [${botName}] Signal decryption failures: ${a.n} in ${Math.round(windowMs / 1000)}s ` +
      `across ${a.distinctSenders} sender(s) — top senders: ${a.topSenders || 'unknown'} · reasons: ${a.topReasons}`,
    )
    if (a.hint) lines.push(`    ↳ ${a.hint}`)
  }

  return lines
}

/**
 * Per-instance sliding-window ledger of decryption failures.
 *
 * Returned API:
 *   record({ text, jid, device, now })  → what to log (and count) for one failure
 *   noteSuccess(now)                    → plaintext arrived; clears the window
 *   total                               → failures inside the window right now
 *   snapshot(now)                       → numbers for `.health`
 *   reset()                             → fresh socket: forget the old one's state
 */
export function createDecryptLedger({
  windowMs = 60_000,
  limit = 10,
  logFirst = 3,
  logEveryN = 25,
  perSenderDedupeMs = 5 * 60_000,
  maxDistinctSenderLogs = 8,
  maxEntries = 500,
  sampleSize = 3,
} = {}) {
  /** @type {{ at:number, sender:string, device:string|null, reason:string, kind:string }[]} */
  let entries = []
  let loggedSenders = new Map() // sender → last time we printed a forensic line for it
  let alertAt = 0               // last count we alarmed on (0 = none yet in this window)
  let lastSuccessAt = 0

  function prune(now) {
    pruneInPlace(entries, now, windowMs)
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries)
    if (!entries.length) {
      loggedSenders = new Map()
      alertAt = 0
      return
    }
    // Forget per-sender log history once the sender has been silent for the
    // dedupe window, so a NEW incident from the same sender is reported again.
    for (const [sender, at] of loggedSenders) {
      if (now - at > perSenderDedupeMs) loggedSenders.delete(sender)
    }
  }

  return {
    get total() {
      return entries.length
    },
    get limit() {
      return limit
    },
    get windowMs() {
      return windowMs
    },
    get lastSuccessAt() {
      return lastSuccessAt
    },

    record({ text = '', jid = null, device = null, now = Date.now(), sawSessionConflict = false } = {}) {
      const sender = jid ? String(jid) : 'unknown'
      const reason = classifyDecryptReason(text)
      const kind = classifyDecryptKind(text)

      entries.push({ at: now, sender, device: device == null ? null : String(device), reason, kind })
      prune(now)

      const total = entries.length
      const distinctSenders = tally(entries, 'sender').size

      // ── Detailed line, deduped ──────────────────────────────────────────
      // The first few failures always get one, then it is at most one per
      // sender per `perSenderDedupeMs`, and at most `maxDistinctSenderLogs`
      // distinct senders inside a window. A session that is wedged for a
      // whole group cannot turn this into a flood — but a NEW sender (a
      // second victim, a different cause) still gets reported.
      const seenSender = loggedSenders.has(sender)
      let logForensic = false
      if (total <= logFirst) logForensic = true
      else if (!seenSender && loggedSenders.size < maxDistinctSenderLogs) logForensic = true
      if (logForensic) loggedSenders.set(sender, now)

      // ── Aggregate alert ────────────────────────────────────────────────
      // Fires when the window first crosses `limit`, then only every
      // `logEveryN` ABOVE the last count we alarmed on. The old
      // `n % 25 === 0` test re-fired the same number every time the window
      // pruned below it (the repeated "#50 in 10 min" lines).
      let alert = null
      if (total >= limit && (alertAt === 0 || total >= alertAt + logEveryN)) {
        alertAt = total
        const senders = tally(entries, 'sender')
        const kinds = tally(entries, 'kind')
        const dominantKind = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        alert = {
          n: total,
          windowMs,
          distinctSenders,
          topSenders: topList(senders),
          topReasons: topList(tally(entries, 'reason')),
          dominantKind,
          hint: decryptFailureHint({ distinctSenders, dominantKind, sawSessionConflict }),
        }
      }

      return {
        total,
        distinctSenders,
        logForensic,
        alert,
        reason,
        kind,
        sender,
        device: device == null ? null : String(device),
      }
    },

    /**
     * A message actually decrypted. Two jobs: mark the plaintext path alive
     * (the watchdog's real input — see main.js), and clear the window so a
     * later incident is reported as a new one instead of inheriting today's
     * counts.
     */
    noteSuccess(now = Date.now()) {
      lastSuccessAt = now
      const cleared = entries.length
      const wasLoud = alertAt > 0 || entries.length > 0
      entries = []
      loggedSenders = new Map()
      alertAt = 0
      return { cleared, wasLoud }
    },

    /** Bounded view for `.health` and for the watchdog's log line. */
    snapshot(now = Date.now(), { sample = sampleSize } = {}) {
      prune(now)
      const senders = tally(entries, 'sender')
      const kinds = tally(entries, 'kind')
      const dominantKind = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      return {
        total: entries.length,
        windowMs,
        limit,
        distinctSenders: senders.size,
        topSenders: topList(senders),
        dominantKind,
        lastSuccessAt: lastSuccessAt || null,
        lastFailureAt: entries.length ? entries[entries.length - 1].at : null,
        sample: entries.slice(-sample).map(e => ({
          sender: senderLabel(e.sender),
          device: e.device,
          reason: e.reason,
          agoMs: now - e.at,
        })),
        hint: decryptFailureHint({ distinctSenders: senders.size, dominantKind }),
      }
    },

    reset() {
      entries = []
      loggedSenders = new Map()
      alertAt = 0
      lastSuccessAt = 0
    },
  }
}
