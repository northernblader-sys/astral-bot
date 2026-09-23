/**
 * lib/guild-board.js — the Astral Town guild board.
 *
 * One engine, one catalog. A slip points at a street, a person, a real item,
 * or a family that already spawns. It does not invent a map.
 *
 * Three slips are posted each day, per hall, seeded like the daily quests:
 * one copper, one iron, one harder. The five halls never share a slip on the
 * same day. The board is shut unless you are sworn to a hall, and you only
 * see that hall's nail. One active slip. Three turn-ins a day. Pay is Solars
 * and fame. A gold slip may add one Gem, and the board never pays a second
 * Gem the same day. Monds are never on a slip. Fame here is a fixed number,
 * not the random kill payout, and it does not enter the treasury.
 *
 * Mutations are synchronous and must run inside updatePlayer. This module
 * never writes the db and never replies.
 *
 * Copy is player-facing: no em or en dashes.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const CATALOG = require('../data/guild-board.json')

import { spotOf, npcOf } from './town.js'
import { DUNGEON_NAMES } from './dungeon-lore.js'

export const SLIPS = CATALOG.slips ?? []
export const POSTED_COUNT = 3
export const TURNIN_CAP = 3
export const GEM_CAP = 1

/** The five fixed halls. Each gets its own three slips. Order is the assignment order. */
export const HALLS = [
  'astral_vanguard',
  'shadow_covenant',
  'gilded_order',
  'stormbreakers',
  'emberwake',
]

export const SLIP_BY_ID = Object.fromEntries(SLIPS.map(s => [s.id, s]))

const RANK_LABEL = { copper: 'Copper', iron: 'Iron', silver: 'Silver', gold: 'Gold' }

function assertCatalog() {
  if (SLIPS.length !== 50) throw new Error(`guild board expected 50 slips, found ${SLIPS.length}`)
  const ids = new Set()
  for (const slip of SLIPS) {
    if (!slip.id || ids.has(slip.id)) throw new Error(`bad or duplicate slip id ${slip.id}`)
    ids.add(slip.id)
    if (!['copper', 'iron', 'silver', 'gold'].includes(slip.rank)) throw new Error(`${slip.id} rank`)
    if (!slip.steps?.length) throw new Error(`${slip.id} has no steps`)
    for (const step of slip.steps) {
      if (step.kind === 'visit' && !spotOf(step.spot)) throw new Error(`${slip.id} visit ${step.spot}`)
      if ((step.kind === 'talk' || step.kind === 'deliver') && !npcOf(step.npc)) throw new Error(`${slip.id} npc ${step.npc}`)
      if (step.kind === 'deliver' && !step.item) throw new Error(`${slip.id} deliver item`)
      if (step.kind === 'cull' && !step.dungeon) throw new Error(`${slip.id} cull dungeon`)
    }
  }
}
assertCatalog()

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function shuffle(ids, seed) {
  const arr = ids.slice()
  let s = seed || 1
  const rand = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100000) / 100000
  }
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * One board per hall for this calendar day. No slip is nailed in two halls
 * at once. A hall that is not one of the five gets nothing.
 */
export function boardsForDay(dayStartMs) {
  const day = Math.floor(dayStartMs / 86_400_000) || 1
  const of = rank => SLIPS.filter(s => s.rank === rank).map(s => s.id)
  const hard = SLIPS.filter(s => s.rank === 'silver' || s.rank === 'gold').map(s => s.id)
  const copper = shuffle(of('copper'), day)
  const iron = shuffle(of('iron'), day + 17)
  const harder = shuffle(hard, day + 91)
  const boards = {}
  HALLS.forEach((hall, i) => {
    boards[hall] = [copper[i], iron[i], harder[i]].filter(Boolean)
  })
  return boards
}

/** The three slips nailed in this hall today. Empty if you have no hall. */
export function postedIds(dayStartMs, guildId) {
  if (!guildId) return []
  return boardsForDay(dayStartMs)[guildId] ?? []
}

export function postedSlips(dayStartMs, guildId) {
  return postedIds(dayStartMs, guildId).map(id => SLIP_BY_ID[id]).filter(Boolean)
}

/** True if some other hall has this slip up today. */
export function postedInOtherHall(dayStartMs, guildId, slipId) {
  return HALLS.some(hall => hall !== guildId && (boardsForDay(dayStartMs)[hall] ?? []).includes(slipId))
}

function blankLog() {
  return { finished: 0, solars: 0, gems: 0, fame: 0, last: [] }
}

