/** Send a character's response as a portrait caption, without losing text if media fails. */
export async function replyWithPortrait(ctx, portrait, text) {
  if (typeof ctx.replyImage === 'function') {
    try {
      return await ctx.replyImage(portrait, text)
    } catch {
      // A failed image host or media upload must not swallow her response.
    }
  }
  return ctx.reply(text)
}
