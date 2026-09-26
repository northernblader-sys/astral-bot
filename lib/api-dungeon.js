/**
 * api-dungeon.js — REST surface for dungeon combat.
 *
 * Mounted at /api/dungeon by lib/api-server.js (same lazy-router pattern as
 * api-pokemon.js). Every route is JWT-gated via requirePlayer.
 *
 * GROUND RULE #1 — no forked combat logic. This module does NOT re-implement a
 * single turn. It drives the REAL chat plugins (plugins/dungeon.js and the
 * combat verbs plugins/attack.js, skill.js, defend.js, flee.js, al/ar/ml/mr,
 * dodge.js) through a synthetic "capture ctx": a ctx object whose reply/
 * replyImage/replyGif methods and whose sock.sendMessage record text into a log
 * array instead of sending it to WhatsApp. The plugins run byte-for-byte the
 * same code the chat handler runs — they call updatePlayer() internally, spawn
 * enemies, resolve damage, advance floors and hand off to handleVictory exactly
 * as before — and we read the committed state back out of the db afterwards.
 *
 * The only things the WhatsApp handler does that we skip are the group ON/OFF
 * admin path and the group slot gate, both of which are keyed on ctx.isGroup —
 * we set isGroup:false, so the plugin dispatch drops straight through to the
 * solo enter/advance/leave handlers.
 *
 * Engine changes required for this module (reported at check-in):
 *   - plugins/dungeon.js: `SWARM_DUNGEONS` const is now `export`ed so /list can
 *     tell the app which dungeons use the multi-monster swarm engine. No logic
 *     moved or changed.
 */
import { getPlayer } from './player-repo.js'
import { locationsMap, skills as allSkills } from './game-data.js'
import { runsRemaining } from './dungeon-limits.js'
import { THE_END_LOCATION_ID, isEventActive } from './end-event.js'
import dungeonPlugin, { isDungeonUnlocked, SWARM_DUNGEONS } from '../plugins/dungeon.js'
import attackPlugin from '../plugins/attack.js'
import skillPlugin from '../plugins/skill.js'
import defendPlugin from '../plugins/defend.js'
import fleePlugin from '../plugins/flee.js'
import alPlugin from '../plugins/al.js'
import arPlugin from '../plugins/ar.js'
import mlPlugin from '../plugins/ml.js'
import mrPlugin from '../plugins/mr.js'
import dodgePlugin from '../plugins/dodge.js'

/** Boss-floor flag — pure data lookup, mirrors dungeon.js's internal isBossFloor. */
function isBossFloor(locId, floor) {
  return (locationsMap[locId]?.bossFloors ?? []).includes(floor)
}

/** Strip WhatsApp markdown (* bold, _ italic) so the app gets clean strings. */
function stripMd(s) {
  return String(s ?? '').replace(/[*_]/g, '').trim()
}

/** Best-effort HTTP status for an entry rejection, read off the reply text. */
function classifyEnterFailure(reason) {
  const r = String(reason ?? '').toLowerCase()
  if (r.includes('locked') || r.includes('requires level')) return 403
  if (reason.includes('☀️') || r.includes('costs')) return 402
  if (r.includes('stamina')) return 429
  if (r.includes('run') && (r.includes('limit') || r.includes('daily') || r.includes('no ') || r.includes('out of'))) return 429
  if (r.includes('already')) return 409
  if (r.includes('unknown')) return 404
  return 409
}

/**
 * Resolve a skillId to the token list the skill plugins expect. Passing the
 * human NAME (not the id) satisfies BOTH resolvers: the 1v1 findSkill() matches
 * id OR name, and swarm resolveSwarmSkill() matches a name substring only.
 */
function resolveSkillArgs(skillId) {
  if (!skillId) return []
  const key = String(skillId).toLowerCase().replace(/\s+/g, '_')
  const s = allSkills.find(
    k => k.id?.toLowerCase() === key || k.name?.toLowerCase().replace(/\s+/g, '_') === key,
  )
  return s ? String(s.name).split(/\s+/) : [String(skillId)]
}

