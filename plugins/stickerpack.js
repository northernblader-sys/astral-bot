/**
 * stickerpack.js — .stickerpack <name>
 *   .stickerpack <name>       → 10 stickers (default)
 *   .stickerpack <n> <name>   → n stickers (max 20)
 *
 * Searches Pinterest using the same unofficial API approach as
 * pinterest-dl v1.1.2 (cookie handshake + the x-pinterest-pws-handler
 * header required since 2025-03-07), converts each result to a WhatsApp
 * sticker via ffmpeg, and sends them one by one.
 *
 * Adapted from the Astral Utility bot's stickerpack.js — same Pinterest
 * scraping logic, restructured to this bot's ctx shape and gated the same
 * way as kick/add/antilink (bot owner or WhatsApp group admin) rather than
 * a separate "trusted users" list this bot doesn't have.
 */
import axios     from 'axios'
import { isGroupOrBotOwner } from '../lib/group-settings.js'
import { config } from '../config.js'
import { bufferToSticker } from '../lib/sticker.js'

const DEFAULT_COUNT = 10
const MAX_COUNT     = 20

const UA = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36'

// ════════════════════════════════════════════════════════
//  PINTEREST SESSION
// ════════════════════════════════════════════════════════
async function getPinterestSession() {
  const BASE = 'https://www.pinterest.com'
  const res  = await axios.get(BASE, { timeout: 15_000, headers: { 'User-Agent': UA } })

  const raw = res.headers['set-cookie'] || []
  const cookieStr = raw.map(c => c.split(';')[0]).join('; ')

  const csrfMatch = cookieStr.match(/csrftoken=([^;]+)/)
  const csrf = csrfMatch ? csrfMatch[1] : ''

  return { cookieStr, csrf }
}

function buildSearchUrl(query, pageSize, bookmarks) {
  const source_url = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`
  const options = {
    appliedProductFilters: '---',
    auto_correction_disabled: false,
    bookmarks,
    page_size: pageSize,
    query,
    redux_normalize_feed: true,
    rs: 'typed',
    scope: 'pins',
    source_url,
  }
  const data = JSON.stringify({ options, context: {} })

  const params = new URLSearchParams({
    source_url,
    data,
    _: String(Date.now()),
  }).toString().replace(/\+/g, '%20')

  return `https://www.pinterest.com/resource/BaseSearchResource/get/?${params}`
}

async function searchPinterest(query, want) {
  const { cookieStr, csrf } = await getPinterestSession()

  const headers = {
    'User-Agent':               UA,
    'Accept':                   'application/json, text/javascript, */*; q=0.01',
    'Accept-Language':          'en-US,en;q=0.5',
    'Referer':                  `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`,
    'X-Requested-With':         'XMLHttpRequest',
    'X-Pinterest-AppState':     'active',
    'x-pinterest-pws-handler':  'www/[username]/[slug].js',
    ...(csrf ? { 'X-CSRFToken': csrf } : {}),
    'Cookie':                   cookieStr,
  }

  const urls      = []
  let bookmarks   = []
  const batchSize = Math.min(50, want * 2)
  const maxPasses = 3

  for (let pass = 0; pass < maxPasses && urls.length < want; pass++) {
    const requestUrl = buildSearchUrl(query, batchSize, bookmarks)

    let data
    try {
      const res = await axios.get(requestUrl, { headers, timeout: 20_000 })
      data = res.data
    } catch (e) {
      const status = e?.response?.status
      throw new Error(`Pinterest API error${status ? ` (HTTP ${status})` : ''}: ${e.message}`)
    }

    const resourceResponse = data?.resource_response
    if (!resourceResponse) throw new Error('Pinterest returned unexpected response format')
    if (resourceResponse?.error) {
      const err = resourceResponse.error
      throw new Error(`Pinterest API: ${err.message || JSON.stringify(err)}`)
    }

    const results = resourceResponse?.data?.results || []
    if (!results.length) break

    for (const pin of results) {
      const img = pin?.images?.orig || pin?.images?.['736x'] || pin?.images?.['474x']
      if (!img?.url) continue

      const ratio = (img.width || 1) / (img.height || 1)
      if (ratio > 2.0) continue

      if (!urls.includes(img.url)) urls.push(img.url)
      if (urls.length >= want) break
    }

    const nextBookmarks = data?.resource?.options?.bookmarks
    if (!Array.isArray(nextBookmarks) || nextBookmarks.includes('-end-')) break
    bookmarks = nextBookmarks.slice(-3)

    if (urls.length >= want) break
  }

  if (urls.length < want) {
    const relaxPass = await relaxedSearch(query, want - urls.length, headers, urls)
    urls.push(...relaxPass)
  }

  if (!urls.length) throw new Error(`no Pinterest results for "${query}"`)
  return urls
}

