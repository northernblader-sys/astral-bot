/**
 * guild-war-engine.js — Intense, hard-fought Guild Wars combat engine.
 *
 * Supports:
 * - Formats:
 *     'standard'     — Full loadout, potions, abilities, totems enabled.
 *     'mcpvp'        — Hardcore Minecraft PvP style (No totems, healing restricted, pure attrition & timing).
 *     'nototem'      — Alias for mcpvp.
 *     'unrestricted' — Unhinged raw power (mythic aura, +25% burst, unlimited abilities).
 * - Match Types:
 *     '1v1' — Single champion showdown.
 *     '2v2' — Tag-team battle with Teammate Aura Synergy!
 *
 * Teammate Auras (Guild specific synergy procs in 2v2):
 *   astral_vanguard: "Vanguard Ironclad Wall" — Teammates share damage absorption (+20% DEF, blocks fatal execution once).
 *   shadow_covenant: "Shadow Critical Surge" — Shadow strike echoes bonus critical hits (+15% crit rate, bleed proc).
 *   gilded_order:    "Gilded Bastion Harmony" — Regens 15% MP/stamina each turn for teammates and shields against status debuffs.
 *   stormbreakers:   "Storm Shockwave Chain" — Chain lightning procs when teammates strike consecutively, staggering enemies.
 *   emberwake:       "Ember Blaze Amplification" — Ignites opponent with true fire burn damage on every physical or skill strike.
 */

import { calcPlayerDamage, applyDefense, calcPlayerHitChance } from './combat-engine.js'
import { getGuildDef } from './guild-repo.js'

export const WAR_FORMATS = {
  standard: {
    id: 'standard',
    name: 'Standard Clash',
    emoji: '⚔️',
    description: 'Full equipment, abilities, and standard recovery allowed.',
    totemAllowed: true,
    potionLimit: 3,
    critMultiplier: 1.5,
  },
  mcpvp: {
    id: 'mcpvp',
    name: 'MCPVP (Hardcore / No-Totem)',
    emoji: '🪓',
    description: 'Totems strictly FORBIDDEN! Capped healing, relentless attrition and combo pacing.',
    totemAllowed: false,
    potionLimit: 1,
    critMultiplier: 1.75,
  },
  nototem: {
    id: 'mcpvp',
    name: 'No-Totem Duel',
    emoji: '🚫',
    description: 'Death-defying totems disabled. Once your HP hits zero, you fall.',
    totemAllowed: false,
    potionLimit: 1,
    critMultiplier: 1.75,
  },
  unrestricted: {
    id: 'unrestricted',
    name: 'Unrestricted Anarchy',
    emoji: '💥',
    description: 'Mythic aura unleashed! +25% damage boost, no restrictions.',
    totemAllowed: true,
    potionLimit: 99,
    critMultiplier: 2.0,
    dmgBonusPct: 25,
  },
}

export const GUILD_AURAS = {
  astral_vanguard: {
    name: 'Vanguard Ironclad Wall',
    emoji: '🛡️',
    description: 'Teammates shield each other, cutting damage taken by 15% and bolstering DEF.',
    applyBonus: (stats, teammate) => {
      stats.def = Math.round((stats.def || 10) * 1.2)
    },
    onHitTaken: (dmg) => Math.max(1, Math.round(dmg * 0.85)),
  },
  shadow_covenant: {
    name: 'Shadow Critical Surge',
    emoji: '🌑',
    description: 'Veils allies in darkness, giving +20% Critical Hit chance and shadow puncture.',
    applyBonus: (stats, teammate) => {
      stats.agi = Math.round((stats.agi || 10) * 1.15)
    },
    critBonusPct: 20,
  },
  gilded_order: {
    name: 'Gilded Bastion Harmony',
    emoji: '⚜️',
    description: 'Replenishes 15% MP per turn and bolsters mental fortitude against disruptions.',
    turnMpRegenPct: 15,
    applyBonus: (stats, teammate) => {
      stats.int = Math.round((stats.int || 10) * 1.15)
    },
  },
  stormbreakers: {
    name: 'Storm Shockwave Chain',
    emoji: '⚡',
    description: 'Consecutive attacks unleash chain lightning, shocking the opposing frontline for bonus shock damage.',
    bonusShockPct: 18,
    applyBonus: (stats, teammate) => {
      stats.str = Math.round((stats.str || 10) * 1.1)
      stats.agi = Math.round((stats.agi || 10) * 1.1)
    },
  },
  emberwake: {
    name: 'Ember Blaze Amplification',
    emoji: '🔥',
    description: 'Attacks ignite the target with true fire burns dealing continuous scorch damage.',
    burnProc: true,
    applyBonus: (stats, teammate) => {
      stats.str = Math.round((stats.str || 10) * 1.2)
    },
  },
}

