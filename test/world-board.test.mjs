/**
 * world-board.test.mjs — the guild board, the streets, and the command list.
 *
 * Pins the ship: 50 slips, 3 posted a day, the sent pay bands, one Gem a day,
 * fetch slips that consume buyable potions, and owner tools left off the
 * all-commands list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SLIPS, POSTED_COUNT, TURNIN_CAP, GEM_CAP,
  postedIds, postedSlips, ensureBoardState, takeSlip, abandonSlip,
  noteVisit, noteTalk, noteKill, turnIn, startOfDay,
} from '../lib/guild-board.js'
import { TOWN_SPOTS, TOWN_NPCS, townWalkBlock, findSpot, findNpc } from '../lib/town.js'
import { entryBrief, encounterLine } from '../lib/dungeon-lore.js'
import { isOwnerCommand, playerSubcommands, buildCommandPages, cleanCopy } from '../lib/command-list.js'

const BANDS = {
  copper: { min: 250, max: 450, fame: 2, gems: 0 },
  iron:   { min: 550, max: 900, fame: 4, gems: 0 },
  silver: { min: 1100, max: 1700, fame: 6, gems: 0 },
  gold:   { min: 2000, max: 3200, fame: 8, gems: 1 },
}

function player(extra = {}) {
  return {
    level: 100,
    guildId: 'emberwake',
    townSpot: null,
    inventory: [],
    wallet: { solars: 0, gems: 0 },
    fame: 0,
    inBattle: false,
    inDungeon: false,
    ...extra,
  }
}

test('catalog is 50 slips in the sent bands, never Monds', () => {
  assert.equal(SLIPS.length, 50)
  assert.equal(POSTED_COUNT, 3)
  assert.equal(TURNIN_CAP, 3)
  assert.equal(GEM_CAP, 1)
  const ranks = { copper: 0, iron: 0, silver: 0, gold: 0 }
  for (const slip of SLIPS) {
    ranks[slip.rank] += 1
    const band = BANDS[slip.rank]
    assert.ok(band, slip.id)
    assert.ok(slip.reward.solars >= band.min && slip.reward.solars <= band.max, `${slip.id} solars`)
    assert.equal(slip.reward.fame, band.fame, `${slip.id} fame`)
    assert.equal(slip.reward.gems ?? 0, band.gems, `${slip.id} gems`)
    const blob = JSON.stringify(slip).toLowerCase()
    assert.equal(blob.includes('mond'), false, slip.id)
    assert.equal(/[—–]/.test(JSON.stringify(slip)), false, `${slip.id} dash`)
  }
  assert.deepEqual(ranks, { copper: 18, iron: 14, silver: 12, gold: 6 })
})

test('fetch slips name buyable potions, not scrap or ore', () => {
  const items = JSON.parse(readFileSync(new URL('../data/items.json', import.meta.url)))
  const flat = []
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      if (node.id && node.buyPrice != null) flat.push(node)
      Object.values(node).forEach(walk)
    }
  }
  walk(items)
  const byId = Object.fromEntries(flat.map(i => [i.id, i]))
  const delivers = SLIPS.flatMap(s => s.steps.filter(st => st.kind === 'deliver'))
  assert.ok(delivers.length >= 4)
  for (const step of delivers) {
    const item = byId[step.item]
    assert.ok(item, `${step.item} is not a buyable catalog item`)
    assert.equal(item.type, 'consumable', step.item)
    assert.ok(item.buyPrice > 0, step.item)
  }
})

test('the day posts one copper, one iron, and one harder slip', () => {
  const day = startOfDay(Date.UTC(2026, 8, 23))
  const posted = postedSlips(day)
  assert.equal(posted.length, 3)
  assert.deepEqual(postedIds(day), postedIds(day))
  assert.notDeepEqual(postedIds(day), postedIds(day + 86_400_000))
  assert.equal(posted.filter(s => s.rank === 'copper').length, 1)
  assert.equal(posted.filter(s => s.rank === 'iron').length, 1)
  assert.equal(posted.filter(s => s.rank === 'silver' || s.rank === 'gold').length, 1)
})

test('taking a slip needs a hall, and only one can be held', () => {
  const day = startOfDay()
  const [id] = postedIds(day)
  const guildless = player({ guildId: null })
  assert.equal(takeSlip(guildless, id, day).reason, 'noguild')

  const held = player()
  assert.equal(takeSlip(held, id, day).ok, true)
  const other = postedIds(day).find(x => x !== id)
  assert.equal(takeSlip(held, other, day).reason, 'busy')
  assert.equal(takeSlip(player(), 'not-a-slip', day).reason, 'unknown')
  assert.equal(takeSlip(player(), SLIPS.find(s => !postedIds(day).includes(s.id)).id, day).reason, 'notposted')
})

test('a visit, a talk, and a delivery finish a slip and pay the player, not a treasury', () => {
  const p = player({ townSpot: 'market', inventory: [] })
  p.guildBoard = {
    day: startOfDay(),
    activeId: 'deliver_potion',
    step: 0,
    count: 0,
    doneToday: [],
    turnins: 0,
    gemsToday: 0,
    log: { finished: 0, solars: 0, gems: 0, fame: 0, last: [] },
  }
  // Already standing where the visit wants, so arriving counts.
  const visit = noteVisit(p)
  assert.equal(visit.advanced, true)
  const short = noteTalk(p, 'hesta')
  assert.equal(short.reason, 'short')
  p.inventory.push('health_potion')
  const talked = noteTalk(p, 'hesta')
  assert.equal(talked.ok, true)
  assert.equal(talked.ready, true)
  assert.equal(p.inventory.filter(id => id === 'health_potion').length, 0)

  const paid = turnIn(p)
  assert.equal(paid.ok, true)
  assert.equal(p.wallet.solars, paid.solars)
  assert.equal(p.fame, paid.fame)
  assert.equal(p.guildBoard.activeId, null)
  assert.equal(p.guildBoard.turnins, 1)
})

test('a cull counts the family, skips bosses, and a gold Gem is once a day', () => {
  const p = player()
  p.guildBoard = {
    day: startOfDay(),
    activeId: 'slime_cellar',
    step: 0,
    count: 0,
    doneToday: [],
    turnins: 0,
    gemsToday: 0,
    log: { finished: 0, solars: 0, gems: 0, fame: 0, last: [] },
  }
  assert.equal(noteKill(p, { name: 'Fanged Slime', locationId: 'gambits_dungeon', isBoss: false }).counted, false)
  assert.equal(noteKill(p, { name: 'Syclila', locationId: 'entry_tower', isBoss: true }).counted, false)
  const slip = SLIPS.find(s => s.id === 'slime_cellar')
  const need = slip.steps[0].count
  let last = null
  for (let i = 0; i < need; i++) {
    last = noteKill(p, { name: 'Lurking Slime', locationId: 'entry_tower', isBoss: false })
    assert.equal(last.counted, true)
  }
  assert.equal(last.ready, true)
  assert.equal(noteKill(p, { name: 'Lurking Slime', locationId: 'entry_tower', isBoss: false }).counted, false)

  const gold = player({ wallet: { solars: 10, gems: 0 }, fame: 3 })
  gold.guildBoard = {
    day: startOfDay(),
    activeId: 'wraith_quiet',
    step: 1,
    count: 0,
    doneToday: [],
    turnins: 0,
    gemsToday: 0,
    log: { finished: 0, solars: 0, gems: 0, fame: 0, last: [] },
  }
  const first = turnIn(gold)
  assert.equal(first.gems, 1)
  assert.equal(gold.wallet.gems, 1)
  gold.guildBoard.activeId = 'remnant_tide'
  gold.guildBoard.step = 1
  const second = turnIn(gold)
  assert.equal(second.gems, 0)
  assert.equal(second.gemSkipped, true)
  assert.equal(gold.wallet.gems, 1)
  assert.ok(gold.wallet.solars > 10)
})

test('midnight drops the slip in your hand', () => {
  const p = player()
  const day = startOfDay()
  takeSlip(p, postedIds(day)[0], day)
  assert.ok(p.guildBoard.activeId)
  ensureBoardState(p, day + 86_400_000)
  assert.equal(p.guildBoard.activeId, null)
  assert.equal(p.guildBoard.turnins, 0)
  assert.equal(p.guildBoard.gemsToday, 0)
})

test('three pins is the day, and abandon frees the hand', () => {
  const p = player()
  const day = startOfDay()
  const id = postedIds(day)[0]
  takeSlip(p, id, day)
  abandonSlip(p, day)
  assert.equal(p.guildBoard.activeId, null)
  takeSlip(p, id, day)
  p.guildBoard.step = 99
  assert.equal(turnIn(p, day).ok, true)
  p.guildBoard.turnins = TURNIN_CAP
  const again = postedIds(day).find(x => x !== id)
  assert.equal(takeSlip(p, again, day).reason, 'cap')
})

test('town walking is soft and blocked only by a live fight or a dungeon', () => {
  assert.equal(townWalkBlock(player()), null)
  assert.equal(townWalkBlock(player({ location: 'entry_tower' })), null)
  assert.equal(townWalkBlock(player({ inDungeon: true })), 'dungeon')
  assert.equal(townWalkBlock(player({ inBattle: true })), 'battle')
  assert.ok(findSpot('market'))
  assert.ok(findNpc('sera', 'guildhall'))
  assert.equal(TOWN_SPOTS.length, 20)
  assert.equal(TOWN_NPCS.length, 21)
  const raw = readFileSync(new URL('../data/town.json', import.meta.url), 'utf8')
  assert.equal(/[—–]/.test(raw), false)
})

test('dungeon entry lore does not invent mid-floor masters', () => {
  const loc = { id: 'gambits_dungeon', floors: 100, bossFloors: [100] }
  const brief = entryBrief(loc, 40, false)
  assert.match(brief, /Kikaru/)
  assert.equal(/champion/i.test(brief), false)
  assert.ok(encounterLine('entry_tower', 'Fanged Slime').length > 0)
  assert.equal(/[—–]/.test(brief), false)
})

test('the flat command list leaves owner tools out', () => {
  const plugins = [
    { name: 'attack', category: 'combat', description: 'strike', aliases: [] },
    { name: 'cheat', category: 'utility', description: 'a player toy', aliases: [] },
    { name: 'admin', category: 'admin', description: 'owner tools', aliases: [] },
    { name: 'cb', category: 'utility', description: 'clear a stuck fight', aliases: [] },
    { name: 'event', category: 'event', description: 'world events', aliases: [], subcommands: [
      { cmd: 'status', desc: 'what is happening' },
      { cmd: 'start', desc: 'owner only: open the rift' },
    ] },
  ]
  assert.equal(isOwnerCommand(plugins[2]), true)
  assert.equal(isOwnerCommand(plugins[3]), true)
  assert.equal(isOwnerCommand(plugins[1]), false)
  assert.equal(playerSubcommands(plugins[4]).map(s => s.cmd).join(','), 'status')
  const pages = buildCommandPages(plugins, { prefix: '.', sections: [
    { key: 'combat', emoji: '⚔️', label: 'Combat', subs: [{ cat: 'combat' }] },
    { key: 'utility', emoji: '🔧', label: 'Utility', subs: [{ cat: 'utility' }, { cat: 'event' }, { cat: 'admin' }] },
  ] })
  assert.match(pages.text, /\.attack/)
  assert.match(pages.text, /\.cheat/)
  assert.equal(pages.text.includes('.admin'), false)
  assert.equal(pages.text.includes('.cb'), false)
  assert.equal(pages.text.includes('event start'), false)
  assert.equal(/[—–]/.test(cleanCopy('a — b – c')), false)
})
