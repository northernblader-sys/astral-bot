/**
 * runtime-paths.js — where MUTABLE state lives at runtime.
 *
 * The bug this fixes: on Railway the container filesystem is rebuilt from the
 * GitHub repo on every deploy. `./data/` is part of the repo, so every file
 * the bot writes back into it — group-settings.json, moderation.json, the
 * spawn-group lists, night mode, spin locks — is silently reverted to whatever
 * was committed the moment you redeploy. Turn antilink on, push a commit, and
 * it's off again. Same story for db.json (every player) and auth_info (the
 * pairing), which is why a deploy could also log the bot out.
 *
 * The fix is to separate two things that were both living in ./data:
 *
 *   STATIC CATALOGS — items.json, monsters.json, locations.json, characters…
 *     These are *code*. They SHOULD be replaced on every deploy, that's how
 *     you ship balance changes. They keep reading from the repo ./data and
 *     nothing here touches them.
 *
 *   MUTABLE STATE — the files below. These are *data*. They must outlive the
 *     container, so they move to a persistent volume and are seeded from the
 *     repo copy only the first time, when the volume is still empty.
 *
 * ── Railway setup ─────────────────────────────────────────────────────────
 * If you ALREADY have a volume (db.json and paired_number.txt on it), there is
 * nothing to do: the mount is found from DB_PATH, or from Railway's own
 * RAILWAY_VOLUME_MOUNT_PATH, and the remaining state files are created next to
 * the database on that same volume. Files already there are never overwritten.
 *
 * If you don't have one yet: Service → Settings → Volumes → New Volume, any
 * mount path, then redeploy. Set RUNTIME_DATA_DIR only if you want the state
 * somewhere other than the mount root.
 *
 * With no volume at all this falls back to ./data and behaves exactly as
 * before, so local dev and PM2 on a VPS are unaffected.
 */
import { existsSync, mkdirSync, copyFileSync, cpSync, accessSync, constants } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

/** The repo's own data/ — static catalogs, and the seed copies. */
export const REPO_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url))

/**
 * Everything the bot WRITES. Anything not on this list keeps coming from the
 * repo, so adding a new catalog file needs no change here — but adding a new
 * piece of saved state does, or it will start reverting on deploy again.
 */
export const MUTABLE_FILES = [
  'group-settings.json',
  'moderation.json',
  'mod-gc.json',
  'submissions.json',
  'night-mode.json',
  'spin-locks.json',
  'premium-groups.json',
  'card-spawn-groups.json',
  'pokemon-spawn-groups.json',
  'series-spawn-groups.json',
  'telegram-groups.json',
  'paired_number.txt',
]

function isWritableDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Finds the volume, in order of how explicit the signal is:
 *
 *   1. RUNTIME_DATA_DIR / DATA_DIR — you said so.
 *   2. The directory DB_PATH already points at. If db.json is already on a
 *      volume, that IS the volume, and everything else belongs beside it.
 *      This is the zero-config path for a bot that was already storing its
 *      database and pairing on a mount: no new variable to add.
 *   3. RAILWAY_VOLUME_MOUNT_PATH — Railway injects this automatically for
 *      whatever mount path you set in the dashboard.
 *   4. The usual mount points, only if one actually exists and is writable.
 *   5. ./data, i.e. no persistence (fine locally, lossy on Railway).
 */
function resolveRuntimeDir() {
  const configured = process.env.RUNTIME_DATA_DIR || process.env.DATA_DIR
  if (configured) {
    const dir = path.resolve(configured)
    if (isWritableDir(dir)) return dir
    process.stderr.write(
      `[runtime-paths] ⚠️ RUNTIME_DATA_DIR="${configured}" is not writable — ` +
      `falling back, which may mean state is lost on the next deploy.\n`,
    )
  }

  // Follow an existing DB_PATH onto its volume.
  if (process.env.DB_PATH) {
    const dir = path.dirname(path.resolve(process.env.DB_PATH))
    if (dir !== path.resolve('.') && isWritableDir(dir)) return dir
  }

  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    const dir = path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)
    if (isWritableDir(dir)) return dir
  }

  for (const candidate of ['/data', '/mnt/data', '/var/data', '/app/data']) {
    if (existsSync(candidate) && isWritableDir(candidate)) return candidate
  }
  return REPO_DATA_DIR
}

export const RUNTIME_DATA_DIR = resolveRuntimeDir()

/** True when state is on a volume rather than inside the deployed repo. */
export const IS_PERSISTENT = path.resolve(RUNTIME_DATA_DIR) !== path.resolve(REPO_DATA_DIR)

/** Absolute path for a mutable state file. */
export function runtimePath(name) {
  return path.join(RUNTIME_DATA_DIR, name)
}

/** Same thing as a file:// URL — drop-in for `new URL('../data/x.json', …)`. */
export function runtimeUrl(name) {
  return pathToFileURL(runtimePath(name))
}

/**
 * First-boot seeding: copy the repo's committed copy of each mutable file to
 * the volume, but ONLY when the volume doesn't have one yet. After that the
 * volume copy is authoritative and deploys never overwrite it — which is the
 * whole point. Safe to call on every boot.
 */
export function seedRuntimeData(log = () => {}) {
  if (!IS_PERSISTENT) return { seeded: [], skipped: [], dir: RUNTIME_DATA_DIR, persistent: false }

  const seeded = []
  const skipped = []
  for (const name of MUTABLE_FILES) {
    const dest = runtimePath(name)
    if (existsSync(dest)) { skipped.push(name); continue }
    const src = path.join(REPO_DATA_DIR, name)
    if (!existsSync(src)) continue
    try {
      copyFileSync(src, dest)
      seeded.push(name)
    } catch (err) {
      process.stderr.write(`[runtime-paths] ⚠️ could not seed ${name}: ${err.message}\n`)
    }
  }

  // db.json and auth_info live at the repo ROOT, not under data/, but they
  // have the same problem and the same fix. Copy them across ONCE so an
  // existing deployment migrates its players and its pairing onto the volume
  // instead of waking up empty and asking to be paired again.
  const rootSeeds = [
    { src: path.resolve('./db.json'), dest: runtimePath('db.json'), kind: 'file' },
    { src: path.resolve('./auth_info'), dest: runtimePath('auth_info'), kind: 'dir' },
  ]
  for (const { src, dest, kind } of rootSeeds) {
    if (existsSync(dest) || !existsSync(src)) continue
    try {
      if (kind === 'dir') cpSync(src, dest, { recursive: true })
      else copyFileSync(src, dest)
      seeded.push(path.basename(dest))
    } catch (err) {
      process.stderr.write(`[runtime-paths] ⚠️ could not migrate ${src}: ${err.message}\n`)
    }
  }

  log(
    `💾 Persistent state dir: ${RUNTIME_DATA_DIR}` +
    (seeded.length ? ` — seeded ${seeded.length} file(s) from the repo on first boot: ${seeded.join(', ')}` : '') +
    (skipped.length ? ` — kept ${skipped.length} existing file(s)` : ''),
  )
  return { seeded, skipped, dir: RUNTIME_DATA_DIR, persistent: true }
}

/**
 * Default location for db.json and the Baileys auth folder. config.js uses
 * these so DB_PATH / AUTH_FOLDER stay overridable but land on the volume by
 * default — a deploy that wipes auth_info forces a re-pair, and a deploy that
 * wipes db.json wipes every player.
 */
export function defaultDbPath() {
  return IS_PERSISTENT ? runtimePath('db.json') : './db.json'
}

export function defaultAuthFolder() {
  return IS_PERSISTENT ? runtimePath('auth_info') : './auth_info'
}
