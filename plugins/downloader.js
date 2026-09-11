/**
 * downloader.js — universal media downloader.
 *   .dl <url>          — auto-detect platform & download
 *   .tiktok <url>       .instagram <url>    .pinterest <url>
 *   .facebook <url>     .twitter <url>      .reddit <url>
 *   .soundcloud <url>   .mediafire <url>    .threads <url>
 *   .mega <url>         .sfile <url>        .videy <url>
 *   .spotify <url>
 *   .upscale / .hd      — 2x upscale a replied-to image (needs
 *                         PIXELCUT_API_KEY in .env, replies with a setup
 *                         message if unset rather than crashing)
 *   .calc <expr>        — evaluate a math expression
 *   .shorturl <url>     — shorten a URL via TinyURL
 *   .gethtml <url>      — download raw HTML of a page
 *
 * Also replying to a message containing a link works for .dl.
 *
 * All commands live in this one plugin file, registered as aliases of a
 * single `name: 'dl'` plugin — the run() function inspects ctx.body to see
 * which actual command name was typed and dispatches accordingly. Fetch
 * logic for each platform is adapted from the Astral Utility bot's
 * downloader.js (same upstream APIs: tikwm, api-faa.my.id, nexray), just
 * restructured to this bot's ctx.reply/replyImage plugin shape.
 *
 * Gated to the bot owner or a WhatsApp group admin — same permission model
 * as kick/add/antilink.
 */
import axios    from 'axios'
import FormData from 'form-data'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { isGroupOrBotOwner } from '../lib/group-settings.js'
import { config } from '../config.js'

