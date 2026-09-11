/**
 * mod-gc.js — backs plugins/submit.js.
 *
 * Two flat JSON stores, same read→mutate→write idiom as
 * lib/premium-groups.js:
 *
 *   data/mod-gc.json         — { groupJid: string | null, counter: number }
 *                               The single group `.submit` forwards group-add
 *                               requests to (groupJid), plus the running
 *                               counter used to mint submission ids. Set with
 *                               `.modgc` (owner-only, run INSIDE the target
 *                               group). Replaces whatever was set before —
 *                               there is only ever one mod GC, not a list, so
 *                               `.modgc` in a new group always wins.
 *
 *   data/submissions.json    — array of ALL submission records, ever. Kept
 *                               forever rather than deleted on approve/
 *                               reject, so `.gcqueue` can show the full
 *                               pending/accepted/rejected history in one
 *                               place. Each record's `status` field is the
 *                               single source of truth for where it stands:
 *                                 'pending'  → awaiting a mod's .join/.reject
 *                                 'accepted' → .join was run against it
 *                                 'rejected' → .reject was run against it
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

const GC_PATH  = new URL('../data/mod-gc.json', import.meta.url)
const SUB_PATH = new URL('../data/submissions.json', import.meta.url)

async function readJson(path, fallback) {
  if (!existsSync(path)) {
    await mkdir(dirname(path.pathname ?? path), { recursive: true }).catch(() => {})
    await writeFile(path, JSON.stringify(fallback) + '\n', 'utf8')
    return fallback
  }
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

// ── Mod GC pointer + id counter ─────────────────────────────────────────

async function readGcFile() {
  return readJson(GC_PATH, { groupJid: null, counter: 0 })
}

/** The currently configured mod-GC jid, or null if `.modgc` was never run. */
export async function getModGc() {
  const data = await readGcFile()
  return data.groupJid ?? null
}

/** Sets the mod GC to `groupJid`, overwriting whatever was set before. */
export async function setModGc(groupJid) {
  const data = await readGcFile()
  await writeJson(GC_PATH, { ...data, groupJid })
}

/** Next short id — S001, S002, ... based on how many have ever been made. */
export async function nextSubmissionId() {
  const data = await readGcFile()
  const counter = (data.counter ?? 0) + 1
  await writeJson(GC_PATH, { ...data, counter })
  return `S${String(counter).padStart(3, '0')}`
}

// ── Submissions (full history — pending / accepted / rejected) ─────────

/**
 * A submission record:
 *   {
 *     id:            string   short id, e.g. "S042" — used in .join/.reject
 *     status:        'pending' | 'accepted' | 'rejected'
 *     submittedBy:   string   jid of the player who ran .submit
 *     submitterName: string
 *     link:          string   raw invite link they submitted
 *     inviteCode:    string   code parsed out of the link (for .join)
 *     groupName:     string
 *     memberCount:   number
 *     submittedAt:   number   Date.now()
 *     decidedAt:     number | null   set when accepted/rejected
 *     reason:        string | null   set on reject, if a reason was given
 *   }
 */
export async function getAllSubmissions() {
  return readJson(SUB_PATH, [])
}

export async function getPendingSubmissions() {
  const all = await getAllSubmissions()
  return all.filter(s => s.status === 'pending')
}

export async function addPendingSubmission(record) {
  const all = await getAllSubmissions()
  all.push({ ...record, status: 'pending', decidedAt: null, reason: null })
  await writeJson(SUB_PATH, all)
  return all[all.length - 1]
}

/** Finds a submission by id (any status), or null if no such id exists. */
export async function findSubmission(id) {
  const all = await getAllSubmissions()
  return all.find(s => s.id.toLowerCase() === String(id).toLowerCase()) ?? null
}

/**
 * Marks a pending submission's status and persists it — used by .join
 * (status: 'accepted') and .reject (status: 'rejected', optional reason).
 * Returns the updated record, or null if no PENDING submission with that
 * id exists (already-decided ids are left untouched, not re-decided).
 */
export async function decideSubmission(id, status, reason = null) {
  const all = await getAllSubmissions()
  const idx = all.findIndex(s => s.id.toLowerCase() === String(id).toLowerCase() && s.status === 'pending')
  if (idx === -1) return null

  all[idx] = { ...all[idx], status, decidedAt: Date.now(), reason }
  await writeJson(SUB_PATH, all)
  return all[idx]
}

/** Parses a WhatsApp group invite code out of a full chat.whatsapp.com link. */
export function parseInviteCode(link) {
  const match = String(link ?? '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/)
  return match ? match[1] : null
}
