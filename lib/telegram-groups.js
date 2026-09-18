/**
 * telegram-groups.js — registry of Telegram groups the bot has seen, so a
 * DM config menu (plugins-telegram/settings.js) can answer "which groups
 * can this person configure?" without Telegram exposing that as a direct
 * API query. Telegram has no "list groups this user administers" call —
 * the bot only knows what it has personally observed, so every group
 * message updates this file with the chat's title and the sender's admin
 * status at that moment.
 *
 * Mirrors lib/group-settings.js's flat-JSON read→mutate→write pattern
 * (small data, no need for lowdb's machinery) and deliberately lives in a
 * separate file from group-settings.json — this is bot-observed metadata
 * about groups, not per-group feature configuration, and keeping them
 * apart means a corrupt/reset one can never take the other down with it.
 */
import { runtimeUrl } from './runtime-paths.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

// Same URL→string conversion group-settings.js does, for the same reason: on
// Windows a file URL's .pathname is "/C:/Users/..." with a leading slash, so
// handing it to dirname()/mkdir() builds "C:\C:\Users\..." and every write
// fails with ENOENT. fileURLToPath() is the only correct way across platforms.
const REGISTRY_PATH = runtimeUrl('telegram-groups.json')
const REGISTRY_FILE = fileURLToPath(REGISTRY_PATH)

async function readAll() {
  try {
    const raw = await readFile(REGISTRY_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeAll(all) {
  const dir = dirname(REGISTRY_FILE)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8')
}

/**
 * Call on every group message. Records the chat's display name and, when
 * `isAdmin` is known for this sender (adapter checks it lazily — see
 * settings.js, which re-verifies live via getChatMember rather than
 * trusting this cache for anything permission-sensitive), keeps a small
 * "last seen as admin" set so the DM menu has something to list without
 * an expensive live scan of every group on every /settings call.
 */
export async function recordGroupSighting(chatId, chatTitle, userId, isAdmin) {
  const all = await readAll()
  const entry = all[chatId] ?? { title: chatTitle, admins: [] }
  entry.title = chatTitle
  entry.lastSeenAt = Date.now()

  const admins = new Set(entry.admins ?? [])
  if (isAdmin) admins.add(userId)
  entry.admins = [...admins]

  all[chatId] = entry
  await writeAll(all)
}

/** Groups where `userId` was last observed as an admin/creator. */
export async function listAdminGroupsFor(userId) {
  const all = await readAll()
  return Object.entries(all)
    .filter(([, entry]) => (entry.admins ?? []).includes(userId))
    .map(([chatId, entry]) => ({ chatId, title: entry.title }))
}

export async function getGroupTitle(chatId) {
  const all = await readAll()
  return all[chatId]?.title ?? null
}

// ── The DM config screen ────────────────────────────────────────────────────
// Backs plugins-telegram/settings.js. It lives here, next to the registry it
// reads, rather than in adapters/telegram/adapter.js — that file's stated
// contract is grammy↔pipeline translation only, and "which groups may this
// person configure, and how" is a rule, not a translation.
//
// This returns a TEXT screen, not an inline keyboard. Telegram delivers button
// taps as callback_query updates, and nothing in this bot listens for those, so
// buttons here would render and then silently do nothing. Listing the exact
// commands to run in the group works today and reads the same in every client.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => HTML_ESCAPES[c])

/** The toggles worth surfacing in a DM, with the command that flips each one. */
const MENU = [
  ['Antilink',        '.antilink on',  '.antilink off'],
  ['Welcome message', '.welcome on',   '.welcome off'],
  ['Goodbye message', '.goodbye on',   '.goodbye off'],
  ['PvP',             '.pvp on',       '.pvp off'],
  ['Mining',          '.mine on',      '.mine off'],
  ['Dungeons',        '.dungeon on',   '.dungeon off'],
  ['Empires',         '.empire on',    '.empire off'],
]

/**
 * The first (and, for now, only) settings screen for `userId`: every group the
 * bot has watched them admin, plus the commands that configure one. Shaped
 * { text, reply_markup } so settings.js can pass it straight to a grammy reply;
 * reply_markup is undefined until a callback_query handler exists to serve taps.
 */
export async function buildGroupPickerScreen(userId) {
  const groups = await listAdminGroupsFor(String(userId))

  if (!groups.length) {
    return {
      text: [
        '⚙️ <b>Group settings</b>',
        '',
        'I have not seen you as an admin of any group yet.',
        '',
        'Telegram gives bots no way to ask "which groups does this person run", so I only',
        'know what I have watched happen. Run any command (for example <code>.help</code>) in a group',
        'where you are an admin, then send <code>.settings</code> here again and it will be listed.',
      ].join('\n'),
      reply_markup: undefined,
    }
  }

  const lines = ['⚙️ <b>Group settings</b>', '', `You admin <b>${groups.length}</b> group${groups.length === 1 ? '' : 's'} I know of:`, '']
  for (const g of groups) {
    lines.push(`• <b>${esc(g.title ?? g.chatId)}</b>`)
  }
  lines.push('')
  lines.push('Run these <i>inside</i> the group you want to change:')
  for (const [label, on, off] of MENU) {
    lines.push(`• ${esc(label)}: <code>${esc(on)}</code> / <code>${esc(off)}</code>`)
  }
  lines.push('')
  lines.push('Set greeting text with <code>.setwelcome &lt;message&gt;</code> or <code>.setgoodbye &lt;message&gt;</code>.')
  lines.push('See everything a group has set with <code>.gcsettings</code>.')

  return { text: lines.join('\n'), reply_markup: undefined }
}
