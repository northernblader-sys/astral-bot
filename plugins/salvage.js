/**
 * plugins/salvage.js — turn dead inventory entries into solars.
 *
 *   .salvage            preview what can be scrapped and for how much
 *   .salvage all        scrap all of it
 *   .salvage <item>     scrap every copy of one item
 *
 * WHY THIS EXISTS: two kinds of entry in a player's inventory are unreachable
 * by every other command in the bot, while still counting against the slot cap
 * from lib/inventory-limits.js.
 *
 *   1. Inert curios. A `misc` item has no equip slot and no consumable effect.
 *      Most have a command behind them (lib/curios.js CURIO_USES, e.g. the
 *      Ender Pearl's .setpearl), but some ship as lore drops with a token
 *      sellPrice of 1 solar, which makes .shop sell pointless.
 *   2. Leftover ids. An id sitting in the inventory array that no longer exists
 *      in the item data at all. It cannot be equipped, inspected, used, or sold
 *      (the shop prices by item definition), so it is pure dead weight. These
 *      are the entries plugins/inventory.js lists under "❔ Other".
 *
 * Salvage is the only route out for both. It pays solars and, more importantly,
 * frees the slot.
 *
 * SAFETY: only entries lib/curios.js marks as inert, or ids absent from the
 * item data, are ever destroyed. Anything equipped is skipped outright, and a
 * curio registered in CURIO_USES is never touched, so wiring a command to a new
 * misc item automatically protects it from being scrapped. The scan is redone
 * INSIDE the mutator, under the write lock, so a concurrent command cannot make
 * this destroy something it did not price. Nothing here mints gems and nothing
 * touches baseStats. One updatePlayer, no nesting.
 */
import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getInventoryCap } from '../lib/inventory-limits.js'
import { isInertCurio, salvageValue, humanizeId, JUNK_VALUE } from '../lib/curios.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))
const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈'

/** Per-item scrapping flavor. Falls back to a generic line. */
const FLAVOR = {
  bar_tab_receipt: 'You settle the tab, argue the total down, and pocket the difference.',
}
const GENERIC_FLAVOR = 'The scrapper weighs it, shrugs, and counts out coins.'

/**
 * Everything in this player's inventory that salvage is allowed to consume.
 * Returns one row per distinct id: { id, name, count, unit, kind }.
 */
function scanSalvage(player) {
  const equippedIds = new Set(Object.values(player.equipped ?? {}).filter(Boolean))
  const counts = {}
  for (const id of player.inventory ?? []) counts[id] = (counts[id] ?? 0) + 1

  const rows = []
  for (const [id, count] of Object.entries(counts)) {
    if (equippedIds.has(id)) continue
    const item = itemMap[id]
    if (item) {
      if (!isInertCurio(item)) continue
      rows.push({ id, name: item.name, count, unit: salvageValue(item), kind: 'curio' })
    } else {
      rows.push({ id, name: humanizeId(id), count, unit: JUNK_VALUE, kind: 'junk' })
    }
  }
  return rows
}

const rowTotal = r => r.count * r.unit
const sumRows = rows => rows.reduce((s, r) => s + rowTotal(r), 0)

