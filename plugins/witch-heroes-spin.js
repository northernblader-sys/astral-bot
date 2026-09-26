import { config } from '../config.js'
import { updatePlayer } from '../lib/player-repo.js'
import { characterMap } from '../lib/game-data.js'
import { spinLockGate } from '../lib/spin-locks.js'
import { getActiveSeason } from '../lib/season-engine.js'
import { NEW_CHARACTERS, pullBanner, sendBannerArt } from '../lib/witch-heroes-spins.js'

const byCommand = { 'scarlett-spin':'scarlett', scarlettspin:'scarlett', 'ronova-spin':'ronova', ronovaspin:'ronova', 'sword-spin':'sword_maiden', swordspin:'sword_maiden', maiden_spin:'sword_maiden' }
export default { name:'scarlett-spin', aliases:['scarlettspin','ronova-spin','ronovaspin','sword-spin','swordspin','maiden-spin'], category:'season', requiresPlayer:true,
 description:'Registered exclusive spins for Scarlett, Ronova and Sword Maiden',
 async run(ctx) {
  const id=byCommand[ctx.cmd] ?? (ctx.cmd.includes('ronova')?'ronova':ctx.cmd.includes('sword')||ctx.cmd.includes('maiden')?'sword_maiden':'scarlett')
  if (spinLockGate(ctx, id)) return
  if (!getActiveSeason(ctx.db)) return ctx.reply('🌙 This exclusive banner is currently closed.')
  const character=NEW_CHARACTERS.find(c=>c.id===id) ?? characterMap[id]
  if (!character) return ctx.reply('This banner is not configured.')
  const first=(ctx.player[({scarlett:'scarlettSpins',ronova:'ronovaSpins',sword_maiden:'swordMaidenSpins'})[id]]??0)===0
  let result
  await updatePlayer(ctx.db,ctx.from,p=>{ result=pullBanner(ctx.db,p,ctx.from,id,ctx.args[0]??1); return p })
  if (result.reason==='claimed') return ctx.reply(`🔒 *${character.name}* has already been claimed bot-wide. No gems were spent.`)
  if (!result.results.length) return ctx.reply(`❌ You need a Gem to spin for *${character.name}*, or have reached its cap.`)
  const won=result.results.some(x=>x.won)
  const text=won?`🎉 *${character.name} is yours!*\nSpin ${result.results.at(-1).spin}/${result.results.at(-1).spin}. Equip it with *${config.prefix}character equip ${id}*.`:`🎡 *${character.name}* — ${result.results.length} spin(s), ${result.results.at(-1).spin} total.\nNo result this time.\n💎 Gems left: ${result.remaining}`
  if (won||first) return sendBannerArt(ctx,character,text,{win:won})
  return ctx.reply(text)
 }
}
