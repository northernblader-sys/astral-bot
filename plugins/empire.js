/**
 * plugins/empire.js — found, view, and run your own empire.
 *
 * The hub of the Empire pillar. Phase 1 gave it the tycoon core (found, info,
 * build, upgrade, shop, collect, upkeep); Phase 3 adds the social and economic
 * layers that hang off the same dispatch: citizenship (join, leave, citizens),
 * putting owned characters to work (assign, unassign), and the storefront
 * funnel (market, buy, visit). Army lives in plugins/army.js, raids in
 * plugins/raid.js, wars in Phase 4.
 *
 * Every write goes through updatePlayer so it rides the serialized write
 * queue. The empire record on db.data.empires is mutated INSIDE that mutator
 * (the season-runtime idiom), so a founding's solar debit, name claim and
 * record creation are one atomic serialized write, and a collect's treasury
 * update can never race a concurrent player write. A market purchase debits the
 * buyer and credits the seller's treasury in ONE mutator for the same reason:
 * stock cannot be sold twice if the decrement and the payment are the same
 * write. Nothing here broadcasts, and nothing mints gems.
 *
 * SETTLE FIRST: anything that changes a production RATE (upgrade, assigning or
 * dismissing a worker) calls applyCollect before it lands, so the new rate is
 * never applied to hours that accrued under the old one.
 */
import { config } from '../config.js'
import { updatePlayer, playerExists } from '../lib/player-repo.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED, isOwnerJid } from '../lib/group-helpers.js'
import { materials as materialDefs, characterMap, recipes, allItems } from '../lib/game-data.js'
import { rarityStars, rarityRank } from '../lib/rarity.js'
import { soldierName } from '../lib/soldier-names.js'
import { resolveTargetJid } from '../lib/transfer-guards.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { pushNotification } from '../lib/notification-repo.js'
import {
  ensureEmpiresInitialized, getOwnedEmpire, findEmpireByQuery,
  getEmpireMembers, empireNameTaken, newEmpireRecord, ensureEmpirePlayer,
  sweepEmpireLifecycle, empireNeedsSweep, buildPresetRecord, freeEmpireId,
} from '../lib/empire-repo.js'
import {
  EMPIRE_CONFIG, BUILDING_DEFS, SHOP_PRICES, TIER_ORDER, MARKET_CONFIG, SELL_CONFIG, buildingDefMap, tierOf, nextTier, fameToNextTier,
  warehouseCap, warehouseUsed, warehouseRoom, buildingCount, buildingSlotsLeft,
  buildingYieldPerHour, findBuilding, buildingCostFor, canAfford, payCost,
  previewCollect, applyCollect, computeUpkeep, empireScore, validateName, MATERIAL_IDS,
  armyPower, armyHeadcount, armyCap, wagePerHour, citizenCap, generalBonusOf, workerMultFor, isVassal,
  populationOf, popCap, popRoom,
  BLACKSMITH_CONFIG, blacksmithLevel, maxForgeRank, forgeCheck, applyForge,
  bankBuilt, bankTaxRatePerDay, previewBankAccount, bankHeld, bankDeposit, bankWithdraw,
  previewFolk,
  REGIONS, regionMap, REGION_CAP, buildingsInRegion, regionSlotsLeft, regionCountsOf, firstOpenRegion,
  PRESET_ORDER, findPreset, presetPreview, auditPreset, suggestPreset,
  RANK_ORDER, rankMap, shortSolars,
} from '../lib/empire-engine.js'
import { renderEmpireMap } from '../lib/empire-map-render.mjs'
import {
  ROLES, WORKER_CAP, GENERAL_CAP, PER_PLAYER_CAP, canAssign, applyAssign, applyUnassign,
  stripPlayerAssignments, assignmentOf, findOwnedCharacter, characterLabel,
  assignmentLines, playerAssignmentCount,
} from '../lib/empire-abilities.js'

const RULE = '━━━━━━━━━━━━━━━━━━━━'
const matName = Object.fromEntries(materialDefs.map(m => [m.id, m.name]))
const mname = id => matName[id] ?? id

// The blacksmith reuses the game's existing recipe substrate (data/recipes.json)
// and item catalogue rather than inventing its own: the empire forge and the
// personal one in plugins/craft.js make the very same gear, differing only in
// where the materials and the payment come from (stash + treasury here, bag +
// wallet there). allItems already folds materials in, so itemMap resolves both
// equippable gear and raw mats by id.
const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))
const recipeByOutput = Object.fromEntries(recipes.map(r => [r.output, r]))
const iname = id => itemMap[id]?.name ?? mname(id)

/** An id names a raw material (as opposed to an equippable item) iff it is in the material set. */
function isMaterialId(id) {
  return Object.prototype.hasOwnProperty.call(matName, id)
}

/** Find a recipe by exact output id, then by partial output-name match (mirrors craft.js). */
function findRecipe(query) {
  const q = query.trim().toLowerCase()
  if (!q) return null
  if (recipeByOutput[q]) return recipeByOutput[q]
  for (const [outputId, recipe] of Object.entries(recipeByOutput)) {
    const item = itemMap[outputId]
    if (item && item.name.toLowerCase().includes(q)) return recipe
  }
  return null
}

/** Resolve a free-text query to a known item/material id: exact id, then partial name. */
function resolveAnyId(query) {
  const q = query.trim().toLowerCase()
  if (!q) return null
  if (itemMap[q]) return q
  for (const it of allItems) {
    if (it.name?.toLowerCase().includes(q)) return it.id
  }
  return null
}

/** How many of a bare id the player is carrying (inventory is a flat id array). */
function countInv(inventory, id) {
  return (inventory ?? []).filter(x => x === id).length
}

// ── Small shared views ─────────────────────────────────────────────────────

function noEmpire(p) {
  return (
    `🏰 *You don't rule an empire yet.*\n` +
    `Found one for *${EMPIRE_CONFIG.foundCost.toLocaleString()} solars*:\n` +
    `> *${p}empire found <name>*`
  )
}

function buildingLine(b, record) {
  const def = buildingDefMap[b.type]
  if (!def) return `• ${b.type} Lv${b.level}`
  const mult = record ? workerMultFor(record, b.type) : 1
  const y = Math.floor(buildingYieldPerHour(def, b.level) * mult)
  let unit = 'idle'
  if (def.produces === 'solars') unit = `+${y.toLocaleString()} solars/h`
  else if (def.produces) unit = `+${y} ${mname(def.produces).toLowerCase()}/h`
  else if (def.storageBonus) unit = `+${(def.storageBonus * b.level).toLocaleString()} storage`
  else if (def.armyCapBonus) unit = `+${(def.armyCapBonus * b.level).toLocaleString()} army cap`
  else if (def.housing) unit = `+${(def.housing * b.level).toLocaleString()} housing`
  const damaged = (b.damagedUntil ?? 0) > Date.now() ? '  ·  🏚️ _offline_' : ''
  const worked = mult > 1 ? `  ·  👷 _+${Math.round((mult - 1) * 100)}%_` : ''
  return `${def.emoji} *${def.name}* Lv${b.level}  ·  ${unit}${worked}${damaged}`
}

function warehouseLine(record) {
  const cap = warehouseCap(record)
  const used = warehouseUsed(record)
  const stocked = Object.entries(record.warehouse)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${mname(id)} ${n.toLocaleString()}`)
  const body = stocked.length ? stocked.join(', ') : 'empty'
  return `📦 *Warehouse* ${used.toLocaleString()}/${cap.toLocaleString()}\n   ${body}`
}

function renderInfo(ctx, record, allUsers, isOwner) {
  const p = config.prefix
  const tier = tierOf(record)
  const next = nextTier(tier.id)
  const upkeep = computeUpkeep(record)
  const preview = previewCollect(record)
  const pop = populationOf(record)
  const cap = popCap(record)
  const room = popRoom(record)
  const members = getEmpireMembers(record.id, allUsers)

  const lines = []
  lines.push(`🏰 *${record.name}*`)
  lines.push(`_${tier.name}  ·  👥 ${pop.toLocaleString()} people  ·  power ${empireScore(record).toLocaleString()}_`)
  lines.push(RULE)
  const now = Date.now()
  if (record.war?.status === 'active') {
    lines.push(`⚔️ *At war* with ${record.war.opponentName ?? 'a rival'}.`)
  } else if (record.war?.status === 'declared' && record.war.role === 'aggressor') {
    lines.push(`📜 *War declared* on ${record.war.opponentName ?? 'a rival'}.`)
  }
  if (isVassal(record, now)) lines.push(`⛓️ *Vassal* of ${record.vassalOfName ?? 'another empire'}.`)
  if (record.dormant) lines.push(`🌙 _Dormant: its ruler has been away a long while._`)
  if (record.sellListing?.price > 0) {
    lines.push(`🏷️ *For sale:* ${record.sellListing.price.toLocaleString()} solars  ·  *${p}empire buyout ${record.name}*`)
  }
  if (next) {
    lines.push(`📈 *Next tier:* ${next.name} in *${fameToNextTier(record).toLocaleString()}* more people`)
    if (next.fame > cap) lines.push(`   🏠 _Room for only ${cap.toLocaleString()}. Build homes so more can move in._`)
  } else {
    lines.push(`📈 *Top tier reached.* There is nothing above you.`)
  }
  lines.push(`💰 *Treasury:* ${record.treasury.toLocaleString()} solars`)
  lines.push(warehouseLine(record))
  lines.push('')

  if (record.buildings.length) {
    lines.push(`🏗️ *Buildings* (${buildingCount(record)}/${tier.buildingCap})`)
    for (const b of record.buildings) lines.push(`   ${buildingLine(b, record)}`)
  } else {
    lines.push(`🏗️ *No buildings yet.* Start with *${p}empire build*.`)
  }
  lines.push('')

  const head = armyHeadcount(record)
  if (head > 0) {
    const gBonus = generalBonusOf(record)
    const powerLine = gBonus > 0
      ? `power ${armyPower(record, gBonus).toLocaleString()} _(+${Math.round(gBonus * 100)}% general)_`
      : `power ${armyPower(record).toLocaleString()}`
    lines.push(`⚔️ *Army* ${head.toLocaleString()}/${armyCap(record).toLocaleString()}  ·  ${powerLine}`)
    const wage = wagePerHour(record)
    if (wage > 0) lines.push(`   wages ${wage.toLocaleString()} solars/h`)
    lines.push('')
  } else if (isOwner) {
    lines.push(`⚔️ *No army yet.* Recruit troops with *${p}recruit <n>*.`)
    lines.push('')
  }

  const posted = assignmentLines(record)
  if (posted.length) {
    lines.push(`🧑‍🌾 *Posted characters*`)
    for (const l of posted) lines.push(`   ${l}`)
    lines.push('')
  }

  lines.push(`⚙️ *Economy (per hour)*`)
  const wageLine = upkeep.wagePerHour ? ` · Wages: ${upkeep.wagePerHour.toLocaleString()}` : ''
  lines.push(`   Income: ${upkeep.grossSolarsPerHour.toLocaleString()} · Upkeep: ${upkeep.maintPerHour.toLocaleString()}${wageLine}`)
  const net = upkeep.netSolarsPerHour
  lines.push(`   Net: ${net >= 0 ? '+' : ''}${net.toLocaleString()} solars/h`)

  if (isOwner && preview.hasSomething) {
    lines.push('')
    const parts = []
    if (preview.solarsGain) parts.push(`${preview.solarsGain.toLocaleString()} solars`)
    for (const [id, qty] of Object.entries(preview.matStored)) parts.push(`${qty} ${mname(id).toLowerCase()}`)
    lines.push(`🧺 *Ready to collect:* ${parts.length ? parts.join(', ') : 'nothing yet'}`)
    lines.push(`   Claim it with *${p}empire collect*.`)
  }

  const stock = record.market?.stock ?? []
  if (stock.length) {
    lines.push('')
    lines.push(`🏪 *Market:* ${stock.length} listing${stock.length === 1 ? '' : 's'} for sale`)
    if (!isOwner) lines.push(`   Browse it with *${p}empire buy*.`)
  }

  const citizens = members.filter(u => u.empireRole === 'citizen')
  lines.push('')
  lines.push(`🏘️ *People:* ${pop.toLocaleString()}/${cap.toLocaleString()}  ·  ${record.citizenCount.toLocaleString()} sworn, ${record.npcs.toLocaleString()} townsfolk`)
  if (room <= 0 && cap > 0) lines.push(`   🏠 _Full. Build homes to make room for more._`)
  lines.push(`👥 *Citizens:* ${citizens.length}/${citizenCap(record)}`)
  if (!isOwner) lines.push(`   Swear in with *${p}empire join ${record.name}*.`)
  lines.push('')
  lines.push(`🧭 _Walk your realm with *${p}goto*, and meet the people with *${p}folk*._`)
  return lines.join('\n')
}

// ── Subcommand handlers ─────────────────────────────────────────────────────

async function foundEmpire(ctx) {
  const p = config.prefix
  const rawName = ctx.args.slice(1).join(' ').trim()
  const check = validateName(rawName)
  if (!check.ok) return ctx.reply(`❌ ${check.reason}`)
  const cleanName = check.name
  const slug = check.slug
  const now = Date.now()

  // Fast pre-check outside the mutator for a friendly message; the mutator
  // re-checks atomically so a concurrent founder still can't take the name.
  if (empireNameTaken(ctx.db, cleanName)) {
    return ctx.reply(`❌ The name *${cleanName}* is already taken. Pick another.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    if (!ctx.db.data.empires) ctx.db.data.empires = {}
    if (getOwnedEmpire(ctx.db, ctx.from)) { outcome = { reason: 'have' }; return player }
    if (player.empireId) { outcome = { reason: 'citizen' }; return player }
    if (empireNameTaken(ctx.db, cleanName)) { outcome = { reason: 'taken' }; return player }
    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    if (solars < EMPIRE_CONFIG.foundCost) { outcome = { reason: 'poor', have: solars }; return player }

    wallet.solars = solars - EMPIRE_CONFIG.foundCost
    // The name is free, but the KEY may not be: a renamed empire keeps the slug
    // of its original name as its immutable id, so this slug can already be
    // taken by a record that no longer answers to it. Assigning blind would
    // overwrite that empire outright.
    const key = freeEmpireId(ctx.db, slug)
    const record = newEmpireRecord({ id: key, name: cleanName, ownerId: ctx.from, now })
    record.treasury = EMPIRE_CONFIG.starterTreasury
    for (const [id, qty] of Object.entries(EMPIRE_CONFIG.starterWarehouse)) {
      record.warehouse[id] = (record.warehouse[id] ?? 0) + qty
    }
    ctx.db.data.empires[key] = record
    player.empireId = key
    player.empireRole = 'owner'
    player.empireJoinedAt = now
    outcome = { reason: 'ok', balance: wallet.solars }
    return player
  })

  if (outcome?.reason === 'have') return ctx.reply(`🏰 You already rule an empire. See it with *${p}empire*.`)
  if (outcome?.reason === 'citizen') return ctx.reply(`🚫 You're a citizen of another empire. Leave it before founding your own.`)
  if (outcome?.reason === 'taken') return ctx.reply(`❌ The name *${cleanName}* was just taken. Pick another.`)
  if (outcome?.reason === 'poor') {
    return ctx.reply(
      `💸 Founding an empire costs *${EMPIRE_CONFIG.foundCost.toLocaleString()} solars*.\n` +
      `You have *${outcome.have.toLocaleString()}*.`
    )
  }
  const started = Object.entries(EMPIRE_CONFIG.starterWarehouse)
    .map(([id, qty]) => `${qty} ${mname(id).toLowerCase()}`).join(', ')
  return ctx.reply(
    `🏰 *${cleanName} is founded.*\n${RULE}\n` +
    `You are its first and only resident. Your renown is your headcount, so build homes to make room and folk will come to live under your banner.\n` +
    `Opening treasury: *${EMPIRE_CONFIG.starterTreasury.toLocaleString()} solars*.\n` +
    `Warehouse: ${started}.\n\n` +
    `Next steps:\n` +
    `> *${p}empire build house* to make room for people\n` +
    `> *${p}empire* to view your dashboard`
  )
}

/**
 * `.empire rename <new name>` — a ruler re-brands their realm for a flat fee.
 *
 * Only the DISPLAY name changes. The record's id stays exactly as it was,
 * because that id is the key in db.data.empires and is referenced from every
 * member's `empireId`, from another empire's `vassalOf`, from war state and from
 * sell listings. Re-keying would mean chasing all of those in one mutator and
 * silently corrupting whichever one was missed, so the id is treated as an
 * immutable primary key and the name as mutable data. The only visible trace is
 * that `.empire info <old name>` still resolves, which reads as an alias rather
 * than a bug.
 *
 * The debit and the rename happen in ONE updatePlayer mutator so a ruler can
 * never be charged for a rename that then loses a race for the name.
 */
