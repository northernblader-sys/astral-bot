/**
 * lib/soldier-names.js — the local soldier-name generator.
 *
 * Empire officers (Veteran and above) are named records. Rather than call an
 * external name API (latency, rate limits, an outage that blocks promotions),
 * names are minted here from pools combined on the fly: given name plus
 * surname, with an occasional epithet. Tens of thousands of distinct names,
 * instantly, offline.
 *
 * A clean seam is left for a future service: everything goes through the
 * `provider` slot, and setNameProvider() can swap in an async-free generator
 * later without touching any caller. Callers only ever import soldierName().
 *
 * Pure and stateless apart from the provider slot. Uses Math.random by default;
 * pass your own rng to generateSoldierName for deterministic tests.
 */

const GIVEN = [
  'Corvin', 'Alda', 'Bram', 'Sela', 'Dorn', 'Yara', 'Fenn', 'Mira', 'Garrek', 'Ysolde',
  'Halden', 'Rina', 'Osric', 'Bertha', 'Cael', 'Nessa', 'Torv', 'Elowen', 'Marek', 'Sig',
  'Rohan', 'Wyn', 'Aldous', 'Petra', 'Kess', 'Doran', 'Isolde', 'Varek', 'Lenna', 'Bael',
  'Odric', 'Tamsin', 'Gareth', 'Vera', 'Hollis', 'Rune', 'Maddox', 'Ilsa', 'Cade', 'Brenna',
  'Soren', 'Nadia', 'Emeric', 'Perrin', 'Talia', 'Joran', 'Selwyn', 'Alys', 'Draven', 'Faye',
]

const SURNAME = [
  'Ashvale', 'Ironmoor', 'Blackbriar', 'Stormhold', 'Greycloak', 'Thornwood', 'Duskbane', 'Coldwater',
  'Redfern', 'Highmarch', 'Wolfsbane', 'Stonefield', 'Ravenshade', 'Oakenshield', 'Frostmere', 'Emberfall',
  'Larkspur', 'Grimwald', 'Fairwind', 'Nightingale', 'Harrow', 'Vance', 'Marsh', 'Kell',
  'Bracken', 'Selby', 'Voss', 'Ambry', 'Crane', 'Holt', 'Merrow', 'Ryecroft',
  'Dunmore', 'Whitlock', 'Pellard', 'Fenwick', 'Aldergrove', 'Brightwater', 'Storne', 'Vexley',
]

const EPITHET = [
  'the Bold', 'the Steady', 'the Grim', 'the Quick', 'Ironhand', 'the Unbroken', 'of the Ninth',
  'the Vigilant', 'Longstride', 'the Loyal', 'Shieldborn', 'the Elder', 'the Sure', 'Trueshot',
]

/** Deterministic index pick from an rng in [0, 1). */
function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)]
}

/**
 * Mints one soldier name. Pass an rng (a function returning [0, 1)) for
 * deterministic output in tests; defaults to Math.random. About one name in
 * seven picks up an epithet, for flavor without overusing it.
 */
export function generateSoldierName(rng = Math.random) {
  const given = pick(GIVEN, rng)
  const surname = pick(SURNAME, rng)
  let name = `${given} ${surname}`
  if (rng() < 0.15) name += ` ${pick(EPITHET, rng)}`
  return name
}

// ── Provider seam ────────────────────────────────────────────────────────

let provider = generateSoldierName

/** Swap the name source (e.g. a future service). fn takes no args and returns a name string. */
export function setNameProvider(fn) {
  provider = typeof fn === 'function' ? fn : generateSoldierName
}

/** Restore the built-in local generator. */
export function resetNameProvider() {
  provider = generateSoldierName
}

/** The one call sites use. Goes through the current provider. */
export function soldierName() {
  return provider()
}

/**
 * A townsfolk name: given plus surname from the same pools, never an epithet.
 * Empire residents (see the Townsfolk section of lib/empire-engine.js) are
 * bakers and candlemakers, not veterans, so "Bram Ryecroft the Unbroken" reads
 * wrong on one. Deliberately NOT routed through the provider seam above: that
 * seam exists so army officer names can be swapped for a service later, and
 * folk names should not silently change with it.
 */
export function townsfolkName(rng = Math.random) {
  return `${pick(GIVEN, rng)} ${pick(SURNAME, rng)}`
}

/** Sizes exposed for a test that wants to assert the pool is large. */
export const NAME_POOL_SIZE = GIVEN.length * SURNAME.length
