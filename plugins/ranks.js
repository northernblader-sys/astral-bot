/**
 * ranks.js — the FULL attainable ladder, highest rank down to Beginner.
 *
 * `.rank list` only ever showed the ordinary Lv 1–100 ranks (E-Rank →
 * Shadow Sovereign) and the post-cap prestige titles were invisible in any
 * table. This command exists so a player can see every rank they can
 * actually achieve in one screen:
 *
 *   Ⓛ🅜 LM  →  Ⓖ🅜 GM  →  Ⓐ🅜 Am  →  Ⓟⓡⓞ Pro   (post-Lv 200 prestige titles)
 *   🌌 Shadow Sovereign → … → 🔰 E-Rank Hunter   (Lv 1–100, Beginner at the foot)
 *
 * The ladder data lives in lib/rank-engine.js's formatFullRankLadder() so the
 * ordering (prestige on top, E-Rank at the bottom) is computed in exactly one
 * place and can never drift from the engines that actually grant each rung.
 *
 * Usage:
 *   <prefix>ranks      — every rank a player can achieve, GM/LM to Beginner
 */
import { config } from '../config.js'
import { formatFullRankLadder } from '../lib/rank-engine.js'

export default {
  name:           'ranks',
  aliases:        ['ranklist', 'allranks', 'rankslist'],
  category:       'account',
  requiresPlayer: false,
  description:    'Every rank a player can achieve — from GM/LM down to Beginner',

  async run(ctx) {
    const p = config.prefix
    return ctx.reply(
      `🏆 *ALL HUNTER RANKS — highest to Beginner*\n` +
      `─────────────────────\n` +
      `${formatFullRankLadder()}\n\n` +
      `_Top four are the post-Lv 200 prestige titles — they climb on prestige XP ` +
      `banked from kills once you hit your level cap, replacing ordinary levelling._\n` +
      `_The rest rise automatically with level — check your own with *${p}rank*._`,
    )
  },
}
