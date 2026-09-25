/**
 * story-slot-flow.test.mjs — the group Story Mode flow, end to end, asserting on
 * the TEXT the group actually sees.
 *
 * What was wrong (player report, 2026-09-26): the story slot is group-wide state
 * that everyone in the group is waiting on, and almost every change to it was
 * silent. Claiming it printed nothing, finishing a chapter on cooldown left it
 * held for a day with no word, taking a detour freed it with no word, and
 * `.story off` dropped the holder with no word. The ONLY slot change anyone
 * could ever see was the 15-minute idle sweep in main.js. So "some parts like
 * slot don't have text that shows updates" was exactly right.
 *
 * Every transition now posts one line into the group, and `.story slot` answers
 * "who's got it" without having to try to take it.
 *
 * Run:  node --test test/story-slot-flow.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Must be set BEFORE lib/runtime-paths.js is first imported: it resolves the
// mutable-state directory (moderation.json holds storySlots) at import time, and
// these tests must not write into the repo's own data/.
process.env.RUNTIME_DATA_DIR = mkdtempSync(join(tmpdir(), 'astral-story-test-'))

// The story plugin paces its narration with setTimeout(4500); a chapter is 90
// beats, so collapse the pacing or the suite takes minutes.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0)

const storyMod = await import('../plugins/story.js')
const story = storyMod.default
const { getPlayer, updatePlayer } = await import('../lib/player-repo.js')
const { listStorySlots } = await import('../lib/moderation-state.js')
const {
  getVolume, getChapter, getResolvedBeats, ensureStoryProgress,
} = await import('../lib/story-engine.js')

const GROUP = '120363000000000000@g.us'
const OWNER = '2347062301848@s.whatsapp.net' // config.js's default owner number
const READER = '234000000102@s.whatsapp.net'
const VOLUME_ID = 'beyond-the-astral'

function makePlayer(jid, name) {
  return {
    id: jid, name, storyProgress: null, premium: { active: false },
    wallet: { solars: 0, gems: 0 }, xp: 0, level: 1,
    stats: { str: 10, agi: 10, int: 10, def: 10, lck: 5 },
    classId: 'warrior', raceId: 'human', maxHp: 100, hp: 100, maxMp: 20, mp: 20,
    inventory: [], ownedCharacters: [], storyFlags: [],
  }
}

const db = { data: { users: { [OWNER]: makePlayer(OWNER, 'Owner'), [READER]: makePlayer(READER, 'Reader') } } }

/** One command invocation; `sent` collects everything the group would see. */
function makeCtx(from, args = [], cmd = 'story') {
  const sent = []
  return {
    db, from, args, cmd, isGroup: true, platform: 'whatsapp',
    player: getPlayer(db, from), sender: GROUP, msg: { key: { id: 'X' } },
    reply: async (t) => { sent.push(String(t)) },
    logger: { warn: () => {} },
    sock: {
      sendMessage: async (to, payload) => {
        sent.push({ text: payload?.text ?? payload?.caption ?? '[image]', mentions: payload?.mentions ?? [] })
        return { key: {} }
      },
    },
    sent,
  }
}

const run = async (from, args = [], cmd = 'story') => {
  const ctx = makeCtx(from, args, cmd)
  await story.run(ctx)
  return ctx
}

const allText = (ctx) => ctx.sent.map(m => (typeof m === 'string' ? m : m.text)).join('\n')
const slotHolders = async () => (await listStorySlots()).map(([, rec]) => rec.userJid)

/** The beat the player is sitting on, resolved exactly the way the plugin does. */
function pendingChoice(from) {
  const player = getPlayer(db, from)
  const progress = player.storyProgress?.volumes?.[VOLUME_ID]
  if (!progress) return null
  const volume = getVolume(VOLUME_ID)
  const chapter = getChapter(volume, progress.currentChapter)
  const beat = getResolvedBeats(volume, player, VOLUME_ID, chapter)[progress.currentBeat]
  return beat?.type === 'choice' ? beat : null
}

test.after(() => { globalThis.setTimeout = realSetTimeout })

// ── 1. The gates ────────────────────────────────────────────────────────────

test('the volume list and the guide work with Story Mode still off', async () => {
  const ctx = await run(OWNER, [])
  assert.match(allText(ctx), /STORY MODE/)
  assert.match(allText(ctx), /Beyond the Astral/)
  assert.match(allText(ctx), /\.story slot/, 'the guide documents the new subcommand')
})