async function renameEmpire(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) {
    return ctx.reply(
      `🔒 Only a ruler can rename a realm.\n` +
      `Found one with *${p}empire found <name>*.`
    )
  }
  const cost = EMPIRE_CONFIG.renameCost ?? 50000
  const rawName = ctx.args.slice(1).join(' ').trim()
  if (!rawName) {
    return ctx.reply(
      `✏️ *Rename your empire*\n${RULE}\n` +
      `Current name: *${owned.name}*\n` +
      `Cost: *${cost.toLocaleString()} solars*\n\n` +
      `> *${p}empire rename <new name>*\n` +
      `_Your buildings, treasury, army, citizens and wars all stay exactly as they are. Only the name on the banner changes._`
    )
  }
  const check = validateName(rawName)
  if (!check.ok) return ctx.reply(`❌ ${check.reason}`)
  const cleanName = check.name

  if (cleanName.toLowerCase() === (owned.name ?? '').toLowerCase()) {
    return ctx.reply(`🤔 *${owned.name}* is already its name. Nothing to change.`)
  }
  // Friendly pre-check outside the mutator; the mutator re-checks atomically.
  if (empireNameTaken(ctx.db, cleanName, owned.id)) {
    return ctx.reply(`❌ The name *${cleanName}* is already taken. Pick another.`)
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec || rec.ownerId !== ctx.from) { outcome = { reason: 'missing' }; return player }
    if (empireNameTaken(ctx.db, cleanName, rec.id)) { outcome = { reason: 'taken' }; return player }
    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    if (solars < cost) { outcome = { reason: 'poor', have: solars }; return player }

    wallet.solars = solars - cost
    const from = rec.name
    rec.name = cleanName
    rec.lastActiveAt = Date.now()
    outcome = { reason: 'ok', from, balance: wallet.solars }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found. Try *${p}empire* again.`)
  if (outcome?.reason === 'taken') return ctx.reply(`❌ The name *${cleanName}* was just taken. Pick another.`)
  if (outcome?.reason === 'poor') {
    return ctx.reply(
      `💸 Renaming an empire costs *${cost.toLocaleString()} solars*.\n` +
      `You have *${outcome.have.toLocaleString()}*.`
    )
  }
  return ctx.reply(
    `✏️ *${outcome.from}* is now *${cleanName}*.\n${RULE}\n` +
    `Paid *${cost.toLocaleString()} solars*. Wallet: *${outcome.balance.toLocaleString()}*.\n` +
    `Everything else is untouched, and your citizens keep their citizenship.`
  )
}

async function collectEmpire(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  let summary = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { summary = { missing: true }; return player }
    summary = applyCollect(rec, Date.now())
    return player
  })

  if (summary?.missing) return ctx.reply(`❌ Your empire record could not be found. Try *${p}empire* again.`)
  const newFolk = summary.newFolk ?? []
  if (!summary.hasSomething) {
    // applyCollect already banked the townsfolk pass, so if someone settled in
    // by name on this run, say so instead of a flat "nothing yet" that hides it.
    if (newFolk.length) {
      return ctx.reply(
        `🧺 Nothing has piled up yet, but the town is not idle.\n\n` +
        `🏘️ *${newFolk.map(f => f.name).join(', ')}* ${newFolk.length === 1 ? 'has' : 'have'} settled in ${owned.name}.\n` +
        `_Go and meet them with *${p}folk*._`
      )
    }
    return ctx.reply(`🧺 Nothing has piled up yet. Your buildings need time to produce.`)
  }

  const lines = [`🧺 *Collected from ${owned.name}*`, RULE]
  if (summary.solarsGain) lines.push(`💰 +${summary.solarsGain.toLocaleString()} solars produced`)
  if (summary.civicIncome) lines.push(`🏘️ +${summary.civicIncome.toLocaleString()} solars in resident taxes`)
  for (const [id, qty] of Object.entries(summary.matStored)) {
    lines.push(`📦 +${qty.toLocaleString()} ${mname(id).toLowerCase()}`)
  }
  if (summary.maintPaid) lines.push(`🔧 -${summary.maintPaid.toLocaleString()} solars upkeep`)
  if (summary.payroll?.wagesPaid) lines.push(`⚔️ -${summary.payroll.wagesPaid.toLocaleString()} solars army wages`)
  if (summary.arrivals) lines.push(`👥 +${summary.arrivals.toLocaleString()} new resident${summary.arrivals === 1 ? '' : 's'} moved in (now ${summary.npcsAfter.toLocaleString()} townsfolk)`)
  if (summary.bankTax) lines.push(`🏦 +${summary.bankTax.toLocaleString()} solars in bank maintenance tax`)
  // Bank tax is swept straight into the treasury (not through netSolars), so
  // fold it back in here to keep the displayed net coherent with treasuryAfter.
  const net = summary.netSolars + (summary.bankTax ?? 0)
  lines.push('')
  lines.push(`Net solars: *${net >= 0 ? '+' : ''}${net.toLocaleString()}*`)
  lines.push(`Treasury: *${summary.treasuryAfter.toLocaleString()}*`)
  const deserted = []
  const dz = summary.payroll?.deserters ?? {}
  if (dz.recruit) deserted.push(`${dz.recruit.toLocaleString()} recruits`)
  if (dz.soldier) deserted.push(`${dz.soldier.toLocaleString()} soldiers`)
  if (summary.payroll?.officersLost?.length) deserted.push(summary.payroll.officersLost.join(', '))
  if (deserted.length) {
    lines.push('')
    lines.push(`🏳️ *Couldn't make payroll.* Deserted: ${deserted.join(', ')}.`)
    lines.push(`_Keep the treasury above your wage bill to hold your troops._`)
  }
  const wasted = Object.entries(summary.waste).filter(([, n]) => n > 0)
  if (wasted.length) {
    const w = wasted.map(([id, n]) => `${n} ${mname(id).toLowerCase()}`).join(', ')
    lines.push('')
    lines.push(`⚠️ Warehouse full, spoiled: ${w}.`)
    lines.push(`_Raise a warehouse to store more._`)
  }
  // The town news goes last, under the ledger: who moved in with a name, and who
  // is holding an heirloom for the ruler. Both come from applyCollect's folk pass.
  if (newFolk.length) {
    lines.push('')
    lines.push(`🏘️ *${newFolk.map(f => f.name).join(', ')}* ${newFolk.length === 1 ? 'has' : 'have'} settled in and taken up a trade.`)
    lines.push(`_Meet them with *${p}folk*._`)
  }
  if (summary.folkGiftsReady) {
    lines.push('')
    lines.push(`✨ *${summary.folkGiftsReady}* of your folk ${summary.folkGiftsReady === 1 ? 'has' : 'have'} something set aside for you: *${p}folk*.`)
  }
  return ctx.reply(lines.join('\n'))
}

async function upkeepView(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  const upkeep = computeUpkeep(owned)
  const lines = [`⚙️ *${owned.name}: Upkeep*`, RULE]
  if (!upkeep.perBuilding.length) {
    lines.push(`No buildings, so no upkeep. Build something with *${p}empire build*.`)
    return ctx.reply(lines.join('\n'))
  }
  for (const b of upkeep.perBuilding) {
    const def = buildingDefMap[b.type]
    const income = b.produces === 'solars' ? `+${b.yieldPerHour.toLocaleString()}` : '   .'
    lines.push(`${def?.emoji ?? '•'} ${def?.name ?? b.type} Lv${b.level}`)
    lines.push(`   income ${income}/h · upkeep -${b.maintPerHour.toLocaleString()}/h`)
  }
  lines.push(RULE)
  lines.push(`Gross income: *${upkeep.grossSolarsPerHour.toLocaleString()}* solars/h`)
  lines.push(`Total upkeep: *${upkeep.maintPerHour.toLocaleString()}* solars/h`)
  if (upkeep.wagePerHour) lines.push(`Army wages: *${upkeep.wagePerHour.toLocaleString()}* solars/h`)
  const net = upkeep.netSolarsPerHour
  lines.push(`Net margin: *${net >= 0 ? '+' : ''}${net.toLocaleString()}* solars/h`)
  if (net < 0) lines.push(`\n⚠️ You're running at a loss. Build more Solar Mines or the treasury will drain.`)
  lines.push(`\n_Production caps at ${EMPIRE_CONFIG.offlineCapHours}h offline, so collect at least once a day._`)
  return ctx.reply(lines.join('\n'))
}

async function infoView(ctx, allUsers) {
  const p = config.prefix
  const query = ctx.args.slice(1).join(' ').trim()
  if (query) {
    const rec = findEmpireByQuery(ctx.db, query)
    if (!rec) return ctx.reply(`❌ No empire found matching "_${query}_".`)
    return ctx.reply(renderInfo(ctx, rec, allUsers, rec.ownerId === ctx.from))
  }
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  return ctx.reply(renderInfo(ctx, owned, allUsers, true))
}

async function toggle(ctx, sub) {
  if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
  if (!(await isGroupOrBotOwner(ctx))) return ctx.reply(NOT_ALLOWED)
  const res = await saveGroupSettings(ctx.sender, (s) => { s.empireEnabled = (sub === 'on') })
  if (!res.ok) return ctx.reply(saveFailedMessage('empire', res.error))
  return ctx.reply(`🏰 The Empire system is now *${res.settings.empireEnabled ? 'ON' : 'OFF'}* in this group.`)
}

// ── Build / upgrade / build-shop ─────────────────────────────────────────────

function fmtCost(cost) {
  const parts = [`${cost.solars.toLocaleString()} solars`]
  for (const [id, qty] of Object.entries(cost.materials ?? {})) parts.push(`${qty} ${mname(id).toLowerCase()}`)
  return parts.join(', ')
}

function fmtMissing(afford) {
  const parts = []
  if (afford.missingSolars > 0) parts.push(`${afford.missingSolars.toLocaleString()} solars`)
  for (const [id, qty] of Object.entries(afford.missingMaterials ?? {})) parts.push(`${qty} ${mname(id).toLowerCase()}`)
  return parts.join(', ')
}

function tierNameForRank(rank) {
  return TIER_ORDER.find(t => t.rank === rank)?.name ?? `tier ${rank}`
}

function renderBuildList(record) {
  const p = config.prefix
  const tier = tierOf(record)
  const lines = [
    `🏗️ *BUILD SHOP · ${record.name}*`,
    `💰 Treasury *${record.treasury.toLocaleString()}*   ·   🧱 Slots *${buildingCount(record)}/${tier.buildingCap}*`,
    `🏘️ People *${populationOf(record).toLocaleString()}/${popCap(record).toLocaleString()}*  ·  homes make room for more`,
    RULE,
  ]
  for (const def of BUILDING_DEFS) {
    if (def.minRank > tier.rank) {
      lines.push(`🔒 ${def.emoji} *${def.name}*  ·  unlocks at ${tierNameForRank(def.minRank)}`)
      continue
    }
    const houseTag = def.housing ? `  ·  🏠 +${def.housing}/lv room` : ''
    const built = findBuilding(record, def.type)
    if (built) {
      const regionTag = regionMap[built.region] ? `  ·  📍${regionMap[built.region].name}` : ''
      if (built.level >= def.maxLevel) {
        lines.push(`${def.emoji} *${def.name}*  ·  Lv${built.level} ✅ MAX${houseTag}${regionTag}`)
      } else {
        const cost = buildingCostFor(def, built.level + 1)
        lines.push(`${def.emoji} *${def.name}*  ·  Lv${built.level}${houseTag}${regionTag}`)
        lines.push(`   ⬆️ Upgrade: ${fmtCost(cost)}`)
        lines.push(`   ↳ *${p}empire upgrade ${def.type}*`)
      }
    } else {
      const cost = buildingCostFor(def, 1)
      lines.push(`${def.emoji} *${def.name}*${houseTag}`)
      lines.push(`   _${def.blurb}_`)
      lines.push(`   🏷️ Cost: ${fmtCost(cost)}`)
      lines.push(`   ↳ *${p}empire build ${def.type}*`)
    }
  }
  lines.push(RULE)
  lines.push(`📌 *${p}empire build <type> [region]* — e.g. *${p}empire build house south* (max ${REGION_CAP} buildings per region).`)
  lines.push(`🗺️ *${p}empire map* — see where everything sits.`)
  lines.push(`📌 *Next:* raise a building, then *${p}empire collect* to claim what it makes.`)
  return lines.join('\n')
}

/**
 * Resolve a player's typed building name to a definition. Exact type key first
 * (the canonical form the help text prints), then the display name, then a
 * unique loose match so "coffee" and "coffee house" both land on coffee_house.
 * An ambiguous query ("mine" matches two) resolves to nothing rather than
 * guessing which one the player meant.
 */
/**
 * Resolve a free-text query to a region id: exact id, then display name, then
 * a short compass abbreviation (n/ne/e/se/s/sw/w/nw). Mirrors resolveBuildingDef.
 */
function resolveRegion(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  if (regionMap[q]) return regionMap[q]
  const byName = REGIONS.find(r => r.name.toLowerCase() === q)
  if (byName) return byName
  const ABBR = {
    n: 'north', ne: 'northeast', e: 'east', se: 'southeast',
    s: 'south', sw: 'southwest', w: 'west', nw: 'northwest',
  }
  if (ABBR[q]) return regionMap[ABBR[q]]
  return null
}

function resolveBuildingDef(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  if (buildingDefMap[q]) return buildingDefMap[q]
  const under = q.replace(/[\s-]+/g, '_')
  if (buildingDefMap[under]) return buildingDefMap[under]
  const byName = BUILDING_DEFS.find(d => d.name.toLowerCase() === q)
  if (byName) return byName
  const loose = BUILDING_DEFS.filter(d =>
    d.type.includes(under) || d.name.toLowerCase().includes(q))
  return loose.length === 1 ? loose[0] : null
}

async function buildCmd(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  const rest = ctx.args.slice(1)
  if (!rest.length || rest[0].toLowerCase() === 'list') return ctx.reply(renderBuildList(owned))

  // Optional trailing region: "build coffee house south" or "build house se".
  // Only peeled off when there's more than one word left AND the last word
  // resolves to a real region — so "build house" (no region) and multi-word
  // building names with no region ("build coffee house") both still resolve
  // their full text as the building type.
  let regionArg = null
  let typeParts = rest
  if (rest.length > 1) {
    const maybeRegion = resolveRegion(rest[rest.length - 1])
    if (maybeRegion) { regionArg = maybeRegion; typeParts = rest.slice(0, -1) }
  }
  const typeArg = typeParts.join(' ').toLowerCase().trim()

  const def = resolveBuildingDef(typeArg)
  if (!def) {
    const types = BUILDING_DEFS.map(d => d.type).join(', ')
    return ctx.reply(`❌ Unknown building "${typeArg}".\nBuild one of: ${types}`)
  }

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const tier = tierOf(rec)
    if (def.minRank > tier.rank) { outcome = { reason: 'locked', tierName: tierNameForRank(def.minRank) }; return player }
    // HOUSING RULE: every type is one-per-empire EXCEPT the House — you can
    // build as many Houses as your tier's building slots and region space
    // allow. Housing gates NPC immigration (popCap sums EVERY house), so the
    // single-House cap walled the population below what townsfolk arrivals
    // and quests expect; legacy empires that predate the uniqueness rule
    // already stack Houses, which made the cap look like a bug rather than a
    // design (the "he has more than one house and I can't build one" report).
    // Yield buildings stay unique — duplicating Solar Mines would just
    // multiply income per slot, which is what upgrading levels are for.
    if (def.type !== 'house' && findBuilding(rec, def.type)) { outcome = { reason: 'exists' }; return player }
    if (buildingSlotsLeft(rec) <= 0) { outcome = { reason: 'noslots', cap: tier.buildingCap }; return player }
    // Region: use what was typed if it has room, otherwise auto-pick the
    // first open region in compass order. Only when EVERY region is already
    // at REGION_CAP (and the tier still has slots free) does this fail.
    let region = regionArg
    if (region) {
      if (regionSlotsLeft(rec, region.id) <= 0) { outcome = { reason: 'regionfull', region }; return player }
    } else {
      region = firstOpenRegion(rec)
      if (!region) { outcome = { reason: 'noregion' }; return player }
    }
    // A new building doesn't change any existing building's yield, so no
    // settle is needed here (unlike upgrade). Just pay from what's on hand.
    const cost = buildingCostFor(def, 1)
    const afford = canAfford(rec, cost)
    if (!afford.ok) { outcome = { reason: 'poor', afford, cost }; return player }
    payCost(rec, cost)
    rec.buildings.push({ type: def.type, level: 1, lastCollectedAt: now, region: region.id })
    rec.lastActiveAt = now
    outcome = { reason: 'ok', cost, treasury: rec.treasury, region }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'locked') return ctx.reply(`🔒 *${def.name}* unlocks at ${outcome.tierName}. Grow your fame first.`)
  if (outcome?.reason === 'exists') return ctx.reply(`🏗️ You already have a ${def.name}. Level it with *${p}empire upgrade ${def.type}*.`)
  if (outcome?.reason === 'noslots') return ctx.reply(`🏗️ No building slots left (${outcome.cap} at this tier). Raise your fame to expand.`)
  if (outcome?.reason === 'regionfull') {
    return ctx.reply(`📍 *${outcome.region.name}* is full (${REGION_CAP} buildings max). Try another region — *${p}empire build ${def.type} <region>*.`)
  }
  if (outcome?.reason === 'noregion') {
    return ctx.reply(`📍 Every region is full (${REGION_CAP} buildings each). You've hit the placement limit even though your tier has room — raid, upgrade a region's buildings, or wait on a higher tier for more room to spread out.`)
  }
  if (outcome?.reason === 'poor') {
    return ctx.reply(`💸 Can't afford *${def.name}*.\nCost: ${fmtCost(outcome.cost)}\nShort: ${fmtMissing(outcome.afford)}`)
  }
  return ctx.reply(
    `${def.emoji} *${def.name} built in the ${outcome.region.name}.*\n` +
    `Paid ${fmtCost(outcome.cost)}.\n` +
    `Treasury: ${outcome.treasury.toLocaleString()} solars.\n\n` +
    `_It starts producing now. Claim with *${p}empire collect*._`
  )
}

