/**
 * group-settings.js — per-group config (antilink, welcome, goodbye) backed
 * by data/group-settings.json. Mirrors the read→mutate→write pattern used by
 * updatePlayer() in lib/player-repo.js, just against a flat JSON file
 * instead of lowdb, since this data is small and doesn't need lowdb's
 * machinery.
 *
 * Also home to isGroupOrBotOwner(), the shared permission check used by
 * every gated subcommand in plugins/groupguard.js.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { config, logger } from '../config.js'
import { isOwnerJid, NOT_GROUP, NOT_ALLOWED } from './group-helpers.js'
import { isMod } from './mod-repo.js'
import { resolveChatAdmin } from './platform/permissions.js'

const SETTINGS_PATH = new URL('../data/group-settings.json', import.meta.url)
// Plain string paths for the atomic write below — fs.rename() needs real
// paths, and mixing URL/string forms across the read and write sides is how
// you end up reading one file and writing another.
const SETTINGS_FILE = fileURLToPath(SETTINGS_PATH)
const SETTINGS_TMP  = `${SETTINGS_FILE}.tmp`

const DEFAULT_SETTINGS = {
  antilink:       false,
  welcome:        false,
  goodbye:        false,
  welcomeMessage: null,
  goodbyeMessage: null,
  // Premium-gated group chat — see plugins/premium.js (.premium on/off) and
  // handler.js's group-gate check. When true, non-owner/non-premium members
  // get a reply-only rejection on every command (no kick). Expired members
  // are removed by the periodic sweep in main.js, which relies on
  // lib/premium-groups.js's snapshot list rather than scanning every group's
  // settings here.
  premiumOnly:    false,
  // Music-only group chat — see plugins/musicmode.js (.music on/off) and
  // handler.js's music-only gate (isMusicModeAllowed). When true, regular
  // members may run ONLY the music command (.song/.mp3) and the group
  // directory commands (category 'group'); every other command is refused
  // with a reply. Group admins/mods and the bot owner bypass it entirely, so
  // they keep moderating and can always run `.music off`. Reply-only, never a
  // kick — same shape as premiumOnly above.
  musicOnly:      false,
  // Feature toggles for pvp.js / mine.js / dungeon.js — these default to
  // FALSE (opt-in). A group admin must explicitly turn a feature on with
  // `.pvp on` / `.mine on` / `.dungeon on` before it works in that group.
  // Each plugin checks its own flag near the top of run() and rejects
  // with a message pointing at the toggle command.
  pvpEnabled:     false,
  miningEnabled:  false,
  dungeonEnabled: false,
  // Live Streaming (plugins/stream.js, `.stream on`) — OFF by default like
  // every other feature toggle. A stream posts its own unprompted round
  // messages into the chat every few minutes, so it may never switch itself
  // on for a group that didn't ask for it. `.stream start` checks this flag.
  streamingEnabled: false,
  // Anime card auto-spawn — OFF by default, unlike the feature toggles
  // above. A group must explicitly opt in with `.waifu on` before cards
  // start spawning there once an hour. See main.js's spawn interval.
  cardsEnabled:   false,
  // Anime Series auto-spawn — OFF by default. A group must explicitly opt in
  // with `.series on` before series start spawning every 2 hours.
  seriesEnabled:  false,
  // Wild Pokémon auto-spawn — OFF by default, same opt-in pattern as
  // cardsEnabled/seriesEnabled. A group must explicitly opt in with
  // `.pokeswitch on` before wild Pokémon start spawning. See
  // main.js's runPokemonSpawnSweep.
  pokemonEnabled: false,
  // Empire system (plugins/empire.js, plugins/build.js) — OFF by default like
  // every other feature toggle. A group admin opts in with `.empire on`. The
  // empire plugins check this flag near the top of run() and reject with a
  // message pointing at the toggle command.
  empireEnabled: false,
  // Story Mode (plugins/story.js, `.story on/off`) — OFF by default like
  // every other feature toggle. Story Mode floods a group with sequential
  // narrative messages, so an owner/mod must explicitly opt a group in
  // before .story-mode / .story enter / .story start do anything there.
  storyEnabled: false,
  // ── Moderation toggles ───────────────────────────────────────────────
  // All OFF by default: every one of these deletes messages or removes
  // people, so none of them may switch themselves on for a group that
  // never asked. Each is flipped by its own plugin and read by the scan
  // block in handler.js.
  //
  // grouplock — only group admins (and the bot owner) may talk. Everyone
  // else's message is deleted on sight. antiFake/antiInternational are
  // sub-settings of the same lock: they act on JOIN, not on message, and
  // are checked by the group-participants hook rather than the scan.
  grouplock:          false,
  antiFake:           false,
  antiInternational:  false,
  // Country codes considered "local" for antiInternational. Empty means
  // the owner's own country code is used — see plugins/grouplock.js.
  localPrefixes:      [],
  // antispam — N identical-or-rapid messages inside a rolling window get
  // deleted. Past the warn threshold the sender is kicked. Count/window
  // are per-group so a chatty group can loosen them.
  antispam:           false,
  antispamCount:      5,
  antispamWindow:     10,   // seconds
  antispamKick:       false,
  // antidelete — repost a deleted message with the sender tagged.
  antidelete:         false,
  // antichannel — delete + kick on WhatsApp Channel (newsletter) forwards.
  antichannel:        false,
  // antistatus — delete status-mention notifications. Delete only, NEVER
  // a kick: the mention notification is posted by WhatsApp on the sender's
  // behalf and is a weak signal to remove someone over.
  antistatus:         false,
}

/**
 * ── Why this file is more careful than "readFile / writeFile" ─────────────
 *
 * A toggle written here has to STICK. `.series off` that silently doesn't
 * persist looks exactly like "the bot ignored me and kept spawning", and that
 * was a real reported bug. Three separate holes made that possible:
 *
 * 1. NO SERIALIZATION. updateGroupSettings() was read → mutate → write with
 *    nothing in between the two halves. Two toggles overlapping (or one toggle
 *    overlapping the welcome/goodbye hook, which also writes here) both read
 *    the same snapshot; the second write put back its own stale copy of the
 *    first one's field. The `.series off` reply was sent, the flag was gone.
 *    Every write now goes through one chain, one at a time.
 *
 * 2. NON-ATOMIC WRITE. writeFile() straight onto group-settings.json means a
 *    crash / OOM-kill / pm2 restart mid-write leaves a half-written file, and
 *    readAll()'s catch turned that into `{}` — i.e. EVERY group silently back
 *    on defaults, and the next write then persisted that empty object. Same
 *    temp-file + rename trick lib/fast-json-adapter.js uses for db.json.
 *
 * 3. A CORRUPT READ LOOKED LIKE AN EMPTY FILE. That is never a safe guess for
 *    a settings file — "no settings" reads as "nothing is enabled anywhere".
 *    A failed parse now keeps the last known-good copy in memory, refuses to
 *    write over the file it couldn't read, and says so loudly.
 *
 * The cache is also a hot-path win: getGroupSettings() is awaited on EVERY
 * inbound group message (antilink + the moderation scan) and once per group
 * per spawn sweep. That was a disk read per message; it's now at most one read
 * every CACHE_TTL_MS. The TTL is deliberately short so editing
 * data/group-settings.json by hand still takes effect within a few seconds —
 * the spawn sweeps in main.js document that as a supported way to turn a
 * feature off.
 */

