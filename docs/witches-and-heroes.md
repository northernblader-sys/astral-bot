# Scarlett, Ronova and The Heroes — implementation checkpoint

**Status: staged foundation, NOT ready to merge or deploy as playable characters.**

The session branch is `arena/01a0dbf3-astral-bot`; the PR base is `master`.
No work uses the unrelated `main` history. The new definitions deliberately do
not enter `data/characters.json` or the plugin loader until combat integration
is finished. Players cannot spend gems on unfinished characters.

## Approved rules captured in code

| Exclusive | Gem cost/spin | Zero-probability spins | Guaranteed spin | Lifetime cap |
|---|---:|---|---:|---:|
| Scarlett | 1 | 1–240 | 241 | 250 |
| Ronova | 1 | 1–260 | 261 | 300 |
| Sword Maiden | 1 | 1–299 | 300 | 300 |

All are one-owner bot-wide, following existing exclusive claims. Winning
batches stop immediately, charging only attempts actually used. Maiden's
preview and win both use animated GIF delivery; a failed GIF falls back to
text, never to a still image.

- Scarlett's **My Desire** is passive: at most four successful reflections
  per battle. The current tuning is a 35% independent chance per direct,
  landed incoming hit. DOT, recoil and reflected hits are not eligible.
  Reflection sends the already resolved damage back unchanged, with no hit
  on Scarlett. Ronova is immune. The 35% tuning was not specified by the user
  and should remain clearly documented, not disguised as an approved number.
- Ronova's **The End of the World** unlocks after five completed **generic
  battle turns**, not five Ronova-only turns. Activation consumes an action;
  that action does not count as a charging turn. The next three completed
  turns change the background and count down; the third executes the enemy
  regardless of ordinary saves/revivals.
- Sword Maiden survives phase one automatically, unchanged HP, with the
  void-cutting owner-protection narration. Phase two takes three more turns.
  An armed, unspent Transcended Sword cuts the beam and defeats Ronova;
  otherwise Maiden loses. A Transcended Sword already released by defending
  cannot also counter the beam.
- Maiden belongs to **The Heroes**. Five physical sword techniques use
  charge plus substantial MP. The current tuning caps charge at six; skills
  consume 1/2/2/3/6 charge and 25/30/35/45/80% maximum MP respectively. Charge
  advances once per completed generic turn. `.ss` must remain read-only.
- The Coordinate returns an intent for three separately resolved strikes.
  Combat adapters must resolve genuine intervening revivals and award one
  battle outcome, never fabricate three deaths of an already-dead target.
- The WhatsApp glitch edits **one result message**, corrupts it briefly, then
  restores the clean result on that same message. The adapter checks bot
  ownership and chat identity before editing. If restoration fails, retry
  the same message first; only persistent failure permits a clean fallback
  reply. Presentation never owns HP, outcome or rewards.

## Implemented and tested here

- `lib/witch-heroes.js`: deterministic battle state, seeded reflection tests,
  countdown/phase rules, sword actions and delayed reactions, idempotent turn
  IDs, JSON-safe state, staged art URLs.
- `lib/witch-heroes-spins.js`: staged definitions, serialized-queue-compatible
  pull mutation, exact costs/caps/guarantees, GIF-safe presentation. Sword Maiden gains one charge after each completed non-sword turn, capped at six; ordinary PvP turns count too. Every `.sword` technique requires and spends both its charge threshold and MP. Using one in a duel consumes the turn and passes play to the opponent, but does not refill the charge it just spent.
- `lib/witch-heroes-cinematic.js`: clash/Coordinate presentation and editable
  result sequence, injectable delays, failed-media and failed-edit fallback.
- `plugins/maiden.js` + `lib/maiden-persona.js` + `data/maiden-personality.json`:
  the holder's chat with her (`.maiden <message>`), Groq first with the
  OpenRouter backup through `lib/ai.js`. Her voice is data, not code: the
  personality file guides her voice and `softenMaidenReply()` removes emoji,
  formatting, and stage directions while preserving natural punctuation. Her
  replies are intentionally varied in length and do not require a catchphrase.
  Her card stays OUT of both battle allowlists
  on purpose: conversation is not a battle action. Ownership is her exclusive
  claim (`ownedCharacters`), with the bot owner let through to test her voice
  live. See `test/maiden.test.mjs` and `test/maiden-smoke.test.mjs`.