/** Text fallback/caption for .empire map: every region, what's built there, and the tally. */
function renderMapText(record) {
  const p = config.prefix
  const counts = regionCountsOf(record)
  const lines = [
    `🗺️ *${record.name}* — territory map`,
    `🏘️ Citizens *${populationOf(record).toLocaleString()}*  ·  ${tierOf(record).name}`,
    RULE,
  ]
  for (const r of REGIONS) {
    const list = buildingsInRegion(record, r.id)
    const label = `📍 *${r.name}*  ·  ${counts[r.id]}/${REGION_CAP}`
    if (!list.length) {
      lines.push(`${label}  ·  _empty_`)
      continue
    }
    const names = list.map(b => buildingDefMap[b.type]?.name ?? b.type).join(', ')
    lines.push(`${label}  ·  ${names}`)
  }
  lines.push(RULE)
  lines.push(`*${p}empire build <type> <region>* to place something new there.`)
  return lines.join('\n')
}

async function mapCmd(ctx) {
  const p = config.prefix
  const query = ctx.args.slice(1).join(' ').trim()
  const rec = query ? findEmpireByQuery(ctx.db, query) : getOwnedEmpire(ctx.db, ctx.from)
  if (!rec) return ctx.reply(query ? `❌ No empire found matching "_${query}_".` : noEmpire(p))

  const caption = renderMapText(rec)
  try {
    const buf = await renderEmpireMap({
      empireName: rec.name,
      tierName: tierOf(rec).name,
      citizenCount: populationOf(rec),
      regions: REGIONS.map(r => ({
        id: r.id,
        name: r.name,
        angle: r.angle,
        cap: REGION_CAP,
        buildings: buildingsInRegion(rec, r.id).map(b => ({
          type: b.type,
          name: buildingDefMap[b.type]?.name ?? b.type,
          level: b.level,
        })),
      })),
      prefix: p,
    })
    return ctx.replyImage(buf, caption)
  } catch {
    // A render failure must never eat the data — the caption is the whole map on its own.
    return ctx.reply(caption)
  }
}

async function upgradeBuilding(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  const type = ctx.args.slice(1).join(' ').toLowerCase().trim()
  if (!type) return ctx.reply(`❌ *Usage:* *${p}empire upgrade <type>*. See *${p}empire build*.`)
  const def = resolveBuildingDef(type)
  if (!def) return ctx.reply(`❌ Unknown building "${type}".`)

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    // Multiple Houses are legal (see the build rule) — upgrade the LOWEST-
    // level one so repeated `.empire upgrade house` raises the stack evenly
    // instead of hammering the same first entry forever. Every other type is
    // one-per-empire, so first-match == only-match for them.
    const all = (rec.buildings ?? []).filter(b => b.type === def.type)
    const b = all.length > 1
      ? all.reduce((lo, b) => (b.level < lo.level ? b : lo), all[0])
      : all[0] ?? null
    if (!b) { outcome = { reason: 'notbuilt' }; return player }
    if (b.level >= def.maxLevel) { outcome = { reason: 'max', level: b.level }; return player }
    // Settle production at the CURRENT level first, so the higher level can't
    // be applied retroactively to time that accrued before the upgrade.
    const settled = applyCollect(rec, now)
    const cost = buildingCostFor(def, b.level + 1)
    const afford = canAfford(rec, cost)
    if (!afford.ok) { outcome = { reason: 'poor', afford, cost, settled }; return player }
    payCost(rec, cost)
    b.level += 1
    b.lastCollectedAt = now
    rec.lastActiveAt = now
    outcome = { reason: 'ok', cost, settled, level: b.level, treasury: rec.treasury }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'notbuilt') return ctx.reply(`🏗️ You haven't built a ${def.name} yet. Use *${p}empire build ${def.type}*.`)
  if (outcome?.reason === 'max') return ctx.reply(`✅ Your ${def.name} is already at max level (${outcome.level}).`)
  if (outcome?.reason === 'poor') {
    let msg = `💸 Can't afford to upgrade *${def.name}*.\nCost: ${fmtCost(outcome.cost)}\nShort: ${fmtMissing(outcome.afford)}`
    if (outcome.settled?.hasSomething) msg += `\n\n_(Production was settled first.)_`
    return ctx.reply(msg)
  }
  let msg = `${def.emoji} *${def.name}* upgraded to *Lv${outcome.level}*.\nPaid ${fmtCost(outcome.cost)}. Treasury: ${outcome.treasury.toLocaleString()} solars.`
  if (outcome.settled?.hasSomething) {
    const gained = []
    if (outcome.settled.solarsGain) gained.push(`${outcome.settled.solarsGain.toLocaleString()} solars`)
    for (const [id, qty] of Object.entries(outcome.settled.matStored)) gained.push(`${qty} ${mname(id).toLowerCase()}`)
    if (gained.length) msg += `\n\n_Production settled first: ${gained.join(', ')}._`
  }
  return ctx.reply(msg)
}

function renderShop(record) {
  const p = config.prefix
  const lines = [
    `🛒 *MATERIAL SHOP · ${record.name}*`,
    `💰 Treasury *${record.treasury.toLocaleString()}*   ·   📦 Warehouse room *${warehouseRoom(record).toLocaleString()}*`,
    RULE,
  ]
  for (const id of MATERIAL_IDS) {
    if (SHOP_PRICES[id] == null) continue
    lines.push(`• ${mname(id)}  ·  *${SHOP_PRICES[id].toLocaleString()}* solars each`)
  }
  lines.push(RULE)
  lines.push(`🛍️ Buy: *${p}empire shop buy <material> <qty>*`)
  lines.push(`📌 *Next:* stock what your upgrades need, then *${p}empire upgrade <type>*.`)
  return lines.join('\n')
}

async function shopCmd(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  const action = ctx.args[1]?.toLowerCase()
  if (!action) return ctx.reply(renderShop(owned))
  if (action !== 'buy') return ctx.reply(`❌ *Usage:* *${p}empire shop* or *${p}empire shop buy <material> <qty>*.`)

  const matId = ctx.args[2]?.toLowerCase()
  const qty = parseInt(ctx.args[3], 10)
  if (!matId || SHOP_PRICES[matId] == null) {
    return ctx.reply(`❌ The build-shop doesn't sell "${matId ?? ''}". See *${p}empire shop*.`)
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return ctx.reply(`❌ How many? e.g. *${p}empire shop buy ${matId} 20*.`)
  }
  const price = SHOP_PRICES[matId]
  const cost = price * qty

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    if ((rec.treasury ?? 0) < cost) { outcome = { reason: 'poor', cost, have: rec.treasury ?? 0 }; return player }
    const room = warehouseRoom(rec)
    if (qty > room) { outcome = { reason: 'full', room }; return player }
    rec.treasury -= cost
    rec.warehouse[matId] = (rec.warehouse[matId] ?? 0) + qty
    rec.lastActiveAt = Date.now()
    outcome = { reason: 'ok', treasury: rec.treasury }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'poor') {
    return ctx.reply(`💸 That costs *${cost.toLocaleString()} solars*. Your treasury has *${outcome.have.toLocaleString()}*.`)
  }
  if (outcome?.reason === 'full') {
    return ctx.reply(`📦 Not enough warehouse room. Space for *${outcome.room.toLocaleString()}* more. Raise a warehouse to store more.`)
  }
  return ctx.reply(
    `🛒 Bought *${qty.toLocaleString()} ${mname(matId).toLowerCase()}* for ${cost.toLocaleString()} solars.\n` +
    `Treasury: ${outcome.treasury.toLocaleString()} solars.`
  )
}

// ── Citizenship (join / leave / citizens) ────────────────────────────────────

async function joinEmpire(ctx, allUsers) {
  const p = config.prefix
  const query = ctx.args.slice(1).join(' ').trim()
  if (!query) return ctx.reply(`👥 *Join which empire?* Try *${p}empire join <name>*. See *${p}empire-top* for who is hiring.`)

  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`❌ No empire matches *"${query}"*. Check the name on *${p}empire-top*.`)
  if (getOwnedEmpire(ctx.db, ctx.from)) {
    return ctx.reply(`🏰 You rule your own empire. A ruler cannot swear to another.`)
  }
  const targetId = target.id
  const targetName = target.name
  const ownerId = target.ownerId

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[targetId]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    if (player.empireId === targetId) { outcome = { reason: 'already' }; return player }
    if (player.empireId) { outcome = { reason: 'sworn', to: player.empireId }; return player }
    // Recount inside the mutator so two simultaneous joins can't both slip
    // past the last free seat.
    const citizens = Object.values(ctx.db.data.users ?? {})
      .filter(u => u.empireId === targetId && u.empireRole === 'citizen').length
    const cap = citizenCap(rec)
    if (citizens >= cap) { outcome = { reason: 'full', cap }; return player }
    player.empireId = targetId
    player.empireRole = 'citizen'
    player.empireJoinedAt = now
    // Headcount just grew by one sworn player, and fame is derived from it, so
    // bump both here rather than waiting for the next reconcile-on-read.
    rec.citizenCount = (rec.citizenCount ?? 0) + 1
    rec.fame = populationOf(rec)
    rec.lastActiveAt = now
    outcome = { reason: 'ok', seats: cap - citizens - 1, cap }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire no longer exists.`)
  if (outcome?.reason === 'already') return ctx.reply(`👥 You're already a citizen of *${targetName}*.`)
  if (outcome?.reason === 'sworn') {
    const cur = ctx.db.data.empires?.[outcome.to]?.name ?? outcome.to
    return ctx.reply(`👥 You're already sworn to *${cur}*. Leave it first with *${p}empire leave*.`)
  }
  if (outcome?.reason === 'full') {
    return ctx.reply(
      `👥 *${targetName}* is full (${outcome.cap} citizens at its tier).\n` +
      `_Its ruler must grow it to a higher tier before it can swear in another._`
    )
  }

  // One notification to the ruler, outside the mutator, best effort. Never a
  // loop over the other citizens.
  if (ownerId && ownerId !== ctx.from) {
    await pushNotification(ctx.db, ownerId, {
      kind: 'empire',
      title: `👥 A new citizen joined ${targetName}`,
      body: `${ctx.player?.name ?? 'A traveler'} swore themselves to your empire.`,
    }).catch(() => {})
  }
  return ctx.reply(
    `👥 *You are now a citizen of ${targetName}.*\n${RULE}\n` +
    `Seats left: *${outcome.seats}*.\n\n` +
    `As a citizen you can:\n` +
    `> post your characters with *${p}empire assign*\n` +
    `> buy at the empire market for less: *${p}empire buy*\n` +
    `_Your own stats and gear are untouched. Leave any time with *${p}empire leave*._`
  )
}

async function leaveEmpire(ctx) {
  const p = config.prefix
  if (getOwnedEmpire(ctx.db, ctx.from)) {
    return ctx.reply(
      `🏰 You *rule* this empire, so you cannot walk away from it.\n` +
      `_A ruler parts with an empire by selling it._`
    )
  }
  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    if (!player.empireId) { outcome = { reason: 'none' }; return player }
    const rec = ctx.db.data.empires?.[player.empireId]
    const name = rec?.name ?? player.empireId
    // A post must never outlive the citizenship that justified it, so settle
    // production at the old rates first, then pull this player's characters.
    let pulled = []
    if (rec) {
      applyCollect(rec, now)
      pulled = stripPlayerAssignments(rec, ctx.from)
      // One fewer sworn player, so keep the derived fame in step immediately.
      rec.citizenCount = Math.max(0, (rec.citizenCount ?? 1) - 1)
      rec.fame = populationOf(rec)
      rec.lastActiveAt = now
    }
    player.empireId = null
    player.empireRole = null
    player.empireJoinedAt = null
    outcome = { reason: 'ok', name, pulled: pulled.map(a => characterLabel(a.charId)) }
    return player
  })

  if (outcome?.reason === 'none') return ctx.reply(`👥 You don't belong to any empire.`)
  let msg = `👋 You are no longer a citizen of *${outcome.name}*.`
  if (outcome.pulled.length) msg += `\nYour posted characters came home: ${outcome.pulled.join(', ')}.`
  msg += `\n_Free to join another with *${p}empire join <name>* or found your own._`
  return ctx.reply(msg)
}

async function citizensView(ctx, allUsers) {
  const p = config.prefix
  const query = ctx.args.slice(1).join(' ').trim()
  let record = query ? findEmpireByQuery(ctx.db, query) : getOwnedEmpire(ctx.db, ctx.from)
  if (!record && !query) {
    const mine = ctx.db.data.empires?.[ctx.player?.empireId]
    if (mine) record = mine
  }
  if (!record) {
    return query
      ? ctx.reply(`❌ No empire matches *"${query}"*.`)
      : ctx.reply(`👥 You don't belong to an empire yet. Join one with *${p}empire join <name>*.`)
  }

  const members = getEmpireMembers(record.id, allUsers)
  const owner = members.find(u => u.empireRole === 'owner')
  const citizens = members.filter(u => u.empireRole === 'citizen')
  const lines = [`👥 *Citizens of ${record.name}*`, RULE]
  lines.push(`👑 *${owner?.name ?? 'Unknown ruler'}* _(ruler)_`)
  if (!citizens.length) {
    lines.push(`\nNo citizens yet. Seats open: *${citizenCap(record)}*.`)
    lines.push(`> *${p}empire join ${record.name}*`)
    return ctx.reply(lines.join('\n'))
  }
  const sorted = [...citizens].sort((a, b) => (a.empireJoinedAt ?? 0) - (b.empireJoinedAt ?? 0))
  for (const u of sorted) {
    const posts = playerAssignmentCount(record, u.id)
    lines.push(`• ${u.name ?? 'Someone'}${posts ? `  ·  ${posts} posted` : ''}`)
  }
  lines.push(RULE)
  lines.push(`*${citizens.length}/${citizenCap(record)}* seats filled.`)
  return ctx.reply(lines.join('\n'))
}

// ── Character posts (assign / unassign) ──────────────────────────────────────

/** The empire a player may post characters to: the one they belong to. */
function homeEmpire(ctx) {
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (owned) return owned
  const id = ctx.player?.empireId
  return id ? (ctx.db.data.empires?.[id] ?? null) : null
}

function assignHelp(p) {
  return (
    `🧑‍🌾 *Put a character to work.*\n` +
    `> *${p}empire assign worker <character> <building>*\n` +
    `> *${p}empire assign general <character>*\n` +
    `> *${p}empire unassign <character>*\n\n` +
    `_A worker raises one building's output. A general raises your army's power._\n` +
    `_Posting never unequips a character, so they still fight for you._\n` +
    `_Room for ${WORKER_CAP} workers and ${GENERAL_CAP} general per empire, ${PER_PLAYER_CAP} posts per person._`
  )
}

