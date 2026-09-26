/**
 * cheat.js — player-installable "cheat mods", Minecraft-mod-flavored but
 * fully server-authoritative.
 *
 * NOTE: named `.cheat` (not `.mod`) because `.mod` is already taken by
 * the existing bot-moderator-role plugin — see plugins/mod.js. Do not
 * rename this back to `.mod` without renaming/removing that one first.
 *
 * HOW THIS IS SAFE:
 * A player writes a small JSON file (optionally with their own AI's help)
 * following a fixed format: mod_name / mod_by / effect_id / flavor_code.
 * They upload it as a document and reply `.cheat install`. The bot reads
 * the file and checks `effect_id` against data/cheat-base.json — a fixed
 * table WE wrote. If (and only if) it matches exactly, the player gets
 * that predefined effect. `flavor_code` is stored and shown in the store
 * for flavor, but it is NEVER executed or interpreted — see
 * lib/mods.js's header comment for the full invariant. Nothing in this
 * file ever calls eval/Function/vm on player-supplied content.
 *
 * Commands:
 *   .cheat                          — status: owned/active mods
 *   .cheat list                     — browse every valid cheat effect_id
 *   .cheat install                  — (reply to a .json document) install it
 *   .cheat activate <name>          — activate an owned mod (max 5 active)
 *   .cheat deactivate <name>        — deactivate an active mod
 *   .cheat sell <name> <price>      — list an owned mod in the store
 *   .cheat unsell <name>            — remove your own store listing
 *   .cheat store [page]             — browse all mods currently for sale
 *   .cheat buy <listing id>         — buy a copy of a listed mod
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import {
  ensureMods,
  parseModFile,
  addOwnedMod,
  activateMod,
  deactivateMod,
  findOwnedByName,
  listCheatDefs,
  getCheatDef,
  MAX_ACTIVE_MODS,
  DISCONNECTED_EFFECTS,
} from '../lib/mods.js'

const MIN_LISTING_PRICE = 100

// ── Document download ───────────────────────────────────────────────────

/**
 * Pulls the quoted document (if any) off ctx.msg and downloads it as a
 * Buffer. Returns null if the command wasn't a reply to a document, or
 * { wrongType: true } if the reply's document isn't JSON-typed by
 * mimetype/filename — the content itself is still fully validated
 * afterward by parseModFile regardless.
 */
async function downloadQuotedJson(ctx) {
  const quoted =
    ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
  const docMsg = quoted?.documentMessage
  if (!docMsg) return null

  const looksJson =
    (docMsg.mimetype && docMsg.mimetype.includes('json')) ||
    (docMsg.fileName && docMsg.fileName.toLowerCase().endsWith('.json'))
  if (!looksJson) return { wrongType: true }

  const { downloadContentFromMessage } = await import('@whiskeysockets/baileys')
  const stream = await downloadContentFromMessage(docMsg, 'document')
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return { buffer: Buffer.concat(chunks) }
}

// ── Views ────────────────────────────────────────────────────────────────

function statusView(ctx) {
  const p = config.prefix
  const mods = ensureMods(ctx.player)

  if (!mods.owned.length) {
    return (
      `🧩 *YOUR CHEATS*\n\n` +
      `_You don't own any yet._\n\n` +
      `Write a mod JSON file (*${p}cheat list* shows valid effects), upload it ` +
      `as a document, and reply *${p}cheat install*.`
    )
  }

  const lines = mods.owned.map(m => {
    const cheat = getCheatDef(m.effectId)
    const active = mods.active.includes(m.instanceId)
    return (
      `${active ? '🟢' : '⚪'} *${m.modName}* _by ${m.modBy}_\n` +
      `   ↳ ${cheat?.label ?? m.effectId} ${active ? '(active)' : '(inactive)'}`
    )
  })

  return (
    `🧩 *YOUR CHEATS*  _(${mods.active.length}/${MAX_ACTIVE_MODS} active)_\n\n` +
    lines.join('\n\n') +
    `\n\n*${p}cheat activate <name>* — turn one on\n` +
    `*${p}cheat deactivate <name>* — turn one off\n` +
    `*${p}cheat sell <name> <price>* — list it in the store`
  )
}

function listView() {
  const p = config.prefix
  const grouped = {}
  for (const c of listCheatDefs()) {
    grouped[c.category] = grouped[c.category] ?? []
    grouped[c.category].push(c)
  }

  const sections = Object.entries(grouped).map(([cat, cheats]) => {
    const lines = cheats.map(
      c => `• \`${c.effect_id}\` — *${c.label}*\n   _${c.description}_ (☀️${c.storePrice.toLocaleString()})`,
    )
    return `*${cat.toUpperCase()}*\n${lines.join('\n')}`
  })

  return (
    `📜 *VALID CHEAT EFFECTS*\n\n` +
    sections.join('\n\n') +
    `\n\n_Your mod file's "effect_id" must match one of these exactly._\n` +
    `*${p}cheat install* — after uploading a document + replying to it`
  )
}

