/**
 * lib/dungeon-lore.js — one voice per dungeon, one line per monster family.
 *
 * Regulars in data/monsters.json have no lore of their own, and they should
 * not: 929 essays would be a catalog, not a world. Families are the name
 * tails that already spawn. Floor 100 is the only master. Chalk rumors are
 * fine. Copy is player-facing: no em or en dashes.
 */

export const DUNGEON_NAMES = {
  entry_tower: 'Entry Tower',
  gambits_dungeon: "Gambit's Dungeon",
  centurions_dungeon: "Centurion's Dungeon",
  astral_tower: 'Astral Tower',
  eternal_dungeon: 'Eternal Dungeon',
  season_01_ruins: 'the Sunken Ruins',
  caged_dimension: 'the Caged Dimension',
  the_end: 'the Rift',
}

const STRATA = {
  entry_tower: [
    { until: 20, name: 'The cellar stair', line: 'Damp stone, lamp smoke, and things that have not learned your name yet.' },
    { until: 50, name: 'The lived-in floors', line: 'Old rooms, broken furniture, and monsters that treat the tower like a house.' },
    { until: 99, name: 'The high stair', line: 'The wind gets in. The guild chalk gets rarer. The things up here have been waiting.' },
  ],
  gambits_dungeon: [
    { until: 30, name: 'The first mirror', line: 'The hall looks like the one you just left. It is not obliged to be.' },
    { until: 70, name: 'The bluff', line: 'Decoys, laughter, and doors that open onto the door you came through.' },
    { until: 99, name: 'The last trick', line: 'Even the chalk marks argue with each other. Trust the floor number, not the room.' },
  ],
  centurions_dungeon: [
    { until: 30, name: 'The outer drill', line: 'Boots, orders, and a war that does not know the town stopped watching.' },
    { until: 70, name: 'The inner gate', line: 'The legions here still form ranks. They are not a rumor. They are a habit.' },
    { until: 99, name: 'The last wall', line: 'Iron, banners, and the sense that the gate above has a name the halls will not say.' },
  ],
  astral_tower: [
    { until: 30, name: 'The near rift', line: 'Stone still pretends to be stone. The things in it do not pretend to be flesh.' },
    { until: 70, name: 'The drift', line: 'Light where a body should be. The tower is a direction, not a building.' },
    { until: 99, name: 'The far side', line: 'You can hear the town if you try. It does not hear you back.' },
  ],
  eternal_dungeon: [
    { until: 30, name: 'The first dark', line: 'Cold that is not weather. The guild stopped sending pairs past this mark.' },
    { until: 70, name: 'The long walk', line: 'Names on the walls, most of them crossed out. Yours is not there yet.' },
    { until: 99, name: 'The last page', line: 'The air feels written. Whatever keeps the top floor has already read you.' },
  ],
  season_01_ruins: [
    { until: 40, name: 'The tide chapel', line: 'Water in the aisles, and a hymn that does not need singers.' },
    { until: 99, name: 'The drowned choir', line: 'The spires are still standing. The prayer is not friendly.' },
  ],
  caged_dimension: [
    { until: 9999, name: 'The cage', line: 'No master, no last floor. The guild stopped writing names after the first week.' },
  ],
}

const MASTERS = {
  entry_tower: 'The guild will not describe what waits at the top. They only say the lamp goes out before you see Syclila.',
  gambits_dungeon: 'Kikaru keeps the last floor. Nothing you trust on the way up is obliged to be real.',
  centurions_dungeon: 'Celestia holds the last gate. The legions below her are the test, not the master.',
  astral_tower: 'Bam waits where the tower stops being stone. The things on the lower floors were never flesh.',
  eternal_dungeon: 'Esteria is the last name on the board. Most slips about her have been crossed out.',
  season_01_ruins: 'The drowned choir still has a voice. The hall calls it the Last Prayer, and they do not send anyone alone.',
  caged_dimension: 'There is no master here. The grind is the whole place.',
}

