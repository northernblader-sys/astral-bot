/**
 * move.js — Pokémon overhaul §2: move selection during an active
 * simultaneous-turn pokebattle (see plugins/pokebattle.js's turn model doc
 * block for the full state shape).
 *
 * Usage:
 *   .move               — shows your active Pokémon's 4 equipped moves as a
 *                          numbered list (name, type emoji, category, power,
 *                          accuracy) if you're in an active pokebattle
 *   .move <name or #>   — locks in that move as this turn's action. Once
 *                          both trainers have a pendingMove set, the turn
 *                          resolves immediately via pokebattle.js's
 *                          resolvePokeBattleTurn().
 *
 * No re-teaching/move-swapping here — moveset is fixed at catch time (see
 * .pokemon moveset <n> for read-only inspection outside of battle). This
 * file only ever reads mon.moves, never mutates it.
 *
 * Deliberately does NOT reveal whether the opponent has chosen yet, or what
 * they chose — that's a real balance leak in a simultaneous-select design
 * (see pokebattle.js's accept() comment). "Waiting for {opponent}..." is
 * the only status this file will ever report about the other side.
 */
import { config } from '../config.js'
import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { getMainPokemon } from '../lib/pokemon-engine.js'
import { getMoveById, getMovesForIds } from '../lib/move-pool.js'
import { inPokeBattle, resolvePokeBattleTurn } from './pokebattle.js'

function typeEmojiInline(type) {
  const TYPE_EMOJI = {
    normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿',
    ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️',
    psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉',
    dark: '🌑', steel: '⚙️', fairy: '✨',
  }
  return TYPE_EMOJI[type] ?? '❔'
}

function formatMoveList(moves) {
  return moves.map((mv, i) => {
    const power = mv.power != null ? mv.power : '—'
    const acc   = mv.accuracy != null ? `${mv.accuracy}%` : 'Never misses'
    const cat   = mv.category.charAt(0).toUpperCase() + mv.category.slice(1)
    return `*${i + 1}.* ${typeEmojiInline(mv.type)} *${mv.name}* _(${cat})_ — Power: ${power} · Acc: ${acc}`
  }).join('\n')
}

/**
 * Resolves a `.move` argument (either a 1-based index into the mon's 4
 * moves, or a case-insensitive name/id match) to a move id from that mon's
 * equipped moveset. Returns null if no match.
 */
function resolveChosenMoveId(mon, raw) {
  const q = String(raw ?? '').trim()
  if (!q) return null

  if (/^[1-4]$/.test(q)) {
    const idx = parseInt(q, 10) - 1
    return mon.moves[idx] ?? null
  }

  const qLower = q.toLowerCase()
  for (const moveId of mon.moves) {
    const mv = getMoveById(moveId)
    if (!mv) continue
    if (mv.id.toLowerCase() === qLower || mv.name.toLowerCase() === qLower) return mv.id
  }
  return null
}

export default {
  name: 'move',
  aliases: ['mv'],
  category: 'pokemon',
  requiresPlayer: true,
  description: `${config.prefix}move <name or #> — lock in your move during an active Pokémon battle`,
  subcommands: [
    { cmd: '',          desc: 'show your 4 equipped moves (during your active battle turn)' },
    { cmd: '<name or #>', desc: 'lock in that move for this turn' },
  ],

  async run(ctx) {
    const { player, args, db } = ctx
    const pr = config.prefix

    if (!inPokeBattle(player)) {
      return ctx.reply(`❌ You're not in an active Pokémon battle. Challenge someone: *${pr}p-battle @target*`)
    }

    const mon = getMainPokemon(player)
    if (!mon) {
      return ctx.reply(`❌ Your Main Pokémon is missing — battle state may be corrupted. Try *${pr}p-battle forfeit*.`)
    }

    const query = args.join(' ').trim()

    // ── .move (no args) — show the numbered move list ────────────────────
    if (!query) {
      const moves = getMovesForIds(mon.moves)
      return ctx.reply(
        `🎯 *${mon.nickname ?? mon.name}'s Moves* 🎯\n\n` +
        formatMoveList(moves) +
        `\n\n_${pr}move <name or #> to lock it in._`
      )
    }

    // ── .move <name or #> — validate + lock in ────────────────────────────
    const chosenId = resolveChosenMoveId(mon, query)
    if (!chosenId) {
      return ctx.reply(`❓ *"${query}"* isn't one of ${mon.nickname ?? mon.name}'s equipped moves. Try *${pr}move* to see them.`)
    }

    // Choice Band/Specs lock (addendum §11.1/§11.2) — once set (on this
    // Pokémon's first move use while holding a choice item), the holder
    // MUST keep selecting that same move for the rest of the battle. This
    // is checked here at SELECTION time (rejecting a different pick),
    // separate from pokebattle.js's applyChoiceLockOnMoveUse() which is
    // what actually SETS the lock the first time a locked-eligible move is
    // used — selection-time enforcement and use-time lock-setting are two
    // different moments, both needed.
    const lockedMoveId = player.pokemonBattleState?.choiceLockedMove
    if (lockedMoveId && lockedMoveId !== chosenId) {
      const lockedMove = getMoveById(lockedMoveId)
      return ctx.reply(
        `🔒 Your held item locks you into *${lockedMove?.name ?? lockedMoveId}* for the rest of this battle!`
      )
    }

    // Re-read fresh state inside updatePlayer to avoid acting on stale
    // ctx.player if something else raced in between (same top-level,
    // never-nested updatePlayer discipline pokebattle.js documents).
    let outcome = null
    let opponentJid = null
    await updatePlayer(db, ctx.from, (p) => {
      if (!inPokeBattle(p)) { outcome = { ok: false, reason: 'not_in_battle' }; return }
      const bs = p.pokemonBattleState
      if (bs.pendingMove !== null) { outcome = { ok: false, reason: 'already_chosen' }; return }
      // Re-check the lock against fresh state too — the ctx.player read
      // above could theoretically be stale if a lock was set concurrently.
      if (bs.choiceLockedMove && bs.choiceLockedMove !== chosenId) {
        outcome = { ok: false, reason: 'choice_locked', lockedId: bs.choiceLockedMove }
        return
      }
      bs.pendingMove = chosenId
      opponentJid = bs.opponentJid
      outcome = { ok: true }
    })

    if (!outcome?.ok) {
      if (outcome?.reason === 'already_chosen') {
        return ctx.reply(`✅ You've already locked in your move this turn — waiting for your opponent...`)
      }
      if (outcome?.reason === 'choice_locked') {
        const lockedMove = getMoveById(outcome.lockedId)
        return ctx.reply(
          `🔒 Your held item locks you into *${lockedMove?.name ?? outcome.lockedId}* for the rest of this battle!`
        )
      }
      return ctx.reply(`❌ You're not in an active Pokémon battle.`)
    }

    const moveDef = getMoveById(chosenId)
    const chosenLine = `✅ You chose *${moveDef.name}*. Waiting for your opponent...`

    // ── Check if the opponent has also locked in — if so, resolve now ─────
    let opponentReady = false
    const opponent = getPlayer(db, opponentJid)
    if (opponent?.pokemonBattleState?.pendingMove) {
      opponentReady = true
    }

    if (!opponentReady) {
      return ctx.reply(chosenLine)
    }

    // Both sides have chosen — resolve the turn. Reply to this chat/context;
    // resolvePokeBattleTurn sends the full turn result (image + battle log)
    // as its own reply, so no separate "waiting" message is needed here.
    return resolvePokeBattleTurn(db, ctx, ctx.from, opponentJid)
  },
}