test('".story slot" is readable with Story Mode off', async () => {
  const ctx = await run(READER, ['slot'])
  assert.match(allText(ctx), /Story slot: free/)
})

test('enter/start are refused while Story Mode is off, and nothing is claimed', async () => {
  const ctx = await run(OWNER, ['enter', 'beyond the astral'])
  assert.match(allText(ctx), /Story Mode is off in this group/)
  assert.deepEqual(await slotHolders(), [])
})

test('only an owner or mod can turn it on', async () => {
  const refused = await run(READER, ['on'])
  assert.doesNotMatch(allText(refused), /Story Mode is now \*ON\*/)

  const on = await run(OWNER, ['on'])
  assert.match(allText(on), /Story Mode is now \*ON\*/)
})

// ── 2. Claiming the slot is visible ─────────────────────────────────────────

test('entering claims the slot AND tells the group, tagging the player', async () => {
  const ctx = await run(OWNER, ['enter', 'beyond the astral'])
  const claim = ctx.sent.find(m => typeof m !== 'string' && /Story slot claimed/.test(m.text))
  assert.ok(claim, 'the claim was announced')
  assert.deepEqual(claim.mentions, [OWNER], 'the holder is really mentioned, not a literal @number')
  assert.match(claim.text, /\.story slot/, 'and the announcement says how to check it')
  assert.deepEqual(await slotHolders(), [OWNER])
})

test('".story slot" names the holder and the idle countdown', async () => {
  const ctx = await run(READER, ['slot'])
  assert.match(allText(ctx), /Story slot: held/)
  assert.match(allText(ctx), /15\* minute/, 'the 15-minute window is shown')
  assert.match(allText(ctx), /\.story clear/)
})

test('a second player is refused and told who holds it', async () => {
  const ctx = await run(READER, ['start'])
  assert.match(allText(ctx), /The story slot is taken/)
  assert.match(allText(ctx), /\.story slot/, 'pointed at the new read-only check')
  assert.deepEqual(await slotHolders(), [OWNER], 'the holder did not change')
})

test('continuing does NOT re-announce the same holder', async () => {
  const before = (await slotHolders()).length
  const ctx = await run(OWNER, ['start'])
  assert.doesNotMatch(allText(ctx), /Story slot claimed/, 'no duplicate announcement')
  assert.equal((await slotHolders()).length, before)
})

// ── 3. Handing the slot back is visible ─────────────────────────────────────

test('".story clear" frees the slot and names who had it', async () => {
  const ctx = await run(OWNER, ['clear'])
  assert.match(allText(ctx), /Story slot cleared/)
  assert.match(allText(ctx), /@2347062301848 was holding it/, 'a real tag, not a function body')
  assert.doesNotMatch(allText(ctx), /\(jid\)/, 'regression: bareTag used to be interpolated uncalled')
  assert.deepEqual(await slotHolders(), [])
})

test('finishing a chapter on cooldown releases the slot AND says so', async () => {
  await run(OWNER, ['start']) // take the slot back
  assert.deepEqual(await slotHolders(), [OWNER])

  // Walk the chapter one choice at a time until it completes. Every answer is
  // "1" until the choice that carries the detour — skipped past here.
  for (let i = 0; i < 20; i++) {
    const beat = pendingChoice(OWNER)
    if (!beat) break
    const detourIdx = (beat.options ?? []).findIndex(o => o.detour)
    const answer = detourIdx >= 0 ? '1' : '1' // never take the detour in this test
    const ctx = makeCtx(OWNER)
    await storyMod.handleStoryChoiceReply(ctx, getPlayer(db, OWNER), answer)
    if (/Chapter 1 complete/.test(allText(ctx))) {
      assert.match(allText(ctx), /Story slot is free/, 'the release is announced')
      assert.match(allText(ctx), /next one unlocks in hours/, 'and why')
      break
    }
  }
  assert.deepEqual(await slotHolders(), [], 'the slot really is free after a completed chapter')
})

