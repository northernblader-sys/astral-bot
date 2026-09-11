/**
 * Celestia - The Scale of Heaven
 * Grade: SSS | Floor: 100 (Centurion's Dungeon master)
 * Original boss. Third of the five tower masters, the midpoint of the ladder.
 *
 * PEAK ABILITY (Verdict of the Scales):
 *   Celestia does not brawl. She judges. On a fixed countdown she raises the
 *   golden scales, gives one turn of warning, and then delivers a Verdict: a
 *   single blow measured as a large fraction of the player's own maximum life,
 *   not her attack stat. It grows heavier with each phase. The one defence is
 *   to DEFEND on the verdict turn, which halves the sentence. Stronger than
 *   Kikaru: the punish scales off YOUR health so gear cannot outgrow it, and
 *   ignoring the tell ends runs outright.
 */

export const celestia = {
  id: 'celestia',
  name: 'Celestia',
  floor: 100,
  grade: 'SSS',
  emoji: '⚖️',
  image: 'https://i.ibb.co/Q72CV4w4/Celestia.jpg',

  statOverride: { hp: 46000, def: 1500, atk: 3600 },
  hp: 46000,
  maxHp: 46000,
  atk: 3600,
  def: 1500,
  exp: 40000,
  gold: 30000,
  type: 'holy',
  weakTo: [],
  resistTo: [],

  personality: 'cold-absolute-impartial',
  voice: 'Measured and final, like a sentence read aloud. She never raises her voice because she has never once doubted the verdict.',

  lore: `The Centurion's Dungeon was built to test worth, and Celestia is the last measure of it. She sits above the hundredth floor with the golden scales, and she does not fight so much as weigh.

She feels no cruelty and no mercy, because both would tilt the scales, and the scales must be true. A climber is not her enemy. A climber is a quantity to be measured, and the Verdict is simply the number the scales return.

The only thing she respects is a soul that knows the sentence is coming and stands ready to bear it. Those she weighs a little more gently, not out of kindness, but because a climber who reads the scales has already proven the thing she is measuring for.`,

  entrance: [
    'She does not look up as you enter. She is adjusting the golden scales, and they must be exactly true.',
    '"You have come to be measured. Good. That is the only thing that happens on this floor."',
    '"I am Celestia. I hold the scales above the Centurion\'s hundredth. I am not your enemy. I am your judgment."',
    'The scales settle. One pan holds a feather. The other, slowly, begins to hold you.',
    '"When the scales are raised, a Verdict follows. Bear it, or be found wanting. Begin."',
  ],

  phases: {
    75: [
      '"You strike well. It is noted." She does not flinch. "But blows are not the measure here. The Verdict is."',
      '"The scales grow heavier now. See that you are ready when they fall."',
    ],
    50: [
      '"Half measured, and still standing when the scales fall." A pause that is almost approval. "Rare."',
      '"But I weigh you more heavily now. The next Verdict will not be so kind."',
    ],
    25: [
      'She lifts the scales fully, and the golden pans blaze with the weight of them.',
      '"This is the final measure. The heaviest Verdict I hold. Bear this, and the scales will name you worthy."',
    ],
  },

  attacks: [
    'Measured Strike',
    'Feather and Weight',
    'Golden Sentence',
    'Impartial Cut',
    'Reckoning',
  ],

  attackNarratives: {
    'Measured Strike': [
      'She lays a blow across you with the exactness of a scale coming to rest.',
      'It is precisely as hard as it needs to be and no harder.',
      '"Measured. Recorded."',
    ],
    'Feather and Weight': [
      'One hand light as a feather, the other heavy as a mountain.',
      'You cannot tell which is coming until it has already arrived.',
      '"The scales know. You do not."',
    ],
    'Golden Sentence': [
      'Light gathers along the beam of the scales and falls as a single line.',
      'It reads across you like a sentence being written.',
      '"So it is weighed. So it is written."',
    ],
    'Impartial Cut': [
      'No anger in it, no mercy. Just the cut the scales called for.',
      'She has already moved on to the next measure before you feel this one.',
      '"Nothing personal. Only true."',
    ],
    'Reckoning': [
      'The pans slam level and the reckoning comes due all at once.',
      'This is not an attack. It is an accounting.',
      '"The tally stands. Pay it."',
    ],
  },

  dodgeLines: [
    '"You slipped the measure. The scales note that too."',
    '"Evasion is a quantity. I am weighing it."',
    '"You read the fall and stepped clear. Worthy."',
    '"Not everything can be measured on a still target. Noted."',
  ],

  hitLines: [
    '"A true blow. It is added to your account."',
    '"You struck between Verdicts. Correct timing. Recorded."',
    '"The scales felt that. So did I."',
    '"Weighed and found sharp. Continue."',
  ],

  tauntLines: [
    '"You cannot out-hit a Verdict. It is not measured against your blade."',
    '"The scales weigh your life itself. No armor you wear tips them."',
    '"When they rise, you have one breath to ready yourself. Waste it and be found wanting."',
    '"I do not tire. I do not err. I only weigh, and weigh, and weigh."',
    '"Bear the Verdict or do not. The scales are indifferent to which you choose."',
  ],

  victoryLines: [
    '"Found wanting." The scales tip against you with no satisfaction and no regret. "The measure is complete."',
    '"You did not read the scales in time. That, more than the blow, is what condemned you."',
    '"Return when you can bear the Verdict. Until then, the sentence stands."',
    '"You were not weak. You were merely unready for the weight. Learn its warning."',
  ],

  defeatLines: [
    'The golden scales come to rest perfectly level, and for the first time she looks at you directly.',
    '"You bore every Verdict. You read the scales and stood ready each time they fell." A long pause. "Balanced."',
    '"The measure is complete, and it names you worthy. That is not a thing I say often."',
    'She sets the scales aside and steps from the stair. "Pass. The weight above me is yours to carry now."',
  ],

  special: {
    name: 'Verdict of the Scales',
    desc: 'Every third turn Celestia raises the scales, warns you once, then delivers a Verdict measured as a large fraction of your MAXIMUM life rather than her attack stat: about 0.9x max HP at first, 1.15x by the second phase, 1.4x by the last. Defending on the verdict turn halves the sentence. Because it scales off your own health it cannot be out-geared, only anticipated. Stronger than Kikaru: misreading one tell can end a run.',
    engineNote: `Case 'celestia'. TURN_START: bossState.verdictClock=(verdictClock||0)+1; when verdictClock hits 2 of a 3-cycle emit narrativeLines[0] and set verdictPending=true; when it hits 3 set verdictDue=true and reset clock to 0. ENEMY_DEAL_DAMAGE: if verdictDue, compute frac by phase (0.90/1.15/1.40 using bossState.phase or hp thresholds), base=floor(player.maxHp*frac); if player.battleState.playerDefending base=floor(base*0.5) and narrativeLines[2] else narrativeLines[1]; set result.damage=base (pre-mitigation feeds calcMonsterDamage), clear verdictDue/verdictPending.`,
    narrativeLines: [
      '"The scales rise." Celestia lifts the golden pans, and a Verdict gathers to fall on the turn to come.',
      '"So you are weighed." The scales fall, and Heaven\'s full Verdict crashes down upon you.',
      '"You stood ready to be measured." You bow beneath the Verdict, and the scales tip, and half the weight passes you by.',
    ],
  },

  playerHitLines: [
    '"A blow struck true and added to the account."',
    '"You timed that between Verdicts. The scales approve."',
    '"Recorded. You are measuring me as I measure you."',
    '"That found its mark. Even I am weighed by something."',
  ],

  playerSkillLines: [
    '"A technique, weighed and found worthy."',
    '"You spend your art precisely. The scales note the discipline."',
    '"Even judgment can be cut, it seems. Recorded."',
    '"Skillfully done. It is added to your measure."',
  ],

  drops: [
    'celestia_scale_fragment',
    'verdict_shard',
    'halo_dust',
    'heavens_gavel_splinter',
    'weighed_soul_crystal',
  ],
}
