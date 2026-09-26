/** Serializable combat rules. No network, database writes, or hidden timers.
 * Call completeTurn exactly once for each completed generic battle turn.
 * Presentation and settlement are deliberately owned by the combat adapters.
 */
export const ART = Object.freeze({
  scarlett: 'https://i.ibb.co/tw7xbfZS/scarlett.jpg',
  ronova: 'https://i.ibb.co/XZ5v7YMv/ronova-info.jpg',
  ronovaSpin: 'https://i.ibb.co/4RTwC4Mf/ronova-spin.jpg',
  ronovaBeam: 'https://i.ibb.co/NnxSsZLw/ronova-unleashing-detrsuction-beam.jpg',
  endworld1: 'https://i.ibb.co/Ng8n0SnV/endworld-1.jpg',
  endworld2: 'https://i.ibb.co/BVBDJ9XR/endworld-2.jpg',
  vortex: 'https://i.ibb.co/qL3Zfn0D/download.jpg',
  invisibleSword: 'https://i.ibb.co/QFjwHHVV/download-1.jpg',
  coordinate: 'https://i.ibb.co/2Y36tJh5/The-Coordinate.jpg',
  maiden: 'https://media3.giphy.com/media/avV3LYHmL8bvsQ21aI/giphy.gif',
})

export const BANNERS = Object.freeze({
  scarlett: { cost: 1, cap: 250, deadZone: 240, guarantee: 241 },
  ronova: { cost: 1, cap: 300, deadZone: 260, guarantee: 261 },
  sword_maiden: { cost: 1, cap: 300, deadZone: 299, guarantee: 300 },
})
export function spinChance(id, spin) {
  const banner = BANNERS[id]
  if (!banner || !Number.isInteger(spin) || spin < 1 || spin > banner.cap) return 0
  return spin > banner.deadZone ? 1 : 0
}

export const WITCHES = Object.freeze(['alexa', 'witch_of_envy', 'echidna', 'circe', 'reverie', 'scarlett', 'ronova'])
export function witchImmune(target, source) {
  return target?.equippedCharacter === 'ronova' && WITCHES.includes(source?.equippedCharacter ?? source)
}
export function state(entity) {
  if (!entity?.battleState) throw new Error('An active battle state is required')
  return entity.battleState.witchHeroes ??= {
    completedTurns: 0, reflections: 0, charge: 0, endworld: null,
  }
}

/** Direct landed attacks only: never call for DOT, recoil or reflected damage.
 * Damage is already resolved by the caller. Never pass it through mitigation again.
 */
export function reflectAttack(defender, attacker, damage, { random = Math.random, indirect = false } = {}) {
  if (indirect || !(damage > 0) || defender?.equippedCharacter !== 'scarlett' ||
      !defender.battleState || !attacker || attacker.hp <= 0 || witchImmune(attacker, defender)) return null
  const s = state(defender)
  if (s.reflections >= 4 || random() >= 0.35) return null
  s.reflections++
  attacker.hp = Math.max(0, attacker.hp - damage)
  return { damage: 0, reflected: damage, message: `🌹 *My Desire* — “Not me, darling. You.”\nThe blow turns back: *${damage}* damage. (${s.reflections}/4)` }
}

export const SWORD_SKILLS = Object.freeze({
  sever: { name: 'Sever', charge: 1, mp: 0.25 },
  wrongfoot: { name: 'Wrong Foot', charge: 2, mp: 0.30 },
  return: { name: 'Return Stroke', charge: 2, mp: 0.35 },
  transcended: { name: 'Transcended Sword', charge: 3, mp: 0.45 },
  coordinate: { name: 'The Coordinate', charge: 6, mp: 0.80 },
})
export function swordStatus(player) {
  const charge = player?.battleState?.witchHeroes?.charge ?? 0
  const lines = ['⚔️ *ABSOLUTE SWORD* · Charge builds by 1 after each completed turn (max 6). A .sword technique spends charge and MP, uses your turn, and does not recharge itself.']
  lines.push(...Object.entries(SWORD_SKILLS).map(([key, skill]) => {
    const filled = Math.min(charge, skill.charge)
    return `${skill.name}: ${'▰'.repeat(filled)}${'▱'.repeat(skill.charge - filled)} ${filled}/${skill.charge} charge · ${Math.ceil(Math.max(1, player.maxMp ?? 1) * skill.mp)} MP · .sword ${key}`
  }))
  return lines.join('\n')
}

