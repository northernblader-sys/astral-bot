/**
 * Levanter-style music/media plugin.
 *
 * Commands:
 *   .song <song name or YouTube URL>  - native YouTube/YouTube Music -> MP3
 *   .mp3  <song name or YouTube URL>  - alias for .song
 *   .yta  <song name or YouTube URL>  - y2mate -> MP3
 *   .ytv  <YouTube URL>               - y2mate -> selectable MP4 quality
 *   .video [quality] <YouTube URL>    - native YouTube -> MP4 buffer
 *   .spotify <track or playlist URL>  - Levanter Spotify backend -> audio
 *
 * This intentionally contains no license or integrity gate.
 */

import axios from 'axios'
import WebSocket from 'ws'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ffmpeg = require('fluent-ffmpeg')
const ffmpegBinary = require('ffmpeg-static')

if (ffmpegBinary && existsSync(ffmpegBinary)) {
  ffmpeg.setFfmpegPath(ffmpegBinary)
}

const SPOTIFY_BACKEND =
  'https://right-annmaria-lev-8a3a4814.koyeb.app'

const Y2MATE_BASE = 'https://yt1d.io'
const Y2MATE_AJAX = `${Y2MATE_BASE}/wp-admin/admin-ajax.php`
const Y2MATE_RENDER_HOST =
  'https://fpa-balancer.flashydl.space/get-server'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

const TEMP_DIR = join(tmpdir(), 'levanter-music')
const YOUTUBE_ID_RE =
  /(?:v=|\/embed\/|\/shorts\/|youtu\.be\/|\/v\/)([-_0-9A-Za-z]{11})/

const y2mateCache = new Map()
let youtubeModulePromise
const youtubeClients = new Map()

function extractVideoId(input) {
  const value = String(input || '').trim()
  if (/^[-_0-9A-Za-z]{11}$/.test(value)) return value
  return value.match(YOUTUBE_ID_RE)?.[1] || value
}

function isYoutubeInput(input) {
  return /(?:youtube\.com|youtu\.be)/i.test(String(input || ''))
}

function directYoutubeVideo(input) {
  const value = String(input || '').trim()
  const id = extractVideoId(value)
  if (
    (isYoutubeInput(value) || /^[-_0-9A-Za-z]{11}$/.test(value)) &&
    /^[-_0-9A-Za-z]{11}$/.test(id)
  ) {
    return {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: id,
      thumbnail: null,
      duration: '',
      author: '',
    }
  }
  return null
}

function safeFilename(value, fallback = 'track') {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds)
  if (!Number.isFinite(seconds)) return ''
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = Math.floor(seconds % 60)
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

async function ensureTempDir() {
  await mkdir(TEMP_DIR, { recursive: true })
}

async function removeFiles(files) {
  await Promise.all(
    files.filter(Boolean).map((file) => rm(file, { force: true }).catch(() => {})),
  )
}

async function saveReadableStream(stream, destination, youtubeUtils) {
  const output = createWriteStream(destination)

  try {
    const iterable =
      stream && stream[Symbol.asyncIterator]
        ? stream
        : youtubeUtils.streamToIterable(stream)

    for await (const chunk of iterable) {
      if (!output.write(chunk)) {
        await new Promise((resolve) => output.once('drain', resolve))
      }
    }

    await new Promise((resolve, reject) => {
      output.once('finish', resolve)
      output.once('error', reject)
      output.end()
    })
  } catch (error) {
    output.destroy()
    throw error
  }
}

function convertWithFfmpeg(input, output, type = 'audio') {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(input)

    if (type === 'audio') {
      command
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate(192)
        .audioFrequency(44100)
    }

    command
      .on('error', (error) => reject(new Error(`FFmpeg error: ${error.message}`)))
      .on('end', resolve)
      .save(output)
  })
}

function isMp3Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    (buffer.subarray(0, 3).toString() === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
  )
}

