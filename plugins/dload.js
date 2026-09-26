/**
 * dload.js — Download manga/manhwa chapters as PDFs after a .manga or .manhwa search.
 *
 * Usage:
 *   .dload 1        — download chapter 1
 *   .dload 1-10     — download chapters 1 through 10 (sent as separate PDFs)
 *   .dload 5 10     — same as 5-10 (space-separated range also works)
 *
 * Requires a prior .manga or .manhwa search — reads the session stored in
 * lib/manga-session.js keyed by the sender's JID.
 *
 * Each chapter is assembled into a PDF (one image per page) and sent as a
 * document. Chapters are sent consecutively so the user can read them in order.
 */
import axios from 'axios'
import { getMangaSession, clearMangaSession } from '../lib/manga-session.js'
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { isMangaAllowed } from '../lib/manga-allow-repo.js'

// ── PDF generation (pure Node.js, no canvas required) ───────────────────────
// pdfkit is CJS — works fine in an ESM project via Node's CJS interop.
// sharp handles WebP → JPEG conversion (pdfkit only supports JPEG/PNG).
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const PDFDocument = require('pdfkit')
import sharp from 'sharp'

// Standard manga/manhwa page canvas (210 × 297 mm = A4, in points: 595 × 842)
const PAGE_W = 595
const PAGE_H = 842

/** Download a URL and return a Buffer. Retries once on failure. */
async function fetchBuffer(url, referer = 'https://www.mangadex.org/', timeout = 30_000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data } = await axios.get(url, {
        responseType:     'arraybuffer',
        timeout,
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer:      referer,
        },
      })
      const buf = Buffer.from(data)
      if (buf.length < 512) throw new Error('response too small — likely an error page')
      return buf
    } catch (err) {
      if (attempt === 2) throw err
      await new Promise(r => setTimeout(r, 1500))
    }
  }
}

/**
 * Normalise a raw image Buffer to JPEG.
 * pdfkit natively supports JPEG and PNG but not WebP — this converts any
 * WebP page to JPEG so the PDF embeds correctly regardless of source CDN.
 */
async function toEmbeddable(buf) {
  // Detect format by magic bytes
  const isWebP = buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 // RIFF...WEBP
  if (!isWebP) return buf
  return sharp(buf).jpeg({ quality: 90 }).toBuffer()
}

/** Build a PDF Buffer from an array of already-embeddable image Buffers (JPEG/PNG). */
function buildPdf(imageBuffers) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ autoFirstPage: false, margin: 0 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end',  () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    for (const imgBuf of imageBuffers) {
      doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 })
      try {
        doc.image(imgBuf, 0, 0, { fit: [PAGE_W, PAGE_H], align: 'center', valign: 'center' })
      } catch {
        // Unrecognised format — blank placeholder
        doc.fontSize(12).fillColor('gray').text('(page unavailable)', 200, 400)
      }
    }
    doc.end()
  })
}

/**
 * Normalise a chapter number from any provider's shape.
 * - Direct fields: chapterNumber, number, chapter
 * - WeebCentral (and similar): parses "Chapter 12" from the title field
 * - ID-based: parses trailing number from "slug-chapter-12" style IDs
 */
function chapterNum(c) {
  const direct = c.chapterNumber ?? c.number ?? c.chapter
  if (direct != null && direct !== '') return String(direct)

  // Parse from title string (e.g. WeebCentral "Chapter 1")
  if (c.title) {
    const m = String(c.title).match(/chapter\s*(\d+(?:\.\d+)?)/i)
    if (m) return m[1]
  }

  // Parse trailing number from ID (e.g. MangaPill "slug-chapter-1")
  if (c.id) {
    const m = String(c.id).match(/[^\d](\d+(?:\.\d+)?)$/)
    if (m) return m[1]
  }

  return ''
}

/** Find a chapter entry matching a numeric string from the chapters list. */
function findChapter(chapters, num) {
  const target = String(parseFloat(num)) // normalise "001" → "1", "10.5" → "10.5"
  return chapters.find(c => {
    const n = chapterNum(c)
    return n !== '' && String(parseFloat(n)) === target
  }) ?? null
}

/** Summarise the available chapter range in a human-readable string. */
function availableRangeSummary(chapters) {
  const nums = chapters
    .map(c => parseFloat(chapterNum(c)))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b)
  if (!nums.length) return 'unknown'
  const lo = nums[0], hi = nums[nums.length - 1]
  return lo === hi ? `${lo}` : `${lo}–${hi}`
}

/** Parse user input into [start, end] inclusive integers. Returns null on bad input. */
function parseRange(args) {
  // ".dload 1-10"
  const rangeMatch = args[0]?.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) return [parseInt(rangeMatch[1]), parseInt(rangeMatch[2])]

  // ".dload 1 10" or ".dload 1 -10"
  if (args.length >= 2 && /^\d+$/.test(args[0]) && /^\d+$/.test(args[1])) {
    return [parseInt(args[0]), parseInt(args[1])]
  }

  // ".dload 5" — single chapter
  if (/^\d+$/.test(args[0])) {
    const n = parseInt(args[0])
    return [n, n]
  }

  return null
}

