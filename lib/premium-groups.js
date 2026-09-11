/**
 * premium-groups.js — flat snapshot list of group JIDs that currently have
 * `.premium on` active, backed by data/premium-groups.json.
 *
 * Why a separate list instead of scanning data/group-settings.json every
 * sweep: the periodic expiry sweep (see main.js) needs "all premium-gated
 * groups" fast and often; this list is exactly that, kept in sync whenever
 * `.premium on`/`.premium off` runs (see plugins/premium.js). The underlying
 * per-group `premiumOnly` flag in group-settings.json remains the source of
 * truth for the handler's per-message gate check — this list is a derived
 * index, not a second source of truth for the flag itself.
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const LIST_PATH = new URL('../data/premium-groups.json', import.meta.url)

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

/** All group JIDs currently marked premium-gated. */
export async function getPremiumGroups() {
  return readAll()
}

/** Adds `groupJid` to the snapshot list if not already present. */
export async function addPremiumGroup(groupJid) {
  const list = await readAll()
  if (!list.includes(groupJid)) {
    list.push(groupJid)
    await writeAll(list)
  }
}

/** Removes `groupJid` from the snapshot list. */
export async function removePremiumGroup(groupJid) {
  const list = await readAll()
  const next = list.filter(g => g !== groupJid)
  if (next.length !== list.length) await writeAll(next)
}