export function ensureBoardState(player, now = Date.now()) {
  const today = startOfDay(now)
  if (!player.guildBoard || typeof player.guildBoard !== 'object') {
    player.guildBoard = {
      day: today, activeId: null, step: 0, count: 0,
      doneToday: [], turnins: 0, gemsToday: 0, log: blankLog(),
    }
  }
  const state = player.guildBoard
  state.log = state.log && typeof state.log === 'object' ? state.log : blankLog()
  state.log.last = Array.isArray(state.log.last) ? state.log.last : []
  if (state.day !== today) {
    state.day = today
    state.activeId = null
    state.step = 0
    state.count = 0
    state.doneToday = []
    state.turnins = 0
    state.gemsToday = 0
  }
  state.doneToday = state.doneToday ?? []
  state.turnins = state.turnins ?? 0
  state.gemsToday = state.gemsToday ?? 0
  state.step = state.step ?? 0
  state.count = state.count ?? 0
  if (state.activeId && !SLIP_BY_ID[state.activeId]) state.activeId = null
  // A slip belongs to the hall that issued it. Leave, or swear to another
  // banner, and it goes back on that hall's nail. It does not follow you.
  const hall = player.guildId || null
  if (!hall) {
    state.activeId = null
    state.step = 0
    state.count = 0
    state.hallId = null
  } else if (state.activeId && state.hallId && state.hallId !== hall) {
    state.activeId = null
    state.step = 0
    state.count = 0
    state.hallId = hall
  } else {
    state.hallId = hall
  }
  return state
}

export function findSlip(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return null
  if (SLIP_BY_ID[q]) return SLIP_BY_ID[q]
  const compact = q.replace(/[^a-z0-9]+/g, '_')
  if (SLIP_BY_ID[compact]) return SLIP_BY_ID[compact]
  const hits = SLIPS.filter(s =>
    s.id.includes(q) ||
    s.id.includes(compact) ||
    s.name.toLowerCase() === q ||
    s.name.toLowerCase().includes(q)
  )
  if (hits.length === 1) return hits[0]
  return hits.length ? hits : null
}

function currentStep(player) {
  const state = player.guildBoard
  const slip = state?.activeId ? SLIP_BY_ID[state.activeId] : null
  if (!slip) return { slip: null, step: null }
  return { slip, step: slip.steps[state.step] ?? null }
}

function ready(player) {
  const { slip } = currentStep(player)
  if (!slip) return false
  return player.guildBoard.step >= slip.steps.length
}

function advance(player) {
  player.guildBoard.step += 1
  player.guildBoard.count = 0
}

function advanceVisits(player) {
  let moved = false
  while (true) {
    const { step } = currentStep(player)
    if (!step || step.kind !== 'visit') break
    if (player.townSpot !== step.spot) break
    advance(player)
    moved = true
  }
  return moved
}

export function rankLabel(rank) {
  return RANK_LABEL[rank] ?? rank
}

export function rewardTag(slip) {
  const r = slip.reward ?? {}
  const bits = [`☀️ ${(Number(r.solars) || 0).toLocaleString('en-US')}`, `🌟 ${r.fame ?? 0} fame`]
  if (r.gems) bits.push(`💎 ${r.gems}`)
  return bits.join('  ·  ')
}

function itemCount(player, itemId) {
  return (player.inventory ?? []).filter(id => id === itemId).length
}

function consumeItems(player, itemId, qty) {
  let left = qty
  player.inventory = (player.inventory ?? []).filter(id => {
    if (id === itemId && left > 0) { left -= 1; return false }
    return true
  })
}

export function stepLabel(step) {
  if (!step) return 'Pin the slip.'
  if (step.kind === 'visit') {
    const spot = spotOf(step.spot)
    return `Walk to ${spot?.name ?? step.spot}.`
  }
  if (step.kind === 'talk') {
    const npc = npcOf(step.npc)
    return `Talk to ${npc?.name ?? step.npc}.`
  }
  if (step.kind === 'deliver') {
    const npc = npcOf(step.npc)
    const qty = step.qty ?? 1
    return `Give ${qty} ${step.itemName ?? step.item} to ${npc?.name ?? step.npc}.`
  }
  if (step.kind === 'cull') {
    const where = DUNGEON_NAMES[step.dungeon] ?? step.dungeon
    const what = step.words?.length ? step.words.join(' or ') : 'monsters'
    return `Defeat ${step.count} ${what} in ${where}.`
  }
  return 'Keep going.'
}

