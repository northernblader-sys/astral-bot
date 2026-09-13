/**
 * music.js — .song  (search YouTube Music, download via own song-api, send as MP3)
 *
 * Download source: your own Vercel song-api (https://musicapi-ranz.vercel.app),
 * which uses yt-dlp internally to resolve a direct audio stream URL. This
 * plugin just fetches that URL and converts it to MP3 — no third-party
 * download APIs, no ytdl-core fallback.
 */
import axios       from 'axios'
import { toAudio } from '../lib/converter.js'

const SONG_API = 'https://musicapi-ranz.vercel.app/api/song'

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

// ─── Download source: your own song-api ────────────────
async function tryOwnApi(query) {
  const { data } = await axios.get(SONG_API, {
    params:  { q: query },
    timeout: 15_000,
  })
  if (!data?.audioUrl) throw new Error('song-api: no audioUrl in response')
  const buf = await fetchBuffer(data.audioUrl, 60_000)
  return {
    buf,
    ext:       'm4a',
    thumbnail: data.thumbnail,
    channel:   data.artist,
    duration:  formatDuration(data.duration),
    source:    'song-api',
    title:     data.title,
  }
}

function formatDuration(totalSeconds) {
  if (!totalSeconds && totalSeconds !== 0) return ''
  const m = Math.floor(totalSeconds / 60)
  const s = Math.floor(totalSeconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Main download — song-api only ─────────────────────
async function downloadAudio(query) {
  return tryOwnApi(query)
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
      return reply(
        `╭─────────────╮\n` +
        `   🎵 *SONG DOWNLOADER*\n` +
        `╰─────────────╯\n\n` +
        `*Usage:*\n` +
        `\`.song <song name or YouTube link>\`\n\n` +
        `_Example:_ \`.song faded alan walker\``,
      )
    }

    await reply(`🔍 _Searching for_ *${query}*_..._`)

    try {
      const dl = await downloadAudio(query)

      const title    = dl.title || query
      const thumbUrl = dl.thumbnail

      if (thumbUrl) {
        await replyImage(
          thumbUrl,
          `┏━━━━━━━━━━━━━┓\n` +
          `   🎧 *NOW FETCHING*\n` +
          `┗━━━━━━━━━━━━━┛\n\n` +
          `*🎵 Title:* ${title}\n` +
          `${dl.duration ? `*⏱️ Duration:* ${dl.duration}\n` : ''}` +
          `${dl.channel  ? `*📺 Artist:* ${dl.channel}\n`    : ''}` +
          `\n_⚙️ converting to mp3, please wait..._`,
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
      await reply(
        `❌ *Download Failed*\n` +
        `_${e.message || 'unknown error'}_\n\n` +
        `Try a different song name or check the link.`,
      )
    }
  },
}
