/**
 * boss-cinematic.js — turns a boss fight into a scene.
 *
 * A regular fight sends one battle-frame image + a combined status caption per
 * turn (lib/battle-frame-render.mjs). A boss fight instead drips its dialogue
 * out one message at a time, then closes with a small text wrapper carrying both
 * HP bars and the action menu. No per-turn arena image.
 *
 * Why no manual sleep: every send goes through the rate limiter
 * (lib/send-rate-limiter.js, ~1.2s min gap), and `await ctx.reply(line)` only
 * resolves once that line has actually gone out. So a plain
 * `for (const beat of beats) await ctx.reply(beat)` loop already arrives ~1.2s
 * apart on its own. The MAX_BEATS cap keeps a single turn from flooding the
 * shared 40/min budget when several players are in boss fights at once.
 *
 * The combat plugins (attack/skill/defend/useability) build their turn text into
 * one `msg` string exactly as before; on the boss path they hand that whole
 * string here as `body` instead of appending the status wrapper. splitIntoBeats()
 * re-groups it into scene beats, so the plugins need no per-line beat bookkeeping.
 */
import { config } from '../config.js'

// Generous by design: the whole point is one-line-at-a-time dialogue. This is a
// safety valve, not a target — a pathological turn (many time-stop hits, a long
// phase script) merges its overflow into the final beat rather than firing a
// dozen sends into the limiter.
const MAX_BEATS = 8

/**
 * Mechanical result lines, damage numbers, shield/MP/HP notes, drops, ride along
 * with the beat they follow. Everything else (an actor's action line, prose, a
 * 💬 quote, a phase header) opens its own beat, so the dialogue lands one message
 * at a time the way the entrance script does.
 */
const RESULT_RE = /^(🩸|💧|🛡️|❤️|🩹|💔|🎁|⚠️|☀️|🎒|🧩|🌟)/u
function opensBeat(line) {
  return !RESULT_RE.test(line.trim())
}

/**
 * Split an accumulated turn body into ordered scene beats. Prose/dialogue lines
 * each open their own beat; mechanical result lines attach to the current beat.
 * Blank lines are dropped (we regroup ourselves). Overflow past MAX_BEATS is
 * merged into the last beat so the send count stays bounded.
 */
export function splitIntoBeats(body) {
  const lines = String(body ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const beats = []
  for (const line of lines) {
    if (beats.length === 0 || opensBeat(line)) beats.push(line)
    else beats[beats.length - 1] += '\n' + line
  }
  if (beats.length > MAX_BEATS) {
    const head = beats.slice(0, MAX_BEATS - 1)
    const tail = beats.slice(MAX_BEATS - 1).join('\n')
    return [...head, tail]
  }
  return beats
}

/** '3240' -> '3,240'. Guards nullish and non-numeric. */
function num(x) {
  const n = Number(x ?? 0)
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(x ?? 0)
}

/**
 * The compact turn wrapper: both HP bars + MP + the action menu. Sent as the
 * final message of a cinematic boss turn, after the dialogue beats.
 */
export function smallWrapper(player, e) {
  const p = config.prefix
  return (
    `───────────────\n` +
    `❤️ You ${num(player.hp)}/${num(player.maxHp)}  💧 ${num(player.mp)}/${num(player.maxMp)}\n` +
    `${e.emoji ?? '👾'} ${e.name} ${num(e.hp)}/${num(e.maxHp)}\n` +
    `▸ ${p}attack · ${p}skill · ${p}defend · ${p}flee`
  )
}

/** Send just the scene beats of a body, one message at a time. No wrapper. */
export async function sendCinematicBody(ctx, body) {
  for (const beat of splitIntoBeats(body)) {
    if (beat.trim()) await ctx.reply(beat)
  }
}

/**
 * A full cinematic boss turn: the dialogue beats one at a time, then the small
 * HP + menu wrapper. Replaces sendBattleTurnReply() on the boss path only.
 */
export async function sendCinematicBossTurn(ctx, { player, e, body }) {
  await sendCinematicBody(ctx, body)
  await ctx.reply(smallWrapper(player, e))
}

/**
 * Send a boss's victoryLines/defeatLines one message at a time, italicised to
 * match the in-fight prose. Skips empty and the '...' placeholder the boss
 * accessors fall back to. The caller sends its own reward/death summary after.
 */
export async function sendBossLines(ctx, lines) {
  if (!Array.isArray(lines)) return
  for (const line of lines) {
    const t = String(line ?? '').trim()
    if (!t || t === '...') continue
    await ctx.reply(`_${t}_`)
  }
}
