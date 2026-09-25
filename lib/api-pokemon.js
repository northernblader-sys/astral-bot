/**
 * api-pokemon.js — the Pokémon game API for the Android app (/api/pokemon/*).
 *
 * Registered from lib/api-server.js. Everything here is server-authoritative:
 * battles run on Pokémon Showdown inside this process (lib/pokegame-sim.js) and
 * every write goes through updatePlayer, like every other route.
 *
 * STORAGE
 *   player.pokemon[]        the shared collection (same records `.p-poke` uses, so a Pokémon
 *                           caught in the app shows up in WhatsApp and the reverse)
 *   player.battlePartyIds   shared party (max 6), player.mainPokemonId shared main
 *   player.pokemonGame      the app's OWN storage:
 *       bag   { itemId: qty }   its own bag — the shared inventory only holds 30 items
 *       dex   { seen, caught }  Pokédex progress
 *       stats { hunts, wins, losses, caught, fled, shiny }
 *   HP is stored as the bot always did (currentHp / maxHp); battles use Showdown's real HP,
 *   so HP crosses between the two scales as a FRACTION (see pokegame-data.hpFraction).
 *
 * JSON stat keys are Showdown's: hp, atk, def, spa, spd, spe (spd = Special Defense here).
 */
import * as G from './pokegame-data.js'
import * as S from './pokegame-sim.js'
import { ensurePokemonExtendedFields, basePokemonHp } from './pokemon-engine.js'
import { checkEvolution, findItemEvolution, applyEvolution, runLevelUpEvolutionCheck } from './pokemon-evolution.js'
import { allMasters, getMaster, masterCount, nextStageFor, applyTowerReward } from './poke-tower.js'
import { recordQuestEvent } from './quest-engine.js'
import { getPlayer } from './player-repo.js'

const { Dex } = G
const round2 = n => Math.round(n * 100) / 100
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

export const STARTERS = [
  1, 4, 7, 25, 133, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501,
  650, 653, 656, 722, 725, 728, 810, 813, 816, 906, 909, 912,
]
const STARTER_GIFT = { poke_ball: 5, poke_super_potion: 2 }
const SHOP_CATS = [
  ['ball', 'Poké Balls'], ['battle', 'Medicine & Battle Items'], ['revive', 'Revives'],
  ['evolution', 'Evolution Stones'], ['held', 'Held Items & Mega Stones'],
]

/* ── player-state helpers ──────────────────────────────────────────────────── */

/** Read-only view of the app's storage block (never mutates the player). */
function readGame(p) {
  const g = p.pokemonGame ?? {}
  return {
    bag: g.bag ?? {},
    dex: { seen: g.dex?.seen ?? {}, caught: g.dex?.caught ?? {} },
    stats: { hunts: 0, wins: 0, losses: 0, caught: 0, fled: 0, shiny: 0, ...(g.stats ?? {}) },
  }
}

/** Writable block: only call inside an updatePlayer mutator. */
function ensureGame(p) {
  p.pokemonGame ??= {}
  const g = p.pokemonGame
  g.v ??= 1
  g.bag ??= {}
  g.dex ??= { seen: {}, caught: {} }
  g.dex.seen ??= {}
  g.dex.caught ??= {}
  g.stats ??= {}
  for (const k of ['hunts', 'wins', 'losses', 'caught', 'fled', 'shiny']) g.stats[k] ??= 0
  return g
}

const ownedMon = (p, id) => (p.pokemon ?? []).find(m => m.id === id) ?? null
const bagQty = (p, id) => num(p.pokemonGame?.bag?.[id])
const wallet = p => ({ solars: p.wallet?.solars ?? 0, gems: p.wallet?.gems ?? 0 })

function partyIds(p) {
  const owned = new Set((p.pokemon ?? []).map(m => m.id))
  const ids = (Array.isArray(p.battlePartyIds) ? p.battlePartyIds : []).filter(id => owned.has(id))
  if (ids.length) return [...new Set(ids)].slice(0, G.CONST.PARTY_MAX)
  if (p.mainPokemonId && owned.has(p.mainPokemonId)) return [p.mainPokemonId]
  return []
}

function bagAdd(g, id, n) { g.bag[id] = clamp(num(g.bag[id]) + n, 0, G.CONST.BAG_STACK_MAX); if (!g.bag[id]) delete g.bag[id] }
function bagTake(g, id, n) {
  if (num(g.bag[id]) < n) return false
  g.bag[id] -= n
  if (g.bag[id] <= 0) delete g.bag[id]
  return true
}

/** Charges a wallet in either currency. Returns false (and changes nothing) if it can't be afforded. */
function charge(p, currency, amount) {
  p.wallet ??= {}
  const have = num(p.wallet[currency])
  if (have < amount) return false
  p.wallet[currency] = currency === 'gems' ? round2(have - amount) : have - amount
  return true
}
function pay(p, currency, amount) {
  p.wallet ??= {}
  p.wallet[currency] = currency === 'gems' ? round2(num(p.wallet[currency]) + amount) : num(p.wallet[currency]) + amount
}

/* ── views ─────────────────────────────────────────────────────────────────── */

