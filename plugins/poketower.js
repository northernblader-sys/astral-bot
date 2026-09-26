/**
 * poketower — climb the Sinnoh Pokemon League: 8 Gym Leaders, the Elite Four,
 * then Champion Cynthia at the very top. The NPC counterpart to pokehunt: a
 * fixed, ordered ladder of trainers instead of a random wild mon.
 *
 *   .poketower           challenge your next rung (or show the ladder if idle)
 *   .poketower ladder    show the full ladder and your progress
 *   .poketower run       forfeit the current tower battle
 *   (during a battle you fight with .pstrike <move #>, see plugins/pstrike.js)
 *
 * Rung flow: each master fields a team of Pokemon fought one after another.
 * Your single main is fully healed between the master's mons. Beat the whole
 * team to clear the rung (reward paid once, on first clear) and unlock the next.
 * All the per-turn combat and the next-mon / rung-clear transitions live in
 * plugins/pstrike.js; this plugin only starts a rung and renders the ladder.
 *
 * State: player.pokeTower = { highestCleared, championed }, and an active fight
 * reuses player.npcBattleState with kind 'tower'.
 *
 * Copy is player-facing: no dashes.
 */
import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { getMainPokemon, fetchPokemonById } from '../lib/pokemon-engine.js'
import { buildFoeMon } from '../lib/npc-pokemon.js'
import { sendNpcBattleFrame, formatMoveMenu } from '../lib/npc-battle-ui.js'
import {
  allMasters, getMaster, masterCount, nextStageFor, towerRewardLine,
} from '../lib/poke-tower.js'

export default {
  name: 'poketower',
  aliases: ['ptower', 'league'],
  category: 'pokemon',
  requiresPlayer: true,
  description: `${config.prefix}poketower — climb the Sinnoh League ladder against Gym Leaders, the Elite Four, and Champion Cynthia.`,

  async run(ctx) {
    const { player, args, reply } = ctx
    const pr = config.prefix
    const sub = (args[0] ?? '').toLowerCase()

    // ── Forfeit ──────────────────────────────────────────────────────────
    if (sub === 'run' || sub === 'flee' || sub === 'forfeit') {
      let left = false
      await updatePlayer(ctx.db, ctx.from, p => {
        if (p.npcBattleState?.kind === 'tower') { p.npcBattleState = null; left = true }
        return p
      })
      return reply(left
        ? `🏳️ You step back from the challenge. The rung stands, come again with *${pr}poketower*.`
        : `❌ You are not in a tower battle.`)
    }

    // ── Ladder view ──────────────────────────────────────────────────────
    if (sub === 'ladder' || sub === 'list' || sub === 'progress') {
      return reply(renderLadder(player, pr))
    }

    // ── Guards ───────────────────────────────────────────────────────────
    if (player.npcBattleState) {
      const k = player.npcBattleState.kind
      return reply(
        k === 'tower'
          ? `⚔️ You are already in a tower battle.\n_Fight with *${pr}pstrike <move #>* or forfeit with *${pr}poketower run*._`
          : `⚔️ Finish your wild battle first. Fight with *${pr}pstrike <move #>* or leave with *${pr}pokehunt run*.`,
      )
    }
    if (player.inPokemonBattle) {
      return reply(`⚔️ You are in a trainer duel right now. Finish it first.`)
    }
    const main = getMainPokemon(player)
    if (!main) {
      return reply(`❌ You have no main Pokemon set.\n_Catch one, then set it with *${pr}pokemon main <name>*._`)
    }

    const stage = nextStageFor(player)
    if (stage == null) {
      return reply(
        `👑 *You are already the Sinnoh Champion.*\n` +
        `_You have cleared every rung. Review the ladder with *${pr}poketower ladder*._`,
      )
    }
    const master = getMaster(stage)
    if (!master) {
      return reply(`❌ The ladder could not be read. Try again shortly.`)
    }

    // ── Fetch the master's first mon and open the battle ─────────────────
    await reply(`${master.emoji} *${master.name}* steps up.\n_"${master.intro}"_\n\n_Sending out their first Pokemon..._`)

    const firstDex = master.team[0]
    const raw = await fetchPokemonById(firstDex)
    if (!raw) {
      return reply(`⚠️ ${master.name}'s Pokemon could not be reached right now. Try *${pr}poketower* again shortly.`)
    }
    const foe = buildFoeMon(raw, master.level)

    let bs = null
    let mainAfter = null
    await updatePlayer(ctx.db, ctx.from, p => {
      const m = getMainPokemon(p)
      if (m) m.currentHp = m.maxHp // start the rung at full
      p.npcBattleState = {
        kind: 'tower',
        stage,
        teamIdx: 0,
        teamLen: master.team.length,
        masterName: master.name,
        masterEmoji: master.emoji,
        level: master.level,
        catchable: false, // you never catch a master's Pokemon
        playerHp: m.maxHp,
        playerMaxHp: m.maxHp,
        foe,
        foeHp: foe.maxHp,
        foeMaxHp: foe.maxHp,
        turn: 1,
      }
      bs = p.npcBattleState
      mainAfter = m
      return p
    })

    const rungLabel = master.kind === 'champion' ? 'CHAMPION' : master.kind === 'elite4' ? 'ELITE FOUR' : `GYM ${stage}`
    const intro =
      `🏛️ *League Rung ${stage} of ${masterCount()} — ${rungLabel}*\n` +
      `${master.emoji} *${master.name}, ${master.title}* sends out *${foe.name}!* [Lvl ${master.level}]\n` +
      `_Their team: ${master.team.length} Pokemon. You are healed between each._\n\n` +
      formatMoveMenu(mainAfter, pr) +
      `\n_Or forfeit with *${pr}poketower run*._`

    return sendNpcBattleFrame(ctx, bs, mainAfter, intro)
  },
}

// ── Ladder render ──────────────────────────────────────────────────────────
function renderLadder(player, pr) {
  const cleared = player.pokeTower?.highestCleared ?? 0
  const championed = player.pokeTower?.championed
  const next = nextStageFor(player)

  const lines = allMasters().map(m => {
    const done = m.stage <= cleared
    const isNext = m.stage === next
    const mark = done ? '✅' : isNext ? '⚔️' : '🔒'
    const rewardHint = done ? '' : `  _(${towerRewardLine(m).replace(/\*/g, '')})_`
    const tag = m.kind === 'champion' ? ' 👑' : m.kind === 'elite4' ? ' [E4]' : ''
    return `${mark} *${m.stage}.* ${m.emoji} ${m.name}${tag} _(Lvl ${m.level}, ${m.specialty})_${isNext ? rewardHint : ''}`
  })

  const header = championed
    ? `👑✨ *Sinnoh Champion* — you have cleared the entire League.`
    : cleared > 0
      ? `🏛️ *Sinnoh League* — ${cleared} of ${masterCount()} rungs cleared.`
      : `🏛️ *Sinnoh League* — a ladder of ${masterCount()} masters. Start climbing.`

  const footer = next == null
    ? `\n_There is no higher rung. You stand at the summit._`
    : `\n_Challenge rung ${next} with *${pr}poketower*._`

  return `${header}\n\n${lines.join('\n')}\n${footer}`
}
