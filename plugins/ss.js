/**
 * ss.js — .movies / .ss <title> : Movie & TV Series Search
 *
 * Usage:
 *   .movies inception          — search by title
 *   .movies dune 2021          — with year hint
 *   .ss the mentalist          — short alias works too
 *
 * NOTE: the `.series` alias has been removed — it belongs to the anime
 * collectible game plugin (plugins/series.js). Use .movies or .film instead.
 *
 * Data source: OMDb API (https://www.omdbapi.com) — free tier, 1,000
 * req/day. Key is read from config.omdbApiKey (set it directly in config.js
 * or via OMDB_API_KEY in your .env — both work).
 */
import axios from 'axios'
import { config } from '../config.js'

const OMDB_BASE = 'https://www.omdbapi.com/'

function apiKey() {
  // Accepts the key however it was set in config.js:
  //   omdbApiKey: 'your_key_here'           ← direct hardcode
  //   omdbApiKey: process.env.OMDB_API_KEY  ← via .env
  return config.omdbApiKey || ''
}

function setupMessage() {
  return (
    `🎬 *Movies/TV search isn't configured yet.*\n\n` +
    `Open *config.js* and set your OMDb key directly:\n` +
    `\`omdbApiKey: 'your_key_here',\`\n\n` +
    `Or add to your *.env* file:\n` +
    `\`OMDB_API_KEY=your_key_here\`\n\n` +
    `Get a free key (instant): https://www.omdbapi.com/apikey.aspx`
  )
}

function splitYear(args) {
  const last = args[args.length - 1]
  if (/^(19|20)\d{2}$/.test(last)) {
    return { query: args.slice(0, -1).join(' '), year: last }
  }
  return { query: args.join(' '), year: null }
}

async function omdbGet(params) {
  const { data } = await axios.get(OMDB_BASE, {
    params: { apikey: apiKey(), ...params },
    timeout: 15_000,
  })
  return data
}

function formatResult(d) {
  const lines = []

  const typeLabel = d.Type === 'series' ? '📺 TV Series' : d.Type === 'episode' ? '🎞️ Episode' : '🎬 Movie'
  lines.push(`${typeLabel} · *${d.Title}* (${d.Year})`)

  if (d.Genre && d.Genre !== 'N/A')     lines.push(`🏷️ ${d.Genre}`)
  if (d.Runtime && d.Runtime !== 'N/A') lines.push(`⏱️ ${d.Runtime}`)
  if (d.Rated && d.Rated !== 'N/A')     lines.push(`🔞 ${d.Rated}`)

  lines.push('')

  if (d.imdbRating && d.imdbRating !== 'N/A') {
    lines.push(`⭐ IMDb: *${d.imdbRating}/10* (${d.imdbVotes ?? 'N/A'} votes)`)
  }
  if (Array.isArray(d.Ratings)) {
    for (const r of d.Ratings) {
      if (r.Source === 'Internet Movie Database') continue
      lines.push(`⭐ ${r.Source}: *${r.Value}*`)
    }
  }
  if (d.Metascore && d.Metascore !== 'N/A') lines.push(`⭐ Metascore: *${d.Metascore}/100*`)

  lines.push('')

  if (d.Plot && d.Plot !== 'N/A') lines.push(`📖 ${d.Plot}`)

  lines.push('')

  if (d.Director && d.Director !== 'N/A') lines.push(`🎥 Director: ${d.Director}`)
  if (d.Writer && d.Writer !== 'N/A')     lines.push(`✍️ Writer: ${d.Writer}`)
  if (d.Actors && d.Actors !== 'N/A')     lines.push(`🎭 Cast: ${d.Actors}`)

  if (d.Type === 'series') {
    if (d.totalSeasons && d.totalSeasons !== 'N/A') lines.push(`📅 Seasons: ${d.totalSeasons}`)
  }

  if (d.Released && d.Released !== 'N/A') lines.push(`📆 Released: ${d.Released}`)
  if (d.Country && d.Country !== 'N/A')   lines.push(`🌍 Country: ${d.Country}`)

  lines.push('', `🔗 https://www.imdb.com/title/${d.imdbID}/`)

  return lines.join('\n')
}

export default {
  name: 'movies',
  // 'series' intentionally removed — that command belongs to the anime
  // collectible game plugin (plugins/series.js).
  aliases: ['movie', 'film', 'ss', 'imdb'],
  category: 'utility',
  cooldown: 5,
  description: 'Search for a movie or TV series and get full details (plot, cast, ratings, poster)',

  async run(ctx) {
    const { args, reply, replyImage } = ctx

    if (!apiKey()) return reply(setupMessage())

    if (!args.length) {
      return reply(`❓ Usage: *.movies <title>*\nExample: *.movies inception*`)
    }

    const { query, year } = splitYear(args)
    if (!query) return reply(`❓ Usage: *.movies <title>*\nExample: *.movies inception*`)

    try {
      let details = await omdbGet({ t: query, ...(year ? { y: year } : {}), plot: 'full' })

      if (details.Response === 'False') {
        const search = await omdbGet({ s: query, ...(year ? { y: year } : {}) })
        if (search.Response === 'False' || !search.Search?.length) {
          return reply(`❌ No results found for *${query}*${year ? ` (${year})` : ''}.`)
        }
        const top = search.Search[0]
        details = await omdbGet({ i: top.imdbID, plot: 'full' })
      }

      if (details.Response === 'False') {
        return reply(`❌ No results found for *${query}*${year ? ` (${year})` : ''}.`)
      }

      const caption = formatResult(details)

      if (details.Poster && details.Poster !== 'N/A') {
        return replyImage(details.Poster, caption)
      }
      return reply(caption)
    } catch (err) {
      if (err.response?.status === 401) {
        return reply(`🔑 OMDb key is invalid or expired. Check *omdbApiKey* in config.js.`)
      }
      return reply(`⚠️ Search failed — OMDb API might be down. Try again shortly.`)
    }
  },
}
