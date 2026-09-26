/**
 * lib/yoriichi.js — "Cat Form Awakening", the whole mechanic in one file.
 *
 * This used to live as a ~400 line block inside lib/character-abilities.js with
 * its turn driver in lib/combat-handlers.js and a third copy of the same idea in
 * plugins/pvp.js. Splitting it across three files is what let the central defect
 * survive so long, so it now lives here and nowhere else. character-abilities.js
 * re-exports these names for the ~9 modules that already import them.
 *
 * ── What she does ────────────────────────────────────────────────────────────
 * The moment her owner would die, Yoriichi comes to life and takes the fight
 * over. She is not a buff on the owner and not a revive: she is a SEPARATE
 * COMBATANT with her own HP pool (a flat 3,000), her own dodge, and her own
 * strike.
 *
 * ── Her defense is the owner's defense ───────────────────────────────────────
 * Her HP pool is the ONLY stat of her own. Everything else she fights with is
 * the owner's stat block: her strike is calcPlayerDamage(owner) with a
 * multiplier, her accuracy is calcPlayerHitChance(owner), and her DEF is
 * literally getEffectiveStat(owner, 'def') — see catFormDefense() below.
 *
 * That last one is not implemented here, and deliberately so: every hit that
 * reaches her pool has ALREADY been mitigated by the owner's DEF at its call
 * site, because cat form doesn't change the incoming-damage pipeline at all —
 * it only changes which number the final subtraction lands on (see
 * applyIncomingDamage() in lib/character-abilities.js, whose last step is the
 * only cat-form-aware line in it). PvE mitigates with
 * calcMonsterDamage(enemyAtk, getEffectiveStat(player, 'def')), PvP with
 * applyDefense(rawDmg, getEffectiveStat(opp, 'def')), and both run before the
 * damage gets anywhere near her.
 *
 * So do NOT apply defense again inside resolveCatFormDamage(). It receives
 * post-mitigation damage; re-mitigating it would give her DOUBLE the owner's
 * defense, not equal defense. catFormDefense() exists to state the number
 * (it's shown on the trigger card) and to give the guarantee one named place
 * to live, not to be a second mitigation step.
 *
 * ── The owner is DONE ────────────────────────────────────────────────────────
 * This is the part that was wrong for a long time and the reason this file
 * exists. Once she is up:
 *
 *   - The owner does not get another turn. Not a real one, and not a suggested
 *     one — nothing in any message from any code path may print a move for them
 *     to type. The old implementation ended every cat-form turn with
 *     "*.attack* · *.skill <name>* · *.defend* · *.flee*", which meant the turn
 *     was being handed straight back to a player who is supposed to be
 *     unconscious on the floor.
 *   - She picks her own moves. The old resolveCatFormAction() took a `skill`
 *     argument so the owner could steer her with `.skill <name>`; that was the
 *     same defect wearing a different hat, and the parameter is gone. Per turn,
 *     she attacks. That is the whole moveset.
 *   - The BOT plays her rounds and narrates each one. See
 *     runCatFormAutoFight() in lib/combat-handlers.js (PvE) and
 *     autoResolveCatFormTurns() in plugins/pvp.js (duels). Nothing here waits
 *     on a command, because she does not need one.
 *
 * Consequences worth being explicit about: the owner cannot flee, cannot heal
 * her, cannot direct her, and cannot end the fight early. If her pool runs out,
 * the fight is genuinely lost — that is the deal the ability makes.
 *
 * ── Once per battle ──────────────────────────────────────────────────────────
 * bs.yoriichiCatFormUsed latches on trigger and battleState is discarded when a
 * fight ends, so this resets per battle with no bookkeeping. A second lethal hit
 * in the same fight is a real death.
 */
import { getEffectiveStat } from './effects.js'
import { sendImageTo } from './image.js'
import { calcPlayerDamage, applyDefense, calcPlayerHitChance } from './combat-engine.js'
import { applyIncomingDamage } from './character-abilities.js'