/** Last known-good parse of the whole file. null until the first read. */
let cache = null
let cacheAt = 0
const CACHE_TTL_MS = 3_000

/** True when the last disk read failed to parse — blocks writes (see #3). */
let readFailed = false

/** Serializes every write in this process, so #1 can't happen. */
let writeChain = Promise.resolve()

/** Reads and parses the file, creating it if missing. Throws on bad JSON. */
async function readFromDisk() {
  if (!existsSync(SETTINGS_FILE)) {
    await mkdir(dirname(SETTINGS_FILE), { recursive: true }).catch(() => {})
    await writeFile(SETTINGS_FILE, '{}\n', 'utf8')
    return {}
  }
  const raw = await readFile(SETTINGS_FILE, 'utf8')
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('group-settings.json does not contain a JSON object')
  }
  return parsed
}

/**
 * The full settings map. Served from cache unless it's older than
 * CACHE_TTL_MS or `force` is set (every write forces, so a mutation never
 * starts from a stale snapshot).
 */
async function readAll({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache

  try {
    cache = await readFromDisk()
    cacheAt = Date.now()
    readFailed = false
    return cache
  } catch (err) {
    readFailed = true
    logger.error({ err: err.message, file: SETTINGS_FILE },
      'group-settings.json could not be read — serving the last known-good copy and refusing to write until it parses again')
    // Last good copy beats {} : {} means "every feature off in every group".
    return cache ?? {}
  }
}

/** Atomic whole-file write (temp + rename), then refresh the cache. */
async function writeAll(all) {
  if (readFailed) {
    throw new Error(
      'refusing to write group-settings.json: the current file could not be parsed, ' +
      'so writing would delete every group\'s settings. Fix or delete data/group-settings.json and retry.',
    )
  }
  await writeFile(SETTINGS_TMP, JSON.stringify(all, null, 2) + '\n', 'utf8')
  await rename(SETTINGS_TMP, SETTINGS_FILE) // atomic swap
  cache = all
  cacheAt = Date.now()
}

/**
 * Returns the settings object for `groupId`, filled in with defaults for
 * any missing keys. Does NOT persist — read-only convenience accessor.
 * Safe to call from hot paths like the antilink scan on every message.
 */
export async function getGroupSettings(groupId) {
  const all = await readAll()
  return { ...DEFAULT_SETTINGS, ...(all[groupId] ?? {}) }
}

/**
 * The group's block EXACTLY as it sits in data/group-settings.json — no
 * defaults merged in, cache bypassed. Returns null if the group has never had
 * a setting written for it.
 *
 * This is what `.gcsettings` reports from, and the distinction from
 * getGroupSettings() is the whole point: getGroupSettings() can't tell you
 * whether `welcome: false` was SAVED or is just the default filling a gap, and
 * "is my toggle actually in the file?" is exactly the question being asked.
 */
export async function readRawGroupSettings(groupId) {
  const all = await readAll({ force: true })
  return all[groupId] ?? null
}

/** Absolute path of the file settings are persisted to — shown by .gcsettings. */
export const SETTINGS_FILE_PATH = SETTINGS_FILE

/** Every key a group can persist, in display order, for `.gcsettings`. */
export const SETTINGS_DISPLAY = [
  ['Greetings', [
    ['welcome',           'Welcome messages',   'bool'],
    ['welcomeMessage',    'Welcome text',       'text'],
    ['goodbye',           'Goodbye messages',   'bool'],
    ['goodbyeMessage',    'Goodbye text',       'text'],
  ]],
  ['Moderation', [
    ['antilink',          'Antilink',           'bool'],
    ['grouplock',         'Group lock',         'bool'],
    ['antiFake',          'Anti-fake number',   'bool'],
    ['antiInternational', 'Anti-international', 'bool'],
    ['localPrefixes',     'Allowed prefixes',   'list'],
    ['antispam',          'Antispam',           'bool'],
    ['antispamCount',     'Antispam count',     'num'],
    ['antispamWindow',    'Antispam window (s)', 'num'],
    ['antispamKick',      'Antispam kicks',     'bool'],
    ['antidelete',        'Antidelete',         'bool'],
    ['antichannel',       'Antichannel',        'bool'],
    ['antistatus',        'Antistatus',         'bool'],
  ]],
  ['Features', [
    ['pvpEnabled',        'PvP',                'bool'],
    ['miningEnabled',     'Mining',             'bool'],
    ['dungeonEnabled',    'Dungeons',           'bool'],
    ['cardsEnabled',      'Card spawns',        'bool'],
    ['seriesEnabled',     'Series spawns',      'bool'],
    ['pokemonEnabled',    'Pokémon spawns',     'bool'],
    ['streamingEnabled',  'Live streaming',     'bool'],
    ['empireEnabled',     'Empires',            'bool'],
    ['storyEnabled',      'Story Mode',         'bool'],
    ['premiumOnly',       'Premium-only chat',  'bool'],
    ['musicOnly',         'Music-only chat',    'bool'],
  ]],
]

/** Every key with a default — used by .gcsettings to flag unknown/legacy keys. */
export const KNOWN_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS)

