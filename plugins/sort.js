/**
 * sort.js — "The Sorter" summon's battle-prep sweep (beast id `the_sorter`).
 *
 * Only works while The Sorter is your ACTIVE beast (win it at the .auction,
 * then .equipbeast the sorter). One command readies you for a fight by reaching
 * across every store you own — the Sorter's whole gimmick is that it has access
 * to all of them at once:
 *
 *   1. VALUABLES (rare-and-up gear, relics, trophies loose in your bag) are
 *      tucked into your chest, which survives death (see plugins/chest.js) — so
 *      a wipe can't take them. No chest? They fall back to home storage; if you
 *      have neither, they stay put and you're told they're at risk.
 *   2. BATTLE KIT (consumables — potions, draughts, cures) sitting in your chest
 *      or home storage is pulled back into your bag, best first, up to your
 *      inventory cap, so you walk in already armed.
 *   3. Your bag is REORDERED into battle order: consumables, then weapons,
 *      armour, relics, then everything else, each group by rarity then name.
 *
 * Nothing is ever sold, destroyed, or unequipped. Every move is between stores
 * you already own, so it is all reversible with .chest / .home. That safety is
 * deliberate: this is a one-tap organiser, not a command that can cost you.
 *
 * This is NOT in BATTLE_ALLOWED_COMMANDS on purpose — you prep before a fight,
 * not mid-swing, so the battle gate refuses it during a live fight.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { allItems } from '../lib/game-data.js'
import { getInventoryCap } from '../lib/inventory-limits.js'
import { storageCap } from '../lib/housing-engine.js'
import { rarityStars } from '../lib/rarity.js'

const SORTER_BEAST_ID = 'the_sorter'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

// Ascending value ladder. Unknown ids (drop-table names with no catalog entry)
// rank -1 so the Sorter never touches something it can't identify.
const RARITY_RANK = {
  common: 0, uncommon: 1, rare: 2, epic: 3,
  legendary: 4, mythic: 5, mythical: 5, boundless: 6,
}
const RARE_FLOOR = RARITY_RANK.rare // rare and above counts as a "valuable"

const rankOf = (def) => (def ? (RARITY_RANK[def.rarity] ?? -1) : -1)
const isConsumable = (def) => def?.type === 'consumable'
/** Worth protecting from a death wipe: a real, rare-or-better, non-consumable. */
const isValuable = (def) => !!def && def.type !== 'consumable' && rankOf(def) >= RARE_FLOOR

// Battle order: consumables first (reach for a potion fast), then the gear
// groups, then loose materials and everything else.
const GROUP_ORDER = (def) => {
  switch (def?.type) {
    case 'consumable': return 0
    case 'weapon':     return 1
    case 'armor':      return 2
    case 'relic':      return 3
    default:           return 4
  }
}
function battleOrder(aId, bId) {
  const a = itemMap[aId], b = itemMap[bId]
  const ga = GROUP_ORDER(a), gb = GROUP_ORDER(b)
  if (ga !== gb) return ga - gb
  const ra = rankOf(a), rb = rankOf(b)
  if (ra !== rb) return rb - ra // higher rarity first within a group
  return String(a?.name ?? aId).localeCompare(String(b?.name ?? bId))
}

/** Groups a flat id[] into "⭐ *Name* xN" lines, sorted for display. */
function summarize(ids) {
  const counts = new Map()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts.entries()]
    .map(([id, count]) => {
      const item = itemMap[id]
      const name = item?.name ?? id
      const stars = item ? rarityStars(item.rarity) : ''
      return { line: `  ${stars} *${name}*${count > 1 ? ` x${count}` : ''}`, name }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => e.line)
    .join('\n')
}

