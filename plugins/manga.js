// ═══════════════════════════════════════════════════════
//   📚  MANGAPILL — Manga Downloader
//       Source: mangapill.com
//
//   .pill <title>          → search & auto-load first result
//   .pilldl <n>-<m>        → download chapter range as PDFs
//   .pilldl <n>-end        → download from n to last chapter
//   .pillurl <chapter_url> → download single chapter PDF
//   .pillinfo              → show loaded series
//   .pillhelp              → full help
//
//   ── HOW THE SITE WORKS ───────────────────────────────
//   • Search:  GET /quick-search?title=<query>
//     → Returns HTML fragment with <a href="/manga/<id>/<slug>"> links
//     → Fallback: GET /search?q=<query>
//
//   • Series:  GET /manga/<id>/<slug>
//     → Chapter list: <a href="/chapters/<id>-<numCode>/<slug>">
//     → numCode = 10000000 + Math.round(chapterNum * 1000)
//       e.g. Ch 57.1 → 10057100,  Ch 230 → 10230000
//     → Cover: https://cdn.readdetectiveconan.com/file/mangapill/i/<id>.jpeg
//
//   • Chapter: GET /chapters/<id>-<numCode>/<slug>
//     → Images in <img data-src="..."> tags pointing to CDN
// ═══════════════════════════════════════════════════════

import axios from 'axios'
import * as cheerio from 'cheerio'
import sharp from 'sharp'
import { createRequire } from 'module'
import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { isMangaAllowed } from '../lib/manga-allow-repo.js'

// pdfkit is CJS — same interop pattern as dload.js
const require = createRequire(import.meta.url)
const PDFDocument = require('pdfkit')

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, '../tmp')
fs.mkdirSync(TMP, { recursive: true })

// ── Constants ────────────────────────────────────────────
const SITE = 'https://mangapill.com'
const CDN  = 'cdn.readdetectiveconan.com'
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HEADERS = {
  'User-Agent':      UA,
  'Accept':          'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         SITE + '/',
  'Cache-Control':   'no-cache',
}

// ── Per-chat session store ───────────────────────────────
const pillSessions = new Map()

// ════════════════════════════════════════════════════════
//  SEARCH
//  GET /quick-search?title=<query>  → HTML fragment
//  Fallback: GET /search?q=<query>  → full HTML page
// ════════════════════════════════════════════════════════
async function searchMangaPill(query) {
  const results = []
  const seen    = new Set()

  function parseLinks(html) {
    const $ = cheerio.load(html)
    $('a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const m    = href.match(/^\/manga\/(\d+)\/([^/?#]+)\/?$/)
      if (!m) return
      const [, id, slug] = m
      if (seen.has(id)) return
      seen.add(id)
      const title = $(el).find('div, span, p').first().text().trim()
        || $(el).attr('title')
        || $(el).text().trim()
        || slug.replace(/-/g, ' ')
      const cover = $(el).find('img').attr('data-src')
        || $(el).find('img').attr('src')
        || `https://${CDN}/file/mangapill/i/${id}.jpeg`
      results.push({
        id, slug, title,
        url:   `${SITE}/manga/${id}/${slug}`,
        cover: cover.startsWith('http') ? cover : `https://${CDN}/file/mangapill/i/${id}.jpeg`,
      })
    })
  }

  // Strategy 1: quick-search endpoint (same as the search modal)
  try {
    const res = await axios.get(`${SITE}/quick-search`, {
      params:  { title: query },
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 30000,
    })
    parseLinks(res.data)
  } catch (e) {
    console.warn('[mangapill] quick-search failed:', e.message)
  }

  // Strategy 2: full search page
  if (!results.length) {
    try {
      const res = await axios.get(`${SITE}/search`, {
        params:  { q: query },
        headers: HEADERS,
        timeout: 30000,
      })
      parseLinks(res.data)
    } catch (e) {
      console.warn('[mangapill] /search failed:', e.message)
    }
  }

  return results.slice(0, 20)
}