async function relaxedSearch(query, stillNeed, headers, alreadyHave) {
  const extra = []
  try {
    const requestUrl = buildSearchUrl(query, 50, [])
    const { data }   = await axios.get(requestUrl, { headers, timeout: 20_000 })
    const results    = data?.resource_response?.data?.results || []
    for (const pin of results) {
      const img = pin?.images?.orig || pin?.images?.['736x'] || pin?.images?.['474x']
      if (!img?.url || alreadyHave.includes(img.url) || extra.includes(img.url)) continue
      extra.push(img.url)
      if (extra.length >= stillNeed) break
    }
  } catch {}
  return extra
}

// ════════════════════════════════════════════════════════
//  IMAGE DOWNLOAD
// ════════════════════════════════════════════════════════
async function downloadImage(url) {
  const { data } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    headers: {
      'User-Agent': UA,
      'Referer':    'https://www.pinterest.com/',
      'Accept':     'image/webp,image/avif,image/*,*/*;q=0.8',
    },
  })
  return Buffer.from(data)
}

// ════════════════════════════════════════════════════════
//  STICKER BUILDER — see lib/sticker.js for the shared
//  ffmpeg/webpmux conversion (bufferToSticker), used here too
//  so this file and plugins/sticker.js don't drift apart.
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
//  COMMAND
// ════════════════════════════════════════════════════════
export default {
  name:        'stickerpack',
  platforms:   ['whatsapp'],   // named packs have no Discord/Telegram analogue
  requires:    ['stickers'],
  aliases:     [],
  category:    'utility',
  description: 'Generate a named sticker pack from Pinterest images (.stickerpack <name>)',

  async run(ctx) {
    const { args, reply, sock, sender, msg } = ctx

    if (!(await isGroupOrBotOwner(ctx))) {
      return reply('❌ Only group admins or the bot owner can use this.')
    }

    if (!args.length) {
      return reply(
        `🖼️ *Usage:*\n` +
        `• *.stickerpack <name>* — e.g. .stickerpack naruto\n` +
        `• *.stickerpack <count> <name>* — up to ${MAX_COUNT} stickers, e.g. .stickerpack 20 naruto`,
      )
    }

    let count = DEFAULT_COUNT
    let nameParts = [...args]
    const maybeCount = parseInt(args[0])
    if (!isNaN(maybeCount) && args.length > 1) {
      count     = Math.min(Math.max(maybeCount, 1), MAX_COUNT)
      nameParts = args.slice(1)
    }

    const query    = nameParts.join(' ').trim()
    if (!query) return reply('❌ Give the pack a search term, e.g. .stickerpack naruto')

    const packName = query.charAt(0).toUpperCase() + query.slice(1) + ' Sticker Pack'
    const author   = ctx.botName || config.botName || 'Astral of the Sun'

    await sock.sendMessage(sender, { react: { text: '🔍', key: msg.key } }).catch(() => {})
    await reply(`🖼️ *${packName}*\nSearching Pinterest for ${count} images...`)

    let imageUrls
    try {
      imageUrls = await searchPinterest(query, count * 2)
    } catch (e) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply(`❌ *${packName}* — ${e.message}`)
    }

    if (!imageUrls.length) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply(`❌ No images found for "${query}".`)
    }

    let sent = 0, failed = 0
    for (let i = 0; i < imageUrls.length && sent < count; i++) {
      try {
        const buffer  = await downloadImage(imageUrls[i])
        const sticker = await bufferToSticker(buffer, packName, author, false)
        await sock.sendMessage(sender, { sticker }, { quoted: msg })
        sent++
      } catch (e) {
        failed++
        console.warn('[stickerpack] skipped:', e.message)
      }
    }

    if (sent === 0) {
      await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } }).catch(() => {})
      return reply('❌ No images could be converted — try a different query.')
    }

    await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } }).catch(() => {})
    return reply(
      `🖼️ *${packName}*\n` +
      `✅ Sent ${sent} stickers` +
      (failed ? `\n⚠️ ${failed} failed` : ''),
    )
  },
}
