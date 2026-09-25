/**
 * pokegame-sim.js — one live Pokémon Showdown battle per player.
 *
 * The server owns the battle. The app only ever sends a CHOICE ("use move 2",
 * "switch to slot 3", "throw a Great Ball") and gets back structured EVENTS to
 * animate plus a SNAPSHOT of the state to draw. The app never reports damage or
 * results, so a modified app cannot fake a win.
 *
 * Sessions live in memory (one per player, dropped after SESSION_IDLE_MS). A
 * restart ends in-flight battles; nothing is lost because HP/EXP/items are only
 * written when a battle ends or an item is spent.
 *
 * Showdown has no bag, so items and Poké Balls spend the player's turn by
 * having the active Pokémon "use" a hidden Splash while the item effect is
 * applied directly. The Splash lines are filtered out of the event stream.
 */
import { createRequire } from 'module'
import * as G from './pokegame-data.js'

const require = createRequire(import.meta.url)
const { Battle } = require('pokemon-showdown')
const { extractChannelMessages } = require('pokemon-showdown/dist/sim/battle')
const { Dex } = G

const FORMAT = 'gen9customgame@@@!team preview'
const PLAYER_NAME = 'You'

const sessions = new Map() // jid -> session

export const getSession = jid => sessions.get(jid) ?? null
export const dropSession = jid => sessions.delete(jid)

setInterval(() => {
  const cutoff = Date.now() - G.CONST.SESSION_IDLE_MS
  for (const [jid, s] of sessions) if (s.lastActive < cutoff) sessions.delete(jid)
}, 5 * 60_000).unref()

/* ── small helpers ─────────────────────────────────────────────────────────── */

const monName = m => m.nickname || m.name
const rand = arr => arr[Math.floor(Math.random() * arr.length)]

function parseIdent(ident) {
  const m = /^(p[12])[a-c]?: (.+)$/.exec(ident ?? '')
  if (!m) return { side: null, slot: null }
  const n = Number(m[2].slice(1))
  return { side: m[1], slot: Number.isFinite(n) ? n : null }
}

function parseHp(str) {
  const [hpPart, status] = String(str ?? '').split(' ')
  if (hpPart === '0') return { cur: 0, max: null, status: status === 'fnt' ? null : status ?? null, fainted: true }
  const [cur, max] = hpPart.split('/').map(Number)
  return { cur, max, status: status ?? null, fainted: false }
}

function speciesFromDetails(details) {
  const name = String(details ?? '').split(',')[0]
  const sp = Dex.species.get(name)
  const dexId = sp.exists ? sp.num : 0
  return { name, dexId, spriteDex: G.spriteDexFor(name, dexId), shiny: /, shiny/.test(details ?? '') }
}