function storeView(allListings, page = 1) {
  const p = config.prefix
  const PER_PAGE = 8
  if (!allListings.length) {
    return `🏪 *CHEAT STORE*\n\n_No mods are currently listed for sale._\n\nList one with *${p}cheat sell <name> <price>*.`
  }
  const totalPages = Math.ceil(allListings.length / PER_PAGE)
  const pageItems = allListings.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  const lines = pageItems.map(l => {
    const cheat = getCheatDef(l.effectId)
    return (
      `🆔 \`${l.instanceId.slice(0, 8)}\`\n` +
      `*${l.modName}* _by ${l.modBy}_ — ${cheat?.label ?? l.effectId}\n` +
      `☀️ *${l.price.toLocaleString()}* — seller: ${l.sellerName}`
    )
  })

  return (
    `🏪 *CHEAT STORE*  _(page ${page}/${totalPages})_\n\n` +
    lines.join('\n\n') +
    `\n\n*${p}cheat buy <id>* — buy using the 🆔 shown above` +
    (totalPages > 1 ? `\n*${p}cheat store <page>* — see more` : '')
  )
}

// ── Handlers ─────────────────────────────────────────────────────────────

async function handleInstall(ctx) {
  const p = config.prefix
  const doc = await downloadQuotedJson(ctx)

  if (!doc) {
    return ctx.reply(
      `❌ *Reply to your mod's .json file with* *${p}cheat install*.\n` +
      `_Upload the file as a document first, then reply to that message._`,
    )
  }
  if (doc.wrongType) {
    return ctx.reply(`❌ That document doesn't look like a .json file. Upload a *.json* mod file and try again.`)
  }

  const parsed = parseModFile(doc.buffer)
  if (!parsed.ok) {
    return ctx.reply(`❌ *Couldn't install that mod:*\n${parsed.error}`)
  }

  let instance
  await updatePlayer(ctx.db, ctx.from, player => {
    instance = addOwnedMod(player, parsed.mod, 'created')
    return player
  })

  return ctx.reply(
    `🧩 *Mod added to your collection!*\n\n` +
    `*${instance.modName}* _by ${instance.modBy}_\n` +
    `Effect: *${parsed.mod.cheatLabel}*\n\n` +
    `_Not active yet — it doesn't do anything until you turn it on._\n` +
    `*${p}cheat activate ${instance.modName}* — activate (max ${MAX_ACTIVE_MODS} at once)\n` +
    `*${p}cheat sell ${instance.modName} <price>* — list it in the store`,
  )
}

async function handleActivate(ctx, name) {
  const p = config.prefix
  if (!name) return ctx.reply(`❌ *Usage:* *${p}cheat activate <mod name>*`)

  const found = findOwnedByName(ctx.player, name)
  if (!found) return ctx.reply(`❌ You don't own a mod named "_${name}_". Check *${p}cheat* for your list.`)

  let result
  await updatePlayer(ctx.db, ctx.from, player => {
    result = activateMod(player, found.instanceId)
    return player
  })

  if (!result.ok) {
    if (result.error === 'already_active') return ctx.reply(`❌ *${found.modName}* is already active.`)
    if (result.error === 'slots_full') {
      return ctx.reply(
        `❌ *All ${MAX_ACTIVE_MODS} mod slots are full.*\n` +
        `Deactivate one first with *${p}cheat deactivate <name>*.`,
      )
    }
    return ctx.reply(`❌ Couldn't activate that mod.`)
  }

  const cheat = getCheatDef(found.effectId)
  return ctx.reply(`✅ *${found.modName}* activated!\n_${cheat?.label} is now in effect._`)
}

async function handleDeactivate(ctx, name) {
  const p = config.prefix
  if (!name) return ctx.reply(`❌ *Usage:* *${p}cheat deactivate <mod name>*`)

  const found = findOwnedByName(ctx.player, name)
  if (!found) return ctx.reply(`❌ You don't own a mod named "_${name}_".`)

  let result
  await updatePlayer(ctx.db, ctx.from, player => {
    result = deactivateMod(player, found.instanceId)
    return player
  })

  if (!result.ok) return ctx.reply(`❌ *${found.modName}* isn't currently active.`)
  return ctx.reply(`✅ *${found.modName}* deactivated.`)
}

async function handleSell(ctx, args) {
  const p = config.prefix
  const priceArg = args[args.length - 1]
  const price = parseInt(priceArg, 10)
  const nameArgs = /^\d+$/.test(priceArg) ? args.slice(0, -1) : args
  const name = nameArgs.join(' ')

  if (!name || !Number.isFinite(price) || price < MIN_LISTING_PRICE) {
    return ctx.reply(
      `❌ *Usage:* *${p}cheat sell <mod name> <price>*\n` +
      `_Minimum price: ☀️${MIN_LISTING_PRICE.toLocaleString()}._`,
    )
  }

  const found = findOwnedByName(ctx.player, name)
  if (!found) return ctx.reply(`❌ You don't own a mod named "_${name}_".`)

  let outcome
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureMods(player)
    if (player.modListings.some(l => l.instanceId === found.instanceId)) {
      outcome = { reason: 'already_listed' }
      return player
    }
    player.modListings.push({
      instanceId: found.instanceId,
      price,
      listedAt: Date.now(),
      sellerId: player.id,
      sellerName: player.name,
      modName: found.modName,
      modBy: found.modBy,
      effectId: found.effectId,
    })
    outcome = { reason: 'ok' }
    return player
  })

  if (outcome.reason === 'already_listed') return ctx.reply(`❌ *${found.modName}* is already listed in the store.`)
  return ctx.reply(`🏪 *${found.modName}* listed for *☀️${price.toLocaleString()}*.\n_Buyers get their own copy — you keep yours._`)
}