// ─── URL regexes ──────────────────────────────────────
const RE = {
  tt:  /(?<!\S)https?:\/\/(www\.)?(vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+/gi,
  ig:  /https?:\/\/(www\.)?instagram\.com\/[^\s]+/gi,
  pin: /https?:\/\/(www\.)?(pinterest\.(com|fr|de|co\.uk|jp|ru|ca|it|com\.au|com\.mx|com\.br|es|pl)|pin\.it)\/[^\s]+/gi,
  fb:  /(?<!\S)https?:\/\/(www\.|m\.|web\.)?facebook\.com\/[^\s]+/gi,
  tw:  /(?<!\S)https?:\/\/(www\.)?(twitter\.com|x\.com)\/[^\s]+/gi,
  vd:  /https?:\/\/(www\.)?videy\.co\/[^\s]+/gi,
  th:  /https?:\/\/(www\.)?threads\.(net|com)\/[^\s]+/gi,
  mg:  /https?:\/\/mega\.nz\/[^\s]+/gi,
  sc:  /(?<!\S)https?:\/\/(www\.|on\.)?soundcloud\.com\/[^\s]+/gi,
  sp:  /https?:\/\/open\.spotify\.com\/[^\s]+/gi,
  sf:  /https?:\/\/sfile\.co\/[^\s]+/gi,
  mf:  /(?<!\S)https?:\/\/(www\.)?mediafire\.com\/\S+/gi,
  rd:  /https?:\/\/(www\.)?reddit\.com\/[^\s]+/gi,
}

function detectPlatform(txt) {
  if (!txt) return null
  const c = (m) => m?.[0]?.replace(/[.,!?]$/, '')
  let m
  m = txt.match(RE.tt);  if (m) return { type: 'tt',  url: c(m) }
  m = txt.match(RE.ig);  if (m && !c(m).includes('/stories/')) return { type: 'ig',  url: c(m) }
  m = txt.match(RE.pin); if (m) return { type: 'pin', url: c(m) }
  m = txt.match(RE.fb);  if (m) {
    const u = c(m)
    if (!u.includes('/login') && !u.includes('/dialog') && !u.includes('/plugins/'))
      return { type: 'fb', url: u }
  }
  m = txt.match(RE.tw);  if (m) return { type: 'tw',  url: c(m) }
  m = txt.match(RE.vd);  if (m) return { type: 'vd',  url: c(m) }
  m = txt.match(RE.th);  if (m) return { type: 'th',  url: c(m) }
  m = txt.match(RE.mg);  if (m) return { type: 'mg',  url: c(m) }
  m = txt.match(RE.sc);  if (m) return { type: 'sc',  url: c(m) }
  m = txt.match(RE.sp);  if (m) return { type: 'sp',  url: c(m) }
  m = txt.match(RE.sf);  if (m) return { type: 'sf',  url: c(m) }
  m = txt.match(RE.mf);  if (m) return { type: 'mf',  url: c(m) }
  m = txt.match(RE.rd);  if (m) return { type: 'rd',  url: c(m) }
  return null
}

// ─── HTTP helper ──────────────────────────────────────
const get = (url, params = {}, timeout = 30_000) =>
  axios.get(url, { params, timeout, headers: { 'User-Agent': 'Mozilla/5.0' } })

// ─── Platform fetch functions ─────────────────────────
async function fetchTikTok(url) {
  const { data: d } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`)
  if (d.code !== 0 || !d.data) throw new Error(d.msg || 'TikTok API error')
  return d.data.images?.length
    ? { type: 'images', data: d.data.images }
    : { type: 'video',  data: d.data.play }
}
async function fetchInstagram(url) {
  const { data: d } = await get('https://api-faa.my.id/faa/igdl', { url })
  if (!d.status || !d.result?.url) throw new Error(d.message || 'Instagram API error')
  return { urls: d.result.url, isVideo: d.result.metadata?.isVideo }
}
async function fetchPinterest(url) {
  const { data: d } = await get('https://api-faa.my.id/faa/pin-down', { url })
  if (!d.status || !d.result?.medias) throw new Error(d.message || 'Pinterest API error')
  return d.result.medias
}
async function fetchFacebook(url) {
  const { data: d } = await get('https://api-faa.my.id/faa/fbdownload', { url })
  if (!d.status || !d.result?.media) throw new Error(d.message || 'Facebook API error')
  return d.result.media
}
async function fetchTwitter(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/twitter', { url })
  if (!d.status || !d.result) throw new Error(d.message || 'Twitter/X API error')
  return { type: d.result.type, data: d.result.download_url }
}
async function fetchVidey(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/videy', { url })
  if (!d.status || !d.result) throw new Error(d.message || 'Videy API error')
  return d.result
}
async function fetchMediafire(url) {
  const { data: d } = await get('https://api-faa.my.id/faa/mediafire', { url })
  if (!d.status || !d.result) throw new Error(d.message || 'MediaFire API error')
  return d.result
}
async function fetchThreads(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/threads', { url })
  if (!d.status || !d.result?.media) throw new Error(d.message || 'Threads API error')
  return d.result.media
}
async function fetchMega(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/mega', { url })
  if (!d.status || !d.result) throw new Error(d.message || 'Mega API error')
  return d.result
}
async function fetchSoundCloud(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/soundcloud', { url })
  if (!d.status || !d.result?.url) throw new Error(d.message || 'SoundCloud API error')
  return d.result
}
async function fetchSpotify(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/spotify', { url })
  if (!d.status || !d.result?.url) throw new Error(d.message || 'Spotify API error')
  return d.result
}
async function fetchReddit(url) {
  try {
    const { data: d } = await get('https://api.nexray.web.id/downloader/reddit', { url })
    if (d.status && d.result) return d.result
  } catch {}
  const { data: d } = await get('https://api-faa.my.id/faa/reddit', { url })
  if (!d.status || !d.result) throw new Error(d.message || 'Reddit API error')
  return d.result
}
async function fetchSfile(url) {
  const { data: d } = await get('https://api.nexray.web.id/downloader/sfile', { url })
  if (!d.status || !d.result?.url) throw new Error(d.message || 'Sfile API error')
  return d.result
}

// ─── Send helpers (adapted to ctx.sock / ctx.sender / ctx.msg) ────────
async function sendVideo(ctx, url) {
  return ctx.sock.sendMessage(ctx.sender, { video: { url }, mimetype: 'video/mp4' }, { quoted: ctx.msg })
}
async function sendImage(ctx, url) {
  return ctx.sock.sendMessage(ctx.sender, { image: { url } }, { quoted: ctx.msg })
}
async function sendAudio(ctx, url, fileName) {
  return ctx.sock.sendMessage(ctx.sender, { audio: { url }, mimetype: 'audio/mpeg', fileName }, { quoted: ctx.msg })
}
async function sendDocument(ctx, url, fileName, mime, caption) {
  return ctx.sock.sendMessage(ctx.sender, {
    document: { url }, fileName, mimetype: mime || 'application/octet-stream', caption,
  }, { quoted: ctx.msg })
}

// ─── Per-platform send logic ──────────────────────────
async function sendTikTok(ctx, url) {
  const r = await fetchTikTok(url)
  if (r.type === 'video') await sendVideo(ctx, r.data)
  else for (const img of r.data) await sendImage(ctx, img)
}
async function sendInstagram(ctx, url) {
  const { urls, isVideo } = await fetchInstagram(url)
  if (!urls?.length) throw new Error('no media found')
  for (const link of urls) isVideo ? await sendVideo(ctx, link) : await sendImage(ctx, link)
}
async function sendPinterest(ctx, url) {
  const meds = await fetchPinterest(url)
  if (!meds?.length) throw new Error('no media found')
  const imgs = meds.filter(m => m.type === 'image')
  if (imgs.length) {
    for (const img of imgs) await sendImage(ctx, img.url)
  } else {
    const vid = meds.find(m => m.type === 'video')
    const gif = meds.find(m => m.type === 'gif')
    if (vid) await sendVideo(ctx, vid.url)
    else if (gif) await ctx.sock.sendMessage(ctx.sender, { video: { url: gif.url }, gifPlayback: true }, { quoted: ctx.msg })
  }
}
async function sendFacebook(ctx, url) {
  const med = await fetchFacebook(url)
  if (med.video_hd || med.video_sd) await sendVideo(ctx, med.video_hd || med.video_sd)
  else if (med.photo_image) await sendImage(ctx, med.photo_image)
  else throw new Error('no downloadable media found')
}
async function sendTwitter(ctx, url) {
  const r = await fetchTwitter(url)
  if (r.type === 'image') {
    if (!r.data?.length) throw new Error('no image data found')
    for (const img of r.data) await sendImage(ctx, img.url)
  } else {
    if (!r.data?.length) throw new Error('no video data found')
    const vqs = r.data.filter(i => i.type === 'mp4')
    const best = vqs.find(v => v.resolusi === '768p') || vqs.find(v => v.resolusi === '640p') || vqs[0]
    if (!best) throw new Error('no video URL found')
    await sendVideo(ctx, best.url)
  }
}
async function sendReddit(ctx, url) {
  const r = await fetchReddit(url)
  const videoUrl = r.url || r.video
  if (!videoUrl) throw new Error('no media found')
  const ext = videoUrl.split('?')[0].split('.').pop().toLowerCase()
  if (['mp4', 'mov', 'webm'].includes(ext)) await sendVideo(ctx, videoUrl)
  else await sendImage(ctx, videoUrl)
}
async function sendSoundCloud(ctx, url) {
  const r = await fetchSoundCloud(url)
  await sendAudio(ctx, r.url, r.fileName || 'track.mp3')
}
async function sendSpotify(ctx, url) {
  const r = await fetchSpotify(url)
  await sendAudio(ctx, r.url, `${r.title || 'track'} - ${r.artist || ''}.mp3`.trim())
}
async function sendMediafire(ctx, url) {
  const r = await fetchMediafire(url)
  await sendDocument(ctx, r.download_url, r.filename,
    r.mime ? `application/${r.mime}` : 'application/octet-stream',
    `📄 *${r.filename}*\n📦 ${r.size || '?'}`)
}
async function sendThreads(ctx, url) {
  const meds = await fetchThreads(url)
  if (!meds?.length) throw new Error('no media found')
  const vids = meds.filter(m => m.thumbnail && m.thumbnail !== '-')
  const imgs = meds.filter(m => !m.thumbnail || m.thumbnail === '-')
  if (vids.length) await sendVideo(ctx, vids[0].url)
  else for (const img of imgs) await sendImage(ctx, img.url)
}
async function sendMega(ctx, url) {
  const r = await fetchMega(url)
  const durl = Array.isArray(r.download_url) ? r.download_url[0] : r.download_url
  await sendDocument(ctx, durl, r.filename, r.mimetype, `📄 *${r.filename}*\n📦 ${r.filesize || '?'}`)
}
async function sendVidey(ctx, url) {
  const vu = await fetchVidey(url)
  await sendVideo(ctx, vu)
}
async function sendSfile(ctx, url) {
  const r = await fetchSfile(url)
  await sendDocument(ctx, r.url, r.file_name,
    r.mimetype === '7ZIP' ? 'application/x-7z-compressed' : 'application/octet-stream',
    `📄 *${r.file_name}*\n📦 ${r.size || '?'}`)
}

const SENDERS = {
  tt: sendTikTok, ig: sendInstagram, pin: sendPinterest, fb: sendFacebook,
  tw: sendTwitter, vd: sendVidey, th: sendThreads, mg: sendMega,
  sc: sendSoundCloud, sp: sendSpotify, sf: sendSfile, mf: sendMediafire, rd: sendReddit,
}

const PLATFORM_LABELS = {
  tt: 'TikTok', ig: 'Instagram', pin: 'Pinterest', fb: 'Facebook', tw: 'Twitter/X',
  vd: 'Videy', th: 'Threads', mg: 'Mega', sc: 'SoundCloud', sp: 'Spotify',
  sf: 'Sfile', mf: 'MediaFire', rd: 'Reddit',
}

// cmd/alias → platform type, used by the per-platform plugins below
const CMD_TYPE = {
  tiktok: 'tt', tt: 'tt',
  instagram: 'ig', ig: 'ig',
  twitter: 'tw', tw: 'tw',
  fb: 'fb', facebook: 'fb',
  pinterest: 'pin', pin: 'pin',
  reddit: 'rd',
  soundcloud: 'sc', sc: 'sc',
  mediafire: 'mf', mf: 'mf',
  threads: 'th',
  mega: 'mg',
  sfile: 'sf',
  videy: 'vd',
  spotify: 'sp',
}

async function runPlatform(ctx, forcedType) {
  const { args, reply, sock, sender, msg } = ctx
  const text  = args.join(' ').trim()
  const quotedText =
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || ''
  const input = text || quotedText

  let type = forcedType
  let url  = input

  if (!type) {
    if (!input) {
      return reply(
        '📥 *Usage:* .dl <url>\n' +
        'Supports: TikTok · Instagram · Pinterest · Facebook · Twitter\n' +
        'Threads · Mega · SoundCloud · Spotify · Reddit\n' +
        'Videy · Sfile · MediaFire\n' +
        '_Tip: replying to a link also works_',
      )
    }
    const detected = detectPlatform(input)
    if (!detected) return reply('❌ Unsupported or invalid URL.')
    type = detected.type
    url  = detected.url
  } else {
    if (!input) return reply(`❌ *Usage:* .${ctx.body.slice(1).split(/\s+/)[0]} <url>`)
    const re = RE[type]
    if (re) {
      re.lastIndex = 0
      if (!re.test(input)) return reply(`❌ That doesn't look like a ${PLATFORM_LABELS[type]} link.`)
      re.lastIndex = 0
    }
  }

  await sock.sendMessage(sender, { react: { text: '📥', key: msg.key } }).catch(() => {})
  try {
    await SENDERS[type](ctx, url)
    await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } }).catch(() => {})
  } catch (e) {
    await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
    return reply(`❌ *${PLATFORM_LABELS[type] || 'Download'} failed:* ${e.message || 'unknown error'}`)
  }
}