async function assignCmd(ctx) {
  const p = config.prefix
  const record = homeEmpire(ctx)
  if (!record) return ctx.reply(`👥 Join or found an empire before posting characters. See *${p}empire*.`)

  const role = ctx.args[1]?.toLowerCase()
  if (!role || !ROLES.includes(role)) return ctx.reply(assignHelp(p))

  const rest = ctx.args.slice(2)
  if (!rest.length) return ctx.reply(assignHelp(p))

  // For a worker the LAST argument is the building, so a multi-word character
  // name still resolves: `assign worker blue archive solar_mine`.
  let buildingType = null
  let charQuery = rest.join(' ').trim()
  if (role === 'worker') {
    if (rest.length < 2) {
      return ctx.reply(`🧑‍🌾 Which building? Try *${p}empire assign worker <character> <building>*.`)
    }
    buildingType = rest[rest.length - 1].toLowerCase()
    charQuery = rest.slice(0, -1).join(' ').trim()
  }

  const charId = findOwnedCharacter(ctx.player, charQuery)
  if (!charId) {
    return ctx.reply(
      `❌ You don't own a character matching *"${charQuery}"*.\n` +
      `_See yours with *${p}character*._`
    )
  }

  const pre = canAssign({ record, player: ctx.player, ownerJid: ctx.from, charId, role, buildingType })
  if (!pre.ok) {
    const label = characterLabel(charId)
    if (pre.reason === 'notmember') return ctx.reply(`👥 You don't belong to that empire any more.`)
    if (pre.reason === 'already') {
      return ctx.reply(`🧑‍🌾 ${label} already holds a post here. Free them with *${p}empire unassign ${charId}*.`)
    }
    if (pre.reason === 'playercap') {
      return ctx.reply(`🧑‍🌾 You already have *${pre.cap}* characters posted here. Recall one first.`)
    }
    if (pre.reason === 'generalcap') return ctx.reply(`🎖️ This empire already has a general. Only *${pre.cap}* may command.`)
    if (pre.reason === 'workercap') return ctx.reply(`👷 All *${pre.cap}* worker posts are filled. Recall someone first.`)
    if (pre.reason === 'nosuchbuilding') return ctx.reply(`❌ There is no building called "${buildingType}". See *${p}empire build*.`)
    if (pre.reason === 'notbuilt') return ctx.reply(`🏗️ *${record.name}* has no ${pre.def.name} yet. Raise one with *${p}empire build ${buildingType}*.`)
    if (pre.reason === 'notproducer') return ctx.reply(`🏗️ A ${pre.def.name} produces nothing, so a worker has nothing to raise there.`)
    if (pre.reason === 'occupied') {
      return ctx.reply(`👷 ${characterLabel(pre.sitting.charId)} already works the ${pre.def.name}.`)
    }
    return ctx.reply(`❌ ${label} cannot take that post.`)
  }

  const recId = record.id
  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[recId]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    // Re-check inside the mutator: two posts racing for the last slot must not
    // both land.
    const ok = canAssign({ record: rec, player, ownerJid: ctx.from, charId, role, buildingType })
    if (!ok.ok) { outcome = { reason: ok.reason, detail: ok }; return player }
    // A worker changes a production RATE, so settle at the old rate first.
    if (role === 'worker') applyCollect(rec, now)
    const entry = applyAssign(rec, { charId, ownerJid: ctx.from, role, buildingType, now })
    rec.lastActiveAt = now
    outcome = { reason: 'ok', entry, bonus: ok.bonus, stars: ok.stars }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire record could not be found.`)
  if (outcome?.reason !== 'ok') return ctx.reply(`❌ That post was just taken. Try another.`)

  const label = characterLabel(charId)
  const pct = Math.round((outcome.bonus ?? 0) * 100)
  if (role === 'general') {
    return ctx.reply(
      `🎖️ *${label} takes command of ${record.name}'s army.*\n${RULE}\n` +
      `Army power: *+${pct}%* (${outcome.stars}★).\n` +
      `_Felt in raids and wars. Your empire's might is unchanged, so this does not shift who may raid you._\n` +
      `_${label} is still yours to equip and fight with._`
    )
  }
  const def = buildingDefMap[buildingType]
  return ctx.reply(
    `👷 *${label} goes to work at the ${def.name}.*\n${RULE}\n` +
    `Output: *+${pct}%* (${outcome.stars}★). Upkeep is unchanged, so your margin widens.\n` +
    `_Production was settled first, so nothing already earned is affected._\n` +
    `> *${p}empire collect* to claim it`
  )
}

async function unassignCmd(ctx) {
  const p = config.prefix
  const record = homeEmpire(ctx)
  if (!record) return ctx.reply(`👥 You don't belong to an empire. See *${p}empire*.`)
  const query = ctx.args.slice(1).join(' ').trim()
  if (!query) return ctx.reply(`🧑‍🌾 *Recall whom?* Try *${p}empire unassign <character>*.`)

  // Resolve against what is actually posted here, so a ruler can also dismiss
  // a citizen's character (they hold the empire, so they hold the roster).
  const isOwner = record.ownerId === ctx.from
  const posted = [...(record.assignments?.workers ?? []), ...(record.assignments?.generals ?? [])]
  const q = query.toLowerCase()
  const hit = posted.find(a => a.charId === q)
    ?? posted.find(a => (characterMap[a.charId]?.name ?? '').toLowerCase().includes(q))
  if (!hit) return ctx.reply(`🧑‍🌾 No posted character matches *"${query}"*. See *${p}empire*.`)
  if (!isOwner && hit.ownerJid !== ctx.from) {
    return ctx.reply(`🧑‍🌾 ${characterLabel(hit.charId)} is not yours to recall. Only their owner or the ruler can.`)
  }

  const recId = record.id
  const charId = hit.charId
  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[recId]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const held = assignmentOf(rec, charId)
    if (!held) { outcome = { reason: 'gone' }; return player }
    // Settle first: dropping a worker lowers a production rate.
    if (held.role === 'worker') applyCollect(rec, now)
    const res = applyUnassign(rec, charId)
    rec.lastActiveAt = now
    outcome = { reason: res.ok ? 'ok' : 'gone', role: res.role, entry: res.entry }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire record could not be found.`)
  if (outcome?.reason !== 'ok') return ctx.reply(`🧑‍🌾 That character no longer holds a post.`)
  const label = characterLabel(charId)
  const where = outcome.role === 'worker'
    ? `the ${buildingDefMap[outcome.entry.buildingType]?.name ?? outcome.entry.buildingType}`
    : `command of the army`
  return ctx.reply(
    `🧑‍🌾 *${label}* is recalled from ${where}.\n` +
    `_Production was settled first, so nothing already earned is lost._`
  )
}

// ── Storefront (market / buy / visit) ────────────────────────────────────────

function priceBandFor(matId) {
  const base = SHOP_PRICES[matId] ?? 0
  return {
    base,
    floor: Math.max(1, Math.floor(base * (MARKET_CONFIG?.priceFloorPct ?? 0.5))),
    ceil: Math.max(1, Math.ceil(base * (MARKET_CONFIG?.priceCeilPct ?? 2))),
  }
}

function renderMarket(record, isOwner) {
  const p = config.prefix
  const stock = record.market?.stock ?? []
  const lines = [`🏪 *${record.name} Market*`, RULE]
  if (!stock.length) {
    lines.push(`Nothing is for sale here yet.`)
    if (isOwner) {
      lines.push('')
      lines.push(`List what your buildings produce:`)
      lines.push(`> *${p}empire market set <material> <price> <qty>*`)
    }
    return lines.join('\n')
  }
  for (const s of stock) {
    lines.push(`${mname(s.itemId)}  ·  *${s.price.toLocaleString()}* solars each  ·  ${s.qty.toLocaleString()} left`)
  }
  lines.push(RULE)
  if (isOwner) {
    lines.push(`Revenue so far: *${(record.market?.revenue ?? 0).toLocaleString()}* solars.`)
    lines.push(`> *${p}empire market set <material> <price> <qty>*`)
    lines.push(`> *${p}empire market clear <material>*`)
  } else {
    lines.push(`> *${p}empire buy <material> [qty]*`)
    lines.push(`_Citizens pay ${Math.round((MARKET_CONFIG?.citizenDiscountPct ?? 0) * 100)}% less._`)
  }
  return lines.join('\n')
}

async function marketCmd(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  const action = ctx.args[1]?.toLowerCase()

  if (!action) {
    const record = owned ?? homeEmpire(ctx)
    if (!record) return ctx.reply(`🏪 You don't belong to an empire. Visit one with *${p}empire visit <name>*.`)
    return ctx.reply(renderMarket(record, record.ownerId === ctx.from))
  }
  if (!owned) return ctx.reply(`🏰 Only a ruler stocks a market. ${noEmpire(p)}`)
  if (action !== 'set' && action !== 'clear') {
    return ctx.reply(`❌ *Usage:* *${p}empire market set <material> <price> <qty>* or *${p}empire market clear <material>*.`)
  }

  const matId = ctx.args[2]?.toLowerCase()
  if (!matId || !MATERIAL_IDS.includes(matId)) {
    return ctx.reply(`❌ *"${matId ?? ''}"* is not something your empire produces or stores.`)
  }
  const ownedId = owned.id

  if (action === 'clear') {
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[ownedId]
      if (!rec) { outcome = { reason: 'missing' }; return player }
      const i = (rec.market.stock ?? []).findIndex(s => s.itemId === matId)
      if (i < 0) { outcome = { reason: 'nolisting' }; return player }
      const [entry] = rec.market.stock.splice(i, 1)
      // Unsold stock goes back to the warehouse, clamped to whatever room is
      // left; anything that cannot fit is reported rather than silently lost.
      const room = warehouseRoom(rec)
      const returned = Math.min(entry.qty, room)
      rec.warehouse[matId] = (rec.warehouse[matId] ?? 0) + returned
      rec.lastActiveAt = Date.now()
      outcome = { reason: 'ok', returned, lost: entry.qty - returned }
      return player
    })
    if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
    if (outcome?.reason === 'nolisting') return ctx.reply(`🏪 You have no ${mname(matId).toLowerCase()} listed.`)
    let msg = `🏪 Pulled *${mname(matId).toLowerCase()}* from the market. ${outcome.returned.toLocaleString()} returned to the warehouse.`
    if (outcome.lost) msg += `\n⚠️ ${outcome.lost.toLocaleString()} could not fit and was left behind.`
    return ctx.reply(msg)
  }

  const price = parseInt(ctx.args[3], 10)
  const qty = parseInt(ctx.args[4], 10)
  const band = priceBandFor(matId)
  if (!Number.isInteger(price) || price <= 0 || !Number.isInteger(qty) || qty <= 0) {
    return ctx.reply(
      `❌ *Usage:* *${p}empire market set ${matId} <price> <qty>*\n` +
      `_Fair price for ${mname(matId).toLowerCase()}: ${band.floor.toLocaleString()} to ${band.ceil.toLocaleString()} solars._`
    )
  }
  if (price < band.floor || price > band.ceil) {
    return ctx.reply(
      `⚖️ That price is outside the fair band for ${mname(matId).toLowerCase()}.\n` +
      `Allowed: *${band.floor.toLocaleString()}* to *${band.ceil.toLocaleString()}* solars each.\n` +
      `_Prices are banded so a market cannot be used to shovel solars between accounts._`
    )
  }

  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[ownedId]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const have = rec.warehouse?.[matId] ?? 0
    if (have < qty) { outcome = { reason: 'short', have }; return player }
    const existing = (rec.market.stock ?? []).find(s => s.itemId === matId)
    if (!existing && (rec.market.stock?.length ?? 0) >= (MARKET_CONFIG?.stockCap ?? 8)) {
      outcome = { reason: 'stockcap', cap: MARKET_CONFIG?.stockCap ?? 8 }
      return player
    }
    // Stock is MOVED out of the warehouse into the listing, so the same units
    // can never be both sold to a visitor and spent on a building.
    rec.warehouse[matId] = have - qty
    if (existing) { existing.price = price; existing.qty += qty }
    else rec.market.stock.push({ itemId: matId, price, qty })
    rec.lastActiveAt = Date.now()
    outcome = { reason: 'ok', qty: existing ? existing.qty : qty }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'short') {
    return ctx.reply(`📦 Your warehouse only holds *${outcome.have.toLocaleString()}* ${mname(matId).toLowerCase()}.`)
  }
  if (outcome?.reason === 'stockcap') {
    return ctx.reply(`🏪 Your market already carries *${outcome.cap}* lines. Clear one first.`)
  }
  return ctx.reply(
    `🏪 *Listed for sale.*\n${RULE}\n` +
    `${mname(matId)} at *${price.toLocaleString()}* solars each, *${outcome.qty.toLocaleString()}* in stock.\n` +
    `_Moved out of the warehouse and onto the shelves. Visitors pay into your treasury._\n` +
    `> *${p}empire market clear ${matId}* to pull it back`
  )
}

async function visitEmpire(ctx) {
  const p = config.prefix
  const query = ctx.args.slice(1).join(' ').trim()
  if (!query) return ctx.reply(`🧭 *Visit which empire?* Try *${p}empire visit <name>*.`)
  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`❌ No empire matches *"${query}"*.`)
  const minRank = MARKET_CONFIG?.mapMinRank ?? 3
  if (tierOf(target).rank < minRank) {
    return ctx.reply(
      `🧭 *${target.name}* is too small to appear on any map yet.\n` +
      `_An empire is worth travelling to from ${TIER_ORDER.find(t => t.rank === minRank)?.name ?? 'City'} tier up._`
    )
  }
  if (target.ownerId === ctx.from) return ctx.reply(`🧭 You're already home. This is your own empire.`)

  const cost = MARKET_CONFIG?.travelCostSolars ?? 0
  const targetId = target.id
  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    if (player.inBattle) { outcome = { reason: 'battle' }; return player }
    if (player.inDungeon) { outcome = { reason: 'dungeon' }; return player }
    const wallet = player.wallet ?? (player.wallet = {})
    if ((wallet.solars ?? 0) < cost) { outcome = { reason: 'poor', have: wallet.solars ?? 0 }; return player }
    wallet.solars -= cost
    // A visit is tracked on its own field, NOT player.location: every existing
    // map and location reader keeps seeing a player safely in town, which is
    // exactly the guard the plan asked for.
    player.visitingEmpire = targetId
    player.visitingSince = Date.now()
    outcome = { reason: 'ok', balance: wallet.solars }
    return player
  })

  if (outcome?.reason === 'battle') return ctx.reply(`⚔️ Finish your current battle first.`)
  if (outcome?.reason === 'dungeon') return ctx.reply(`🗺️ Leave the dungeon before you go visiting.`)
  if (outcome?.reason === 'poor') {
    return ctx.reply(`💸 The road there costs *${cost.toLocaleString()} solars*. You have *${outcome.have.toLocaleString()}*.`)
  }
  const stock = target.market?.stock ?? []
  return ctx.reply(
    `🧭 *You arrive at ${target.name}.*\n${RULE}\n` +
    `_${tierOf(target).name}, ruled by another. The road cost ${cost.toLocaleString()} solars._\n\n` +
    (stock.length
      ? `🏪 The market is open with *${stock.length}* line${stock.length === 1 ? '' : 's'}.\n> *${p}empire buy*`
      : `🏪 The market stalls are empty today.`) +
    `\n_Head home whenever with *${p}travel town*._`
  )
}

/** The empire whose market this player may shop at right now. */
function shoppingAt(ctx) {
  const visiting = ctx.player?.visitingEmpire
  // Walking into a dungeon means you are no longer standing in a foreign
  // market, whatever the visit field still says. Your own empire's stalls stay
  // reachable, same as `.empire shop`.
  const away = ctx.player?.inDungeon || ctx.player?.inBattle
  if (visiting && !away && ctx.db.data.empires?.[visiting]) return ctx.db.data.empires[visiting]
  return homeEmpire(ctx)
}