function describeItem(id, it) {
  const fx = G.ITEM_FX[id]
  if (!fx) return it?.description ?? ''
  if (fx.heal) return `Restores ${fx.heal} HP to one Pokémon.`
  if (fx.healPct) return fx.healPct >= 100 ? 'Fully restores one Pokémon\'s HP.' : `Restores ${fx.healPct}% of one Pokémon's HP.`
  if (fx.cure) return fx.cure === 'all' ? 'Cures any status condition.' : `Cures ${fx.cure.includes('psn') ? 'poison' : fx.cure.includes('brn') ? 'burns' : fx.cure.includes('frz') ? 'freezing' : 'paralysis'}.`
  if (fx.boost) return `Raises ${Object.keys(fx.boost).map(s => ({ atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' })[s]).join(', ')} in battle.`
  if (fx.revivePct) return fx.revivePct >= 100 ? 'Revives a fainted Pokémon with full HP.' : 'Revives a fainted Pokémon with half its HP.'
  return it?.description ?? ''
}

function itemView(id, qty) {
  const it = G.POKE_ITEM_MAP.get(id)
  return {
    id, name: it?.name ?? id, category: it?.category ?? 'misc', rarity: it?.rarity ?? 'common',
    currency: it?.currency ?? 'solars', buyPrice: it?.buyPrice ?? 0, sellPrice: it?.sellPrice ?? 0,
    description: describeItem(id, it), iconUrl: G.itemIconUrl(id),
    ball: id in G.BALL_MULT, mega: !!it?.megaStone,
    usableInBattle: G.inBattleUsable(id), usableOutside: G.outOfBattleUsable(id),
    ...(qty != null ? { qty } : {}),
  }
}

function monView(p, mon, { detail = false } = {}) {
  ensurePokemonExtendedFields(mon)
  const sp = G.speciesForMon(mon)
  const st = G.realStats(mon)
  const hp = mon.currentHp <= 0 ? 0 : Math.max(1, Math.round(st.hp * G.hpFraction(mon)))
  const party = partyIds(p)
  const base = {
    id: mon.id, dexId: sp.num, name: sp.name, nickname: mon.nickname ?? null,
    level: mon.level, exp: mon.exp ?? 0, expNext: (mon.level ?? 5) * 100,
    shiny: !!mon.shiny, protected: !!mon.protected,
    main: p.mainPokemonId === mon.id, inParty: party.includes(mon.id), partySlot: party.indexOf(mon.id),
    types: sp.types, hp, maxHp: st.hp, fainted: hp <= 0,
    held: mon.heldItem ? itemView(mon.heldItem) : null,
    caughtAt: mon.caughtAt ?? null,
  }
  if (!detail) return base
  const nat = Dex.natures.get(String(mon.nature ?? 'hardy'))
  return {
    ...base,
    stats: st,
    ivs: G.botToPsStats(mon.ivs, 0), evs: G.botToPsStats(mon.evs, 0),
    baseStats: sp.baseStats,
    nature: { name: nat.name, up: nat.plus ?? null, down: nat.minus ?? null },
    ability: Dex.abilities.get(mon.abilities?.find(a => Object.values(sp.abilities).map(G.toID).includes(G.toID(a))) ?? sp.abilities[0]).name,
    abilities: Object.values(sp.abilities),
    moves: G.psMovesOf(mon, sp).map(G.moveInfo).filter(Boolean),
    happiness: mon.happiness ?? 0,
    art: { front: G.spriteChain(sp.num, { shiny: base.shiny }), back: G.spriteChain(sp.num, { shiny: base.shiny, back: true }) },
    heightM: sp.heightm, weightKg: sp.weightkg, tags: sp.tags ?? [],
  }
}

/** Items that matter inside a fight (Poké Balls + usable items), with quantities, for the battle screen. */
function battleBag(p) {
  const bag = p.pokemonGame?.bag ?? {}
  return Object.entries(bag)
    .filter(([id, q]) => q > 0 && (id in G.BALL_MULT || G.inBattleUsable(id)))
    .map(([id, q]) => itemView(id, q))
}

function towerView(p) {
  const cleared = p.pokeTower?.highestCleared ?? 0
  const next = nextStageFor(p)
  return {
    highestCleared: cleared, total: masterCount(), championed: !!p.pokeTower?.championed, nextStage: next,
    masters: allMasters().map(m => ({
      stage: m.stage, kind: m.kind, name: m.name, title: m.title, specialty: m.specialty, emoji: m.emoji, level: m.level,
      team: m.team.map(id => ({ dexId: id, name: G.speciesByNum(id)?.name ?? `#${id}` })),
      reward: m.reward ?? {}, intro: m.intro, defeat: m.defeat,
      status: m.stage <= cleared ? 'cleared' : m.stage === next ? 'next' : 'locked',
    })),
  }
}

/* ── battle helpers ────────────────────────────────────────────────────────── */

/** Your fighters in party order (main leads if it can), alive only, cloned so the fight can't touch the save. */
function fighters(p) {
  const ids = partyIds(p)
  const mons = ids.map(id => ownedMon(p, id)).filter(Boolean)
  mons.forEach(ensurePokemonExtendedFields)
  const alive = mons.filter(m => (m.currentHp ?? m.maxHp) > 0)
  const leadIdx = alive.findIndex(m => m.id === p.mainPokemonId)
  if (leadIdx > 0) alive.unshift(...alive.splice(leadIdx, 1))
  return alive.map(m => JSON.parse(JSON.stringify(m)))
}

function battlePayload(p, session, events = []) {
  return { battle: S.snapshot(session), events, bag: battleBag(p) }
}

/**
 * Writes a finished battle into the save: HP, EXP/levels, Solars, tower progress, a caught Pokémon,
 * Pokédex and stats. Runs inside updatePlayer. Returns a summary for the results screen.
 */
