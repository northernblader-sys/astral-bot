/**
 * pvp-gambits.js — a chess-engine-style commentator for duels.
 *
 * Chess engines name the shape of a game as it forms: 1.e4 is the "King's
 * Pawn Opening", 1.e4 c5 is the "Sicilian Defense", and so on. This does the
 * same for PvP: it watches the sequence of moves both players make and, when
 * the duel first reaches a recognizable shape, hands back a named line for the
 * bot to announce in the battle text.
 *
 * The "board" here is just the ordered list of executed moves (the ply log),
 * where each entry is one of the PvP actions: 'attack', 'skill', 'ability',
 * 'defend', 'cinderverdict'. The challenger moves first, so log[0] is ply 1.
 *
 * detectGambits(log, seen) is pure: give it the full move log and the names
 * already announced this duel, and it returns only the NEWLY-recognized lines.
 * pvp.js stores the log + the seen-names on both players' battleState (mirrored
 * each turn) so detection sees the whole game regardless of who acts next.
 *
 * Everything below is data — add a row to OPENINGS / VARIATIONS / MOTIFS and it
 * just works. No detection code needs touching to add a new named line.
 */

// ── Openings — named by the FIRST move of the duel (ply 1, the challenger) ──
const OPENINGS = {
  attack:        { name: 'Vanguard Opening',    flavor: 'a straight blade, first thing.' },
  skill:         { name: 'Arcane Opening',      flavor: 'magic drawn on the opening breath.' },
  defend:        { name: 'Turtle Opening',      flavor: 'shield up before a word is said.' },
  ability:       { name: "Artificer's Opening", flavor: 'a crafted trick, sprung early.' },
  cinderverdict: { name: 'The Wither Gambit',   flavor: 'the entire verdict, spent on move one.' },
}
const GENERIC_OPENING = { name: 'Irregular Opening', flavor: 'an unorthodox first move.' }

// ── Variations — named by the first TWO half-moves: challenger, then answer ──
// Keyed "firstMove>secondMove".
const VARIATIONS = {
  'attack>attack':   { name: 'Open Duel',             flavor: 'both blades meet in the center, no fear.' },
  'attack>defend':   { name: 'Counterpunch Defense',  flavor: 'let the first blow ring off the shield.' },
  'attack>skill':    { name: 'Bait & Cast',           flavor: 'answer steel with sorcery.' },
  'attack>ability':  { name: 'Trap Response',         flavor: 'meet the rush with a prepared trick.' },
  'skill>skill':     { name: "Mage's Mirror",         flavor: 'spell for spell, a war of MP.' },
  'skill>attack':    { name: 'Interrupt Line',        flavor: 'close the gap before the cast settles.' },
  'skill>defend':    { name: 'Warded Response',        flavor: 'brace against the opening cast.' },
  'defend>defend':   { name: 'The Standoff',           flavor: 'two turtles. Someone has to blink.' },
  'defend>attack':   { name: 'Punish the Patient',     flavor: 'strike the one who waited too long.' },
  'defend>skill':    { name: 'Patient Sorcerer',       flavor: 'a shield, then a spell through the gap.' },
  'cinderverdict>defend':  { name: 'Wither Gambit, Declined', flavor: 'shield raised against the verdict.' },
  'cinderverdict>attack':  { name: 'Wither Gambit, Accepted', flavor: 'trade blows straight through the fire.' },
  'cinderverdict>skill':   { name: 'Wither Countergambit',    flavor: 'answer the verdict with your own power.' },
}
function genericVariation(a, b) {
  return { name: 'Irregular Line', flavor: `an off-book answer: ${b} against ${a}.` }
}

// ── Motifs — shapes that can arise at ANY point in the duel ─────────────────
// Each is announced once, the first time its trigger fires.
const MOTIFS = {
  berserker: { name: "Berserker's Rush", flavor: 'three unbroken strikes, nobody is blinking.' },
  ironWall:  { name: 'The Iron Wall',    flavor: 'shields locked, turn after turn. A siege.' },
  barrage:   { name: 'Sustained Barrage', flavor: 'the air keeps cracking, spell after spell.' },
  scorched:  { name: 'Scorched Earth',    flavor: 'the verdict, held back until now. Everything, at once.' },
}