/**
 * Initializes a Guild War match state between two guilds.
 */
export function createWarSession({
  id,
  guildAId,
  guildBId,
  formatId = 'standard',
  matchType = '1v1',
  teamA = [], // Array of player objects
  teamB = [], // Array of player objects
}) {
  const format = WAR_FORMATS[formatId] || WAR_FORMATS.standard

  const buildCombatant = (p, guildId, teamKey) => ({
    id: p.id,
    name: p.name,
    guildId,
    teamKey,
    level: p.level || 1,
    maxHp: p.maxHp || 100,
    hp: p.hp ?? p.maxHp ?? 100,
    maxMp: p.maxMp || 50,
    mp: p.mp ?? p.maxMp ?? 50,
    stats: { ...(p.stats || { str: 10, agi: 10, int: 10, def: 10, lck: 10 }) },
    equipped: { ...(p.equipped || {}) },
    skills: [...(p.skills || [])],
    potionsUsed: 0,
    isDefending: false,
    alive: true,
  })

  const fightersA = teamA.map(p => buildCombatant(p, guildAId, 'teamA'))
  const fightersB = teamB.map(p => buildCombatant(p, guildBId, 'teamB'))

  // Apply Teammate Aura in 2v2
  if (matchType === '2v2') {
    applyTeamAuras(fightersA, guildAId)
    applyTeamAuras(fightersB, guildBId)
  }

  return {
    id,
    status: 'active',
    guildAId,
    guildBId,
    matchType,
    formatId: format.id,
    turnCount: 1,
    currentTeam: 'teamA',
    currentActorIndex: 0,
    teamA: fightersA,
    teamB: fightersB,
    combatLog: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Applies guild aura passive stat boosts across teammates when fighting in 2v2.
 */
export function applyTeamAuras(teamFighters, guildId) {
  if (teamFighters.length < 2) return
  const aura = GUILD_AURAS[guildId]
  if (!aura) return

  for (let i = 0; i < teamFighters.length; i++) {
    const fighter = teamFighters[i]
    const partner = teamFighters[1 - i]
    if (aura.applyBonus) {
      aura.applyBonus(fighter.stats, partner)
    }
  }
}

/**
 * Resolves one combat turn in a Guild War match.
 * action: 'attack' | 'skill' | 'defend' | 'drink'
 */
export function resolveWarTurn(session, actorId, action, targetId = null, extra = {}) {
  const isTeamA = session.teamA.some(f => f.id === actorId)
  const myTeam = isTeamA ? session.teamA : session.teamB
  const enemyTeam = isTeamA ? session.teamB : session.teamA
  const myGuildId = isTeamA ? session.guildAId : session.guildBId
  const enemyGuildId = isTeamA ? session.guildBId : session.guildAId

  const actor = myTeam.find(f => f.id === actorId)
  if (!actor || !actor.alive) {
    return { ok: false, msg: `❌ Combatant is incapacitated or not in this battle.` }
  }

  // Find target
  let target = enemyTeam.find(f => f.alive && (targetId ? f.id === targetId : true))
  if (!target) {
    target = enemyTeam.find(f => f.alive)
  }
  if (!target) {
    return { ok: false, msg: `❌ No valid opposing targets remain.` }
  }

  const format = WAR_FORMATS[session.formatId] || WAR_FORMATS.standard
  const aura = GUILD_AURAS[myGuildId]
  const enemyAura = GUILD_AURAS[enemyGuildId]
  const logEntries = []

  actor.isDefending = false

  // Turn MP Regen if Gilded Bastion
  if (session.matchType === '2v2' && aura?.turnMpRegenPct) {
    const regen = Math.round(actor.maxMp * (aura.turnMpRegenPct / 100))
    actor.mp = Math.min(actor.maxMp, actor.mp + regen)
  }

  if (action === 'defend') {
    actor.isDefending = true
    const mpGain = Math.round(actor.maxMp * 0.2)
    actor.mp = Math.min(actor.maxMp, actor.mp + mpGain)
    logEntries.push(`🛡️ *${actor.name}* takes a defensive stance (+${mpGain} MP, -50% incoming damage)!`)
  } else if (action === 'drink') {
    if (actor.potionsUsed >= format.potionLimit) {
      return { ok: false, msg: `❌ Potion limit reached for ${format.name} (Max ${format.potionLimit} allowed)!` }
    }
    actor.potionsUsed += 1
    const heal = Math.round(actor.maxHp * 0.4)
    actor.hp = Math.min(actor.maxHp, actor.hp + heal)
    logEntries.push(`🧪 *${actor.name}* drinks a recovery vial, restoring +${heal} HP! (${format.potionLimit - actor.potionsUsed} left)`)
  } else {
    // Attack / Skill strike
    const roll = calcPlayerDamage(actor, target)
    let baseDmg = typeof roll === 'object' && roll !== null ? (roll.rawDmg || 25) : (Number(roll) || 25)
    if (format.dmgBonusPct) {
      baseDmg = Math.round(baseDmg * (1 + format.dmgBonusPct / 100))
    }

    // Critical roll
    const baseCritChance = 10 + (actor.stats.lck || 0) * 0.2 + (session.matchType === '2v2' && aura?.critBonusPct ? aura.critBonusPct : 0)
    const isCrit = Math.random() * 100 < baseCritChance
    if (isCrit) {
      baseDmg = Math.round(baseDmg * format.critMultiplier)
    }

    // Apply target defense
    let finalDmg = applyDefense(baseDmg, target.stats.def)
    if (target.isDefending) {
      finalDmg = Math.max(1, Math.round(finalDmg * 0.5))
    }

    // Vanguard aura damage reduction
    if (session.matchType === '2v2' && enemyAura?.onHitTaken) {
      finalDmg = enemyAura.onHitTaken(finalDmg)
    }

    // Stormbreaker shockwave bonus
    let shockBonus = 0
    if (session.matchType === '2v2' && aura?.bonusShockPct) {
      shockBonus = Math.round(finalDmg * (aura.bonusShockPct / 100))
      finalDmg += shockBonus
    }

    target.hp = Math.max(0, target.hp - finalDmg)

    let attackDesc = action === 'skill' ? `uses a high-tier skill` : `strikes`
    let critText = isCrit ? ` 💥 *CRITICAL HIT!*` : ''
    let shockText = shockBonus > 0 ? ` ⚡ *(+${shockBonus} Storm Shock)*` : ''
    logEntries.push(`⚔️ *${actor.name}* ${attackDesc} *${target.name}* for *${finalDmg}* damage!${critText}${shockText}`)

    // Emberwake Burn Proc
    if (session.matchType === '2v2' && aura?.burnProc && target.alive) {
      const burnDmg = Math.max(5, Math.round(actor.stats.str * 0.25))
      target.hp = Math.max(0, target.hp - burnDmg)
      logEntries.push(`🔥 *Ember Blaze* scorches *${target.name}* for *${burnDmg}* true burn damage!`)
    }

    // Check target defeat / Totem check
    if (target.hp <= 0) {
      if (format.totemAllowed && target.equipped?.offhand === 'totem_of_undying') {
        target.hp = Math.round(target.maxHp * 0.3)
        target.equipped.offhand = null
        logEntries.push(`✨ *${target.name}'s Totem of Undying shattered!* Death was defied (+${target.hp} HP)!`)
      } else {
        target.alive = false
        logEntries.push(`💀 *${target.name}* was decisively DEFEATED!`)
      }
    }
  }

  // Check battle end
  const teamAAlive = session.teamA.some(f => f.alive)
  const teamBAlive = session.teamB.some(f => f.alive)

  let winnerGuildId = null
  if (!teamAAlive) {
    session.status = 'finished'
    winnerGuildId = session.guildBId
  } else if (!teamBAlive) {
    session.status = 'finished'
    winnerGuildId = session.guildAId
  }

  session.turnCount += 1
  session.updatedAt = Date.now()
  session.combatLog.push(...logEntries)

  return {
    ok: true,
    logs: logEntries,
    session,
    finished: session.status === 'finished',
    winnerGuildId,
  }
}