/** Charge Sword Maiden once when the holder completes their own duel turn. */
export function chargeSwordTurn(player) {
  if (player?.equippedCharacter !== 'sword_maiden' || !player?.battleState) return 0
  const s = state(player)
  s.charge = Math.min(6, Math.max(0, Number(s.charge) || 0) + 1)
  return s.charge
}
function activeError(player, character) {
  if (!player?.inBattle || !player.battleState || player.hp <= 0) return 'You need an active battle.'
  if (player.equippedCharacter !== character) return `Equip ${character.replaceAll('_', ' ')} first.`
  if (player.battleState.type === 'pvp' && !player.battleState.myTurn) return 'It is not your turn.'
  return null
}
export function activateEndworld(player) {
  const error = activeError(player, 'ronova')
  if (error) return { ok: false, message: error }
  const s = state(player)
  if (s.completedTurns < 5) return { ok: false, message: 'The End of the World requires five completed battle turns.' }
  if (s.endworld) return { ok: false, message: 'The End of the World can only be used once per battle.' }
  s.endworld = { phase: 1, remaining: 3, justActivated: true, finished: false }
  return { ok: true, message: '☠️ *The End of the World*\n“You keep mistaking this for a fight.”' }
}

/** Absolute physical damage: no accuracy roll, interception or mitigation.
 * Endgame techniques do not grant additional wins: adapters settle once.
 */
export function absoluteSlash(attacker, target, multiplier = 1) {
  const attack = Math.max(1, Number(attacker.stats?.str ?? attacker.atk ?? 1))
  const damage = Math.max(1, Math.ceil(attack * 4 * multiplier), Math.ceil((target.maxHp ?? target.hp) / 3 * multiplier))
  target.hp = Math.max(0, target.hp - damage)
  return damage
}
export function useSword(player, target, move) {
  const error = activeError(player, 'sword_maiden')
  if (error) return { ok: false, message: error }
  const skill = SWORD_SKILLS[move]
  if (!skill || !target || target.hp <= 0) return { ok: false, message: 'Choose a sword technique against a living opponent.' }
  const s = state(player)
  const cost = Math.ceil(Math.max(1, player.maxMp ?? 1) * skill.mp)
  if (s.charge < skill.charge) return { ok: false, message: `${skill.name} needs ${skill.charge} charge and ${cost} MP. Charge builds by 1 after a completed non-sword turn; sword techniques do not recharge themselves. Check .ss.` }
  if (player.mp < cost) return { ok: false, message: `${skill.name} needs ${cost} MP.` }
  if (move === 'transcended' && s.transcended) return { ok: false, message: 'Your invisible sword is already drawn. Defend to release it.' }
  if (move === 'return' && s.returnStroke) return { ok: false, message: 'Return Stroke is already waiting.' }
  if (move === 'coordinate' && s.coordinateUsed) return { ok: false, message: 'The Coordinate has already been used this battle.' }
  player.mp -= cost
  s.charge -= skill.charge
  if (move === 'transcended') {
    s.transcended = true
    return { ok: true, message: 'She draws an invisible sword. Nothing happens.\n“Go on. Tell me I missed.”\n*Defend for one turn to release Transcended Sword.*' }
  }
  if (move === 'return') {
    s.returnStroke = true
    return { ok: true, message: 'The invisible edge catches the next strike with a single, quiet ring. She leaves the opening waiting. “Go on. Give me something worth answering.”' }
  }
  if (move === 'coordinate') {
    s.coordinateUsed = true
    // Each strike must be resolved separately by the adapter, allowing a
    // genuine intervening revival without inventing extra deaths or rewards.
    return { ok: true, cinematic: 'coordinate', strikes: 3, message: '“Found you.”' }
  }
  if (move === 'sever') target.activeEffects = (target.activeEffects ?? []).filter(e => e.type !== 'shield')
  if (move === 'wrongfoot') {
    const bs = target.battleState ?? target
    bs.defending = false
    bs.playerDefending = false
    if (bs.witchHeroes) bs.witchHeroes.returnStroke = false
  }
  const combo = s.previousSword === 'wrongfoot' && move === 'sever'
  const damage = absoluteSlash(player, target, combo ? 1.5 : 1)
  s.previousSword = move
  return { ok: true, damage, message: combo
    ? `The two cuts arrive as one—the second finding the weakness the first taught her to hear. “That limp is getting louder.” *${damage}* damage.`
    : move === 'sever' ? `Her blade slips through the seam in the guard, clean as a line drawn in ink. “You trusted that shield too much.” *${damage}* damage.`
      : `A heel shifts half an inch. She is already there, cutting across the balance before it can return. “Wrong foot.” *${damage}* damage.` }
}
export function swordReaction(player, attacker, { defend = false, directAttack = false } = {}) {
  if (player?.equippedCharacter !== 'sword_maiden' || !player.battleState || player.hp <= 0 || !attacker || attacker.hp <= 0) return null
  const s = state(player)
  if (defend && s.transcended) {
    s.transcended = false
    const damage = absoluteSlash(player, attacker, 2)
    return { damage, message: `The cut arrives a turn after the sword. “Still think I missed?” *${damage}* damage.` }
  }
  if (directAttack && s.returnStroke) {
    s.returnStroke = false
    const damage = absoluteSlash(player, attacker, 1.5)
    return { damage, message: `Steel rings once. She laughs. “There you are.” *${damage}* damage.` }
  }
  return null
}