// ════════════════════════════════════════════════════════
//  SERIES INFO + CHAPTER LIST
// ════════════════════════════════════════════════════════
async function fetchSeriesInfo(seriesUrl) {
  const res = await axios.get(seriesUrl, { headers: HEADERS, timeout: 45000 })
  const $   = cheerio.load(res.data)

  const title  = $('h1').first().text().trim()
    || $('meta[property="og:title"]').attr('content')?.replace(/\s*[-|].*$/, '').trim()
    || 'Unknown'
  const status = $('[class*="status" i]').first().text().trim() || ''
  const genres = []
  $('a[href*="/search?genre"]').each((_, el) => {
    const g = $(el).text().trim()
    if (g && !genres.includes(g)) genres.push(g)
  })

  const mangaId  = seriesUrl.match(/\/manga\/(\d+)\//)?.[1] || ''
  const coverImg = $('img[src*="mangapill"]').first().attr('src')
    || $('img[data-src*="mangapill"]').first().attr('data-src')
    || (mangaId ? `https://${CDN}/file/mangapill/i/${mangaId}.jpeg` : '')

  const chapters = []
  const seen     = new Set()
  $('a[href*="/chapters/"]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const m    = href.match(/\/chapters\/(\d+)-(\d+)\/([^/?#]+)\/?$/)
    if (!m) return
    const [, chapMangaId, numCode, chapSlug] = m
    if (seen.has(numCode)) return
    seen.add(numCode)

    const number = (parseInt(numCode) - 10000000) / 1000
    const label  = $(el).text().trim() || `Chapter ${number}`

    chapters.push({
      number,
      numCode,
      slug:  chapSlug,
      title: label,
      url:   `${SITE}/chapters/${chapMangaId}-${numCode}/${chapSlug}`,
    })
  })

  chapters.sort((a, b) => a.number - b.number)

  return { title, cover: coverImg, status, genres: genres.slice(0, 5), chapters, url: seriesUrl }
}

// ════════════════════════════════════════════════════════
//  CHAPTER IMAGE FETCHING
// ════════════════════════════════════════════════════════
async function fetchChapterImages(chapterUrl) {
  const res  = await axios.get(chapterUrl, {
    headers: { ...HEADERS, 'Referer': chapterUrl },
    timeout: 45000,
  })
  const html = res.data
  const $    = cheerio.load(html)
  const imgs = []
  const seen = new Set()

  function addImg(url) {
    if (!url || seen.has(url)) return
    url = url.replace(/([^:])\/\/+/g, '$1/')
    if (!url.startsWith('http')) return
    seen.add(url)
    imgs.push(url)
  }

  $('img[data-src]').each((_, el) => {
    const src = $(el).attr('data-src') || ''
    if (src.includes(CDN) || src.includes('mangapill')) addImg(src)
  })

  if (!imgs.length) {
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src') || ''
      if ((src.includes(CDN) || src.includes('mangapill')) && !src.includes('favicon') && !src.includes('logo')) {
        addImg(src)
      }
    })
  }

  if (!imgs.length) {
    const re = new RegExp(`https://${CDN}/[^"'\\s>)]+`, 'g')
    let m
    while ((m = re.exec(html)) !== null) {
      const url = m[0].replace(/&amp;/g, '&')
      if (!url.includes('/i/') && !url.includes('favicon') && !url.includes('logo')) addImg(url)
    }
  }

  imgs.sort((a, b) => {
    const na = parseInt(a.match(/\/(\d+)\.[a-z]+(?:\?|$)/i)?.[1] || '0')
    const nb = parseInt(b.match(/\/(\d+)\.[a-z]+(?:\?|$)/i)?.[1] || '0')
    return na - nb
  })

  return imgs
}

// ════════════════════════════════════════════════════════
//  IMAGE DOWNLOAD + PDF BUILDER (uses pdfkit, same as dload.js)
// ════════════════════════════════════════════════════════