export default {
  name:        'dl',
  aliases:     [
    'download',
    'tiktok', 'instagram',
    'twitter', 'fb', 'facebook',
    'pinterest',
    'reddit', 'soundcloud',
    'mediafire', 'threads', 'mega', 'sfile', 'videy', 'spotify',
    'upscale', 'hd',
    'calc', 'calculate',
    'shorturl',
    'gethtml',
  ],
  category:    'utility',
  description: 'Universal media downloader — TikTok, Instagram, Pinterest, Facebook, Twitter, Reddit, and more',

  async run(ctx) {
    // Determine which command name/alias was actually typed, since aliases
    // all route to this same plugin object.
    const typedCmd = ctx.body
      .slice(1) // strip prefix (config.prefix is always 1 char '.')
      .trim()
      .split(/\s+/)[0]
      .toLowerCase()

    if (!(await isGroupOrBotOwner(ctx))) {
      return ctx.reply('❌ Only group admins or the bot owner can use this.')
    }

    if (typedCmd === 'calc' || typedCmd === 'calculate') return runCalc(ctx)
    if (typedCmd === 'shorturl') return runShortUrl(ctx)
    if (typedCmd === 'upscale' || typedCmd === 'hd') return runUpscale(ctx)
    if (typedCmd === 'gethtml') return runGetHtml(ctx)

    const platformType = CMD_TYPE[typedCmd] // undefined for 'dl'/'download' → auto-detect
    return runPlatform(ctx, platformType)
  },
}

