/**
 * chunk.js — split long replies to fit a platform's per-message cap.
 *
 * This bot was written against WhatsApp's ~65k limit, so several commands
 * (.menu, .profile, .inventory, .leaderboard) emit text far past Discord's
 * 2000-char ceiling. On WhatsApp that never mattered; on Discord an oversized
 * send is rejected outright and the player sees nothing at all.
 *
 * Splitting is layout-aware, in descending order of preference:
 *   1. paragraph breaks   (blank line)  — keeps sections intact
 *   2. line breaks                      — keeps table rows intact
 *   3. spaces                           — keeps words intact
 *   4. a hard cut                       — only for a single unbroken run
 *
 * Fenced code blocks are reopened across the split so a table that spans two
 * messages doesn't render as raw text in the second half.
 */

/**
 * @param {string} text   the full message body
 * @param {number} limit  platform cap (PLATFORMS[x].textLimit)
 * @returns {string[]}    one or more pieces, each <= limit
 */
export function chunkText(text, limit) {
  const body = String(text ?? '')
  if (body.length <= limit) return [body]

  const pieces = []
  let rest = body

  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    // Prefer the latest clean break point inside the window.
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n')
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = limit          // one unbroken run — hard cut

    pieces.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length) pieces.push(rest)

  return balanceCodeFences(pieces)
}

/**
 * If a piece ends inside an open ``` fence, close it and reopen the next one,
 * preserving the language tag so highlighting survives the split.
 */
function balanceCodeFences(pieces) {
  let carriedTag = null

  return pieces.map(piece => {
    let out = piece
    if (carriedTag !== null) out = `\`\`\`${carriedTag}\n${out}`

    const fences = out.match(/```/g)
    const isOpen = fences ? fences.length % 2 === 1 : false

    if (isOpen) {
      const lastFence = out.lastIndexOf('```')
      const tagLine = out.slice(lastFence + 3).split('\n')[0].trim()
      carriedTag = tagLine || ''
      out += '\n```'
    } else {
      carriedTag = null
    }
    return out
  })
}

/**
 * Truncate to fit a media caption slot, which is much tighter than the text
 * limit on every platform. Returns [caption, overflow] — the caller sends the
 * overflow as follow-up text messages so nothing is silently dropped.
 */
export function splitCaption(text, captionLimit) {
  const body = String(text ?? '')
  if (body.length <= captionLimit) return [body, '']

  const window = body.slice(0, captionLimit)
  let cut = window.lastIndexOf('\n')
  if (cut < captionLimit * 0.5) cut = window.lastIndexOf(' ')
  if (cut <= 0) cut = captionLimit

  return [body.slice(0, cut).trimEnd(), body.slice(cut).trimStart()]
}
