/**
 * contactteam — forwards a message from the player straight to the owner's DM.
 * Usage: <prefix>contactteam <your message>
 */
import { config } from '../config.js'

export default {
  name: 'contactteam',
  aliases: ['contact'],
  category: 'utility',
  cooldown: 30, // prevent spam-forwarding to the owner
  description: 'Send a message directly to the dev team',

  async run(ctx) {
    const pr = config.prefix
    const message = ctx.args?.join(' ').trim()

    if (!message) {
      return ctx.reply(`Usage: *${pr}contactteam <your message>*\nExample: *${pr}contactteam the craft command isn't working*`)
    }

    const ownerNumber = (config.ownerNumbers ?? [])[0]
    if (!ownerNumber) {
      return ctx.reply(`⚠️ No owner configured to receive messages right now — try again later.`)
    }

    const ownerJid = `${ownerNumber.replace(/\D/g, '')}@s.whatsapp.net`
    const senderName = ctx.player?.name ?? ctx.from

    try {
      await ctx.sock.sendMessage(ownerJid, {
        text: `📨 *Player message* (from ${senderName})\n\n${message}`,
      })
      return ctx.reply(`✅ Your message was sent to the team. Thanks for reaching out!`)
    } catch (err) {
      return ctx.reply(`❌ Couldn't deliver your message right now — please try again shortly.`)
    }
  },
}