async function buyCmd(ctx) {
  const p = config.prefix
  const record = shoppingAt(ctx)
  if (!record) {
    return ctx.reply(
      `🏪 You're not standing in any empire's market.\n` +
      `> *${p}empire visit <name>* to travel to one`
    )
  }
  const isMember = ctx.player?.empireId === record.id
  const matId = ctx.args[1]?.toLowerCase()
  if (!matId) return ctx.reply(renderMarket(record, record.ownerId === ctx.from))
  if (record.ownerId === ctx.from) {
    return ctx.reply(`🏪 This is your own market. Pull stock back with *${p}empire market clear <material>*.`)
  }

  const qty = ctx.args[2] ? parseInt(ctx.args[2], 10) : 1
  if (!Number.isInteger(qty) || qty <= 0) return ctx.reply(`❌ How many? e.g. *${p}empire buy ${matId} 5*.`)
  const listing = (record.market?.stock ?? []).find(s => s.itemId === matId)
  if (!listing) return ctx.reply(`🏪 *${record.name}* isn't selling ${mname(matId).toLowerCase()}. See *${p}empire buy*.`)
  if (!hasInventoryRoom(ctx.player, qty)) return ctx.reply(inventoryFullMessage(ctx.player))

  const discount = isMember ? (MARKET_CONFIG?.citizenDiscountPct ?? 0) : 0
  const recId = record.id
  const sellerId = record.ownerId
  const sellerName = record.name

  // ONE mutator: the stock decrement, the buyer's debit and the seller's
  // credit are the same serialized write, so stock can never be sold twice and
  // no solars can appear or vanish in between. The seller's own player record
  // is untouched: their wealth is the empire treasury.
  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[recId]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const line = (rec.market.stock ?? []).find(s => s.itemId === matId)
    if (!line) { outcome = { reason: 'gone' }; return player }
    const take = Math.min(qty, line.qty)
    if (take <= 0) { outcome = { reason: 'gone' }; return player }
    const unit = Math.max(1, Math.round(line.price * (1 - discount)))
    const total = unit * take
    const wallet = player.wallet ?? (player.wallet = {})
    if ((wallet.solars ?? 0) < total) { outcome = { reason: 'poor', total, have: wallet.solars ?? 0 }; return player }
    if (!Array.isArray(player.inventory)) player.inventory = []
    if (!hasInventoryRoom(player, take)) { outcome = { reason: 'full' }; return player }

    wallet.solars -= total
    for (let i = 0; i < take; i++) player.inventory.push(matId)
    line.qty -= take
    if (line.qty <= 0) rec.market.stock = rec.market.stock.filter(s => s !== line)
    rec.treasury += total
    rec.market.revenue = (rec.market.revenue ?? 0) + total
    rec.lastActiveAt = Date.now()
    outcome = { reason: 'ok', take, unit, total, balance: wallet.solars, short: take < qty }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ That empire record could not be found.`)
  if (outcome?.reason === 'gone') return ctx.reply(`🏪 That line just sold out.`)
  if (outcome?.reason === 'full') return ctx.reply(inventoryFullMessage(ctx.player))
  if (outcome?.reason === 'poor') {
    return ctx.reply(`💸 That costs *${outcome.total.toLocaleString()} solars*. You have *${outcome.have.toLocaleString()}*.`)
  }

  // One notification to the seller, outside the mutator, best effort.
  if (sellerId) {
    await pushNotification(ctx.db, sellerId, {
      kind: 'empire',
      title: `🏪 ${sellerName} made a sale`,
      body: `${ctx.player?.name ?? 'A visitor'} bought ${outcome.take.toLocaleString()} ${mname(matId).toLowerCase()} `
        + `for ${outcome.total.toLocaleString()} solars. It went into your treasury.`,
    }).catch(() => {})
  }

  const lines = [`🛍️ *Bought at ${sellerName}*`, RULE]
  lines.push(`${mname(matId)} x*${outcome.take.toLocaleString()}* for *${outcome.total.toLocaleString()}* solars.`)
  if (discount > 0) lines.push(`_Citizen price: ${outcome.unit.toLocaleString()} each._`)
  if (outcome.short) lines.push(`_Only ${outcome.take.toLocaleString()} were left in stock._`)
  lines.push(`Your solars: *${outcome.balance.toLocaleString()}*.`)
  lines.push(`_Straight into your bag. The solars went to the ruler's treasury._`)
  return ctx.reply(lines.join('\n'))
}

// ── Sell / buyout (transfer an empire between rulers) ────────────────────────

async function sellCmd(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))
  const now = Date.now()
  const arg = ctx.args[1]?.toLowerCase()

  // Pull an existing listing off the market.
  if (arg === 'cancel' || arg === 'clear' || arg === 'off') {
    let had = false
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[owned.id]
      if (!rec) return player
      had = !!rec.sellListing
      rec.sellListing = null
      rec.dormant = false
      rec.lastActiveAt = now
      return player
    })
    return ctx.reply(had
      ? `🏷️ *${owned.name}* is off the market.`
      : `🏷️ *${owned.name}* was not listed for sale.`)
  }

  // A contested or subjugated empire cannot change hands.
  if (owned.war?.status === 'active') {
    return ctx.reply(`⚔️ You cannot sell *${owned.name}* while it is at war. End the war first.`)
  }
  if (owned.war?.status === 'declared') {
    return ctx.reply(`📜 Withdraw your declaration of war with *${p}war peace* before you sell.`)
  }
  if (isVassal(owned, now)) {
    return ctx.reply(`⛓️ *${owned.name}* is a vassal and cannot be sold until it is free.`)
  }

  const price = parseInt(ctx.args[1], 10)
  const min = SELL_CONFIG.minPrice ?? 1
  const max = SELL_CONFIG.maxPrice ?? Infinity
  const burnPct = SELL_CONFIG.burnPct ?? 0
  if (!Number.isInteger(price) || price <= 0) {
    return ctx.reply(
      `🏷️ *Sell your empire.*\n` +
      `> *${p}empire sell <price>* to list it for another ruler to buy\n` +
      `> *${p}empire sell cancel* to pull the listing\n` +
      `_Asking price must be between ${min.toLocaleString()} and ${max.toLocaleString()} solars. ` +
      `The buyer pays into your wallet, and ${Math.round(burnPct * 100)}% is lost to the handover._`
    )
  }
  if (price < min || price > max) {
    return ctx.reply(`🏷️ Set an asking price between *${min.toLocaleString()}* and *${max.toLocaleString()}* solars.`)
  }

  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) return player
    rec.sellListing = { price, at: now }
    rec.dormant = false
    rec.lastActiveAt = now
    return player
  })
  const net = Math.floor(price * (1 - burnPct))
  return ctx.reply(
    `🏷️ *${owned.name} is for sale.*\n${RULE}\n` +
    `Asking *${price.toLocaleString()} solars*. You would keep *${net.toLocaleString()}* after the handover cut.\n` +
    `Another ruler-less player buys it with *${p}empire buyout ${owned.name}*.\n` +
    `_Pull it any time with *${p}empire sell cancel*._`
  )
}

async function buyoutCmd(ctx) {
  const p = config.prefix
  const query = ctx.args.slice(1).join(' ').trim()
  const now = Date.now()

  // One empire per player: a buyer must be wholly unaffiliated first.
  if (getOwnedEmpire(ctx.db, ctx.from)) {
    return ctx.reply(`🏰 You already rule an empire. Sell it before buying another.`)
  }
  if (ctx.player?.empireId) {
    return ctx.reply(`👥 Leave your current empire with *${p}empire leave* before buying one.`)
  }
  if (!query) return ctx.reply(`💰 *Buy which empire?* Try *${p}empire buyout <name>*. A listed empire shows its price on *${p}empire info <name>*.`)

  const target = findEmpireByQuery(ctx.db, query)
  if (!target) return ctx.reply(`❌ No empire matches *"${query}"*.`)
  if (target.ownerId === ctx.from) return ctx.reply(`🏰 You cannot buy your own empire.`)
  if (!target.sellListing || !(target.sellListing.price > 0)) {
    return ctx.reply(`🏷️ *${target.name}* is not for sale.`)
  }
  if (target.war?.status === 'active') return ctx.reply(`⚔️ *${target.name}* is at war and cannot be bought right now.`)
  if (isVassal(target, now)) return ctx.reply(`⛓️ *${target.name}* is a vassal and cannot be bought until it is free.`)

  const price = Math.max(1, Math.floor(target.sellListing.price))
  const have = ctx.player?.wallet?.solars ?? 0
  if (have < price) {
    return ctx.reply(`💸 *${target.name}* costs *${price.toLocaleString()} solars*. You have *${have.toLocaleString()}*.`)
  }

  const recId = target.id
  const recName = target.name
  const sellerId = target.ownerId
  const burnPct = SELL_CONFIG.burnPct ?? 0

  // Two sequential writes (never nested). BUYER first: re-check, debit the
  // wallet, and take the record over in the same pass, settling its books and
  // pulling the departing ruler's own posts before their worker boost can carry
  // into the new reign. SELLER second: clear their throne and take the proceeds,
  // net of the burned handover cut. Citizens keep their seats under the new lord.
  let outcome = null
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[recId]
    if (!rec) { outcome = { reason: 'gone' }; return player }
    if (!rec.sellListing || !(rec.sellListing.price > 0)) { outcome = { reason: 'unlisted' }; return player }
    if (rec.war?.status === 'active' || isVassal(rec, now)) { outcome = { reason: 'contested' }; return player }
    if (player.empireId) { outcome = { reason: 'haveempire' }; return player }
    const livePrice = Math.max(1, Math.floor(rec.sellListing.price))
    const wallet = player.wallet ?? (player.wallet = {})
    if ((wallet.solars ?? 0) < livePrice) { outcome = { reason: 'poor', price: livePrice, have: wallet.solars ?? 0 }; return player }
    // Settle at the old rates, then pull the departing ruler's posts so no
    // worker boost survives the handover.
    applyCollect(rec, now)
    stripPlayerAssignments(rec, sellerId)
    wallet.solars -= livePrice
    rec.ownerId = ctx.from
    rec.sellListing = null
    rec.dormant = false
    rec.lastActiveAt = now
    player.empireId = recId
    player.empireRole = 'owner'
    player.empireJoinedAt = now
    outcome = { reason: 'ok', price: livePrice, balance: wallet.solars }
    return player
  })

  if (outcome?.reason === 'gone') return ctx.reply(`❌ *${recName}* no longer exists.`)
  if (outcome?.reason === 'unlisted') return ctx.reply(`🏷️ *${recName}* is no longer for sale.`)
  if (outcome?.reason === 'contested') return ctx.reply(`⚔️ *${recName}* is contested right now and cannot change hands.`)
  if (outcome?.reason === 'haveempire') return ctx.reply(`🏰 You already belong to an empire.`)
  if (outcome?.reason === 'poor') {
    return ctx.reply(`💸 *${recName}* costs *${outcome.price.toLocaleString()} solars*. You have *${outcome.have.toLocaleString()}*.`)
  }

  const proceeds = Math.floor(outcome.price * (1 - burnPct))
  if (sellerId && sellerId !== ctx.from) {
    await updatePlayer(ctx.db, sellerId, player => {
      ensureEmpirePlayer(player)
      if (player.empireId === recId) {
        player.empireId = null
        player.empireRole = null
        player.empireJoinedAt = null
      }
      const wallet = player.wallet ?? (player.wallet = {})
      wallet.solars = (wallet.solars ?? 0) + proceeds
      return player
    })
    await pushNotification(ctx.db, sellerId, {
      kind: 'empire',
      title: `🏰 ${recName} has been sold`,
      body: `${ctx.player?.name ?? 'A new ruler'} bought ${recName} for ${outcome.price.toLocaleString()} solars. `
        + `You received ${proceeds.toLocaleString()} after the handover cut.`,
    }).catch(() => {})
  }

  return ctx.reply(
    `🏰 *You are now the ruler of ${recName}.*\n${RULE}\n` +
    `Paid *${outcome.price.toLocaleString()} solars*. Your solars: *${outcome.balance.toLocaleString()}*.\n` +
    `The treasury, buildings and army come with it. The former ruler's posted characters went home.\n` +
    `> *${p}empire* to view your new dashboard`
  )
}

// ── Deposit / withdraw solars (the ruler shares their wallet with the purse) ──

/**
 * The treasury is the empire's shared purse that build, upgrade and recruit all
 * draw from, so only the ruler funds or drains it. deposit/withdraw are a pure
 * balance transfer, so they do NOT settle production first: a deposit simply
 * raises the starting treasury the next collect computes from, and a withdraw
 * pulls only the already-banked treasury (pending production is claimed with
 * *empire collect*, never here). Both sides move in ONE mutator because the
 * ruler IS the player being written, so the wallet debit and the treasury
 * credit can never race each other or a concurrent collect.
 */
async function depositCmd(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const raw = (ctx.args[1] ?? '').toLowerCase()
  const have = ctx.player?.wallet?.solars ?? 0
  if (!raw) {
    return ctx.reply(
      `🏦 *Fund the treasury of ${owned.name}.*\n${RULE}\n` +
      `> *${p}empire deposit <amount>* to move solars from your wallet in\n` +
      `> *${p}empire deposit all* to move your whole wallet in\n` +
      `_Your wallet: *${have.toLocaleString()} solars*  ·  treasury: *${(owned.treasury ?? 0).toLocaleString()}*._`
    )
  }
  const amount = raw === 'all' ? have : Math.floor(Number(raw))
  if (!Number.isInteger(amount) || amount <= 0) {
    return ctx.reply(`❌ How many solars? e.g. *${p}empire deposit 5000* or *${p}empire deposit all*.`)
  }
  if (amount > have) {
    return ctx.reply(`💸 You only have *${have.toLocaleString()} solars* in your wallet.`)
  }

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const wallet = player.wallet ?? (player.wallet = {})
    const bal = wallet.solars ?? 0
    if (bal < amount) { outcome = { reason: 'poor', have: bal }; return player }
    wallet.solars = bal - amount
    rec.treasury = (rec.treasury ?? 0) + amount
    rec.lastActiveAt = now
    outcome = { reason: 'ok', moved: amount, wallet: wallet.solars, treasury: rec.treasury }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'poor') return ctx.reply(`💸 You only have *${outcome.have.toLocaleString()} solars* in your wallet.`)
  return ctx.reply(
    `🏦 *Deposited ${outcome.moved.toLocaleString()} solars into ${owned.name}.*\n` +
    `Treasury: *${outcome.treasury.toLocaleString()}*  ·  your wallet: *${outcome.wallet.toLocaleString()}*.\n` +
    `📌 *Next:* spend it with *${p}empire build*, *${p}empire upgrade <type>* or *${p}recruit <n>*.`
  )
}

async function withdrawCmd(ctx) {
  const p = config.prefix
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const raw = (ctx.args[1] ?? '').toLowerCase()
  const banked = owned.treasury ?? 0
  const have = ctx.player?.wallet?.solars ?? 0
  if (!raw) {
    return ctx.reply(
      `🏦 *Draw solars out of ${owned.name}'s treasury.*\n${RULE}\n` +
      `> *${p}empire withdraw <amount>* to move treasury solars to your wallet\n` +
      `> *${p}empire withdraw all* to empty the banked treasury into your wallet\n` +
      `_Treasury: *${banked.toLocaleString()} solars*  ·  your wallet: *${have.toLocaleString()}*._\n` +
      `_Pending production is claimed with *${p}empire collect*, not here._`
    )
  }
  const amount = raw === 'all' ? banked : Math.floor(Number(raw))
  if (!Number.isInteger(amount) || amount <= 0) {
    return ctx.reply(`❌ How many solars? e.g. *${p}empire withdraw 5000* or *${p}empire withdraw all*.`)
  }

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureEmpirePlayer(player)
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const inPurse = rec.treasury ?? 0
    if (inPurse <= 0) { outcome = { reason: 'empty' }; return player }
    // Clamp to what's banked so "withdraw 999999" and "withdraw all" both just
    // take everything there, never overdrawing the treasury into the negative.
    const move = Math.min(amount, inPurse)
    const wallet = player.wallet ?? (player.wallet = {})
    rec.treasury = inPurse - move
    wallet.solars = (wallet.solars ?? 0) + move
    rec.lastActiveAt = now
    outcome = { reason: 'ok', moved: move, wallet: wallet.solars, treasury: rec.treasury }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'empty') return ctx.reply(`🏦 The treasury is empty. Earn solars with *${p}empire collect*.`)
  return ctx.reply(
    `🏦 *Withdrew ${outcome.moved.toLocaleString()} solars from ${owned.name}.*\n` +
    `Treasury: *${outcome.treasury.toLocaleString()}*  ·  your wallet: *${outcome.wallet.toLocaleString()}*.\n` +
    `📌 *Next:* redeposit any time with *${p}empire deposit <amount>*.`
  )
}

// ── Empire bank (citizens store their own solars; the realm skims a daily tax) ─

/**
 * .empire bank — a ruler and their sworn citizens store PERSONAL wallet solars
 * in the empire's coffers, safe from robbery and PvP, in exchange for a small
 * daily maintenance tax the realm sweeps into its treasury. Deposits and
 * withdrawals move wallet<->account in one mutator; the tax accrues lazily
 * (clamped to the offline cap) and settles on every deposit/withdraw and on
 * .empire collect. Owner + sworn citizens only (stash invitees get no banking
 * rights). Mutates only the acting player + the empire record; never broadcasts.
 */
