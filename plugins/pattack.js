/**
 * pattack.js — short top-level aliases for the dungeon-party combat actions
 * that live in plugins/party.js (registered as `.dparty`). Typing
 * `.dparty attack` every turn in a fast co-op fight is painful, so these give
 * one-word shortcuts:
 *
 *   .pattack / .pa   → .dparty attack
 *   .pdefend / .pd   → .dparty defend
 *   .pflee           → .dparty flee
 *   .pcv / .pcinder  → .dparty cinderverdict   (Wither)
 *   .pk / .pkurama   → .dparty kurama          (Naruto)
 *   .php             → .dparty hollowpurple    (Gojo)
 *   .puv / .pvoid    → .dparty unlimitedvoid   (Gojo)
 *
 * Each just delegates to the exported handler in party.js — no combat logic is
 * duplicated here. Kept as its own plugin (rather than more aliases on party.js)
 * so `.pattack` maps straight to the attack handler instead of the party
 * router, which would otherwise read ctx.args[0] as a subcommand.
 */
import { config } from '../config.js'
import { battleAttack, battleDefend, battleFlee, battleCinderVerdict, battleKurama, battleHollowPurple, battleUnlimitedVoid } from './party.js'

export default {
  name: 'pattack',
  aliases: ['pa', 'pdefend', 'pd', 'pflee', 'pcv', 'pcinder', 'pk', 'pkurama', 'php', 'phollowpurple', 'puv', 'pvoid', 'punlimitedvoid'],
  category: 'party',
  requiresPlayer: true,
  description: 'Shortcuts for dungeon-party combat — see .dparty',

  async run(ctx) {
    switch (ctx.cmd?.toLowerCase()) {
      case 'pdefend':
      case 'pd':
        return battleDefend(ctx)
      case 'pflee':
        return battleFlee(ctx)
      case 'pcv':
      case 'pcinder':
        return battleCinderVerdict(ctx)
      case 'pk':
      case 'pkurama':
        return battleKurama(ctx)
      case 'php':
      case 'phollowpurple':
        return battleHollowPurple(ctx)
      case 'puv':
      case 'pvoid':
      case 'punlimitedvoid':
        return battleUnlimitedVoid(ctx)
      case 'pattack':
      case 'pa':
      default:
        return battleAttack(ctx)
    }
  },
}