const STAT_LABEL = { atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness' }
const STATUS_LABEL = { par: 'paralyzed', slp: 'fell asleep', brn: 'was burned', psn: 'was poisoned', tox: 'was badly poisoned', frz: 'was frozen solid' }

/* ── protocol lines -> structured events ───────────────────────────────────── */

function toEvents(session, lines) {
  const out = []
  const who = (side, slot) => {
    const mons = side === 'p1' ? session.playerMons : session.foeMons
    const m = mons[slot]
    return m ? monName(m) : 'The Pokémon'
  }
  const owner = side => (side === 'p1' ? '' : session.kind === 'wild' ? 'The wild ' : `${session.foeName}'s `)
  const label = (side, slot) => `${owner(side)}${who(side, slot)}`

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) continue
    if (/\|move: Splash|\|Splash\||^\|-nothing/.test(line) && session.hideSplash) continue
    const parts = line.split('|')
    const cmd = parts[1]
    const A = parts.slice(2)
    const tags = A.filter(x => x.startsWith('[')).join(' ')
    switch (cmd) {
      case 'switch': case 'drag': {
        const { side, slot } = parseIdent(A[0])
        const hp = parseHp(A[2])
        const det = speciesFromDetails(A[1])
        const isMe = side === 'p1'
        if (isMe && slot != null) session.participants.add(slot)
        out.push({
          t: 'switch', side, slot, species: det.name, dexId: det.dexId, spriteDex: det.spriteDex, shiny: det.shiny,
          hp: isMe ? { cur: hp.cur, max: hp.max } : null, hpPct: hp.max ? Math.round((hp.cur / hp.max) * 100) : null,
          status: hp.status, text: isMe ? `Go! ${who(side, slot)}!` : `${session.kind === 'wild' ? 'A wild' : session.foeName + ' sent out'} ${who(side, slot)}${session.kind === 'wild' ? ' appeared!' : '!'}`,
        })
        break
      }
      case 'move': {
        const { side, slot } = parseIdent(A[0])
        const mv = Dex.moves.get(A[1])
        const tgt = parseIdent(A[2])
        out.push({
          t: 'move', side, slot, move: A[1], moveId: mv.id, type: mv.type, category: mv.category,
          targetSide: tgt.side, miss: /\[miss\]/.test(tags),
          text: `${label(side, slot)} used ${A[1]}!`,
        })
        break
      }
      case 'cant': {
        const { side, slot } = parseIdent(A[0])
        const why = { par: 'is paralyzed! It can\'t move!', slp: 'is fast asleep.', frz: 'is frozen solid!', flinch: 'flinched!', recharge: 'must recharge!' }[A[1]] ?? "can't move!"
        out.push({ t: 'cant', side, slot, reason: A[1], text: `${label(side, slot)} ${why}` })
        break
      }
      case '-damage': case '-heal': {
        const { side, slot } = parseIdent(A[0])
        const hp = parseHp(A[1])
        const src = (A.find(x => x.startsWith('[from]')) ?? '').replace('[from] ', '')
        const heal = cmd === '-heal'
        out.push({
          t: heal ? 'heal' : 'damage', side, slot, from: src || null,
          hp: side === 'p1' ? { cur: hp.cur, max: hp.max ?? session.lastMax?.[slot] ?? null } : null,
          hpPct: hp.max ? Math.round((hp.cur / hp.max) * 100) : hp.cur === 0 ? 0 : null,
          status: hp.status,
          text: src ? `${label(side, slot)} ${heal ? 'restored HP' : 'was hurt'} (${src.replace(/^item: |^ability: /, '')}).` : '',
        })
        break
      }
      case 'faint': {
        const { side, slot } = parseIdent(A[0])
        if (side === 'p2' && slot != null) session.foeFainted.add(slot)
        out.push({ t: 'faint', side, slot, text: `${label(side, slot)} fainted!` })
        break
      }
      case '-supereffective': out.push({ t: 'effect', kind: 'super', text: "It's super effective!" }); break
      case '-resisted': out.push({ t: 'effect', kind: 'resisted', text: "It's not very effective..." }); break
      case '-immune': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'effect', kind: 'immune', text: `It doesn't affect ${label(side, slot)}...` })
        break
      }
      case '-crit': out.push({ t: 'effect', kind: 'crit', text: 'A critical hit!' }); break
      case '-miss': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'effect', kind: 'miss', text: `${label(side, slot)} avoided the attack!` })
        break
      }
      case '-fail': out.push({ t: 'effect', kind: 'fail', text: 'But it failed!' }); break
      case '-status': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'status', side, slot, status: A[1], text: `${label(side, slot)} ${STATUS_LABEL[A[1]] ?? 'has a status'}!` })
        break
      }
      case '-curestatus': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'cure', side, slot, status: A[1], text: `${label(side, slot)} is cured!` })
        break
      }
      case '-boost': case '-unboost': {
        const { side, slot } = parseIdent(A[0])
        const n = Number(A[2]) * (cmd === '-unboost' ? -1 : 1)
        const word = Math.abs(n) >= 3 ? 'drastically ' : Math.abs(n) === 2 ? 'sharply ' : ''
        out.push({ t: 'boost', side, slot, stat: A[1], amount: n, text: `${label(side, slot)}'s ${STAT_LABEL[A[1]] ?? A[1]} ${word}${n > 0 ? 'rose' : 'fell'}!` })
        break
      }
      case '-weather': out.push({ t: 'weather', weather: A[0], text: A[0] === 'none' ? 'The weather cleared.' : `Weather: ${A[0]}.` }); break
      case '-fieldstart': out.push({ t: 'field', field: A[0].replace('move: ', ''), on: true, text: `${A[0].replace('move: ', '')} began.` }); break
      case '-fieldend': out.push({ t: 'field', field: A[0].replace('move: ', ''), on: false, text: `${A[0].replace('move: ', '')} ended.` }); break
      case '-mega': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'mega', side, slot, stone: A[2] ?? null, text: `${label(side, slot)} Mega Evolved!` })
        break
      }
      case 'detailschange': case '-formechange': {
        const { side, slot } = parseIdent(A[0])
        const det = speciesFromDetails(A[1])
        out.push({ t: 'form', side, slot, species: det.name, dexId: det.dexId, spriteDex: det.spriteDex, text: '' })
        break
      }
      case '-ability': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'ability', side, slot, ability: A[1], text: `${label(side, slot)}'s ${A[1]}!` })
        break
      }
      case '-item': case '-enditem': {
        const { side, slot } = parseIdent(A[0])
        out.push({ t: 'item', side, slot, item: A[1], text: cmd === '-enditem' ? `${label(side, slot)}'s ${A[1]} was used up.` : `${label(side, slot)} has ${A[1]}.` })
        break
      }
      case '-start': case '-end': case '-activate': case '-sidestart': case '-sideend': {
        const { side, slot } = parseIdent(A[0])
        const what = String(A[1] ?? '').replace(/^(move|ability|item): /, '')
        if (what && !/^(Splash|typechange)$/i.test(what)) out.push({ t: 'note', side, slot, text: `${side && slot != null ? label(side, slot) + ': ' : ''}${what}` })
        break
      }
      case '-hitcount': out.push({ t: 'effect', kind: 'hits', count: Number(A[1]), text: `Hit ${A[1]} time(s)!` }); break
      case 'turn': out.push({ t: 'turn', n: Number(A[0]), text: '' }); break
      case 'win': out.push({ t: 'end', winner: A[0] === PLAYER_NAME ? 'you' : 'foe', text: '' }); break
      case 'tie': out.push({ t: 'end', winner: 'tie', text: '' }); break
      default: break
    }
  }
  return out
}