- `lib/platform/whatsapp-edits.js` and `handler.js`: actual Baileys own-message
  edit capability exposed as `ctx.editReply`.
- OpenRouter: keep request abort timeout active while reading response JSON,
  retry malformed success bodies, parse text content blocks, distinguish
  credit failures in Echidna, log only a numeric status. This fixes a proven
  client failure mode; the deployed Echidna incident remains unverified.

## Required before making this PR ready

1. **PvE/dungeon/boss adapter**: integrate completed-turn events into every
   action, including alternate actions, stun/skip, flee and fight end. Do not
   tick on informational/invalid commands. Route reflection-caused enemy
   deaths through the normal victory path exactly once. Multi-enemy/swarm
   and party modes need explicit coverage, not accidental 1v1 assumptions.
2. **PvP adapter**: introduce/mirror a duel-wide completed-move ID. Current
   `battleState.turn` is per-player. Preserve turn ownership, timeouts, duel
   variants and the existing no-character-powers rule for wager duels.
   Avoid nested `updatePlayer` calls (the shared write queue deadlocks).
3. **Immunity audit**: apply `witchImmune` at every existing witch power,
   including Alexa, Tella, Echidna, Circe and Reverie. The standalone predicate
   alone does not block the existing production abilities. Normal physical
   attacks must still work on Ronova.
4. **Absolute sword integration**: bypass hit rolls, damage negation and pet
   interception intentionally; resolve each Coordinate strike against real
   revival state; retain one final settlement. Wire delayed defend release,
   reaction ordering, charging and all five distinct effects into each mode.
5. **Renderer and cinematic ownership**: the actual renderer now consumes
   `cinematicBackground` and a resolved `opts.cinematic` payload, replacing the
   generic card/footer. Both participants have an in-process presentation lock;
   generation tickets discard stale in-flight renders, and finally releases
   the lock on rejected sends. Dispatcher and direct PvP entry points check it.
   **Still required:** combat adapters must supply the resolved scene instead
   of sending separate victory/status messages, preserve participant IDs after
   settlement, and keep mutation/settlement atomic. The lock is not distributed
   across independent VPS processes and is not a database transaction. A socket
   promise that never settles relies on the platform transport's timeout.
6. **Commands and discoverability**: register `.endworld`, `.sword`, `.ss`,
   all spin commands and aliases; add every combat token to BOTH
   `handler.js` and `lib/platform/pipeline.js` battle allowlists. The holder's
   `.maiden` chat command is the deliberate exception and stays out of both. Add character
   routes, hero-series display and entries to the production character data
   only after integration passes.
7. **End-to-end tests**: real plugin routing and HP/result/reward assertions
   across dungeon, bosses, PvP and swarm/party; renderer tests for background
   changes and no generic message overlap; manual WhatsApp test for live
   media/edit delivery (mocks do not prove platform delivery).
8. **Deployment diagnosis**: review redacted runtime OpenRouter status on
   the deployed bot. Do not print API keys or chat history, or claim the
   timeout fix proves the original incident's cause.

## Test commands

```sh
node --test test/witch-heroes*.test.mjs test/openrouter-client.test.mjs
npm test
```

No live WhatsApp session or live OpenRouter API call is used in these tests.


## Cinematic retest checkpoint (2026-09-26)

See `docs/cinematic-retest.md` for evidence and remaining live-delivery limits.
Full suite: **272 passed, 0 failed**, on three consecutive runs. Focused scene
suite: **25 passed, 0 failed**, on five consecutive runs, including seeded
failure schedules and actual PvP renderer / command-dispatch boundary tests.
These do not make the characters playable: the adapters in the checklist above
still need to invoke the new mechanics and pass the resolved cinematic payload.
