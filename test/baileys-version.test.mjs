/**
 * baileys-version.test.mjs — the connect path may never hang on a version probe.
 *
 * Context: main.js used to `await fetchLatestBaileysVersion()` before building
 * every socket. That call is an untimed axios GET against
 * raw.githubusercontent.com. When that host is slow or blackholed, connect()
 * never reaches makeWASocket(), no close event ever fires to trigger a retry,
 * and PM2 happily reports the process as online while the bot answers nobody —
 * one reported outage exactly. lib/baileys-version.js bounds it. These tests
 * pin the contract, and they need no network: the fetcher is injected.
 *
 * Run:  node --test test/baileys-version.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBaileysVersion, buildSocketVersionOption, DEFAULT_VERSION_FETCH_TIMEOUT_MS } from '../lib/baileys-version.js'

const elapsed = async fn => {
  const startedAt = Date.now()
  const value = await fn()
  return { value, tookMs: Date.now() - startedAt }
}

test('a fetcher that never settles is cut off at the deadline and falls back', async () => {
  const { value, tookMs } = await elapsed(() => resolveBaileysVersion({
    timeoutMs: 120,
    fetchVersion: () => new Promise(() => {}), // hangs forever: the real bug
  }))

  assert.equal(value.version, null, 'must fall back rather than hand out a bogus version')
  assert.equal(value.source, 'timeout')
  assert.ok(tookMs < 1_000, `hung probe must not delay the connect path (took ${tookMs}ms)`)
  assert.ok(tookMs >= 100, 'the deadline is honoured, not skipped')
})

test('the default deadline is a few seconds, not "whenever"', () => {
  assert.ok(DEFAULT_VERSION_FETCH_TIMEOUT_MS > 0 && DEFAULT_VERSION_FETCH_TIMEOUT_MS <= 15_000)
})

test('a resolved remote version is passed through untouched', async () => {
  const remote = { version: [2, 3000, 1043857760], isLatest: true }
  const { value } = await elapsed(() => resolveBaileysVersion({
    timeoutMs: 200,
    fetchVersion: async () => remote,
  }))
  assert.deepEqual(value.version, remote.version)
  assert.equal(value.source, 'remote')
  assert.equal(value.isLatest, true)
})

test('a rejected probe resolves — it can never reject or throw', async () => {
  const { value } = await elapsed(() => resolveBaileysVersion({
    timeoutMs: 200,
    fetchVersion: async () => { throw new Error('ETIMEDOUT') },
  }))
  assert.equal(value.version, null)
  assert.equal(value.source, 'error')
  assert.match(value.note, /ETIMEDOUT/)
})

test('a synchronous throw from the fetcher is caught too', async () => {
  const { value } = await elapsed(() => resolveBaileysVersion({
    timeoutMs: 200,
    fetchVersion: () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
  }))
  assert.equal(value.version, null)
  assert.equal(value.source, 'error')
})

test('a malformed payload falls back instead of poisoning the socket config', async () => {
  for (const bad of [null, undefined, {}, { version: 'x' }, { version: [] }, { version: [2, 'nope'] }]) {
    const value = await resolveBaileysVersion({ timeoutMs: 200, fetchVersion: async () => bad })
    assert.equal(value.version, null, `expected fallback for ${JSON.stringify(bad)}`)
    assert.equal(value.source, 'error')
  }
})

test('a hanging diagnostic logger cannot break the fallback', async () => {
  const logs = []
  const throwingLogger = () => { logs.push(logs.length); if (logs.length === 1) throw new Error('logger exploded') }
  const value = await resolveBaileysVersion({
    timeoutMs: 120,
    fetchVersion: () => new Promise(() => {}),
    log: throwingLogger,
  })
  assert.equal(value.version, null)
  assert.equal(value.source, 'timeout')
})

test('the timeout is logged loudly, because that is the whole point', async () => {
  const lines = []
  await resolveBaileysVersion({
    timeoutMs: 60,
    fetchVersion: () => new Promise(() => {}),
    log: msg => lines.push(msg),
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /timed out/)
  assert.match(lines[0], /Inbound is NOT affected/)
})

test('a fetcher that honours its abort signal is actually cancelled', async () => {
  let aborted = false
  const value = await resolveBaileysVersion({
    timeoutMs: 60,
    fetchVersion: ({ signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    }),
  })
  assert.equal(value.source, 'timeout')
  assert.equal(aborted, true, 'the controller must still be aborted so a well-behaved fetcher stops')
})

test('buildSocketVersionOption OMITS the key on fallback', () => {
  const opts = buildSocketVersionOption({ version: null, source: 'timeout' })
  // Not `{ version: undefined }`: DEFAULT_CONNECTION_CONFIG is merged with a
  // spread, so an explicit undefined would overwrite the library default
  // instead of falling back to it.
  assert.deepEqual(Object.keys(opts), [])
  assert.equal('version' in opts, false)
  assert.deepEqual(buildSocketVersionOption(undefined), {})
  assert.deepEqual(buildSocketVersionOption({ version: [] }), {})
})

test('buildSocketVersionOption forwards a real version as numbers', () => {
  const opts = buildSocketVersionOption({ version: ['2', 3000, 1043857760] })
  assert.deepEqual(opts.version, [2, 3000, 1043857760])
})

test('the real Baileys fetcher is used when none is injected, and never wedges', async () => {
  // No network guarantee in CI: this must resolve either way, fast.
  const { value, tookMs } = await elapsed(() => resolveBaileysVersion({ timeoutMs: 4_000 }))
  assert.ok(['remote', 'timeout', 'error', 'unavailable'].includes(value.source), `got ${value.source}`)
  assert.ok(tookMs < 8_000, `real probe must be bounded (took ${tookMs}ms)`)
  if (value.source !== 'remote') assert.equal(value.version, null)
})