async function bankCmd(ctx) {
  const p = config.prefix
  // Resolve the empire whose bank this player may use: their own, or the one
  // they are sworn to as a citizen. Invitees who only share a stash get nothing.
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  const me = ctx.db.data.users?.[ctx.from] ?? ctx.player
  let record = null
  let role = null
  if (owned) { record = owned; role = 'owner' }
  else if (me?.empireId && me.empireRole === 'citizen') {
    const rec = ctx.db.data.empires?.[me.empireId]
    if (rec) { record = rec; role = 'citizen' }
  }
  if (!record) {
    return ctx.reply(
      `🏦 You have no realm to bank with.\n` +
      `_Found one with *${p}empire found <name>*, or join one with *${p}empire join <name>*._`
    )
  }
  if (!bankBuilt(record)) {
    return ctx.reply(
      role === 'owner'
        ? `🏦 *${record.name}* has no bank yet.\n` +
          `_Raise one with *${p}empire build bank* (needs Town rank), then you and your citizens can store coin here._`
        : `🏦 *${record.name}* has no bank yet. Only the ruler can build one.`
    )
  }

  const rate = bankTaxRatePerDay()
  const pct = `${+(rate * 100).toFixed(2)}%`
  const action = (ctx.args[1] ?? '').toLowerCase()
  const raw = (ctx.args[2] ?? '').toLowerCase()
  const now = Date.now()

  // Bare .empire bank — a read-only statement (no mutation), mirroring the vault
  // pending-interest display: what you hold and what the next sweep will skim.
  if (!action) {
    const acct = previewBankAccount(record, ctx.from, now)
    const have = me?.wallet?.solars ?? 0
    const held = bankHeld(record)
    const lines = [
      `🏦 *The Bank of ${record.name}*`, RULE,
      `Your balance: *${acct.balance.toLocaleString()} solars*`,
    ]
    if (acct.pendingTax > 0) {
      lines.push(`Maintenance tax due: *-${acct.pendingTax.toLocaleString()}* (settles on your next move or collect)`)
      lines.push(`After tax: *${acct.net.toLocaleString()} solars*`)
    }
    lines.push(`_Daily maintenance tax: ${pct} of your balance, swept to the treasury. The realm holds ${held.toLocaleString()} solars in all._`)
    lines.push('')
    lines.push(`> *${p}empire bank deposit <amount|all>* to store wallet solars here`)
    lines.push(`> *${p}empire bank withdraw <amount|all>* to take them back`)
    lines.push(`_Your wallet: *${have.toLocaleString()} solars*. Banked coin is safe from robbery and PvP._`)
    return ctx.reply(lines.join('\n'))
  }

  if (action === 'deposit') {
    const have = me?.wallet?.solars ?? 0
    if (!raw) {
      return ctx.reply(`🏦 How much? *${p}empire bank deposit <amount>* or *${p}empire bank deposit all*. Your wallet: *${have.toLocaleString()} solars*.`)
    }
    const amount = raw === 'all' ? have : Math.floor(Number(raw))
    if (!Number.isInteger(amount) || amount <= 0) {
      return ctx.reply(`❌ How many solars? e.g. *${p}empire bank deposit 5000* or *${p}empire bank deposit all*.`)
    }
    if (amount > have) {
      return ctx.reply(`💸 You only have *${have.toLocaleString()} solars* in your wallet.`)
    }
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[record.id]
      if (!rec) { outcome = { reason: 'missing' }; return player }
      const wallet = player.wallet ?? (player.wallet = {})
      const bal = wallet.solars ?? 0
      if (bal < amount) { outcome = { reason: 'poor', have: bal }; return player }
      wallet.solars = bal - amount
      const res = bankDeposit(rec, ctx.from, amount, now)
      rec.lastActiveAt = now
      outcome = { reason: 'ok', moved: amount, wallet: wallet.solars, balance: res.balance, tax: res.taxTaken }
      return player
    })
    if (outcome?.reason === 'missing') return ctx.reply(`❌ The bank record could not be found.`)
    if (outcome?.reason === 'poor') return ctx.reply(`💸 You only have *${outcome.have.toLocaleString()} solars* in your wallet.`)
    const taxNote = outcome.tax > 0 ? `\n_Maintenance tax settled first: -${outcome.tax.toLocaleString()} solars._` : ''
    return ctx.reply(
      `🏦 *Banked ${outcome.moved.toLocaleString()} solars in ${record.name}.*\n` +
      `Your balance: *${outcome.balance.toLocaleString()}*  ·  wallet: *${outcome.wallet.toLocaleString()}*.${taxNote}\n` +
      `📌 *Next:* draw it back any time with *${p}empire bank withdraw <amount>*.`
    )
  }

  if (action === 'withdraw') {
    if (!raw) {
      const acct = previewBankAccount(record, ctx.from, now)
      return ctx.reply(`🏦 How much? *${p}empire bank withdraw <amount>* or *${p}empire bank withdraw all*. Banked: *${acct.net.toLocaleString()} solars* after tax.`)
    }
    let want
    if (raw === 'all') want = Infinity
    else {
      want = Math.floor(Number(raw))
      if (!Number.isInteger(want) || want <= 0) {
        return ctx.reply(`❌ How many solars? e.g. *${p}empire bank withdraw 5000* or *${p}empire bank withdraw all*.`)
      }
    }
    let outcome = null
    await updatePlayer(ctx.db, ctx.from, player => {
      ensureEmpirePlayer(player)
      const rec = ctx.db.data.empires?.[record.id]
      if (!rec) { outcome = { reason: 'missing' }; return player }
      const res = bankWithdraw(rec, ctx.from, want, now)
      if (!res.ok) { outcome = { reason: res.reason, tax: res.taxTaken }; return player }
      const wallet = player.wallet ?? (player.wallet = {})
      wallet.solars = (wallet.solars ?? 0) + res.paid
      rec.lastActiveAt = now
      outcome = { reason: 'ok', moved: res.paid, wallet: wallet.solars, balance: res.balance, tax: res.taxTaken }
      return player
    })
    if (outcome?.reason === 'missing') return ctx.reply(`❌ The bank record could not be found.`)
    if (outcome?.reason === 'noaccount' || outcome?.reason === 'empty') {
      return ctx.reply(`🏦 You have nothing banked in ${record.name}. Store some with *${p}empire bank deposit <amount>*.`)
    }
    if (outcome?.reason === 'short') return ctx.reply(`❌ How many solars? e.g. *${p}empire bank withdraw 5000* or *${p}empire bank withdraw all*.`)
    const taxNote = outcome.tax > 0 ? `\n_Maintenance tax settled first: -${outcome.tax.toLocaleString()} solars._` : ''
    return ctx.reply(
      `🏦 *Withdrew ${outcome.moved.toLocaleString()} solars from ${record.name}.*\n` +
      `Your balance: *${outcome.balance.toLocaleString()}*  ·  wallet: *${outcome.wallet.toLocaleString()}*.${taxNote}\n` +
      `📌 *Next:* store solars again with *${p}empire bank deposit <amount>*.`
    )
  }

  return ctx.reply(
    `❓ Unknown bank command. Try *${p}empire bank*, *${p}empire bank deposit <amount>*, or *${p}empire bank withdraw <amount>*.`
  )
}

// ── Stash (where NPC-gathered materials and crafted items collect) ───────────

/**
 * Read-only view of the empire stash: the raw materials your workers gather and
 * the finished items your blacksmith forges collect here, each item tagged with
 * the character who made it. Exported so plugins/stash.js can offer a bare
 * .stash alias that lands on the very same screen. Self-contained (it runs the
 * group gate and reads the db itself) so that standalone entry point works;
 * calling it from the empire dispatch just repeats those idempotent steps.
 * Mutates nothing and never broadcasts.
 */
export async function stashView(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      return ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const stash = owned.stash ?? {}
  const mats = stash.materials ?? {}
  const items = Array.isArray(stash.items) ? stash.items : []
  const matEntries = Object.entries(mats).filter(([, q]) => q > 0)

  const lines = [`📦 *STASH · ${owned.name}*`, RULE]
  if (!matEntries.length && !items.length) {
    lines.push(`Your stash is empty for now.`)
    lines.push(`_Raw materials your workers gather and gear your blacksmith forges will collect here._`)
    lines.push('')
    lines.push(`📌 *Next:* put a character to work with *${p}empire assign worker <char> <building>*,`)
    lines.push(`or drop loot straight in with *${p}stash drop <item>*.`)
    return ctx.reply(lines.join('\n'))
  }
  if (matEntries.length) {
    lines.push(`*Raw materials*`)
    for (const [id, q] of matEntries) lines.push(`• ${mname(id)} ⌁ *${q.toLocaleString()}*`)
  }
  if (items.length) {
    if (matEntries.length) lines.push('')
    lines.push(`*Crafted items*`)
    for (const it of items) {
      const by  = it.madeBy ? ` _(forged by ${it.madeBy})_` : ''
      const qty = (it.qty ?? 1) > 1 ? ` ×${it.qty}` : ''
      lines.push(`• ${it.name ?? it.id}${qty}${by}`)
    }
  }
  lines.push(RULE)
  lines.push(`> *${p}stash drop <item>* store loot  ·  *${p}stash take <item>* claim it`)
  lines.push(`> *${p}empire forge <item>* forge gear  ·  *${p}tp <player>* share the stash`)
  return ctx.reply(lines.join('\n'))
}

// ── Who lives here (online / roster) ─────────────────────────────────────────

/**
 * Roster of everyone living under the empire's banner: the sworn PLAYERS (owner
 * and citizens) named one by one, and the NPC townsfolk as a headcount, since
 * they are the auto-immigrating residents that housing makes room for. Together
 * they are the population, which IS the empire's fame. Exported so
 * plugins/em-online.js can hang a bare .em-online alias on the very same screen,
 * exactly like plugins/stash.js does for the stash. Self-contained (it runs the
 * group gate and reads the db itself) so the standalone entry point works;
 * calling it from the empire dispatch just repeats those idempotent steps.
 * Mutates nothing and never broadcasts.
 */
export async function onlineView(ctx, allUsers = null) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      return ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  const users = allUsers ?? Object.values(ctx.db.data.users ?? {})
  const record = getOwnedEmpire(ctx.db, ctx.from)
    ?? (ctx.player?.empireId ? ctx.db.data.empires?.[ctx.player.empireId] : null)
  if (!record) {
    return ctx.reply(
      `🏘️ You don't belong to an empire yet.\n` +
      `Found one with *${p}empire found <name>* or join one with *${p}empire join <name>*.`
    )
  }

  const members = getEmpireMembers(record.id, users)
  const owner = members.find(u => u.empireRole === 'owner')
  const citizens = members.filter(u => u.empireRole === 'citizen')
    .sort((a, b) => (a.empireJoinedAt ?? 0) - (b.empireJoinedAt ?? 0))
  const pop = populationOf(record)
  const cap = popCap(record)
  const npcs = Math.max(0, Math.floor(record.npcs ?? 0))

  const lines = [`🏘️ *WHO LIVES IN ${record.name}*`, RULE]
  lines.push(`👥 *People:* ${pop.toLocaleString()}/${cap.toLocaleString()}`)
  lines.push(`   ${record.citizenCount.toLocaleString()} sworn  ·  ${npcs.toLocaleString()} townsfolk`)
  lines.push('')
  lines.push(`👑 *${owner?.name ?? 'Unknown ruler'}* _(ruler)_`)
  for (const u of citizens) {
    const posts = playerAssignmentCount(record, u.id)
    lines.push(`• ${u.name ?? 'Someone'}${posts ? `  ·  ${posts} posted` : ''}`)
  }
  if (!citizens.length) lines.push(`_No sworn citizens yet. Seats open: ${citizenCap(record)}._`)
  lines.push('')
  if (npcs > 0) {
    lines.push(`🧑‍🌾 *${npcs.toLocaleString()} townsfolk* live and work here.`)
    lines.push(`_They pay taxes and draw wages every *${p}empire collect*._`)
    // Named residents are the ones you can actually walk up to. Listed by trade
    // here so this view answers "who is here" for people as well as headcount.
    const named = previewFolk(record, Date.now())
    if (named.length) {
      lines.push('')
      for (const f of named.slice(0, 10)) {
        lines.push(`${f.tradeDef?.emoji ?? '👤'} *${f.name}* the ${f.tradeDef?.name ?? 'townsfolk'}${f.ready ? ' ✨' : ''}`)
      }
      lines.push(`_Meet them properly with *${p}folk*._`)
    }
  } else {
    lines.push(`🧑‍🌾 *No townsfolk yet.* Build homes so folk can move in.`)
  }
  if (popRoom(record) <= 0 && cap > 0) lines.push(`\n🏠 _Full. Build more homes to make room for more._`)
  return ctx.reply(lines.join('\n'))
}

// ── Stash economy: forge, drop, take, guests ────────────────────────────────

/**
 * Runs the group feature gate and loads the empire tables, exactly like
 * stashView/onlineView do inline. Returns true if the caller may proceed, or
 * replies with the disabled notice and returns false. Lets the exported stash
 * handlers below be self-contained so plugins/stash.js and plugins/tp.js can
 * call them directly, while the empire dispatch just repeats idempotent steps.
 */
async function gateAndLoad(ctx) {
  const p = config.prefix
  if (ctx.isGroup) {
    const settings = await getGroupSettings(ctx.sender)
    if (!settings.empireEnabled) {
      await ctx.reply(
        `🚫 The Empire system is disabled in this group.\n` +
        `_A group admin can enable it with *${p}empire on*._`
      )
      return false
    }
  }
  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)
  return true
}

/**
 * Which stash a player acts on, and in what capacity:
 *  - owner   → their own empire (the ruler runs the stash outright)
 *  - citizen → the empire they are sworn to
 *  - invited → a stash a ruler shared with them via .tp; prefer the empire they
 *              are currently visiting, else the first that lists them
 * Returns { record, role } with role null when they belong to none.
 */
function resolveStashEmpire(ctx) {
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (owned) return { record: owned, role: 'owner' }
  const me = ctx.db.data.users?.[ctx.from] ?? ctx.player
  if (me?.empireId && me.empireRole === 'citizen') {
    const rec = ctx.db.data.empires?.[me.empireId]
    if (rec) return { record: rec, role: 'citizen' }
  }
  const empires = ctx.db.data.empires ?? {}
  const visiting = me?.visitingEmpire
  if (visiting && empires[visiting]?.stash?.invited?.includes(ctx.from)) {
    return { record: empires[visiting], role: 'invited' }
  }
  for (const rec of Object.values(empires)) {
    if (Array.isArray(rec.stash?.invited) && rec.stash.invited.includes(ctx.from)) {
      return { record: rec, role: 'invited' }
    }
  }
  return { record: null, role: null }
}

/** Resolve a query against what a stash actually holds (material map + item pile). */
function resolveInStash(record, query) {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const mats = record.stash?.materials ?? {}
  const items = Array.isArray(record.stash?.items) ? record.stash.items : []
  if ((mats[q] ?? 0) > 0) return { kind: 'material', id: q }
  if (items.some(it => it.id === q && (it.qty ?? 0) > 0)) return { kind: 'item', id: q }
  for (const id of Object.keys(mats)) {
    if ((mats[id] ?? 0) > 0 && mname(id).toLowerCase().includes(q)) return { kind: 'material', id }
  }
  const it = items.find(e => (e.qty ?? 0) > 0 && (e.name ?? e.id).toLowerCase().includes(q))
  if (it) return { kind: 'item', id: it.id }
  return null
}

/** Total of one id in a stash: the material tally, or the summed item-stack qty. */
function stashCount(record, kind, id) {
  if (kind === 'material') return Math.max(0, Math.floor(record.stash?.materials?.[id] ?? 0))
  return (record.stash?.items ?? [])
    .filter(it => it.id === id)
    .reduce((s, it) => s + Math.max(0, Math.floor(it.qty ?? 0)), 0)
}

/** Rank number (1..7) back to a rarity word, for star-bar display of forge limits. */
function rankToRarity(r) {
  const ladder = [null, 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'boundless']
  return ladder[Math.max(1, Math.min(7, Math.floor(Number(r) || 1)))] ?? 'common'
}

/**
 * The forge browser (.empire forge with no item): what the resident smith can
 * attempt at the current blacksmith level, grouped by kind, each marked ready
 * (stash has the materials and the treasury the fee) or short (what is missing).
 */
function renderForgeList(record) {
  const p = config.prefix
  const level = blacksmithLevel(record)
  const maxR = maxForgeRank(level)
  const smith = record.blacksmith?.smithName
  const lines = [
    `🔨 *FORGE · ${record.name}*`,
    RULE,
    `Smith: *${smith ?? 'not hired yet'}*  ·  forge level *${level}*`,
    `Works up to ${rarityStars(rankToRarity(maxR))} *${rankToRarity(maxR)}* gear.`,
    `_Materials come from the stash, the fee from the treasury._`,
    '',
  ]
  const groups = [['weapon', '⚔️ Weapons'], ['armor', '🛡️ Armor'], ['named', '🌟 Named gear']]
  let shown = 0
  for (const [cat, title] of groups) {
    const inCat = recipes.filter(r => {
      const it = itemMap[r.output]
      return it && r.category === cat && rarityRank(it.rarity) <= maxR
    })
    if (!inCat.length) continue
    lines.push(`*${title}*`)
    for (const r of inCat) {
      const it = itemMap[r.output]
      const chk = forgeCheck(record, r, rarityRank(it.rarity))
      let note = ''
      if (!chk.ok) {
        if (chk.missing.length) note = ` _(need ${chk.missing.map(m => `${m.need - m.have} ${mname(m.itemId)}`).join(', ')})_`
        else if (chk.shortSolars > 0) note = ` _(need ${chk.shortSolars.toLocaleString()} ☀️)_`
      }
      lines.push(`${chk.ok ? '✅' : '❌'} ${rarityStars(it.rarity)} *${it.name}*${note}`)
      shown++
    }
    lines.push('')
  }
  if (!shown) lines.push(`_This forge is too basic to make anything yet. Upgrade it with *${p}empire upgrade blacksmith*._`)
  lines.push(RULE)
  lines.push(`> *${p}empire forge <item>* to forge  ·  *${p}stash* to check your stores`)
  return lines.join('\n')
}