// NOTE ON THE IMPORT ABOVE — this is a deliberate cycle:
// character-abilities.js's applyIncomingDamage() calls resolveCatFormDamage()
// from this file (that is how damage gets routed into her pool), and
// resolveCatFormAction() below calls applyIncomingDamage() (so her hits still
// respect whatever the person she is hitting has going on — Mei's sustain,
// Circe's guards, their own cat form). Node ESM resolves this fine because every
// use is inside a function body rather than at module-evaluation time. Do not
// move any of these calls to the top level.

// ── Tuning ───────────────────────────────────────────────────────────────────
const CAT_FORM_HP = 3000               // her whole pool, flat — no growth curve
const CAT_FORM_ATTACK_MULT = 1.6       // her strike hits harder than a normal attack
const CAT_FORM_DODGE_MIN = 0.30        // freshly-triggered cat form
const CAT_FORM_DODGE_MAX = 0.35        // fully-grown cat form

// Yoriichi EXP now feeds her DODGE only. It used to drive an HP ramp as well
// (4,000 -> 10,000), which is why the field is still called yoriichiExp and why
// grantYoriichiExp() is still called on every win — her pool is a flat
// CAT_FORM_HP now, so wins buy evasion rather than a bigger bar. Deliberately
// NOT tied to the player's own level curve (levels.json is for player stats;
// this is her own growth track, earned only from wins while she is equipped).
const YORIICHI_EXP_FOR_MAX_GROWTH = 100 // wins-while-equipped needed to max her dodge
const YORIICHI_EXP_PER_DUNGEON_WIN = 1
const YORIICHI_EXP_PER_PVP_WIN = 2     // PvP wins are riskier, so worth more growth

/**
 * Yoriichi's cat-form max HP for this player — a flat CAT_FORM_HP.
 *
 * Still takes `player` and stays exported despite ignoring its argument: it's
 * imported by ~9 modules and read at both arm sites below, and keeping the
 * function is what makes a future per-player pool a one-line change here
 * instead of a hunt through every caller.
 */
export function yoriichiCatFormMaxHp(player) { // eslint-disable-line no-unused-vars
  return CAT_FORM_HP
}

/**
 * catFormDefense(player) -> number
 * Her DEF, which is exactly her owner's DEF — she fights behind the same armor
 * they do. Read the "Her defense is the owner's defense" note at the top of
 * this file before using this anywhere: it is a REPORTING helper, not a
 * mitigation step. Damage arriving at resolveCatFormDamage() has already been
 * cut by this exact number upstream.
 */
export function catFormDefense(player) {
  return getEffectiveStat(player, 'def')
}

/** Her dodge chance for this player, scaling with her win count. */
function catFormDodgeChance(player) {
  const exp = Math.max(0, Number(player?.yoriichiExp) || 0)
  const progress = Math.min(1, exp / YORIICHI_EXP_FOR_MAX_GROWTH)
  return CAT_FORM_DODGE_MIN + (CAT_FORM_DODGE_MAX - CAT_FORM_DODGE_MIN) * progress
}

/**
 * grantYoriichiExp(player, source) -> void
 * Call once per WIN (losses grant nothing) from the same win-resolution point
 * handleVictory()/pvpConclude() already use. `source` is 'dungeon' | 'pvp'.
 * No-ops silently when she isn't equipped, so callers can invoke it
 * unconditionally on every win without an extra equippedCharacter check.
 */
export function grantYoriichiExp(player, source) {
  if (player?.equippedCharacter !== 'yoriichi') return
  const gain = source === 'pvp' ? YORIICHI_EXP_PER_PVP_WIN : YORIICHI_EXP_PER_DUNGEON_WIN
  player.yoriichiExp = Math.min(YORIICHI_EXP_FOR_MAX_GROWTH, (Number(player.yoriichiExp) || 0) + gain)
}

/**
 * The trigger cinematic. Named after the OWNER rather than 2nd-person "you":
 * in a duel this same text is read by BOTH players, and "your vision goes dark"
 * made the opponent think their own cat form had fired. Naming the owner makes
 * it unambiguous whose master fell and who she is fighting for.
 *
 * The last line is doing real work — it tells both players that she is running
 * the fight from here on, which is why no message after it offers the owner a
 * move. Her two numbers ride on that same line rather than as a seventh entry,
 * because sendYoriichiCatFormSequence() sends these one at a time and puts the
 * LAST one over her art — a separate stat line would either steal the caption
 * or trail after the image.
 */