// ─── .calc ──────────────────────────────────────────────
async function runCalc(ctx) {
  const { args, reply, sock, sender, msg } = ctx
  const text = args.join(' ').trim()
  if (!text) return reply('🧮 *Usage:* .calc 2+2 | (5*8)/2 | 2**10')
  try {
    const safe = text.replace(/[^0-9+\-*/%().^ ]/g, '')
    if (!safe.trim()) throw new Error('invalid expression')
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${safe})`)()
    if (!isFinite(result)) throw new Error('result is not finite')
    await sock.sendMessage(sender, { react: { text: '🧮', key: msg.key } }).catch(() => {})
    return reply(`🧮 *${safe}*\n= *${result}*`)
  } catch {
    await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
    return reply('❌ Invalid expression.')
  }
}

// ─── .shorturl ──────────────────────────────────────────
async function runShortUrl(ctx) {
  const { args, reply, sock, sender, msg } = ctx
  const text = args.join(' ').trim()
  if (!text) return reply('🔗 *Usage:* .shorturl <url>')
  let target = text
  if (!target.startsWith('http://') && !target.startsWith('https://')) target = 'https://' + target

  await sock.sendMessage(sender, { react: { text: '🔗', key: msg.key } }).catch(() => {})
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(target)}`, { timeout: 15_000 })
    const short = res.data?.trim()
    if (!short?.startsWith('http')) throw new Error('invalid response')
    return reply(`🔗 *Original:* ${target}\n*Short:* ${short}`)
  } catch {
    await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
    return reply('❌ Failed to shorten — check the URL.')
  }
}