/* ── flushing Showdown's output ────────────────────────────────────────────── */

function flush(session) {
  const b = session.battle
  b.sendUpdates()
  const raw = session.pending.join('\n')
  session.pending.length = 0
  if (!raw) return []
  const lines = extractChannelMessages(raw, [1])[1] // player 1's view: hides the foe's secret info
  return toEvents(session, lines)
}

/* ── foe AI ────────────────────────────────────────────────────────────────── */

function effectiveness(moveType, defTypes) {
  if (!Dex.getImmunity(moveType, defTypes)) return 0
  let e = 0
  for (const t of defTypes) e += Dex.getEffectiveness(moveType, t)
  return 2 ** e
}

function foeChoice(session) {
  const b = session.battle
  const side = b.sides[1]
  const req = side.activeRequest
  if (!req || req.wait) return null
  if (req.forceSwitch) {
    const idx = req.side.pokemon.findIndex(p => !p.active && !/ fnt$/.test(p.condition))
    return idx >= 0 ? `switch ${idx + 1}` : null
  }
  const me = b.sides[0].active[0]
  const mine = side.active[0]
  const moves = (req.active?.[0]?.moves ?? []).map((m, i) => ({ ...m, i })).filter(m => !m.disabled && m.pp !== 0)
  if (!moves.length) return 'move 1'
  const scored = moves.map(m => {
    const mv = Dex.moves.get(m.id)
    if (mv.category === 'Status') return { m, score: mine && mine.hp / mine.maxhp < 0.35 ? 8 : 22 }
    const eff = me ? effectiveness(mv.type, me.getTypes()) : 1
    const stab = mine?.getTypes().includes(mv.type) ? 1.5 : 1
    const acc = mv.accuracy === true ? 1 : mv.accuracy / 100
    return { m, score: (mv.basePower || 40) * eff * stab * acc }
  })
  scored.sort((a, b2) => b2.score - a.score)
  // Mostly the best move, sometimes not, so wild Pokémon don't feel like a script.
  const pick = Math.random() < 0.72 ? scored[0] : rand(scored.slice(0, Math.min(3, scored.length)))
  return `move ${pick.m.i + 1}`
}

/** Let the foe settle any forced switch it owes (its Pokémon fainted) without waiting on the player. */
function settleFoe(session) {
  for (let n = 0; n < 4 && !session.battle.ended; n++) {
    const req = session.battle.sides[1].activeRequest
    if (!req?.forceSwitch) return
    const ch = foeChoice(session)
    if (!ch) return
    if (!session.battle.choose('p2', ch)) return
  }
}