export function stepInstruction(step, prefix) {
  if (step.kind === 'visit') {
    const spot = spotOf(step.spot)
    return `Walk to ${spot?.name ?? step.spot}: *${prefix}town ${step.spot}*`
  }
  if (step.kind === 'talk') {
    const npc = npcOf(step.npc)
    const spot = spotOf(npc?.spot)
    return `Go to ${spot?.name ?? 'them'} (*${prefix}town ${npc?.spot}*) and talk to ${npc?.name ?? step.npc}: *${prefix}talk ${step.npc}*`
  }
  if (step.kind === 'deliver') {
    const npc = npcOf(step.npc)
    const qty = step.qty ?? 1
    return `Bring ${qty} ${step.itemName ?? step.item} (*${prefix}shop buy ${step.item}* if you need ${qty === 1 ? 'one' : 'them'}) to ${npc?.name ?? step.npc}, then *${prefix}talk ${step.npc}*`
  }
  if (step.kind === 'cull') {
    const where = DUNGEON_NAMES[step.dungeon] ?? step.dungeon
    const what = step.words?.length ? step.words.join(' or ') : 'whatever is walking there'
    return `Defeat ${step.count} ${what} in ${where}: *${prefix}enter ${step.dungeon}*`
  }
  return stepLabel(step)
}

