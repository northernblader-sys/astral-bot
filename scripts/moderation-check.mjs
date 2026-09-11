/**
 * scripts/moderation-check.mjs — behavioural check for the moderation scans.
 *
 * These rules DELETE messages and REMOVE people, so the exemptions matter more
 * than the actions: an admin or the bot owner tripping antichannel would kick
 * the person running the group. Driven through fake sock/msg objects — no
 * WhatsApp connection, no writes to the real group-settings.json.
 *
 *   node scripts/moderation-check.mjs
 */
import assert from 'assert'
import { config } from '../config.js'
import { isChannelForward, isStatusMention } from '../lib/moderation-scan.js'
import { recordForSpam, resetSpamWindow, rememberMessage, takeMessage } from '../lib/message-cache.js'

let pass = 0, fail = 0
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++ }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++ }
}

const GROUP = '120363000000000000@g.us'
const USER  = '999000111222@s.whatsapp.net'

console.log('\nModeration — detection + windows\n')

// ── Channel-forward detection ────────────────────────────────────────────
check('Channel forward is detected via forwardedNewsletterMessageInfo', () => {
  const msg = { message: { extendedTextMessage: { text: 'hi', contextInfo: {
    forwardedNewsletterMessageInfo: { newsletterJid: '1@newsletter', newsletterName: 'X' },
  } } } }
  assert.strictEqual(isChannelForward(msg), true)
})

check('an ORDINARY forward is NOT a Channel forward', () => {
  // forwardingScore/isForwarded is set on every normal forward. Treating it as
  // a Channel forward would kick people for forwarding a friend's message.
  const msg = { message: { extendedTextMessage: { text: 'hi', contextInfo: {
    isForwarded: true, forwardingScore: 5,
  } } } }
  assert.strictEqual(isChannelForward(msg), false)
})

check('a plain text message is not a Channel forward', () => {
  assert.strictEqual(isChannelForward({ message: { conversation: 'hello' } }), false)
})

check('an image caption carrying newsletter info is detected', () => {
  const msg = { message: { imageMessage: { caption: 'x', contextInfo: {
    forwardedNewsletterMessageInfo: { newsletterJid: '2@newsletter' },
  } } } }
  assert.strictEqual(isChannelForward(msg), true)
})

// ── Status-mention detection ─────────────────────────────────────────────
check('status@broadcast remoteJid is a status mention', () => {
  assert.strictEqual(isStatusMention({ key: { remoteJid: 'status@broadcast' }, message: {} }, GROUP), true)
})

check('groupMentions in contextInfo is a status mention', () => {
  const msg = { key: { remoteJid: GROUP }, message: { extendedTextMessage: { text: 'x', contextInfo: {
    groupMentions: [{ groupJid: GROUP, groupSubject: 'The Group' }],
  } } } }
  assert.strictEqual(isStatusMention(msg, GROUP), true)
})

check('an ordinary @mention is NOT a status mention', () => {
  const msg = { key: { remoteJid: GROUP }, message: { extendedTextMessage: { text: '@123 hi', contextInfo: {
    mentionedJid: ['123@s.whatsapp.net'],
  } } } }
  assert.strictEqual(isStatusMention(msg, GROUP), false)
})

// ── Antispam windows ─────────────────────────────────────────────────────
check('flood trips at the configured count, not before', () => {
  resetSpamWindow(GROUP, USER)
  const opts = { count: 5, windowSec: 10 }
  for (let i = 1; i <= 4; i++) {
    const v = recordForSpam(GROUP, USER, `msg ${i}`, opts)
    assert.strictEqual(v.spam, false, `tripped early at message ${i}`)
  }
  const v = recordForSpam(GROUP, USER, 'msg 5', opts)
  assert.strictEqual(v.spam, true)
  assert.strictEqual(v.kind, 'flood')
})

check('duplicates trip before the flood count is reached', () => {
  resetSpamWindow(GROUP, USER)
  const opts = { count: 10, windowSec: 10 }
  recordForSpam(GROUP, USER, 'same', opts)
  recordForSpam(GROUP, USER, 'same', opts)
  const v = recordForSpam(GROUP, USER, 'same', opts)
  assert.strictEqual(v.spam, true, 'three identical messages should trip')
  assert.strictEqual(v.kind, 'duplicate')
})

