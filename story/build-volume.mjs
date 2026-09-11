/**
 * build-volume.mjs — assembles data/story-beyond-the-astral.json out of the
 * per-chapter fragments in story/chapters-json/.
 *
 *   node story/build-volume.mjs
 *
 * WHY THIS EXISTS
 * The volume is one JSON document at runtime (lib/game-data.js loads exactly
 * one file per volume — see story/json-schema-spec.md), but 20 chapters of
 * branching prose in one file is unreviewable: a single chapter's diff is
 * buried in a 300KB blob and a stray comma breaks all twenty. So the prose is
 * authored one chapter per file and stitched here.
 *
 * story/chapters-json/_volume.json  — everything above "chapters"
 * story/chapters-json/chNN.json     — one chapter object each, NN = 01..20
 *
 * data/story-beyond-the-astral.json is GENERATED. Edit the fragments, then
 * re-run this. Editing the generated file directly works until the next
 * build silently reverts it.
 *
 * The validation pass below is the real point of the script. It catches the
 * three mistakes that are invisible in JSON but break at play time:
 *   - a duplicate choice key, which makes two different choices share one
 *     recorded pick (lib/story-engine.js's choiceKeyFor / choiceKeys)
 *   - a choice beat with no key while carrying per-option beats, which falls
 *     back to an option-id-derived key and can collide
 *   - a 4th option, which lib/interactive-buttons.js's sendButtons silently
 *     drops from the button row (it slices to 3) while it stays pickable by
 *     typing — i.e. an option some players can never see
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fragDir = path.join(here, 'chapters-json')
const outFile = path.join(here, '..', 'data', 'story-beyond-the-astral.json')

const read = f => JSON.parse(readFileSync(path.join(fragDir, f), 'utf8'))

const volume = read('_volume.json')
const chapterFiles = readdirSync(fragDir).filter(f => /^ch\d\d\.json$/.test(f)).sort()
if (!chapterFiles.length) throw new Error('no chNN.json fragments found in ' + fragDir)

volume.chapters = chapterFiles.map(read)

// ------------------------------------------------------------------ validate
const problems = []
const stats = []

/** Walks a beat list plus every per-option beat list nested inside it. */
function walk(beats, visit, depth = 0) {
  for (const beat of beats ?? []) {
    visit(beat, depth)
    for (const option of beat.options ?? []) {
      if (option.beats?.length) walk(option.beats, visit, depth + 1)
    }
  }
}

function allBeatLists(chapter) {
  const lists = [chapter.beats ?? []]
  if (chapter.branch) {
    for (const c of Object.values(chapter.branch.cases ?? {})) lists.push(c)
    lists.push(chapter.branch.default ?? [], chapter.branch.resumeBeats ?? [])
  }
  return lists
}

const VALID_TYPES = new Set(['line', 'dialogue', 'choice', 'plea', 'battle'])

volume.chapters.forEach((chapter, i) => {
  const where = `ch${String(chapter.num).padStart(2, '0')} (${chapter.id})`
  if (chapter.num !== i + 1) problems.push(`${where}: num is ${chapter.num}, expected ${i + 1}`)
  const prev = volume.chapters[i - 1]
  const expectedRequires = prev ? prev.id : null
  if ((chapter.requires ?? null) !== expectedRequires) {
    problems.push(`${where}: requires is ${JSON.stringify(chapter.requires ?? null)}, expected ${JSON.stringify(expectedRequires)}`)
  }

  const keys = new Set()
  let total = 0, choices = 0, branchBeats = 0, pleas = 0, battles = 0

  for (const list of allBeatLists(chapter)) {
    walk(list, (beat, depth) => {
      total++
      if (depth > 0) branchBeats++
      if (!VALID_TYPES.has(beat.type)) problems.push(`${where}: unknown beat type ${JSON.stringify(beat.type)}`)
      if (typeof beat.text !== 'string' || !beat.text.trim()) problems.push(`${where}: a ${beat.type} beat has no text`)

      if (beat.type === 'plea') {
        if (!beat.stakes) problems.push(`${where}: plea beat has no stakes block`)
        else if (!beat.stakes.scripted && typeof beat.stakes.chance !== 'number') {
          problems.push(`${where}: unscripted plea has no numeric chance`)
        }
      }
      if (beat.type === 'battle') {
        if (!beat.encounter) problems.push(`${where}: battle beat has no encounter block`)
        else if (!beat.encounter.onWin) problems.push(`${where}: battle beat has no onWin text`)
      }

      if (beat.type !== 'choice') {
        if (beat.options) problems.push(`${where}: a ${beat.type} beat has options`)
        return
      }
      choices++
      const opts = beat.options ?? []
      if (opts.length < 2) problems.push(`${where}: choice ${beat.key ?? '(no key)'} has ${opts.length} option(s)`)
      if (opts.length > 3) problems.push(`${where}: choice ${beat.key ?? '(no key)'} has ${opts.length} options — sendButtons only renders 3`)

      const ids = new Set()
      for (const o of opts) {
        if (!o.id) problems.push(`${where}: choice ${beat.key ?? '(no key)'} has an option with no id`)
        if (ids.has(o.id)) problems.push(`${where}: choice ${beat.key ?? '(no key)'} repeats option id ${o.id}`)
        ids.add(o.id)
        if (!o.label) problems.push(`${where}: option ${o.id} has no label`)
      }

      const carriesBeats = opts.some(o => o.beats?.length)
      if (!beat.key) {
        if (carriesBeats) problems.push(`${where}: a choice with per-option beats has no key`)
        return
      }
      if (keys.has(beat.key)) problems.push(`${where}: duplicate choice key ${beat.key}`)
      keys.add(beat.key)
    })
  }

  for (const list of allBeatLists(chapter)) {
    walk(list, beat => { if (beat.type === 'plea') pleas++; if (beat.type === 'battle') battles++ })
  }

  stats.push({ ch: chapter.num, title: chapter.title, beats: total, choices, branchBeats, pleas, battles })
})

const globalKeys = new Map()
for (const chapter of volume.chapters) {
  for (const list of allBeatLists(chapter)) {
    walk(list, beat => {
      if (beat.type !== 'choice' || !beat.key) return
      if (globalKeys.has(beat.key)) {
        problems.push(`choice key ${beat.key} used in both ch${globalKeys.get(beat.key)} and ch${chapter.num}`)
      }
      globalKeys.set(beat.key, chapter.num)
    })
  }
}

for (const row of stats) {
  console.log(
    `ch${String(row.ch).padStart(2, '0')}  ${String(row.beats).padStart(4)} beats  ` +
    `${String(row.choices).padStart(2)} choices  ${String(row.branchBeats).padStart(3)} branch  ` +
    `${row.pleas ? row.pleas + ' plea ' : '      '}${row.battles ? row.battles + ' battle' : ''}  ${row.title}`,
  )
}
const totals = stats.reduce((a, r) => ({ beats: a.beats + r.beats, choices: a.choices + r.choices }), { beats: 0, choices: 0 })
console.log(`\n${volume.chapters.length} chapters · ${totals.beats} beats · ${totals.choices} choices`)

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

writeFileSync(outFile, JSON.stringify(volume, null, 2) + '\n')
console.log(`\nwrote ${path.relative(path.join(here, '..'), outFile)}`)
