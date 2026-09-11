/**
 * All For One - The Symbol of Evil
 * Grade: SS+ | Floor: 77
 * My Hero Academia
 */

export const all_for_one = {
  id: 'all_for_one',
  name: 'All For One',
  floor: 77,
  grade: 'SS+',
  emoji: '🕷️',
  image: null,
  hp: 50000,
  maxHp: 50000,
  atk: 2600,
  def: 1800,
  exp: 25000,
  gold: 17000,
  type: 'shadow',
  weakTo: [],
  resistTo: ['physical', 'magic', 'shadow', 'fire'],

  personality: 'elegant-predatory-patient',
  voice: 'Gracious and measured, like a host who has already decided the evening\'s outcome.',

  lore: `He stole the most powerful Quirk in the world and distributed fragments of it to build loyalty. He stole thousands of other Quirks over a century and keeps them in reserve. He has outlived the laws that named him a criminal. He has outlived most of the heroes who tried to stop him.

All For One lets him take any Quirk and use it himself. He combines Quirks in ways their original owners never imagined. Air Cannon plus Springlike Limbs plus Kinetic Booster produces a blast that reshapes architecture. He steals in combat. He adds what he takes to his arsenal mid-fight.

He is not in a hurry. He has never been in a hurry. Every hero who came to stop him was, in some sense, working within his timeline. He finds patience to be the most underrated virtue.

He came to this floor to see what you are made of. He will take what he likes.`,

  entrance: [
    '"Welcome." He gestures at the room.',
    '"You have made it further than most." He sounds like a host.',
    '"I am going to steal something from you today." He says it conversationally.',
    '"Not a threat. An observation." He extends one hand.',
    '"All For One: active." He steps forward.',
  ],

  phases: {
    75: [
      '"Interesting output." He begins taking notes internally.',
      '"I will start combining." He activates two Quirks simultaneously.',
      '"The combinations I have perfected over a century. Watch."',
    ],
    50: [
      '"Impact Recoil stored." He held onto your last big hit.',
      '"I am going to return it now. With interest." He releases it.',
      '"Stolen energy always hits harder going back."',
    ],
    25: [
      '"One last acquisition." He looks at you carefully.',
      '"There is something in you worth taking." He reaches.',
      '"Whether you survive the taking is the question."',
    ],
  },

  attacks: [
    'Air Cannon Combo',
    'Quirk Steal',
    'Impact Recoil Return',
    'Warp Gate Strike',
    'All For One: Overload',
  ],

  attackNarratives: {
    'Air Cannon Combo': [
      'Springlike Limbs extend and lock.',
      'Air cannon concentrates at the impact point.',
      'He releases the combined technique.',
      'The blast radius is the size of the room.',
      '"Air Cannon combined with Springlike Limbs. Effective combination."',
    ],
    'Quirk Steal': [
      'He reaches with one hand.',
      'The reach carries the magnetism of All For One.',
      'He is not reaching for you. He is reaching for your ability.',
      'Your primary skill becomes temporarily unavailable for 2 turns.',
      '"I have taken that. Temporarily. I will decide whether to return it."',
    ],
    'Impact Recoil Return': [
      '"I stored the recoil from your last significant hit." He releases it.',
      'The energy you spent hits you going the other direction.',
      'The magnitude is the same as what you dealt, no reduction.',
      '"Impact Recoil: stored. Now returned." He says it with satisfaction.',
      '"Your own power against you. A classic."',
    ],
    'Warp Gate Strike': [
      'A black portal opens beside you.',
      'His fist comes through it from the other side.',
      'The portal closed before you could react to its opening.',
      'The strike bypasses your guard completely because it originated behind you.',
      '"Warp Gate. One of the more useful acquisitions."',
    ],
    'All For One: Overload': [
      'He activates every stored Quirk simultaneously.',
      'The output is not elegant. It is total.',
      'Every combination fires at once toward your position.',
      'The room takes significant structural damage.',
      '"All For One at maximum." He watches it hit. "Every century of acquisitions."',
    ],
  },

  dodgeLines: [
    '"Good evasion." He files it.',
    '"You moved well." He adjusts.',
    '"Faster than projected." He recalibrates.',
    '"Nice dodge. Next one is already adjusted for."',
  ],

  hitLines: [
    '"Good hit." He stores the energy.',
    '"Strong output." He notes the technique.',
    '"That one I felt." He responds accordingly.',
    '"Real power. Worth taking." He means it.',
  ],

  tauntLines: [
    '"I have been doing this for a century. Your experience level is not an advantage."',
    '"Every Quirk I have stolen from heroes who thought the same thing you are thinking."',
    '"I do not fight to win. I fight to acquire. Win is a byproduct."',
    '"Everything you do teaches me something about you. Thank you."',
    '"The Symbol of Evil is patient. Are you?"',
  ],

  victoryLines: [
    '"As expected." He turns.',
    '"You have something worth cultivating. Do so." He departs.',
    '"Come back. I want to see what you become."',
    '"An interesting evening." He straightens his collar.',
  ],

  defeatLines: [
    '"A century." He says it.',
    '"And today." He pauses.',
    '"You found the limit." He sounds almost pleased.',
    '"The Symbol of Evil has a limit. I did not think I would see that today."',
    '"There is a reason I never said evil was unbeatable. I only said it was patient." He settles.',
  ],

  special: {
    name: 'Quirk Theft',
    desc: 'Once per fight (at 55% HP), All For One steals the last skill the player used. For the next 3 turns, that skill is unavailable to the player (they can use other skills or basic attacks). After 3 turns, the skill is returned. The stolen skill also adds +10% ATK to All For One while he holds it.',
    trigger: [
      { type: 'hp_threshold', value: 0.55, key: 'quirkTheft', oneShot: true },
    ],
    engineNote: `On trigger: record bossState.stolenSkillId = player.battleState.lastSkillUsed (track this as bossState.lastSkillUsed on each skill use). Set bossState.stolenUntilTurn = bossState.turn + 3. While stolenUntilTurn > current turn: if player tries to use stolenSkillId, block with "that skill has been stolen" message, do not consume MP. Add Math.floor(enemy.atk * 0.10) to enemy.atk while held. On expiry: restore skill, remove bonus, show return line.`,
    narrativeLines: [
      '"I am taking that." He reaches.',
      '"Your skill belongs to me for three turns."',
      '"Your skill has been returned." He considers whether he needed it.',
      '"All For One holds your technique. Fascinating."',
    ],
  },

  playerHitLines: [
    '"Good hit." He stores the energy.',
    '"Strong output. Noted."',
    '"That one carried real power."',
    '"Genuine technique. Worth studying."',
  ],

  playerSkillLines: [
    '"A Quirk-like ability. Interesting."',
    '"Strong skill. I am analyzing the mechanism."',
    '"Good output. That goes into my collection mentally."',
    '"An interesting technique. I will want that one."',
  ],

  drops: [
    'all_for_one_core',
    'quirk_vessel_shard',
    'recoil_impact_stone',
    'warp_gate_fragment',
    'century_rune',
  ],
}