/** "on"/"true"/"1"/"enable" → true, "off"/"false"/"0"/"disable" → false, else null. */
export function parseOnOff(arg) {
  const s = String(arg ?? '').trim().toLowerCase()
  if (['on', 'enable', 'enabled', 'true', 'yes', '1'].includes(s)) return true
  if (['off', 'disable', 'disabled', 'false', 'no', '0'].includes(s)) return false
  return null
}

/**
 * updateGroupSettings() with the throw turned into a value.
 *
 * updateGroupSettings() rejects when a write doesn't land, which is correct —
 * but every caller was `await`ing it bare inside a plugin's run(), and
 * dispatch() in lib/plugin-manager.js catches a plugin throw, logs it, and
 * returns. Net effect: a failed save sent the group NOTHING AT ALL. No
 * confirmation, no error — which is indistinguishable from "the bot ignored
 * me", and is exactly what "I feel like it isn't saving" looks like from the
 * inside of a chat.
 *
 * So: same write, same read-back verification, but the outcome comes back as
 * { ok, settings, error } and the caller is expected to say which one happened.
 */
export async function saveGroupSettings(groupId, mutatorFn) {
  try {
    const settings = await updateGroupSettings(groupId, mutatorFn)
    return { ok: true, settings, error: null }
  } catch (err) {
    logger.error({ groupId, err: err.message }, 'group settings save failed — reporting to the chat')
    return { ok: false, settings: null, error: err.message }
  }
}