export function guideText(slip, prefix) {
  const lines = [
    `📜 *${slip.name}*`,
    `_${slip.summary}_`,
    '',
    `*How to finish it*`,
  ]
  slip.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${stepInstruction(step, prefix)}`)
  })
  lines.push(`${slip.steps.length + 1}. Pin it: *${prefix}board turnin*`)
  lines.push('')
  lines.push(`Pay: ${rewardTag(slip)}`)
  lines.push(`_Check the steps any time with *${prefix}board track*._`)
  return lines.join('\n')
}

export function nextHint(player, now = Date.now()) {
  ensureBoardState(player, now)
  const { slip, step } = currentStep(player)
  if (!slip) return null
  if (!step) return `*${slip.name}* is ready to pin.`
  return `${slip.name}: ${stepLabel(step)}`
}

/**
 * Take a posted slip. Returns { ok, reason, slip, matches }.
 * reasons: unknown, many, notposted, level, noguild, busy, cap
 */
export function takeSlip(player, query, now = Date.now()) {
  const state = ensureBoardState(player, now)
  const found = findSlip(query)
  if (!found) return { ok: false, reason: 'unknown' }
  if (Array.isArray(found)) return { ok: false, reason: 'many', matches: found }
  const slip = found
  if (!player.guildId) return { ok: false, reason: 'noguild', slip }
  if (!postedIds(state.day, player.guildId).includes(slip.id)) {
    const other = postedInOtherHall(state.day, player.guildId, slip.id)
    return { ok: false, reason: other ? 'otherhall' : 'notposted', slip }
  }
  if ((player.level ?? 1) < (slip.minLevel ?? 1)) return { ok: false, reason: 'level', slip }
  if (state.turnins >= TURNIN_CAP) return { ok: false, reason: 'cap', slip }
  if (state.doneToday.includes(slip.id)) return { ok: false, reason: 'done', slip }
  if (state.activeId) return { ok: false, reason: 'busy', slip, active: SLIP_BY_ID[state.activeId] }
  state.activeId = slip.id
  state.hallId = player.guildId
  state.step = 0
  state.count = 0
  state.startedAt = now
  advanceVisits(player)
  return { ok: true, slip, ready: ready(player) }
}

export function abandonSlip(player, now = Date.now()) {
  const state = ensureBoardState(player, now)
  if (!state.activeId) return { ok: false, reason: 'none' }
  const slip = SLIP_BY_ID[state.activeId]
  state.activeId = null
  state.step = 0
  state.count = 0
  return { ok: true, slip }
}

/** Call after player.townSpot changes. Completes a waiting visit, maybe several. */
export function noteVisit(player, now = Date.now()) {
  ensureBoardState(player, now)
  const before = player.guildBoard.step
  const moved = advanceVisits(player)
  if (!moved) return { advanced: false, ready: ready(player), line: null }
  const { slip, step } = currentStep(player)
  const line = ready(player)
    ? `📜 *${slip.name}* is ready. Pin it when you can.`
    : `📜 *${slip.name}*: ${stepLabel(step)}`
  return { advanced: player.guildBoard.step > before, ready: ready(player), line }
}

/**
 * Talk to an NPC on the street the player is already standing in.
 * A deliver step consumes the items when the talk lands.
 */
export function noteTalk(player, npcId, now = Date.now()) {
  ensureBoardState(player, now)
  const npc = npcOf(npcId)
  if (!npc) return { ok: false, reason: 'who' }
  if (player.townSpot !== npc.spot) return { ok: false, reason: 'away', npc }

  // Standing where a visit wanted, then talking, counts as arriving.
  if (currentStep(player).step?.kind === 'visit' && player.townSpot === currentStep(player).step.spot) {
    advanceVisits(player)
  }

  const { slip, step } = currentStep(player)
  if (!slip || !step) return { ok: false, reason: 'none', npc }
  if (step.kind !== 'talk' && step.kind !== 'deliver') return { ok: false, reason: 'notnow', npc, step }
  if (step.npc !== npc.id) return { ok: false, reason: 'wrong', npc, step }

  if (step.kind === 'deliver') {
    const qty = step.qty ?? 1
    const have = itemCount(player, step.item)
    if (have < qty) return { ok: false, reason: 'short', npc, step, have, need: qty }
    consumeItems(player, step.item, qty)
  }

  advance(player)
  const nowStep = currentStep(player).step
  return {
    ok: true,
    npc,
    slip,
    line: step.line || `${npc.name} nods. The slip moves.`,
    ready: ready(player),
    next: nowStep ? stepLabel(nowStep) : null,
  }
}

function nameMatches(name, words) {
  if (!words || !words.length) return true
  const n = String(name ?? '').toLowerCase()
  return words.some(w => n.includes(String(w).toLowerCase()))
}

/**
 * A kill the player actually earned. Bosses do not fill a cull.
 * locationId should be the dungeon the fight was in.
 */
export function noteKill(player, enemy, now = Date.now()) {
  if (!player || !enemy) return { counted: false }
  ensureBoardState(player, now)
  const { slip, step } = currentStep(player)
  if (!slip || !step || step.kind !== 'cull') return { counted: false }
  if (enemy.isBoss) return { counted: false }
  if (step.dungeon && enemy.locationId !== step.dungeon) return { counted: false }
  if (!nameMatches(enemy.name, step.words)) return { counted: false }

  const goal = step.count ?? 1
  if ((player.guildBoard.count ?? 0) >= goal) return { counted: false, progress: goal, goal }
  player.guildBoard.count += 1
  const progress = player.guildBoard.count
  let justReady = false
  if (progress >= goal) {
    advance(player)
    justReady = ready(player)
  }
  return {
    counted: true,
    progress: Math.min(progress, goal),
    goal,
    ready: justReady,
    slip,
    line: justReady ? `📜 *${slip.name}* is ready to pin.` : null,
  }
}

export function turnIn(player, now = Date.now()) {
  const state = ensureBoardState(player, now)
  const slip = state.activeId ? SLIP_BY_ID[state.activeId] : null
  if (!slip) return { ok: false, reason: 'none' }
  if (!ready(player)) return { ok: false, reason: 'notready', slip, step: currentStep(player).step }
  if (state.turnins >= TURNIN_CAP) return { ok: false, reason: 'cap', slip }

  const reward = slip.reward ?? {}
  const solars = Math.max(0, Math.floor(Number(reward.solars) || 0))
  const fame = Math.max(0, Math.floor(Number(reward.fame) || 0))
  let gems = Math.max(0, Math.floor(Number(reward.gems) || 0))
  let gemSkipped = false
  if (gems > 0 && (state.gemsToday ?? 0) >= GEM_CAP) {
    gems = 0
    gemSkipped = true
  }

  player.wallet = player.wallet ?? {}
  player.wallet.solars = (player.wallet.solars ?? 0) + solars
  if (gems) player.wallet.gems = Math.round(((player.wallet.gems ?? 0) + gems) * 100) / 100
  if (fame) player.fame = (player.fame ?? 0) + fame

  state.doneToday.push(slip.id)
  state.turnins += 1
  if (gems) state.gemsToday += gems
  state.activeId = null
  state.step = 0
  state.count = 0

  const log = state.log
  log.finished = (log.finished ?? 0) + 1
  log.solars = (log.solars ?? 0) + solars
  log.gems = (log.gems ?? 0) + gems
  log.fame = (log.fame ?? 0) + fame
  log.byId = log.byId ?? {}
  log.byId[slip.id] = (log.byId[slip.id] ?? 0) + 1
  log.last = [{ id: slip.id, name: slip.name, at: now }, ...(log.last ?? [])].slice(0, 8)

  return { ok: true, slip, solars, fame, gems, gemSkipped }
}

export function trackView(player, prefix, now = Date.now()) {
  const state = ensureBoardState(player, now)
  const slip = state.activeId ? SLIP_BY_ID[state.activeId] : null
  if (!slip) {
    return `📜 *No slip in your hand.*\n\n_Take one off the board with *${prefix}board*._`
  }
  const lines = [
    `📜 *TRACKING: ${slip.name.toUpperCase()}*`,
    `_${slip.summary}_`,
    '',
  ]
  slip.steps.forEach((step, i) => {
    const done = state.step > i
    const current = state.step === i
    const mark = done ? '✅' : current ? '▶️' : '⬜'
    let extra = ''
    if (current && step.kind === 'cull') extra = `  _${state.count}/${step.count}_`
    lines.push(`${mark} ${stepLabel(step)}${extra}`)
  })
  if (ready(player)) {
    lines.push('', `🎁 *Ready to pin.* *${prefix}board turnin*`)
  } else {
    lines.push('', `_Next: ${stepLabel(currentStep(player).step)}_`)
    lines.push(`*${prefix}board guide* for the long version.`)
  }
  lines.push(`Turn-ins today: *${state.turnins}/${TURNIN_CAP}*`)
  return lines.join('\n')
}

export function logView(player, prefix, now = Date.now()) {
  const state = ensureBoardState(player, now)
  const log = state.log ?? blankLog()
  const last = (log.last ?? []).slice(0, 5).map(row => `  • ${row.name}`).join('\n')
  const distinct = Object.keys(log.byId ?? {}).length
  return [
    `📜 *GUILD BOARD LOG*`,
    `Slips pinned: *${log.finished ?? 0}*`,
    `Different slips: *${distinct}* of ${SLIPS.length}`,
    `Earned from the board: ☀️ *${(log.solars ?? 0).toLocaleString()}*  ·  🌟 *${log.fame ?? 0}* fame` +
      ((log.gems ?? 0) ? `  ·  💎 *${log.gems}*` : ''),
    '',
    last ? `*Recent*\n${last}` : '_You have not pinned a slip yet._',
    '',
    `Today: *${state.turnins}/${TURNIN_CAP}* pinned.`,
    `*${prefix}board* to see what is nailed up.`,
  ].join('\n')
}

export function closedBoardText(prefix) {
  return (
    `🏰 *The board is for hall members.*\n\n` +
    `_Each hall nails its own three slips at dawn. Another banner does not see yours._\n` +
    `*${prefix}guild*  ·  *${prefix}guild join <name>*`
  )
}

export function boardView(player, prefix, { motd = '', hall = '' } = {}, now = Date.now()) {
  if (!player?.guildId) return closedBoardText(prefix)
  const state = ensureBoardState(player, now)
  const posted = postedSlips(state.day, player.guildId)
  const lines = [
    `📜 *GUILD BOARD*`,
    `_Sera nailed three slips for your hall at dawn. Another hall has a different three. They come down at midnight._`,
  ]
  if (hall) lines.push(`_${hall}_`)
  if (motd) lines.push(`📢 _"${motd}"_`)
  lines.push('')

  posted.forEach((slip, i) => {
    const locked = (player.level ?? 1) < (slip.minLevel ?? 1)
    const done = state.doneToday.includes(slip.id)
    const held = state.activeId === slip.id
    const flag = done ? '☑️' : held ? '✋' : locked ? '🔒' : '📌'
    const lock = locked ? `  _needs level ${slip.minLevel}_` : ''
    lines.push(
      `${flag} *${i + 1}. ${rankLabel(slip.rank)}*  ${slip.name}${lock}`,
      `   _${slip.summary}_`,
      `   ${rewardTag(slip)}  ·  \`${slip.id}\``,
    )
    if (!done && !held && !locked) lines.push(`   *${prefix}board take ${slip.id}*`)
    lines.push('')
  })

  if (state.activeId && SLIP_BY_ID[state.activeId]) {
    const slip = SLIP_BY_ID[state.activeId]
    const step = currentStep(player).step
    lines.push(`*In your hand:* ${slip.name}`)
    lines.push(ready(player) ? `🎁 Ready. *${prefix}board turnin*` : `▶️ ${stepLabel(step)}`)
    if (!ready(player) && step?.kind === 'cull') lines.push(`   _${state.count}/${step.count}_`)
    lines.push(`*${prefix}board track*  ·  *${prefix}board guide*  ·  *${prefix}board abandon*`)
  } else if (state.turnins >= TURNIN_CAP) {
    lines.push(`_You have pinned ${TURNIN_CAP} slips today. The hall is done with you until midnight._`)
  } else {
    lines.push(`_One slip at a time. *${prefix}board take <id>*_`)
  }
  lines.push(`Pinned today: *${state.turnins}/${TURNIN_CAP}*`)
  return lines.join('\n')
}

export function readyLine(prefix) {
  return `📜 *Guild slip ready.* Pin it with *${prefix}board turnin*.`
}
