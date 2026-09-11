/**
 * Vegeta - Prince of all Saiyans, Ultra Ego
 * Grade: SS | Floor: 70
 * Dragon Ball Super
 */

export const vegeta = {
  id: 'vegeta',
  name: 'Vegeta',
  floor: 70,
  grade: 'SS',
  emoji: '👑',
  image: null,
  hp: 18000,
  maxHp: 18000,
  atk: 1350,
  def: 480,
  exp: 14000,
  gold: 9000,
  type: 'physical',
  weakTo: [],
  resistTo: ['physical', 'fire'],

  personality: 'proud-elite-relentless',
  voice: 'Cold and imperious. Compliments are delivered as insults and insults as facts.',

  lore: `He is the prince of a dead planet and he has never once stopped acting like it. Every fight is a matter of pride. Every loss is a debt. He trains not to surpass himself but to surpass the one person in the universe he cannot stand being second to.

Ultra Ego is the power of the gods of destruction distilled through pure Saiyan stubbornness. It works differently from Ultra Instinct. It does not evade damage. It welcomes it. Every blow landed on Vegeta fuels Ultra Ego. He becomes stronger the harder you hit him. His pride will not let him go down. His Saiyan blood turns injury into power.

He did not come to this floor for fun. He came because word reached him that something worthwhile was here. He has standards. You are about to meet them.`,

  entrance: [
    '"So. You are the one they are talking about." He crosses his arms.',
    'He does not introduce himself. His name is not something you need explained.',
    '"I will give you one warning. What you are about to face is the Prince of all Saiyans."',
    '"Do not embarrass me by dying in the first exchange."',
    'He drops into his stance and the air pressure doubles. "Defend yourself."',
  ],

  phases: {
    75: [
      '"Better. You are actually better than I thought." The words taste like vinegar.',
      'His aura shifts. Darker. More destructive.',
      '"Ultra Ego. This is what a true warrior looks like." He powers up.',
    ],
    50: [
      '"You are landing hits. Fine. Hit me harder." He does not say it as a dare.',
      'His ki destabilizes and goes purple-black at the edges.',
      '"Every strike you land makes me stronger. You should have thought about that."',
    ],
    25: [
      '"This is what you wanted? A desperate Saiyan Prince?" He laughs once, sharp.',
      '"Fine. I will show you what desperation looks like for someone like me."',
      '"FINAL FLASH." He begins charging.',
    ],
  },

  attacks: [
    'Galick Gun',
    'Final Flash',
    'Big Bang Attack',
    'Ultra Ego Surge',
    'Hakai Burst',
  ],

  attackNarratives: {
    'Galick Gun': [
      'He extends both hands sideways and brings them together.',
      '"GALICK GUN!" The purple beam is narrow and exact and very fast.',
      'It punches through the room and the echo follows thirty seconds later.',
      'You throw yourself clear and the aftermath singes your shoulder.',
      '"Hmph. You moved. Barely."',
    ],
    'Final Flash': [
      'He spreads both arms wide and the energy gathers between his palms.',
      'The wind before the attack pushes you backward across the floor.',
      '"FINAL FLASH!" It is not a beam. It is a statement.',
      'The gold-white column of energy rewrites the physics of the corridor.',
      'You survive by being outside its direct path. That is the only way to survive.',
    ],
    'Big Bang Attack': [
      'He extends one arm and a sphere of white energy forms at his fingertip.',
      'It is quiet, perfectly round, utterly focused.',
      '"Big Bang Attack."',
      'The sphere launches and expands on contact to the size of the room.',
      'The explosion is deafening. The force is worse.',
    ],
    'Ultra Ego Surge': [
      'He takes the damage you just dealt and channels it.',
      'His ki darkens and thickens around his fists.',
      'He comes at you faster and hits harder than he did ten seconds ago.',
      'That last hit you landed on him? He is returning it with interest.',
      '"Destruction amplification. Thank you for fueling it."',
    ],
    'Hakai Burst': [
      'His eyes go flat and grey.',
      '"Hakai." He extends one hand.',
      'The energy of erasure radiates from his palm.',
      'It does not strike you. It touches everything your defense is made of.',
      'Your buffs, your guard, your momentum: all of it struggles against the god of destruction\'s power.',
    ],
  },

  dodgeLines: [
    '"Hmph. Lucky."',
    '"Do not mistake speed for skill."',
    'He recalculates. Silent.',
    '"You moved. Good. Do it again if you can."',
  ],

  hitLines: [
    '"Is that it?" He takes the hit without moving.',
    '"More." He says it as a command.',
    '"Hit me harder. I mean it."',
    '"Good. Now I am paying attention."',
  ],

  tauntLines: [
    '"You fight like someone who has never met a Saiyan before. This is educational for you."',
    '"Hit me harder! I cannot grow on this!"',
    '"Is this everything you have? Disappointing. Show me more."',
    '"A Prince of Saiyans does not lose to something like you." He means it completely.',
    '"More power! Do not hold back! I refuse to win like this!"',
  ],

  victoryLines: [
    '"Sufficient." He turns away.',
    '"You fought with pride. Acceptable."',
    '"Train. Come back. You are not ready yet but you have the right instincts."',
    '"A Saiyan respects a real fight. That was real enough."',
  ],

  defeatLines: [
    'He does not fall cleanly.',
    'He goes to one knee and stays there for a long moment.',
    '"You... beat a Saiyan Prince." He says it factually.',
    '"Kakarot." He says the name once, quietly. Then: "Hm."',
    '"I will surpass this. That is my promise." He collapses. It sounds like a vow.',
  ],

  special: {
    name: 'Ultra Ego: Pain Amplification',
    desc: 'Vegeta gains +5% ATK permanently each time the player successfully lands a hit on him (not a miss, not a blocked hit - a real damage hit). This stacks without limit. Maximum cap of +80% total bonus. Players who attack less frequently take less total damage but deal less per turn.',
    trigger: [
      { type: 'on_player_hit', key: 'ultraEgoStack', stackable: true },
    ],
    engineNote: `Track bossState.ultraEgoStacks (default 0). Each time the player deals damage > 0, increment ultraEgoStacks by 1. Set enemy.atk = enemy.baseAtk * (1 + Math.min(bossState.ultraEgoStacks * 0.05, 0.80)). Cache baseAtk in bossState.baseAtk at fight start. Show stack announcement every 3 stacks. Players who defend often will slow Vegeta's growth but also deal less damage.`,
    narrativeLines: [
      '"That hit made me stronger. Thank you."',
      '"The pain fuels Ultra Ego. Keep going." He almost sounds grateful.',
      '"Three stacks. You are your own worst problem right now."',
      '"Ultra Ego loves damage. I love Ultra Ego. You see the issue."',
    ],
  },

  playerHitLines: [
    '"Good hit. More."',
    '"There. That is the power level I was looking for."',
    '"Stronger than I gave you credit for."',
    '"That one I felt. That was real." He sounds like he approves.',
  ],

  playerSkillLines: [
    '"Technique. Fine. Show me what it does."',
    '"Skilled. Not as skilled as a Saiyan but skilled."',
    '"Noted. Use it again."',
    '"A true technique. I will not underestimate you again."',
  ],

  drops: [
    'saiyan_pride_shard',
    'galick_gun_residue',
    'ultra_ego_fragment',
    'royal_saiyan_crest',
    'hakai_touch_stone',
  ],
}
