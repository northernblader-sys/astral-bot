/**
 * link-check.mjs — assertions for the antilink link detector.
 *
 * Run: node scripts/link-check.mjs
 *
 * The MUST NOT list is the important half of this file. A false positive here
 * gets a real person removed from a group they may not be able to rejoin, so
 * ordinary chat that happens to look domain-ish ("ok.so anyway", "done.in the
 * morning", "version 1.5") is tested just as carefully as the actual links.
 */
import { containsLink } from '../lib/group-helpers.js'

let pass = 0
let fail = 0

function expectLink(text) {
  if (containsLink(text)) { pass++; return }
  fail++
  console.log(`  ✗ MISSED a link: ${JSON.stringify(text)}`)
}

function expectClean(text) {
  if (!containsLink(text)) { pass++; return }
  fail++
  console.log(`  ✗ FALSE POSITIVE (would kick): ${JSON.stringify(text)}`)
}

console.log('\n── must be caught ────────────────────────────────────────────')
const LINKS = [
  // Tier 1: schemes and www.
  'https://example.com',
  'http://example.com/page?a=1',
  'check this https://google.com out',
  'HTTPS://EXAMPLE.COM',
  'ftp://files.example.net/pub',
  'www.example.com',
  'go to www.bbc.co.uk now',
  'tg://join?invite=abc123',
  // Tier 2: invite hosts and shorteners (word-like TLDs)
  'https://chat.whatsapp.com/ABCdef123',
  'chat.whatsapp.com/ABCdef123',
  'join here t.me/somechannel',
  'discord.gg/abcdef',
  'wa.me/2348012345678',
  'youtu.be/dQw4w9WgXcQ',
  'linktr.ee/someone',
  'mega.nz/file/xyz',
  // Tier 3: bare domains on a domain-flavoured TLD
  'example.com',
  'visit example.com for more',
  'freerobux.xyz',
  'my-site.online',
  'sub.domain.example.org',
  'earnmoney.tk',
  'shop.example.co',
  // Tier 4: word-like TLD rescued by a path
  'bit.ly/3xK9aQ',
  'is.gd/abc123',
  'example.to/promo',
  'sketchy.site/free',
  'test.in/offer',
  // obfuscation
  'foo (dot) com',
  'foo[dot]com',
  'foo[.]com',
  'example dot com',
  'hxxp://malware.example',
  'hxxps://malware.example',
  'chat . whatsapp . com / ABCdef',
  't . me / channel',
  'https : / / example.com',
  // invisible-character padding
  'exam​ple.com',
  // full-width dot
  'example．com',
  // multi-line: link buried in a longer message
  'hey everyone\nfree gift cards here\nfreestuff.xyz\nfirst come first serve',
]
for (const t of LINKS) expectLink(t)

console.log('\n── must NOT be caught ────────────────────────────────────────')
const CLEAN = [
  // the four the strictness decision explicitly promised
  'ok.so anyway',
  'done.in the morning',
  'hi.how are you',
  'version 1.5',
  // sentence punctuation with a word-like TLD on the right
  "I'm done. Best regards",
  'call me. In the morning',
  'that is it. So what now',
  'finished.at last',
  'oh.my god',
  'stop.by later',
  'the wi.fi is down',
  'love you.mom',
  'she is on.cam right now',
  'james.bond is on tonight',
  'stop.it now',
  'wait.no really',
  'yes.me too',
  'nope.to be fair',
  'lets.go team',
  'why.is this happening',
  'sure.am glad',
  'run.it back',
  'ok.no worries',
  'app.live stream later',
  'the link.click it',
  'good news.today was fine',
  'my work.life balance',
  'one.two.three',
  // numbers and versions
  'v2.10.4 released',
  'deal 12.5 damage',
  'the ratio is 9.30/10',
  '192.168 something',
  // ordinary chat
  'hello world',
  'gm everyone',
  'lol what',
  'w/e man',
  'and/or',
  'he said etc. and left',
  'no.1 fan',
  'Mr. Smith arrived',
  'U.S.A.',
  'e.g. this one',
  'i.e. that one',
  '...',
  '. . .',
  '',
  '   ',
  // bot commands, which must never read as links
  '.profile',
  '.song alan walker faded',
  '.inn sleep',
  '.menu group',
  // an email address is not a link
  'mail me at someone@example.com',
  'contact: admin@my-site.org',
  // decorative middle dots the bot itself uses
  'Level 5 · HP 200 · ATK 40',
  // a filename is not a link
  'sent report.pdf earlier',
  'open config.json and edit it',
  'the file is data.csv',
  'try index.html',
  'run main.js first',
  'saved as photo.png',
]
for (const t of CLEAN) expectClean(t)

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
