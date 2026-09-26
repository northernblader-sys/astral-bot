import test from 'node:test'
import assert from 'node:assert/strict'
import { glitchResult, showEndworldClash, showCoordinate } from '../lib/witch-heroes-cinematic.js'
import { ART } from '../lib/witch-heroes.js'
const instant = { sleep: async () => {} }
function mock() {
  const calls = [], sent = { key: { id: 'one-result', fromMe: true, remoteJid: 'chat' } }
  return { calls, sent, from: 'owner', db: {}, reply: async text => { calls.push(['reply', text]); return sent },
    replyImage: async (url, text) => calls.push(['image', url, text]),
    editReply: async (message, text) => calls.push(['edit', message, text]) }
}
test('WhatsApp glitch uses one result message and edits that exact message twice', async () => {
  const ctx = mock()
  await glitchResult(ctx, 'Maiden wins!', instant)
  assert.equal(ctx.calls.filter(c => c[0] === 'reply').length, 1)
  const edits = ctx.calls.filter(c => c[0] === 'edit')
  assert.equal(edits.length, 2)
  for (const edit of edits) assert.equal(edit[1], ctx.sent)
  assert.match(edits[0][2], /R E S U L T/)
  assert.equal(edits[1][2], 'Maiden wins!')
})
test('platform without edits gets one clean result, never nonsense', async () => {
  const ctx = mock(); delete ctx.editReply
  await glitchResult(ctx, 'Done', instant)
  assert.deepEqual(ctx.calls, [['reply', 'Done']])
})
test('transient final-edit failure retries the same message without a duplicate result', async () => {
  const ctx = mock(); let edits = 0
  ctx.editReply = async (sent, text) => { edits++; assert.equal(sent, ctx.sent); if (edits === 2) throw new Error('timeout'); ctx.calls.push(['edit', sent, text]) }
  await glitchResult(ctx, 'Correct result', instant)
  assert.equal(edits, 3)
  assert.equal(ctx.calls.filter(c => c[0] === 'reply').length, 1)
  assert.equal(ctx.calls.at(-1)[2], 'Correct result')
})
test('permanent edit failure leaves a readable final result as fallback', async () => {
  const ctx = mock(); ctx.editReply = async () => { throw new Error('offline') }
  await glitchResult(ctx, 'Correct result', instant)
  assert.deepEqual(ctx.calls.at(-1), ['reply', 'Correct result'])
})
test('clash image order is vortex, invisible sword, then same-message glitch/result', async () => {
  const ctx = mock()
  await showEndworldClash(ctx, 'Winner', instant)
  assert.deepEqual(ctx.calls.filter(c => c[0] === 'image').map(c => c[1]), [ART.vortex, ART.invisibleSword])
  assert.equal(ctx.calls.at(-1)[2], 'Winner')
})
test('Coordinate renders only supplied resolved strikes, ending on Coordinate image', async () => {
  const ctx = mock()
  await showCoordinate(ctx, [{ damage: 900, revived: false }], 'Won once', instant)
  assert.equal(ctx.calls.filter(c => c[0] === 'reply').length, 1)
  assert.deepEqual(ctx.calls.at(-1), ['image', ART.coordinate, 'Won once'])
})
test('image failures fall back to text and do not prevent the result', async () => {
  const ctx = mock(); ctx.replyImage = async () => { throw new Error('image unavailable') }
  await showEndworldClash(ctx, 'Winner', instant)
  assert.equal(ctx.calls.at(-1)[2], 'Winner')
})

test('real WhatsApp edit adapter preserves the message key and rejects foreign messages', async () => {
  const { editOwnWhatsAppText } = await import('../lib/platform/whatsapp-edits.js')
  const calls = [], sock = { sendMessage: async (...args) => calls.push(args) }
  const sent = { key: { id: 'our-result', remoteJid: 'chat', fromMe: true, participant: 'bot' } }
  await editOwnWhatsAppText(sock, 'chat', sent, 'Restored')
  assert.deepEqual(calls, [['chat', { text: 'Restored', edit: sent.key }]])
  assert.equal(calls[0][1].edit, sent.key)
  for (const bad of [null, {}, { key: { ...sent.key, remoteJid: 'another-chat' } }, { key: { ...sent.key, fromMe: false } }]) {
    assert.throws(() => editOwnWhatsAppText(sock, 'chat', bad, 'no'))
  }
  assert.equal(calls.length, 1)
})