function applyOutcome(p, session) {
  const g = ensureGame(p)
  const o = S.outcome(session)
  const sum = { result: o.result, turns: o.turns, exp: [], levelUps: [], payout: 0, rewards: [], caught: null, leveled: [] }
  const trainer = session.kind === 'tower'

  // 1) HP back into the save (fraction of the bot's stored max HP).
  for (const m of o.mine) {
    const live = ownedMon(p, session.playerMons[m.slot]?.id)
    if (!live) continue
    live.currentHp = m.fainted ? 0 : Math.max(1, Math.round(live.maxHp * (m.hp / m.maxHp)))
  }

  const won = o.result === 'won'
  if (won) {
    // 2) EXP for everything that was knocked out; every Pokémon that fought shares the full amount.
    const total = o.foesDefeated.reduce((s, f) => s + G.expForFoe(f, { trainer }), 0)
    for (const slot of o.participants) {
      const live = ownedMon(p, session.playerMons[slot]?.id)
      if (!live || live.currentHp <= 0) continue
      const before = live.level
      const frac = G.hpFraction(live)
      live.exp = (live.exp ?? 0) + total
      while (live.exp >= live.level * 100 && live.level < G.CONST.MAX_LEVEL) { live.exp -= live.level * 100; live.level++ }
      if (live.level >= G.CONST.MAX_LEVEL) live.exp = 0
      if (live.level > before) {
        live.maxHp = basePokemonHp(live.baseHp, live.level)
        live.currentHp = Math.max(1, Math.round(live.maxHp * frac))
        sum.levelUps.push({ monId: live.id, name: live.nickname ?? live.name, from: before, to: live.level })
        sum.leveled.push(live.id)
      }
      sum.exp.push({ monId: live.id, name: live.nickname ?? live.name, gain: total })
    }
    g.stats.wins++
    recordQuestEvent(p, 'poke_win', 1)
  } else if (o.result === 'lost') {
    g.stats.losses++
  } else if (o.result === 'fled') {
    g.stats.fled++
  }

  // 3) Money and tower progress.
  if (won && session.kind === 'wild') {
    sum.payout = (o.foesDefeated[0]?.level ?? 1) * G.CONST.WILD_PAYOUT_PER_LEVEL
    pay(p, 'solars', sum.payout)
  }
  if (won && trainer) {
    const master = getMaster(session.meta.stage)
    p.pokeTower ??= { highestCleared: 0, championed: false }
    if (master && session.meta.stage > (p.pokeTower.highestCleared ?? 0)) {
      p.pokeTower.highestCleared = session.meta.stage
      if (session.meta.stage >= masterCount()) p.pokeTower.championed = true
      applyTowerReward(p, master)
      sum.rewards.push({ kind: 'first-clear', solars: master.reward?.solars ?? 0, gems: master.reward?.gems ?? 0 })
      sum.firstClear = true
    } else if (master) {
      sum.payout = master.level * G.CONST.TRAINER_PAYOUT_PER_LEVEL
      pay(p, 'solars', sum.payout)
    }
  }

  // 4) A caught Pokémon joins the collection (and the party if there's room).
  if (o.result === 'caught' && o.caught) {
    const mon = o.caught
    const foe = session.battle.sides[1].pokemon.find(x => x.name === `f${session.foeMons.indexOf(mon)}`)
    const frac = foe ? clamp(foe.hp / foe.maxhp, 0, 1) : 1
    mon.currentHp = Math.max(1, Math.round(mon.maxHp * frac))
    mon.caughtAt = Date.now()
    ensurePokemonExtendedFields(mon)
    p.pokemon ??= []
    p.pokemon.push(mon)
    const party = partyIds(p)
    if (party.length < G.CONST.PARTY_MAX) p.battlePartyIds = [...party, mon.id]
    if (!p.mainPokemonId) p.mainPokemonId = mon.id
    g.dex.caught[mon.dexId] = num(g.dex.caught[mon.dexId]) + 1
    g.stats.caught++
    if (mon.shiny) g.stats.shiny++
    recordQuestEvent(p, 'catch', 1)
    sum.caught = monView(p, mon)
    sum.caught.toParty = p.battlePartyIds?.includes(mon.id) ?? false
  }
  return sum
}

/** Run any level-up evolutions the fight unlocked. Separate write: it needs PokéAPI, which can be slow. */
async function evolveLeveled(db, updatePlayer, jid, monIds) {
  const out = []
  for (const id of monIds) {
    try {
      await updatePlayer(db, jid, async p => {
        const mon = ownedMon(p, id)
        if (!mon) return p
        const before = mon.dexId
        const r = await runLevelUpEvolutionCheck(mon)
        if (r) {
          const g = ensureGame(p)
          g.dex.caught[mon.dexId] = num(g.dex.caught[mon.dexId]) + 1
          out.push({ monId: id, from: r.oldName, to: r.newName, dexId: mon.dexId, fromDexId: before })
        }
        return p
      })
    } catch { /* evolution is a bonus; never fail a finished battle over it */ }
  }
  return out
}

/* ── registration ──────────────────────────────────────────────────────────── */

/**
 * @param router an express.Router() that the caller mounts at /api/pokemon
 */
