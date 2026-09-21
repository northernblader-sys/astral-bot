/**
 * menu-ten-sections.test.mjs — pins the 2026-09-21 menu rework.
 *
 * The overview is exactly TEN sections now (was 24 raw plugin categories).
 * The old categories survive as sub-sections inside the drill-downs, and the
 * complaint that started it is pinned here: "Season Packs" is NOT a top-level
 * category anymore, it is a sub-section of Season (`.menu Season` shows the
 * season, the packs, and the event commands together).
 *
 * Also pins the copy rule on the new section labels and blurbs: no em or en
 * dashes anywhere player-facing.
 *
 * Run:  node test/menu-ten-sections.test.mjs
 */
import assert from 'node:assert/strict'

const { SECTIONS } = await import('../plugins/menu.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`FAIL  ${name}\n      ${err.message}`) }
}

// Every category key the plugin registry can produce (the values plugins put
// in `category:`, plus 'misc' for the ones that don't).
const KNOWN_CATEGORIES = [
  'account', 'progression', 'social', 'character', 'cards', 'pokemon',
  'evolution', 'combat', 'battle', 'party', 'pvp', 'dungeon', 'story',
  'economy', 'inventory', 'town', 'empire', 'housing', 'season', 'packs',
  'event', 'group', 'moderation', 'admin', 'utility', 'media', 'download',
  'misc',
]

const sectionOfCat = (cat) => SECTIONS.find((s) => s.subs.some((sub) => sub.cat === cat))

await test('the overview is exactly ten sections', () => {
  assert.equal(SECTIONS.length, 10)
})

await test('every known category folds into exactly one section', () => {
  for (const cat of KNOWN_CATEGORIES) {
    const hits = SECTIONS.filter((s) => s.subs.some((sub) => sub.cat === cat))
    assert.equal(hits.length, 1, `${cat} must belong to exactly one section (found ${hits.length})`)
  }
})

await test('Season Packs is a sub-section of Season (the original complaint)', () => {
  assert.equal(sectionOfCat('packs').key, 'season')
  assert.equal(sectionOfCat('season').key, 'season')
  assert.equal(sectionOfCat('event').key, 'season', 'events ride along with the season')
  const season = SECTIONS.find((s) => s.key === 'season')
  const labels = season.subs.map((sub) => sub.label)
  assert.ok(labels.includes('Season Packs'), 'the name survives as a sub-header')
})

await test('the fights sit together: pvp and party fold into Combat', () => {
  assert.equal(sectionOfCat('pvp').key, 'combat')
  assert.equal(sectionOfCat('party').key, 'combat')
  assert.equal(sectionOfCat('battle').key, 'combat')
})

await test('section keys and labels are unique', () => {
  const keys = new Set(SECTIONS.map((s) => s.key))
  const labels = new Set(SECTIONS.map((s) => s.label.toLowerCase()))
  assert.equal(keys.size, 10)
  assert.equal(labels.size, 10)
})

await test('each section carries an emoji, a label, and a blurb', () => {
  for (const s of SECTIONS) {
    assert.ok(s.emoji?.length > 0, `${s.key} emoji`)
    assert.ok(s.label?.length > 0, `${s.key} label`)
    assert.ok(s.blurb?.length > 10, `${s.key} blurb`)
    assert.ok(s.subs.length > 0, `${s.key} has at least one sub-section`)
  }
})

await test('section copy obeys the no-dash rule', () => {
  const text = SECTIONS.map((s) => `${s.label} ${s.blurb} ${s.subs.map((x) => x.label).join(' ')}`).join('\n')
  assert.ok(!/[—–]/.test(text), 'no em or en dashes in menu copy')
})

// ── summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