/** The reply text for a save that didn't land. Says where to look, not just "error". */
export function saveFailedMessage(label, error) {
  return (
    `❌ Couldn't save *${label}* — *nothing was changed.*\n\n` +
    `_${error}_\n\n` +
    `The setting is stored in \`data/group-settings.json\`. Check that file exists, ` +
    `is valid JSON, and that the bot can write to it. Then try again.`
  )
}

/**
 * Safely mutates a group's settings: re-reads from disk, applies
 * `mutatorFn` to a defaults-filled copy, writes the result back.
 * mutatorFn receives the settings object and must mutate it in place or
 * return a new object to replace it.
 *
 * Serialized against every other write in this process, and the result is
 * read back off disk and compared before returning. If the value that
 * landed isn't the value we wrote, this THROWS rather than returning — the
 * caller's "✅ series spawns are now OFF" reply must never be sent for a
 * write that didn't actually take.
 */
export async function updateGroupSettings(groupId, mutatorFn) {
  const run = async () => {
    const all = await readAll({ force: true })
    const current = { ...DEFAULT_SETTINGS, ...(all[groupId] ?? {}) }

    const result = await mutatorFn(current)
    const next = result ?? current

    await writeAll({ ...all, [groupId]: next })

    // Read-back verification. Cheap (one small file), and it turns "the
    // toggle silently didn't stick" into a logged, thrown error instead of
    // a false confirmation to the group.
    const onDisk = await readFromDisk()
    if (JSON.stringify(onDisk[groupId]) !== JSON.stringify(next)) {
      cache = onDisk
      cacheAt = Date.now()
      logger.error({ groupId }, 'group settings write did not persist as written')
      throw new Error(`group settings for ${groupId} did not persist — nothing was changed`)
    }

    return next
  }

  // .then(run, run): a previous write failing must not stop this one, and
  // the chain itself is kept un-rejected so it can never poison later calls.
  const task = writeChain.then(run, run)
  writeChain = task.then(() => {}, () => {})
  return task
}

// isOwnerJid is now imported from group-helpers.js (single source of truth).
// Re-exported here so existing `import { isOwnerJid } from './group-settings.js'`
// call sites elsewhere keep working without changes.
export { isOwnerJid }

/**
 * Returns true if ctx.from is either the configured bot owner, or an
 * admin of the current group/channel/chat. Used to gate every
 * group-management subcommand (kick, add, antilink toggle, welcome/goodbye
 * config) — either credential is sufficient, not both.
 *
 * The platform branch lives in lib/platform/permissions.js: WhatsApp keeps
 * the groupMetadata() participant lookup, while Discord and Telegram answer
 * through a native check the adapter installs as ctx.isChatAdmin(). Before
 * that split, this function threw on ctx.sock (absent off WhatsApp), caught
 * its own error, and returned false — silently locking every admin command
 * on the other two platforms.
 */
export async function isGroupOrBotOwner(ctx) {
  return resolveChatAdmin(ctx)
}

/**
 * Same as isGroupOrBotOwner(), plus a third credential: being a bot-level
 * "mod" (db.data.mods — see lib/mod-repo.js). Mod status is GLOBAL — once
 * granted (by the bot owner, via .mod), that JID is a mod in every group,
 * not just the one it was granted in. Mods are NOT WhatsApp group admins
 * and don't pass isGroupOrBotOwner() itself — this is a separate, narrower
 * check used only by the specific commands a mod is allowed to run (.ban,
 * .unban, .kick, .add, .antilink, .welcome, .setwelcome, .goodbye,
 * .setgoodbye). Everything still gated by isGroupOrBotOwner() alone stays
 * owner/WhatsApp-admin-only.
 */
