/**
 * series-spawn-groups.js — flat snapshot list of group JIDs that currently
 * have `.series on` (anime series auto-spawn) active, backed by
 * data/series-spawn-groups.json.
 *
 * Exact structural mirror of lib/card-spawn-groups.js — same rationale:
 * the 2-hour spawn interval in main.js needs "all series-enabled groups"
 * fast, without scanning every group's settings each run. The `seriesEnabled`
 * flag in group-settings.json stays the source of truth for the per-message
 * check; this list is a derived index kept in sync by `.series on` / `.series off`.
 */
import { runtimeUrl } from './runtime-paths.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const LIST_PATH = runtimeUrl('series-spawn-groups.json')

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

/** All group JIDs currently marked for series auto-spawn. */
export async function getSeriesSpawnGroups() {
  return readAll()
}

/** Adds `groupJid` to the snapshot list if not already present. */
export async function addSeriesSpawnGroup(groupJid) {
  const list = await readAll()
  if (!list.includes(groupJid)) {
    list.push(groupJid)
    await writeAll(list)
  }
}

/** Removes `groupJid` from the snapshot list. */
export async function removeSeriesSpawnGroup(groupJid) {
  const list = await readAll()
  const next = list.filter(g => g !== groupJid)
  if (next.length !== list.length) await writeAll(next)
}
