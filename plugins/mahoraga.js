/**
 * mahoraga.js — info surface for the Divine General, Mahoraga (八握剣異戒神将魔虚羅).
 *
 * Mahoraga is not a separately-summoned command: it is the Ten Shadows'
 * final shikigami and rides along automatically whenever Megumi Fushiguro is
 * equipped (see lib/megumi.js hasMahoraga / recordMahoragaExposure). This
 * command explains how its adaptation works and, if the viewer is mid-battle
 * with Megumi equipped, reports what the Wheel has mastered so far.
 *
 * Usage: <prefix>mahoraga
 */
import { config } from '../config.js'
import { hasMegumi, sendMahoragaImage } from '../lib/character-abilities.js'

export default {
  name: 'mahoraga',
  aliases: ['wheel', 'divinegeneral'],
  category: 'combat',
  requiresPlayer: true,
  description: `${config.prefix}mahoraga — the Divine General; adapts to and nullifies any move used against Megumi`,

  async run(ctx) {
    const p = config.prefix
    const player = ctx.player
    const equipped = hasMegumi(player)

    let status = ''
    const bs = player?.battleState
    const wheel = bs?.megumi?.wheel
    if (equipped && wheel) {
      const mastered = Object.keys(wheel.mastered ?? {})
      if (mastered.length) {
        status += `\n🛞 *Mastered this battle:* ${mastered.length} move${mastered.length === 1 ? '' : 's'} — now dealing *0* damage.`
      }
      if (wheel.lastKey && wheel.streak > 0 && !(wheel.mastered ?? {})[wheel.lastKey]) {
        status += `\n🔄 *Adapting:* ${wheel.streak}/3 toward the current move.`
      }
    }

    const body =
      `🛞 *MAHORAGA — THE DIVINE GENERAL*\n` +
      `_八握剣異戒神将魔虚羅_\n` +
      `─────────────\n` +
      `The eight-handled sword divine general. Megumi's ultimate shikigami — ` +
      `no sorcerer in history has ever tamed it.\n\n` +
      `⚙️ *The Wheel of Adaptation*\n` +
      `Any single move used against Megumi is studied. Used *3 times in a row*, ` +
      `the Wheel spins, Mahoraga *masters* it, and that exact move deals *0 damage* ` +
      `from then on — until a *different* move is used (each move adapts on its own count; ` +
      `a mastered move stays mastered).\n\n` +
      `⚔️ While summoned, Mahoraga also cleaves the enemy each turn with its blade ` +
      `_(true damage)_.\n\n` +
      `🔒 *Only works while Megumi Fushiguro is equipped.*` +
      (equipped ? `\n\n✅ _Megumi is equipped — Mahoraga stands ready._${status}`
                : `\n\n⚠️ _You do not have Megumi equipped. Equip him with_ *${p}character equip megumi*_._`)

    await sendMahoragaImage(ctx, body)
  },
}
