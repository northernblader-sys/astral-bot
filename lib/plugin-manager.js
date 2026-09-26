import { isBattleCinematicActive } from './battle-presentation.js'
import { readdir } from 'fs/promises'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { logger, config } from '../config.js'
import { missingCapabilities } from './platform/capabilities.js'
import { isInAuraTrial, AURA_LOCK_MSG } from './reborn-engine.js'

/**
 * Command registry: name/alias → EVERY plugin registered under that key.
 *
 * The value is an array, not a single plugin, and that is the whole point. The
 * same command name legitimately exists once per platform — `.antilink` is
 * plugins/antilink.js on WhatsApp, plugins-discord/automod.js on Discord and
 * plugins-telegram/guard.js on Telegram; `.welcome`, `.setwelcome`, `.goodbye`
 * and `.setgoodbye` each exist in all three plugin directories too.
 *
 * When this was a flat Map<key, plugin>, the last loader to run won. A combined
 * process (main-all.js, and main.js itself when DISCORD_TOKEN/TELEGRAM_TOKEN are
 * set) loads ./plugins, then ./plugins-discord, then ./plugins-telegram, so the
 * key 'antilink' ended up pointing at the TELEGRAM plugin. dispatch() then found
 * it, failed isPluginAvailableOn(telegramPlugin, 'whatsapp'), and returned false
 * — which the caller reports as "Unknown command .antilink. Did you mean ...?".
 * The same overwrite hid .welcome/.setwelcome/.goodbye/.setgoodbye from WhatsApp
 * and from .menu, and it was SILENT because the collision warning below only
 * fires when the two plugins have different `name`s.
 *
 * So every candidate is kept and the platform picks the winner at lookup time.
 */
const registry = new Map()

/**
 * Derived flat views: platform → Map<key, plugin>, one resolved plugin per key.
 * Rebuilt lazily and dropped whenever loadPlugins() registers anything, so
 * getRegistry() stays an O(1) Map lookup on the hot path (handler.js consults it
 * per command) instead of re-resolving every key on every call.
 */
const flatCache = new Map()

/**
 * True when `a` and `b` could both be reached from the same platform, i.e. when
 * one shadowing the other would actually cost someone a command. A plugin with
 * no `platforms` array is universal and therefore overlaps everything.
 */
function platformsOverlap(a, b) {
  const pa = Array.isArray(a.platforms) && a.platforms.length ? a.platforms : null
  const pb = Array.isArray(b.platforms) && b.platforms.length ? b.platforms : null
  if (!pa || !pb) return true
  return pa.some(p => pb.includes(p))
}

/**
 * The plugin a caller on `platform` gets for `key`, or null.
 *
 * LAST registered candidate that the platform can actually run wins. Last-wins
 * (rather than first-wins) preserves the pre-existing behaviour for genuine
 * same-platform alias collisions — e.g. 'claim' is an alias of both claim.js and
 * daily.js, and daily.js has always been the one that answered.
 *
 * Passing platform=null skips the availability filter entirely, for callers that
 * just want "is this a known command name at all".
 */
function resolvePlugin(key, platform = null) {
  const candidates = registry.get(String(key).toLowerCase())
  if (!candidates?.length) return null
  if (!platform) return candidates[candidates.length - 1]
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (isPluginAvailableOn(candidates[i], platform)) return candidates[i]
  }
  return null
}

/** Memoized flat key→plugin view for one platform. */
function flatFor(platform) {
  const cacheKey = platform ?? '*'
  let flat = flatCache.get(cacheKey)
  if (flat) return flat

  flat = new Map()
  for (const key of registry.keys()) {
    const plugin = resolvePlugin(key, platform)
    if (plugin) flat.set(key, plugin)
  }
  flatCache.set(cacheKey, flat)
  return flat
}

/**
 * The single plugin `platform` should get for `cmd`, or null. Prefer this over
 * getRegistry().get(cmd) in new code — it makes the platform explicit instead of
 * inheriting whatever the process happened to boot as.
 */
export function getPluginFor(cmd, platform = null) {
  return flatFor(platform).get(String(cmd).toLowerCase()) ?? null
}

