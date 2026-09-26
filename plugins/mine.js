/**
 * mine — Gather crafting materials from the ore veins.
 * Stamina-gated (costs 3 stamina per attempt).
 * Weighted random drop across the ore ladder; better ores
 * unlock and become more common as player level increases.
 * Returns 1-3 units per attempt.
 *
 * Bonus find: mining a lot in one day (100+ mines) sharply raises the
 * odds of a rare bonus ore on top of the normal drop — see
 * DAILY_BONUS_THRESHOLD / rollBonusOre below.
 *
 * Usage: <prefix>mine
 *   <prefix>mine on|off — group admins: enable/disable mining in this group
 *
 * 5-second per-player cooldown between attempts (MINE_COOLDOWN_MS), on top
 * of the stamina cost, to stop back-to-back spam.
 */
import { config } from '../config.js'
import { sendImage } from '../lib/image.js'
import { updatePlayer } from '../lib/player-repo.js'
import { refreshStamina } from '../lib/combat-engine.js'
import { hasInventoryRoom, inventoryFullMessage } from '../lib/inventory-limits.js'
import { locationsMap, allItems, beasts } from '../lib/game-data.js'
import { wearToolOnUse, breakMessage } from '../lib/durability.js'
import { getGroupSettings, saveGroupSettings, saveFailedMessage, isGroupOrBotOwner } from '../lib/group-settings.js'
import { NOT_GROUP, NOT_ALLOWED } from '../lib/group-helpers.js'
import { BEAST_MAX_OWNED } from '../lib/beast-engine.js'

const itemMap = Object.fromEntries(allItems.map((i) => [i.id, i]))

const STAMINA_COST = 3

// Per-player anti-spam cooldown between .mine attempts — stamina already
// caps total mines per day, but without this a player can fire .mine
// commands back-to-back as fast as WhatsApp will deliver them. Mirrors
// rob.js's lastRobAt/ROB_COOLDOWN_MS pattern, just much shorter.
const MINE_COOLDOWN_MS = 5000

// Ore pool — each entry unlocks at minLevel and has a base weight.
// Higher-level players accumulate more unlocked slots, so rarer ores
// become proportionally more likely even though their weights are lower.
const ORE_POOL = [
  { id: 'iron_ore',      name: 'Iron Ore',      minLevel: 1,  weight: 40 },
  { id: 'wood_plank',    name: 'Wood Plank',     minLevel: 1,  weight: 35 },
  { id: 'leather_scrap', name: 'Leather Scrap',  minLevel: 1,  weight: 30 },
  { id: 'silver_ore',    name: 'Silver Ore',     minLevel: 5,  weight: 25 },
  { id: 'mythril_ore',   name: 'Mythril Ore',    minLevel: 20, weight: 18 },
  { id: 'diamond_ore',   name: 'Diamond Ore',    minLevel: 40, weight: 12 },
  { id: 'titanium_ore',  name: 'Titanium Ore',   minLevel: 65, weight: 7  },
  { id: 'celestial_ore', name: 'Celestial Ore',  minLevel: 85, weight: 4  },
]

// Bonus pool for the "mined a lot today" streak — skews toward the rare
// end (mythril/diamond/titanium/celestial), still level-gated so a
// level 3 grinding 100 mines can't suddenly pull celestial ore.
const BONUS_ORE_POOL = [
  { id: 'mythril_ore',   name: 'Mythril Ore',    minLevel: 20, weight: 40 },
  { id: 'diamond_ore',   name: 'Diamond Ore',    minLevel: 40, weight: 30 },
  { id: 'titanium_ore',  name: 'Titanium Ore',   minLevel: 65, weight: 20 },
  { id: 'celestial_ore', name: 'Celestial Ore',  minLevel: 85, weight: 10 },
]

const RARITY_EMOJI = {
  iron_ore: '🪨', wood_plank: '🪵', leather_scrap: '🟤',
  silver_ore: '⚪', mythril_ore: '🔵', diamond_ore: '💎',
  titanium_ore: '🟣', celestial_ore: '🌟',
}

// After this many mines in the same day, every mine gets a rising chance
// (capped) at an extra bonus ore drop on top of the normal one.
const DAILY_BONUS_THRESHOLD = 100
const BONUS_CHANCE_BASE     = 0.15  // chance right at the threshold
const BONUS_CHANCE_PER_50   = 0.05  // chance climbs further every 50 mines past it
const BONUS_CHANCE_CAP      = 0.60

// Summon Beasts are a rare mining find, not bought or gacha-rolled.
// Roughly 1-in-600 to 1-in-1000 mines, per attempt (independent of the
// ore/bonus-ore rolls above). Always awarded at its lowest CP so it's
// found as a baby and trained up like everything else.
const BEAST_FIND_CHANCE = 1 / 800