export default {
  name: 'dload',
  aliases: ['dlchapter', 'dlch'],
  category: 'media',
  description: 'Download manga/manhwa chapters as PDFs after a .manga or .manhwa search',

  async run(ctx) {
    const { args, reply, sock, sender, msg, from, db } = ctx
    const pr = config.prefix

    if (!isOwnerJid(from) && !isMangaAllowed(db, from)) {
      return reply(`🔒 This command is restricted. Ask the bot owner to *${pr}allow* you.`)
    }

    // ── Validate session ──────────────────────────────────────────────────
    const session = getMangaSession(from)
    if (!session) {
      return reply(
        `❌ No active search found.\n\n` +
        `Search first:\n` +
        `*${pr}manga <title>* — for manga\n` +
        `*${pr}manhwa <title>* — for manhwa`,
      )
    }

    // ── Parse range ───────────────────────────────────────────────────────
    if (!args.length) {
      return reply(
        `📥 *Download chapters*\n\n` +
        `Current: *${session.title}* (${session.type})\n\n` +
        `Usage:\n` +
        `*${pr}dload 1* — chapter 1\n` +
        `*${pr}dload 1-10* — chapters 1 to 10`,
      )
    }

    const range = parseRange(args)
    if (!range) {
      return reply(`⚠️ Invalid range. Examples: *${pr}dload 5* or *${pr}dload 1-10*`)
    }

    const [start, end] = range
    if (start < 1 || end < start || (end - start) > 49) {
      return reply(`⚠️ Range must be 1–50 chapters max and start ≤ end (e.g. *${pr}dload 1-10*).`)
    }

    const { title, provider, chapters } = session
    const total = end - start + 1

    await reply(
      `📥 Downloading *${title}*\n` +
      `Chapters ${start}${end !== start ? `–${end}` : ''} (${total} total)\n\n` +
      `_This may take a while — sending each chapter as it finishes..._`,
    )

    let sent    = 0
    let skipped = 0

    for (let num = start; num <= end; num++) {
      const chapter = findChapter(chapters, num)

      if (!chapter) {
        skipped++
        const range = availableRangeSummary(chapters)
        await reply(
          `⚠️ Chapter ${num} not found.\n` +
          `Available chapters: *${range}*\n` +
          `_(Providers only serve a limited window of chapters.)_`,
        ).catch(() => {})
        continue
      }

      try {
        // Fetch page list
        let pages
        try {
          pages = await provider.fetchChapterPages(chapter.id)
        } catch (err) {
          skipped++
          await reply(`⚠️ Chapter ${num}: couldn't fetch pages — ${err.message}. Skipping.`).catch(() => {})
          continue
        }

        if (!pages?.length) {
          skipped++
          await reply(`⚠️ Chapter ${num}: no pages returned. Skipping.`).catch(() => {})
          continue
        }

        // Download all pages (use per-page Referer if the provider supplies one,
        // e.g. WeebCentral includes headerForImage for hotlink protection)
        const imageBuffers = []
        for (let i = 0; i < pages.length; i++) {
          const pageUrl = pages[i].img || pages[i].url || pages[i].image
          const referer  = pages[i].headerForImage || 'https://www.mangadex.org/'
          if (!pageUrl) continue
          try {
            const raw = await fetchBuffer(pageUrl, referer)
            // Convert WebP → JPEG so pdfkit can embed it (ComicK serves WebP)
            const buf = await sharp(raw).jpeg({ quality: 90 }).toBuffer().catch(() => raw)
            imageBuffers.push(buf)
          } catch {
            // Skip individual failed pages — better a PDF with a gap than no PDF
          }
        }

        if (!imageBuffers.length) {
          skipped++
          await reply(`⚠️ Chapter ${num}: all page downloads failed. Skipping.`).catch(() => {})
          continue
        }

        // Build PDF
        const pdfBuf = await buildPdf(imageBuffers)

        // Send as document
        await sock.sendMessage(
          sender,
          {
            document: pdfBuf,
            fileName: `${title} - Chapter ${num}.pdf`,
            mimetype: 'application/pdf',
            caption:  `📖 *${title}*\n📄 Chapter ${num} • ${imageBuffers.length} pages`,
          },
          { quoted: msg },
        )

        sent++

        // Small pause between chapters to avoid flooding
        if (num < end) await new Promise(r => setTimeout(r, 1200))
      } catch (err) {
        skipped++
        await reply(`⚠️ Chapter ${num} failed: ${err.message}. Skipping.`).catch(() => {})
      }
    }

    // Summary
    const lines = [`✅ Done! Sent *${sent}* chapter PDF${sent !== 1 ? 's' : ''} for *${title}*.`]
    if (skipped) lines.push(`⚠️ ${skipped} chapter${skipped !== 1 ? 's' : ''} skipped (not found or download failed).`)
    lines.push(`\nSearch again anytime with *${pr}manga* or *${pr}manhwa*.`)
    await reply(lines.join('\n')).catch(() => {})
  },
}
