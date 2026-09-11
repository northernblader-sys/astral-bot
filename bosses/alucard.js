/**
 * Alucard - The Crimson Fucker, Hellsing's Monster
 * Grade: SSS | Floor: 89
 * Hellsing
 */

export const alucard = {
  id: 'alucard',
  name: 'Alucard',
  floor: 89,
  grade: 'SSS',
  emoji: '🩸',
  image: null,
  hp: 88000,
  maxHp: 88000,
  atk: 3900,
  def: 1500,
  exp: 46000,
  gold: 31000,
  type: 'shadow',
  weakTo: ['holy', 'fire'],
  resistTo: ['physical', 'shadow', 'ice', 'poison'],

  personality: 'bloodthirsty-theatrical-ancient',
  voice: 'Decadent and eager, the voice of something that has been bored for four hundred years and finally found a reason to exist.',

  lore: `He was Vlad the Impaler before he became something else. They executed him for dark arts and he came back different: a vampire of a kind the world had not seen, a being that consumed the souls of his enemies and could manifest them in combat.

Hellsing keeps him on a leash made of ancient seals. Level 0 is the release of all of them. When Level 0 is triggered, the millions of souls he has consumed over centuries pour out of him. He becomes an army. He becomes the ocean. He is no longer contained in a single body because he has never actually been in just one body.

He is not invincible. Silver, holy water, blessed weapons, the right kind of faith: these can hurt him. But hurting him is not the same as killing him, and killing him requires making sure there is nothing left that remembers being alive.

He has been waiting for a real fight for a century. His smile gets wider the more damage he takes.`,

  entrance: [
    'Darkness pools at one end of the room and he steps out of it already grinning.',
    '"Oh my." His red coat spreads behind him. "A genuine one."',
    '"Do you know how long I have been waiting?" He tilts his hat.',
    '"Since Vlad died at the stake I have been looking for something like this."',
    '"Come then." He opens his arms wide. "Hurt me. I want to see if you can."',
  ],

  phases: {
    75: [
      '"Yes. YES. That is what I am talking about." He laughs.',
      '"Restriction Level Two released." The shadows behind him multiply.',
      '"Let me stop pulling punches. You deserve the real thing."',
    ],
    50: [
      '"You are not boring." He sounds genuinely surprised.',
      '"Level One released." The room fills with the sound of souls.',
      '"The Undead King fights now. Not the butler."',
    ],
    25: [
      '"Level Zero." He says it quietly.',
      '"Release all restrictions." The seals on his body dissolve.',
      '"Every soul I have ever consumed. Every life. Every death." They pour out.',
    ],
  },

  attacks: [
    'Jackal Barrage',
    'Shadow Dissolution',
    'Schrodinger Shift',
    'Soul Army Surge',
    'Crimson Drain',
  ],

  attackNarratives: {
    'Jackal Barrage': [
      'The Jackal appears in his hand.',
      'The Casull in the other.',
      'He fires with both at the same time, from the hip, still smiling.',
      'Anti-Midian bullets that explode on contact with life force.',
      'The barrage covers every angle you had to move to and three you did not think of.',
    ],
    'Shadow Dissolution': [
      'He dissolves into his own shadow.',
      'Not hides. Dissolves.',
      'The shadow spreads across the entire floor.',
      'It reaches up and touches you from below.',
      'He reassembles around the contact point and strikes from directly inside your guard.',
    ],
    'Schrodinger Shift': [
      'You hit him.',
      'The hit passes through.',
      'He exists simultaneously in a state of being hit and not being hit.',
      'Schrodinger\'s quantum existence means the outcome the universe chooses is the one that favors him.',
      '"I exist because I think I exist." He taps his temple. "Inconvenient for you."',
    ],
    'Soul Army Surge': [
      'The millions of devoured souls pour out of him.',
      'They do not think or speak. They move toward you.',
      'The mass of them is not individual attacks. It is a tide.',
      'You fight through them and each one that lands is a fragment of consumed life hitting you.',
      'He watches from behind the wave, still smiling.',
    ],
    'Crimson Drain': [
      'He moves faster than a man should be able to move.',
      'His fangs find your neck region before you process his approach.',
      'The drain is immediate and takes both HP and stamina.',
      'He heals for the amount he takes.',
      '"You taste like effort." He releases. "I mean that as a compliment."',
    ],
  },

  dodgeLines: [
    '"Fast! Very fast! Excellent!"',
    '"You moved! Yes! Again!"',
    '"Good evasion! I am genuinely delighted!"',
    '"You evaded a vampire. That requires real skill. I salute you."',
  ],

  hitLines: [
    '"AHAHAHAHA! Yes!"',
    '"More! Do not stop!"',
    '"That one bled me! I love this!"',
    '"You actually hurt the monster!" He spreads his arms. "DO IT AGAIN."',
  ],

  tauntLines: [
    '"I have been killing things since before your great-grandparents were born. Try harder."',
    '"The more you hurt me the happier I get. Think about your strategy."',
    '"I am the bird of Hermes. I ate my own wings to make me tame. I am not tame."',
    '"Four hundred years of fighting. You are the best in a while. DO NOT STOP."',
    '"Kill me. If you can. Please. I am so bored when I cannot be killed."',
  ],

  victoryLines: [
    '"Disappointing." He vanishes back into shadow.',
    '"You almost had it. Almost." He tips his hat.',
    '"Come back stronger. I will still be here." He always will be.',
    '"A good effort from a worthy opponent." He sounds sad it is over.',
  ],

  defeatLines: [
    '"Finally." He says it with relief.',
    '"FINALLY." He says it louder, still grinning.',
    '"Four hundred years." He falls backward. "Four hundred years for a fight like this."',
    '"Well done. Well DONE." He is still smiling as he hits the ground.',
    'The souls release. All of them. They rise from him and fill the room and depart.',
  ],

  special: {
    name: 'Undying Thirst',
    desc: 'Alucard heals for 20% of all damage he deals. Additionally, once per fight when he would drop to 0 HP, he rises at 15% max HP (Level 0 release). After rising, his ATK increases by 30% permanently. Holy-type damage bypasses the rise (if the player has holy attacks).',
    trigger: [
      { type: 'on_deal_damage', key: 'vampiricHeal', pct: 0.20 },
      { type: 'on_lethal', key: 'levelZeroRise', oneShot: true },
    ],
    engineNote: `After each enemy attack that deals damage: heal enemy.hp by Math.floor(dmgDealt * 0.20), capped at maxHp, show drain-heal line. For level zero: if enemy.hp would reach 0 and !bossState.levelZeroUsed: set enemy.hp = Math.floor(enemy.maxHp * 0.15), bossState.levelZeroUsed = true, enemy.atk = Math.floor(enemy.atk * 1.30), show Level Zero narrative. Exception: if player has a holy damage modifier flag in battleState (set by holy skills), skip the rise.`,
    narrativeLines: [
      'The vampiric drain heals him.',
      'He feeds on the damage he deals.',
      '"LEVEL ZERO. ALL RESTRICTIONS RELEASED." He rises.',
      'The souls pour out of him. He is no longer one thing.',
    ],
  },

  playerHitLines: [
    '"YES! MORE!"',
    '"You drew blood! Glorious!"',
    '"Strong! You are actually strong!" He means this as the highest praise.',
    '"That one hurt! THAT ONE HURT! Do it again!"',
  ],

  playerSkillLines: [
    '"A technique! Show me everything!"',
    '"Strong skill! I love opponents with real techniques!"',
    '"EXCELLENT! More of that!"',
    '"You are fighting the monster properly! I have not been this entertained in decades!"',
  ],

  drops: [
    'jackal_casing',
    'soul_vial',
    'crimson_restraint_seal',
    'level_zero_fragment',
    'bird_of_hermes_crest',
  ],
}
