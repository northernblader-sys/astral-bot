/**
 * Sung Jin-Woo - The Shadow Monarch
 * Grade: SS+ | Floor: 78
 * Solo Leveling
 */

export const sung_jinwoo = {
  id: 'sung_jinwoo',
  name: 'Sung Jin-Woo',
  floor: 78,
  grade: 'SS+',
  emoji: '🖤',
  image: null,
  hp: 48000,
  maxHp: 48000,
  atk: 2400,
  def: 1100,
  exp: 24000,
  gold: 17000,
  type: 'shadow',
  weakTo: ['holy'],
  resistTo: ['physical', 'shadow', 'ice', 'poison'],

  personality: 'quiet-dangerous-rising',
  voice: 'Speaks little. Acts completely. The silence before his strike is deliberate.',

  lore: `He started at the bottom of every ranking system the hunter world had. E-Rank. The weakest. He survived things that should have killed him and came out of each one changed, the System pushing him further, faster, higher.

The Shadow Monarch\'s power is the command of shadows. He extracts the shadows of defeated enemies and keeps them as soldiers. He walks with an invisible army. Every fighter he has killed in every dungeon is with him now, compressed into darkness.

The Ruler\'s Authority lets him telekinetically throw anything made of magical energy. His shadow soldiers cannot be counted. His personal combat ability, separate from the army, would put him at the top of the S-Rank hunter list on its own.

He did not start as the strongest. He became it. That distinction matters more than the result.`,

  entrance: [
    'He walks into the room alone.',
    'He looks like he always has. Quiet. Almost ordinary.',
    '"Is this the floor they mentioned." He says it flat.',
    'Shadows move behind him. Not his shadow. Shadows that belong to people who no longer need them.',
    '"Let\'s go." His eyes flash violet. The Shadow Army is present.',
  ],

  phases: {
    75: [
      '"Shadow Exchange." He shifts through the shadows.',
      '"I have done this before. Every strong floor, every strong enemy."',
      '"You are not the hardest thing I have fought." A pause. "Not yet."',
    ],
    50: [
      '"Sovereign: Shadow Army." He calls more.',
      'The shadows behind him thicken.',
      '"Every opponent I have extracted is here now. You are fighting all of them."',
    ],
    25: [
      '"Tenebris." The final form of the Shadow Monarch begins to surface.',
      'The violet in his eyes goes full black.',
      '"I am going to end this now."',
    ],
  },

  attacks: [
    'Ruler\'s Authority Throw',
    'Shadow Army Surge',
    'Dagger Flurry',
    'Shadow Exchange Strike',
    'Sovereign\'s Wrath',
  ],

  attackNarratives: {
    'Ruler\'s Authority Throw': [
      'He raises one hand.',
      'Everything in the room made of magic and intent lurches toward you.',
      'The Ruler\'s Authority gathers it and throws it.',
      'Your own buffed energy becomes the projectile.',
      'Impact. The paradox of being hit by your own power lands differently.',
    ],
    'Shadow Army Surge': [
      'The shadows on the walls peel off.',
      'Shadow soldiers. Dozens. They do not speak. They do not hesitate.',
      'They move through the room at speed and each one hits like a trained hunter.',
      'You fight them and find more behind them.',
      'He watches from behind the surge, waiting for the opening it creates.',
    ],
    'Dagger Flurry': [
      'He closes the gap between you and the daggers are already moving.',
      'A flurry of precise cuts to every unguarded angle.',
      'His movement pattern is optimized from thousands of dungeon fights.',
      'Each dagger hits a joint, a gap in armor, a momentary opening.',
      'The accumulation of small precise hits adds up to something significant.',
    ],
    'Shadow Exchange Strike': [
      'He switches places with one of his shadow soldiers.',
      'The soldier was in front of you. He is now in front of you.',
      'The switch happens faster than the eye tracks.',
      'He is inside your guard and the strike follows immediately.',
      '"Shadow Exchange." He steps back out.',
    ],
    'Sovereign\'s Wrath': [
      '"Arise." He says it quietly.',
      'Every shadow in the room raises.',
      'The concentrated authority of the Shadow Monarch compresses into one pulse.',
      'The pulse hits everything.',
      'You take the full weight of every soul he has ever extracted, directed at once.',
    ],
  },

  dodgeLines: [
    '"Fast." He recalibrates.',
    '"Good evasion." He adjusts.',
    '"You moved before I expected." He notes it.',
    '"Nice speed." The shadows reposition.',
  ],

  hitLines: [
    '"Good hit." He takes it.',
    '"Strong." He does not retreat.',
    '"You hit the Shadow Monarch." He continues fighting.',
    '"That one I felt." He acknowledges it.',
  ],

  tauntLines: [
    '"I have cleared dungeons that erased everyone else in the party. Yours is number what, eight hundred?"',
    '"The System made me survive everything before you. Think about your position."',
    '"My shadow army does not tire. Do you?"',
    '"E-Rank to this. What is your excuse?"',
    '"Every strong opponent I have cleared is standing behind me. Visually you are outnumbered."',
  ],

  victoryLines: [
    '"Good fight." He turns and walks into a shadow.',
    '"Train more." He is gone before it echoes.',
    '"You are strong. Not yet." He disappears.',
    '"Come back. I will be waiting in the shadows." He means this literally.',
  ],

  defeatLines: [
    'He goes still.',
    '"The Shadow Monarch falls." He says it.',
    '"This has happened before. In the memories of the previous monarchs."',
    '"The System... did not account for you." He sits on the floor.',
    '"You fought like you knew what the dungeon system was." He looks at you. "Maybe you do."',
  ],

  special: {
    name: 'Shadow Army Extraction',
    desc: 'Each time Jin-Woo defeats the player in combat (player HP reaches 0 and they are revived by game mechanics, or if the fight is part of a series), he gains a Shadow Soldier token. During the fight: every 3 turns, one Shadow Soldier is summoned to assist for 2 turns, adding +15% of Jin-Woo\'s ATK as bonus damage on each of his attacks while active. Up to 3 soldiers can be active simultaneously.',
    trigger: [
      { type: 'turn_interval', value: 3, key: 'shadowSummon' },
    ],
    engineNote: `Track bossState.activeSoldiers (default 0, max 3) and bossState.soldierTurns = {} (maps soldier index to remaining turns). Every 3 turns: if activeSoldiers < 3, increment activeSoldiers, add to soldierTurns. Each turn: for each active soldier, add Math.floor(enemy.baseAtk * 0.15) to total enemy damage. Decrement soldierTurns for each soldier; remove when 0. Show summon and departure lines.`,
    narrativeLines: [
      '"Arise." A shadow soldier joins the fight.',
      'The soldier moves alongside Jin-Woo without a word.',
      'Another soldier emerges from the dark.',
      'One shadow soldier falls silent and dissipates.',
    ],
  },

  playerHitLines: [
    '"Good hit." He is already moving.',
    '"That reached me." He continues.',
    '"Strong." He acknowledges it.',
    '"You hit the Shadow Monarch." He takes it and comes back.',
  ],

  playerSkillLines: [
    '"A real technique." He watches.',
    '"Strong skill." The shadows react.',
    '"Good output." He adjusts.',
    '"Your technique is real." He notes it.',
  ],

  drops: [
    'shadow_monarch_fragment',
    'rulers_authority_stone',
    'shadow_soldier_core',
    'system_log_rune',
    'arise_sigil',
  ],
}
