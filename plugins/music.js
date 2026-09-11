/**
 * music.js — .song  (search YouTube, download, send as MP3)
 *
 * Download strategy (in order), matching the proven chain from the
 * Astral Utility bot's music.js:
 *   1. qasimdev  api.qasimdev.dpdns.org  ← primary
 *   2. nayan     nayan-video-downloader.vercel.app
 *   3. ytdl-core direct stream           ← last resort
 * Title always comes from the YouTube search result, never the API
 * response — APIs frequently return a generic "Video" title.
 */
import axios       from 'axios'
import yts         from 'yt-search'
import { toAudio } from '../lib/converter.js'

const QASIM_API  = 'https://api.qasimdev.dpdns.org/api/loaderto/download'
const QASIM_KEY  = 'qasim-dev'
const NAYAN_BASE = 'https://nayan-video-downloader.vercel.app'

// ─── Fetch a URL and return a real Buffer ───────────────
async function fetchBuffer(url, timeout = 90_000) {
  const { data } = await axios.get(url, {
    responseType:     'arraybuffer',
    timeout,
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
  })
  const buf = Buffer.from(data)
  if (buf.length < 1024) throw new Error('response too small — likely an error page')
  return buf
}

// ─── YouTube search helper ──────────────────────────────
async function searchYT(query) {
  if (/youtu\.?be/.test(query)) return { url: query, title: query, thumbnail: null, timestamp: '' }
  const { videos } = await yts(query)
  if (!videos?.length) throw new Error('no results found')
  return videos[0]
}

// ─── Source 1: qasimdev (primary) ──────────────────────
async function tryQasim(videoUrl) {
  let lastErr
  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await axios.get(QASIM_API, {
        params:  { apiKey: QASIM_KEY, format: 'mp3', url: videoUrl },
        timeout: 40_000,
      })
      const d   = data?.data
      const url = d?.downloadUrl || d?.url || d?.link || d?.download
      if (!url) throw new Error('qasimdev: no download URL in response')
      const buf = await fetchBuffer(url, 60_000)
      return { buf, ext: 'mp3', thumbnail: d?.thumbnail, source: 'qasimdev' }
    } catch (e) {
      lastErr = e
      if (i === 0) await new Promise(r => setTimeout(r, 2000))
    }
  }
  throw lastErr
}

// ─── Source 2: nayan ────────────────────────────────────
async function tryNayan(videoUrl) {
  const { data } = await axios.get(
    `${NAYAN_BASE}/ytdown?url=${encodeURIComponent(videoUrl)}`,
    { timeout: 20_000 },
  )
  if (!data?.status || !data?.data?.audio) throw new Error('nayan: no audio URL')
  const buf = await fetchBuffer(data.data.audio, 60_000)
  return { buf, ext: 'm4a', thumbnail: data.data.thumb, channel: data.data.channel, source: 'nayan' }
}

// ─── Main download — qasimdev first, then nayan, then ytdl ────────────────
async function downloadAudio(video) {
  try {
    return await tryQasim(video.url)
  } catch {
    try {
      return await tryNayan(video.url)
    } catch {
      const ytdl   = (await import('@distube/ytdl-core')).default
      const chunks = []
      await new Promise((resolve, reject) => {
        ytdl(video.url, { filter: 'audioonly', quality: 'highestaudio' })
          .on('data',  c => chunks.push(c))
          .on('end',   resolve)
          .on('error', reject)
      })
      const buf = Buffer.concat(chunks)
      if (buf.length < 1024) throw new Error('ytdl-core: empty stream')
      return { buf, ext: 'webm', thumbnail: video.thumbnail, source: 'ytdl' }
    }
  }
}

export default {
  name:        'song',
  aliases:     ['mp3'],
  category:    'utility',
  description: 'Search and download a song from YouTube as an MP3',

  async run(ctx) {
    const { args, reply, replyImage, sock, sender, msg } = ctx
    const query = args.join(' ').trim()

    if (!query) {
      return reply('🎵 *Usage:* .song <song name or YouTube link>')
    }

    await reply(`🔎 Searching for *${query}*...`)

    try {
      const video = await searchYT(query)
      const dl    = await downloadAudio(video)

      const title    = video.title || query
      const thumbUrl = dl.thumbnail || video.thumbnail

      if (thumbUrl) {
        await replyImage(
          thumbUrl,
          `🎵 *${title}*\n` +
          `${video.timestamp ? `⏱ ${video.timestamp}\n` : ''}` +
          `${dl.channel     ? `📺 ${dl.channel}\n`      : ''}` +
          `_converting..._`,
        )
      }

      const mp3      = await toAudio(dl.buf, dl.ext)
      const fileName = `${title.replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'track'}.mp3`

      await sock.sendMessage(sender, {
        audio:    mp3,
        mimetype: 'audio/mpeg',
        fileName,
        ptt:      false,
      }, { quoted: msg })
    } catch (e) {
      await reply(`❌ *Download failed:* ${e.message || 'unknown error'}`)
    }
  },
}