const TOLLS = {
  entry_tower: (n) => `The gate clerk takes *${n} Solars* and hands you a lamp.`,
  gambits_dungeon: (n) => `A clerk who might be real takes *${n} Solars* and does not wish you luck.`,
  centurions_dungeon: (n) => `The toll is *${n} Solars*. The clerk stamps it like a muster roll.`,
  astral_tower: (n) => `The booth takes *${n} Solars*. The hand that takes them is only mostly there.`,
  eternal_dungeon: (n) => `*${n} Solars* for the last descent. The clerk does not look up.`,
  season_01_ruins: (n) => `The tide clerk takes *${n} Solars* and tells you not to answer the hymn.`,
  caged_dimension: (n) => `The cage takes *${n} Solars* at the door. It does not offer a receipt.`,
}

/** Family lines keyed by a word that already appears in the monster's name. */
const FAMILIES = {
  entry_tower: [
    { words: ['slime'], line: 'Slimes own the wet stair. They do not hunt. They arrive.' },
    { words: ['gargoyle'], line: 'Gargoyles were the tower\'s ornaments until they decided to leave the eaves.' },
    { words: ['bat'], line: 'Bats in this tower are not a nuisance. They are a ceiling that bites.' },
    { words: ['harpy'], line: 'Harpies take the high turns and drop what they do not like.' },
    { words: ['brute'], line: 'Brutes are what the tower does with a body that would not stay down.' },
    { words: ['wretch'], line: 'Wretches used to be people. The tower kept the walk and lost the rest.' },
    { words: ['creeper'], line: 'Creepers hug the wall and wait for the lamp to be the interesting thing.' },
    { words: ['specter'], line: 'Specters here are thin and local. They know the stair better than you do.' },
  ],
  gambits_dungeon: [
    { words: ['decoy'], line: 'A decoy wants you to swing at the wrong one. Sometimes both are wrong.' },
    { words: ['illusion'], line: 'Illusions in Gambit\'s hall spend your turn and keep theirs.' },
    { words: ['jester'], line: 'Jesters laugh because the joke already landed.' },
    { words: ['marionette'], line: 'Marionettes move like a person who is late to their own body.' },
    { words: ['lure'], line: 'Lures stand where a friend would stand. That is the whole trick.' },
    { words: ['bluff'], line: 'A bluff folds if you hit it. The trouble is knowing which swing was the real one.' },
    { words: ['doppel'], line: 'A doppel wears a face you almost trust. Do not finish the thought.' },
    { words: ['gambit'], line: 'Anything that still uses his name is a piece, not the player.' },
  ],
  centurions_dungeon: [
    { words: ['lancer'], line: 'Lancers keep the line. The line does not care that you are one person.' },
    { words: ['phalanx'], line: 'A phalanx is a door that decided to walk.' },
    { words: ['gladiator'], line: 'Gladiators are still performing. The crowd left years ago.' },
    { words: ['ironclad'], line: 'Ironclads are armor that kept the job after the soldier did not.' },
    { words: ['praetor'], line: 'Praetors give orders the halls still obey.' },
    { words: ['sentinel'], line: 'Sentinels do not chase. They occupy.' },
    { words: ['bastion'], line: 'A bastion is a wall with a grudge.' },
    { words: ['centurion'], line: 'Centurions are the habit of command. The fortress still has the habit.' },
  ],
  astral_tower: [
    { words: ['wraith'], line: 'Wraiths here are not ghosts of people. They are weather with a temper.' },
    { words: ['specter'], line: 'Specters on this side of the rift do not remember having bodies.' },
    { words: ['remnant'], line: 'Remnants are what a spell leaves when it refuses to end.' },
    { words: ['drifter'], line: 'Drifters have no road. They have a direction, and you are in it.' },
    { words: ['watcher'], line: 'Watchers do not attack first. They decide you have already happened.' },
    { words: ['nebula'], line: 'A nebula in a corridor is a star that took a wrong turn.' },
    { words: ['flux'], line: 'Flux does not hold a shape long enough to hate you. It still hits.' },
    { words: ['comet'], line: 'Comets in the tower are motion that grew a mouth.' },
  ],
  eternal_dungeon: [
    { words: ['lich'], line: 'Liches keep their names. That is worse than forgetting them.' },
    { words: ['wail'], line: 'Wails are grief that learned the layout.' },
    { words: ['phantom'], line: 'Phantoms pass through the oath you thought was armor.' },
    { words: ['harbinger'], line: 'A harbinger is not the end. It is the announcement.' },
    { words: ['vessel'], line: 'Vessels are walking containers. Do not ask for what.' },
    { words: ['scourge'], line: 'Scourges do not negotiate with the living. They edit them.' },
    { words: ['warden'], line: 'Wardens still think this place is a prison. They are not wrong.' },
    { words: ['soul'], line: 'Soul-things here are loose pages. Some of them used to be yours.' },
  ],
  season_01_ruins: [
    { words: ['choir', 'hymn', 'acolyte', 'drowned'], line: 'The choir does not need air. It needs an audience.' },
  ],
  caged_dimension: [
    { words: [], line: 'Nothing in the cage was meant to have a name. The hall gave up naming them.' },
  ],
}