/** Matches a query against a salvageable row by id or name, loosely. */
function matchRows(rows, query) {
  const q = query.toLowerCase().trim()
  const exact = rows.filter(r => r.id.toLowerCase() === q || r.name.toLowerCase() === q)
  if (exact.length) return exact
  return rows.filter(r => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
}

function rowLine(r) {
  const qty = r.count > 1 ? `  ×${r.count}` : ''
  const mark = r.kind === 'junk' ? '❔' : '🎲'
  return `${mark} ${r.name}${qty}  ·  ☀️ ${rowTotal(r).toLocaleString()}`
}

// ── Preview (.salvage) ───────────────────────────────────────────────────────

function previewText(ctx, rows) {
  const p = config.prefix
  if (!rows.length) {
    return (
      `♻️ *SCRAPYARD*\n${DIVIDER}\n` +
      `_Nothing to salvage._\n\n` +
      `Salvage only takes curios that no command uses, and leftovers from retired ` +
      `content. Everything in your bag right now is either usable or sellable at ` +
      `*${p}shop sell*.`
    )
  }
  const total = sumRows(rows)
  const slots = rows.reduce((s, r) => s + r.count, 0)
  const lines = [
    `♻️ *SCRAPYARD*`,
    DIVIDER,
    `These entries have no use and cannot be sold:`,
    '',
    ...rows.map(rowLine),
    '',
    DIVIDER,
    `☀️ Total: *${total.toLocaleString()} solars*`,
    `🎒 Slots freed: *${slots}*`,
    '',
    `> *${p}salvage all* to scrap all of it`,
    `> *${p}salvage <item>* to scrap just one`,
    `_Scrapping is permanent._`,
  ]
  return lines.join('\n')
}

// ── Scrap (.salvage all / .salvage <item>) ───────────────────────────────────

async function doSalvage(ctx, query) {
  const p = config.prefix
  let outcome = null

  await updatePlayer(ctx.db, ctx.from, player => {
    // Re-scan under the write lock: the preview the player saw may be stale.
    const rows = scanSalvage(player)
    if (!rows.length) { outcome = { reason: 'none' }; return player }

    const targets = query === null ? rows : matchRows(rows, query)
    if (!targets.length) { outcome = { reason: 'nomatch', rows }; return player }

    const removeIds = new Set(targets.map(r => r.id))
    player.inventory = (player.inventory ?? []).filter(id => !removeIds.has(id))

    const total = sumRows(targets)
    player.wallet = player.wallet ?? {}
    player.wallet.solars = (player.wallet.solars ?? 0) + total

    outcome = {
      reason: 'ok',
      targets,
      total,
      slots: targets.reduce((s, r) => s + r.count, 0),
      balance: player.wallet.solars,
      used: player.inventory.length,
      cap: getInventoryCap(player),
    }
    return player
  })

  if (outcome?.reason === 'none') {
    return ctx.reply(`♻️ You have nothing the scrapyard will take.`)
  }
  if (outcome?.reason === 'nomatch') {
    return ctx.reply(
      `❌ Nothing salvageable matches *"${query}"*.\n` +
      `Run *${p}salvage* to see what can be scrapped.`,
    )
  }
  if (outcome?.reason !== 'ok') {
    return ctx.reply(`❌ The scrapyard is closed. Try again in a moment.`)
  }

  const flavor = outcome.targets.length === 1
    ? (FLAVOR[outcome.targets[0].id] ?? GENERIC_FLAVOR)
    : GENERIC_FLAVOR

  const lines = [
    `♻️ *SALVAGED*`,
    DIVIDER,
    `_${flavor}_`,
    '',
    ...outcome.targets.map(rowLine),
    '',
    DIVIDER,
    `☀️ Earned: *+${outcome.total.toLocaleString()} solars*`,
    `💳 Balance: *${outcome.balance.toLocaleString()} solars*`,
    `🎒 Inventory: ${outcome.used}/${outcome.cap}  (freed ${outcome.slots} slot${outcome.slots === 1 ? '' : 's'})`,
  ]
  return ctx.reply(lines.join('\n'))
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default {
  name:           'salvage',
  aliases:        ['scrap'],
  category:       'inventory',
  requiresPlayer: true,
  description:    'Scrap unusable curios and leftovers for solars',
  subcommands: [
    { cmd: 'all', desc: 'scrap everything salvageable' },
    { cmd: '<item>', desc: 'scrap every copy of one item' },
  ],

  async run(ctx) {
    const sub = ctx.args.join(' ').trim()
    if (!sub) return ctx.reply(previewText(ctx, scanSalvage(ctx.player)))
    if (sub.toLowerCase() === 'all') return doSalvage(ctx, null)
    return doSalvage(ctx, sub)
  },
}