/** Download one image and normalise to a pdfkit-embeddable buffer (JPEG/PNG). */
async function downloadImage(imgUrl, chapterUrl) {
  const referer = chapterUrl || SITE + '/'
  let buffer
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(imgUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent':      UA,
          'Accept':          'image/webp,image/avif,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer':         referer,
          'Cache-Control':   'no-cache',
        },
      })
      buffer = Buffer.from(res.data)
      break
    } catch (e) {
      if (attempt === 3) throw e
      await new Promise(r => setTimeout(r, 1200 * attempt))
    }
  }

  // pdfkit supports JPEG and PNG but not WebP/AVIF — convert anything else via sharp
  const isWebP = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57
  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8
  const isPng  = buffer[0] === 0x89 && buffer[1] === 0x50
  if (!isJpeg && !isPng) {
    buffer = await sharp(buffer).jpeg({ quality: 88 }).toBuffer()
  }
  return buffer
}

/** Build a PDF Buffer from an array of image URLs — same pattern as dload.js. */
async function buildPDF(imageUrls, chapterUrl) {
  // Download all images in batches of 8
  const BATCH = 8
  const settled = []
  for (let i = 0; i < imageUrls.length; i += BATCH) {
    const batch = imageUrls.slice(i, i + BATCH)
    const res   = await Promise.allSettled(batch.map(url => downloadImage(url, chapterUrl)))
    settled.push(...res)
  }

  const imageBuffers = []
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      imageBuffers.push(settled[i].value)
    } else {
      console.warn('[mangapill] skipped image:', imageUrls[i], settled[i].reason?.message)
    }
  }

  if (!imageBuffers.length) throw new Error('No images could be downloaded for this chapter.')

  // Build PDF — same stream pattern as dload.js
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ autoFirstPage: false, margin: 0 })
    const chunks = []
    doc.on('data',  c => chunks.push(c))
    doc.on('end',   () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    for (const imgBuf of imageBuffers) {
      // Use natural image size so manga pages aren't squished to A4
      let meta = { width: 595, height: 842 }
      try { meta = require('sharp')(imgBuf).metadata() } catch { /* use defaults */ }
      doc.addPage({ size: [595, 842], margin: 0 })
      try {
        doc.image(imgBuf, 0, 0, { fit: [595, 842], align: 'center', valign: 'center' })
      } catch {
        doc.fontSize(12).fillColor('gray').text('(page unavailable)', 200, 400)
      }
    }

    doc.end()
  })
}

// ════════════════════════════════════════════════════════
//  COMMANDS
// ════════════════════════════════════════════════════════