function todayKey() {
  return new Date().toDateString()
}

function pickFrom(pool, level) {
  const available = pool.filter(o => level >= o.minLevel)
  if (!available.length) return null
  const total = available.reduce((s, o) => s + o.weight, 0)
  let roll    = Math.random() * total
  for (const ore of available) {
    roll -= ore.weight
    if (roll <= 0) return ore
  }
  return available[available.length - 1]
}

function bonusChanceFor(minesToday) {
  if (minesToday < DAILY_BONUS_THRESHOLD) return 0
  const extra = Math.floor((minesToday - DAILY_BONUS_THRESHOLD) / 50) * BONUS_CHANCE_PER_50
  return Math.min(BONUS_CHANCE_CAP, BONUS_CHANCE_BASE + extra)
}

export default {
  name:           'mine',
  aliases:        ['gather', 'prospect'],
  category:       'town',
  requiresPlayer: true,
  description:    `${config.prefix}mine — gather crafting materials (costs ${STAMINA_COST} stamina)`,

  async run(ctx) {
    const { player, args } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── ON / OFF (group admins only) ────────────────────────────────────────
    if (sub === 'on' || sub === 'off') {
      if (!ctx.isGroup) return ctx.reply(NOT_GROUP)
      if (!(await isGroupOrBotOwner(ctx))) return ctx.reply(NOT_ALLOWED)
      // Report from the value that actually landed on disk, not from `sub` —
      // a save that failed used to reply nothing at all (dispatch() swallows
      // the throw), which reads as "the bot ignored me".
      const res = await saveGroupSettings(ctx.sender, (s) => { s.miningEnabled = (sub === 'on') })
      if (!res.ok) return ctx.reply(saveFailedMessage('mining', res.error))
      return ctx.reply(`⛏️ Mining is now *${res.settings.miningEnabled ? 'ON' : 'OFF'}* in this group.`)
    }

    // ── Group gate ───────────────────────────────────────────────────────────
    if (ctx.isGroup) {
      const settings = await getGroupSettings(ctx.sender)
      if (!settings.miningEnabled) {
        return ctx.reply(
          `🚫 Mining is disabled in this group.\n` +
          `_A group admin can turn it back on with *${pr}mine on*._`,
        )
      }
    }

    if (player.inBattle) {
      return ctx.reply(`⚔️ You can't mine during a battle!`)
    }

    // Anti-spam cooldown — checked here for a fast fail, and again inside
    // the race-guard below since lastMineAt can change between reads.
    const cdRemaining = MINE_COOLDOWN_MS - (Date.now() - (player.lastMineAt ?? 0))
    if (cdRemaining > 0) {
      return ctx.reply(`⏳ Catch your breath — mine again in *${Math.ceil(cdRemaining / 1000)}s*.`)
    }

    // Mining requires an equipped pickaxe.
    const toolId = player.equipped?.tool
    const tool   = toolId ? itemMap[toolId] : null
    if (!tool) {
      return ctx.reply(
        `⛏️ You need a pickaxe equipped to mine!\n` +
        `Buy one with *${pr}shop tools* and equip it with *${pr}equip <pickaxe>*.`,
      )
    }

    // Mining is only allowed inside dungeon locations.
    const loc = locationsMap[player.location]
    if (!loc || loc.type !== 'dungeon') {
      return ctx.reply(
        `⛏️ You can only mine inside a dungeon.\n` +
        `Use *${pr}travel <dungeon>* or *${pr}enter <dungeon>* to head into one first.`,
      )
    }

    // Check stamina before entering race-guard
    const st = refreshStamina(player.stamina)
    if (st.current < STAMINA_COST) {
      const resetDate = new Date(st.resetAt)
      const hh = resetDate.getHours().toString().padStart(2,'0')
      const mm = resetDate.getMinutes().toString().padStart(2,'0')
      return ctx.reply(
        `⚡ Not enough stamina to mine! (need ${STAMINA_COST}, have ${st.current})\n` +
        `Stamina resets at *${hh}:${mm}*.`,
      )
    }

    // Inventory-full check — normal drop always needs at least 1 slot.
    if (!hasInventoryRoom(player, 1)) {
      return ctx.reply(inventoryFullMessage(player))
    }

    let raceAborted   = false
    let inventoryFull = false
    let noTool        = false
    let onCooldown    = false
    let cooldownMs    = 0
    let qty = 0, ore = null, bonusOre = null, minesToday = 0
    let toolWear = null
    let foundBeast = null

    await updatePlayer(ctx.db, ctx.from, (p) => {
      // Re-validate pickaxe against fresh state before mutating.
      if (!p.equipped?.tool) { noTool = true; return }

      const cdLeft = MINE_COOLDOWN_MS - (Date.now() - (p.lastMineAt ?? 0))
      if (cdLeft > 0) { onCooldown = true; cooldownMs = cdLeft; return }

      const freshSt = refreshStamina(p.stamina)
      if (freshSt.current < STAMINA_COST) { raceAborted = true; return }
      if (!hasInventoryRoom(p, 1))        { inventoryFull = true; return }

      p.lastMineAt = Date.now()
      freshSt.current -= STAMINA_COST
      p.stamina = freshSt

      // Daily mine counter — resets on a new day
      if (p.miningStats?.date !== todayKey()) {
        p.miningStats = { date: todayKey(), count: 0 }
      }
      p.miningStats.count += 1
      minesToday = p.miningStats.count

      qty = 1 + Math.floor(Math.random() * 3)  // 1-3
      ore = pickFrom(ORE_POOL, p.level)
      const drops = Array(qty).fill(ore.id)

      // Bonus roll — only if there's still room for one more slot
      const chance = bonusChanceFor(minesToday)
      if (chance > 0 && Math.random() < chance && hasInventoryRoom(p, qty + 1)) {
        bonusOre = pickFrom(BONUS_ORE_POOL, p.level)
        if (bonusOre) drops.push(bonusOre.id)
      }

      p.inventory = [...(p.inventory ?? []), ...drops]

      // Rare beast find — independent roll, gated the same way summons
      // used to be (level-eligible pool, 4-owned cap), just found instead
      // of bought. Always granted at its lowest CP (a "baby").
      if ((p.summonedBeasts ?? []).length < BEAST_MAX_OWNED && Math.random() < BEAST_FIND_CHANCE) {
        const eligible = beasts.filter((b) => (b.levelReq ?? 1) <= p.level)
        const pool = eligible.length ? eligible : beasts
        const beast = pool[Math.floor(Math.random() * pool.length)]
        foundBeast = beast
        p.beastInventory = [...(p.beastInventory ?? []), { beastId: beast.id, obtainedAt: Date.now() }]
        p.summonedBeasts = [
          ...(p.summonedBeasts ?? []),
          { beastId: beast.id, cp: beast.startingCp, obtainedAt: Date.now() },
        ]
        if (!p.activeBeast) p.activeBeast = beast.id
      }

      // Wear the pickaxe down by one use.
      toolWear = wearToolOnUse(p)
    })

    if (noTool)         return ctx.reply(`⛏️ You need a pickaxe equipped to mine!`)
    if (onCooldown)     return ctx.reply(`⏳ Catch your breath — mine again in *${Math.ceil(cooldownMs / 1000)}s*.`)
    if (raceAborted)    return ctx.reply(`⚡ Not enough stamina. Need *${STAMINA_COST}*, stamina changed.`)
    if (inventoryFull)  return ctx.reply(inventoryFullMessage(player))

    const freshSt   = refreshStamina(player.stamina)
    const remaining = Math.max(0, freshSt.current - STAMINA_COST)
    const emoji     = RARITY_EMOJI[ore.id] ?? '⛏️'

    let msg = `⛏️ *Mining complete!*\n\n  ${emoji} *${ore.name}* ×${qty}\n`

    if (bonusOre) {
      const bEmoji = RARITY_EMOJI[bonusOre.id] ?? '✨'
      msg += `\n🎉 *YOU FOUND A RARE ${bonusOre.name.toUpperCase()}!* ${bEmoji}\n` +
             `_Your relentless mining today paid off._\n`
    }

    if (foundBeast) {
      msg += `\n🐲 *SOMETHING STIRS IN THE RUBBLE...*\n` +
             `${foundBeast.emoji} A wild *${foundBeast.name}* was hiding in the vein!\n` +
             `_${foundBeast.description}_\n` +
             `It's young — Starting CP: *${foundBeast.startingCp}*. Fight with it and it'll grow.\n` +
             (player.activeBeast ? `See it: *${pr}summon*` : `✅ Auto-equipped as your active beast!`) +
             `\n`
    }

    msg += `\n⚡ Stamina: ${remaining}/${freshSt.max}  _(costs ${STAMINA_COST} per mine)_\n` +
           `⛏️ Mines today: *${minesToday}*` +
           (minesToday >= DAILY_BONUS_THRESHOLD ? ` _(bonus-find odds active!)_` : ` _(${DAILY_BONUS_THRESHOLD - minesToday} more for bonus-find odds)_`) +
           breakMessage(toolWear) +
           `\n_Use *${pr}craft* or *${pr}table* to see what you can forge._`

    return sendImage(ctx, `item_${tool.id}.jpg`,
      `*${tool.name}*\n${emoji} Struck ${ore.name} ×${qty}${bonusOre ? ' · rare bonus find!' : ''}\n\n${msg}`)
  },
}
