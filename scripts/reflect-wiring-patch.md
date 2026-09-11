# Reflect wiring — proposed patch (NOT APPLIED)

Per the original request: this touches the shared damage path multiple
combat plugins rely on, so it's delivered here as a reviewable patch rather
than applied directly. `lib/effects.js` already has the `reflect` duration
effect (initializer + tick processor) — this document is only the
*consumption* side: where combat code should check for it and redirect
damage.

## Why this needs care

There is **no single damage-application choke point** for enemy-directed
damage in this codebase, unlike `applyIncomingDamage()` (player-directed
only, in `lib/character-abilities.js`). Enemy/boss HP is mutated at
distinct call sites per fight type:

| Path | File | Location | Notes |
|---|---|---|---|
| Player attacks enemy | `plugins/attack.js` | `e.hp = Math.max(0, e.hp - finalDmg)` (~L394) | Already has its own reflect concept: the hardcoded Meliodas "Full Counter" boss special (`lib/boss-engine.js`, case `'meliodas'`), which reflects the **player's outgoing** damage back at the player. This is a *different* mechanism and must not be confused with the new player-usable `reflect` effect, which reflects **incoming enemy** damage back at the enemy. |
| Regular enemy attacks player | `plugins/attack.js` | before `absorbDamage(player, enemyDmg)` (~L649) | Correct hook point for the new player-usable reflect skill. |
| Boss attacks player | `plugins/attack.js` | `buildEnemyAttack()` / `applyBossSpecial(EVENT.ENEMY_DEAL_DAMAGE)` block (~L473) | Also has `guaranteedHits` multi-hit true-damage bursts (Jotaro Time Stop style) that **already bypass shields** — reflect should follow the same exclusion, consistent with existing true-damage handling. |
| PvP | `plugins/pvp.js` | `resolveActiveAbility()` writes `opp.hp` directly, "no hook to intercept" (existing code comment, ~L1129) | No interception point exists at all today — `resolveActiveAbility()` itself needs a new return value or callback, which is a bigger change than the other two paths. |

## Proposed change — regular enemy attack (attack.js, ~L649)

```js
// Before:
const absorbedEnemyDmg = absorbDamage(player, enemyDmg)
const shieldBlockedEnemy = enemyDmg - absorbedEnemyDmg
const appliedEnemy = applyIncomingDamage(player, absorbedEnemyDmg)

// Proposed:
const reflectEntry = (player.activeEffects ?? []).find(
  (x) => x.type === 'reflect' && x.remaining > 0,
)
if (reflectEntry && enemyDmg > 0) {
  const reflected = Math.floor(enemyDmg * (reflectEntry.value / 100))
  e.hp = Math.max(0, e.hp - reflected)
  reflectEntry.remaining = 0 // consume on the hit it blocks, not just duration decay
  player.activeEffects = player.activeEffects.filter((x) => x.remaining > 0)
  msg += `\n🔁 *Reflected!* ${reflected} damage sent back at *${e.name}*!`
  if (e.hp <= 0) {
    if (boss) cleanupBossFight(player)
    return handleVictory(player, e, ctx)
  }
} else {
  const absorbedEnemyDmg = absorbDamage(player, enemyDmg)
  const shieldBlockedEnemy = enemyDmg - absorbedEnemyDmg
  const appliedEnemy = applyIncomingDamage(player, absorbedEnemyDmg)
  // ...unchanged rest of block
}
```

Open questions before merging:
- Should reflect stack with shield (partial absorb, partial reflect), or is
  it strictly either/or as sketched above? Sketched as either/or since that
  matches "counter stance" framing, but the interaction isn't specified in
  the original skill design.
- Boss path needs the identical check inserted at ~L473, with the same
  guaranteedHits/true-damage exclusion shields already get.
- PvP path needs `resolveActiveAbility()` itself modified to either return
  the damage dealt (so the caller can post-hoc redirect it, imperfect since
  `opp.hp` is already mutated by the time control returns) or accept a
  pre-check callback. This is the riskiest of the three and probably wants
  its own separate PR/review pass rather than landing in the same change as
  the other two.

## Not touched

`lib/effects.js`'s `reflect` initializer/tick-processor (already added,
see `data/skills.json` `pack_counter_sovereign`) works standalone —
skills can already grant the activeEffects entry safely. It's inert
(no combat behavior yet) until one of the above hooks is added, so shipping
the data-only half first and this wiring in a follow-up is a safe
sequencing if preferred.