export async function isGroupOrBotOwnerOrMod(ctx) {
  if (await isGroupOrBotOwner(ctx)) return true
  return isMod(ctx.db, ctx.from)
}

/**
 * Shared body for any plain `<cmd> on|off` group setting — .antilink and
 * friends. Writes, verifies, and reports what actually landed. Same contract
 * as handleGreetingToggle() below, minus the word "messages".
 *
 * @param onNote  extra line appended when the setting ends up ON
 */
export async function handleBoolToggle(ctx, field, label, emoji = '⚙️', onNote = '') {
  const { args, reply, sender, isGroup } = ctx
  if (!isGroup) return reply(NOT_GROUP)
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

  const p = config.prefix
  const want = parseOnOff(args[0])
  if (want === null) {
    return reply(`❌ *Usage:* ${p}${ctx.cmd} on|off`)
  }

  const res = await saveGroupSettings(sender, s => { s[field] = want; return s })
  if (!res.ok) return reply(saveFailedMessage(label, res.error))

  const stored = res.settings[field] === true
  return reply(
    `${emoji} ${label} is now *${stored ? 'ON' : 'OFF'}*.\n` +
    (stored && onNote ? `${onNote}\n` : '') +
    `_Saved to data/group-settings.json — verify any time with ${p}gcsettings._`,
  )
}

/**
 * Shared body for every platform's `.welcome on|off` / `.goodbye on|off`
 * style toggle — used by plugins/welcome.js, plugins/goodbye.js, and their
 * Discord/Telegram equivalents in plugins-discord/ and plugins-telegram/,
 * so the on/off parsing and reply text can't drift between the four copies.
 *
 * The confirmation quotes the value READ BACK OFF DISK, not the value that was
 * asked for. Those are the same thing when the write worked, and when they
 * aren't the same thing that's precisely the bug worth surfacing — a reply of
 * "welcome is now ON" that was generated from the request rather than from the
 * stored result is a claim the bot has no evidence for.
 */
export async function handleGreetingToggle(ctx, field, label, emoji = '👋') {
  const { args, reply, sender, isGroup } = ctx
  if (!isGroup) return reply(NOT_GROUP)
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

  const p = config.prefix
  const want = parseOnOff(args[0])
  if (want === null) {
    return reply(`❌ *Usage:* ${p}${ctx.cmd} on|off`)
  }

  const res = await saveGroupSettings(sender, s => { s[field] = want; return s })
  if (!res.ok) return reply(saveFailedMessage(label, res.error))

  const stored = res.settings[field] === true
  return reply(
    `${emoji} ${label} messages are now *${stored ? 'ON' : 'OFF'}*.\n` +
    `_Saved to data/group-settings.json — verify any time with ${p}gcsettings._`,
  )
}

/**
 * Shared body for `.setwelcome <text>` / `.setgoodbye <text>` — same
 * dedup rationale as handleGreetingToggle() above, and the same read-back.
 */
export async function handleSetGreetingMessage(ctx, field, label, example) {
  const { args, reply, sender, isGroup } = ctx
  if (!isGroup) return reply(NOT_GROUP)
  if (!(await isGroupOrBotOwnerOrMod(ctx))) return reply(NOT_ALLOWED)

  const p = config.prefix
  const text = args.join(' ').trim()
  if (!text) {
    return reply(`❌ *Usage:* ${p}${ctx.cmd} <text>\nUse {user} to mention the member.\nExample: ${p}${ctx.cmd} ${example}`)
  }

  const res = await saveGroupSettings(sender, s => { s[field] = text; return s })
  if (!res.ok) return reply(saveFailedMessage(`${label} message`, res.error))

  // The toggle and the text are separate settings, and setting the text
  // without the toggle on is the most common way "I set it up and nothing
  // happened" happens. Say so here rather than letting them find out by
  // watching nobody get greeted.
  const toggleField = field === 'welcomeMessage' ? 'welcome' : 'goodbye'
  const toggleOn    = res.settings[toggleField] === true

  return reply(
    `✅ ${label} message saved:\n\n${res.settings[field]}\n\n` +
    (toggleOn
      ? `_${label} messages are ON, so this is live._`
      : `⚠️ _${label} messages are currently *OFF* — run *${p}${toggleField} on* to actually send this._`),
  )
}
