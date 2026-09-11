/**
 * eat — Eat food from your inventory to refill your hunger bar.
 *
 * The eating twin of plugins/use.js: same race-guarded updatePlayer
 * consume-one-instance pattern, but instead of routing through lib/effects.js
 * it calls feed() in lib/hunger-engine.js — the single owner of player.hunger.
 * The Golden Apple (immunity:true) also switches on permanent hunger immunity
 * until the player's next death.
 *
 * Usable anywhere EXCEPT mid-battle, so you can eat between dungeon fights
 * without eating a turn in the battle economy.
 *
 * Usage: <prefix>eat <food name or id>
 */
import { config } from '../config.js'
import { allItems } from '../lib/game-data.js'
import { updatePlayer } from '../lib/player-repo.js'
import { feed, hungerBar, ensureHunger } from '../lib/hunger-engine.js'

const itemMap = Object.fromEntries(allItems.map(i => [i.id, i]))

/** First matching id in inventory — exact id, else partial name. */
function findInInventory(inventory, query) {
  const q = query.toLowerCase()
  if (inventory.includes(q)) return q
  for (const id of inventory) {
    const item = itemMap[id]
    if (item && item.name.toLowerCase().includes(q)) return id
  }
  return null
}

export default {
  name:           'eat',
  aliases:        ['feed'],
  category:       'inventory',
  requiresPlayer: true,
  description:    `${config.prefix}eat <food> — eat food to refill your hunger bar`,

  async run(ctx) {
    const { player, args } = ctx
    const pr = config.prefix

    if (player.inBattle) {
      return ctx.reply(`⚔️ You can't stop to eat mid-battle! Finish the fight first.`)
    }
    if (!args || args.length === 0) {
      return ctx.reply(`Usage: *${pr}eat <food name or id>*\nSee your food with *${pr}inventory*.`)
    }

    const query   = args.join(' ')
    const foundId  = findInInventory(player.inventory ?? [], query)
    if (!foundId) {
      return ctx.reply(
        `❌ *"${query}"* not found in your inventory.\n` +
        `Cook a dish with *${pr}cook* or check *${pr}inventory*.`,
      )
    }

    const item = itemMap[foundId]
    if (!item) return ctx.reply(`❌ Item data for *${foundId}* is missing. Please report this bug.`)

    if (item.type !== 'food') {
      return ctx.reply(
        `❌ *${item.name}* isn't food — you can't eat it.\n` +
        `Try *${pr}use ${foundId}* instead.`,
      )
    }

    let raceAborted = false
    let barAfter    = ''
    let restored    = 0
    const wasImmune = item.immunity === true

    await updatePlayer(ctx.db, ctx.from, (p) => {
      const inv = p.inventory ?? []
      const idx = inv.indexOf(foundId)
      if (idx === -1) { raceAborted = true; return } // consumed by a concurrent command

      const before = ensureHunger(p).current       // hunger before eating
      restored = Math.round(feed(p, item.hunger, { immune: wasImmune }) - before)

      inv.splice(idx, 1)
      p.inventory = inv
      barAfter = hungerBar(p)
    })

    if (raceAborted) {
      return ctx.reply(`❌ *${item.name}* is no longer in your inventory — please try again.`)
    }

    const immuneNote = wasImmune
      ? `\n✨ *The Golden Apple's power fills you* — you will not hunger again until you die.`
      : ''
    return ctx.reply(
      `🍽️ You ate *${item.name}*! _(+${restored} hunger)_\n` +
      `${barAfter}${immuneNote}`,
    )
  },
}
