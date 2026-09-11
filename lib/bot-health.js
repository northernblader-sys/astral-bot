/**
 * bot-health.js — a one-field registry so anything in the process can ask
 * "is the WhatsApp side actually healthy right now?" without importing
 * main.js.
 *
 * main.js is the entry point: a plugin that imported it to read socket state
 * would create an import cycle (main.js → loadPlugins → plugin → main.js).
 * So main.js pushes a read-only accessor in here at boot instead, and
 * plugins/health.js pulls it back out.
 *
 * This exists because of a bug that was almost impossible to diagnose from
 * the outside: the bot stayed "online", the hourly card and Pokémon spawns
 * kept arriving, and yet commands went unanswered. From a group's point of
 * view those two facts look contradictory, and there was nothing to query.
 * There are two very different causes with the same symptom —
 *
 *   • the outbound send queue is minutes behind (lib/send-rate-limiter.js), or
 *   • inbound messages stopped being delivered/decrypted altogether while the
 *     socket stayed open (the watchdog in main.js)
 *
 * — and telling them apart needs numbers, not guesses. Hence `.health`.
 */

/** @type {null | (() => object)} */
let provider = null

/** Called once by main.js with a function returning a fresh snapshot. */
export function setHealthProvider(fn) {
  provider = typeof fn === 'function' ? fn : null
}

/**
 * Live health snapshot, or null when the WhatsApp side never booted (e.g. a
 * Discord-only or Telegram-only process, where there is no Baileys socket).
 */
export function getHealthSnapshot() {
  if (!provider) return null
  try {
    return provider()
  } catch {
    return null
  }
}
