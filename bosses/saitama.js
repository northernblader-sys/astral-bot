/**
 * Saitama - The Caped Baldy
 * Grade: MYTHIC | Floor: 100
 * One Punch Man
 */

export const saitama = {
  id: 'saitama',
  name: 'Saitama',
  floor: 100,
  grade: 'MYTHIC',
  emoji: '🥊',
  image: null,
  hp: 1,
  maxHp: 1,
  atk: 99999,
  def: 99999,
  exp: 120000,
  gold: 80000,
  type: 'physical',
  weakTo: [],
  resistTo: ['fire', 'ice', 'shadow', 'holy', 'physical', 'magic', 'time', 'void'],

  personality: 'bored-absolute',
  voice: 'Flat, understated, perpetually disappointed. His deadpan delivery carries more threat than anyone else\'s war cry.',

  lore: `He trained for three years. One hundred push-ups, one hundred sit-ups, one hundred squats, a ten-kilometer run, every single day, no air conditioning in summer. He lost his hair and gained something he never asked for.

He can end anything with one punch. Any planet, any god, any concept given physical form. He has never once needed a second punch. The problem is that he has not felt a thing since. No excitement. No rush. Nothing.

He came to this floor on a whim. He saw a sign. He was bored. He is still bored. The question is whether you can do the impossible and hold his attention long enough to make him actually try.

Nobody has. But that was before you.`,

  entrance: [
    'A man in a yellow jumpsuit sits cross-legged in the center of the floor.',
    'He is reading a grocery flyer. He does not look up.',
    '"Oh. A fighter." He folds the flyer carefully. "Sure. Okay."',
    'He stands. He does not stretch. He does not shift his weight. He just stands.',
    '"I will try not to end it too fast. I say that every time." He sounds tired.',
  ],

  phases: {
    75: [
      '"Okay. You are actually hitting me. That is... hm."',
      'He tilts his head and looks at his hand.',
      '"I felt that one a little. Just a little." He sounds uncertain. Like he is not sure he is remembering correctly.',
    ],
    50: [
      '"All right. Now I am actually paying attention."',
      'He cracks his knuckles. The sound travels through the floor.',
      '"This is the most fun I have had in a while. Still not fun. But more than usual."',
    ],
    25: [
      'He goes very still.',
      '"Okay." He takes one slow breath.',
      '"Serious Series." He says it quietly. The air pressure in the room drops.',
    ],
  },

  attacks: [
    'Normal Punch',
    'Consecutive Normal Punches',
    'Air Pressure Wave',
    'Serious Punch',
    'Serious Table Flip',
  ],

  attackNarratives: {
    'Normal Punch': [
      'He throws a punch. Just a punch.',
      'The air in front of his fist compresses into a wall before the fist even arrives.',
      'The normal punch from a normal man would bruise. This one rearranges geography.',
      'You catch the edge of it and it still sends you the full length of the room.',
      '"Oh. You are still standing." He sounds mildly interested.',
    ],
    'Consecutive Normal Punches': [
      'He starts throwing punches at his normal speed.',
      'Normal speed is faster than sound.',
      'Each one hits a different angle, different height, different timing.',
      'The combination does not look like a technique. It is not. It is just him punching.',
      'You raise your arms and feel every single one through your guard.',
    ],
    'Air Pressure Wave': [
      'He swings his arm sideways without throwing a punch.',
      'The displacement of air from that motion hits you like a freight train.',
      'He did not touch you. The atmosphere he moved through touched you.',
      'You slam backward and the wall cracks where you hit it.',
      '"That was the wind off my arm. Sorry." He does not sound sorry.',
    ],
    'Serious Punch': [
      'He gets serious.',
      'The word "serious" does not cover what that means.',
      'His fist moves forward. The universe moves backward to get out of the way.',
      'The shockwave of it parts the air for a kilometer in every direction.',
      'You are not standing in front of it anymore. You are standing in its past.',
    ],
    'Serious Table Flip': [
      'He picks up a piece of the dungeon floor.',
      'He flips it.',
      'Casually. Like frustration at a bad meal.',
      'The debris field from one bored table flip rewrites the room.',
      '"This is the Serious Series." He says it flatly. "Of throwing a rock."',
    ],
  },

  dodgeLines: [
    '"You dodged." He sounds genuinely surprised.',
    '"Huh. Most people just get hit."',
    '"That was fast. I think." He squints. "I have not had to judge speed in a while."',
    'He watches where you moved and recalculates.',
  ],

  hitLines: [
    'He looks down at where you hit him.',
    '"...oh." A pause. "I felt that." Another pause. "That almost never happens."',
    'He touches the spot. His expression does not change but his eyes do.',
    '"You should not be able to do that." He sounds almost respectful.',
  ],

  tauntLines: [
    '"Are you trying hard? It looks like you are trying." He sounds like that is fine but not interesting.',
    '"Tell me when you are ready to do something special. I will wait."',
    '"I am not trying yet. Just so you know."',
    '"This is nice. Usually it is over before I have to use the second punch position."',
    '"You have about fifteen more turns before I get bored. Use them well."',
  ],

  victoryLines: [
    '"Oh." He stands over you. "It ended."',
    '"Was that everything? That was everything, was it not." He sighs.',
    'He starts walking away before you even finish falling.',
    '"Next time try the thing you were saving." He does not explain how he knew you were saving something.',
  ],

  defeatLines: [
    'He stares at you.',
    'He has never lost.',
    'He does not know what this feeling is yet.',
    '"...oh." His voice breaks slightly. "Oh. This is it. This is what it feels like."',
    'He sits down on the floor, slowly, and puts his face in his hands. His shoulders shake. He is laughing. He has not laughed in years.',
  ],

  special: {
    name: 'Invincible Boredom',
    desc: 'For the first 10 turns, all player damage is capped at 1 regardless of stats. Saitama is not trying. On turn 11 he gets serious and his atk doubles. Surviving 20 full turns counts as a "draw" win condition if the player is still alive.',
    trigger: [
      { type: 'turn_threshold', value: 11, key: 'getsSerious', oneShot: true },
      { type: 'turn_threshold', value: 20, key: 'drawCondition', oneShot: true },
    ],
    engineNote: `Track bossState.turn. For turns 1-10: cap all player damage at 1 before applying (after all calculations, set finalDmg = 1). On turn 11: set bossState.serious = true, double enemy.atk, show serious announcement. On turn 20: if player.hp > 0, trigger a special handleDraw() that awards half exp/gold and shows draw narrative. Saitama's HP should be set to a large number (999999) but his actual displayed HP does not move until turn 11. Alternative: keep hp = 1 and set bossState.phase = 'casual' where all damage is absorbed to 1.`,
    narrativeLines: [
      '"Turn ten. Now I try." He exhales.',
      '"Serious Series." The room pressure shifts.',
      '"You lasted twenty turns. Nobody lasts twenty turns." He nods at you.',
      '"Draw. You earned that." He walks away and the exit opens.',
    ],
  },

  playerHitLines: [
    '"...you are actually hitting me. Hm."',
    '"Good. More of that." His tone is flat but he is paying attention now.',
    '"That was a real hit. I noticed it." He sounds like this is significant.',
    '"Keep going. I want to see if you can get me to feel it." He means that.',
  ],

  playerSkillLines: [
    '"A technique. Okay. Let me watch."',
    '"That was good. Genuinely. That was a good move."',
    '"Nice form." Coming from him, this means something vast.',
    '"You trained for that. I can see it. Good."',
  ],

  drops: [
    'caped_baldy_glove',
    'one_punch_residue',
    'hero_association_badge',
    'serious_punch_echo_stone',
    'boredom_crystal',
  ],
}