/**
 * .empire forge <item> — the ruler directs the resident smith to forge gear
 * from the stash. Materials are drawn from stash.materials, the fee from the
 * treasury, and the finished piece lands on the stash tagged with the smith who
 * made it (see applyForge). Owner-only: the forge is the ruler's to command.
 */
export async function forgeCmd(ctx) {
  const p = config.prefix
  if (!(await gateAndLoad(ctx))) return
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(noEmpire(p))

  const level = blacksmithLevel(owned)
  if (level <= 0) {
    return ctx.reply(
      `🔨 *${owned.name} has no blacksmith yet.*\n` +
      `Build one with *${p}empire build blacksmith*, then it can forge gear from your stash.`
    )
  }

  const query = ctx.args.slice(1).join(' ').trim()
  if (!query) return ctx.reply(renderForgeList(owned))

  const recipe = findRecipe(query)
  if (!recipe) {
    return ctx.reply(
      `❌ Your smith knows no recipe for *"${query}"*.\n` +
      `See what they can make with *${p}empire forge*.`
    )
  }
  const item = itemMap[recipe.output]
  if (!item) return ctx.reply(`❌ Recipe data error: output *${recipe.output}* has no item.`)
  const outputRank = rarityRank(item.rarity)

  const check = forgeCheck(owned, recipe, outputRank)
  if (!check.ok) {
    if (check.reason === 'rank') {
      return ctx.reply(
        `🔨 *Your forge cannot make ${item.name} yet.*\n` +
        `That is ${rarityStars(item.rarity)} *${item.rarity}* work; a level *${level}* forge tops out at ${rarityStars(rankToRarity(check.maxRank))} *${rankToRarity(check.maxRank)}*.\n` +
        `Raise it with *${p}empire upgrade blacksmith*.`
      )
    }
    const lines = [`🔨 *Cannot forge ${item.name} yet.* ${owned.name} is missing:`]
    for (const m of check.missing) lines.push(`  • *${mname(m.itemId)}* ×${m.need - m.have} _(stash has ${m.have})_`)
    if (check.shortSolars > 0) lines.push(`  • *${check.shortSolars.toLocaleString()} more ☀️* in the treasury`)
    lines.push(`_Gather materials into the stash (*${p}stash drop*) and fund the treasury (*${p}empire deposit*)._`)
    return ctx.reply(lines.join('\n'))
  }

  // Mint the resident smith's name once, on the first successful forge.
  const mintedName = (typeof owned.blacksmith?.smithName === 'string' && owned.blacksmith.smithName.trim())
    ? owned.blacksmith.smithName.trim()
    : soldierName()

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const fresh = forgeCheck(rec, recipe, outputRank)
    if (!fresh.ok) { outcome = { reason: 'race' }; return player }
    if (!rec.blacksmith || typeof rec.blacksmith !== 'object') rec.blacksmith = {}
    if (!(typeof rec.blacksmith.smithName === 'string' && rec.blacksmith.smithName.trim())) {
      rec.blacksmith.smithName = mintedName
    }
    const smith = rec.blacksmith.smithName
    const entry = applyForge(rec, recipe, { id: item.id, name: item.name }, smith, now)
    rec.lastActiveAt = now
    outcome = { reason: 'ok', smith, qty: entry.qty }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'race') return ctx.reply(`❌ The stash changed before the forge finished. Try again.`)
  return ctx.reply(
    `🔨 *${outcome.smith} forged ${rarityStars(item.rarity)} ${item.name}!*\n` +
    `It rests in *${owned.name}'s* stash${outcome.qty > 1 ? ` _(now ×${outcome.qty})_` : ''}.\n` +
    `📌 *Next:* claim it with *${p}stash take ${item.id}*, or forge more.`
  )
}

/**
 * .stash drop <item> [amount] — move loot or crafting materials from your bag
 * into the shared stash. Materials land in stash.materials (the smith forges
 * from them); gear lands on stash.items as an untagged stack (no maker). Owner,
 * citizens and invited guests may all contribute.
 */
