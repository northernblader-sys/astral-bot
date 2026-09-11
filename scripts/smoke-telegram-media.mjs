/**
 * Offline exercise of the Telegram media dispatch.
 *
 *   node scripts/smoke-telegram-media.mjs
 *
 * No bot token, no network, no db. `bot.api` is a recorder, so every branch of
 * sendTelegramMedia() can be asserted from the outside: which Bot API method
 * was chosen, and what the file argument actually was.
 *
 * The two shapes that matter are the two that exist in the codebase:
 *
 *   plugins/downloader.js:160  { audio: { url }, mimetype, fileName }
 *   plugins/music.js:134       { audio: <Buffer>, mimetype, fileName, ptt: false }
 *
 * The first MUST stay a plain string all the way to sendAudio — the moment it
 * gets buffered it hits the 12 MB cap in lib/platform/media.js:55 and any track
 * over a few minutes silently sends nothing. That regression is the whole
 * reason this file exists, so it is asserted directly rather than implied.
 */
import { InputFile } from 'grammy'
import {
  telegramMediaKind, sendTelegramMedia,
} from '../adapters/telegram/adapter.js'

/** A bot whose api records calls instead of making them. */
function recorder() {
  const calls = []
  const log = (method) => (chatId, file, opts) => {
    calls.push({ method, chatId, file, opts })
    return { message_id: calls.length }
  }
  return {
    calls,
    api: {
      sendVoice: log('sendVoice'),
      sendAudio: log('sendAudio'),
      sendVideo: log('sendVideo'),
      sendDocument: log('sendDocument'),
      sendPhoto: log('sendPhoto'),
      sendMessage: log('sendMessage'),
    },
  }
}

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const CHAT = 123456789

/* ── kind selection ────────────────────────────────────────────────────── */

console.log('\ntelegramMediaKind()')
check('audio → audio', telegramMediaKind({ audio: {} }) === 'audio')
check('audio + ptt → voice', telegramMediaKind({ audio: {}, ptt: true }) === 'voice')
check('audio + ptt:false → audio', telegramMediaKind({ audio: {}, ptt: false }) === 'audio')
check('video → video', telegramMediaKind({ video: {} }) === 'video')
check('document → document', telegramMediaKind({ document: {} }) === 'document')
check('image → photo', telegramMediaKind({ image: {} }) === 'photo')
check('text only → null', telegramMediaKind({ text: 'hi' }) === null)
check('empty → null', telegramMediaKind() === null)

/* ── the two real call sites ───────────────────────────────────────────── */

console.log('\nplugins/downloader.js shape — { audio: { url }, fileName }')
{
  const bot = recorder()
  const url = 'https://cdn.example.com/track.mp3'
  const sent = await sendTelegramMedia(bot, CHAT, {
    audio: { url }, mimetype: 'audio/mpeg', fileName: 'Never Gonna Give You Up.mp3',
  })
  const [call] = bot.calls
  check('sent something', !!sent)
  check('routed to sendAudio', call?.method === 'sendAudio', call?.method)
  check('url passed through as a plain string', call?.file === url, typeof call?.file)
  check('NOT buffered into InputFile', !(call?.file instanceof InputFile))
  check('title derived from fileName sans extension',
    call?.opts?.title === 'Never Gonna Give You Up', call?.opts?.title)
  check('exactly one api call', bot.calls.length === 1, String(bot.calls.length))
}

console.log('\nplugins/music.js shape — { audio: <Buffer>, fileName, ptt: false }')
{
  const bot = recorder()
  const sent = await sendTelegramMedia(bot, CHAT, {
    audio: Buffer.from('ID3fake-mp3-bytes'),
    mimetype: 'audio/mpeg', fileName: 'song.mp3', ptt: false,
  })
  const [call] = bot.calls
  check('sent something', !!sent)
  check('routed to sendAudio', call?.method === 'sendAudio', call?.method)
  check('bytes wrapped in InputFile', call?.file instanceof InputFile)
}

/* ── remaining branches ────────────────────────────────────────────────── */

console.log('\nevery other payload type reaches its own method')
for (const [label, content, expected] of [
  ['voice note', { audio: Buffer.from('ogg'), ptt: true }, 'sendVoice'],
  ['video', { video: { url: 'https://x.test/v.mp4' } }, 'sendVideo'],
  ['document', { document: Buffer.from('pdf'), fileName: 'doc.pdf' }, 'sendDocument'],
  ['image', { image: { url: 'https://x.test/i.jpg' } }, 'sendPhoto'],
]) {
  const bot = recorder()
  await sendTelegramMedia(bot, CHAT, content)
  check(`${label} → ${expected}`, bot.calls[0]?.method === expected, bot.calls[0]?.method)
}

console.log('\nno media at all')
{
  const bot = recorder()
  const sent = await sendTelegramMedia(bot, CHAT, { text: 'just words' })
  check('returns null so the caller falls back to text', sent === null)
  check('made no api call', bot.calls.length === 0, String(bot.calls.length))
}

console.log('\nempty url is not sent as an empty file')
{
  const bot = recorder()
  const sent = await sendTelegramMedia(bot, CHAT, { audio: { url: '' } })
  check('returns null', sent === null)
  check('made no api call', bot.calls.length === 0, String(bot.calls.length))
}

/* ── captions ──────────────────────────────────────────────────────────── */

console.log('\ncaption longer than the cap overflows into messages, never truncates')
{
  const bot = recorder()
  await sendTelegramMedia(bot, CHAT, {
    audio: { url: 'https://x.test/a.mp3' }, fileName: 'a.mp3',
    caption: 'A'.repeat(20) + ' ' + 'B'.repeat(40),
  }, { captionLimit: 20, textLimit: 25 })

  const audio = bot.calls.find(c => c.method === 'sendAudio')
  const overflow = bot.calls.filter(c => c.method === 'sendMessage')
  check('caption head fits the cap', (audio?.opts?.caption?.length ?? 99) <= 20,
    String(audio?.opts?.caption?.length))
  check('remainder sent as follow-up messages', overflow.length > 0, String(overflow.length))
  const total = (audio?.opts?.caption ?? '') + overflow.map(c => c.file).join('')
  check('no caption text lost', total.replace(/\s/g, '').length === 60,
    String(total.replace(/\s/g, '').length))
}

console.log('\nvoice notes carry no caption, so text goes out separately')
{
  const bot = recorder()
  await sendTelegramMedia(bot, CHAT, { audio: Buffer.from('ogg'), ptt: true, caption: 'listen' })
  const voice = bot.calls.find(c => c.method === 'sendVoice')
  check('sendVoice got no caption option', voice?.opts === undefined)
  check('caption sent as its own message',
    bot.calls.some(c => c.method === 'sendMessage' && c.file === 'listen'))
}

console.log('\nWhatsApp markup in a caption becomes HTML, not raw asterisks')
{
  const bot = recorder()
  await sendTelegramMedia(bot, CHAT, {
    audio: { url: 'https://x.test/a.mp3' }, fileName: 'a.mp3', caption: '*Now playing* <hi>',
  })
  const cap = bot.calls[0]?.opts?.caption ?? ''
  check('*bold* → <b>', cap.includes('<b>Now playing</b>'), cap)
  check('literal < escaped', cap.includes('&lt;hi&gt;'), cap)
  check('parse_mode is HTML', bot.calls[0]?.opts?.parse_mode === 'HTML')
}

console.log(failures ? `\n✖ ${failures} check(s) failed\n` : '\n✓ all checks passed\n')
process.exit(failures ? 1 : 0)
