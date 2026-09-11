/**
 * Gojo Satoru - The Honored One
 * Grade: SSS | Floor: 92
 * Jujutsu Kaisen
 */

export const gojo_satoru = {
  id: 'gojo_satoru',
  name: 'Gojo Satoru',
  floor: 92,
  grade: 'SSS',
  emoji: '🔵',
  image: null,
  hp: 95000,
  maxHp: 95000,
  atk: 3600,
  def: 9999,
  exp: 52000,
  gold: 35000,
  type: 'void',
  weakTo: [],
  resistTo: ['physical', 'magic', 'fire', 'ice', 'shadow', 'holy', 'void'],

  personality: 'playful-invincible-narcissistic',
  voice: 'Confident to the point of comedy. He talks during the fight the way other people talk during lunch.',

  lore: `He was born with the Six Eyes. One in a hundred years. Maybe one in a generation. His Limitless cursed technique generates an automatic barrier at the boundary layer of his skin, infinitely weakening anything that approaches him. Infinity is not a defense. Infinity is the absence of the concept of contact with Gojo.

He is also aware of this and he finds it incredibly funny.

He teaches at a school because he decided to. He fights because he wants to. He is the most powerful jujutsu sorcerer alive because nobody has been able to change that fact.

When he takes off the blindfold and the Six Eyes open, he processes the entire room at once. Every angle of attack, every trajectory, every vector of harm, all of it nullified before it arrives.

He probably knows you are going to try to fight him. He is already looking forward to it.`,

  entrance: [
    'He strolls into the room with his hands in his pockets.',
    '"Yo." He waves.',
    'He is wearing a blindfold.',
    '"Strong aura. Better than the last twenty." He sounds genuinely pleased.',
    '"Okay." He reaches up and takes the blindfold off. The Six Eyes open. "Let\'s go."',
  ],

  phases: {
    75: [
      '"Okay now I am actually impressed." He grins.',
      '"Nobody gets to seventy-five percent on me. Usually."',
      '"Blue." He touches the air and attraction curves toward his hand.',
    ],
    50: [
      '"Half? Really?" He laughs. "I need to stop underestimating people."',
      '"Red." The repulsion field activates. The room bends.',
      '"Let me try the actual thing now."',
    ],
    25: [
      '"Hollow Purple." He crosses his hands.',
      '"This is it. This is what I look like when I mean it."',
      '"Thanks for making me do this. Not many people get to see Hollow Purple."',
    ],
  },

  attacks: [
    'Infinity Barrier',
    'Blue Attraction',
    'Red Repulsion',
    'Hollow Purple',
    'Infinite Void Domain',
  ],

  attackNarratives: {
    'Infinity Barrier': [
      'Your attack approaches Gojo.',
      'It slows. Not from resistance. From mathematics.',
      'The gap between your attack and him halves, then halves again, then halves again.',
      'It never arrives. Infinity intervenes.',
      '"Did that feel weird for you? It always looks weird from here."',
    ],
    'Blue Attraction': [
      '"Blue." He flicks one hand.',
      'Space around you bends inward toward a point.',
      'Your body is pulled toward it with increasing urgency.',
      'The center of Blue\'s gravity is not Gojo. It is nothing. A hungry nothing.',
      'You pull yourself clear and land badly.',
    ],
    'Red Repulsion': [
      '"Red." His other hand.',
      'Inverted Blue. Everything pushes away from the point.',
      'The shockwave of repulsion hits you at the speed of a car accident.',
      'The wall you hit afterward hits you back.',
      '"Red is fun. I like Red." He watches you reassemble.',
    ],
    'Hollow Purple': [
      'He crosses his hands in front of him.',
      '"Hollow Purple."',
      'Blue and Red collide at the midpoint and produce a third thing: erasure.',
      'The violet beam removes a column of space from the room.',
      'Anything in that column ceases. Not breaks. Not burns. Ceases.',
    ],
    'Infinite Void Domain': [
      'His eyes reach further than eyes should.',
      '"Unlimited Void." He exhales.',
      'The domain expands and everything inside it receives infinite information simultaneously.',
      'Your mind processes everything and nothing in the same moment.',
      'The overload of complete perception shuts your body down temporarily.',
    ],
  },

  dodgeLines: [
    '"Whoa. You moved. That is not supposed to help against Infinity but respect."',
    '"Nice dodge. Did not do anything. Still nice."',
    '"I appreciate the effort." He means this sincerely.',
    '"You are quick. Against someone other than me, that matters a lot."',
  ],

  hitLines: [
    '"Wait." He blinks.',
    '"You got through Infinity. How." He squints at you.',
    '"That actually reached me." He touches the spot. "Interesting. Very interesting."',
    '"Okay, new threat assessment. You are something special."',
  ],

  tauntLines: [
    '"You cannot hit me. Not because I am fast. Because Infinity says no."',
    '"I am not even trying to dodge. Your attacks just never arrive."',
    '"This is not arrogance. This is physics. I know the difference."',
    '"You are doing great, honestly. You just cannot win. Not against Infinity."',
    '"Do you want to hear about how the Six Eyes work? I have time. Technically you do not but still."',
  ],

  victoryLines: [
    '"Good fight! No, seriously, that was genuinely good."',
    '"You touched Infinity. That is rare."',
    '"Train more. Come back. I want to see what you become." He puts the blindfold back on.',
    '"You made me use Hollow Purple. First time in a while." He sounds satisfied.',
  ],

  defeatLines: [
    'The Six Eyes close.',
    '"Huh." He sits down.',
    '"Infinity was broken." He sounds like he is going to spend a year thinking about this.',
    '"I have no idea how you did that and I find that incredible and infuriating."',
    '"Tell me how you did that. Seriously. I need to know." He sounds completely genuine.',
  ],

  domainLines: [
    '"Unlimited Void." The domain opens.',
    'Every fact about reality floods into you simultaneously.',
    'You process everything at once. Your mind shuts itself off to protect itself.',
  ],

  domainStrainLines: [
    '"Maintaining the domain." He exhales once.',
    '"How are you still upright in here?" He sounds impressed.',
  ],

  domainBreakoutLine: '"You broke out of Unlimited Void." He laughs. "INCREDIBLE."',

  special: {
    name: 'Infinity Auto-Defense',
    desc: 'Gojo\'s Infinity automatically reduces all incoming physical and magic damage by 75%. To break through, the player must either: (A) land 5 consecutive hits without missing (any miss resets the count) which temporarily disrupts Infinity for 2 turns, dealing full damage; or (B) use a skill 3 times in a row (consecutive turns) to "overload" the barrier for 1 turn of full damage.',
    trigger: [
      { type: 'passive', key: 'infinityBarrier' },
      { type: 'on_player_streak', key: 'infinityBreak' },
    ],
    engineNote: `By default: multiply finalDmg by 0.25 (75% reduction). Track bossState.hitStreak (consecutive hits without miss) and bossState.skillStreak (consecutive skill-use turns). On miss: reset hitStreak to 0. On hit: increment hitStreak. When hitStreak >= 5: set bossState.infinityBroken = true, bossState.infinityBrokenTurns = 2, reset hitStreak to 0, show breakthrough narrative. When infinityBroken: apply full damage, decrement infinityBrokenTurns each turn, restore barrier when 0. Same logic for skillStreak >= 3 but only 1 turn of break.`,
    narrativeLines: [
      'Infinity weakens. You found the gap.',
      'Your consecutive pressure broke through the automatic defense.',
      '"Infinity is down. Two turns. Hit me hard."',
      '"Infinity restored." He pushes your offense back.',
    ],
  },

  playerHitLines: [
    '"You got through! NICE!"',
    '"That landed. Full credit."',
    '"How?! No, really, how?!" He sounds delighted.',
    '"You broke Infinity. That deserves acknowledgment."',
  ],

  playerSkillLines: [
    '"That technique has real output. Noted."',
    '"A real skill! Good form!"',
    '"Nice. You are chipping at the barrier."',
    '"Strong output. Keep going."',
  ],

  drops: [
    'six_eyes_fragment',
    'infinity_shard',
    'hollow_purple_residue',
    'blue_attraction_stone',
    'gojo_blindfold_cloth',
  ],
}