/**
 * Canonical plugin names that run even while the sender is inside a Reborn
 * Aura trial. See the lock in dispatch() for why each one is here.
 */
const AURA_LOCK_EXEMPT = new Set(['reborn', 'unstick'])

/**
 * The platform this process is serving. Set once at boot by the entry point
 * (main.js / main-discord.js / main-telegram.js) BEFORE loadPlugins() runs,
 * so the loader can skip plugins this platform can't support.
 */
let activePlatform = 'whatsapp'

/** Called by the entry point before loadPlugins(). */
export function setActivePlatform(platformId) {
  activePlatform = platformId
}

export function getActivePlatform() {
  return activePlatform
}

/**
 * Decide whether a plugin belongs on the active platform.
 *
 * Two independent filters, both opt-in — a plugin that declares neither field
 * loads everywhere, so all ~150 existing game plugins are unaffected:
 *
 *   platforms: ['whatsapp']    explicit allowlist. This is what keeps
 *                              .antichannel / .antidelete / .stickerpack off
 *                              Discord and Telegram, where the underlying
 *                              WhatsApp concepts simply don't exist.
 *
 *   requires: ['stickers']     capability gate. Declares what the plugin needs
 *                              rather than where it runs, so a new platform
 *                              gets the right answer without editing lists.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkPlatformFit(meta) {
  if (Array.isArray(meta.platforms) && meta.platforms.length) {
    if (!meta.platforms.includes(activePlatform)) {
      return { ok: false, reason: `restricted to ${meta.platforms.join('/')}` }
    }
  }

  if (Array.isArray(meta.requires) && meta.requires.length) {
    const missing = missingCapabilities(activePlatform, meta.requires)
    if (missing.length) {
      return { ok: false, reason: `needs unsupported ${missing.join(', ')}` }
    }
  }

  return { ok: true }
}

/**
 * Scan `dir` at boot, import each .js file, and register valid plugins.
 * Malformed plugins are skipped with a warning — they never crash the loader.
 *
 * Safe to call more than once with different directories: the entry point
 * loads shared `./plugins` first, then its own `./plugins-<platform>` dir.
 */
