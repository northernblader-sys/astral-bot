/**
 * pipeline.js — the platform-neutral half of command handling.
 *
 * handler.js does two jobs: it decodes Baileys events, then it runs a series
 * of gates (banned? jailed? asleep? mid-battle?) before dispatching. The
 * second half has nothing to do with WhatsApp, so it lives here and the
 * Discord and Telegram adapters call it with an already-built ctx.
 *
 * handler.js is deliberately NOT refactored to call this. It is the live,
 * working WhatsApp path with a lot of hard-won behaviour in it (LID handling,
 * antilink, antidelete, screenshot capture, premium sweeps) and rewiring it to
 * gain a little deduplication would risk a bot that currently works. The gates
 * duplicated here are the small, stable, purely-logical ones.
 */

import { logger, config } from '../../config.js'
import { dispatch, suggestCommand, getRegistry } from '../plugin-manager.js'
import { incrementCommandCount } from '../server-stats.js'
import { getPlayer, savePlayer, updatePlayer } from '../player-repo.js'
import { wakeIfDue } from '../sleep-engine.js'
import { getBan } from '../ban-repo.js'
import { getJailRecord, releasePlayer } from '../jail-repo.js'
import { awardPetCommandSolars } from '../pet-bond.js'
import { petMap } from '../game-data.js'

// Mirrors handler.js's NON_RPG_CATEGORIES / NON_RPG_COMMANDS, and duplicated for
// the same reason as BATTLE_ALLOWED_COMMANDS below: importing handler.js here
// would drag Baileys-dependent modules into the Discord/Telegram processes.
//
// The inn-sleep gate is the only lockout this file has, and it used to block all
// ~208 commands — so a Discord player who slept at the inn could not run `.song`
// or `.dload` either. Your character being asleep says nothing about whether the
// bot can fetch a track. Keep these two sets in sync with handler.js.
const NON_RPG_CATEGORIES = new Set(['utility', 'media', 'group', 'admin'])
const NON_RPG_COMMANDS = new Set([
  'discord-link', 'telegram-link', 'whatsapp-link', 'pfp', 'cleanup',
  // handler.js's LOCKOUT_EXEMPT_COMMANDS — a ban appeal must never be swallowed
  // by a lockout, on any platform.
  'unban', 'unban-me', 'unbanme', 'appeal',
])

function isNonRpgCommand(cmd, platform) {
  if (NON_RPG_COMMANDS.has(cmd)) return true
  const category = getRegistry(platform).get(cmd)?.category
  return !!category && NON_RPG_CATEGORIES.has(category)
}

// Mirrors handler.js's BATTLE_ALLOWED_COMMANDS. Kept as its own copy rather
// than exported from handler.js, because importing handler.js would drag
// Baileys-dependent modules (moderation-scan, pending-purchase) into the
// Discord/Telegram processes, where they have no socket to talk to.
const BATTLE_ALLOWED_COMMANDS = new Set([
  'attack', 'atk', 'a',
  'skill', 'sk', 's', 'sp',
  'defend', 'def', 'd', 'block',
  'flee', 'run', 'escape',
  'useability', 'ua', 'useab',
  'cinderverdict', 'cinder', 'cv', 'verdict',
  // Character signature moves. Each of these is a real battle action that
  // spends the turn, so it has to clear the gate exactly like attack/skill do.
  // They were missing here long after handler.js gained them, which meant a
  // Discord/Telegram player mid-battle had `.wildcard`, `.domain-expansion`,
  // `.ultimate` and `.finalform` rejected by this gate before the plugin ever
  // ran — the WhatsApp path worked, so it looked fine. Keep this block in sync
  // with handler.js's BATTLE_ALLOWED_COMMANDS when a character is added.
  'wildcard', 'wc', 'circe', 'wild',
  'ultimate', 'dragonultimate', 'dragon-ultimate',
  'domain-expansion', 'domain', 'de', 'domainexpansion', 'chimera',
  'mahoraga', 'wheel', 'divinegeneral',
  'finalform', 'ff', 'transform',
  'thiefseye', 'thiefs-eye', 'steal', 'te', 'mimic',
  'hollowexchange', 'hollow-exchange', 'hollow', 'exchange', 'hx',
  // Gojo's Hollow Purple and Unlimited Void (plugins/purple.js, plugins/domain.js).
  // Both are PvE-only and PvE is what sets player.inBattle, so without these
  // the gate rejected them in every fight they exist for. 'hp' is the Hollow
  // Purple shorthand.
  'hollowpurple', 'purple', 'hollow-purple', 'hp',
  'unlimitedvoid', 'unlimited-void', 'void', 'domain-expansion-gojo',
  // Yato's true form (plugins/unwritten.js) — PvE-only, same as Gojo's pair
  // above, and usable every turn rather than once per battle.
  'unwritten', 'unwrite', 'erase', 'uw',
  'willow', 'advisor', 'advise',
  'pvp', 'duel',
  'dparty', 'dungeonparty', 'dp', 'coop',
  'pattack', 'pa', 'pdefend', 'pd', 'pflee', 'pcv', 'pcinder',
  'shop', 'gm', 'gameshop', 'profile', 'inventory',
  'skillslot', 'skillslots', 'slots',
  'stats', 'stat', 'train', 'menu', 'ping',
  'cb', 'clearbattle', 'resetbattle', 'unstuck',
])

