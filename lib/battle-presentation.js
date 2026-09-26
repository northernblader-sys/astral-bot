/** In-process presentation ownership. No HP, reward or database mutations.
 * A cinematic owns both duel participants, NOT the entire group chat.
 * The db is the scope because multiple WhatsApp sockets share one battle DB.
 * Cross-process/VPS coordination remains the responsibility of combat adapters.
 */
const scopes = new WeakMap()
const completedContexts = new WeakSet()
const defaultScope = {}

function scope(ctx) {
  const key = ctx.db ?? ctx.sock ?? defaultScope
  if (!scopes.has(key)) scopes.set(key, new Map())
  return scopes.get(key)
}
function ids(ctx, opts = {}) {
  const player = opts.player ?? ctx.player
  const all = [ctx.from, player?.battleState?.opponentJid, ...(opts.participants ?? [])]
  return [...new Set(all.filter(id => typeof id === 'string' && id.length))]
}
function record(records, id) {
  if (!records.has(id)) records.set(id, { generation: 0, active: null })
  return records.get(id)
}

export function isBattleCinematicActive(ctx, opts = {}) {
  const records = scope(ctx)
  return ids(ctx, opts).some(id => records.get(id)?.active)
}

/** Capture BEFORE rendering. A scene starting while canvas/HTTP work is pending
 * invalidates the old card even if that scene has finished before rendering does.
 */
export function battleOutputTicket(ctx, opts = {}) {
  const records = scope(ctx)
  return ids(ctx, opts).map(id => [record(records, id), record(records, id).generation])
}
export function suppressBattleOutput(ctx, ticket = [], opts = {}) {
  return completedContexts.has(ctx) || isBattleCinematicActive(ctx, opts) ||
    ticket.some(([entry, generation]) => entry.generation !== generation)
}

export async function withBattleCinematic(ctx, play, opts = {}) {
  if (completedContexts.has(ctx) || isBattleCinematicActive(ctx, opts)) return { suppressed: true }
  const records = scope(ctx)
  const participants = ids(ctx, opts)
  if (!participants.length) throw new Error('A cinematic requires a battle participant')
  const token = Symbol('battle cinematic')
  const entries = participants.map(id => record(records, id))
  // Acquire synchronously, before the first send/await. Competing commands
  // cannot both observe the lock as free and start overlapping scenes.
  for (const entry of entries) { entry.generation++; entry.active = token }
  try {
    return await play()
  } finally {
    // Suppress a caller's trailing generic card even after the lock releases.
    // A fresh command context can render normally; contexts are command-local.
    completedContexts.add(ctx)
    for (const entry of entries) if (entry.active === token) entry.active = null
  }
}