function catFormTriggerLines(player) {
  const name = player?.name || 'The hunter'
  const possessive = player?.name ? `${name}'s` : 'their'
  return [
    `💫 _${name}'s vision goes dark..._`,
    `🩸 _${name} is slipping away..._`,
    '🐈‍⬛ _Yoriichi watches her master fall._',
    '⚡ _Her eyes narrow. Something in her breaks._',
    `🔥 *YORIICHI ENTERS CAT FORM* 🔥`,
    `_She does not wait for orders. ${name} is down — she takes the fight from here._\n` +
    `🐈‍⬛ *${yoriichiCatFormMaxHp(player)} HP*  ·  🛡️ *${catFormDefense(player)} DEF* ` +
    `_(${possessive} own armour — she fights behind it)_`,
  ]
}

/** Staged cinematic lines for when her own HP pool is the one that runs out. */
const CAT_FORM_DEFEAT_SEQUENCE = [
  '🐈‍⬛ _Yoriichi staggers — she has nothing left to give._',
  '💔 _The last of her strength leaves her._',
  '🌑 *YORIICHI FALLS.* _The fight is lost._',
]

/**
 * checkYoriichiCatForm(player) -> '' | string
 * Call at the same "player.hp <= 0" checkpoints checkTotemRevive()/
 * checkPearlSave() are called from, with the same contract: '' means no
 * intercept (fall through to the real death), a truthy string means she took
 * over and the caller must NOT call handleDeath.
 *
 * IMPORTANT — arming her is only half the job. A caller that arms cat form and
 * then returns without running her fight leaves a battle sitting there with
 * nobody whose turn it is: the owner has no turn by design and she has not been
 * given hers. Every call site must follow up with runCatFormAutoFight()
 * (lib/combat-handlers.js) or autoResolveCatFormTurns() (plugins/pvp.js).
 */
export function checkYoriichiCatForm(player) {
  if (player?.equippedCharacter !== 'yoriichi') return ''
  const bs = player.battleState
  if (!bs) return ''
  if (bs.yoriichiCatFormUsed) return '' // already spent this battle — real death now
  if (bs.yoriichiCatFormActive) return '' // shouldn't happen (used implies active), safety net

  bs.yoriichiCatFormUsed = true
  const maxHp = yoriichiCatFormMaxHp(player)
  bs.yoriichiCatFormActive = { hp: maxHp, maxHp }
  // Bump the owner's own hp off exactly 0 so every OTHER "player.hp <= 0" read
  // scattered around the codebase (alerts.js's "You are down" card, party.js's
  // incapacitation checks — none of which know about cat form) stops mistaking
  // "Yoriichi is fighting for me" for "I actually died". 1 hp still reads as
  // critical everywhere HP is shown, it just isn't literal zero.
  player.hp = 1
  // A guard held before she took over is not hers to hold, and a stale flag
  // would otherwise keep mitigating damage for the rest of the fight.
  bs.playerDefending = false

  return '\n\n' + catFormTriggerLines(player).join('\n')
}

/**
 * sendYoriichiCatFormSequence(ctx, player, recipient) -> Promise<string|null>
 * Paced version of checkYoriichiCatForm() for call sites that can afford a real
 * staged cinematic (~2s between lines, matching pvp.js's dragon-ultimate
 * pattern). Arms the same battleState fields — do NOT call both for the same
 * death event. Returns null if she didn't trigger, or the final line if she did.
 *
 * Not used by the PvE driver: resolvePlayerHpZero() runs inside an updatePlayer()
 * mutator, and mutators hold a shared global write queue (see
 * lib/player-repo.js's runExclusive), so sleeping in there would stall every
 * other player's commands.
 */