/** How many times `action` repeats at the very end of the log. */
function tailRun(log, action) {
  let n = 0
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i] === action) n++
    else break
  }
  return n
}

/**
 * Given the full ply log and the names already announced this duel, return the
 * newly-recognized lines as [{ tag, name, flavor }]. `tag` is the category the
 * bot prefixes the announcement with (Opening / Variation / Gambit / Motif).
 */
export function detectGambits(log, seen = []) {
  const out = []
  const has = new Set(seen)
  const add = (tag, entry) => {
    if (!entry || has.has(entry.name)) return
    has.add(entry.name)
    out.push({ tag, name: entry.name, flavor: entry.flavor })
  }

  // Opening — the very first move.
  if (log.length === 1) {
    add('Opening', OPENINGS[log[0]] ?? GENERIC_OPENING)
  }

  // Variation — the challenger's move and the responder's answer.
  if (log.length === 2) {
    add('Variation', VARIATIONS[`${log[0]}>${log[1]}`] ?? genericVariation(log[0], log[1]))
  }

  // Motifs — checked against the tail of the log on every move.
  const last = log[log.length - 1]
  if (tailRun(log, 'attack') >= 3) add('Motif', MOTIFS.berserker)
  if (tailRun(log, 'defend') >= 4) add('Motif', MOTIFS.ironWall)  // 4 plies = 2 full defends each
  if (tailRun(log, 'skill')  >= 3) add('Motif', MOTIFS.barrage)
  if (last === 'cinderverdict' && log.length > 1) add('Gambit', MOTIFS.scorched)

  return out
}

/**
 * Render recognized lines as an engine-style banner for the battle text.
 * Returns '' when there's nothing new to announce.
 */
export function formatGambits(entries) {
  if (!entries || !entries.length) return ''
  return entries
    .map(e => `📖 *${e.tag}:* *${e.name}*\n   _“${e.flavor}”_`)
    .join('\n') + '\n'
}

// ── Catalog for the .gambits command ────────────────────────────────────────
// How each motif is reached during a duel, in plain words. Keyed to MOTIFS.
const MOTIF_TRIGGERS = {
  berserker: 'Land three attacks in a row (either fighter).',
  ironWall:  'Both fighters defend, twice each, back to back.',
  barrage:   'Cast three skills in a row (either fighter).',
  scorched:  'Fire the Cinderverdict on any move after the first.',
}

/**
 * A flat, display-ready list of every named line for the .gambits command.
 * `prefix` is the bot command prefix so the trigger strings show the exact
 * moves a player types. Reads the same OPENINGS / VARIATIONS / MOTIFS tables
 * the detector uses, so the listing can never drift from what fires in battle.
 */
export function listGambits(prefix = '.') {
  const cmd = {
    attack:        `${prefix}pvp attack`,
    skill:         `${prefix}pvp skill <name>`,
    ability:       `${prefix}pvp ability <name>`,
    defend:        `${prefix}pvp defend`,
    cinderverdict: `${prefix}pvp cinderverdict`,
  }

  const openings = Object.entries(OPENINGS).map(([move, o]) => ({
    name: o.name,
    flavor: o.flavor,
    trigger: `Open the duel with *${cmd[move]}*.`,
  }))

  const variations = Object.entries(VARIATIONS).map(([key, v]) => {
    const [a, b] = key.split('>')
    return {
      name: v.name,
      flavor: v.flavor,
      trigger: `Challenger *${cmd[a]}*, opponent answers *${cmd[b]}*.`,
    }
  })

  const motifs = Object.entries(MOTIFS).map(([tag, m]) => ({
    name: m.name,
    flavor: m.flavor,
    trigger: MOTIF_TRIGGERS[tag] ?? '',
  }))

  return { openings, variations, motifs }
}
