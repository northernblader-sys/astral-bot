/**
 * pstrike — throw one move in an active NPC Pokemon battle (wild hunt OR League
 * tower). The single combat verb for lib/npc-pokemon.js fights, the NPC-side
 * counterpart to .move (which is PvP only).
 *
 *   .pstrike <move #>   use that move (1 to 4 from your main's moveset)
 *   .pstrike            show your move menu again
 *
 * Turn flow (synchronous, no waiting on a second player):
 *   1. resolve the turn (player move + NPC move) via resolveNpcTurn
 *   2. if the FOE fainted:
 *        wild  -> offer a catch (auto-rolled here), then end the battle
 *        tower -> heal the player, send in the master's next mon, or if the
 *                 team is empty, clear the rung (reward on first clear) and,
 *                 if this was the last master, crown the player
 *   3. if the PLAYER fainted: end the battle as a loss (no penalty beyond the
 *      lost attempt, tower progress is preserved so they can retry the rung)
 *   4. otherwise: persist HP and prompt the next move
 *
 * Copy is player-facing: no dashes.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getMainPokemon, addPokemonToPlayer, fetchPokemonById } from '../lib/pokemon-engine.js'
import { resolveNpcTurn, buildFoeMon } from '../lib/npc-pokemon.js'
import { sendNpcBattleFrame, formatMoveMenu } from '../lib/npc-battle-ui.js'
import { recordQuestEvent } from '../lib/quest-engine.js'
import {
  getMaster, masterCount, catchChanceFor, towerRewardLine, applyTowerReward,
} from '../lib/poke-tower.js'

export default {
  name: 'pstrike',
  aliases: ['ps', 'pmove'],
  category: 'pokemon',
  requiresPlayer: true,
  description: `${config.prefix}pstrike <move #> — use a move in a wild or tower Pokemon battle.`,

  async run(ctx) {
    const { player, args, reply } = ctx
    const pr = config.prefix

    const bs0 = player.npcBattleState
    if (!bs0) {
      return reply(`❌ You are not in a wild or tower battle.\n_Start one with *${pr}pokehunt* or *${pr}poketower*._`)
    }
    const main = getMainPokemon(player)
    if (!main) {
      return reply(`❌ Your main Pokemon is missing. Battle cancelled.`)
    }

    // ── No arg: reshow the move menu ─────────────────────────────────────
    const raw = (args[0] ?? '').trim()
    if (!raw) {
      return reply(formatMoveMenu(main, pr))
    }

    // Resolve the chosen move: 1..4 index into the main's moveset.
    let moveId = null
    if (/^[1-4]$/.test(raw)) moveId = main.moves?.[parseInt(raw, 10) - 1] ?? null
    else {
      const q = raw.toLowerCase()
      moveId = (main.moves ?? []).find(id => id.toLowerCase() === q) ?? null
    }
    if (!moveId) {
      return reply(`❓ *"${raw}"* is not one of your moves.\n\n${formatMoveMenu(main, pr)}`)
    }

    // ── Resolve the turn inside a single writer ──────────────────────────
    let result = null
    let outcome = null // 'foe_faint' | 'player_faint' | 'continue'
    let bsAfter = null
    let mainAfter = null

    await updatePlayer(ctx.db, ctx.from, p => {
      const bs = p.npcBattleState
      const m = getMainPokemon(p)
      if (!bs || !m) { outcome = 'gone'; return p }

      result = resolveNpcTurn(bs, m, moveId)

      // Keep the mon's stored currentHp in step with the battle pool so a fight
      // that spans turns, or ends, always reflects real damage taken.
      m.currentHp = Math.max(0, bs.playerHp)

      if (result.playerFainted) outcome = 'player_faint'
      else if (result.foeFainted) outcome = 'foe_faint'
      else outcome = 'continue'

      bsAfter = bs
      mainAfter = m
      return p
    })

    if (outcome === 'gone') {
      return reply(`❌ The battle ended unexpectedly.`)
    }

    const log = result.log.join('\n')

    // ── Continue: neither side fainted ───────────────────────────────────
    if (outcome === 'continue') {
      return sendNpcBattleFrame(ctx, bsAfter, mainAfter,
        `${log}\n\n${formatMoveMenu(mainAfter, pr)}`, result.lastAction)
    }

    // ── Player fainted: loss ─────────────────────────────────────────────
    if (outcome === 'player_faint') {
      const kind = bsAfter.kind
      await updatePlayer(ctx.db, ctx.from, p => {
        const m = getMainPokemon(p)
        if (m) m.currentHp = m.maxHp // healed back at a Pokemon Center offscreen
        p.npcBattleState = null
        return p
      })
      return sendNpcBattleFrame(ctx, bsAfter, mainAfter,
        `${log}\n\n😵 *${mainAfter.nickname ?? mainAfter.name} was knocked out.*\n` +
        (kind === 'tower'
          ? `_Your climb ends here for now. Your progress is saved, try the rung again with *${pr}poketower*._`
          : `_The wild Pokemon slipped away. Heal up and hunt again with *${pr}pokehunt*._`),
        result.lastAction)
    }

    // ── Foe fainted ──────────────────────────────────────────────────────
    if (bsAfter.kind === 'wild') {
      return concludeWildWin(ctx, bsAfter, mainAfter, log)
    }
    return concludeTowerFoeDown(ctx, bsAfter, mainAfter, log)
  },
}

// ── Wild win + catch ─────────────────────────────────────────────────────────
async function concludeWildWin(ctx, bs, main, log) {
  const pr = config.prefix
  const foe = bs.foe
  const chance = catchChanceFor(bs.foeMaxHp, bs.level, main.level)
  const caught = Math.random() < chance

  let caughtMon = null
  await updatePlayer(ctx.db, ctx.from, p => {
    recordQuestEvent(p, 'poke_win', 1)
    const m = getMainPokemon(p)
    if (m) m.currentHp = m.maxHp // rest after the fight
    if (caught) {
      // Re-derive a fresh owned mon from the foe's own species/level so the
      // caught Pokemon gets its own id and clean state (not the battle-worn foe
      // object). buildFoeMon already produced owned shape; clone it cleanly.
      caughtMon = addPokemonToPlayer(p, {
        dexId: foe.dexId, name: foe.name, types: foe.types, abilities: foe.abilities,
        hp: foe.baseHp, atk: foe.baseAtk, def: foe.baseDef, spd: foe.baseSpd,
        spAtk: foe.baseSpAtk, spDef: foe.baseSpDef, apiMoveNames: [],
        image: foe.image, sprite: foe.sprite, isShiny: foe.shiny,
      }, { level: bs.level })
      // The re-fetch path can lose the resolved moveset (apiMoveNames empty), so
      // carry the foe's already-resolved moves straight over.
      caughtMon.moves = foe.moves
      recordQuestEvent(p, 'catch', 1)
    }
    p.npcBattleState = null
    return p
  })

  const win = `${log}\n\n🏆 *You defeated the wild ${foe.name}!*`
  if (caught) {
    const shinyTag = caughtMon.shiny ? '✨ *SHINY* ' : ''
    return sendNpcBattleFrame(ctx, bs, main,
      `${win}\n\n🎉 *Gotcha! ${shinyTag}${foe.name} was caught!*\n` +
      `_Find it in *${pr}pokemon dex*, or make it your main with *${pr}pokemon main ${foe.name}*._`)
  }
  return sendNpcBattleFrame(ctx, bs, main,
    `${win}\n\n💨 _It broke free and fled before you could catch it. Better luck on the next hunt._`)
}

// ── Tower foe down: next mon, or rung clear ───────────────────────────────────
async function concludeTowerFoeDown(ctx, bs, main, log) {
  const pr = config.prefix
  const master = getMaster(bs.stage)
  const nextIdx = (bs.teamIdx ?? 0) + 1

  // More mons on this master's team: send in the next one, heal the player.
  if (nextIdx < (bs.teamLen ?? master.team.length)) {
    const nextDex = master.team[nextIdx]
    const raw = await fetchPokemonById(nextDex)
    if (!raw) {
      // Could not fetch the next mon (network). End the rung gracefully as a
      // win-in-progress rather than trapping the player; they can retry.
      await updatePlayer(ctx.db, ctx.from, p => { p.npcBattleState = null; return p })
      return sendNpcBattleFrame(ctx, bs, main,
        `${log}\n\n⚠️ _${master.name}'s next Pokemon could not be reached. The battle is paused, retry with *${pr}poketower*._`)
    }
    const nextFoe = buildFoeMon(raw, master.level)

    let bsAfter = null
    let mainAfter = null
    await updatePlayer(ctx.db, ctx.from, p => {
      const m = getMainPokemon(p)
      if (m) m.currentHp = m.maxHp // full heal between the master's mons
      p.npcBattleState.teamIdx = nextIdx
      p.npcBattleState.foe = nextFoe
      p.npcBattleState.foeHp = nextFoe.maxHp
      p.npcBattleState.foeMaxHp = nextFoe.maxHp
      p.npcBattleState.playerHp = m.maxHp
      p.npcBattleState.turn = 1
      bsAfter = p.npcBattleState
      mainAfter = m
      return p
    })
    return sendNpcBattleFrame(ctx, bsAfter, mainAfter,
      `${log}\n\n${master.emoji} *${master.name} sends out ${nextFoe.name}!* [Lvl ${master.level}]\n` +
      `_You are healed. ${bsAfter.teamLen - nextIdx} left on their team._\n\n${formatMoveMenu(mainAfter, pr)}`,
      { actor: 'left', kind: 'hit', damage: null })
  }

  // Team cleared: this master is beaten.
  const isChampion = master.kind === 'champion'
  const isLast = bs.stage >= masterCount()
  let rewardLine = ''
  let firstClear = false

  await updatePlayer(ctx.db, ctx.from, p => {
    recordQuestEvent(p, 'poke_win', 1)
    const m = getMainPokemon(p)
    if (m) m.currentHp = m.maxHp
    p.pokeTower = p.pokeTower ?? { highestCleared: 0, championed: false }
    if (bs.stage > p.pokeTower.highestCleared) {
      firstClear = true
      p.pokeTower.highestCleared = bs.stage
      rewardLine = applyTowerReward(p, master)
    }
    if (isChampion) p.pokeTower.championed = true
    p.npcBattleState = null
    return p
  })

  const beat =
    `${log}\n\n${master.emoji} *You defeated ${master.name}, the ${master.title}!*\n` +
    `_"${master.defeat}"_`
  const rewardPart = firstClear && rewardLine ? `\n\n🎁 *Rung reward:* ${rewardLine}` : (firstClear ? '' : `\n\n_(Rung already cleared, no reward again.)_`)

  if (isChampion) {
    return sendNpcBattleFrame(ctx, bs, main,
      `${beat}${rewardPart}\n\n` +
      `👑✨ *SINNOH CHAMPION!* ✨👑\n` +
      `_You have climbed the entire League and taken the crown. There is no higher rung. Your name stands at the very top._`)
  }
  const nextStage = bs.stage + 1
  return sendNpcBattleFrame(ctx, bs, main,
    `${beat}${rewardPart}\n\n` +
    `_Next up the ladder awaits. Challenge them with *${pr}poketower*._` +
    (isLast ? '' : `\n_(You are now on rung ${nextStage}.)_`))
}