/**
 * Run one command through the shared gates and dispatch it.
 *
 * The adapter is responsible for everything above this: decoding the platform
 * event, parsing prefix/cmd/args, and building ctx (including reply,
 * replyImage, from, sender, isGroup). This function owns everything from
 * "we have a valid command" to "the plugin has run".
 *
 * @returns {Promise<boolean>} true if a plugin handled the command
 */
export async function runCommand(ctx) {
  const { cmd } = ctx

  ctx.player = getPlayer(ctx.db, ctx.from)
  ctx.save = () => savePlayer(ctx.db, ctx.player)

  // ── Ban gate ──────────────────────────────────────────────────────────
  // getBan is synchronous and takes (db, id). Calling it as getBan(id) read
  // `.bans` off the id string's undefined `.data`, throwing
  // "Cannot read properties of undefined (reading 'bans')" before any plugin
  // ran — and because it throws synchronously, the trailing .catch() never
  // got attached, so every Discord/Telegram command died here.
  const ban = getBan(ctx.db, ctx.from)
  if (ban) {
    const bannedAt = ban.bannedAt ? new Date(ban.bannedAt).toLocaleDateString() : 'unknown date'
    await ctx.reply(
      `🚫 *You are banned and cannot use this bot.*\n\n` +
      `Banned: *${bannedAt}*\n` +
      (ban.reason ? `Reason: *${ban.reason}*\n` : '') +
      `\nContact the owner if you think this is a mistake.`,
    ).catch(() => {})
    return false
  }

  // ── Jail gate ─────────────────────────────────────────────────────────
  // Also (db, id), also synchronous — same fix as the ban gate above.
  const jailRec = getJailRecord(ctx.db, ctx.from)
  if (jailRec) {
    if (Date.now() < jailRec.releaseAt) {
      const minsLeft = Math.max(1, Math.ceil((jailRec.releaseAt - Date.now()) / 60_000))
      await ctx.reply(
        `🔒 *You're locked up${jailRec.crime ? ` for ${jailRec.crime}` : ''}.*\n\n` +
        `Time left: *${minsLeft} min* on your sentence.`,
      ).catch(() => {})
      return false
    }
    // releasePlayer IS async, so .catch() is genuine here.
    await releasePlayer(ctx.db, ctx.from).catch(() => {})
    await ctx.reply(
      `🔓 *You've served your time and walked free.*\n\n` +
      `The cell door creaks open and morning light hits your face.`,
    ).catch(() => {})
  }

  // ── Inn sleep lockout ─────────────────────────────────────────────────
  // Check-and-mutate inside updatePlayer's read→mutate→write cycle, matching
  // handler.js — reading ctx.player and saving it back later would race any
  // concurrent command touching the same player. Utility commands skip the
  // gate entirely (see isNonRpgCommand above).
  if (ctx.player && !isNonRpgCommand(cmd, ctx.platform)) {
    let stillAsleep = false
    let justWoke = false
    let wakeAt = null

    await updatePlayer(ctx.db, ctx.from, fresh => {
      if (fresh.sleepUntil == null) return fresh
      if (Date.now() < fresh.sleepUntil) {
        stillAsleep = true
        wakeAt = fresh.sleepUntil
        return fresh
      }
      justWoke = wakeIfDue(fresh)
      return fresh
    })

    ctx.player = getPlayer(ctx.db, ctx.from)

    if (stillAsleep) {
      const minsLeft = Math.max(1, Math.ceil((wakeAt - Date.now()) / 60_000))
      await ctx.reply(
        `😴 *${ctx.player.name}* is fast asleep at the inn.\n` +
        `All commands are locked — you'll wake up in *${minsLeft} minute${minsLeft === 1 ? '' : 's'}*.`,
      ).catch(() => {})
      return false
    }
    if (justWoke) {
      await ctx.reply(
        `☀️ *${ctx.player.name}* wakes up feeling fully rested!\n` +
        `❤️ HP ${ctx.player.maxHp}/${ctx.player.maxHp}  💧 MP ${ctx.player.maxMp}/${ctx.player.maxMp}  ` +
        `⚡ Stamina ${ctx.player.stamina?.current ?? '?'}/${ctx.player.stamina?.max ?? '?'}`,
      ).catch(() => {})
      return false
    }
  }

  // ── In-battle command gate ────────────────────────────────────────────
  if (ctx.player?.inBattle && !BATTLE_ALLOWED_COMMANDS.has(cmd)) {
    await ctx.reply(
      `⚔️ You're mid-battle! Only battle commands work right now:\n` +
      `*${config.prefix}attack* · *${config.prefix}skill <name>* · *${config.prefix}defend* · *${config.prefix}flee*\n` +
      `_(${config.prefix}shop and ${config.prefix}profile also work if you need to check something.)_`,
    ).catch(() => {})
    return false
  }

  // debug, not info — see the matching note in handler.js.
  logger.debug({ cmd, from: ctx.from, platform: ctx.platform, isGroup: ctx.isGroup }, 'Command dispatched')
  incrementCommandCount()

  const handled = await dispatch(cmd, ctx)

  // Pet per-command passive income — same single funnel point as handler.js.
  if (handled && ctx.player) {
    await updatePlayer(ctx.db, ctx.from, fresh => {
      awardPetCommandSolars(fresh, petMap)
    }).catch(err => logger.warn({ err: err.message }, 'Pet command payout failed'))
  }

  if (!handled) {
    const suggestion = suggestCommand(cmd, ctx.platform)
    await ctx.reply(
      suggestion
        ? `❓ Unknown command *${config.prefix}${cmd}*. Did you mean *${config.prefix}${suggestion}*?`
        : `❓ Unknown command *${config.prefix}${cmd}*. Use *${config.prefix}menu* to see everything available.`,
    ).catch(() => {})
  }

  return handled
}