async function convertBufferToMp3(buffer) {
  await ensureTempDir()
  const id = randomUUID()
  const source = join(TEMP_DIR, `${id}.source`)
  const output = join(TEMP_DIR, `${id}.mp3`)

  try {
    await writeFile(source, buffer)
    await convertWithFfmpeg(source, output, 'audio')
    return await readFile(output)
  } finally {
    await removeFiles([source, output])
  }
}

async function loadYoutubeModule() {
  if (!youtubeModulePromise) {
    youtubeModulePromise = import('youtubei.js').then(async (youtube) => {
      // youtubei.js uses this platform shim for the same challenge path used
      // by Levanter's native downloader. Older versions may not expose it.
      try {
        if (youtube.Platform?.load && youtube.Platform.shim) {
          youtube.Platform.load({
            ...youtube.Platform.shim,
            eval: (source) => {
              const code = typeof source === 'string' ? source : source.output
              return new Function(code)()
            },
          })
        }
      } catch {
        // The normal InnerTube clients can still work without the shim.
      }
      return youtube
    }).catch((error) => {
      youtubeModulePromise = null
      throw error
    })
  }
  return youtubeModulePromise
}

function youtubeCookie() {
  return process.env.YT_COOKIE || undefined
}

async function getYoutubeClient(clientType = 'WEB') {
  const key = `${clientType}:${youtubeCookie() || ''}`
  if (youtubeClients.has(key)) return youtubeClients.get(key)

  const youtube = await loadYoutubeModule()
  const client = await youtube.Innertube.create({
    cache: new youtube.UniversalCache(false),
    cookie: youtubeCookie(),
    generate_session_locally: true,
    client_type: clientType,
  })

  youtubeClients.set(key, client)
  return client
}

function availableYoutubeClients(youtube, preferred) {
  const knownClients = Object.keys(youtube.Constants?.CLIENTS || {})
  if (!knownClients.length) return preferred

  const selected = preferred.filter((name) => knownClients.includes(name))
  const clientNames = selected.length ? selected : knownClients

  // Constants.CLIENTS is keyed by friendly names such as TV and IOS, but
  // Innertube.create() expects the actual client NAME values such as
  // TVHTML5 and iOS.
  return clientNames.map(
    (name) =>
      youtube.Constants.CLIENTS[name]?.NAME ||
      youtube.ClientType?.[name] ||
      name,
  )
}

async function searchYoutube(query) {
  const input = String(query || '').trim()
  const id = extractVideoId(input)

  if (isYoutubeInput(input) || /^[-_0-9A-Za-z]{11}$/.test(input)) {
    try {
      const client = await getYoutubeClient('WEB')
      const info = await client.getBasicInfo(id)
      return {
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: info.basic_info?.title || id,
        thumbnail: info.basic_info?.thumbnail?.[0]?.url || null,
        duration: info.basic_info?.duration || '',
        author: info.basic_info?.author || '',
      }
    } catch {
      return {
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: id,
        thumbnail: null,
        duration: '',
        author: '',
      }
    }
  }

  const client = await getYoutubeClient('WEB')

  try {
    const musicResults = await client.music.search(input)
    const songs = await musicResults.applyFilter('Songs')
    const section = songs.contents?.[0]
    const result = section?.contents?.find((entry) => entry.title)

    if (result?.id || result?.videoId) {
      const videoId = result.id || result.videoId
      return {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title:
          result.artist?.name
            ? `${result.title} - ${result.artist.name}`
            : result.title,
        thumbnail: result.thumbnail?.contents?.[0]?.url || null,
        duration: result.duration?.seconds
          ? formatDuration(result.duration.seconds)
          : result.duration?.text || '',
        author: result.artist?.name || '',
      }
    }
  } catch {
    // Fall through to ordinary YouTube search, matching Levanter's fallback.
  }

  const searchResults = (await client.search(input, { type: 'video' })).results || []
  const result = searchResults.find((entry) => entry.id && entry.title)
  if (!result) throw new Error('No YouTube result found')

  return {
    id: result.id,
    url: `https://www.youtube.com/watch?v=${result.id}`,
    title: result.title?.text || result.title || input,
    thumbnail: result.thumbnails?.[0]?.url || null,
    duration: result.duration?.text || '',
    author: result.author?.name || '',
  }
}

