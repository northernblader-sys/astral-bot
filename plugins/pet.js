/**
 * pet.js — The Astral Town Pet Store.
 * Adopt companions with Solars/Gems, then equip one at a time. An equipped
 * pet's statBonuses fold directly into player.stats/maxHp/maxMp via the same
 * applyEquipmentBonus() mechanism gear uses — so pet buffs apply everywhere
 * player stats matter, including dungeon combat.
 *
 * Usage:
 *   <prefix>pet                — show your collection + active pet
 *   <prefix>pet shop           — browse pets available to adopt
 *   <prefix>pet adopt <pet>    — buy a pet from the store
 *   <prefix>pet equip <pet>    — set your active pet (swaps out any current one)
 *   <prefix>pet unequip        — unequip your active pet
 */
import { config } from '../config.js'
import { pets, petMap } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { applyEquipmentBonus } from '../lib/combat-engine.js'
import { rarityStars } from '../lib/rarity.js'
import {
  getBondLevel, getBondProgress, scaledStatBonuses,
  feedCost, feedCooldownRemaining, applyFeed, MAX_BOND_LEVEL,
  checkEvolution,
} from '../lib/pet-bond.js'

function findPet(query) {
  const q = query.toLowerCase().trim()
  if (petMap[q]) return petMap[q]
  return pets.find((p) => p.name.toLowerCase().includes(q)) ?? null
}

function formatBonuses(b) {
  const parts = []
  if (b.str)   parts.push(`STR+${b.str}`)
  if (b.agi)   parts.push(`AGI+${b.agi}`)
  if (b.int)   parts.push(`INT+${b.int}`)
  if (b.def)   parts.push(`DEF+${b.def}`)
  if (b.lck)   parts.push(`LCK+${b.lck}`)
  if (b.maxHp) parts.push(`HP+${b.maxHp}`)
  if (b.maxMp) parts.push(`MP+${b.maxMp}`)
  return parts.join(' ')
}

function formatPrice(price) {
  const parts = []
  if (price.solars) parts.push(`☀️${price.solars}`)
  if (price.gems)   parts.push(`💎${price.gems}`)
  return parts.join(' + ')
}

function renderShop(player) {
  const pr = config.prefix
  const lines = [`🐾 *Astral Town Pet Store*\n`]
  for (const pet of pets) {
    const owned = player?.pets?.includes(pet.id)
    const rar   = rarityStars(pet.rarity)
    const bondLine = owned ? `  _(owned — bond Lv.${getBondLevel(player, pet.id)}/${MAX_BOND_LEVEL})_` : ''
    lines.push(
      `${pet.emoji} *${pet.name}* ${rar}${bondLine}\n` +
      `  Lv.${pet.levelReq}+  •  ${formatPrice(pet.price)}\n` +
      `  ${formatBonuses(pet.statBonuses)} _(base — grows with bond)_\n` +
      `  _${pet.description}_\n`,
    )
  }
  lines.push(`Adopt one: *${pr}pet adopt <name>*`)
  return lines.join('\n')
}

function bondBar(level) {
  const filled = Math.round((level / MAX_BOND_LEVEL) * 10)
  return '❤️'.repeat(Math.max(0, filled)) + '🤍'.repeat(Math.max(0, 10 - filled))
}

function renderCollection(player) {
  const pr = config.prefix
  const owned = player.pets ?? []
  if (owned.length === 0) {
    return (
      `🐾 You don't have any pets yet.\n` +
      `Browse the store: *${pr}pet shop*`
    )
  }
  const activeId = player.equipped?.pet
  const lines = [`🐾 *Your Pets*\n`]
  for (const id of owned) {
    const pet = petMap[id]
    if (!pet) continue
    const active  = id === activeId ? '  ⭐ _active_' : ''
    const level   = getBondLevel(player, id)
    const prog    = getBondProgress(player, id)
    const progLine = prog.maxed
      ? `  ${bondBar(level)} Lv.${level}/${MAX_BOND_LEVEL} _(max bond!)_`
      : `  ${bondBar(level)} Lv.${level}/${MAX_BOND_LEVEL} _(${prog.into}/${prog.needed} to next)_`
    lines.push(
      `${pet.emoji} *${pet.name}*${active}\n` +
      `${progLine}\n` +
      `  ${formatBonuses(scaledStatBonuses(pet, player))}`,
    )
  }
  lines.push(
    `\nEquip: *${pr}pet equip <name>*` +
    (activeId ? `  •  Unequip: *${pr}pet unequip*` : '') +
    `\nFeed (raise bond): *${pr}pet feed <name>*`,
  )
  return lines.join('\n')
}

