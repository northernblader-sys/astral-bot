/**
 * ping — proves the full command loop works end-to-end.
 * Usage: <prefix>ping  (or <prefix>p) — prefix is config.prefix, never hardcoded.
 */
export default {
  name: 'ping',
  aliases: ['p'],
  category: 'utility',
  cooldown: 3,
  description: 'Check if the bot is alive and measure round-trip latency',

  async run(ctx) {
    const start = Date.now()
    await ctx.reply('Pong! 🏓')
    const ms = Date.now() - start
    await ctx.reply(`⚡ Latency: *${ms} ms*`)
  },
}