async function nativeYoutubeAudio(videoId) {
  await ensureTempDir()
  const youtube = await loadYoutubeModule()
  const clientTypes = availableYoutubeClients(youtube, [
    'TV',
    'TV_EMBEDDED',
    'WEB',
    'MWEB',
    'ANDROID',
    'ANDROID_VR',
    'IOS',
  ])
  let lastError

  for (const clientType of clientTypes) {
    const source = join(TEMP_DIR, `${videoId}.${clientType}.m4a`)
    const output = join(TEMP_DIR, `${videoId}.${clientType}.mp3`)

    try {
      const client = await getYoutubeClient(clientType)
      const stream = await client.download(videoId, {
        type: 'audio',
        quality: 'best',
        format: 'mp4',
      })

      await saveReadableStream(stream, source, youtube.Utils)
      await convertWithFfmpeg(source, output, 'audio')
      const buffer = await readFile(output)
      await removeFiles([source, output])
      return buffer
    } catch (error) {
      lastError = error
      await removeFiles([source, output])
    }
  }

  const hint = youtubeCookie()
    ? ''
    : ' YouTube may require a YT_COOKIE value for this video.'
  throw new Error(`All YouTube clients failed: ${lastError?.message || 'unknown error'}.${hint}`)
}

async function nativeYoutubeVideo(videoId, quality = 'best') {
  await ensureTempDir()
  const youtube = await loadYoutubeModule()
  const clientTypes = availableYoutubeClients(youtube, [
    'TV',
    'TV_EMBEDDED',
    'WEB',
    'MWEB',
    'ANDROID',
    'IOS',
  ])
  let lastError

  for (const clientType of clientTypes) {
    const source = join(TEMP_DIR, `${videoId}.${clientType}.mp4`)
    try {
      const client = await getYoutubeClient(clientType)
      const stream = await client.download(videoId, {
        type: 'video+audio',
        quality,
        format: 'mp4',
      })

      await saveReadableStream(stream, source, youtube.Utils)
      const buffer = await readFile(source)
      await removeFiles([source])
      return buffer
    } catch (error) {
      lastError = error
      await removeFiles([source])
    }
  }

  throw new Error(`All YouTube clients failed: ${lastError?.message || 'unknown error'}`)
}

async function getY2mateNonces() {
  const response = await fetch(`${Y2MATE_BASE}/`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
  })
  const html = await response.text()
  return {
    path: new URL(response.url).pathname,
    nonce: html.match(/name="yt1_nonce" value="([^"]+)"/)?.[1],
    mergeNonce: html.match(/"merge_nonce":"([^"]+)"/)?.[1],
  }
}

async function fetchY2mateOptions(videoId) {
  const { path, nonce, mergeNonce } = await getY2mateNonces()
  if (!nonce) throw new Error('y2mate did not return a nonce')

  const response = await fetch(`${Y2MATE_BASE}/results/`, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'content-type': 'application/x-www-form-urlencoded',
      Origin: Y2MATE_BASE,
      Referer: `${Y2MATE_BASE}${path}`,
    },
    body: new URLSearchParams({
      yt1_nonce: nonce,
      _wp_http_referer: path,
      yt_video_url: `https://www.youtube.com/watch?v=${videoId}`,
    }),
  })

  const html = await response.text()
  return [...html.matchAll(/<[^>]*data-token="[^"]*"[^>]*>/g)]
    .map(([tag]) => {
      const attr = (name) =>
        tag.match(new RegExp(`data-${name}="([^"]*)"`))?.[1]

      return {
        token: attr('token'),
        quality: attr('quality'),
        hasAudio: attr('has-audio') === '1',
        size: Number.parseInt(attr('filesize'), 10) || 0,
        title: attr('title'),
        mergeId: attr('merge-id'),
        mergeNonce: attr('merge-nonce') || mergeNonce,
      }
    })
    .filter((option) => option.token && option.quality)
}