check('messages outside the window do not accumulate', async () => {
  resetSpamWindow(GROUP, USER)
  const opts = { count: 3, windowSec: 1 }
  recordForSpam(GROUP, USER, 'a', opts)
  recordForSpam(GROUP, USER, 'b', opts)
  // A 1s window means the first two must have aged out before the third.
  const start = Date.now()
  while (Date.now() - start < 1100) { /* busy-wait, keeps the check sync */ }
  const v = recordForSpam(GROUP, USER, 'c', opts)
  assert.strictEqual(v.spam, false, 'stale messages were still counted')
})

check('two users in one group have independent windows', () => {
  resetSpamWindow(GROUP, USER)
  const other = '888000111222@s.whatsapp.net'
  resetSpamWindow(GROUP, other)
  const opts = { count: 3, windowSec: 10 }
  recordForSpam(GROUP, USER, 'x', opts)
  recordForSpam(GROUP, USER, 'y', opts)
  const v = recordForSpam(GROUP, other, 'z', opts)
  assert.strictEqual(v.spam, false, "one user's flood leaked into another's window")
})

// ── Antidelete cache ─────────────────────────────────────────────────────
check('a remembered message can be taken back exactly once', () => {
  rememberMessage('MSGID1', { sender: GROUP, from: USER, body: 'secret' })
  const first = takeMessage('MSGID1')
  assert.ok(first, 'message was not cached')
  assert.strictEqual(first.body, 'secret')
  assert.strictEqual(takeMessage('MSGID1'), null, 'a delete must only repost once')
})

check('an unknown message id returns null', () => {
  assert.strictEqual(takeMessage('NOPE'), null)
})

// ── Owner exemption ──────────────────────────────────────────────────────
const { isOwnerJid, isGroupAdmin } = await import('../lib/group-helpers.js')
check('the configured owner is exempt (would never be kicked)', () => {
  assert.strictEqual(isOwnerJid(`${config.ownerNumbers[0]}@s.whatsapp.net`), true)
  assert.strictEqual(isOwnerJid(USER), false)
})

// ── Admin exemption across addressing modes ──────────────────────────────
// The scan's most dangerous failure mode. Antilink kicks, so an admin lookup
// that misses means the bot removes a group's own admin for posting a link.
// A group may address participants by lid while the incoming `from` is a phone
// number (or the reverse), and either may carry a `:device` suffix — the old
// `pt.id === from` comparison silently returned "not an admin" in every one of
// those cases.
const ADMIN_PN  = '234700000001@s.whatsapp.net'
const ADMIN_LID = '87209327755401@lid'

check('admin matches when the group addresses by the same format', () => {
  const meta = { participants: [{ id: ADMIN_PN, admin: 'admin' }] }
  assert.strictEqual(isGroupAdmin(meta, ADMIN_PN), true)
})

check('admin matches when the group addresses by lid and `from` is a lid', () => {
  const meta = { participants: [{ id: ADMIN_LID, admin: 'superadmin' }] }
  assert.strictEqual(isGroupAdmin(meta, ADMIN_LID), true)
})

check('admin matches across id/jid/lid fields on the participant entry', () => {
  // Baileys populates .jid and .lid alongside .id; `from` may be any of them.
  const meta = { participants: [{ id: ADMIN_LID, jid: ADMIN_PN, lid: ADMIN_LID, admin: 'admin' }] }
  assert.strictEqual(isGroupAdmin(meta, ADMIN_PN), true, 'phone-number form missed')
  assert.strictEqual(isGroupAdmin(meta, ADMIN_LID), true, 'lid form missed')
})

check('admin matches when `from` carries a :device suffix', () => {
  const meta = { participants: [{ id: ADMIN_PN, admin: 'admin' }] }
  assert.strictEqual(isGroupAdmin(meta, '234700000001:5@s.whatsapp.net'), true)
})

check('a NON-admin member is not mistaken for an admin', () => {
  const meta = { participants: [
    { id: ADMIN_PN, admin: 'admin' },
    { id: USER, admin: null },
  ] }
  assert.strictEqual(isGroupAdmin(meta, USER), false)
})

check('a member absent from the participant list is not an admin', () => {
  const meta = { participants: [{ id: ADMIN_PN, admin: 'admin' }] }
  assert.strictEqual(isGroupAdmin(meta, '111000111000@s.whatsapp.net'), false)
})

check('missing/empty metadata is not an admin (fails closed on the exemption)', () => {
  assert.strictEqual(isGroupAdmin(null, ADMIN_PN), false)
  assert.strictEqual(isGroupAdmin({ participants: [] }, ADMIN_PN), false)
  assert.strictEqual(isGroupAdmin({ participants: [{ id: ADMIN_PN, admin: 'admin' }] }, null), false)
})

