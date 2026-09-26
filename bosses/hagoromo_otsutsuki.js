/**
 * Hagoromo Otsutsuki - Sage of Six Paths
 * Grade: SSS | Floor: 87
 * Naruto
 */

export const hagoromo_otsutsuki = {
  id: 'hagoromo_otsutsuki',
  name: 'Hagoromo Otsutsuki (Sage of Six Paths)',
  floor: 87,
  grade: 'SSS',
  emoji: '☯️',
  image: null,
  hp: 80000,
  maxHp: 80000,
  atk: 3600,
  def: 4000,
  exp: 43000,
  gold: 29000,
  type: 'divine',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'poison', 'void'],

  personality: 'ancient-wise-absolute',
  voice: 'Deliberate and deep. Every sentence carries the weight of millennia.',

  lore: `He was the son of Kaguya and the first human to master chakra on his own terms. He split the Ten-Tails into nine tailed beasts. He created ninjutsu and the entire tradition of jutsu. He became the Sage of Six Paths.

The Six Paths give him Yin Release, Yang Release, and their combination: Six Paths Yin-Yang. He carries Truth-Seeking Balls: orbs of black matter that nullify all ninjutsu they touch. They float behind him in a ring and intercept techniques automatically.

He is not malicious. He is not violent by nature. He fights because he has chosen to engage with you as a test of what the world has produced. He finds this necessary. He is not certain you will pass.

His chakra is the source of all chakra. Fighting him is fighting the origin.`,

  entrance: [
    'The room fills with a presence before a form.',
    'He materializes slowly, as if arriving from a great distance.',
    '"I have watched this world for a long time." His voice is everywhere.',
    '"You have come to test the Sage of Six Paths." He opens his eyes.',
    '"Very well. I accept." The Truth-Seeking Balls orbit him. "Begin."',
  ],

  phases: {
    75: [
      '"Six Paths chakra: fully active." The aura brightens.',
      '"I have been evaluating you. You have proven yourself worth my full attention."',
      '"Truth-Seeking Balls: activated to intercept."',
    ],
    50: [
      '"Yin-Yang Release." He combines both paths.',
      '"This is the foundation of all jutsu. Watch closely."',
      '"You are fighting the concept of ninjutsu itself."',
    ],
    25: [
      '"Six Paths: Yang Tensei." He reaches for his last reserves.',
      '"I have given life and taken it in equal measure. Let us see which applies here."',
      '"Come. This is the final lesson."',
    ],
  },

  attacks: [
    'Truth-Seeking Ball Lance',
    'Six Paths Chibaku Tensei',
    'Yin-Yang Disruption',
    'Six Paths Senjutsu Strike',
    'Yang Pulse',
  ],

  attackNarratives: {
    'Truth-Seeking Ball Lance': [
      'He extends one finger.',
      'A Truth-Seeking Ball launches from its orbit.',
      'It is black matter. It nullifies ninjutsu on contact.',
      'Your technique does not deflect it. The Ball absorbs the technique and continues.',
      'The impact is the full force of nullified chakra concentrated.',
    ],
    'Six Paths Chibaku Tensei': [
      'He raises one hand and a black sphere rises from his palm.',
      'The gravitational pull it generates is immediate and vast.',
      'The dungeon floor rises toward it. The walls reach.',
      'You are included in the pull and you have to fight it actively.',
      '"Chibaku Tensei created the moon. This is a smaller application."',
    ],
    'Yin-Yang Disruption': [
      'He releases both Yin and Yang simultaneously.',
      'The two forces collide around you.',
      'Creation and erasure occupying the same space.',
      'Your body is caught between being unmade and being violently remade.',
      'The disruption tears through HP and applies a two-turn confusion effect.',
    ],
    'Six Paths Senjutsu Strike': [
      'He channels natural energy from every environment simultaneously.',
      'The sage chakra concentrates in his palm.',
      'The strike carries the weight of nature itself behind a human hand.',
      'It bypasses conventional defense because it targets the body\'s own chakra.',
      'You take it and feel it in every point where chakra moves through you.',
    ],
    'Yang Pulse': [
      'Yang release: life force, vitality, creation.',
      'He releases it outward as a pulse.',
      'The pulse does not deal HP damage to you.',
      'It drains your MP by forcing your chakra system to overload with foreign energy.',
      '"Yang energy given incorrectly can be its own weapon." He explains this calmly.',
    ],
  },

  dodgeLines: [
    '"Good evasion. You are faster than most who reach this floor."',
    '"You moved with real skill." He acknowledges it.',
    '"The Six Eyes would have tracked that. Mine are different." He notes the distinction.',
    '"Well done. Continue."',
  ],

  hitLines: [
    '"You struck the Sage of Six Paths." He is not angry.',
    '"Your chakra output is genuine. I recognize the quality."',
    '"A real hit. You have earned this fight."',
    '"Strong." He says it simply.',
  ],

  tauntLines: [
    '"All chakra returns to the source. This fight is simply that process, accelerated."',
    '"I watched your ancestors take their first steps with chakra. I am not threatened by your technique."',
    '"The Truth-Seeking Balls nullify ninjutsu. What else do you have?"',
    '"You are strong. Whether you are strong enough is what this test determines."',
    '"There is no shame in falling to the Sage of Six Paths."',
  ],

  victoryLines: [
    '"You fought with real strength." He bows slightly.',
    '"The world has produced something worthwhile in you. That is encouraging."',
    '"Come back when you are ready. This test is always available."',
    '"Rest. You have earned it."',
  ],

  defeatLines: [
    '"Remarkable." He says it with genuine weight.',
    '"The Sage of Six Paths is surpassed." He touches the ground.',
    '"The world has grown beyond me. That is what I always hoped for."',
    '"You carry a power that has gone past the origin." He closes his eyes.',
    '"This is not failure. This is completion."',
  ],

  special: {
    name: 'Truth-Seeking Ball Screen',
    desc: 'Three Truth-Seeking Balls orbit Hagoromo at all times. Each ball automatically intercepts one skill-based attack per fight (not basic attacks), nullifying it to 0 damage. When all three are spent, he is vulnerable to skill damage normally. Players can "waste" balls by using cheap MP skills.',
    trigger: [
      { type: 'on_skill_attack', key: 'truthSeekingIntercept', maxUses: 3 },
    ],
    engineNote: `Track bossState.truthSeekingBalls (default 3). On each player skill attack that would deal damage > 0: if truthSeekingBalls > 0, nullify to 0, decrement truthSeekingBalls, show intercept line. If balls = 0, skill damage applies normally. Basic attacks always apply normally (balls do not intercept basic attacks). Show ball count each time one is spent.`,
    narrativeLines: [
      'A Truth-Seeking Ball interposes and nullifies your technique.',
      '"Ninjutsu nullified." One ball is spent.',
      'The ball absorbs your skill and dissipates. Two remain.',
      '"No more Truth-Seeking Balls." He is fully open now.',
    ],
  },

  playerHitLines: [
    '"Real power." He accepts the hit.',
    '"Your chakra output impresses." He means this.',
    '"That strike carried genuine weight."',
    '"You hit the Sage of Six Paths. That is not nothing."',
  ],

  playerSkillLines: [
    '"A technique based on the foundation I built. Well executed."',
    '"Strong skill. The Truth-Seeking Ball will decide."',
    '"Good form. Your training shows."',
    '"A real technique. I watch it with interest."',
  ],

  drops: [
    'truth_seeking_ball_shard',
    'six_paths_chakra_crystal',
    'yin_yang_fragment',
    'senjutsu_sage_dust',
    'ten_tails_remnant',
  ],
}
