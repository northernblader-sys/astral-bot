/**
 * spawn-timer.js — standalone, ABSOLUTE card/series auto-spawn timer.
 *
 * WHY THIS EXISTS: the original sweeps (main.js's armCardSpawn/armSeriesSpawn,
 * driven by lib/night-mode.js's isNightMode() check) went silent for 3 days
 * with zero errors logged anywhere. The most likely cause: isNightMode()
 * reads data/night-mode.json, and that file's `on` flag is deliberately
 * persisted across restarts "so an overnight crash doesn't reopen the bot"
 * (see night-mode.js's own header comment). If that flag is stuck at `true`
 * — a crash mid-night, a `.night on` nobody remembered to undo, a corrupted
 * write — every sweep just no-ops forever. Silently. By design. There is no
 * log line for "sweep skipped because night mode", because skipping IS the
 * intended behavior; a stuck flag is indistinguishable from a working one
 * from the logs alone.
 *
 * This plugin is the fix: a completely independent timer for the same two
 * spawns (cards / anime series), that does NOT import night-mode.js, does
 * NOT check isNightMode(), and does NOT share main.js's cardSpawnTimer /
 * seriesSpawnTimer variables or arm/rearm functions. It fires on a plain,
 * unconditional setInterval, forever, for as long as the process is alive.
 * If you want a "closed for the night" pause on THIS timer later, it needs
 * its own explicit flag — it will never silently inherit night-mode's.
 *
 * WIRING: unlike a command plugin, this one needs to run on a clock, not
 * in response to a message. So it lives in lib/, not plugins/ — it has no
 * `run()` or default export, and the command loader (lib/plugin-manager.js)
 * never touches it. main.js calls initAbsoluteSpawnTimer(sock) once, right
 * after `inst.activeSock = sock` on the 'open' event (search main.js for
 * "spawn-timer.js" to find the one added line/import). That hands this
 * module a live socket to send with; every later tick reuses the most
 * recently handed-in socket, kept in the module-level `liveSock` below, so a
 * reconnect (new socket object) is picked up automatically without needing
 * to re-arm anything.
 *
 * This runs ALONGSIDE the original main.js sweeps, not instead of them —
 * nothing here removes armCardSpawn/armSeriesSpawn. If night-mode's stuck
 * flag is the actual cause, the original sweeps stay silently dead and THIS
 * timer is what actually spawns cards/series from now on. Once you've
 * confirmed (see the "Diagnosing" note below) that data/night-mode.json
 * really was the culprit and fixed it, you can decide whether to keep
 * running both or rip the old ones out — that's a separate change, not done
 * here automatically, since two live spawns instead of one is a much safer
 * failure mode than zero.
 *
 * DIAGNOSING (do this once, on the server):
 *   cat data/night-mode.json
 * If it shows "on": true and you didn't intend that, that confirms the
 * theory. `.night off` clears it (and also wakes the original sweeps, per
 * night-mode.js's onNightModeOff listeners) — but this timer no longer
 * cares either way.
 *
 * No plugin `run()` — commands still come from waifu.js (.waifu on/off) and
 * series.js (.series on/off), which this file does not touch. This file's
 * only job is firing the next spawn once a group is registered.
 */
import { config, logger } from '../config.js'
import { fetchSpawnCard, tierStars, cardSellPrice } from './card-engine.js'
import {
  fetchRandomSeries,
  getSeriesTier,
  generateSeriesClaimCode,
  seriesTierEmoji,
  seriesTierStars,
} from './series-engine.js'
import { setActiveSpawn } from './card-spawn-state.js'
import { setActiveSeriesSpawn } from './series-spawn-state.js'
import { getCardSpawnGroups, removeCardSpawnGroup } from './card-spawn-groups.js'
import { getSeriesSpawnGroups, removeSeriesSpawnGroup } from './series-spawn-groups.js'
import { getGroupSettings } from './group-settings.js'
import { CARD_SPAWN_INTERVAL_MS, SERIES_SPAWN_INTERVAL_MS, humanInterval } from './spawn-intervals.js'

/** Same three suffixes main.js's isWhatsAppJid() checks — kept local so this
 *  file has zero imports from main.js (main.js imports INTO this file, not
 *  the other way around — see the wiring note up top). */
