/**
 * player-factory.js — the single place a brand-new player record is built.
 *
 * Extracted out of plugins/register.js so the website's sign-up flow
 * (lib/api-server.js → POST /api/auth/register) creates EXACTLY the same
 * record shape as the in-chat `.register` command. Two divergent copies of
 * this object was the one thing guaranteed to rot: a field added to the
 * chat flow but missed on the web flow produces players that crash a
 * plugin months later. One factory, two callers.
 *
 * The field-by-field documentation for everything below lives in
 * lib/player-repo.js's header — don't duplicate it here, keep it there.
 */
import { classes, races, defaultWallet, getTotalStats, skills as allSkills } from './game-data.js'
import { autoFillSkillSlots } from './skill-slots.js'
import { ensureHunger } from './hunger-engine.js'

/** Valid class ids, in data order — used by the web sign-up form. */
export function listClasses() {
  return Object.entries(classes).map(([id, c]) => ({
    id,
    name: c.name,
    description: c.description,
    primaryStat: c.primaryStat,
    school: c.school,
    baseStats: c.baseStats,
    startingSkills: c.startingSkills,
    startingItems: c.startingItems,
  }))
}

/** Valid race ids, in data order — used by the web sign-up form. */
export function listRaces() {
  return Object.entries(races).map(([id, r]) => ({
    id,
    name: r.name,
    description: r.description,
    statModifiers: r.statModifiers,
    passive: r.passive,
  }))
}

/**
 * Validates a would-be registration. Returns { ok: true, name, classId,
 * raceId } or { ok: false, error } with a human-readable message — the same
 * message the API hands back to the website's sign-up form.
 */
export function validateRegistration({ name, classId, raceId }) {
  const cleanName = String(name ?? '').trim()
  const cls = String(classId ?? '').toLowerCase().trim()
  const race = String(raceId ?? '').toLowerCase().trim()

  if (!cleanName) return { ok: false, error: 'Pick a character name.' }
  if (cleanName.length < 2) return { ok: false, error: 'Name must be at least 2 characters.' }
  if (cleanName.length > 20) return { ok: false, error: 'Name must be 20 characters or fewer.' }
  // Same charset the chat command effectively allows (a single whitespace-free
  // token), minus anything that would break WhatsApp's markdown in replies.
  if (!/^[A-Za-z0-9_.-]+$/.test(cleanName)) {
    return { ok: false, error: 'Name can only use letters, numbers, and _ . -' }
  }
  if (!Object.prototype.hasOwnProperty.call(classes, cls)) {
    return { ok: false, error: `Unknown class "${classId}".` }
  }
  if (!Object.prototype.hasOwnProperty.call(races, race)) {
    return { ok: false, error: `Unknown race "${raceId}".` }
  }
  return { ok: true, name: cleanName, classId: cls, raceId: race }
}

/**
 * Builds (but does NOT persist) a fresh player record. Caller is responsible
 * for createPlayer(db, id, player) and for having checked playerExists first.
 *
 * `id` is the WhatsApp JID the player will be identified by forever.
 */
export function buildNewPlayer({ id, name, classId, raceId }) {
  const totalStats = getTotalStats(classId, raceId, 1)
  const cls = classes[classId]

  // Stamina resets at tomorrow midnight
  const tom = new Date(); tom.setHours(24, 0, 0, 0)

  const newPlayer = {
    id,
    name,
    classId,
    raceId,
    title:             null,
    // Profile customization — see plugins/setbio.js and plugins/setpfp.js.
    bio:               null,
    // pfp: ImgBB URL of the player's custom profile picture (lib/pfp.js).
    pfp:               null,
    level:             1,
    xp:                0,
    hp:                totalStats.maxHp,
    maxHp:             totalStats.maxHp,
    mp:                totalStats.maxMp,
    maxMp:             totalStats.maxMp,
    stats: {
      str:    totalStats.str,
      agi:    totalStats.agi,
      int:    totalStats.int,
      def:    totalStats.def,
      lck:    totalStats.lck,
      wins:   0,
      losses: 0,
    },
    baseStats: {
      str:    totalStats.str,
      agi:    totalStats.agi,
      int:    totalStats.int,
      def:    totalStats.def,
      lck:    totalStats.lck,
      maxHp:  totalStats.maxHp,
      maxMp:  totalStats.maxMp,
    },
    statPoints: {
      version: 2,
      earned: 15,
      spent: 0,
      unallocated: 15,
      allocations: { str: 0, agi: 0, int: 0, def: 0, lck: 0 },
    },
    // wallet.vault is deliberately NOT part of data/currency.json's
    // defaultWallet — see the long note in plugins/register.js's history and
    // lib/player-repo.js's schema comment.
    wallet:            { ...defaultWallet, vault: 0 },
    equipped:          { weapon: null, offhand: null, helmet: null, chestplate: null, boots: null, relic: null, pet: null, tool: null },
    equippedDurability: {},
    inventory:         [...cls.startingItems],
    chest:             { unlocked: false, items: [] },
    pets:              [],
    beastInventory:    [],
    summonedBeasts:    [],
    activeBeast:       null,
    skills:            [...cls.startingSkills],
    equippedSkills:    [],
    activeEffects:     [],
    abilityInventory:  [],
    equippedAbilities: [],
    abilitySlots:      1,
    ownedCharacters:   [],
    equippedCharacter: null,
    seasonPoints:      0,
    seasonOwned:       {
      characters: [],
      items: [],
      weapons: [],
      titles: [],
      pokemon: [],
      pokemonItems: [],
    },
    seasonProgress:    {
      seasonId: null,
      battlePassTier: 0,
      premiumPass: false,
      claimedTiers: [],
      spins: 0,
      majorCharacter: null,
      pointsEarned: 0,
    },
    // Dungeon / battle state
    location:          'astral_town',
    inDungeon:         false,
    inBattle:          false,
    dungeonFloor:      0,
    dungeonCheckpoint: 0,
    battleState:       null,
    dungeonProgress:   {},
    stamina:           { current: 30, max: 30, resetAt: tom.getTime() },
    // hunger: { current, max, lastTick, immune, ... } — stamped just below by
    // ensureHunger() so the shape stays owned by lib/hunger-engine.js alone.
    registeredAt:      Date.now(),
    guildId:           null,
    guildJoinedAt:     null,
    guildJoinBaseline: 0,
    dailyStreak:       0,
    lastDailyClaim:    null,
    lastRenameAt:      null,
    sleepUntil:        null,
    lastSleepDate:     null,
    lastWorkAt:        null,
    lastWorkAmount:    null,
    lastRobAt:         null,
    premium: {
      active:              false,
      plan:                null,
      expiresAt:           null,
      grantedAt:           null,
      autoReviveUsedToday: false,
      autoReviveDate:      null,
    },
    premiumPending:    null,
    topupPending:      null,
    // mondPending — an in-flight Naira Mond pack awaiting its payment
    // screenshot (plugins/monds.js, lib/pending-purchase.js). wallet.monds
    // itself needs no line here: it comes in through defaultWallet, since
    // data/currency.json declares it like every other currency.
    mondPending:       null,
    seasonOfferPending: null,
    storyProgress:     { volumes: {} },
    storyFlags:        [],
  }

  autoFillSkillSlots(newPlayer, allSkills)

  // Start every fresh character with a full hunger bar (lastTick = now), using
  // the engine's own backfill so the record matches what applyHungerTick expects.
  ensureHunger(newPlayer)

  return newPlayer
}