/** Advance one completed generic turn. turnId must be battle-local, monotonic
 * and identical for both duel participants. Replays/status commands are no-ops.
 */
export function completeTurn(fighters, turnId, { chargeSword = true } = {}) {
  if (!Number.isInteger(turnId) || turnId < 1) throw new Error('Invalid completed turn id')
  const events = []
  for (const player of fighters) {
    if (!player?.battleState) continue
    const s = state(player)
    if (turnId <= s.completedTurns) continue
    s.completedTurns = turnId
    if (chargeSword && player.equippedCharacter === 'sword_maiden') chargeSwordTurn(player)
    const end = s.endworld
    const target = fighters.find(f => f !== player)
    if (!end || end.finished || player.hp <= 0 || !target || target.hp <= 0) continue
    if (end.justActivated) { end.justActivated = false; continue }
    player.battleState.cinematicBackground = end.phase === 1 ? ART.endworld1 : ART.endworld2
    if (target.battleState) target.battleState.cinematicBackground = player.battleState.cinematicBackground
    end.remaining--
    events.push({ type: 'charge', phase: end.phase, remaining: end.remaining,
      text: `☠️ *THE END OF THE WORLD — ${end.remaining}/3 turns remain*\n${end.phase === 1 ? 'The horizon folds inward. There is less sky with every breath.' : 'Beyond the torn sky, the beam begins to descend.'}` })
    if (end.remaining > 0) continue
    if (end.phase === 1 && target.equippedCharacter === 'sword_maiden') {
      end.phase = 2
      end.remaining = 3
      player.battleState.cinematicBackground = ART.endworld2
      target.battleState.cinematicBackground = ART.endworld2
      events.push({ type: 'survive', text: 'She tilts her head. “Stay behind me.”\nHer blade cuts through the collapsing void, leaving one untouched space around her owner.' })
      continue
    }
    end.finished = true
    const maiden = target.equippedCharacter === 'sword_maiden'
    // The prepared invisible sword survives phase one; spending it on an
    // ordinary defensive release before the beam means it cannot save you.
    const counters = maiden && state(target).transcended
    if (counters) state(target).transcended = false
    const loser = counters ? player : target
    loser.hp = 0
    events.push({ type: end.phase === 2 && maiden ? 'clash' : 'execution',
      winner: counters ? target : player, loser, terminal: true,
      text: counters ? 'The invisible blade parts the destruction beam. Ronova falls. The sword remains.'
        : 'The destruction reaches its mark. No shield. No second life. 0 HP.' })
  }
  return events
}