/**
 * Serialize the player's live dungeon/battle state into the shape the Android
 * app consumes. HP/MP are raw numbers (the app renders its own bars). `enemy`
 * is null between floors; `monsters` is populated only on swarm floors.
 */
function serializeDungeonState(player) {
  const bs = player?.battleState ?? null
  const inDungeon = !!player?.inDungeon
  const inBattle = !!player?.inBattle && !!bs
  const locId = bs?.locationId ?? (inDungeon ? player?.location : null) ?? null
  const loc = locId ? locationsMap[locId] : null
  const floor = player?.dungeonFloor ?? 0
  const mode = bs ? (bs.mode === 'swarm' ? 'swarm' : 'solo') : null
  const prog = locId ? (player?.dungeonProgress?.[locId] ?? null) : null

  const e = inBattle ? bs.enemy : null
  const enemy = e ? {
    name: e.name ?? null,
    emoji: e.emoji ?? null,
    hp: e.hp ?? 0,
    maxHp: e.maxHp ?? 0,
    atk: e.atk ?? 0,
    def: e.def ?? 0,
    isBoss: !!e.isBoss,
    tier: e.tier ?? null,
  } : null

  const monsters = (inBattle && bs.mode === 'swarm' && Array.isArray(bs.monsters))
    ? bs.monsters.map(m => ({
        uid: m.uid ?? null,
        name: m.name ?? null,
        emoji: m.emoji ?? null,
        hp: m.hp ?? 0,
        maxHp: m.maxHp ?? 0,
        atk: m.atk ?? 0,
        lane: m.lane ?? null,
        range: m.range ?? null,
        telegraph: m.telegraph ?? null,
        alive: !!m.alive,
      }))
    : null

  const actions = !inBattle
    ? []
    : mode === 'swarm'
      ? ['al', 'ar', 'ml', 'mr', 'dodge', 'skill', 'defend', 'flee']
      : ['attack', 'skill', 'defend', 'flee']

  return {
    inDungeon,
    inBattle,
    dungeonId: locId,
    dungeonName: loc?.name ?? null,
    floor,
    totalFloors: loc?.floors ?? null,
    isBossFloor: locId ? isBossFloor(locId, floor) : false,
    mode,
    canAdvance: inDungeon && !inBattle,
    conquered: !!prog?.conquered,
    highestFloor: prog?.highestFloor ?? 0,
    playerLane: bs?.mode === 'swarm' ? (bs.playerLane ?? null) : null,
    player: {
      name: player?.name ?? null,
      level: player?.level ?? 0,
      hp: player?.hp ?? 0,
      maxHp: player?.maxHp ?? 0,
      mp: player?.mp ?? 0,
      maxMp: player?.maxMp ?? 0,
      defending: !!(bs?.playerDefending ?? bs?.defending),
    },
    enemy,
    monsters,
    actions,
  }
}

