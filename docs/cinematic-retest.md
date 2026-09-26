# Cinematic/PvP presentation retest — 2026-09-26

## What this checkpoint proves

The **actual `sendBattleTurnReply` entry used by PvP** can now receive a resolved
cinematic and replace its generic turn card/command footer with that cinematic.
This is no longer just testing a standalone image-sending helper.

- Clash order: vortex image → invisible-sword image → one result message →
  corrupted edit → restored result on **the same message key**.
- Coordinate: separately narrated resolved strikes → final Coordinate image.
  No generic PvP command footer is appended.
- `battle-presentation.js` acquires ownership for both participant IDs before
  the first await. A second scene cannot interleave with it. Other duels in the
  same group, and other databases with the same IDs, remain independent.
- A generic render captures a generation ticket before canvas/network work.
  If a scene starts while it is rendering, that card is discarded even if the
  scene has already finished when rendering returns.
- A trailing generic card from the same command context is suppressed too.
- The real plugin dispatcher and direct PvP entry points block RPG actions
  without printing busy-message spam. Admin recovery is still available.
- All presentation locks release in `finally` on delivery rejection. Commands
  arriving during a scene are dropped, **not queued as surprise future turns**.
- Both approved Endworld backgrounds reach the actual canvas renderer. Pixel
  tests use distinguishable mock images; this verifies composition, not remote
  image-host availability. Arbitrary player-provided background URLs are ignored.
- Failed media can fall back to text. Failed result edits retry the same message;
  if restoration persistently fails, a clean result reply is the safety fallback.
- Remote renderer image fetches have an eight-second abort timeout.

## Repeated test results

| Suite | Consecutive runs | Passed per run | Failed per run |
|---|---:|---:|---:|
| `npm test` | 3 | 272 | 0 |
| Focused cinematic regression | 5 | 25 | 0 |

Each focused run includes 100 varied asynchronous scheduling scenarios and
200 seeded image/edit failure schedules. These are reproducible simulations,
not hundreds of live WhatsApp sends.

Focused command:

```sh
node --test test/battle-presentation.test.mjs \
  test/battle-cinematic-renderer.test.mjs \
  test/cinematic-dispatch.test.mjs \
  test/witch-heroes-cinematic.test.mjs
```

An early integration test exposed a distinction worth covering: ability entry
points can emit a "not in a duel" reply before reaching the turn engine once
settlement clears battle state. Guards now also precede those exported PvP
entry points, not merely `runPvpTurn`.

## What is NOT proven / release blockers

1. **These characters are still staged.** Their actual combat commands and
   adapters do not yet trigger these scenes. New character commands, spin
   registration, both battle allowlists, all witch-immunity hooks, and normal
   battle settlement integration are not complete. Do not mark the PR ready.
2. A combat adapter must pass `opts.cinematic` to `sendBattleTurnReply` with
   `type`, an already resolved `finalText`, and explicit `participants` when
   settlement has cleared the battle states. Coordinate also supplies its
   actually resolved `strikes`. It must not emit a second ordinary victory
   message afterward. This layer does not decide winners or grant rewards.
3. The lock is **in-process**, scoped to the shared database object. Independent
   VPS processes need coordinated gameplay locking. It is not a substitute for
   an atomic turn transaction, cannot cancel a network send already submitted,
   and relies on the transport rejecting stalled send promises eventually.
4. No real paired WhatsApp delivery was tested. Media transcode latency, edit
   acknowledgements, and actual device rendering still need a manual smoke test.
5. Public-art fetches were attempted for both backgrounds, the vortex, invisible
   sword and Coordinate. This sandbox returned `ECONNRESET` before TLS; curl
   also failed TLS. This is **not proof the URLs are broken**, but their real
   delivery cannot be signed off from this environment. Test them on the bot's
   deployment host (or cache validated artwork locally) before release.

## Manual smoke test before release

- Start a real duel and run Endworld at the approved turn threshold.
- Verify the normal turn background changes on the next completed turn and the
  separate three-turn countdown has no off-by-one error.
- Verify phase-one Maiden survival, then both prepared/unprepared beam outcomes.
- During the scene, have both users send a battle command and a status command.
  Neither should mutate the fight or insert a generic card between scenes.
- Confirm only one result message is created for the glitch sequence and that
  it ends with readable, correct results; settlement/rewards happen once.
- Repeat with failing media and an edit rejection. Then verify the next battle
  can act normally and unrelated duels in the same chat were not blocked.
