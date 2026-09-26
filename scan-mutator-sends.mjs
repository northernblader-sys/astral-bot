// Throwaway: find awaited network sends INSIDE updatePlayer/updateAllPlayers
// mutator callbacks — those are the ones that freeze the global write queue.
// A top-level `await reply(...)` is fine; only nested ones matter.
import fs from 'fs'
import path from 'path'

const dir = './plugins'
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'))

const SEND_RE = /await\s+(ctx\.)?reply\s*\(|await\s+[\w.]*\bsendMessage\s*\(|await\s+ctx\.replyWithImage\s*\(|await\s+ctx\.replyImage\s*\(/
const MUT_RE  = /\b(updatePlayer|updateAllPlayers)\s*\(/g

let total = 0
const hits = {}

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  const lines = src.split('\n')
  let m
  while ((m = MUT_RE.exec(src)) !== null) {
    // find the callback: scan forward to the first '=>' or 'function', then to
    // the '{' that opens the body, then track brace depth to its close.
    const start = m.index
    const arrowIdx = src.indexOf('=>', start)
    const funcIdx  = src.indexOf('function', start)
    let bodyOpen = -1
    const anchor = (arrowIdx !== -1 && (funcIdx === -1 || arrowIdx < funcIdx)) ? arrowIdx : funcIdx
    if (anchor === -1 || anchor - start > 200) continue // not a callback-taking call
    bodyOpen = src.indexOf('{', anchor)
    if (bodyOpen === -1) continue
    let depth = 0, i = bodyOpen, end = -1
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) end = src.length
    const body = src.slice(bodyOpen, end)
    const sm = body.match(new RegExp(SEND_RE, 'g'))
    if (sm) {
      const lineNo = src.slice(0, start).split('\n').length
      total += sm.length
      ;(hits[f] ||= []).push({ mutatorLine: lineNo, awaitedSends: sm.length })
    }
  }
  MUT_RE.lastIndex = 0
}

console.log('Files with awaited sends INSIDE a mutator callback:\n')
for (const [f, arr] of Object.entries(hits)) {
  const totalF = arr.reduce((s, a) => s + a.awaitedSends, 0)
  console.log(`  ${f.padEnd(24)} ${totalF} awaited send(s) across mutator(s) at line(s) ${arr.map(a => a.mutatorLine).join(', ')}`)
}
console.log(`\nTOTAL awaited sends inside mutators: ${total} across ${Object.keys(hits).length} files`)