// ── Antilink: what the scan actually reads ───────────────────────────────
// The rule searches linkText(), not `body`. These assert the shapes that used
// to slip past a body-only check.
const { containsLink } = await import('../lib/group-helpers.js')

check('a link in an image caption is detectable', () => {
  const caption = 'free stuff here bit.ly/3xK9aQ'
  assert.strictEqual(containsLink(caption), true)
})

check('a plain group chat message is not a link', () => {
  assert.strictEqual(containsLink('ok.so anyway see you at 5'), false)
})

// ── Registry: per-platform command resolution ────────────────────────────
// The bug behind ".antilink" replying "Unknown command. Did you mean...?": the
// registry was flat, so plugins-telegram/guard.js (also named 'antilink')
// overwrote plugins/antilink.js and WhatsApp was left with a plugin it could
// not run. Same for .welcome/.setwelcome/.goodbye/.setgoodbye, which exist in
// all three plugin directories.
const { loadPlugins, getPluginFor, setActivePlatform } = await import('../lib/plugin-manager.js')
setActivePlatform('whatsapp')
await loadPlugins('./plugins')
await loadPlugins('./plugins-discord')
await loadPlugins('./plugins-telegram')

for (const name of ['antilink', 'welcome', 'setwelcome', 'goodbye', 'setgoodbye']) {
  check(`.${name} resolves to a WhatsApp-runnable plugin`, () => {
    const plugin = getPluginFor(name, 'whatsapp')
    assert.ok(plugin, `nothing resolved for .${name} on whatsapp`)
    assert.ok(
      !plugin.platforms || plugin.platforms.includes('whatsapp'),
      `.${name} resolved to ${plugin.__sourceFile}, which excludes whatsapp`,
    )
  })
}

check('each platform gets its OWN antilink plugin, not a shared one', () => {
  const wa = getPluginFor('antilink', 'whatsapp')
  const dc = getPluginFor('antilink', 'discord')
  const tg = getPluginFor('antilink', 'telegram')
  assert.strictEqual(wa?.__sourceFile, 'antilink.js')
  assert.notStrictEqual(dc, wa, 'discord got the WhatsApp plugin')
  assert.notStrictEqual(tg, wa, 'telegram got the WhatsApp plugin')
})

check('a WhatsApp-only command does not resolve for Discord', () => {
  // Resolving it anyway is what produced "ctx.sock.groupMetadata is not a
  // function" instead of an honest "unknown command".
  assert.strictEqual(getPluginFor('antichannel', 'discord'), null)
})

check('same-platform alias precedence is unchanged (claim → daily)', () => {
  // 'claim' is an alias of both claim.js and daily.js. daily.js has always been
  // the one that answers; the registry rewrite must not have flipped that.
  assert.strictEqual(getPluginFor('claim', 'whatsapp')?.name, 'daily')
})

// ── Lockout gates: utility commands must survive them ────────────────────
const { isNonRpgCommand, isCollapseBlocked } = await import('../handler.js')

check('.song survives the body-state lockouts', () => {
  assert.strictEqual(isNonRpgCommand('song'), true)
  assert.strictEqual(isNonRpgCommand('mp3'), true, 'the alias must match too')
  assert.strictEqual(isCollapseBlocked('song'), false)
})

check('other utility/group/media commands survive them too', () => {
  for (const cmd of ['menu', 'dload', 'gcsettings', 'antilink', 'submit', 'ban']) {
    assert.strictEqual(isNonRpgCommand(cmd), true, `.${cmd} is still gated`)
  }
})

check('actual RPG commands are still gated', () => {
  for (const cmd of ['mine', 'attack', 'craft', 'travel', 'fish', 'work', 'eat', 'profile']) {
    assert.strictEqual(isNonRpgCommand(cmd), false, `.${cmd} escaped the lockouts`)
  }
})

check('strenuous commands are still collapse-blocked', () => {
  for (const cmd of ['mine', 'craft', 'fish', 'work', 'attack']) {
    assert.strictEqual(isCollapseBlocked(cmd), true, `.${cmd} is no longer collapse-blocked`)
  }
  // and the recovery path still is not
  assert.strictEqual(isCollapseBlocked('eat'), false)
  assert.strictEqual(isCollapseBlocked('travel'), false)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