async function handleUnsell(ctx, name) {
  const p = config.prefix
  if (!name) return ctx.reply(`❌ *Usage:* *${p}cheat unsell <mod name>*`)

  let removed = false
  await updatePlayer(ctx.db, ctx.from, player => {
    ensureMods(player)
    const before = player.modListings.length
    player.modListings = player.modListings.filter(
      l => l.modName.toLowerCase() !== name.toLowerCase(),
    )
    removed = player.modListings.length < before
    return player
  })

  return ctx.reply(removed ? `✅ Listing removed.` : `❌ No listing found for "_${name}_".`)
}

/** Collects every player's modListings into one flat array for the store view. */
function collectAllListings(db) {
  const all = []
  for (const player of Object.values(db.data.users ?? {})) {
    for (const listing of player.modListings ?? []) {
      all.push(listing)
    }
  }
  return all.sort((a, b) => b.listedAt - a.listedAt)
}

async function handleStore(ctx, args) {
  const page = Math.max(1, parseInt(args[0], 10) || 1)
  const listings = collectAllListings(ctx.db)
  return ctx.reply(storeView(listings, page))
}

async function handleBuy(ctx, shortId) {
  const p = config.prefix
  if (!shortId) return ctx.reply(`❌ *Usage:* *${p}cheat buy <id>* — see IDs via *${p}cheat store*.`)

  const listings = collectAllListings(ctx.db)
  const listing = listings.find(l => l.instanceId.startsWith(shortId))
  if (!listing) return ctx.reply(`❌ No listing found with that id. Check *${p}cheat store*.`)

  if (listing.sellerId === ctx.from) {
    return ctx.reply(`❌ You can't buy your own listing.`)
  }

  // Buyer side: deduct currency, add owned mod copy.
  let buyOutcome
  await updatePlayer(ctx.db, ctx.from, player => {
    const wallet = player.wallet ?? (player.wallet = {})
    const solars = wallet.solars ?? 0
    if (solars < listing.price) {
      buyOutcome = { reason: 'poor', have: solars }
      return player
    }
    wallet.solars = solars - listing.price
    addOwnedMod(
      player,
      {
        modName: listing.modName,
        modBy: listing.modBy,
        effectId: listing.effectId,
        flavorCode: '',
        cheatLabel: getCheatDef(listing.effectId)?.label ?? listing.effectId,
      },
      'purchased',
    )
    buyOutcome = { reason: 'ok' }
    return player
  })

  if (buyOutcome.reason === 'poor') {
    return ctx.reply(
      `❌ *Not enough Solars.*\n` +
      `Costs ☀️*${listing.price.toLocaleString()}*, you have ☀️*${buyOutcome.have.toLocaleString()}*.`,
    )
  }

  // Seller side: credit currency. Separate updatePlayer call since it's a
  // different player record — both go through the same serialized write
  // queue in player-repo.js, so there's no race between the two.
  await updatePlayer(ctx.db, listing.sellerId, seller => {
    const wallet = seller.wallet ?? (seller.wallet = {})
    wallet.solars = (wallet.solars ?? 0) + listing.price
    return seller
  }).catch(() => {}) // seller record should always exist, but never let this block the buyer's success reply

  return ctx.reply(
    `🧩 *Purchased!*\n\n` +
    `*${listing.modName}* _by ${listing.modBy}_ — ${getCheatDef(listing.effectId)?.label}\n` +
    `Paid: ☀️*${listing.price.toLocaleString()}*\n\n` +
    `_Added to your collection, inactive. Use_ *${p}cheat activate ${listing.modName}* _to turn it on._`,
  )
}

// ── Plugin export ─────────────────────────────────────────────────────

export default {
  name:           'cheat',
  aliases:        ['cheats'],
  category:       'inventory',
  requiresPlayer: true,
  description:    `${config.prefix}cheat — install, activate, and trade cheat mods. ${config.prefix}cheat list for valid effects.`,

  async run(ctx) {
    const sub = ctx.args[0]?.toLowerCase()
    const rest = ctx.args.slice(1)

    if (sub === 'list')       return ctx.reply(listView())
    if (sub === 'install')    return handleInstall(ctx)
    if (sub === 'activate')   return handleActivate(ctx, rest.join(' '))
    if (sub === 'deactivate') return handleDeactivate(ctx, rest.join(' '))
    if (sub === 'sell')       return handleSell(ctx, rest)
    if (sub === 'unsell')     return handleUnsell(ctx, rest.join(' '))
    if (sub === 'store')      return handleStore(ctx, rest)
    if (sub === 'buy')        return handleBuy(ctx, rest[0])

    return ctx.reply(statusView(ctx))
  },
}