async function getY2mateInfo(idOrUrl) {
  const cacheKey = String(idOrUrl)
  if (y2mateCache.has(cacheKey)) return y2mateCache.get(cacheKey)

  const videoId = extractVideoId(idOrUrl)
  const options = await fetchY2mateOptions(videoId)
  if (!options.length) return null

  const video = {}
  const audio = {}

  for (const option of options) {
    if (option.quality === 'MP3') audio['128kbps mp3'] = option
    else video[option.quality] = option
  }

  const info = {
    id: videoId,
    title: options[0].title || videoId,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    video,
    audio,
  }
  y2mateCache.set(cacheKey, info)
  return info
}

async function resolveY2mateStreams(option) {
  const body = new FormData()
  body.append('action', 'yt1_resolve_streams')
  body.append('nonce', option.mergeNonce)
  body.append('token', option.token)
  body.append('quality', option.quality)

  const response = await fetch(Y2MATE_AJAX, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: `${Y2MATE_BASE}/results/`,
    },
    body,
  })
  const json = await response.json().catch(() => ({}))
  if (!json.success || !json.data) throw new Error('y2mate stream resolution failed')

  return {
    videoUrl: json.data.video_url || '',
    audioUrl: json.data.audio_url || '',
  }
}

async function startY2mateRender(request, nonce) {
  const body = new FormData()
  body.append('action', 'process_video_merge')
  body.append('nonce', nonce)
  body.append('request_data', JSON.stringify(request))

  const response = await fetch(Y2MATE_AJAX, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: `${Y2MATE_BASE}/results/`,
    },
    body,
  })
  const json = await response.json().catch(() => ({}))
  if (!json.success) {
    throw new Error(`y2mate render start failed: ${JSON.stringify(json.data || json).slice(0, 160)}`)
  }
}

