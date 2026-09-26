/**
 * check-imports.mjs — static link check for the new website/API modules.
 *
 * `node --check` only validates syntax, and a full `import()` needs
 * node_modules (express, baileys) which isn't installed on this machine —
 * those live on the VPS. This walks every relative import in the files we
 * touched and confirms the target file exists and really exports the names
 * being imported. Catches the whole class of "typo'd an export name" bugs
 * without needing dependencies installed.
 *
 * Run: node scripts/check-imports.mjs
 */
import fs from 'fs'
import path from 'path'

const FILES = [
  'lib/api-server.js',
  'lib/player-factory.js',
  'lib/notification-repo.js',
  'lib/alerts.js',
  'lib/otp-store.js',
  'plugins/register.js',
  'main.js',
]

const cache = new Map()

function exportsOf(file) {
  if (cache.has(file)) return cache.get(file)
  if (!fs.existsSync(file)) { cache.set(file, null); return null }

  const src = fs.readFileSync(file, 'utf8')
  const names = new Set()

  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1])
  }
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/\s+as\s+/)
      const name = (seg[1] ?? seg[0] ?? '').trim()
      if (name) names.add(name)
    }
  }
  if (/export\s+default/.test(src)) names.add('default')

  cache.set(file, names)
  return names
}

let problems = 0

for (const file of FILES) {
  if (!fs.existsSync(file)) {
    console.log(`MISSING FILE    ${file}`)
    problems++
    continue
  }
  const src = fs.readFileSync(file, 'utf8')

  // One import statement at a time. The clause can't contain a quote, which
  // is what stops the match running on into the next import line.
  for (const m of src.matchAll(/^import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1].trim()
    const spec = m[2]
    if (!spec.startsWith('.')) continue // bare package — needs node_modules

    const target = path.normalize(path.join(path.dirname(file), spec))
    const names = exportsOf(target)
    if (!names) {
      console.log(`MISSING FILE    ${file} -> ${spec}`)
      problems++
      continue
    }

    const named = clause.match(/\{([\s\S]*?)\}/)
    if (named) {
      for (const part of named[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (!name) continue
        if (!names.has(name)) {
          console.log(`MISSING EXPORT  ${file}: { ${name} } from ${spec}`)
          problems++
        }
      }
    }

    const def = clause.replace(/\{[\s\S]*?\}/, '').replace(/(^,)|(,$)/g, '').trim()
    if (def && !def.startsWith('*') && !names.has('default')) {
      console.log(`MISSING DEFAULT ${file}: ${def} from ${spec}`)
      problems++
    }
  }
}

console.log(problems ? `\n${problems} problem(s)` : '\nAll local imports resolve to real exports.')
process.exit(problems ? 1 : 0)
