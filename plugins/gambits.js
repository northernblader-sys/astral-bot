/**
 * gambits.js - .gambits: the duel "opening book".
 *
 * Lists every named line the PvP commentator can recognize (openings,
 * variations, and motifs) and the exact .pvp moves that trigger each one.
 * The data comes straight from lib/pvp-gambits.js via listGambits(), so this
 * listing can never drift from what the battle engine actually announces.
 */
import { config } from '../config.js'
import { listGambits } from '../lib/pvp-gambits.js'

const DIV = '━━━━━━━━━━━━━━━━━'

function section(title, items) {
  return (
    `*${title}*\n\n` +
    items
      .map(i =>
        `📖 *${i.name}*\n` +
        `   _“${i.flavor}”_\n` +
        `   ▸ ${i.trigger}`
      )
      .join('\n\n')
  )
}

export default {
  name: 'gambits',
  aliases: ['variations', 'openings', 'gambit', 'lines', 'book'],
  category: 'pvp',
  requiresPlayer: false,
  description: 'List every PvP duel line (openings, variations, motifs) and how to trigger each',

  async run(ctx) {
    const { reply } = ctx
    const p = config.prefix
    const { openings, variations, motifs } = listGambits(p)

    const msg =
      `📖 *THE DUEL OPENING BOOK*\n` +
      `${DIV}\n` +
      `_Like a chess engine, the bot names the shape of your duel as it forms and calls it out mid fight. Here is every line it knows and how to reach it._\n\n` +
      `${section('⚔️ OPENINGS  ·  your very first move', openings)}\n\n` +
      `${DIV}\n` +
      `${section('🔀 VARIATIONS  ·  first move plus the answer', variations)}\n\n` +
      `${DIV}\n` +
      `${section('✨ MOTIFS  ·  shapes that form over a whole duel', motifs)}\n\n` +
      `${DIV}\n` +
      `_Start any duel with *${p}pvp @player*. New here? Read *${p}guide pvp*._`

    return reply(msg)
  },
}