function isWhatsAppJid(jid) {
  return typeof jid === 'string' && (
    jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
  )
}

/** The most recently handed-in live socket. Updated by initAbsoluteSpawnTimer()
 *  on every 'open' event, so a reconnect is picked up without re-arming. */
let liveSock = null

/** Guards against main.js accidentally calling init twice (e.g. two bot
 *  numbers both hitting 'open') and ending up with duplicate intervals. */
let armed = false

async function cardTick() {
  const sock = liveSock
  if (!sock) return // no connected socket right now — try again next tick

  const groupJids = await getCardSpawnGroups().catch(() => [])
  for (const groupJid of groupJids) {
    if (!isWhatsAppJid(groupJid)) continue
    try {
      const settings = await getGroupSettings(groupJid)
      if (!settings.cardsEnabled) {
        await removeCardSpawnGroup(groupJid)
        continue
      }

      const card = await fetchSpawnCard()
      if (!card) continue

      setActiveSpawn(groupJid, card)
      await sock.sendMessage(groupJid, {
        image: { url: card.imageUrl },
        caption:
          `🎴 *A WILD CARD APPEARED!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `✨ *${card.title}*\n` +
          `📺 _${card.series}_\n` +
          `${tierStars(card.tier)}  ·  💰 *${cardSellPrice(card.tier).toLocaleString()}* Solars\n\n` +
          `🎯 First to type *${config.prefix}collect ${card.claim}* claims it!`,
      }).catch(err => {
        logger.warn({ err: err.message, jid: groupJid }, 'spawn-timer: card send failed')
      })
    } catch (err) {
      logger.warn({ err: err.message, jid: groupJid }, 'spawn-timer: card tick failed for group')
    }
  }
}

async function seriesTick() {
  const sock = liveSock
  if (!sock) return

  const groupJids = await getSeriesSpawnGroups().catch(() => [])
  for (const groupJid of groupJids) {
    if (!isWhatsAppJid(groupJid)) continue
    try {
      const settings = await getGroupSettings(groupJid)
      if (!settings.seriesEnabled) {
        await removeSeriesSpawnGroup(groupJid)
        continue
      }

      const series = await fetchRandomSeries()
      if (!series) continue

      const tier = getSeriesTier(series.score)
      const code = generateSeriesClaimCode()
      const spawn = { ...series, tier: tier.name, claimCode: code }

      setActiveSeriesSpawn(groupJid, spawn)

      const score = series.score != null ? `${series.score.toFixed(1)}⭐` : 'Unrated'
      await sock.sendMessage(groupJid, {
        image: { url: series.imageUrl },
        caption:
          `📺 *AN ANIME SERIES APPEARED!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `${seriesTierEmoji(tier.name)} ${seriesTierStars(tier.name)} *${series.title}*\n` +
          `🏅 Score ${score}  ·  Tier *${tier.name}*\n\n` +
          `🎯 First to type *${config.prefix}collect ${code}* claims it!`,
      }).catch(err => {
        logger.warn({ err: err.message, jid: groupJid }, 'spawn-timer: series send failed')
      })
    } catch (err) {
      logger.warn({ err: err.message, jid: groupJid }, 'spawn-timer: series tick failed for group')
    }
  }
}

/**
 * Call once at boot (from main.js, on the socket's 'open' event) to start
 * both unconditional intervals and give this module a socket to send with.
 * Safe to call again on a reconnect — it just refreshes `liveSock` without
 * arming a second pair of intervals.
 */
export function initAbsoluteSpawnTimer(sock) {
  liveSock = sock

  if (armed) return // intervals already running — just needed the fresh sock above
  armed = true

  setInterval(() => {
    cardTick().catch(err => logger.warn({ err: err.message }, 'spawn-timer: card tick crashed'))
  }, CARD_SPAWN_INTERVAL_MS)

  setInterval(() => {
    seriesTick().catch(err => logger.warn({ err: err.message }, 'spawn-timer: series tick crashed'))
  }, SERIES_SPAWN_INTERVAL_MS)

  logger.warn(
    { cardEvery: humanInterval(CARD_SPAWN_INTERVAL_MS), seriesEvery: humanInterval(SERIES_SPAWN_INTERVAL_MS) },
    '⏱️ spawn-timer.js armed — absolute card/series spawns, independent of night mode',
  )
}
