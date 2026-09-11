/**
 * card-spawn-groups.js — flat snapshot list of group JIDs that currently
 * have `.waifu on` (card auto-spawn) active, backed by
 * data/card-spawn-groups.json.
 *
 * Same rationale as lib/premium-groups.js: the hourly spawn interval in
 * main.js needs "all card-enabled groups" fast, without scanning every
 * group's settings each run. The `cardsEnabled` flag in
 * group-settings.json stays the source of truth for the per-message
 * flavor text / `.waifu off` check; this list is a derived index kept in
 * sync by the `.waifu on` / `.waifu off` toggle in plugins/waifu.js.
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const LIST_PATH = new URL('../data/card-spawn-groups.json', import.meta.url)

async function readAll() {
  if (!existsSync(LIST_PATH)) {
    await mkdir(dirname(LIST_PATH.pathname ?? LIST_PATH), { recursive: true }).catch(() => {})
    await writeFile(LIST_PATH, '[]\n', 'utf8')
    return []
  }
  try {
    const raw = await readFile(LIST_PATH, 'utf8')
    const parsed = raw.trim() ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeAll(list) {
  await writeFile(LIST_PATH, JSON.stringify(list, null, 2) + '\n', 'utf8')
}

/** All group JIDs currently marked for card auto-spawn. */
export async function getCardSpawnGroups() {
  return readAll()
}

/** Adds `groupJid` to the snapshot list if not already present. */
export async function addCardSpawnGroup(groupJid) {
  const list = await readAll()
  if (!list.includes(groupJid)) {
    list.push(groupJid)
    await writeAll(list)
  }
}

/** Removes `groupJid` from the snapshot list. */
export async function removeCardSpawnGroup(groupJid) {
  const list = await readAll()
  const next = list.filter(g => g !== groupJid)
  if (next.length !== list.length) await writeAll(next)
}