test('taking a detour releases the slot AND says so', async () => {
  // The chapter cooldown from the test above is still running, so lift it: this
  // test is about the detour release, not the daily chapter cap.
  await updatePlayer(db, OWNER, p => {
    const pr = ensureStoryProgress(p, VOLUME_ID)
    pr.chaptersCompletedInWindow = 0
    pr.lastChapterCompletedAt = 0
    pr.currentChapter = 1
    pr.currentBeat = 0
  })
  await run(OWNER, ['start'])
  assert.deepEqual(await slotHolders(), [OWNER])

  let tookDetour = null
  for (let i = 0; i < 20; i++) {
    const beat = pendingChoice(OWNER)
    if (!beat) break
    const detourIdx = (beat.options ?? []).findIndex(o => o.detour)
    if (detourIdx < 0) {
      const ctx = makeCtx(OWNER)
      await storyMod.handleStoryChoiceReply(ctx, getPlayer(db, OWNER), '1')
      continue
    }
    const ctx = makeCtx(OWNER)
    await storyMod.handleStoryChoiceReply(ctx, getPlayer(db, OWNER), String(detourIdx + 1))
    tookDetour = allText(ctx)
    break
  }
  assert.ok(tookDetour, 'the detour choice was reached and answered')
  assert.match(tookDetour, /went down a detour/, 'the group is told why the baton moved')
  assert.match(tookDetour, /Story slot is free/)
  assert.deepEqual(await slotHolders(), [])

  // And the player who comes back during the lock gets a real answer — without
  // taking the slot. Claiming it first and releasing it a moment later used to
  // post "claimed" and then "free" for a command that did nothing at all.
  const locked = await run(OWNER, ['start'])
  assert.match(allText(locked), /Not yet\. Try again in/)
  assert.doesNotMatch(allText(locked), /Story slot claimed/, 'no claim for an unplayable turn')
  assert.deepEqual(await slotHolders(), [], 'a locked-out start does not re-claim the slot')
})

test('a start on the daily chapter cooldown is refused without touching the slot', async () => {
  await updatePlayer(db, OWNER, p => {
    const pr = ensureStoryProgress(p, VOLUME_ID)
    pr.detourLockedUntil = 0
    pr.pendingDetourResume = null
    pr.completed = false
    pr.chaptersCompletedInWindow = 9
    pr.lastChapterCompletedAt = Date.now()
  })
  const ctx = await run(OWNER, ['start'])
  assert.match(allText(ctx), /Next chapter isn't ready yet/)
  assert.doesNotMatch(allText(ctx), /Story slot claimed/)
  assert.deepEqual(await slotHolders(), [], 'the group is not locked out by a cooldown')
})

test('".story off" frees the holder and says so, tagging them', async () => {
  await updatePlayer(db, OWNER, p => {
    const pr = ensureStoryProgress(p, VOLUME_ID)
    pr.detourLockedUntil = 0
    pr.pendingDetourResume = null
    pr.chaptersCompletedInWindow = 0
    pr.lastChapterCompletedAt = 0
  })
  await run(OWNER, ['start'])
  assert.deepEqual(await slotHolders(), [OWNER])

  const off = await run(OWNER, ['off'])
  const msg = off.sent.find(m => typeof m !== 'string' && /Story Mode is now \*OFF\*/.test(m.text))
  assert.ok(msg, 'the toggle reply rendered')
  assert.deepEqual(msg.mentions, [OWNER], 'the dropped holder is mentioned')
  assert.match(msg.text, /had the story slot/, 'and told their slot was released')
  assert.deepEqual(await slotHolders(), [])
})

test('completing the volume releases the slot and grants its rewards', async () => {
  await run(OWNER, ['on'])
  const volume = getVolume(VOLUME_ID)
  const lastChapter = volume.chapters[volume.chapters.length - 1]

  // Stand the player on the last beat of the last chapter.
  await updatePlayer(db, OWNER, p => {
    const pr = ensureStoryProgress(p, VOLUME_ID)
    pr.currentChapter = lastChapter.num
    pr.currentBeat = 0
    pr.completed = false
    pr.chaptersCompletedInWindow = 0
    pr.lastChapterCompletedAt = 0
  })
  const beats = getResolvedBeats(volume, getPlayer(db, OWNER), VOLUME_ID, lastChapter)
  await updatePlayer(db, OWNER, p => {
    p.storyProgress.volumes[VOLUME_ID].currentBeat = beats.length - 1
  })

  // Standing on the last beat, this single start claims the slot, plays it, and
  // completes the volume — so the release is in this same reply.
  const ctx = await run(OWNER, ['start'])
  assert.match(allText(ctx), /Complete/, 'the volume completion rendered')
  assert.match(allText(ctx), /Story slot is free/, 'and the release was announced')
  assert.match(allText(ctx), /finished the volume/)
  assert.deepEqual(await slotHolders(), [])

  const after = getPlayer(db, OWNER)
  assert.equal(after.storyProgress.volumes[VOLUME_ID].completed, true)
  assert.deepEqual(after.ownedCharacters, ['monica'], 'the volume reward really landed')
  assert.ok(after.inventory.includes('oliver-goggles'))
})
