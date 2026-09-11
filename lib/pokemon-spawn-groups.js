/**
 * pokemon-spawn-groups.js — flat snapshot list of group JIDs that currently
 * have wild Pokémon auto-spawn active, backed by
 * data/pokemon-spawn-groups.json.
 *
 * Same rationale as lib/card-spawn-groups.js: the spawn interval in
 * main.js needs "all pokemon-enabled groups" fast, without scanning every
 * group's settings each run. This list is kept in sync by the
 * `.pokeswitch on` / `.pokeswitch off` toggle in plugins/pokeswitch.js.
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const LIST_PATH = new URL('../data/pokemon-spawn-groups.json', import.meta.url)

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

/** All group JIDs currently marked for Pokémon auto-spawn. */
export async function getPokemonSpawnGroups() {
  return readAll()
}

/** Adds `groupJid` to the snapshot list if not already present. */
export async function addPokemonSpawnGroup(groupJid) {
  const list = await readAll()
  if (!list.includes(groupJid)) {
    list.push(groupJid)
    await writeAll(list)
  }
}

/** Removes `groupJid` from the snapshot list. */
export async function removePokemonSpawnGroup(groupJid) {
  const list = await readAll()
  const next = list.filter(g => g !== groupJid)
  if (next.length !== list.length) await writeAll(next)
}
