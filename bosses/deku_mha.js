/**
 * Izuku Midoriya - Deku, 100% OFA
 * Grade: SS | Floor: 68
 * My Hero Academia
 */

export const deku_mha = {
  id: 'deku_mha',
  name: 'Izuku Midoriya (Deku)',
  floor: 68,
  grade: 'SS',
  emoji: '💚',
  image: null,
  hp: 16000,
  maxHp: 16000,
  atk: 1200,
  def: 400,
  exp: 12000,
  gold: 8000,
  type: 'physical',
  weakTo: [],
  resistTo: ['physical', 'magic'],

  personality: 'determined-analytical-selfless',
  voice: 'Earnest and slightly breathless, every line sounds like someone who did the math and still chose the hard option.',

  lore: `He was born without a Quirk in a world where nearly everyone has one. He trained for ten months, inherited the most powerful Quirk in history, and proceeded to break every bone in his body learning how to use it. He learned from each break.

One For All contains the Quirk factors of eight previous users. He has access to all of them: Fa Jin (stored kinetic energy), Danger Sense (involuntary spider-sense), Blackwhip (extending black tendrils), Smokescreen, Float, Gear Shift (speed manipulation). And 100% of the original stockpiled power.

He fights by overclock and adapt. He reads the fight mid-movement and changes what he was going to do before he finishes doing it. He is always working out a new solution.

He has been told he cannot win this fight. He looked that up and checked whether it was actually true.`,

  entrance: [
    '"Okay." He exhales slowly.',
    '"One For All: 100%." He says it like a pre-race breath.',
    '"I am going to analyze your movements and find the optimal counter." He is already doing it.',
    '"Please fight seriously. I need real data."',
    'He moves. He is instantly very far away from where he started.',
  ],

  phases: {
    75: [
      '"Switching to Gear Shift." He accelerates.',
      '"Velocity calculation updated." He is faster now.',
      '"Blackwhip extending for reach coverage."',
    ],
    50: [
      '"Float: active." He lifts off the floor.',
      '"New axis of movement. Adjusting."',
      '"This changes the attack pattern calculations significantly."',
    ],
    25: [
      '"Everything." He breathes.',
      '"All Quirks: simultaneous. This is going to hurt both of us." He knows this.',
      '"But I am not stopping."',
    ],
  },

  attacks: [
    'Delaware Smash: Air Force',
    'Blackwhip Capture',
    'Danger Sense Counter',
    'Fa Jin Burst',
    'Full Cowl Combo',
  ],

  attackNarratives: {
    'Delaware Smash: Air Force': [
      'He flicks his fingers.',
      'The air pressure wave from the flick carries the force of One For All at full concentration.',
      'It is not a projectile. It is a column of compressed atmosphere.',
      'You get your arms up and the pressure travels through them.',
      '"Delaware Smash. Air Force version. Fingers, not fist." He notes the distinction.',
    ],
    'Blackwhip Capture': [
      'Black tendrils extend from his arm.',
      'They reach around obstacles, around dodges, around the geometry of the room.',
      'One finds your wrist.',
      'The grip of Blackwhip does not break through physical force alone.',
      'He pulls. You go where he chose.',
    ],
    'Danger Sense Counter': [
      'You attack.',
      'Before your attack reaches him, his body has already moved.',
      'Danger Sense is involuntary: his body interprets incoming threats and responds.',
      'He counters before you finish the attack because the counter was ready before the attack landed.',
      '"Danger Sense is automatic. I am still working on controlling it."',
    ],
    'Fa Jin Burst': [
      'He has been building kinetic energy since the fight started.',
      '"Fa Jin release." He discharges everything stored.',
      'The speed he achieves in the burst phase is above anything visible.',
      'Multiple strikes land in the time it takes to register the first one.',
      '"Fa Jin: stored kinetic energy released. Effective."',
    ],
    'Full Cowl Combo': [
      'One For All runs through his whole body at once.',
      'Every limb, every movement, all of it operating at full power simultaneously.',
      'The combination of Quirks running together produces an output that is more than their sum.',
      'He hits you with everything he has learned and everything that was inherited.',
      '"All eight users. This is what they built. Together." He catches his breath.',
    ],
  },

  dodgeLines: [
    '"Good evasion! I am updating my movement prediction model!"',
    '"You moved faster than my Danger Sense range. Noted."',
    '"Nice dodge. I will factor that in."',
    '"Fast. My Quirk analysis was slightly off." He corrects it.',
  ],

  hitLines: [
    '"OW." He straightens.',
    '"Strong hit. Damage output higher than projected."',
    '"You broke through my guard. That means I was wrong about your power level."',
    '"Real power." He gets back up. He always gets back up.',
  ],

  tauntLines: [
    '"I am not going to give up. I want you to know that ahead of time."',
    '"I analyzed your movement. I have a plan. I might be wrong. I have backup plans."',
    '"Every person I have fought taught me something. You are teaching me things."',
    '"I do not have the most power on this floor. I have the most persistence."',
    '"Come on. Give me everything. I need to know if I am enough."',
  ],

  victoryLines: [
    '"You are strong. Really strong." He offers a hand.',
    '"I need to train more. You showed me exactly where."',
    '"Thank you for the fight. Seriously." He means it.',
    '"Get up when you are ready. The world needs people who can take a loss and come back."',
  ],

  defeatLines: [
    '"You won." He blinks.',
    '"My analysis was... incomplete." He looks at his notes (he has notes).',
    '"You have something I have not learned how to counter yet."',
    '"I will train for this specifically." He is already planning.',
    '"Good fight. The best kind." He grins through the bruises.',
  ],

  special: {
    name: 'Gear Shift',
    desc: 'Every 4 turns, Deku activates Gear Shift for 2 turns: his attack speed doubles, meaning he attacks twice on his turn (both at full ATK). The player can break this by dealing damage exceeding 15% of his max HP in one hit, which disrupts the Gear Shift (he over-accelerates and crashes).',
    trigger: [
      { type: 'turn_interval', value: 4, key: 'gearShift', duration: 2 },
    ],
    engineNote: `Track bossState.gearShiftActive (bool) and bossState.gearShiftTurns (int). Every 4 turns: set gearShiftActive = true, gearShiftTurns = 2, show announcement. While gearShiftActive: on enemy attack phase, calculate and apply enemy damage twice (two separate calcMonsterDamage calls, each vs player). Decrement gearShiftTurns each turn. When 0: gearShiftActive = false. If player deals >= enemy.maxHp * 0.15 in one hit while gearShiftActive: immediately set gearShiftActive = false, show crash line.`,
    narrativeLines: [
      '"Gear Shift." He accelerates.',
      'He attacks twice. The second one comes before you register the first.',
      '"You disrupted the Gear Shift. Strong hit." He stumbles briefly.',
      '"Gear Shift expires." He returns to base speed.',
    ],
  },

  playerHitLines: [
    '"You hit me! Good power!"',
    '"Strong. Higher than my estimates."',
    '"That broke through. Good technique."',
    '"Real power. I am adjusting my projections."',
  ],

  playerSkillLines: [
    '"A Quirk? No. A skill. Interesting!"',
    '"Good technique! Strong output!"',
    '"Nice skill! Analyzing pattern now!"',
    '"Strong! How did you get that?"',
  ],

  drops: [
    'one_for_all_fragment',
    'blackwhip_tendril',
    'fa_jin_kinetic_shard',
    'plus_ultra_rune',
    'symbol_of_peace_badge',
  ],
}