// ─── .upscale / .hd ──────────────────────────────────────
// Requires PIXELCUT_API_KEY in .env — this bot's config.js does not define
// one by default, so it's read directly from process.env here. If unset,
// the command replies with a clear setup error instead of crashing.
async function runUpscale(ctx) {
  const { reply, sock, sender, msg } = ctx
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
  const target = quoted
    ? { key: { remoteJid: sender, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant }, message: quoted }
    : msg

  const mime = target?.message?.imageMessage ? 'image/jpeg'
    : target?.message?.stickerMessage ? 'image/webp'
    : ''
  if (!mime) return reply('🖼️ *Usage:* .upscale — reply to an image')

  const apiKey = config.pixelcutApiKey
  if (!apiKey) return reply('❌ Upscale isn\'t configured — set PIXELCUT_API_KEY in .env to enable it.')

  await sock.sendMessage(sender, { react: { text: '⏳', key: msg.key } }).catch(() => {})
  try {
    const buf = await downloadMediaMessage(target, 'buffer', {})
    const form = new FormData()
    const isWebp = mime.includes('webp')
    form.append('image', buf, { filename: isWebp ? 'image.webp' : 'image.jpg', contentType: mime })
    form.append('scale', '2')

    const { data: res } = await axios.post('https://api.developer.pixelcut.ai/v1/upscale', form, {
      headers: { ...form.getHeaders(), accept: 'application/json', 'X-API-KEY': apiKey },
      timeout: 60_000,
    })
    if (!res?.result_url) throw new Error('upscale API returned no result')

    await sock.sendMessage(sender, {
      image: { url: res.result_url },
      caption: '🖼️ Image enhanced ✅',
    }, { quoted: msg })
    await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } }).catch(() => {})
  } catch (e) {
    await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
    return reply(`❌ Upscale failed: ${e.message || 'try another image'}`)
  }
}

// ─── .gethtml ────────────────────────────────────────────
async function runGetHtml(ctx) {
  const { args, reply, sock, sender, msg } = ctx
  const text = args.join(' ').trim()
  if (!text) return reply('🔰 *Usage:* .gethtml <url>')

  let target = text
  if (!target.startsWith('http')) target = 'https://' + target

  await sock.sendMessage(sender, { react: { text: '🔰', key: msg.key } }).catch(() => {})
  try {
    const { data: html } = await axios.get(target, {
      timeout: 20_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        Accept: 'text/html,application/xhtml+xml',
      },
      responseType: 'text',
    })
    const hostname = new URL(target).hostname
    await sock.sendMessage(sender, {
      document: Buffer.from(html),
      fileName: `${hostname}.html`,
      mimetype: 'text/html',
      caption: `🔰 *Source:* ${target}`,
    }, { quoted: msg })
    await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } }).catch(() => {})
  } catch (e) {
    await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
    return reply(`❌ Fetch failed: ${e.message || 'unknown error'}`)
  }
}
