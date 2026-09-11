/**
 * npc-battle-ui.js — shared rendering + move-menu helpers for the NPC Pokemon
 * battles (wild hunts and the League tower). Kept apart from the engine
 * (lib/npc-pokemon.js, pure logic) and the plugins (flow) so both battle types
 * render identically.
 *
 * Reuses the PvP battle frame renderer (sendPokemonBattleTurnReply) with the
 * same { left, right, msg, lastAction } contract, so an NPC fight looks exactly
 * like a trainer duel. `left` is always the player, `right` the foe.
 *
 * Copy is player-facing: no dashes.
 */
import { getMovesForIds } from './move-pool.js'
import { sendPokemonBattleTurnReply } from './pokemon-battle-render.mjs'

const TYPE_EMOJI = {
  normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿',
  ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️',
  psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉',
  dark: '🌑', steel: '⚙️', fairy: '✨',
}

/** The player's 4 moves as a numbered menu, prompting .pstrike. */
export function formatMoveMenu(mon, prefix) {
  const moves = getMovesForIds(mon.moves ?? [])
  const list = moves.map((mv, i) => {
    const power = mv.power != null ? mv.power : '—'
    const acc = mv.accuracy != null ? `${mv.accuracy}%` : 'sure hit'
    const cat = mv.category.charAt(0).toUpperCase() + mv.category.slice(1)
    return `*${i + 1}.* ${TYPE_EMOJI[mv.type] ?? '❔'} *${mv.name}* _(${cat}, Pow ${power}, Acc ${acc})_`
  }).join('\n')
  return `🎯 *Choose your move:*\n${list}\n\n_Attack with *${prefix}pstrike <move #>*._`
}

/**
 * Render one NPC battle frame. `bs` is the npcBattleState, `playerMon` the
 * player's main. `msg` is the log/prose for this frame. `lastAction` (optional)
 * drives the render's impact burst; the player is 'left', the foe 'right'.
 */
export function sendNpcBattleFrame(ctx, bs, playerMon, msg, lastAction = null) {
  const foe = bs.foe
  return sendPokemonBattleTurnReply(ctx, {
    left: {
      name: playerMon.nickname ?? playerMon.name,
      image: playerMon.image,
      hp: bs.playerHp,
      maxHp: bs.playerMaxHp,
      level: playerMon.level,
      shiny: playerMon.shiny,
    },
    right: {
      name: foe.name,
      image: foe.image,
      hp: bs.foeHp,
      maxHp: bs.foeMaxHp,
      level: foe.level,
      shiny: foe.shiny,
    },
    msg,
    lastAction,
  })
}