export async function sendYoriichiCatFormSequence(ctx, player, recipient = ctx.sender) {
  if (player?.equippedCharacter !== 'yoriichi') return null
  const bs = player.battleState
  if (!bs || bs.yoriichiCatFormUsed || bs.yoriichiCatFormActive) return null

  bs.yoriichiCatFormUsed = true
  const maxHp = yoriichiCatFormMaxHp(player)
  bs.yoriichiCatFormActive = { hp: maxHp, maxHp }
  player.hp = 1 // see checkYoriichiCatForm() for why this isn't left at 0
  bs.playerDefending = false

  const lines = catFormTriggerLines(player)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isLast = i === lines.length - 1
    if (isLast) {
      await sendImageTo(ctx, 'yoriichi-catform', line, recipient).catch(() => ctx.reply(line))
    } else {
      await ctx.reply(line)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return lines[lines.length - 1]
}

/**
 * isCatFormActive(player) -> boolean
 * The guard every caller uses to decide "is Yoriichi the one standing here?" —
 * for routing damage into her pool, for refusing the owner a turn, and for
 * deciding whether a side of a duel is still alive.
 */
export function isCatFormActive(player) {
  return Boolean(player?.battleState?.yoriichiCatFormActive)
}

/** Her remaining pool, or null when she isn't up. Read-only convenience. */
export function catFormPool(player) {
  return player?.battleState?.yoriichiCatFormActive ?? null
}

/**
 * resolveCatFormDamage(player, incomingDamage) -> { damage, catFormHp, catFormMaxHp, defeated, message }
 * Call INSTEAD OF subtracting incoming damage from player.hp whenever
 * isCatFormActive(player). Rolls her dodge, then drains her own pool — never the
 * owner's hp. If this empties her, sets battleState.yoriichiCatFormDefeated and
 * returns defeated: true; the CALLER must check that and route to the real
 * death/loss flow (handleDeath in PvE, pvpConclude(loser) in a duel) exactly as
 * if no intercept had ever fired, using buildCatFormDefeatMessage() to narrate.
 *
 * `incomingDamage` is POST-mitigation: the owner's DEF has already been applied
 * by the caller, which is how "her defense equals her user's" is delivered. Do
 * not apply catFormDefense() to it here — see the note at the top of the file.
 */
export function resolveCatFormDamage(player, incomingDamage) {
  const bs = player?.battleState
  const cat = bs?.yoriichiCatFormActive
  const dmg = Math.max(0, Number(incomingDamage) || 0)
  if (!cat) return { damage: dmg, catFormHp: 0, catFormMaxHp: 0, defeated: false, message: '' }

  if (Math.random() < catFormDodgeChance(player)) {
    return {
      damage: 0,
      catFormHp: cat.hp,
      catFormMaxHp: cat.maxHp,
      defeated: false,
      message: `🐈‍⬛💨 *Yoriichi* slips the attack entirely!`,
    }
  }

  cat.hp = Math.max(0, cat.hp - dmg)
  const defeated = cat.hp <= 0
  if (defeated) bs.yoriichiCatFormDefeated = true

  return {
    damage: dmg,
    catFormHp: cat.hp,
    catFormMaxHp: cat.maxHp,
    defeated,
    message: `🐈‍⬛ *Yoriichi* takes *${dmg}* damage! (${cat.hp}/${cat.maxHp} HP)`,
  }
}

/**
 * catFormAttackDamage(player) -> number
 * Her damage multiplier while she's up, or 1 when she isn't — the same
 * "just the multiplier" contract Wither's CINDER_VERDICT_MULT uses, so callers
 * can fold it into an existing calcPlayerDamage() call unconditionally.
 */
export function catFormAttackDamage(player) {
  return isCatFormActive(player) ? CAT_FORM_ATTACK_MULT : 1
}

/**
 * Heal her pool rather than the owner's hp bar. The owner's hp is pinned at 1
 * on purpose (see checkYoriichiCatForm), so healing it would be an invisible
 * no-op. Used by the PvE driver to redirect a regen tick that landed on the
 * pinned hp into her pool. Returns the amount actually restored.
 */
export function healCatFormPool(player, amount) {
  const cat = player?.battleState?.yoriichiCatFormActive
  if (!cat) return 0
  const before = cat.hp
  cat.hp = Math.min(cat.maxHp, cat.hp + Math.max(0, Math.floor(amount) || 0))
  return cat.hp - before
}

/**
 * Her strike, described a few different ways so a long fight doesn't read as
 * the same sentence twenty times. Indexed by turn rather than randomised so the
 * narration of a given fight is reproducible.
 */
const CAT_FORM_STRIKE_VERBS = [
  'tears into',
  'is on',
  'rips through',
  'lands on',
  'comes down on',
  'cuts across',
]

/**
 * resolveCatFormAction(actor, opponent) -> { message, opponentDefeated }
 *
 * One turn of Yoriichi's. She attacks — that is the entire moveset, and it is
 * deliberate: she is not a puppet the owner drives, so there is no `skill`
 * parameter here and no support branch. (The previous version accepted one,
 * which is how `.skill <name>` kept giving a downed owner a turn.)
 *
 * Damage runs through the SAME calcPlayerDamage()/applyDefense()/
 * calcPlayerHitChance() pipeline every other hit uses — crits, accuracy and
 * defense mitigation all still apply — with catFormAttackDamage()'s multiplier
 * stacked on, then routes through applyIncomingDamage() so whatever the person
 * she's hitting has going on (Mei's sustain, Circe's guards, their own cat form)
 * still applies normally.
 *
 * Pure and synchronous on purpose: both drivers call this from inside an
 * updatePlayer() mutator, and mutators must not await.
 */
export function resolveCatFormAction(actor, opponent) {
  const turn = Number(actor?.battleState?.turn) || 1

  const hitChance = calcPlayerHitChance(actor, opponent)
  if (Math.random() > hitChance) {
    return {
      message: `🐈‍⬛💨❌ *Yoriichi* lunges at *${opponent.name}*... and MISSES!\n`,
      opponentDefeated: false,
    }
  }

  const { rawDmg, isCrit } = calcPlayerDamage(actor, null, catFormAttackDamage(actor))
  const dmg = applyDefense(rawDmg, getEffectiveStat(opponent, 'def'))
  const applied = applyIncomingDamage(opponent, dmg)

  const verb = CAT_FORM_STRIKE_VERBS[(turn - 1) % CAT_FORM_STRIKE_VERBS.length]
  let message =
    `${isCrit ? '💥🔥 *CRITICAL HIT!!* 🔥💥\n' : '🐈‍⬛ '}` +
    `*Yoriichi* ${verb} *${opponent.name}* 👉 *${applied.damage} DMG*! 💢\n`
  if (applied.message) message += applied.message + '\n'

  // Their side may have its own interceptors. applied.catFormDefeated means they
  // were already in cat form and this hit drained it; otherwise a fresh 0 gives
  // THEIR Yoriichi (if any) her one chance to stand up.
  let opponentDefeated = applied.catFormDefeated
  if (!opponentDefeated && opponent.hp <= 0) {
    const catMsg = checkYoriichiCatForm(opponent)
    if (catMsg) {
      message += catMsg
    } else {
      opponentDefeated = true
    }
  }

  return { message, opponentDefeated }
}

/**
 * buildCatFormDefeatMessage() -> string
 * Narration for when her pool hits 0 (the real loss). Callers append this before
 * invoking handleDeath()/pvpConclude(loser). Does not mutate state —
 * resolveCatFormDamage() already set yoriichiCatFormDefeated.
 */
export function buildCatFormDefeatMessage() {
  return '\n\n' + CAT_FORM_DEFEAT_SEQUENCE.join('\n')
}

/**
 * isOpponentLive(player) -> boolean
 * "Is there still someone standing on that side?" A cat-form owner reads as
 * hp 1 with a full pool behind them, so a plain hp check would call a duel over
 * while Yoriichi is still very much fighting.
 */
export function isOpponentLive(player) {
  return (player?.hp ?? 0) > 0 || isCatFormActive(player)
}

/**
 * clearYoriichiCatForm(player) — call when the battle actually ends (win, loss,
 * flee, forfeit). Mostly belt-and-braces: nulling battleState drops all three
 * flags for free in every real call site, so this exists for the paths that
 * clear a fight without discarding the whole object.
 */
export function clearYoriichiCatForm(player) {
  if (!player?.battleState) return
  delete player.battleState.yoriichiCatFormActive
  delete player.battleState.yoriichiCatFormUsed
  delete player.battleState.yoriichiCatFormDefeated
}