export default {
  name:           'sort',
  aliases:        ['sorter'],
  category:       'inventory',
  requiresPlayer: true,
  description:    `${config.prefix}sort — The Sorter summon readies your bag for battle: valuables locked in your chest, potions back in hand.`,

  async run(ctx) {
    const { player, db, from } = ctx
    const p = config.prefix

    if (player.activeBeast !== SORTER_BEAST_ID) {
      return ctx.reply(
        `🤖 *The Sorter isn't at your side.*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Make it your active summon first: *${p}equipbeast the sorter*\n` +
        `Then *${p}sort* readies your bag for battle: valuables locked safe, potions in hand.\n\n` +
        `_The Sorter goes up at the *${p}auction*._`,
      )
    }

    // Everything happens inside one mutator so the moves across bag / chest /
    // home storage all land in a single serialized write.
    const report = {
      stashed: [], stashWhere: null, stashLeftBehind: 0,
      valuablesAtRisk: 0, armed: [], reordered: false,
    }

    await updatePlayer(db, from, (pl) => {
      // Reset the receipt at the top: updatePlayer may call this mutator more
      // than once under cluster-mode optimistic-concurrency retries, and the
      // report accumulates via push — without this a retry would double-count.
      report.stashed = []; report.stashWhere = null; report.stashLeftBehind = 0
      report.valuablesAtRisk = 0; report.armed = []; report.reordered = false

      pl.inventory = Array.isArray(pl.inventory) ? pl.inventory : []
      const chestUnlocked = !!(pl.chest && pl.chest.unlocked && Array.isArray(pl.chest.items))
      const homeStorage = Array.isArray(pl.home?.storage) ? pl.home.storage : null
      const homeRoom = homeStorage ? Math.max(0, storageCap(pl) - homeStorage.length) : 0

      // ── Phase 1: stash valuables out of the bag, safe from death ──────────
      const valuables = []
      const keep = []
      for (const id of pl.inventory) (isValuable(itemMap[id]) ? valuables : keep).push(id)

      if (valuables.length) {
        if (chestUnlocked) {
          // Chest is unbounded and death-proof: everything valuable goes in.
          pl.chest.items.push(...valuables)
          report.stashed = valuables
          report.stashWhere = 'chest'
          pl.inventory = keep
        } else if (homeRoom > 0) {
          // No chest, but the house has shelves. Fill what room there is.
          const moved = valuables.slice(0, homeRoom)
          const left = valuables.slice(homeRoom)
          homeStorage.push(...moved)
          report.stashed = moved
          report.stashWhere = 'home'
          report.stashLeftBehind = left.length
          report.valuablesAtRisk = left.length
          pl.inventory = keep.concat(left)
        } else {
          // Nowhere safe to put them: leave them, but warn they're exposed.
          report.valuablesAtRisk = valuables.length
          pl.inventory = keep.concat(valuables)
        }
      }

      // ── Phase 2: arm the bag with consumables from every store ────────────
      let room = Math.max(0, getInventoryCap(pl) - pl.inventory.length)
      if (room > 0) {
        const sources = []
        if (chestUnlocked)          sources.push(['chest', pl.chest.items])
        if (homeStorage)            sources.push(['home', homeStorage])

        const cands = []
        for (const [key, arr] of sources)
          for (let i = 0; i < arr.length; i++) {
            if (isConsumable(itemMap[arr[i]])) cands.push({ key, i, id: arr[i], rank: rankOf(itemMap[arr[i]]) })
          }
        cands.sort((a, b) => b.rank - a.rank) // best potions come home first
        const chosen = cands.slice(0, room)

        // Pull chosen into the bag, then splice them out of their sources by
        // descending index so duplicate ids never remove the wrong copy.
        const removeByKey = { chest: [], home: [] }
        for (const c of chosen) {
          pl.inventory.push(c.id)
          report.armed.push(c.id)
          removeByKey[c.key].push(c.i)
        }
        for (const [key, arr] of sources)
          for (const idx of removeByKey[key].sort((a, b) => b - a)) arr.splice(idx, 1)
      }

      // ── Phase 3: reorder the bag into battle order ────────────────────────
      const before = pl.inventory.join('|')
      pl.inventory = [...pl.inventory].sort(battleOrder)
      report.reordered = pl.inventory.join('|') !== before

      return pl
    })

    // ── Receipt ─────────────────────────────────────────────────────────────
    const didSomething = report.stashed.length || report.armed.length || report.reordered
    if (!didSomething && !report.valuablesAtRisk) {
      return ctx.reply(
        `🤖 *THE SORTER*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Your kit is already battle-ready. Nothing to move.`,
      )
    }

    const whereLabel = report.stashWhere === 'chest' ? 'your chest' : 'home storage'
    const lines = [`🤖 *THE SORTER: BATTLE PREP*`, `━━━━━━━━━━━━━━━━━━━━`]

    if (report.stashed.length) {
      lines.push(`🔒 *Stowed safe from death* _(in ${whereLabel})_`)
      lines.push(summarize(report.stashed))
    }
    if (report.armed.length) {
      lines.push(`🎒 *Armed your bag*`)
      lines.push(summarize(report.armed))
    }
    if (report.reordered) lines.push(`↕️ Reordered your bag for battle.`)

    if (report.stashLeftBehind) {
      lines.push(`⚠️ Home storage filled up. *${report.stashLeftBehind}* valuable${report.stashLeftBehind === 1 ? '' : 's'} left in your bag.`)
    } else if (report.valuablesAtRisk) {
      lines.push(
        `⚠️ *${report.valuablesAtRisk}* valuable${report.valuablesAtRisk === 1 ? '' : 's'} still in your bag and lost if you die.\n` +
        `_Unlock a chest with *${p}chest buy* so I can protect them._`,
      )
    }

    lines.push(`_Nothing sold, dropped, or unequipped._`)
    return ctx.reply(lines.join('\n'))
  },
}