export async function loadPlugins(dir = './plugins') {
  let files
  try {
    files = await readdir(dir)
  } catch (err) {
    logger.warn({ dir, err: err.message }, 'Plugin directory not found — skipping')
    return
  }

  for (const file of files.filter(f => f.endsWith('.js'))) {
    const fullPath = join(process.cwd(), dir, file)
    try {
      const mod = await import(pathToFileURL(fullPath).href)
      const meta = mod.default

      // Validate shape
      if (!meta || typeof meta !== 'object') {
        logger.warn({ file }, 'Plugin skipped: no default export')
        continue
      }
      if (typeof meta.name !== 'string' || !meta.name.trim()) {
        logger.warn({ file }, 'Plugin skipped: missing name')
        continue
      }
      if (typeof meta.run !== 'function') {
        logger.warn({ file }, 'Plugin skipped: run() is not a function')
        continue
      }

      // Platform fit — not an error, just "not for this platform". Logged at
      // debug so a Discord boot isn't buried under 7 warnings about WhatsApp
      // moderation plugins it was never meant to have.
      const fit = checkPlatformFit(meta)
      if (!fit.ok) {
        logger.debug(
          { file, name: meta.name, platform: activePlatform, reason: fit.reason },
          'Plugin skipped: platform mismatch',
        )
        continue
      }

      // Tag with source filename so dispatch() can report exactly which
      // plugin file threw, without guessing from the command name.
      meta.__sourceFile = file

      // Register under name + all aliases. Candidates accumulate per key —
      // see the registry comment at the top for why the per-platform copies of
      // .antilink / .welcome must not overwrite each other.
      const keys = [meta.name, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
      for (const rawKey of keys) {
        const key = rawKey.toLowerCase()
        const candidates = registry.get(key) ?? []

        // Only warn about a collision that a single platform could actually
        // hit. Cross-platform namesakes (plugins/antilink.js vs
        // plugins-telegram/guard.js) are the intended design, not a mistake,
        // and warning about them trained everyone to ignore this line.
        const shadowed = candidates.find(p => p.name !== meta.name && platformsOverlap(p, meta))
        if (shadowed) {
          logger.warn({ key, existing: shadowed.name, incoming: meta.name }, 'Alias collision — overwriting')
        }

        candidates.push(meta)
        registry.set(key, candidates)
      }
      flatCache.clear()

      // Per-plugin confirmation is debug-only — at ~150 plugins this line
      // alone floods every boot with noise at LOG_LEVEL=info. Set
      // LOG_LEVEL=debug if you need to verify a specific plugin registered.
      logger.debug({ name: meta.name, aliases: meta.aliases ?? [] }, 'Plugin loaded')
    } catch (err) {
      logger.warn({ file, err: err.message }, 'Plugin failed to import')
    }
  }

  const distinct = new Set()
  for (const candidates of registry.values()) for (const p of candidates) distinct.add(p)
  logger.warn({ total: distinct.size }, 'Plugin registry ready')
}

/**
 * A flat key→plugin Map, resolved for one platform (default: the platform this
 * process booted as). Callers treat this as read-only.
 *
 * The underlying registry stores an ARRAY per key so per-platform namesakes can
 * coexist (see the comment at the top of this file); this view flattens that
 * back to the one plugin `platform` would actually get, which is the shape every
 * existing caller expects.
 */
export function getRegistry(platform = activePlatform) {
  return flatFor(platform)
}

/**
 * True when `plugin` should be visible to, and runnable by, a caller on
 * `platform`.
 *
 * checkPlatformFit() above answers the same question at LOAD time, using the
 * one `activePlatform` the process booted with. That is not enough in combined
 * mode (main-all.js): all three platforms share this single registry, and it is
 * loaded with activePlatform='whatsapp', so every WhatsApp-only plugin —
 * .antilink, .sticker, .kick, .setname — is registered and then shown to
 * Discord and Telegram users by .menu, which reads the registry directly.
 *
 * So the same declaration has to be re-checked per COMMAND, against the
 * platform of the ctx actually calling. Load-time filtering stays as-is: it's
 * still correct for single-platform entry points and it keeps a plugin whose
 * capabilities can't be satisfied out of the registry entirely.
 *
 * Plugins declaring neither `platforms` nor `requires` remain universal, so the
 * ~150 game plugins are unaffected.
 */
export function isPluginAvailableOn(plugin, platform) {
  if (!plugin || !platform) return true

  if (Array.isArray(plugin.platforms) && plugin.platforms.length) {
    if (!plugin.platforms.includes(platform)) return false
  }

  if (Array.isArray(plugin.requires) && plugin.requires.length) {
    if (missingCapabilities(platform, plugin.requires).length) return false
  }

  return true
}

/**
 * The plugins a caller on `platform` may actually see — what .menu should
 * build its category list from. Deduplicated by plugin (the registry holds one
 * entry per alias as well as per name).
 */
export function listPluginsFor(platform) {
  const out = []
  const seen = new Set()
  for (const candidates of registry.values()) {
    for (const plugin of candidates) {
      if (seen.has(plugin)) continue
      seen.add(plugin)
      if (!isPluginAvailableOn(plugin, platform)) continue
      out.push(plugin)
    }
  }
  return out
}

// ── "Did you mean...?" suggestion for unknown commands ─────────────────

/** Classic Levenshtein edit distance between two strings. */
function editDistance(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
    }
    prev = curr
  }
  return prev[n]
}

// A suggestion only makes sense if the typo is small relative to the
// command's length — otherwise "closest match" is just noise. Roughly
// half the command's length, minimum 2 (so short commands like "rank"/
// "shop" still catch a couple of dropped/swapped letters), capped at 4
// so a wildly wrong short command doesn't match something long by chance.
function maxDistanceFor(len) {
  return Math.min(4, Math.max(2, Math.ceil(len / 2)))
}

/**
 * Finds the closest registered command/alias name to an unrecognized
 * input, for a "did you mean *X*?" reply. Returns the plugin's canonical
 * name (not the alias that was closest) or null if nothing is close enough.
 *
 * `platform` restricts candidates to what that platform can actually run —
 * suggesting *.sticker* to a Discord user who typoed sends them to a command
 * that will then tell them it doesn't exist here.
 */