export default {
  name: 'pet',
  aliases: ['pets', 'petshop'],
  category: 'town',
  requiresPlayer: true,
  description: `${config.prefix}pet — manage your pets (shop, adopt, equip, unequip)`,

  async run(ctx) {
    const { player, args, db } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── Browse ──────────────────────────────────────────────────────────
    if (!sub || sub === 'list' || sub === 'collection' || sub === 'my') {
      return ctx.reply(renderCollection(player))
    }

    if (sub === 'shop' || sub === 'store' || sub === 'browse') {
      return ctx.reply(renderShop(player))
    }

    // ── Adopt ───────────────────────────────────────────────────────────
    if (sub === 'adopt' || sub === 'buy') {
      if (player.inBattle)  return ctx.reply(`⚔️ You can't visit the pet store mid-battle!`)
      if (player.inDungeon) return ctx.reply(`🗺️ Exit the dungeon first. Use *${pr}dungeon leave*.`)
      if (player.location !== 'astral_town') {
        return ctx.reply(`🐾 The pet store is only in *Astral Town*. You are in *${player.location ?? 'unknown'}*.`)
      }

      const query = args.slice(1).join(' ')
      if (!query) return ctx.reply(`Usage: *${pr}pet adopt <pet name>*\nSee options: *${pr}pet shop*`)

      const pet = findPet(query)
      if (!pet) return ctx.reply(`❌ No pet found matching *"${query}"*.\nSee options: *${pr}pet shop*`)

      if ((player.pets ?? []).includes(pet.id)) {
        return ctx.reply(`⚠️ You already have *${pet.name}*.`)
      }
      if (player.level < pet.levelReq) {
        return ctx.reply(`❌ You need *level ${pet.levelReq}* to adopt *${pet.name}*. You are level ${player.level}.`)
      }

      const wallet = player.wallet ?? {}
      const needSolars = pet.price.solars ?? 0
      const needGems   = pet.price.gems ?? 0
      if ((wallet.solars ?? 0) < needSolars || (wallet.gems ?? 0) < needGems) {
        return ctx.reply(
          `❌ Not enough currency for *${pet.name}*.\n` +
          `Cost: ${formatPrice(pet.price)}  •  You have: ☀️${wallet.solars ?? 0} 💎${wallet.gems ?? 0}`,
        )
      }

      let raceAborted = false
      await updatePlayer(db, player.id, (p) => {
        if ((p.pets ?? []).includes(pet.id)) { raceAborted = true; return }
        const w = p.wallet ?? {}
        if ((w.solars ?? 0) < needSolars || (w.gems ?? 0) < needGems) { raceAborted = true; return }
        w.solars = (w.solars ?? 0) - needSolars
        w.gems   = (w.gems ?? 0) - needGems
        p.wallet = w
        p.pets   = [...(p.pets ?? []), pet.id]
      })

      if (raceAborted) return ctx.reply(`❌ Adoption failed — your state changed. Please try again.`)

      return ctx.reply(
        `🎉 You adopted *${pet.emoji} ${pet.name}*!\n` +
        `Equip it: *${pr}pet equip ${pet.id}*`,
      )
    }

    // ── Equip ───────────────────────────────────────────────────────────
    if (sub === 'equip') {
      const query = args.slice(1).join(' ')
      if (!query) return ctx.reply(`Usage: *${pr}pet equip <pet name>*`)

      const pet = findPet(query)
      if (!pet || !(player.pets ?? []).includes(pet.id)) {
        return ctx.reply(`❌ You don't own a pet matching *"${query}"*.\nSee your pets: *${pr}pet list*`)
      }
      if (player.equipped?.pet === pet.id) {
        return ctx.reply(`⚠️ *${pet.name}* is already your active pet.`)
      }

      let oldPetName = null
      let raceAborted = false
      await updatePlayer(db, player.id, (p) => {
        if (!(p.pets ?? []).includes(pet.id)) { raceAborted = true; return }
        const equipped = p.equipped ?? {}
        const oldId = equipped.pet
        if (oldId) {
          const oldPet = petMap[oldId]
          if (oldPet) {
            // Strip exactly what was added at equip time — the OLD pet's
            // scaled bonuses computed now, not its raw base. Bond level
            // only ever goes up between equips, so recomputing here is
            // safe and stays symmetric with applyFeed changing bondXp.
            applyEquipmentBonus(p, { ...oldPet, statBonuses: scaledStatBonuses(oldPet, p) }, -1)
            oldPetName = oldPet.name
          }
        }
        applyEquipmentBonus(p, { ...pet, statBonuses: scaledStatBonuses(pet, p) }, +1)
        equipped.pet = pet.id
        p.equipped = equipped
      })

      if (raceAborted) return ctx.reply(`❌ Equip failed — your state changed. Please try again.`)

      const swapLine = oldPetName ? `\n↩️ *${oldPetName}* is no longer active.` : ''
      return ctx.reply(
        `${pet.emoji} *${pet.name}* is now your active companion!${swapLine}\n` +
        `Buffs: ${formatBonuses(scaledStatBonuses(pet, player))} _(bond Lv.${getBondLevel(player, pet.id)})_\n` +
        `Use *${pr}profile* to see your updated stats.`,
      )
    }

    // ── Unequip ─────────────────────────────────────────────────────────
    if (sub === 'unequip') {
      const activeId = player.equipped?.pet
      if (!activeId) return ctx.reply(`❌ You don't have an active pet.`)

      const pet = petMap[activeId]
      let raceAborted = false
      await updatePlayer(db, player.id, (p) => {
        const equipped = p.equipped ?? {}
        if (!equipped.pet) { raceAborted = true; return }
        const oldPet = petMap[equipped.pet]
        if (oldPet) applyEquipmentBonus(p, { ...oldPet, statBonuses: scaledStatBonuses(oldPet, p) }, -1)
        equipped.pet = null
        p.equipped = equipped
      })

      if (raceAborted) return ctx.reply(`❌ You don't have an active pet.`)

      return ctx.reply(`✅ *${pet?.name ?? activeId}* has been unequipped and is resting in your collection.`)
    }

    // ── Feed (raise bond level) ────────────────────────────────────────
    if (sub === 'feed') {
      const query = args.slice(1).join(' ')
      if (!query) return ctx.reply(`Usage: *${pr}pet feed <pet name>*\nSee your pets: *${pr}pet list*`)

      const pet = findPet(query)
      if (!pet || !(player.pets ?? []).includes(pet.id)) {
        return ctx.reply(`❌ You don't own a pet matching *"${query}"*.\nSee your pets: *${pr}pet list*`)
      }

      if (getBondLevel(player, pet.id) >= MAX_BOND_LEVEL) {
        return ctx.reply(`❤️ *${pet.name}* already has max bond (Lv.${MAX_BOND_LEVEL}) — nothing more to gain from feeding.`)
      }

      const cdRemaining = feedCooldownRemaining(player, pet.id)
      if (cdRemaining > 0) {
        const mins = Math.ceil(cdRemaining / 60000)
        return ctx.reply(`⏳ *${pet.name}* is still full — feed again in *${mins} min*.`)
      }

      const cost = feedCost(pet)
      if ((player.wallet?.solars ?? 0) < cost) {
        return ctx.reply(`❌ Not enough Solars to feed *${pet.name}*.\nCost: ☀️${cost} — You have: ☀️${player.wallet?.solars ?? 0}`)
      }

      let raceAborted    = false
      let newLevel       = null
      let leveledUp      = false
      let isActive       = false
      let evolutionResult = null

      await updatePlayer(db, player.id, (p) => {
        if (!(p.pets ?? []).includes(pet.id)) { raceAborted = true; return }
        if (getBondLevel(p, pet.id) >= MAX_BOND_LEVEL) { raceAborted = true; return }
        if (feedCooldownRemaining(p, pet.id) > 0) { raceAborted = true; return }
        const w = p.wallet ?? {}
        if ((w.solars ?? 0) < cost) { raceAborted = true; return }

        const beforeLevel  = getBondLevel(p, pet.id)
        const beforeScaled = scaledStatBonuses(pet, p)

        w.solars -= cost
        p.wallet = w
        newLevel  = applyFeed(p, pet.id)
        leveledUp = newLevel > beforeLevel
        isActive  = p.equipped?.pet === pet.id

        // Check for evolution before applying the incremental bond-level delta.
        // checkEvolution swaps all pet IDs in place and returns the old/new
        // scaled stats so we can re-apply the equip bonus from scratch if needed.
        const evo = checkEvolution(p, pet.id, petMap)
        if (evo.evolved) {
          evolutionResult = evo
          if (evo.wasEquipped && evo.oldScaled && evo.newScaled) {
            applyEquipmentBonus(p, { statBonuses: evo.oldScaled }, -1)
            applyEquipmentBonus(p, { statBonuses: evo.newScaled }, +1)
            // Suppress the incremental delta below — stats already fully re-applied.
            leveledUp = false
          }
        }

        // If this pet is currently equipped, its applied stat contribution
        // needs to grow immediately to match the new bond level — otherwise
        // the buff only "catches up" the next time the player re-equips it.
        if (isActive && leveledUp) {
          const afterScaled = scaledStatBonuses(pet, p)
          const delta = {}
          for (const k of Object.keys(afterScaled)) delta[k] = afterScaled[k] - (beforeScaled[k] ?? 0)
          applyEquipmentBonus(p, { statBonuses: delta }, +1)
        }
      })

      if (raceAborted) return ctx.reply(`❌ Feeding failed — your state (Solars, bond, or cooldown) changed. Please try again.`)

      // Evolution takes priority over the normal bond-level-up message.
      if (evolutionResult) {
        return ctx.reply(
          `✨🐣 *PET EVOLUTION!*\n\n` +
          `*${evolutionResult.fromPet.emoji} ${evolutionResult.fromPet.name}* evolved into ` +
          `*${evolutionResult.toPet.emoji} ${evolutionResult.toPet.name}*!\n` +
          `All bond XP carried over — no progress lost.\n` +
          (evolutionResult.wasEquipped ? `_(Buffs updated automatically!)_\n` : ``) +
          `☀️ Spent: *${cost} solars*\n` +
          `\n_Use *${pr}pet* to see your new companion._`,
        )
      }

      const levelLine = leveledUp
        ? `\n🎉 *Bond level up!* → Lv.${newLevel}/${MAX_BOND_LEVEL}${isActive ? ' _(buffs updated live!)_' : ''}`
        : ''

      return ctx.reply(
        `🍖 You feed *${pet.emoji} ${pet.name}*!\n` +
        `☀️ Spent: *${cost} solars*` +
        levelLine +
        `\n_Use *${pr}pet* to see your updated collection._`,
      )
    }

    return ctx.reply(
      `Usage:\n` +
      `  *${pr}pet* — view your collection\n` +
      `  *${pr}pet shop* — browse the pet store\n` +
      `  *${pr}pet adopt <name>* — adopt a pet\n` +
      `  *${pr}pet equip <name>* — set your active pet\n` +
      `  *${pr}pet unequip* — unequip your active pet\n` +
      `  *${pr}pet feed <name>* — raise a pet's bond level (stronger buffs)`,
    )
  },
}
