/**
 * pokehunt — go looking for a WILD Pokemon and battle it on demand.
 *
 *   .pokehunt            find a wild Pokemon and start a battle with your main
 *   .pokehunt run        flee the current wild battle
 *   (during a battle you fight with .pstrike <move #>, see plugins/pstrike.js)
 *
 * This is the "there is no way to just go battle a Pokemon" fix: the only wild
 * Pokemon before this were claim-by-code spawns (.collect) with no fight at all,
 * and battles were PvP-only. Now a player can pick a fight any time against a
 * level-scaled wild mon, and if they win they get a shot at catching it.
 *
 * Runs on the synchronous NPC engine (lib/npc-pokemon.js) and stores state on
 * player.npcBattleState, so it never touches the PvP pokebattle machinery.
 *
 * Copy is player-facing: no dashes.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getMainPokemon, fetchRandomPokemon, addPokemonToPlayer } from '../lib/pokemon-engine.js'
import { buildFoeMon } from '../lib/npc-pokemon.js'
import { computeBattleStats } from '../lib/pokemon-stats.js'
import { sendNpcBattleFrame, formatMoveMenu } from '../lib/npc-battle-ui.js'

// Wild level scales gently around the player's own main so a hunt is a fight,
// not a wall or a pushover: main level plus/minus a small band, floored at 3.
function rollWildLevel(mainLevel) {
  const base = Math.max(3, mainLevel ?? 5)
  const delta = Math.floor(Math.random() * 5) - 2 // -2..+2
  return Math.max(3, base + delta)
}

export default {
  name: 'pokehunt',
  aliases: ['phunt', 'wild'],
  category: 'pokemon',
  requiresPlayer: true,
  description: `${config.prefix}pokehunt — find and battle a wild Pokemon. Win for a chance to catch it.`,

  async run(ctx) {
    const { player, args, reply } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── Flee ─────────────────────────────────────────────────────────────
    if (sub === 'run' || sub === 'flee') {
      let fled = false
      await updatePlayer(ctx.db, ctx.from, p => {
        if (p.npcBattleState?.kind === 'wild') { p.npcBattleState = null; fled = true }
        return p
      })
      return reply(fled
        ? `🏃 You backed away from the wild Pokemon. No harm done.`
        : `❌ You are not in a wild battle.`)
    }

    // ── Guards ───────────────────────────────────────────────────────────
    if (player.npcBattleState) {
      const k = player.npcBattleState.kind
      return reply(
        k === 'wild'
          ? `⚔️ You are already facing a wild *${player.npcBattleState.foe?.name ?? 'Pokemon'}*.\n_Fight with *${pr}pstrike <move #>* or leave with *${pr}pokehunt run*._`
          : `⚔️ Finish your tower battle first. Fight with *${pr}pstrike <move #>*.`,
      )
    }
    if (player.inPokemonBattle) {
      return reply(`⚔️ You are in a trainer duel right now. Finish it first.`)
    }
    const main = getMainPokemon(player)
    if (!main) {
      return reply(`❌ You have no main Pokemon set.\n_Catch one, then set it with *${pr}pokemon main <name>*._`)
    }

    // ── Find a wild Pokemon ──────────────────────────────────────────────
    await reply(`🌿 You wade into the tall grass, searching...`)
    const raw = await fetchRandomPokemon()
    if (!raw) {
      return reply(`🍃 Nothing stirred this time. Try *${pr}pokehunt* again.`)
    }

    const level = rollWildLevel(main.level)
    const foe = buildFoeMon(raw, level)
    const foeStats = computeBattleStats(foe)
    const foeMaxHp = foe.maxHp
    const playerMaxHp = main.maxHp

    let bs = null
    await updatePlayer(ctx.db, ctx.from, p => {
      const m = getMainPokemon(p)
      p.npcBattleState = {
        kind: 'wild',
        level,
        catchable: true,
        playerHp: m.currentHp > 0 ? m.currentHp : m.maxHp,
        playerMaxHp: m.maxHp,
        foe,
        foeHp: foeMaxHp,
        foeMaxHp,
        turn: 1,
      }
      bs = p.npcBattleState
      return p
    })

    const shinyTag = foe.shiny ? '✨ *SHINY* ' : ''
    const intro =
      `🌿 *A wild ${shinyTag}${foe.name} appeared!* [Lvl ${level}]\n\n` +
      `It squares up against *${main.nickname ?? main.name}*.\n\n` +
      formatMoveMenu(main, pr) +
      `\n_Or back off with *${pr}pokehunt run*._`

    return sendNpcBattleFrame(ctx, bs, main, intro)
  },
}