export function suggestCommand(cmd, platform = null) {
  const input = cmd.toLowerCase()
  let best = null
  let bestDist = Infinity

  for (const key of registry.keys()) {
    const plugin = platform ? resolvePlugin(key, platform) : resolvePlugin(key)
    // Nothing this platform can run under that key ⇒ never suggest it.
    // Suggesting *.sticker* to a Discord user sends them to a command that
    // will only tell them it doesn't exist here.
    if (!plugin) continue
    const dist = editDistance(input, key)
    if (dist < bestDist) {
      bestDist = dist
      best = plugin
    }
  }

  if (!best) return null
  if (bestDist > maxDistanceFor(input.length)) return null
  if (bestDist === 0) return null // exact match would've dispatched already

  return best.name
}

/**
 * Dispatch a command string to its plugin.
 * Returns true if the command was handled, false if unknown.
 */
export async function dispatch(cmd, ctx) {
  // Resolved against the CALLER's platform, not against whichever plugin
  // directory happened to be loaded last. This is what makes `.antilink` on
  // WhatsApp find plugins/antilink.js even though plugins-discord/automod.js and
  // plugins-telegram/guard.js also register the name 'antilink'.
  //
  // A key that exists but has no candidate for this platform resolves to null
  // and is reported as unknown, which is the pre-existing behaviour for a
  // command that genuinely belongs to another app: a Discord user who knows a
  // WhatsApp-only name would otherwise hit a TypeError deep inside it
  // (ctx.sock.groupMetadata is not a function), reading as "the bot is broken"
  // rather than "wrong app".
  const plugin = getPluginFor(cmd, ctx.platform)
  // Freeze the involved players' RPG actions before any turn mutation. Do
  // not queue them for replay: the user must choose again after the scene.
  // Admin recovery remains reachable. No busy message interrupts the clash.
  if (isBattleCinematicActive(ctx) && plugin?.category !== 'admin') return true
  if (!plugin) return false

  // The alias the caller actually typed, lowercased. A plugin registered under
  // several names sometimes has to know which one fired: `.sleep` is an alias of
  // `inn` that must behave like `.inn sleep` instead of opening the inn menu
  // (see plugins/inn.js).
  ctx.cmd = cmd.toLowerCase()

  if (plugin.requiresPlayer && !ctx.player) {
    await ctx.reply(`⚠️ You need to *${config.prefix}register* first before using that command.`).catch(() => {})
    return true
  }

  // Aura-trial lock. While a player is standing inside a god's Aura (the 30
  // second Reborn trial — see plugins/reborn.js), they cannot do anything
  // else: not attack, not flee, not heal their way out of it. The lock lives
  // here rather than in each combat plugin so it covers all ~150 commands,
  // and it releases itself 15 seconds past the trial's end so a crash mid
  // trial can never leave anyone permanently unable to type.
  //
  // Two exemptions: `reborn`, since that is the command that resolves the
  // trial, and `unstick`, the owner's escape hatch for clearing a wedged
  // state — a lock that can block the tool built to clear locks is a trap.
  if (!AURA_LOCK_EXEMPT.has(plugin.name) && isInAuraTrial(ctx.player)) {
    await ctx.reply(AURA_LOCK_MSG).catch(() => {})
    return true
  }

  try {
    await plugin.run(ctx)
  } catch (err) {
    const sourceFile = plugin.__sourceFile ?? 'unknown plugin file'
    const who = ctx.from ?? ctx.msg?.key?.remoteJid ?? 'unknown sender'

    // Pretty summary for normal console/stdout viewing.
    logger.error({ cmd, plugin: sourceFile, err: err.message }, 'Plugin threw an error during run()')

    // Full detail (stack trace = exact file + line number) written
    // directly to stderr, so PM2 routes it into pm2-err.log regardless
    // of the pino transport's own destination.
    process.stderr.write(
      `[${new Date().toISOString()}] ❌ Command error\n` +
      `  command : ${config.prefix}${cmd}\n` +
      `  plugin  : plugins/${sourceFile}\n` +
      `  from    : ${who}\n` +
      `  stack   :\n${err?.stack ?? err}\n\n`
    )
  }

  return true
}
