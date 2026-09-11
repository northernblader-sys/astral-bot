/**
 * <prefix>willow  (aliases: advise, advisor)
 *
 * Willow's unique ability (Season System Spec §13.3) — "Battle Advisor".
 * Purely informational: reads the current battle's enemy and the
 * player's available moves (basic attack, equipped skills, and — while
 * Willow herself is equipped — her own advisory read on the matchup),
 * grades each against the enemy via lib/effectiveness-engine.js, and
 * recommends the best one. Costs no turn, deals no damage, and does not
 * touch player.battleState at all — calling it repeatedly mid-fight is
 * completely free and safe.
 *
 * Unlike Mei/Urahara, Willow does NOT require being the equipped
 * character to provide value here: the effectiveness readout itself is
 * presented as "battlefield knowledge" available to any player currently
 * in a fight, exactly like checking a wiki mid-battle would be. Having
 * Willow specifically equipped instead adds one extra flavor line (her
 * own voiced read on the enemy), matching the spec's framing of her as
 * an advisor character rather than a damage dealer — the numbers
 * themselves aren't gated behind owning her.
 */
import { config } from '../config.js'
import { skills as allSkills } from '../lib/game-data.js'
import { buildMoveOptions, moveCategories } from '../lib/effectiveness-engine.js'
import { getEquippedSkills } from '../lib/skill-slots.js'

const TIER_BLURB = {
  'super-effective': 'a serious weak point — lean into this.',
  effective:         'solidly favorable.',
  neutral:           'nothing special either way.',
  resisted:          'the enemy shrugs a lot of this off.',
  weak:              'actively a bad idea right now.',
}

export default {
  name: 'willow',
  aliases: ['advise', 'advisor'],
  category: 'combat',
  description: `${config.prefix}willow — get a battle-effectiveness readout on your current enemy. Free to use, costs no turn.`,
  requiresPlayer: true,

  async run(ctx) {
    const { player } = ctx
    const p = config.prefix

    if (!player.inBattle || !player.battleState?.enemy) {
      return ctx.reply(`❌ *Not in battle.* Willow has nothing to advise on right now — use *${p}dungeon* to find an enemy first.`)
    }

    const enemy = player.battleState.enemy
    const hasWillow = player.equippedCharacter === 'willow'

    const equippedSkillIds = getEquippedSkills(player)
    const equippedSkillDefs = allSkills.filter((s) => equippedSkillIds.includes(s.id) && s.type === 'active')

    const options = buildMoveOptions(player, enemy, { skills: equippedSkillDefs })

    let out = `🦉 *${hasWillow ? "Willow leans in and studies" : "You size up"} ${enemy.name}...*\n\n`

    for (const opt of options.slice(0, 6)) {
      out += `${opt.emoji} *${opt.name}* _(${moveCategories[opt.category]?.label ?? opt.category})_ — ${opt.grade}x\n`
    }

    const best = options[0]
    if (best) {
      out += `\n💡 *Recommendation:* ${best.name} — ${TIER_BLURB[best.tier] ?? 'a reasonable pick.'}`
    }

    if (hasWillow) {
      out += `\n\n🌿 _"${willowFlavorLine(best?.tier)}"_ — Willow`
    }

    out += `\n\n_This is advisory only — it doesn't change your damage or cost a turn._`

    return ctx.reply(out)
  },
}

function willowFlavorLine(tier) {
  switch (tier) {
    case 'super-effective': return "There — right there. Hit it exactly like that."
    case 'effective':       return "Good instinct. That'll work."
    case 'weak':            return "Don't. You'll barely scratch it."
    case 'resisted':        return "It's braced for that one. Try something else."
    default:                return "Nothing stands out. Trust your gut on this one."
  }
}
