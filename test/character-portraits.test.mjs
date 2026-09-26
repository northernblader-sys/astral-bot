/** All .maiden / .echidna command responses carry their portrait, offline. */
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { config } from '../config.js'
import maiden from '../plugins/maiden.js'
import echidna from '../plugins/echidna.js'

const original = { groq: config.groqApiKey, router: config.openrouterApiKey, fetch: globalThis.fetch }
let apiCalls = 0
beforeEach(() => {
  config.groqApiKey = ''
  config.openrouterApiKey = ''
  apiCalls = 0
  globalThis.fetch = async () => { apiCalls++; throw new Error('unexpected network request') }
})
after(() => {
  config.groqApiKey = original.groq
  config.openrouterApiKey = original.router
  globalThis.fetch = original.fetch
})

let nextId = 0
function context(character, words = '', { owns = true, media = 'ok', child = false } = {}) {
  const from = `portrait-test-${++nextId}@s.whatsapp.net`
  const player = {
    name: 'Tester', level: 42, ownedCharacters: owns ? [character] : [],
    wallet: { solars: 100, gems: 3 },
    ...(child ? { echidnaChild: { name: 'Luna', bornAt: Date.now(), visits: 0, lastVisitAt: 0 } } : {}),
  }
  const images = [], texts = []
  const ctx = {
    from, player, args: words ? words.split(' ') : [], images, texts,
    db: { data: { users: { [from]: player } }, write: async () => {}, read: async () => {} },
    reply: async text => { texts.push(text); return { kind: 'text' } },
  }
  if (media !== 'missing') ctx.replyImage = async (image, caption) => {
    images.push({ image, caption })
    if (media === 'failed') throw new Error('media unavailable')
    return { kind: 'image' }
  }
  return ctx
}

const portraits = [
  { plugin: maiden, character: 'sword_maiden', image: 'https://i.ibb.co/3mKrwxQj/30821578697063150.jpg',
    commands: ['', 'status', 'info', 'help', 'card', 'hug', 'lap', 'headpat', 'forget', 'reset', 'hello', 'hug me please'],
    refused: ['hello', 'hug', 'lap', 'headpat', 'forget', 'reset'], quiet: /lost the thread/ },
  { plugin: echidna, character: 'echidna', image: 'https://i.ibb.co/GhJCg2G/Echidna-Nerd.jpg',
    commands: ['', 'status', 'info', 'help', 'hello', 'child', 'name Luna', 'name'],
    refused: ['hello', 'ritual'], quiet: /quiet moment/ },
]
function assertPortraits(ctx, image, count = 1) {
  assert.equal(ctx.images.length, count)
  assert.equal(ctx.texts.length, 0, 'no duplicate plain text response')
  for (const sent of ctx.images) {
    assert.equal(sent.image, image)
    assert.ok(sent.caption.length > 0)
  }
}

for (const { plugin, character, image, commands, refused, quiet } of portraits) {
  for (const command of commands) test(`${plugin.name} ${command || '(bare)'} carries its portrait`, async () => {
    const ctx = context(character, command)
    const result = await plugin.run(ctx)
    assertPortraits(ctx, image)
    assert.equal(result.kind, 'image')
    assert.equal(apiCalls, 0)
  })

  for (const command of refused) test(`${plugin.name} ${command} dismissal carries its portrait with no API or write`, async () => {
    config.groqApiKey = 'test-only-key'
    const ctx = context(character, command, { owns: false })
    const before = JSON.stringify(ctx.player)
    ctx.db.write = async () => assert.fail('strangers must not write')
    await plugin.run(ctx)
    assertPortraits(ctx, image)
    assert.equal(apiCalls, 0)
    assert.equal(JSON.stringify(ctx.player), before)
  })

  test(`${plugin.name} bare card remains public with its portrait`, async () => {
    const ctx = context(character, '', { owns: false })
    await plugin.run(ctx)
    assertPortraits(ctx, image)
    assert.match(ctx.images[0].caption, /Not yours/)
  })

  for (const media of ['failed', 'missing']) test(`${plugin.name} preserves response text when media is ${media}`, async () => {
    const ctx = context(character, 'hello', { media })
    const result = await plugin.run(ctx)
    assert.equal(ctx.images.length, media === 'failed' ? 1 : 0)
    assert.equal(ctx.texts.length, 1)
    assert.match(ctx.texts[0], quiet)
    if (media === 'failed') assert.equal(ctx.texts[0], ctx.images[0].caption)
    assert.equal(result.kind, 'text')
  })

  test(`${plugin.name} successful AI reply is the portrait caption`, async () => {
    config.groqApiKey = 'test-only-key'
    globalThis.fetch = async () => {
      apiCalls++
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hello, Dear!' } }] }) }
    }
    const ctx = context(character, 'hello')
    await plugin.run(ctx)
    assertPortraits(ctx, image)
    assert.equal(apiCalls, 1)
    assert.equal(ctx.images[0].caption, plugin === maiden ? 'hello dear' : 'Hello, Dear!')
    if (plugin === maiden) assert.equal(ctx.player.maidenChat.at(-1).content, 'hello dear')
  })

  test(`${plugin.name} provider failure still returns a portrait with the quiet reply`, async () => {
    config.groqApiKey = 'test-only-key'
    globalThis.fetch = async () => {
      apiCalls++
      return { ok: false, status: 401, json: async () => ({ error: { message: 'test authentication failure' } }) }
    }
    const ctx = context(character, 'hello')
    await plugin.run(ctx)
    assertPortraits(ctx, image)
    assert.equal(apiCalls, 1)
    assert.match(ctx.images[0].caption, quiet)
  })
}

test('maiden unpronounceable AI reply uses the quiet portrait caption', async () => {
  config.groqApiKey = 'test-only-key'
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '!!!' } }] }) })
  const ctx = context('sword_maiden', 'hello')
  await maiden.run(ctx)
  assertPortraits(ctx, portraits[0].image)
  assert.match(ctx.images[0].caption, portraits[0].quiet)
})

test('every Echidna ritual beat and closing uses her portrait, without changing child rewards', async () => {
  const ctx = context('echidna', 'ritual')
  await echidna.run(ctx)
  assertPortraits(ctx, portraits[1].image, 5)
  assert.ok(ctx.player.echidnaChild.bornAt)
  ctx.images.length = 0
  await echidna.run(ctx)
  assertPortraits(ctx, portraits[1].image)
  assert.match(ctx.images[0].caption, /ONE child/)
})

test('Echidna naming, visits and visit cooldown all keep her portrait', async () => {
  const ctx = context('echidna', 'name Luna', { child: true })
  await echidna.run(ctx)
  assertPortraits(ctx, portraits[1].image)
  assert.equal(ctx.player.echidnaChild.name, 'Luna')
  ctx.images.length = 0
  ctx.args = ['name', 'x'.repeat(25)]
  await echidna.run(ctx)
  assertPortraits(ctx, portraits[1].image)
  assert.match(ctx.images[0].caption, /24 characters/)
  ctx.images.length = 0
  ctx.args = ['child']
  await echidna.run(ctx)
  assertPortraits(ctx, portraits[1].image)
  ctx.images.length = 0
  await echidna.run(ctx)
  assertPortraits(ctx, portraits[1].image)
  assert.match(ctx.images[0].caption, /just saw you/)
})