/**
 * Parse a raw message body into { cmd, args }.
 * Returns null when the text isn't a command at all.
 *
 * `accepted` is the list of prefixes to honour, defaulting to the global one.
 * Telegram passes ['/', '.'] so `/menu` works (the prefix Telegram users reach
 * for by reflex) while `.menu` keeps working too — every help string in the bot
 * is built from config.prefix, and rewriting 445 of them per platform would be
 * a far bigger change than accepting both.
 *
 * Longest prefix wins, so a multi-char prefix can't be shadowed by a one-char
 * prefix that happens to be its first character.
 */
export function parseCommand(body, accepted = [config.prefix]) {
  const text = String(body ?? '').trim()

  const prefixes = [...new Set([accepted].flat().filter(Boolean))]
    .sort((a, b) => b.length - a.length)

  const prefix = prefixes.find(p => text.startsWith(p))
  if (!prefix) return null

  const withoutPrefix = text.slice(prefix.length).trim()
  if (!withoutPrefix) return null

  const parts = withoutPrefix.split(/\s+/)

  // Telegram appends @botname when more than one bot is in the group, and
  // always does for /commands typed from the command palette: "/menu@astrall121bot".
  const cmd = parts[0].toLowerCase().split('@')[0]
  if (!cmd) return null

  return { cmd, args: parts.slice(1), body: text }
}
