import { updatePlayer, getPlayer } from '../lib/player-repo.js'
import { activateEndworld, useSword, swordStatus, completeTurn, absoluteSlash } from '../lib/witch-heroes.js'
import { showCoordinate } from '../lib/witch-heroes-cinematic.js'
function targetFor(db,p) { return p?.battleState?.enemy ?? getPlayer(db,p?.battleState?.opponentJid) ?? null }
export default { name:'endworld', aliases:['end-world','ss','swordstatus','sword-status','sword','absolute-sword'], category:'combat', requiresPlayer:true, description:'Scarlett, Ronova and Sword Maiden combat actions', async run(ctx) {
 const cmd=ctx.cmd
 if (cmd==='ss'||cmd==='swordstatus'||cmd==='sword-status') return ctx.reply(swordStatus(ctx.player))
 if (cmd==='endworld'||cmd==='end-world') { let out; await updatePlayer(ctx.db,ctx.from,p=>{out=activateEndworld(p);return p}); return ctx.reply(out.message) }
 let out, targetId=null, strikes=[]
 await updatePlayer(ctx.db,ctx.from,p=>{ const t=targetFor(ctx.db,p); targetId=p.battleState?.opponentJid; out=useSword(p,t,ctx.args[0]?.toLowerCase()); if(out.ok && out.cinematic==='coordinate' && t) { for(let i=0;i<out.strikes;i++) strikes.push({damage:absoluteSlash(p,t,1),revived:false}) }
  if(out.ok && t?.battleState) completeTurn([p,t],p.battleState.turn??1); return p })
 // PvP opponent objects are independent persisted records; commit any sequential slash.
 if (out?.ok && targetId) await updatePlayer(ctx.db,targetId,p=>p)
 if (out?.ok && out.cinematic==='coordinate') return showCoordinate(ctx,strikes, out.message, { player:ctx.player, participants:[ctx.player, targetFor(ctx.db,ctx.player)] })
 return ctx.reply(out?.message ?? 'No active battle.')
} }