export async function dropCmd(ctx) {
  const p = config.prefix
  if (!(await gateAndLoad(ctx))) return
  const { record } = resolveStashEmpire(ctx)
  if (!record) {
    return ctx.reply(`📦 You have no stash to drop into. Found an empire, join one, or get invited with *${p}tp*.`)
  }
  const me = ctx.db.data.users?.[ctx.from] ?? ctx.player

  const rest = ctx.args.slice(1)
  let qty = 1
  let nameTokens = rest
  if (rest.length >= 2 && /^\d+$/.test(rest[rest.length - 1])) {
    qty = Math.max(1, parseInt(rest[rest.length - 1], 10))
    nameTokens = rest.slice(0, -1)
  }
  const query = nameTokens.join(' ').trim()
  if (!query) {
    return ctx.reply(
      `📦 *Drop into ${record.name}'s stash.*\n${RULE}\n` +
      `> *${p}stash drop <item> [amount]*\n` +
      `_Puts loot or crafting materials from your bag into the shared stash. Raw mats feed the blacksmith._`
    )
  }
  const id = resolveAnyId(query)
  if (!id) return ctx.reply(`❌ Nothing called *"${query}"* exists.`)
  const have = countInv(me?.inventory, id)
  if (have <= 0) return ctx.reply(`❌ You have no *${iname(id)}* in your bag to drop.`)
  if (qty > have) qty = have

  let outcome = null
  const now = Date.now()
  const material = isMaterialId(id)
  await updatePlayer(ctx.db, ctx.from, player => {
    const rec = ctx.db.data.empires?.[record.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const inv = player.inventory ?? (player.inventory = [])
    const has = inv.filter(x => x === id).length
    const move = Math.min(qty, has)
    if (move <= 0) { outcome = { reason: 'gone' }; return player }
    let remaining = move
    for (let i = inv.length - 1; i >= 0 && remaining > 0; i--) {
      if (inv[i] === id) { inv.splice(i, 1); remaining-- }
    }
    if (!rec.stash || typeof rec.stash !== 'object') rec.stash = {}
    if (material) {
      if (!rec.stash.materials || typeof rec.stash.materials !== 'object') rec.stash.materials = {}
      rec.stash.materials[id] = (rec.stash.materials[id] ?? 0) + move
    } else {
      if (!Array.isArray(rec.stash.items)) rec.stash.items = []
      let entry = rec.stash.items.find(it => it && it.id === id && (it.madeBy ?? null) === null)
      if (entry) entry.qty = Math.max(1, Math.floor(entry.qty ?? 0)) + move
      else rec.stash.items.push({ id, name: iname(id), qty: move, madeBy: null })
    }
    rec.lastActiveAt = now
    outcome = { reason: 'ok', moved: move }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ That stash could not be found.`)
  if (outcome?.reason === 'gone') return ctx.reply(`❌ You no longer have a *${iname(id)}* to drop.`)
  return ctx.reply(
    `📦 *Dropped ${outcome.moved > 1 ? `${outcome.moved}× ` : ''}${iname(id)}* into *${record.name}'s* stash.\n` +
    (material
      ? `_The blacksmith can forge with it. See *${p}empire forge*._`
      : `_Anyone with access can claim it with *${p}stash take*._`)
  )
}

/**
 * .stash take <item> [amount] — move materials or forged gear from the stash
 * into your bag. Taking deposits the item's bare id (a normal equippable), so a
 * forged piece loses its stash-side maker tag on the way out; the forge log
 * keeps the record of who made it. The ruler and invited guests may take;
 * citizens may only drop, so nobody can quietly drain the shared store.
 */
export async function takeCmd(ctx) {
  const p = config.prefix
  if (!(await gateAndLoad(ctx))) return
  const { record, role } = resolveStashEmpire(ctx)
  if (!record) {
    return ctx.reply(`📦 You have no stash to take from. Found an empire, join one, or get invited with *${p}tp*.`)
  }
  if (role === 'citizen') {
    return ctx.reply(`🔒 Only the ruler and invited guests can take from *${record.name}'s* stash. As a citizen you can still *${p}stash drop* into it.`)
  }
  const me = ctx.db.data.users?.[ctx.from] ?? ctx.player

  const rest = ctx.args.slice(1)
  let qty = 1
  let nameTokens = rest
  if (rest.length >= 2 && /^\d+$/.test(rest[rest.length - 1])) {
    qty = Math.max(1, parseInt(rest[rest.length - 1], 10))
    nameTokens = rest.slice(0, -1)
  }
  const query = nameTokens.join(' ').trim()
  if (!query) {
    return ctx.reply(
      `📦 *Take from ${record.name}'s stash.*\n${RULE}\n` +
      `> *${p}stash take <item> [amount]*\n` +
      `_Moves materials or forged gear into your bag. See what is stored with *${p}stash*._`
    )
  }
  const found = resolveInStash(record, query)
  if (!found) return ctx.reply(`❌ *${record.name}'s* stash has nothing called *"${query}"*.`)
  const id = found.id
  const avail = stashCount(record, found.kind, id)
  if (avail <= 0) return ctx.reply(`❌ The stash has no *${iname(id)}* right now.`)
  if (qty > avail) qty = avail
  if (!hasInventoryRoom(me, 1)) return ctx.reply(inventoryFullMessage(me))
  while (qty > 1 && !hasInventoryRoom(me, qty)) qty--

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    const rec = ctx.db.data.empires?.[record.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    const live = stashCount(rec, found.kind, id)
    let move = Math.min(qty, live)
    if (move <= 0) { outcome = { reason: 'gone' }; return player }
    const inv = player.inventory ?? (player.inventory = [])
    while (move > 1 && !hasInventoryRoom(player, move)) move--
    if (!hasInventoryRoom(player, move)) { outcome = { reason: 'full' }; return player }
    if (found.kind === 'material') {
      const left = Math.max(0, Math.floor(rec.stash.materials[id] ?? 0) - move)
      if (left > 0) rec.stash.materials[id] = left
      else delete rec.stash.materials[id]
    } else {
      let need = move
      for (let i = 0; i < rec.stash.items.length && need > 0; i++) {
        const e = rec.stash.items[i]
        if (e.id !== id) continue
        const take = Math.min(need, Math.max(0, Math.floor(e.qty ?? 0)))
        e.qty = Math.max(0, Math.floor(e.qty ?? 0)) - take
        need -= take
      }
      rec.stash.items = rec.stash.items.filter(e => (e.qty ?? 0) > 0)
    }
    for (let i = 0; i < move; i++) inv.push(id)
    rec.lastActiveAt = now
    outcome = { reason: 'ok', moved: move }
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ That stash could not be found.`)
  if (outcome?.reason === 'gone') return ctx.reply(`❌ The stash ran out of *${iname(id)}* before you took any.`)
  if (outcome?.reason === 'full') return ctx.reply(inventoryFullMessage(me))
  return ctx.reply(
    `📦 *Took ${outcome.moved > 1 ? `${outcome.moved}× ` : ''}${iname(id)}* from *${record.name}'s* stash.\n` +
    (isMaterialId(id) ? `_Crafting material added to your bag._` : `_Equip it with *${p}equip ${id}*._`)
  )
}

/**
 * .tp <player> / .tp remove <player> (and .empire tp|invite|uninvite) — the
 * ruler grants or revokes a guest's access to the stash, like sharing a chest.
 * Owner-only. A guest may drop into and take from the stash; the invite list
 * lives on record.stash.invited. Never broadcasts.
 */
export async function inviteCmd(ctx, targetRaw, mode = 'add') {
  const p = config.prefix
  if (!(await gateAndLoad(ctx))) return
  const owned = getOwnedEmpire(ctx.db, ctx.from)
  if (!owned) return ctx.reply(`🔒 Only a ruler can share a stash. Found an empire with *${p}empire found <name>* first.`)

  const targetJid = resolveTargetJid(ctx, targetRaw)
  if (!targetJid) {
    const guests = Array.isArray(owned.stash?.invited) ? owned.stash.invited : []
    const names = guests
      .map(j => ctx.db.data.users?.[j]?.name)
      .filter(Boolean)
    const roster = names.length ? `\n_Current guests: ${names.join(', ')}._` : ''
    return ctx.reply(
      `📦 *Share ${owned.name}'s stash.*\n${RULE}\n` +
      `> *${p}tp <player>* invite someone (reply, @mention, or their number)\n` +
      `> *${p}tp remove <player>* revoke access\n` +
      `_Guests may drop into and take from your stash, like a shared chest._${roster}`
    )
  }
  if (targetJid === ctx.from) return ctx.reply(`❌ You already have full run of your own stash.`)
  if (!playerExists(ctx.db, targetJid)) return ctx.reply(`❌ That player isn't registered yet.`)
  const targetName = ctx.db.data.users?.[targetJid]?.name ?? 'that player'

  let outcome = null
  const now = Date.now()
  await updatePlayer(ctx.db, ctx.from, player => {
    const rec = ctx.db.data.empires?.[owned.id]
    if (!rec) { outcome = { reason: 'missing' }; return player }
    if (!rec.stash || typeof rec.stash !== 'object') rec.stash = {}
    if (!Array.isArray(rec.stash.invited)) rec.stash.invited = []
    const set = new Set(rec.stash.invited)
    if (mode === 'remove') {
      if (!set.has(targetJid)) { outcome = { reason: 'not_invited' }; return player }
      set.delete(targetJid)
      outcome = { reason: 'removed' }
    } else {
      if (set.has(targetJid)) { outcome = { reason: 'already' }; return player }
      set.add(targetJid)
      outcome = { reason: 'added' }
    }
    rec.stash.invited = [...set]
    rec.lastActiveAt = now
    return player
  })

  if (outcome?.reason === 'missing') return ctx.reply(`❌ Your empire record could not be found.`)
  if (outcome?.reason === 'already') return ctx.reply(`✅ *${targetName}* already has access to ${owned.name}'s stash.`)
  if (outcome?.reason === 'not_invited') return ctx.reply(`ℹ️ *${targetName}* did not have access to begin with.`)
  if (outcome?.reason === 'removed') return ctx.reply(`🔒 Revoked *${targetName}'s* access to *${owned.name}'s* stash.`)
  return ctx.reply(
    `📦 *${targetName} may now use ${owned.name}'s stash.*\n` +
    `They can *${p}stash drop* into it and *${p}stash take* from it.\n` +
    `Revoke any time with *${p}tp remove <player>*.`
  )
}

// ── Presets (owner tool: hand a ready-made empire to a player) ───────────────
/**
 * When a player's empire is lost (a rollback, a bad restore, a dissolution
 * that should not have fired), rebuilding it by hand is 25 buildings and an
 * army of typed commands. These presets are the pre-made answer: eight full
 * realms from 1,050 to 10,000 residents, each with its own specialisation,
 * building spread, ranked officer corps and treasury, sitting in
 * data/empire.json under `presets`.
 *
 * Owner-only, and handled BEFORE the group feature gate so a restoration can
 * be done from any chat, including a DM.
 */
function presetLine(preset) {
  const view = presetPreview(preset)
  return (
    `${preset.emoji} *${preset.name}* _(${preset.id})_\n` +
    `   ${preset.specialisation} · 👥 ${preset.citizens.toLocaleString()} · ${view.tier.name}\n` +
    `   🏗️ ${view.buildingCount} · ⚔️ ${view.armyHeadcount.toLocaleString()} (${preset.soilerLabel}) · ` +
    `☀️ ${shortSolars(preset.treasury)} · 📈 +${view.netSolarsPerHour.toLocaleString()}/h`
  )
}

function renderPresetList() {
  const p = config.prefix
  const lines = [
    `🗂️ *READY-MADE EMPIRES* _(owner only)_\n${RULE}`,
    `Hand one of these to a player who lost their realm. Smallest first.\n`,
  ]
  for (const preset of PRESET_ORDER) lines.push(presetLine(preset), '')
  lines.push(
    `${RULE}\n` +
    `> *${p}empire preset <id>* to inspect one\n` +
    `> *${p}empire preset suggest @player* to fit one to a player\n` +
    `> *${p}empire preset assign @player <id> [new name]*`
  )
  return lines.join('\n')
}

function renderPresetDetail(preset) {
  const p = config.prefix
  const view = presetPreview(preset)

  // Buildings read best grouped by kind with their levels listed, the way the
  // dashboard shows them, rather than as 25 separate lines.
  const byType = new Map()
  for (const b of preset.buildings) {
    if (!byType.has(b.type)) byType.set(b.type, [])
    byType.get(b.type).push(b.level)
  }
  const buildLines = [...byType.entries()].map(([type, levels]) => {
    const def = buildingDefMap[type]
    const sorted = [...levels].sort((a, b) => b - a)
    return `   ${def?.emoji ?? '▫️'} *${def?.name ?? type}* ${sorted.map(l => `Lv${l}`).join(', ')}`
  })

  const officers = preset.army.officers ?? []
  const byRank = new Map()
  for (const o of officers) byRank.set(o.rank, (byRank.get(o.rank) ?? 0) + 1)
  const officerLine = [...byRank.entries()]
    .sort((a, b) => RANK_ORDER.indexOf(b[0]) - RANK_ORDER.indexOf(a[0]))
    .map(([rank, n]) => `${n}x ${rankMap[rank]?.name ?? rank}`)
    .join(', ')

  const stock = MATERIAL_IDS
    .filter(id => (preset.warehouse?.[id] ?? 0) > 0)
    .map(id => `${preset.warehouse[id].toLocaleString()} ${mname(id).toLowerCase()}`)
    .join(', ')

  const audit = auditPreset(preset)

  return (
    `${preset.emoji} *${preset.name.toUpperCase()}*\n${RULE}\n` +
    `_${preset.tagline}_\n\n` +
    `🏷️ Focus: *${preset.specialisation}*\n` +
    `👥 Residents: *${preset.citizens.toLocaleString()}* · 🏛️ Tier: *${view.tier.name}*\n` +
    `🏘️ Housing for: *${view.popCap.toLocaleString()}*${view.population > view.popCap ? ` _(arrives full, no new folk until they build)_` : ''}\n` +
    `☀️ Treasury: *${preset.treasury.toLocaleString()}*\n` +
    `📦 Warehouse: *${view.warehouseUsed.toLocaleString()}/${view.warehouseCap.toLocaleString()}*\n` +
    `💪 Might: *${view.score.toLocaleString()}*\n\n` +
    `*Buildings* _(${view.buildingCount}/${view.buildingCap})_\n${buildLines.join('\n')}\n\n` +
    `*Army* _(${view.armyHeadcount.toLocaleString()}/${view.armyCap.toLocaleString()}, power ${view.armyPower.toLocaleString()})_\n` +
    `   ${(preset.army.levies?.recruit ?? 0).toLocaleString()} recruits, ${(preset.army.levies?.soldier ?? 0).toLocaleString()} soldiers\n` +
    `   ${officerLine || 'no officers'}\n` +
    `   Top rank: *${rankMap[preset.soilerRank]?.name ?? preset.soilerRank}* _(${preset.soilerLabel})_\n\n` +
    `*Economy per hour*\n` +
    `   Income *${view.grossSolarsPerHour.toLocaleString()}* · upkeep *${view.maintPerHour.toLocaleString()}* · ` +
    `wages *${view.wagePerHour.toLocaleString()}*\n` +
    `   Net *${view.netSolarsPerHour > 0 ? '+' : ''}${view.netSolarsPerHour.toLocaleString()}*\n\n` +
    (stock ? `*Stock*\n   ${stock}\n\n` : '') +
    (preset.notes ? `_${preset.notes}_\n\n` : '') +
    (audit.ok ? '' : `⚠️ *Audit:* ${audit.problems.join('; ')}\n\n`) +
    `${RULE}\n> *${p}empire preset assign @player ${preset.id} [new name]*`
  )
}

/** Resolve the player an owner is pointing at: reply, @mention, bare number, or a pasted raw id. */
function resolvePresetTarget(ctx, raw) {
  if (raw && raw.includes('@') && ctx.db.data.users?.[raw]) return raw
  return resolveTargetJid(ctx, raw)
}

async function presetCmd(ctx) {
  const p = config.prefix
  if (!ctx.from || !isOwnerJid(ctx.from)) {
    return ctx.reply(`❌ This command is restricted to the bot owner.`)
  }
  if (!PRESET_ORDER.length) {
    return ctx.reply(`❌ No presets are configured. Check the *presets* block in data/empire.json.`)
  }

  await ctx.db.read()
  await ensureEmpiresInitialized(ctx.db)

  const action = ctx.args[1]?.toLowerCase()
  if (!action) return ctx.reply(renderPresetList())

  // ── suggest ──
  if (action === 'suggest' || action === 'fit') {
    const targetId = resolvePresetTarget(ctx, ctx.args[2])
    if (!targetId) {
      return ctx.reply(`❌ Point at a player: reply to them, @mention them, or paste their id.`)
    }
    const target = ctx.db.data.users?.[targetId]
    if (!target) return ctx.reply(`❌ *${targetId}* is not a registered player.`)
    const preset = suggestPreset(target)
    const view = presetPreview(preset)
    return ctx.reply(
      `🎯 *Suggested for ${target.name ?? targetId}*\n${RULE}\n` +
      `Level *${target.level ?? 1}*, purse ` +
      `*${((target.wallet?.solars ?? 0) + (target.bank?.balance ?? 0) + (target.vault?.solars ?? 0)).toLocaleString()}*\n\n` +
      `${preset.emoji} *${preset.name}* _(${preset.id})_\n` +
      `${preset.specialisation} · 👥 ${preset.citizens.toLocaleString()} · ${view.tier.name} · +${view.netSolarsPerHour.toLocaleString()}/h\n\n` +
      `> *${p}empire preset ${preset.id}* to inspect it\n` +
      `> *${p}empire preset assign @player ${preset.id}*`
    )
  }

  // ── assign ──
  if (action === 'assign' || action === 'give' || action === 'grant') {
    const rest = ctx.args.slice(2)
    // A mention arrives as its own token, so pull the target token out first and
    // read the preset id and the optional custom name from what is left.
    const targetToken = rest.find(t => t.includes('@') || /^\+?\d[\d\s-]*$/.test(t))
    const words = rest.filter(t => t !== targetToken)
    const targetId = resolvePresetTarget(ctx, targetToken)
    if (!targetId) {
      return ctx.reply(
        `❌ *Usage:* *${p}empire preset assign @player <id> [new name]*\n` +
        `Reply to the player, @mention them, or paste their raw id.`
      )
    }
    if (!words.length) {
      return ctx.reply(`❌ Name a preset: *${PRESET_ORDER.map(x => x.id).join('*, *')}*`)
    }
    const preset = findPreset(words[0])
    if (!preset) return ctx.reply(`❌ No preset matches "_${words[0]}_". See *${p}empire preset*.`)

    const audit = auditPreset(preset)
    if (!audit.ok) {
      return ctx.reply(`❌ *${preset.name}* fails its own audit and will not be handed out:\n${audit.problems.map(x => `• ${x}`).join('\n')}`)
    }

    const rawName = words.slice(1).join(' ').trim() || preset.name
    const check = validateName(rawName)
    if (!check.ok) return ctx.reply(`❌ ${check.reason}`)
    const cleanName = check.name
    let slug = check.slug
    const now = Date.now()

    if (!playerExists(ctx.db, targetId)) {
      return ctx.reply(`❌ *${targetId}* is not a registered player.`)
    }
    if (empireNameTaken(ctx.db, cleanName)) {
      return ctx.reply(
        `❌ The name *${cleanName}* is already taken.\n` +
        `Pass a different one: *${p}empire preset assign @player ${preset.id} <new name>*`
      )
    }

    let outcome = null
    await updatePlayer(ctx.db, targetId, player => {
      ensureEmpirePlayer(player)
      if (!ctx.db.data.empires) ctx.db.data.empires = {}
      if (getOwnedEmpire(ctx.db, targetId)) { outcome = { reason: 'have' }; return player }
      if (player.empireId) { outcome = { reason: 'citizen', id: player.empireId }; return player }
      if (empireNameTaken(ctx.db, cleanName)) { outcome = { reason: 'taken' }; return player }
      // The slug is the record key, so it has to be free even when the display
      // name is: two names can normalize onto one slug, and a renamed empire
      // keeps its original slug as an id that no longer matches its name.
      slug = freeEmpireId(ctx.db, check.slug)

      const record = buildPresetRecord(preset, { id: slug, name: cleanName, ownerId: targetId, now })
      ctx.db.data.empires[slug] = record
      player.empireId = slug
      player.empireRole = 'owner'
      player.empireJoinedAt = now
      outcome = { reason: 'ok', record, name: player.name ?? targetId }
      return player
    })

    if (outcome?.reason === 'have') return ctx.reply(`🏰 That player already rules an empire. It has to be sold or dissolved first.`)
    if (outcome?.reason === 'citizen') return ctx.reply(`🚫 That player is sworn to *${outcome.id}*. They must leave it first (*${p}empire leave*).`)
    if (outcome?.reason === 'taken') return ctx.reply(`❌ The name *${cleanName}* was just taken. Pick another.`)
    if (outcome?.reason !== 'ok') return ctx.reply(`❌ Nothing was assigned. That player may not be registered.`)

    const rec = outcome.record
    const upkeep = computeUpkeep(rec)
    // No fan-out: this reply lands in the chat the owner typed it in, and the
    // player gets a notification they read on their own terms.
    await pushNotification(ctx.db, targetId, {
      kind: 'empire',
      title: `🏰 ${rec.name} has been raised in your name`,
      body:
        `${rec.npcs.toLocaleString()} residents, ${rec.buildings.length} buildings and an army of ` +
        `${armyHeadcount(rec).toLocaleString()}. See it with ${p}empire.`,
    }).catch(() => {})

    return ctx.reply(
      `✅ *${rec.name}* assigned to *${outcome.name}*\n${RULE}\n` +
      `Preset: ${preset.emoji} *${preset.name}* _(${preset.id})_\n` +
      `🆔 Record: *${slug}*\n` +
      `👥 Residents: *${rec.npcs.toLocaleString()}* · 🏛️ *${tierOf(rec).name}*\n` +
      `🏗️ Buildings: *${rec.buildings.length}* · ⚔️ Army: *${armyHeadcount(rec).toLocaleString()}* ` +
      `(power ${armyPower(rec).toLocaleString()})\n` +
      `☀️ Treasury: *${rec.treasury.toLocaleString()}* · 📈 Net *+${upkeep.netSolarsPerHour.toLocaleString()}/h*\n\n` +
      `_Every clock is stamped to now, so there is no backdated payout waiting._\n` +
      `They have been notified.`
    )
  }

  // ── detail ──
  const preset = findPreset(ctx.args.slice(1).join(' '))
  if (!preset) {
    return ctx.reply(
      `❌ No preset matches "_${ctx.args.slice(1).join(' ')}_".\n` +
      `Known: *${PRESET_ORDER.map(x => x.id).join('*, *')}*`
    )
  }
  return ctx.reply(renderPresetDetail(preset))
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default {
  name:           'empire',
  aliases:        ['empires', 'em'],
  category:       'empire',
  requiresPlayer: true,
  description:    'Found and run your own empire: build, produce, and grow',
  subcommands: [
    { cmd: 'found <name>', desc: `raise a new empire for ${EMPIRE_CONFIG.foundCost.toLocaleString()} solars` },
    { cmd: 'info [name]', desc: 'view your empire, or look up another' },
    { cmd: 'build [type] [region]', desc: 'list buildings, or raise one (optionally in a named region)' },
    { cmd: 'map [name]', desc: 'see your (or another empire\'s) territory laid out by region' },
    { cmd: 'upgrade <type>', desc: 'level up a building' },
    { cmd: 'shop [buy <mat> <qty>]', desc: 'buy construction materials' },
    { cmd: 'collect', desc: 'claim off-battle production and pay upkeep' },
    { cmd: 'upkeep', desc: 'see your income, upkeep and net margin' },
    { cmd: 'deposit <amount>', desc: 'move solars from your wallet into the treasury' },
    { cmd: 'withdraw <amount>', desc: 'take treasury solars back to your wallet' },
    { cmd: 'bank [deposit|withdraw <amount>]', desc: 'store your own solars in the realm bank (small daily tax)' },
    { cmd: 'stash', desc: 'see materials your workers gathered and gear forged' },
    { cmd: 'forge [item]', desc: 'have your blacksmith forge gear from the stash' },
    { cmd: 'drop <item> [n]', desc: 'put loot or materials from your bag into the stash' },
    { cmd: 'take <item> [n]', desc: 'claim materials or gear from the stash to your bag' },
    { cmd: 'tp <player>', desc: 'invite a player to share your stash (or tp remove)' },
    { cmd: 'online', desc: 'see who lives here: sworn players and townsfolk' },
    { cmd: 'join <name>', desc: 'become a citizen of another empire' },
    { cmd: 'leave', desc: 'give up your citizenship' },
    { cmd: 'citizens [name]', desc: 'see who lives in an empire' },
    { cmd: 'assign worker <char> <building>', desc: 'post a character to raise output' },
    { cmd: 'assign general <char>', desc: 'post a character to lead the army' },
    { cmd: 'unassign <char>', desc: 'recall a posted character' },
    { cmd: 'market [set|clear]', desc: 'see a storefront, or stock your own' },
    { cmd: 'buy [mat] [qty]', desc: 'buy from the market you are standing in' },
    { cmd: 'visit <name>', desc: 'travel to another empire to shop' },
    { cmd: 'sell <price>', desc: 'list your empire for sale, or sell cancel' },
    { cmd: 'buyout <name>', desc: 'buy an empire that is listed for sale' },
    { cmd: 'on', desc: 'group admin: enable empires here' },
    { cmd: 'off', desc: 'group admin: disable empires here' },
    { cmd: 'preset [id|assign|suggest]', desc: 'owner only: hand a ready-made empire to a player' },
  ],

  async run(ctx) {
    const p = config.prefix
    const sub = ctx.args[0]?.toLowerCase()

    // on/off must work even when the feature is disabled — that's how you
    // turn it on. Handle the toggle before the group feature gate.
    if (sub === 'on' || sub === 'off') return toggle(ctx, sub)

    // Presets are an owner restoration tool, not gameplay: they skip the group
    // gate too, so a lost empire can be handed back from a DM.
    if (sub === 'preset' || sub === 'presets') return presetCmd(ctx)

    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.empireEnabled) {
        return ctx.reply(
          `🚫 The Empire system is disabled in this group.\n` +
          `_A group admin can enable it with *${p}empire on*._`
        )
      }
    }

    await ctx.db.read()
    await ensureEmpiresInitialized(ctx.db)
    // Age dormant/abandoned empires on read, outside any mutator. The pre-check
    // keeps this free on the common path where nothing has gone stale. The
    // caller's own empire is spared so a returning ruler never dissolves it by
    // their very first command.
    const nowSweep = Date.now()
    if (empireNeedsSweep(ctx.db, nowSweep, ctx.from)) await sweepEmpireLifecycle(ctx.db, nowSweep, ctx.from)
    const allUsers = Object.values(ctx.db.data.users ?? {})

    if (!sub)               return infoView(ctx, allUsers)
    if (sub === 'found')    return foundEmpire(ctx)
    if (sub === 'rename')   return renameEmpire(ctx)
    if (sub === 'info')     return infoView(ctx, allUsers)
    if (sub === 'build')    return buildCmd(ctx)
    if (sub === 'map')      return mapCmd(ctx)
    if (sub === 'upgrade')  return upgradeBuilding(ctx)
    if (sub === 'shop')     return shopCmd(ctx)
    if (sub === 'collect')  return collectEmpire(ctx)
    if (sub === 'upkeep')   return upkeepView(ctx)
    if (sub === 'deposit')  return depositCmd(ctx)
    if (sub === 'withdraw') return withdrawCmd(ctx)
    if (sub === 'bank')     return bankCmd(ctx)
    if (sub === 'stash')    return stashView(ctx)
    if (sub === 'forge')    return forgeCmd(ctx)
    if (sub === 'drop')     return dropCmd(ctx)
    if (sub === 'take')     return takeCmd(ctx)
    if (sub === 'tp' || sub === 'invite') {
      return (ctx.args[1]?.toLowerCase() === 'remove')
        ? inviteCmd(ctx, ctx.args[2], 'remove')
        : inviteCmd(ctx, ctx.args[1], 'add')
    }
    if (sub === 'uninvite')  return inviteCmd(ctx, ctx.args[1], 'remove')
    if (sub === 'online')   return onlineView(ctx, allUsers)
    if (sub === 'join')     return joinEmpire(ctx, allUsers)
    if (sub === 'leave')    return leaveEmpire(ctx)
    if (sub === 'citizens') return citizensView(ctx, allUsers)
    if (sub === 'assign')   return assignCmd(ctx)
    if (sub === 'unassign') return unassignCmd(ctx)
    if (sub === 'market')   return marketCmd(ctx)
    if (sub === 'buy')      return buyCmd(ctx)
    if (sub === 'visit')    return visitEmpire(ctx)
    if (sub === 'sell')     return sellCmd(ctx)
    if (sub === 'buyout')   return buyoutCmd(ctx)

    return ctx.reply(
      `❓ Unknown empire command.\n` +
      `Try: *${p}empire*, *${p}empire found <name>*, *${p}empire rename <name>*, *${p}empire build*, *${p}empire map*, *${p}empire collect*, ` +
      `*${p}empire join <name>*, *${p}empire assign*, *${p}empire market*.`
    )
  },
}