export function registerDungeonRoutes(router, { db, requirePlayer, wrap, updatePlayer, log = console.log }) {
  const ok = (res, data = {}) => res.json({ ok: true, ...data })
  const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra })
  const safeRuns = (p) => { try { return runsRemaining(p) } catch { return null } }

  /**
   * Build a synthetic ctx that captures all outgoing text, then run one plugin.
   * The plugin owns its own updatePlayer() call — we never wrap it in another.
   * Returns the captured log lines (markdown stripped).
   */
  async function drive(jid, plugin, { cmd = null, args = [] } = {}) {
    const lines = []
    const push = (t) => { const s = String(t ?? '').trim(); if (s) lines.push(s) }
    const ctx = {
      db,
      from: jid,
      sender: jid,
      player: getPlayer(db, jid),
      platform: 'whatsapp',
      isGroup: false,
      args,
      cmd,
      body: [cmd, ...args].filter(Boolean).join(' '),
      msg: { key: {}, message: {} },
      // lib/image.js's sendImageTo() talks to ctx.sock.sendMessage directly on
      // the WhatsApp path. A Proxy makes every sock method an async no-op that
      // still harvests any {text}/{caption} it's handed, so no render path can
      // throw its way out of the plugin's updatePlayer() mutator and roll back
      // a committed turn.
      sock: new Proxy({}, {
        get: () => (async (_to, content) => { push(content?.text ?? content?.caption); return {} }),
      }),
      reply: async (t) => { push(t); return {} },
      replyImage: async (_buf, caption = '') => { push(caption); return {} },
      replyGif: async (_buf, caption = '') => { push(caption); return {} },
      react: async () => {},
    }
    await plugin.run(ctx)
    return lines.map(stripMd)
  }

  // ── POST /api/dungeon/enter — start or resume a run, spawn the floor ──────
  router.post('/enter', requirePlayer, wrap(async (req, res) => {
    const { dungeonId } = req.body ?? {}
    if (!dungeonId || typeof dungeonId !== 'string') {
      return fail(res, 400, 'dungeonId is required.', { code: 'BAD_REQUEST' })
    }
    const locId = dungeonId.toLowerCase().replace(/\s+/g, '_')
    const loc = locationsMap[locId]
    if (!loc || loc.type !== 'dungeon') {
      return fail(res, 404, `Unknown dungeon "${locId}".`, { code: 'UNKNOWN_DUNGEON' })
    }

    const before = getPlayer(db, req.jid)

    // Mid-fight: /enter is a pure resume — return the live battle, spend nothing.
    if (before?.inBattle && before?.battleState) {
      return ok(res, { resumed: true, log: [], state: serializeDungeonState(before), runsRemaining: safeRuns(before) })
    }

    // Already in a dungeon between floors.
    if (before?.inDungeon) {
      if (before.location !== locId) {
        return fail(res, 409,
          `You're already in ${locationsMap[before.location]?.name ?? before.location}. Leave it first.`,
          { code: 'ALREADY_IN_DUNGEON', currentDungeonId: before.location })
      }
      // Same dungeon → advance/spawn the current floor (no run spent, mirrors `.dungeon`).
      const advLog = await drive(req.jid, dungeonPlugin, { cmd: 'dungeon', args: [] })
      const p2 = getPlayer(db, req.jid)
      return ok(res, { resumed: true, log: advLog, state: serializeDungeonState(p2), runsRemaining: safeRuns(p2) })
    }

    // Fresh entry: `.enter <id>` spends a run + sets up (no encounter yet)…
    const enterLog = await drive(req.jid, dungeonPlugin, { cmd: 'enter', args: [locId] })
    const mid = getPlayer(db, req.jid)
    if (!mid?.inDungeon || mid.location !== locId) {
      // Rejected by a gate (locked / level / stamina / run cap / solars). The
      // plugin already wrote the human reason into the log; surface it.
      const reason = enterLog[enterLog.length - 1] || enterLog[0] || 'Could not enter this dungeon.'
      return fail(res, classifyEnterFailure(reason), reason, { code: 'ENTER_REJECTED', log: enterLog })
    }
    // …then `.dungeon` spawns the first encounter, so we return live floor state.
    const advLog = await drive(req.jid, dungeonPlugin, { cmd: 'dungeon', args: [] })
    const after = getPlayer(db, req.jid)
    ok(res, { resumed: false, log: [...enterLog, ...advLog], state: serializeDungeonState(after), runsRemaining: safeRuns(after) })
  }))

  // ── GET /api/dungeon/state — current floor / enemy / HP / boss flag ───────
  router.get('/state', requirePlayer, wrap(async (req, res) => {
    const player = getPlayer(db, req.jid)
    ok(res, { state: serializeDungeonState(player) })
  }))

  // ── POST /api/dungeon/action — resolve ONE turn via the real combat verbs ─
  router.post('/action', requirePlayer, wrap(async (req, res) => {
    const { action, skillId, direction, target } = req.body ?? {}
    const p0 = getPlayer(db, req.jid)
    if (!p0 || !p0.inBattle || !p0.battleState) {
      return fail(res, 409, 'You are not in a battle.', { code: 'NOT_IN_BATTLE' })
    }
    const isSwarm = p0.battleState.mode === 'swarm'
    let plugin
    let args = []

    switch (action) {
      case 'attack':
        if (isSwarm) {
          if (direction !== 'left' && direction !== 'right') {
            return fail(res, 400, "This floor is a swarm — attack needs direction 'left' or 'right'.", { code: 'DIRECTION_REQUIRED' })
          }
          plugin = direction === 'left' ? alPlugin : arPlugin
        } else {
          plugin = attackPlugin
        }
        break
      case 'skill':
        if (!isSwarm && !skillId) {
          return fail(res, 400, 'skillId is required for a skill on this floor.', { code: 'SKILL_REQUIRED' })
        }
        plugin = skillPlugin
        args = resolveSkillArgs(skillId)
        // Swarm skills accept an optional trailing target number (1-based).
        if (isSwarm && Number.isInteger(target) && target >= 1) args = [...args, String(target)]
        break
      case 'defend':
        plugin = defendPlugin
        break
      case 'flee':
        plugin = fleePlugin
        break
      case 'move':
        if (!isSwarm) return fail(res, 400, 'move is only valid on swarm floors.', { code: 'SWARM_ONLY' })
        if (direction !== 'left' && direction !== 'right') {
          return fail(res, 400, "move needs direction 'left' or 'right'.", { code: 'DIRECTION_REQUIRED' })
        }
        plugin = direction === 'left' ? mlPlugin : mrPlugin
        break
      case 'dodge':
        if (!isSwarm) return fail(res, 400, 'dodge is only valid on swarm floors.', { code: 'SWARM_ONLY' })
        plugin = dodgePlugin
        break
      default:
        return fail(res, 400, 'Unknown action. Use attack | skill | defend | flee (swarm floors also accept move | dodge).', { code: 'BAD_ACTION' })
    }

    const turnLog = await drive(req.jid, plugin, { args })
    const after = getPlayer(db, req.jid)
    ok(res, { log: turnLog, state: serializeDungeonState(after) })
  }))

  // ── POST /api/dungeon/leave — save progress and exit ──────────────────────
  router.post('/leave', requirePlayer, wrap(async (req, res) => {
    const before = getPlayer(db, req.jid)
    if (before?.inBattle && before?.battleState?.enemy?.isBoss) {
      return fail(res, 423, 'You cannot leave during a boss fight.', { code: 'BOSS_LOCK' })
    }
    const leaveLog = await drive(req.jid, dungeonPlugin, { cmd: 'dungeon', args: ['leave'] })
    const after = getPlayer(db, req.jid)
    ok(res, { log: leaveLog, state: serializeDungeonState(after) })
  }))

  // ── GET /api/dungeon/list — unlocked/locked dungeons + per-dungeon progress ─
  router.get('/list', requirePlayer, wrap(async (req, res) => {
    const player = getPlayer(db, req.jid)
    let eventActive = false
    try { eventActive = isEventActive(db) } catch { eventActive = false }

    const dungeons = Object.values(locationsMap)
      .filter(l => l.type === 'dungeon')
      .filter(l => l.id !== THE_END_LOCATION_ID || eventActive)
      .map(l => {
        const prog = player?.dungeonProgress?.[l.id] ?? null
        return {
          id: l.id,
          name: l.name ?? l.id,
          floors: l.floors ?? null,
          levelRange: Array.isArray(l.levelRange) ? l.levelRange : null,
          entryLevel: l.entryLevel ?? null,
          travelCost: l.travelCost ?? 0,
          prerequisite: l.prerequisite ?? null,
          prerequisiteName: l.prerequisite ? (locationsMap[l.prerequisite]?.name ?? l.prerequisite) : null,
          swarm: SWARM_DUNGEONS.has(l.id),
          unlocked: isDungeonUnlocked(player, l.id),
          conquered: !!prog?.conquered,
          highestFloor: prog?.highestFloor ?? 0,
        }
      })

    ok(res, { dungeons, runsRemaining: safeRuns(player) })
  }))
}