async function waitForY2mateResult(jobId, timeoutMs = 180000) {
  const hostResponse = await fetch(Y2MATE_RENDER_HOST, {
    headers: { 'User-Agent': BROWSER_UA },
  })
  const host = (await hostResponse.text()).trim()
  if (!host) throw new Error('y2mate did not return a render host')

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${host}/pub/render/status_ws/${jobId}`, {
      headers: { 'User-Agent': BROWSER_UA },
    })

    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('y2mate render timed out'))
    }, timeoutMs)

    socket.on('message', (raw) => {
      let data
      try {
        data = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (data.status === 'done' && data.output?.url) {
        clearTimeout(timer)
        socket.close()
        resolve(data.output.url)
      } else if (data.error) {
        clearTimeout(timer)
        socket.close()
        reject(new Error(JSON.stringify(data.error)))
      }
    })

    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function downloadWithY2mate(idOrUrl, type, quality) {
  const info = y2mateCache.get(String(idOrUrl)) || await getY2mateInfo(idOrUrl)
  if (!info) return null

  const option =
    type === 'audio'
      ? info.audio['128kbps mp3'] || Object.values(info.audio)[0]
      : info.video[quality] || info.video[Object.keys(info.video)[0]]

  if (!option) return null
  const streams = await resolveY2mateStreams(option)

  if (type === 'video' && option.hasAudio && streams.videoUrl) {
    return streams.videoUrl
  }

  const chunkUpload = { size: 209715200, concurrency: 3 }
  const base = {
    id: `${option.mergeId}_${option.quality}`,
    ttl: 3600000,
    chunk: chunkUpload,
  }

  let request
  if (type === 'audio') {
    if (!streams.audioUrl) throw new Error('y2mate returned no audio stream')
    request = {
      id: base.id,
      ttl: base.ttl,
      inputs: [{ url: streams.audioUrl, ext: 'm4a' }],
      output: {
        ext: 'mp3',
        downloadName: `${safeFilename(option.title)}_MP3.mp3`,
        chunkUpload: base.chunk,
      },
      operation: { type: 'no_process' },
    }
  } else {
    if (!streams.videoUrl || !streams.audioUrl) {
      throw new Error('y2mate returned incomplete video streams')
    }
    request = {
      id: base.id,
      ttl: base.ttl,
      inputs: [
        {
          url: streams.videoUrl,
          ext: 'mp4',
          chunkDownload: { type: 'header', size: 52428800, concurrency: 3 },
        },
        { url: streams.audioUrl, ext: 'm4a' },
      ],
      output: {
        ext: 'mp4',
        downloadName: `${safeFilename(option.title)}_${option.quality}.mp4`,
        chunkUpload: base.chunk,
      },
      operation: { type: 'replace_audio_in_video' },
    }
  }

  await startY2mateRender(request, option.mergeNonce)
  return waitForY2mateResult(request.id)
}

async function downloadUrlToBuffer(url, timeout = 180000) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  })
  const buffer = Buffer.from(response.data)
  if (!buffer.length) throw new Error('The media response was empty')
  return buffer
}

function parseContentDisposition(value) {
  if (!value) return ''
  const match = /filename[^;=\n]*=(([\"']).*?\2|[^;\n]*)/.exec(value)
  return match?.[1]?.replace(/['"]/g, '') || ''
}

async function downloadSpotifyTrack(trackOrQuery) {
  const response = await axios.get(
    `${SPOTIFY_BACKEND}/spotify/download/?url=${encodeURIComponent(trackOrQuery)}`,
    {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  )

  const title =
    parseContentDisposition(response.headers['content-disposition']) ||
    (String(trackOrQuery).startsWith('http')
      ? 'track.mp3'
      : `${trackOrQuery}.mp3`)

  return { title, buffer: Buffer.from(response.data) }
}

async function getSpotifyPlaylist(playlistUrl) {
  const response = await axios.get(
    `${SPOTIFY_BACKEND}/spotify/playlist/?url=${encodeURIComponent(playlistUrl)}`,
    { timeout: 120000 },
  )
  return response.data?.result || []
}

function spotifyType(value) {
  const match = String(value || '').match(
    /https:\/\/open\.spotify\.com\/(playlist|track)\/([a-zA-Z0-9]+)/,
  )
  return match?.[1] || false
}

function commandName(ctx) {
  return String(
    ctx.command || ctx.cmd || ctx.trigger || ctx.alias || ctx.name || 'song',
  )
    .replace(/^\./, '')
    .toLowerCase()
}

async function sendAudio(ctx, buffer, title) {
  const { sock, sender, msg } = ctx
  // Some download services return AAC/M4A bytes while labeling the response
  // as MP3. WhatsApp is stricter than the HTTP headers, so normalize anything
  // that is not actually an MP3 before sending it.
  const mp3 = isMp3Buffer(buffer) ? buffer : await convertBufferToMp3(buffer)
  const fileName = safeFilename(title, 'track').replace(/\.mp3$/i, '') + '.mp3'
  return sock.sendMessage(
    sender,
    {
      audio: mp3,
      mimetype: 'audio/mpeg',
      fileName,
      ptt: false,
    },
    { quoted: msg },
  )
}

async function sendY2mateQualityList(ctx, info) {
  const rows = Object.keys(info.video).map((quality) => ({
    title: quality,
    rowId: `ytv y2mate;${quality};${info.id}`,
    description: info.video[quality].size
      ? `${(info.video[quality].size / 1000000).toFixed(1)} MB`
      : 'YouTube video',
  }))

  const listMessage = {
    text: `${info.title}\n\nChoose a video quality:`,
    footer: 'Levanter video downloader',
    title: 'YouTube video',
    buttonText: 'Choose quality',
    sections: [{ title: 'Available qualities', rows }],
  }

  try {
    return await ctx.sock.sendMessage(ctx.sender, listMessage, { quoted: ctx.msg })
  } catch {
    return ctx.reply(
      `Available qualities for *${info.title}*:\n\n` +
      rows.map((row) => `• ${row.title}`).join('\n') +
      `\n\nUse: .ytv <quality> <YouTube URL>`,
    )
  }
}

async function runSong(ctx, query) {
  await ctx.reply(`🔍 Searching YouTube Music for *${query}*...`)
  const video = await searchYoutube(query)

  if (video.thumbnail && ctx.replyImage) {
    await ctx.replyImage(
      video.thumbnail,
      `🎧 *${video.title}*\n` +
        `${video.duration ? `⏱️ ${video.duration}\n` : ''}` +
        `${video.author ? `🎤 ${video.author}\n` : ''}` +
        `\n_Converting to MP3..._`,
    )
  }

  try {
    const buffer = await nativeYoutubeAudio(video.id)
    return sendAudio(ctx, buffer, video.title)
  } catch (nativeError) {
    // YouTube may reject an anonymous native stream even when search works.
    // Keep .song usable without cookies by falling back to the same y2mate
    // audio path exposed by .yta.
    const info = await getY2mateInfo(video.id)
    const url = info && await downloadWithY2mate(video.id, 'audio')
    if (!url) {
      throw new Error(
        `Native YouTube failed (${nativeError.message}); y2mate fallback also failed`,
      )
    }
    const buffer = await downloadUrlToBuffer(url)
    return sendAudio(ctx, buffer, info.title || video.title)
  }
}

async function runYta(ctx, query) {
  // Match Levanter's yta path: a direct YouTube URL goes straight to
  // y2mate and does not require a separate native YouTube metadata request.
  const video = directYoutubeVideo(query) || await searchYoutube(query)
  const info = await getY2mateInfo(video.id)
  if (!info) throw new Error('No audio format was returned by y2mate')

  await ctx.reply(`⬇️ Downloading *${info.title}* as MP3...`)
  const url = await downloadWithY2mate(video.id, 'audio')
  if (!url) throw new Error('No MP3 was returned by y2mate')

  // Keep the output as a Buffer, like Levanter's native song() helper.
  return sendAudio(ctx, await downloadUrlToBuffer(url), info.title)
}

async function runYtv(ctx, query) {
  const parts = query.split(';')
  if (parts[0] === 'y2mate' && parts[1] && parts[2]) {
    const quality = parts[1]
    const id = parts[2]
    const url = await downloadWithY2mate(id, 'video', quality)
    if (!url) throw new Error('No video was returned by y2mate')
    const buffer = await downloadUrlToBuffer(url)
    return ctx.sock.sendMessage(
      ctx.sender,
      {
        video: buffer,
        mimetype: 'video/mp4',
        fileName: `${id}_${quality}.mp4`,
      },
      { quoted: ctx.msg },
    )
  }

  const qualityRequest = query.match(/^(144p|240p|360p|480p|720p|1080p)\s+(.+)$/i)
  const input = qualityRequest?.[2] || query
  const video = directYoutubeVideo(input) || await searchYoutube(input)
  const info = await getY2mateInfo(video.id)
  if (!info || !Object.keys(info.video).length) {
    throw new Error('No video qualities were returned by y2mate')
  }

  if (qualityRequest) {
    const url = await downloadWithY2mate(video.id, 'video', qualityRequest[1])
    if (!url) throw new Error('No video was returned by y2mate')
    const buffer = await downloadUrlToBuffer(url)
    return ctx.sock.sendMessage(
      ctx.sender,
      {
        video: buffer,
        mimetype: 'video/mp4',
        fileName: `${safeFilename(info.title)}_${qualityRequest[1]}.mp4`,
      },
      { quoted: ctx.msg },
    )
  }

  return sendY2mateQualityList(ctx, info)
}

async function runNativeVideo(ctx, query) {
  const match = query.match(
    /^(144p|240p|360p|480p|720p|1080p|best)\s+(.+)$/i,
  )
  const quality = match?.[1]?.toLowerCase() || 'best'
  const input = match?.[2] || query
  const video = directYoutubeVideo(input) || await searchYoutube(input)

  await ctx.reply(
    `🎬 Downloading *${video.title}*${quality === 'best' ? '' : ` at ${quality}`}...`,
  )
  const buffer = await nativeYoutubeVideo(video.id, quality)
  const fileName = `${safeFilename(video.title)}_${quality}.mp4`

  return ctx.sock.sendMessage(
    ctx.sender,
    { video: buffer, mimetype: 'video/mp4', fileName },
    { quoted: ctx.msg },
  )
}

async function runSpotify(ctx, query) {
  const type = spotifyType(query)
  if (!type) throw new Error('Send a Spotify track or playlist URL')

  if (type === 'track') {
    const track = await downloadSpotifyTrack(query)
    return sendAudio(ctx, track.buffer, track.title)
  }

  const playlist = await getSpotifyPlaylist(query)
  await ctx.reply(`⬇️ Downloading ${playlist.length} Spotify tracks...`)

  for (const song of playlist) {
    try {
      const track = await downloadSpotifyTrack(song.title)
      await sendAudio(ctx, track.buffer, track.title || song.title)
    } catch {
      // Match Levanter's playlist behavior: continue when one track fails.
    }
  }
}

export default {
  name: 'song',
  aliases: ['mp3', 'audio', 'yta', 'ytv', 'video', 'ytvideo', 'spotify'],
  category: 'download',
  description: 'All-in-one Levanter-style music and video downloader',

  async run(ctx) {
    const command = commandName(ctx)
    const query = (ctx.args || []).join(' ').trim()

    if (!query) {
      return ctx.reply(
        '🎵 *MUSIC DOWNLOADER*\n\n' +
          '`.song <song name or YouTube link>` — native YouTube MP3\n' +
          '`.video [quality] <YouTube link>` — native YouTube MP4\n' +
          '`.yta <song name or YouTube link>` — y2mate MP3\n' +
          '`.ytv <YouTube link>` — choose video quality\n' +
          '`.spotify <Spotify track or playlist>` — Spotify download',
      )
    }

    try {
      // Row IDs generated by .ytv start with "y2mate;" and are passed to the
      // plugin as the command arguments by the normal Baileys command parser.
      if (command === 'spotify') return await runSpotify(ctx, query)
      if (command === 'yta') return await runYta(ctx, query)
      if (command === 'ytv') return await runYtv(ctx, query)
      if (command === 'video' || command === 'ytvideo') {
        return await runNativeVideo(ctx, query)
      }

      // Some routers expose only the plugin name for aliases. These prefixes
      // keep the Levanter commands usable even with that router shape.
      if (/^spotify\s+/i.test(query)) {
        return await runSpotify(ctx, query.replace(/^spotify\s+/i, ''))
      }
      if (/^yta\s+/i.test(query)) {
        return await runYta(ctx, query.replace(/^yta\s+/i, ''))
      }
      if (/^ytv\s+/i.test(query)) {
        return await runYtv(ctx, query.replace(/^ytv\s+/i, ''))
      }
      if (/^(?:video|ytvideo)\s+/i.test(query)) {
        return await runNativeVideo(
          ctx,
          query.replace(/^(?:video|ytvideo)\s+/i, ''),
        )
      }

      return await runSong(ctx, query)
    } catch (error) {
      return ctx.reply(
        `❌ *Download failed*\n_${error?.message || 'Unknown error'}_`,
      )
    }
  },
}