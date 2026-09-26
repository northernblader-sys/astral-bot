/** Edit only a message sent by this bot in the current chat. Preserve the
 * original Baileys key, including participant metadata when present.
 */
export function editOwnWhatsAppText(sock, chatId, sent, text) {
  if (!sent?.key?.id || sent.key.remoteJid !== chatId || sent.key.fromMe !== true) {
    throw new Error('Cannot edit a message not sent by this bot in this chat')
  }
  return sock.sendMessage(chatId, { text: String(text), edit: sent.key })
}