/* ── starting a battle ─────────────────────────────────────────────────────── */

/**
 * @param {{jid:string, kind:'wild'|'tower', playerMons:object[], foeMons:object[], foeName:string, meta?:object}} o
 * playerMons/foeMons are owned-shape Pokémon (player.pokemon[] entries / buildFoe()).
 * playerMons must all be alive (currentHp > 0); the first entry leads.
 */
export function startBattle({ jid, kind, playerMons, foeMons, foeName, meta = {} }) {
  const session = {
    id: `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    jid, kind, meta, foeName, playerMons, foeMons,
    createdAt: Date.now(), lastActive: Date.now(),
    pending: [], participants: new Set(), foeFainted: new Set(),
    hideSplash: false, runAttempts: 0, busy: false,
    ended: false, result: null, caught: null, lastError: null, lastMax: {},
  }
  const battle = new Battle({
    formatid: FORMAT,
    send: (type, data) => {
      const text = Array.isArray(data) ? data.join('\n') : String(data)
      if (type === 'update') session.pending.push(text)
      else if (type === 'sideupdate' && text.includes('|error|')) session.lastError = text.split('|error|')[1]
    },
  })
  battle.setPlayer('p1', { name: PLAYER_NAME, team: G.packTeam(playerMons.map((m, i) => G.toPsSet(m, `m${i}`))) })
  battle.setPlayer('p2', { name: foeName, team: G.packTeam(foeMons.map((m, i) => G.toPsSet(m, `f${i}`))) })
  session.battle = battle

  // Carry each Pokémon's saved HP into the fight (a fraction bridges the bot's HP scale to Showdown's).
  // Fainted Pokémon never enter a battle, so every team member here has HP left.
  playerMons.forEach((m, i) => {
    const p = battle.sides[0].pokemon.find(x => x.name === `m${i}`)
    if (!p) return
    p.hp = Math.max(1, Math.round(p.maxhp * G.hpFraction(m)))
    session.lastMax[i] = p.maxhp
  })

  const events = flush(session)
  sessions.set(jid, session)
  return { session, events }
}

/* ── reading state for the app ─────────────────────────────────────────────── */

function pokeState(p, mons, tagPrefix) {
  const slot = Number(p.name.slice(1))
  const owned = mons[slot]
  return {
    slot, monId: owned?.id ?? null,
    name: owned ? monName(owned) : p.species.name,
    species: p.species.name, dexId: G.speciesForMon(owned ?? { name: p.species.name }).num, spriteDex: G.spriteDexFor(p.species.name, G.speciesForMon(owned ?? { name: p.species.name }).num),
    level: p.level, shiny: !!p.set.shiny,
    hp: p.hp, maxHp: p.maxhp, status: p.status || null, fainted: p.hp <= 0,
    active: p.isActive, types: p.getTypes(), item: p.item || null, ability: p.ability || null,
    boosts: Object.fromEntries(Object.entries(p.boosts).filter(([, v]) => v)),
  }
}

export function snapshot(session) {
  const b = session.battle
  const me = b.sides[0], foe = b.sides[1]
  const req = me.activeRequest
  const active = me.active[0]
  const fActive = foe.active[0]
  const awaiting = session.ended || b.ended ? 'end' : req?.forceSwitch ? 'switch' : req?.wait ? 'wait' : 'move'

  let moves = []
  if (awaiting === 'move' && req?.active?.[0]) {
    const foeTypes = fActive ? fActive.getTypes() : []
    const myTypes = active ? active.getTypes() : []
    moves = req.active[0].moves.filter(m => m.id !== 'splash' || active.baseMoves.includes('splash')).map((m, i) => {
      const info = G.moveInfo(m.id) ?? { id: m.id, name: m.move, type: 'Normal', category: 'Status', power: null, accuracy: null, pp: m.maxpp, desc: '' }
      const dmg = info.category !== 'Status'
      return {
        index: i + 1, ...info, pp: m.pp ?? info.pp, maxPp: m.maxpp ?? info.pp, disabled: !!m.disabled,
        effectiveness: dmg && foeTypes.length ? effectiveness(info.type, foeTypes) : null,
        stab: dmg && myTypes.includes(info.type),
      }
    })
  }

  const team = me.pokemon.map(p => pokeState(p, session.playerMons)).sort((a, c) => a.slot - c.slot)
  const foeSt = fActive ? pokeState(fActive, session.foeMons) : null
  const foeView = foeSt && {
    slot: foeSt.slot, name: foeSt.name, species: foeSt.species, dexId: foeSt.dexId, level: foeSt.level, shiny: foeSt.shiny,
    hpPct: Math.round((fActive.hp / fActive.maxhp) * 100), status: foeSt.status, fainted: foeSt.fainted,
    types: foeSt.types, boosts: foeSt.boosts,
  }
  const alive = foe.pokemon.filter(p => p.hp > 0).length

  return {
    id: session.id, kind: session.kind, foeName: session.foeName, meta: session.meta, turn: b.turn,
    awaiting, ended: session.ended || b.ended, result: session.result,
    weather: b.field.weather || null, terrain: b.field.terrain || null,
    you: {
      active: active ? { ...pokeState(active, session.playerMons), moves, canMega: !!req?.active?.[0]?.canMegaEvo, trapped: !!req?.active?.[0]?.trapped, bagLocked: awaiting === 'move' && !canSpend(session) } : null,
      team,
      canSwitch: awaiting !== 'end' && team.some(t => !t.active && !t.fainted),
    },
    foe: { active: foeView, remaining: alive, total: session.foeMons.length },
    canRun: session.kind === 'wild' && awaiting === 'move',
    canCatch: session.kind === 'wild' && awaiting === 'move',
    catchOdds: session.kind === 'wild' && fActive && fActive.hp > 0
      ? Math.round(G.catchOdds({ sp: fActive.species, hp: fActive.hp, maxhp: fActive.maxhp, status: fActive.status, ballId: 'poke_ball' }).chance * 100)
      : null,
  }
}

/* ── acting ────────────────────────────────────────────────────────────────── */

const LOCKED_MSG = session => `${monName(session.playerMons[Number(session.battle.sides[0].active[0].name.slice(1))])} is locked into its move. Use a move this turn.`

const SPLASH_SLOT = () => ({ move: 'Splash', id: 'splash', pp: 1, maxpp: 1, target: 'self', disabled: false, disabledSource: '', used: false })

/**
 * True if the active Pokémon can take a "do nothing" turn right now. A Choice lock
 * only restricts MOVES in the real games, never the bag, so it is set aside for the check.
 */
function canSpend(session) {
  const a = session.battle.sides[0].active[0]
  if (!a) return false
  const lock = a.volatiles.choicelock
  if (lock) delete a.volatiles.choicelock
  a.moveSlots.push(SPLASH_SLOT())
  let ok = false
  try { ok = a.getMoveRequestData().moves.some(m => m.id === 'splash' && !m.disabled) } finally {
    a.moveSlots = a.moveSlots.filter(m => m.id !== 'splash')
    if (lock) a.volatiles.choicelock = lock
  }
  return ok
}

/** Spend the player's turn doing nothing (an item/ball/failed run), so the foe still acts. */
function spendTurn(session) {
  const b = session.battle
  const a = b.sides[0].active[0]
  session.savedLock = a.volatiles.choicelock ?? null
  session.savedLast = { lastMove: a.lastMove, lastMoveUsed: a.lastMoveUsed }
  if (session.savedLock) delete a.volatiles.choicelock
  a.moveSlots.push(SPLASH_SLOT())
  session.hideSplash = true
  const ok = b.choose('p1', 'move splash')
  return ok
}

function cleanupSplash(session) {
  const a = session.battle.sides[0].active[0]
  if (a) {
    a.moveSlots = a.moveSlots.filter(m => m.id !== 'splash')
    // Splash must never leave a Choice item locked into it: drop any lock it created, restore the real one.
    if (a.volatiles?.choicelock) delete a.volatiles.choicelock
    if (session.savedLock) a.volatiles.choicelock = session.savedLock
  }
  session.savedLock = null
  if (a) {
    // Put back the real "last move used" (Choice items and Encore-type effects depend on it).
    if (session.savedLast) { a.lastMove = session.savedLast.lastMove; a.lastMoveUsed = session.savedLast.lastMoveUsed }
    session.savedLast = null
    // The next turn's disabled-move flags and request were built while Splash's temporary state was in
    // place (it briefly replaced any Choice lock). Recompute them from the restored real state.
    const bt = session.battle
    if (!bt.ended && bt.requestState === 'move' && a.hp > 0) {
      for (const ms of a.moveSlots) { ms.disabled = false; ms.disabledSource = '' }
      bt.runEvent('DisableMove', a)
      for (const ms of a.moveSlots) {
        const am = bt.dex.getActiveMove(ms.id)
        bt.singleEvent('DisableMove', am, null, a)
        if (am.flags['cantusetwice'] && a.lastMove?.id === ms.id) a.disableMove(a.lastMove.id)
      }
      bt.makeRequest()
    }
  }
  session.hideSplash = false
}

function finishIfOver(session) {
  const b = session.battle
  if (!b.ended || session.ended) return
  session.ended = true
  session.result = b.winner === PLAYER_NAME ? 'won' : b.winner ? 'lost' : 'tie'
}

function commitFoe(session) {
  const ch = foeChoice(session)
  if (ch) session.battle.choose('p2', ch)
}

/**
 * Apply one player action. Returns { events, error?, consumed?, ended }.
 * `consumed` names a bag item that was spent (the route deducts it).
 */
export function act(session, action) {
  const b = session.battle
  const me = b.sides[0]
  session.lastActive = Date.now()
  session.lastError = null
  if (session.ended) return { error: 'This battle is over.' }

  const req = me.activeRequest
  const type = action?.action
  const events = []
  let consumed = null

  const done = () => {
    settleFoe(session)
    events.push(...flush(session))
    finishIfOver(session)
    return { events, consumed, ended: session.ended }
  }

  /* run */
  if (type === 'run') {
    if (session.kind !== 'wild') return { error: "You can't run from a trainer battle!" }
    if (req?.forceSwitch) return { error: 'Choose a Pokémon first.' }
    if (!canSpend(session)) return { error: LOCKED_MSG(session) }
    session.runAttempts++
    const mySpe = me.active[0].storedStats.spe
    const foeSpe = b.sides[1].active[0].storedStats.spe
    if (G.runSucceeds(mySpe, foeSpe, session.runAttempts - 1)) {
      session.ended = true; session.result = 'fled'
      return { events: [{ t: 'run', ok: true, text: 'Got away safely!' }, { t: 'end', winner: 'fled', text: '' }], consumed, ended: true }
    }
    events.push({ t: 'run', ok: false, text: "Can't escape!" })
    if (!spendTurn(session)) return { error: session.lastError ?? 'Could not run.' }
    commitFoe(session)
    const r = done(); cleanupSplash(session); return r
  }

  /* switch */
  if (type === 'switch') {
    const slot = Number(action.slot)
    const idx = req?.side?.pokemon?.findIndex(p => p.ident === `p1: m${slot}`)
    if (idx == null || idx < 0) return { error: 'No such Pokémon.' }
    if (!req?.forceSwitch && req?.active?.[0]?.trapped) return { error: "It can't be switched out!" }
    if (!b.choose('p1', `switch ${idx + 1}`)) return { error: session.lastError ?? 'You cannot switch to that Pokémon.' }
    if (!req?.forceSwitch) commitFoe(session)
    return done()
  }

  /* everything below needs a normal turn */
  if (req?.forceSwitch) return { error: 'Choose a Pokémon to send out first.' }
  if (req?.wait || !req?.active) return { error: 'Waiting for the opponent.' }

  /* move */
  if (type === 'move') {
    const index = Number(action.index)
    const m = req.active[0].moves[index - 1]
    if (!m) return { error: 'No such move.' }
    if (m.disabled || m.pp === 0) return { error: `${m.move} can't be used right now.` }
    const cmd = `move ${index}${action.mega && req.active[0].canMegaEvo ? ' mega' : ''}`
    if (!b.choose('p1', cmd)) return { error: session.lastError ?? 'Invalid move.' }
    commitFoe(session)
    return done()
  }

  /* bag item */
  if (type === 'item') {
    const itemId = String(action.itemId ?? '')
    const fx = G.ITEM_FX[itemId]
    if (!fx || fx.revivePct) return { error: "That can't be used in battle." }
    const slot = action.slot == null ? Number(me.active[0].name.slice(1)) : Number(action.slot)
    const mon = me.pokemon.find(p => p.name === `m${slot}`)
    if (!mon) return { error: 'No such Pokémon.' }
    const item = G.POKE_ITEM_MAP.get(itemId)
    const nm = item?.name ?? itemId
    const label = monName(session.playerMons[slot])
    const ev = { t: 'bagitem', itemId, name: nm, slot, text: `You used ${nm} on ${label}.` }

    let apply
    if (fx.heal || fx.healPct) {
      if (mon.hp <= 0) return { error: `${label} has fainted.` }
      if (mon.hp >= mon.maxhp) return { error: `${label}'s HP is already full.` }
      const amount = fx.heal ?? Math.ceil((mon.maxhp * fx.healPct) / 100)
      apply = () => { mon.heal(amount); b.add('-heal', mon, mon.getHealth, `[from] item: ${nm}`) }
    } else if (fx.cure) {
      if (mon.hp <= 0) return { error: `${label} has fainted.` }
      const list = fx.cure === 'all' ? null : fx.cure
      if (!mon.status || (list && !list.includes(mon.status))) return { error: 'It would have no effect.' }
      apply = () => mon.cureStatus()
    } else if (fx.boost) {
      if (!mon.isActive || mon.hp <= 0) return { error: 'It can only be used on the Pokémon in battle.' }
      const stats = Object.keys(fx.boost)
      if (stats.every(st => (mon.boosts[st] ?? 0) >= 6)) return { error: "It won't have any effect." }
      apply = () => {
        for (const st of stats) {
          const nv = Math.min(6, (mon.boosts[st] ?? 0) + fx.boost[st])
          const gain = nv - (mon.boosts[st] ?? 0)
          if (gain > 0) { mon.boosts[st] = nv; b.add('-boost', mon, st, gain) }
        }
      }
    }
    // Only now that the item is valid: make sure the turn can be spent, THEN apply it (no free effects).
    if (!canSpend(session)) return { error: LOCKED_MSG(session) }
    if (!spendTurn(session)) { cleanupSplash(session); return { error: session.lastError ?? 'Could not use that.' } }
    events.push(ev)
    apply()
    consumed = itemId
    commitFoe(session)
    const r = done(); cleanupSplash(session); return r
  }

  /* Poké Ball */
  if (type === 'catch') {
    if (session.kind !== 'wild') return { error: "You can't catch another trainer's Pokémon!" }
    const ballId = String(action.itemId ?? 'poke_ball')
    if (!(ballId in G.BALL_MULT)) return { error: "That isn't a Poké Ball." }
    const foe = b.sides[1].active[0]
    if (!foe || foe.hp <= 0) return { error: 'There is nothing to catch.' }
    if (!canSpend(session)) return { error: LOCKED_MSG(session) }
    const odds = G.catchOdds({ sp: foe.species, hp: foe.hp, maxhp: foe.maxhp, status: foe.status, ballId })
    const roll = G.rollCatch(odds)
    consumed = ballId
    const ballName = G.POKE_ITEM_MAP.get(ballId)?.name ?? 'Poké Ball'
    events.push({ t: 'ball', ball: ballId, name: ballName, shakes: roll.shakes, caught: roll.caught, text: `You threw a ${ballName}!` })
    if (roll.caught) {
      session.ended = true; session.result = 'caught'
      session.caught = session.foeMons[Number(foe.name.slice(1))]
      events.push({ t: 'end', winner: 'caught', text: `Gotcha! ${monName(session.caught)} was caught!` })
      return { events, consumed, ended: true }
    }
    events.push({ t: 'effect', kind: 'escaped', text: `Oh no! ${monName(session.foeMons[Number(foe.name.slice(1))])} broke free!` })
    if (!spendTurn(session)) return { error: session.lastError ?? 'Could not throw.' }
    commitFoe(session)
    const r = done(); cleanupSplash(session); return r
  }

  return { error: 'Unknown action.' }
}

/** What happened to each Pokémon of yours, for writing results back to the save. */
export function outcome(session) {
  const b = session.battle
  const mine = b.sides[0].pokemon.map(p => ({ slot: Number(p.name.slice(1)), hp: p.hp, maxHp: p.maxhp, fainted: p.hp <= 0 }))
  return {
    result: session.result,
    mine,
    participants: [...session.participants],
    foesDefeated: [...session.foeFainted].map(i => session.foeMons[i]),
    caught: session.caught,
    turns: b.turn,
  }
}