const FALLBACK = {
  entry_tower: 'Another thing the tower grew when nobody was sweeping.',
  gambits_dungeon: 'If it looks familiar, that is the trick working.',
  centurions_dungeon: 'The fortress still issues this one a rank.',
  astral_tower: 'Not flesh. Not a rumor. In the way.',
  eternal_dungeon: 'The dark kept this one because it was useful.',
  season_01_ruins: 'The hymn has another voice. It noticed you.',
  caged_dimension: 'The cage does not explain its tenants.',
}

export function stratumFor(locId, floor) {
  const bands = STRATA[locId]
  if (!bands) return null
  const n = Number(floor) || 1
  return bands.find(b => n <= b.until) ?? bands[bands.length - 1]
}

export function tollVoice(locId, amount) {
  const fn = TOLLS[locId]
  if (!fn) return `Travel cost: *${amount} Solars* paid.`
  return fn(amount)
}

/**
 * Short block for .enter. Null for places that already have their own script
 * (the End). Does not pretend the old floor 10 to 90 bosses still spawn.
 */
export function entryBrief(loc, floor, resuming) {
  if (!loc || loc.id === 'the_end') return ''
  const stratum = stratumFor(loc.id, floor)
  const lines = []
  if (stratum) lines.push(`*${stratum.name}.* ${stratum.line}`)
  if (resuming) lines.push(`Your chalk mark is still on floor ${floor}.`)
  else lines.push('You start where the guild marks still make sense.')
  const rumor = MASTERS[loc.id]
  const top = (loc.bossFloors ?? [])[(loc.bossFloors ?? []).length - 1] ?? loc.floors
  if (rumor && (top == null || floor < top)) lines.push(rumor)
  return lines.join('\n')
}

/** One family line for a swarm or 1v1 regular. Empty if this place has no voice. */
export function encounterLine(locId, name) {
  if (!locId) return ''
  const families = FAMILIES[locId]
  const lower = String(name ?? '').toLowerCase()
  if (families) {
    const hit = families.find(f => f.words.length && f.words.some(w => lower.includes(w)))
    if (hit) return hit.line
    const any = families.find(f => f.words.length === 0)
    if (any) return any.line
  }
  return FALLBACK[locId] ?? ''
}

export function familyIndex() {
  const out = []
  for (const [locId, families] of Object.entries(FAMILIES)) {
    for (const family of families) {
      if (!family.words.length) continue
      out.push({
        locId,
        dungeon: DUNGEON_NAMES[locId] ?? locId,
        words: family.words,
        line: family.line,
      })
    }
  }
  return out
}
