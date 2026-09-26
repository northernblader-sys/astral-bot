/**
 * manhwa.js — Search manhwa via WeebCentral, show cover + info,
 * then let the user run .dload <range> to download chapters as PDFs.
 *
 * Commands:
 *   .manhwa <title>    — search and display top result with cover image
 *
 * After a successful search the result is stored in lib/manga-session.js so
 * .dload knows which manhwa to pull chapters from.
 */
import { MANGA } from '@consumet/extensions'
import { setMangaSession } from '../lib/manga-session.js'
import { config } from '../config.js'
import { isOwnerJid } from '../lib/group-helpers.js'
import { isMangaAllowed } from '../lib/manga-allow-repo.js'

const weebcentral = new MANGA.WeebCentral()

/** Fetch full info (chapters + description) for a manhwa ID. */
async function fetchInfo(id) {
  try {
    return await weebcentral.fetchMangaInfo(id)
  } catch {
    return null
  }
}

export default {
  name: 'manhwa',
  aliases: ['manhwadl', 'manhwadownload'],
  category: 'media',
  description: 'Search manhwa and download chapters as PDF — use .dload after searching',

  async run(ctx) {
    const { args, reply, replyImage, from, db } = ctx
    const pr = config.prefix

    if (!isOwnerJid(from) && !isMangaAllowed(db, from)) {
      return reply(`🔒 This command is restricted. Ask the bot owner to *${pr}allow* you.`)
    }

    if (!args.length) {
      return reply(
        `📖 *Manhwa Downloader*\n\n` +
        `Search: *${pr}manhwa <title>*\n` +
        `Then download chapters: *${pr}dload 1-10*\n\n` +
        `Example: *${pr}manhwa solo leveling*`,
      )
    }

    const query = args.join(' ')
    await reply(`🔍 Searching for *${query}*...`)

    let searchResult
    try {
      const data = await weebcentral.search(query)
      searchResult = { provider: weebcentral, providerName: 'WeebCentral', data }
    } catch (err) {
      return reply(`⚠️ Search failed: ${err.message}`)
    }

    const results = searchResult.data?.results ?? []
    if (!results.length) {
      return reply(`❌ No manhwa found for *${query}*.`)
    }

    const top = results[0]
    const manhwaId = top.id

    // Fetch full info so we have chapters + description
    await reply(`📋 Loading details...`)
    const info = await fetchInfo(manhwaId)

    const title       = info?.title || top.title || 'Unknown'
    const description = info?.description || top.description || null
    const image       = info?.image || top.image || null
    const chapters    = info?.chapters ?? []
    const status      = info?.status || top.status || null
    const genres      = info?.genres?.slice(0, 4).join(', ') || null

    // Build caption
    let caption =
      `📖 *${title}*\n` +
      `━━━━━━━━━━━━━━━━━━\n`
    if (status) caption  += `📌 Status: ${status}\n`
    if (genres) caption  += `🏷️ Genres: ${genres}\n`
    if (chapters.length) caption += `📚 Chapters: ${chapters.length}\n`
    caption += `\n`
    if (description) {
      const shortDesc = description.length > 300
        ? description.slice(0, 297) + '...'
        : description
      caption += `📝 ${shortDesc}\n\n`
    }
    caption +=
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 Download chapters with:\n` +
      `*${pr}dload 1* — one chapter\n` +
      `*${pr}dload 1-10* — range of chapters`

    // Store session for .dload
    setMangaSession(from, {
      type:         'manhwa',
      title,
      mangaId:      manhwaId,
      provider:     weebcentral,
      providerName: 'WeebCentral',
      image,
      description,
      chapters,
    })

    if (image) {
      return replyImage(image, caption)
    }
    return reply(caption)
  },
}