export function registerPokemonRoutes(router, { db, requirePlayer, wrap, updatePlayer, log = console.log }) {
  const R = ''
  const ok = (res, data = {}) => res.json({ ok: true, ...data })
  const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra })
  const mutate = async (req, fn) => {
    let out
    await updatePlayer(db, req.jid, async p => { out = await fn(p); return p })
    return out
  }
  /** Management actions are locked while a fight is running (its result would overwrite them). */
  const noBattle = (req, res) => {
    if (S.getSession(req.jid)) { fail(res, 409, 'Finish your battle first.', { code: 'IN_BATTLE' }); return true }
    return false
  }

  /* ---- meta (static) ---- */
  router.get(`${R}/meta`, (_req, res) => ok(res, {
    regions: Object.entries(G.REGIONS).map(([key, [lo, hi]]) => ({ key, from: lo, to: hi })),
    starters: STARTERS.map(id => ({ dexId: id, name: G.speciesByNum(id)?.name, types: G.speciesByNum(id)?.types })),
    starterGift: Object.entries(STARTER_GIFT).map(([id, qty]) => itemView(id, qty)),
    partyMax: G.CONST.PARTY_MAX, maxLevel: G.CONST.MAX_LEVEL, dexTotal: 1025,
    costs: { feed: G.CONST.FEED_COST, trainPerLevel: G.CONST.TRAIN_COST_PER_LEVEL, trainEv: G.CONST.TRAIN_EV_GAIN },
    natures: Dex.natures.all().map(n => ({ name: n.name, up: n.plus ?? null, down: n.minus ?? null })),
    sprites: { base: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites' },
  }))

  /* ---- overview ---- */
  router.get(`${R}/overview`, requirePlayer, wrap(async (req, res) => {
    const p = req.player
    const g = readGame(p)
    const owned = p.pokemon ?? []
    const party = partyIds(p).map(id => ownedMon(p, id)).filter(Boolean)
    const caught = new Set([...Object.keys(g.dex.caught).map(Number), ...owned.map(m => m.dexId)])
    const session = S.getSession(req.jid)
    const importable = (p.inventory ?? []).filter(G.isPokeItem).length
    ok(res, {
      needsStarter: owned.length === 0,
      wallet: wallet(p),
      main: p.mainPokemonId ? (() => { const m = ownedMon(p, p.mainPokemonId); return m ? monView(p, m) : null })() : null,
      party: party.map(m => monView(p, m)),
      counts: { owned: owned.length, fainted: owned.filter(m => (m.currentHp ?? 1) <= 0).length },
      stats: g.stats,
      dex: { seen: new Set([...Object.keys(g.dex.seen).map(Number), ...caught]).size, caught: caught.size, total: 1025 },
      tower: { highestCleared: p.pokeTower?.highestCleared ?? 0, total: masterCount(), championed: !!p.pokeTower?.championed, nextStage: nextStageFor(p) },
      bag: { distinct: Object.keys(g.bag).length, total: Object.values(g.bag).reduce((a, b) => a + b, 0), importable },
      battle: session && !session.ended ? { id: session.id, kind: session.kind, foeName: session.foeName } : null,
    })
  }))

  /* ---- starter ---- */
  router.post(`${R}/starter`, requirePlayer, wrap(async (req, res) => {
    const dexId = num(req.body?.dexId)
    if (!STARTERS.includes(dexId)) return fail(res, 400, 'Pick one of the starter Pokémon.')
    const out = await mutate(req, p => {
      if ((p.pokemon ?? []).length > 0) return { error: 'You already have a Pokémon.' }
      const mon = G.buildFoe(G.speciesByNum(dexId), 5, { shiny: false })
      mon.caughtAt = Date.now()
      ensurePokemonExtendedFields(mon)
      p.pokemon = [mon]
      p.mainPokemonId = mon.id
      p.battlePartyIds = [mon.id]
      const g = ensureGame(p)
      g.dex.caught[dexId] = 1
      for (const [id, q] of Object.entries(STARTER_GIFT)) bagAdd(g, id, q)
      return { mon: monView(p, mon, { detail: true }) }
    })
    if (out.error) return fail(res, 409, out.error)
    ok(res, out)
  }))

  /* ---- collection ---- */
  router.get(`${R}/mons`, requirePlayer, wrap(async (req, res) => {
    const p = req.player
    const q = String(req.query.q ?? '').toLowerCase().trim()
    const type = String(req.query.type ?? '').toLowerCase()
    const filter = String(req.query.filter ?? '')
    const sort = String(req.query.sort ?? 'recent')
    const dir = String(req.query.order ?? (sort === 'name' || sort === 'dex' ? 'asc' : 'desc')) === 'asc' ? 1 : -1
    const limit = clamp(num(req.query.limit, 30), 1, 100)
    let list = (p.pokemon ?? []).map(m => monView(p, m))
    if (q) list = list.filter(m => m.name.toLowerCase().includes(q) || (m.nickname ?? '').toLowerCase().includes(q))
    if (type) list = list.filter(m => m.types.some(t => t.toLowerCase() === type))
    if (filter === 'party') list = list.filter(m => m.inParty)
    else if (filter === 'fainted') list = list.filter(m => m.fainted)
    else if (filter === 'shiny') list = list.filter(m => m.shiny)
    else if (filter === 'box') list = list.filter(m => !m.inParty)
    const keyFn = { level: m => m.level, name: m => m.name, dex: m => m.dexId, hp: m => m.hp / m.maxHp, recent: m => m.caughtAt ?? 0 }[sort] ?? (m => m.caughtAt ?? 0)
    list.sort((a, b) => { const x = keyFn(a), y = keyFn(b); return (x < y ? -1 : x > y ? 1 : 0) * dir })
    const total = list.length
    const pages = Math.max(1, Math.ceil(total / limit))
    const page = clamp(num(req.query.page, 1), 1, pages)
    ok(res, { total, page, pages, mons: list.slice((page - 1) * limit, page * limit) })
  }))

  router.get(`${R}/mons/:id`, requirePlayer, wrap(async (req, res) => {
    const mon = ownedMon(req.player, req.params.id)
    if (!mon) return fail(res, 404, 'Pokémon not found.')
    ok(res, { mon: monView(req.player, mon, { detail: true }) })
  }))

  router.patch(`${R}/mons/:id`, requirePlayer, wrap(async (req, res) => {
    const body = req.body ?? {}
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      if ('nickname' in body) {
        const nick = String(body.nickname ?? '').replace(/[\u0000-\u001f|]/g, '').trim().slice(0, 18)
        mon.nickname = nick || null
      }
      if ('protected' in body) mon.protected = !!body.protected
      return { mon: monView(p, mon) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  router.post(`${R}/mons/:id/main`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      p.mainPokemonId = mon.id
      const party = partyIds(p)
      if (!party.includes(mon.id)) p.battlePartyIds = [mon.id, ...party].slice(0, G.CONST.PARTY_MAX)
      return { mainId: mon.id }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  router.put(`${R}/party`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null
    if (!ids) return fail(res, 400, 'Send { ids: [...] }.')
    if (new Set(ids).size !== ids.length) return fail(res, 400, 'A Pokémon can only be in the party once.')
    if (ids.length > G.CONST.PARTY_MAX) return fail(res, 400, `A party holds at most ${G.CONST.PARTY_MAX} Pokémon.`)
    const out = await mutate(req, p => {
      if (ids.some(id => !ownedMon(p, id))) return { error: 'One of those Pokémon is not yours.' }
      p.battlePartyIds = ids
      if (ids.length) p.mainPokemonId = ids[0]
      return { party: ids.map(id => monView(p, ownedMon(p, id))) }
    })
    if (out.error) return fail(res, 400, out.error)
    ok(res, out)
  }))

  router.post(`${R}/heal`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const out = await mutate(req, p => {
      let n = 0
      for (const m of p.pokemon ?? []) if ((m.currentHp ?? m.maxHp) < m.maxHp) { m.currentHp = m.maxHp; n++ }
      return { healed: n }
    })
    ok(res, out)
  }))

  /* ---- per-Pokémon care ---- */
  router.post(`${R}/mons/:id/feed`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const leveled = []
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      if ((mon.currentHp ?? mon.maxHp) <= 0) return { error: `${mon.nickname ?? mon.name} has fainted. Use a Revive or visit the Pokémon Center.` }
      if (mon.level >= G.CONST.MAX_LEVEL) return { error: `${mon.nickname ?? mon.name} is already at the max level.` }
      if (!charge(p, 'solars', G.CONST.FEED_COST)) return { status: 402, error: `You need ${G.CONST.FEED_COST} Solars.` }
      const gain = 20 + Math.floor(Math.random() * 50)
      const before = mon.level
      const frac = G.hpFraction(mon)
      mon.exp = (mon.exp ?? 0) + gain
      mon.happiness = clamp((mon.happiness ?? 0) + 1 + Math.floor(Math.random() * 5), 0, 255)
      while (mon.exp >= mon.level * 100 && mon.level < G.CONST.MAX_LEVEL) { mon.exp -= mon.level * 100; mon.level++ }
      if (mon.level > before) { mon.maxHp = basePokemonHp(mon.baseHp, mon.level); leveled.push(mon.id) }
      mon.currentHp = clamp(Math.round(mon.maxHp * Math.min(1, frac + G.CONST.FEED_HEAL_PCT / 100)), 1, mon.maxHp)
      return { gain, leveledUp: mon.level > before ? { from: before, to: mon.level } : null, mon: monView(p, mon), wallet: wallet(p) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    out.evolutions = await evolveLeveled(db, updatePlayer, req.jid, leveled)
    ok(res, out)
  }))

  router.post(`${R}/mons/:id/train`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const stat = String(req.body?.stat ?? '')
    if (!G.PS_STATS.includes(stat)) return fail(res, 400, 'Pick a stat: hp, atk, def, spa, spd or spe.')
    const botKey = { hp: 'hp', atk: 'atk', def: 'def', spa: 'spAtk', spd: 'spDef', spe: 'spd' }[stat]
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      mon.evs ??= { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0 }
      const total = Object.values(mon.evs).reduce((a, b) => a + num(b), 0)
      const cur = num(mon.evs[botKey])
      if (cur >= G.CONST.EV_PER_STAT) return { error: 'That stat is already fully trained.' }
      if (total >= G.CONST.EV_TOTAL) return { error: 'This Pokémon can not train any more.' }
      const cost = mon.level * G.CONST.TRAIN_COST_PER_LEVEL
      if (!charge(p, 'solars', cost)) return { status: 402, error: `You need ${cost} Solars.` }
      const add = Math.min(G.CONST.TRAIN_EV_GAIN, G.CONST.EV_PER_STAT - cur, G.CONST.EV_TOTAL - total)
      mon.evs[botKey] = cur + add
      return { added: add, stat, cost, mon: monView(p, mon, { detail: true }), wallet: wallet(p) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  router.post(`${R}/mons/:id/release`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      if (mon.protected) return { status: 409, error: 'This Pokémon is protected. Unlock it first.' }
      if ((p.pokemon ?? []).length <= 1) return { status: 409, error: "You can't release your last Pokémon." }
      const g = ensureGame(p)
      if (mon.heldItem) bagAdd(g, mon.heldItem, 1)
      const reward = mon.level * 100
      p.pokemon = p.pokemon.filter(m => m.id !== mon.id)
      p.battlePartyIds = partyIds(p).filter(id => id !== mon.id)
      if (p.mainPokemonId === mon.id) p.mainPokemonId = p.battlePartyIds[0] ?? p.pokemon[0]?.id ?? null
      pay(p, 'solars', reward)
      return { released: mon.nickname ?? mon.name, reward, wallet: wallet(p) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  router.post(`${R}/mons/:id/hold`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const itemId = String(req.body?.itemId ?? '')
    const it = G.POKE_ITEM_MAP.get(itemId)
    if (!it || !(it.category === 'held' || it.megaStone)) return fail(res, 400, "That item can't be held.")
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      const g = ensureGame(p)
      if (!bagTake(g, itemId, 1)) return { status: 409, error: "You don't have that item." }
      const previous = mon.heldItem
      if (previous) bagAdd(g, previous, 1)
      mon.heldItem = itemId
      return { mon: monView(p, mon), returned: previous ?? null }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  router.post(`${R}/mons/:id/unhold`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      if (!mon.heldItem) return { status: 409, error: 'It is not holding anything.' }
      bagAdd(ensureGame(p), mon.heldItem, 1)
      const returned = mon.heldItem
      mon.heldItem = null
      return { mon: monView(p, mon), returned }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  /* ---- evolution ---- */
  router.get(`${R}/mons/:id/evolution`, requirePlayer, wrap(async (req, res) => {
    const mon = ownedMon(req.player, req.params.id)
    if (!mon) return fail(res, 404, 'Pokémon not found.')
    const levelUp = await checkEvolution(mon).catch(() => null)
    ok(res, { ready: levelUp ? { dexId: levelUp.dexId, name: levelUp.name, minLevel: levelUp.minLevel ?? null } : null })
  }))

  router.post(`${R}/mons/:id/evolve`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const itemId = req.body?.itemId ? String(req.body.itemId) : null
    const pre = ownedMon(req.player, req.params.id)
    if (!pre) return fail(res, 404, 'Pokémon not found.')
    let apiName = null
    if (itemId) {
      const it = G.POKE_ITEM_MAP.get(itemId)
      if (!it || it.category !== 'evolution') return fail(res, 400, "That isn't an evolution stone.")
      apiName = itemId.replace(/^poke_/, '').replace(/_/g, '-')
      if (bagQty(req.player, itemId) < 1) return fail(res, 409, "You don't have that stone.")
    }
    const target = itemId ? await findItemEvolution(pre, apiName).catch(() => null) : await checkEvolution(pre).catch(() => null)
    if (!target) return fail(res, 409, itemId ? "It doesn't react to that stone." : 'It has no evolution available right now.')
    const out = await mutate(req, async p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      const g = ensureGame(p)
      if (itemId && !bagTake(g, itemId, 1)) return { status: 409, error: "You don't have that stone." }
      const r = await applyEvolution(mon, target)
      if (!r) { if (itemId) bagAdd(g, itemId, 1); return { status: 503, error: 'Evolution failed. Try again in a moment.' } }
      g.dex.caught[mon.dexId] = num(g.dex.caught[mon.dexId]) + 1
      return { from: r.oldName, to: r.newName, mon: monView(p, mon, { detail: true }) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  /* ---- moves ---- */
  router.get(`${R}/mons/:id/moves`, requirePlayer, wrap(async (req, res) => {
    const mon = ownedMon(req.player, req.params.id)
    if (!mon) return fail(res, 404, 'Pokémon not found.')
    const sp = G.speciesForMon(mon)
    ok(res, { current: G.psMovesOf(mon, sp).map(G.moveInfo).filter(Boolean), learnable: G.learnableMoves(sp, mon.level) })
  }))

  router.put(`${R}/mons/:id/moves`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const ids = Array.isArray(req.body?.moves) ? [...new Set(req.body.moves.map(G.toID))] : null
    if (!ids || ids.length < 1 || ids.length > 4) return fail(res, 400, 'Pick 1 to 4 moves.')
    const out = await mutate(req, p => {
      const mon = ownedMon(p, req.params.id)
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      const legal = new Set(G.learnableMoves(G.speciesForMon(mon), mon.level).map(m => m.id))
      const bad = ids.find(id => !legal.has(id))
      if (bad) return { error: `${Dex.moves.get(bad).name || bad} can't be learned by this Pokémon yet.` }
      mon.psMoves = ids
      return { mon: monView(p, mon, { detail: true }) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  /* ---- pokédex ---- */
  router.get(`${R}/dex`, requirePlayer, wrap(async (req, res) => {
    const p = req.player
    const g = readGame(p)
    const [lo, hi] = G.REGIONS[String(req.query.region ?? '').toLowerCase()] ?? [1, 1025]
    const caught = new Map()
    for (const [k, v] of Object.entries(g.dex.caught)) caught.set(Number(k), num(v))
    for (const m of p.pokemon ?? []) caught.set(m.dexId, Math.max(1, caught.get(m.dexId) ?? 0))
    const seen = new Set([...Object.keys(g.dex.seen).map(Number), ...caught.keys()])
    const entries = []
    for (let n = lo; n <= hi; n++) {
      const sp = G.speciesByNum(n)
      const c = caught.has(n), s = seen.has(n)
      entries.push({ dexId: n, seen: s, caught: c, count: caught.get(n) ?? 0, name: s ? sp?.name ?? null : null, types: s ? sp?.types ?? null : null })
    }
    ok(res, { total: hi - lo + 1, seen: entries.filter(e => e.seen).length, caught: entries.filter(e => e.caught).length, entries })
  }))

  /* ---- bag ---- */
  const CAT_ORDER = ['ball', 'battle', 'revive', 'evolution', 'held', 'cosmetic']
  router.get(`${R}/bag`, requirePlayer, wrap(async (req, res) => {
    const p = req.player
    const items = Object.entries(readGame(p).bag).filter(([, q]) => q > 0).map(([id, q]) => itemView(id, q))
    items.sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || a.name.localeCompare(b.name))
    ok(res, { items, importable: (p.inventory ?? []).filter(G.isPokeItem).length, wallet: wallet(p) })
  }))

  router.post(`${R}/bag/import`, requirePlayer, wrap(async (req, res) => {
    const out = await mutate(req, p => {
      const g = ensureGame(p)
      let moved = 0
      const keep = []
      for (const id of p.inventory ?? []) {
        if (G.isPokeItem(id)) { bagAdd(g, id, 1); moved++ } else keep.push(id)
      }
      p.inventory = keep
      return { moved }
    })
    ok(res, out)
  }))

  router.post(`${R}/bag/use`, requirePlayer, wrap(async (req, res) => {
    if (noBattle(req, res)) return
    const itemId = String(req.body?.itemId ?? '')
    const fx = G.ITEM_FX[itemId]
    if (!fx || !G.outOfBattleUsable(itemId)) return fail(res, 400, itemId in G.ITEM_FX ? 'Use that one during a battle.' : "That can't be used here.")
    const out = await mutate(req, p => {
      const mon = ownedMon(p, String(req.body?.monId ?? ''))
      if (!mon) return { status: 404, error: 'Pokémon not found.' }
      const g = ensureGame(p)
      if (num(g.bag[itemId]) < 1) return { status: 409, error: "You don't have that item." }
      const st = G.realStats(mon)
      const label = mon.nickname ?? mon.name
      const fainted = (mon.currentHp ?? mon.maxHp) <= 0
      if (fx.revivePct) {
        if (!fainted) return { error: `${label} hasn't fainted.` }
        mon.currentHp = Math.max(1, Math.round(mon.maxHp * (fx.revivePct / 100)))
      } else {
        if (fainted) return { error: `${label} has fainted. Use a Revive.` }
        const cur = Math.round(st.hp * G.hpFraction(mon))
        if (cur >= st.hp) return { error: `${label}'s HP is already full.` }
        const heal = fx.heal ?? Math.ceil((st.hp * fx.healPct) / 100)
        mon.currentHp = Math.max(1, Math.round(mon.maxHp * Math.min(1, (cur + heal) / st.hp)))
      }
      bagTake(g, itemId, 1)
      return { mon: monView(p, mon), left: num(g.bag[itemId]) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  /* ---- shop ---- */
  router.get(`${R}/shop`, requirePlayer, wrap(async (req, res) => {
    const p = req.player
    const bag = readGame(p).bag
    const cats = SHOP_CATS.map(([key, label]) => ({
      key, label,
      items: G.allPokeItems().filter(i => i.category === key && i.buyPrice > 0)
        .sort((a, b) => (a.currency === b.currency ? a.buyPrice - b.buyPrice : a.currency === 'solars' ? -1 : 1))
        .map(i => ({ ...itemView(i.id), owned: num(bag[i.id]) })),
    }))
    ok(res, { wallet: wallet(p), categories: cats })
  }))

  router.post(`${R}/shop/buy`, requirePlayer, wrap(async (req, res) => {
    const id = String(req.body?.id ?? '')
    const qty = clamp(Math.floor(num(req.body?.qty, 1)), 1, 99)
    const it = G.POKE_ITEM_MAP.get(id)
    if (!it || !SHOP_CATS.some(([k]) => k === it.category) || !(it.buyPrice > 0)) return fail(res, 404, 'That item is not for sale.')
    const out = await mutate(req, p => {
      const g = ensureGame(p)
      if (num(g.bag[id]) + qty > G.CONST.BAG_STACK_MAX) return { status: 409, error: `You can carry at most ${G.CONST.BAG_STACK_MAX}.` }
      const cost = it.currency === 'gems' ? round2(it.buyPrice * qty) : it.buyPrice * qty
      if (!charge(p, it.currency, cost)) return { status: 402, error: `You need ${cost} ${it.currency === 'gems' ? 'Gems' : 'Solars'}.` }
      bagAdd(g, id, qty)
      return { bought: itemView(id, qty), owned: num(g.bag[id]), cost, currency: it.currency, wallet: wallet(p) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  router.post(`${R}/shop/sell`, requirePlayer, wrap(async (req, res) => {
    const id = String(req.body?.id ?? '')
    const qty = clamp(Math.floor(num(req.body?.qty, 1)), 1, 999)
    const it = G.POKE_ITEM_MAP.get(id)
    if (!it || !(it.sellPrice > 0)) return fail(res, 400, "That can't be sold.")
    const out = await mutate(req, p => {
      const g = ensureGame(p)
      if (!bagTake(g, id, qty)) return { status: 409, error: "You don't have that many." }
      const gain = it.sellPrice * qty
      pay(p, it.currency, gain)
      return { sold: itemView(id, qty), gain, currency: it.currency, wallet: wallet(p) }
    })
    if (out.error) return fail(res, out.status ?? 400, out.error)
    ok(res, out)
  }))

  /* ---- hunting & battles ---- */
  const startFight = async (req, res, { kind, foes, foeName, meta }) => {
    if (S.getSession(req.jid)) {
      const s = S.getSession(req.jid)
      return fail(res, 409, 'You are already in a battle.', { code: 'IN_BATTLE', ...battlePayload(req.player, s) })
    }
    const mine = fighters(req.player)
    if (!mine.length) {
      const has = (req.player.pokemon ?? []).length > 0
      return fail(res, 409, has ? 'All of your Pokémon have fainted. Heal them first.' : 'You need a Pokémon first. Pick a starter!', { code: has ? 'ALL_FAINTED' : 'NO_POKEMON' })
    }
    const { session, events } = S.startBattle({ jid: req.jid, kind, playerMons: mine, foeMons: foes, foeName, meta })
    await mutate(req, p => {
      const g = ensureGame(p)
      for (const f of foes) g.dex.seen[f.dexId] = num(g.dex.seen[f.dexId]) + 1
      if (kind === 'wild') g.stats.hunts++
    })
    return ok(res, battlePayload(req.player, session, events))
  }

  router.post(`${R}/hunt`, requirePlayer, wrap(async (req, res) => {
    const lead = fighters(req.player)[0]
    const base = lead?.level ?? 5
    const [lo, hi] = G.CONST.HUNT_LEVEL_BAND
    const level = clamp(base + lo + Math.floor(Math.random() * (hi - lo + 1)), 2, G.CONST.MAX_LEVEL)
    const sp = G.pickWildSpecies(req.body?.region)
    const foe = G.buildFoe(sp, level, { shiny: Math.random() < G.CONST.SHINY_CHANCE })
    return startFight(req, res, { kind: 'wild', foes: [foe], foeName: 'Wild', meta: { region: req.body?.region ?? null } })
  }))

  router.get(`${R}/battle`, requirePlayer, wrap(async (req, res) => {
    const s = S.getSession(req.jid)
    if (!s) return ok(res, { battle: null })
    ok(res, battlePayload(req.player, s))
  }))

  router.post(`${R}/battle/act`, requirePlayer, wrap(async (req, res) => {
    const session = S.getSession(req.jid)
    if (!session) return fail(res, 404, 'No battle in progress.', { code: 'NO_BATTLE' })
    if (session.busy) return fail(res, 409, 'Your last move is still resolving.', { code: 'BUSY' })
    const a = req.body ?? {}
    // Items and balls come from the app's own bag: check first, take after the turn resolves.
    if (a.action === 'catch' && session.kind !== 'wild') return fail(res, 400, "You can't catch another trainer's Pokémon!")
    if (a.action === 'item' && bagQty(req.player, String(a.itemId)) < 1) return fail(res, 409, "You don't have that item.")
    if (a.action === 'catch' && bagQty(req.player, String(a.itemId ?? 'poke_ball')) < 1) return fail(res, 409, "You don't have that Poké Ball.")
    session.busy = true
    try {
      const r = S.act(session, a)
      if (r.error) return fail(res, 400, r.error)
      let summary = null
      let evolutions = []
      await mutate(req, p => {
        if (r.consumed) bagTake(ensureGame(p), r.consumed, 1)
        if (r.ended) summary = applyOutcome(p, session)
      })
      if (r.ended) {
        if (summary?.leveled?.length) evolutions = await evolveLeveled(db, updatePlayer, req.jid, summary.leveled)
        S.dropSession(req.jid)
      }
      const fresh = getPlayer(db, req.jid) ?? req.player
      ok(res, { ...battlePayload(fresh, session, r.events), ...(summary ? { summary: { ...summary, evolutions } } : {}) })
    } finally {
      session.busy = false
    }
  }))

  router.post(`${R}/battle/forfeit`, requirePlayer, wrap(async (req, res) => {
    const session = S.getSession(req.jid)
    if (!session) return fail(res, 404, 'No battle in progress.', { code: 'NO_BATTLE' })
    if (session.busy) return fail(res, 409, 'Your last move is still resolving.', { code: 'BUSY' })
    session.busy = true
    try {
      session.ended = true
      session.result = session.kind === 'wild' ? 'fled' : 'lost'
      let summary = null
      await mutate(req, p => { summary = applyOutcome(p, session) })
      S.dropSession(req.jid)
      ok(res, { battle: S.snapshot(session), summary })
    } finally { session.busy = false }
  }))

  /* ---- Sinnoh League tower ---- */
  router.get(`${R}/tower`, requirePlayer, wrap(async (req, res) => ok(res, towerView(req.player))))

  router.post(`${R}/tower/challenge`, requirePlayer, wrap(async (req, res) => {
    const stage = num(req.body?.stage, nextStageFor(req.player) ?? masterCount())
    const cleared = req.player.pokeTower?.highestCleared ?? 0
    const master = getMaster(stage)
    if (!master) return fail(res, 404, 'No such challenger.')
    if (stage > cleared + 1) return fail(res, 403, `Beat ${getMaster(cleared + 1)?.name ?? 'the previous challenger'} first.`, { code: 'LOCKED' })
    const foes = master.team.map(id => G.buildFoe(G.speciesByNum(id), master.level))
    return startFight(req, res, {
      kind: 'tower', foes, foeName: master.name,
      meta: { stage, name: master.name, title: master.title, emoji: master.emoji, intro: master.intro, defeat: master.defeat },
    })
  }))

  log('Pokémon game API ready (/api/pokemon/*)')
}
