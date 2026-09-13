/**
 * music.js — .song  (search YouTube Music, download via own song-api, send as MP3)
 *
 * Download source: your own Vercel song-api (https://musicapi-ranz.vercel.app),
 * which uses yt-dlp internally to resolve a direct audio stream URL. This
 * plugin just fetches that URL and converts it to MP3 — no third-party
 * download APIs, no ytdl-core fallback.
 */
import axios       from 'axios'
import YTMusic     from 'ytmusic-api'
import { toAudio } from '../lib/converter.js'

const SONG_API = 'https://musicapi-ranz.vercel.app/api/song'

// ytmusic-api needs a one-time async init before it can search. We do this
// lazily (on first .song call) and cache the instance so every call after
// the first one is fast. If init ever fails, we retry on the next call
// instead of leaving the plugin permanently broken.
let ytmusic     = null
let ytmusicInit = null

async function getYTMusic() {
  if (ytmusic) return ytmusic
  if (!ytmusicInit) {
    ytmusicInit = (async () => {
      const client = new YTMusic()
      await client.initialize()
      ytmusic = client
      return client
    })().catch(e => {
      ytmusicInit = null // allow retry on next call
      throw e
    })
  }
  return ytmusicInit
}

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

// ─── YouTube Music search helper ────────────────────────
// Returns the same shape the rest of the file already expects:
// { url, title, thumbnail, timestamp }
async function searchYT(query) {
  if (/youtu\.?be/.test(query)) return { url: query, title: query, thumbnail: null, timestamp: '' }

  try {
    const client  = await getYTMusic()
    const results = await client.searchSongs(query)
    if (results?.length) {
      const song = results[0]
      const thumb = song.thumbnails?.[song.thumbnails.length - 1]?.url || null
      return {
        url:       `https://www.youtube.com/watch?v=${song.videoId}`,
        title:     song.artist?.name ? `${song.name} - ${song.artist.name}` : song.name,
        thumbnail: thumb,
        timestamp: song.duration ? formatDuration(song.duration) : '',
      }
    }
  } catch (e) {
    // fall through to yt-search below — don't let a ytmusic-api hiccup
    // (e.g. init failure) take the whole command down
  }

  // fallback: plain YouTube search, in case YT Music has no match
  // (e.g. very obscure or non-music content)
  const yts     = (await import('yt-search')).default
  const { videos } = await yts(query)
  if (!videos?.length) throw new Error('no results found')
  return videos[0]
}

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
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
    source:    'song-api',
    title:     data.title, // song-api's own title, may be more accurate than yt-search's
  }
}

// ─── Main download — song-api only ─────────────────────
async function downloadAudio(video, query) {
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
      const video = await searchYT(query)
      const dl    = await downloadAudio(video, query)

      const title    = dl.title || video.title || query
      const thumbUrl = dl.thumbnail || video.thumbnail

      if (thumbUrl) {
        await replyImage(
          thumbUrl,
          `┏━━━━━━━━━━━━━┓\n` +
          `   🎧 *NOW FETCHING*\n` +
          `┗━━━━━━━━━━━━━┛\n\n` +
          `*🎵 Title:* ${title}\n` +
          `${video.timestamp ? `*⏱️ Duration:* ${video.timestamp}\n` : ''}` +
          `${dl.channel     ? `*📺 Artist:* ${dl.channel}\n`         : ''}` +
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