async function cmdPill(ctx) {
  const { sock, sender, msg, args, reply, react } = ctx

  if (!args.length) return reply(
    `📚 *MangaPill Commands*\n\n` +
    `*.pill <title>*          → search & load series\n` +
    `*.pilldl <n>-<m>*        → download chapter range\n` +
    `*.pilldl <n>-end*        → download n to last chapter\n` +
    `*.pillurl <chapter_url>* → direct chapter PDF\n` +
    `*.pillinfo*              → show loaded series\n\n` +
    `_Source: mangapill.com_`
  )

  const query = args.join(' ').trim()
  await react('⏳')

  let results
  try {
    results = await searchMangaPill(query)
  } catch (e) {
    await react('❌')
    return reply(`❌ Search failed.\n_${e.message}_`)
  }

  if (!results.length) {
    await react('❌')
    return reply(`❌ No results for *${query}* on MangaPill.`)
  }

  const picked = results[0]
  let info
  try {
    info = await fetchSeriesInfo(picked.url)
  } catch (e) {
    await react('❌')
    return reply(`❌ Failed to load series page.\n_${e.message}_`)
  }

  if (!info.chapters.length) {
    await react('❌')
    return reply(`❌ No chapters found for *${info.title}*.`)
  }

  pillSessions.set(sender, {
    series: {
      title:         info.title,
      cover:         info.cover || picked.cover,
      url:           picked.url,
      status:        info.status,
      genres:        info.genres,
      totalChapters: info.chapters.length,
      chapters:      info.chapters,
    }
  })

  const s = pillSessions.get(sender).series
  const caption =
    `📖 *${s.title}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (s.status         ? `📌 ${s.status}\n`              : '') +
    (s.genres?.length ? `🏷️ ${s.genres.join(', ')}\n`   : '') +
    `📖 *${s.totalChapters} chapters available*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 *.pilldl 1-end* to download all\n` +
    `💡 *.pilldl 1-50* to download a range`

  try {
    if (s.cover) {
      const res    = await axios.get(s.cover, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': UA, 'Referer': SITE + '/' } })
      const imgBuf = Buffer.from(res.data)
      await sock.sendMessage(sender, { image: imgBuf, caption }, { quoted: msg })
    } else {
      await reply(caption)
    }
  } catch {
    await reply(caption)
  }

  await react('✅')
}

async function cmdPillInfo(ctx) {
  const { sender, reply } = ctx
  const session = pillSessions.get(sender)
  if (!session?.series) return reply(`❌ No series loaded. Use *.pill <title>* first.`)
  const s = session.series
  return reply(
    `📚 *${s.title}*\n\n` +
    `🔗 ${s.url}\n` +
    `📖 ${s.totalChapters} chapters available\n` +
    `🔢 Ch${s.chapters[0]?.number} – Ch${s.chapters[s.chapters.length - 1]?.number}`
  )
}

async function cmdPillDl(ctx) {
  const { sock, sender, msg, args, reply, react } = ctx
  const session = pillSessions.get(sender)

  if (!session?.series)
    return reply(`❌ No series loaded. Use *.pill <title>* first.`)

  const input = args[0]?.trim()
  if (!input) return reply(
    `❌ Provide a chapter range.\n\nExamples:\n*.pilldl 1-50*\n*.pilldl 1-end*\n*.pilldl 46-46*`
  )

  const series = session.series
  let from, to
  if (input.includes('-')) {
    const [rawA, rawB] = input.split('-')
    from = parseFloat(rawA)
    const bIsEnd = rawB.trim().toLowerCase() === 'end'
    to   = bIsEnd ? Infinity : parseFloat(rawB)
    if (isNaN(from) || (!bIsEnd && isNaN(to)) || from > to)
      return reply(`❌ Invalid range. Example: *.pilldl 1-50* or *.pilldl 1-end*`)
  } else {
    from = parseFloat(input)
    to   = from
    if (isNaN(from)) return reply(`❌ Invalid chapter number.`)
  }

  const targets = series.chapters.filter(c => c.number >= from && c.number <= to)
  if (!targets.length) {
    await react('❌')
    return reply(`❌ No chapters in range ${from}–${to === Infinity ? 'end' : to}. Total loaded: ${series.totalChapters}`)
  }

  await react('⏳')
  const lastNum     = targets[targets.length - 1].number
  const progressMsg = await sock.sendMessage(sender, {
    text:
      `📥 *${series.title}*\n` +
      `Downloading Ch${from}–${to === Infinity ? lastNum : to} (${targets.length} chapters)\n` +
      `⏳ Starting…`,
  }, { quoted: msg })
  const progressKey = progressMsg?.key

  async function updateProgress(done, total, currentNum, failed) {
    if (!progressKey) return
    const pct = Math.round((done / total) * 100)
    const bar = '█'.repeat(Math.round((done / total) * 10)) + '░'.repeat(10 - Math.round((done / total) * 10))
    await sock.sendMessage(sender, {
      text:
        `📥 *${series.title}*\n` +
        `Ch${from}–${to === Infinity ? lastNum : to} — ${done}/${total}\n` +
        `[${bar}] ${pct}%\n` +
        (currentNum !== null ? `📖 Ch${currentNum} done` : '') +
        (failed > 0 ? `  ⚠️ ${failed} failed` : ''),
      edit: progressKey,
    }).catch(() => {})
  }

  let ok = 0, failed = 0
  for (let i = 0; i < targets.length; i++) {
    const ch = targets[i]
    try {
      await cmdPillUrl({ ...ctx, args: [ch.url], react: () => {} })
      ok++
    } catch (e) {
      failed++
      console.warn(`[pilldl] Ch${ch.number} failed:`, e.message)
    }
    await updateProgress(i + 1, targets.length, ch.number, failed)
  }

  await react(ok > 0 ? '✅' : '❌')
  if (ok === 0) await reply(`❌ No chapters could be downloaded.`)
}

async function cmdPillUrl(ctx) {
  const { sock, sender, msg, args, reply, react } = ctx
  const url = args.join(' ').trim()

  if (!url || !url.includes('mangapill.com')) {
    return reply(
      `❌ Provide a valid MangaPill chapter URL.\n\n` +
      `Example:\n*.pillurl https://mangapill.com/chapters/4143-10001000/spy-x-family-chapter-1*`
    )
  }

  await react('⏳')

  try {
    const imgs = await fetchChapterImages(url)

    if (!imgs.length) {
      await react('❌')
      return reply(`❌ No images found at that URL.\n_${url}_`)
    }

    const m           = url.match(/\/chapters\/(\d+)-(\d+)\/([^/?#]+)/)
    const numCode     = m ? parseInt(m[2]) : null
    const chNum       = numCode ? (numCode - 10000000) / 1000 : '?'
    const chapterSlug = m ? m[3] : 'chapter'
    const seriesName  = pillSessions.get(sender)?.series?.title
      || chapterSlug.replace(/-chapter-[\d.]+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

    const pdf  = await buildPDF(imgs, url)
    const safe = seriesName.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 28)

    await sock.sendMessage(sender, {
      document: pdf,
      fileName: `${safe} - Ch${chNum}.pdf`,
      mimetype: 'application/pdf',
      caption:
        `📖 *${seriesName}*\n` +
        `Chapter ${chNum}  •  🖼️ ${imgs.length} pages  •  📦 ${(pdf.length / 1048576).toFixed(1)} MB`,
    }, { quoted: msg })

    await react('✅')
  } catch (e) {
    await react('❌')
    return reply(`❌ Failed: _${e.message}_`)
  }
}

async function cmdPillHelp(ctx) {
  return ctx.reply(
    `📚 *MangaPill — Help*\n\n` +
    `*.pill <title>*\n  Search & auto-load first result\n\n` +
    `*.pilldl <n>-<m>*\n  Download chapter range as PDFs\n\n` +
    `*.pilldl <n>-end*\n  Download from chapter n to last available\n\n` +
    `*.pillurl <chapter_url>*\n  Download a single chapter by direct URL\n\n` +
    `*.pillinfo*\n  Show currently loaded series\n\n` +
    `*─── Notes ────────────────────*\n` +
    `📦 PDFs sent one per chapter\n` +
    `🔢 Decimal chapters supported (e.g. 57.1)\n` +
    `⚡ Source: mangapill.com`
  )
}

// ── Plugin export — registered by lib/plugin-manager.js ──────────────────
export default {
  name: 'pill',
  aliases: ['pilldl', 'pillurl', 'pillinfo', 'pillhelp'],
  category: 'media',
  description: 'Search and download manga chapters as PDFs via MangaPill',

  async run(ctx) {
    if (!isOwnerJid(ctx.from) && !isMangaAllowed(ctx.db, ctx.from)) {
      return ctx.reply(`🔒 This command is restricted. Ask the bot owner to *${config.prefix}allow* you.`)
    }

    const enriched = {
      ...ctx,
      react: (emoji) =>
        ctx.sock.sendMessage(ctx.sender, { react: { text: emoji, key: ctx.msg.key } }).catch(() => {}),
    }
    if (ctx.cmd === 'pill')     return cmdPill(enriched)
    if (ctx.cmd === 'pilldl')   return cmdPillDl(enriched)
    if (ctx.cmd === 'pillurl')  return cmdPillUrl(enriched)
    if (ctx.cmd === 'pillinfo') return cmdPillInfo(enriched)
    if (ctx.cmd === 'pillhelp') return cmdPillHelp(enriched)
  },
}
