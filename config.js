import { defaultDbPath, defaultAuthFolder, runtimePath } from './lib/runtime-paths.js'
import 'dotenv/config'
import pino from 'pino'

/**
 * Central config — values are read from environment variables when present,
 * with the original hardcoded values kept as fallback defaults.
 * See .env.example for the full list of supported variables.
 *
 * .env is the source of truth. The defaults below exist so a fresh clone
 * still boots, not so anything can be configured by editing this file — put
 * real values in .env, which is gitignored.
 */

/**
 * Records, per key, whether the live value came from .env or from the
 * hardcoded fallback below. Populated as this module initialises; read by
 * describeConfigSources() for the startup banner.
 */
const CONFIG_SOURCES = new Map()

/** Keys whose VALUE must never be printed to a log. Presence only. */
const SECRET_KEYS = new Set([
  'JWT_SECRET', 'DISCORD_TOKEN', 'TELEGRAM_TOKEN',
  'OMDB_API_KEY', 'IMGBB_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'BANK_ACCOUNT', 'BANK_ACCOUNT_NAME',
  // Holds the database username and password. Anyone with this string owns
  // every player's data.
  'MONGO_URI',
])

/**
 * Read an env var, treating BLANK as unset.
 *
 * `process.env.X ?? default` only falls back when X is undefined. A key that
 * is PRESENT BUT EMPTY — which is exactly what `.env.example` ships for
 * OWNER_NUMBERS, OWNER_LID, OMDB_API_KEY and friends — is the string '', which
 * is not nullish, so the default is skipped and the empty string wins.
 *
 * That failed silently and dangerously: `''.split(',')` is `['']`, so
 * isOwnerJid() would compare every sender against '@s.whatsapp.net' and NOBODY
 * would be owner, with nothing logged to say why. Anyone who copied
 * .env.example verbatim lost every admin command.
 */
function env(key, fallback) {
  const raw = process.env[key]
  const fromEnv = raw !== undefined && raw.trim() !== ''
  CONFIG_SOURCES.set(key, { fromEnv, hasValue: fromEnv || (fallback !== undefined && fallback !== '') })
  return fromEnv ? raw : fallback
}

/** Same, for comma-separated lists. Blank entries are dropped. */
function envList(key, fallback = []) {
  const raw = process.env[key]
  const parts = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const fromEnv = parts.length > 0
  CONFIG_SOURCES.set(key, { fromEnv, hasValue: fromEnv || fallback.length > 0 })
  return fromEnv ? parts : fallback
}

/**
 * What the bot is actually running on, for the startup banner.
 *
 * The point is that a value silently coming from a hardcoded default is
 * indistinguishable, at runtime, from one you set deliberately — until an
 * owner command is denied or an OTP goes to the wrong place. This makes the
 * difference visible on every boot.
 *
 * Secret VALUES are never included; only whether the key is set.
 */
export function describeConfigSources() {
  const fromEnv = []
  const fromDefault = []
  const missing = []
  for (const [key, { fromEnv: e, hasValue }] of CONFIG_SOURCES) {
    if (e) fromEnv.push(key)
    else if (hasValue) fromDefault.push(key)
    else missing.push(key)
  }
  return { fromEnv, fromDefault, missing, secretKeys: [...SECRET_KEYS] }
}

export const config = {
  prefix: '.', // Changing this value updates the prefix everywhere — no other file should hardcode it.
  // Telegram users reach for "/" by reflex, so that platform accepts it in
  // addition to the global prefix above — `/menu` and `.menu` both work there.
  // Every help/error string in the bot is built from `prefix`, so the global
  // one must stay accepted or 445 references would print unusable examples.
  // Set TELEGRAM_PREFIX to change what the extra prefix is.
  telegramPrefix: env('TELEGRAM_PREFIX', '/'),
  ownerNumbers: envList('OWNER_NUMBERS', ['2347062301848']),
  // LID (Linked ID) — some WhatsApp accounts resolve to a LID rather than a
  // plain phone number JID. If set, this takes priority for the owner DM
  // since @s.whatsapp.net won't reach a LID-based account.
  ownerLid: env('OWNER_LID', '87209327755401'),
  // Owner ids on the other two platforms. These are NOT phone numbers —
  // OWNER_NUMBERS can't cover them, because a Discord user id and a Telegram
  // user id are their own namespaces. Comma-separated, numeric ids only.
  // Discord: enable Developer Mode, right-click yourself → Copy User ID.
  // Telegram: message @userinfobot, it replies with your id.
  // Left empty by default: with no id set, nobody is owner on that platform
  // and only chat admins pass the admin gate.
  discordOwnerIds: envList('DISCORD_OWNER_IDS', []),
  telegramOwnerIds: envList('TELEGRAM_OWNER_IDS', []),
  // Fallback display name — used only where a per-instance ctx.botName isn't
  // available (e.g. code running outside a message handler). In normal
  // command handling, ctx.botName (the name of whichever number the message
  // came in on) always takes priority over this. Defaults to bot #1's name.
  botName: env('BOT_NAME', 'Astral of the Sun'),
  // Defaults to the persistent volume when one is mounted (RUNTIME_DATA_DIR
  // or /data on Railway) — otherwise ./db.json as before. A deploy that wipes
  // the container must not wipe every player. See lib/runtime-paths.js.
  dbPath: env('DB_PATH', defaultDbPath()),

  // ── Backing the database up off this machine ────────────────────────────
  // dbPath above is always the live database. Set MONGO_URI and every save is
  // additionally copied up to MongoDB (Atlas) the moment it lands on disk, so
  // deleting the folder — or losing the whole box — no longer loses anyone's
  // progress: the bot pulls the world back down on the next boot. Nothing waits
  // on the network, so a slow or dead cluster cannot make a command feel laggy.
  // Leave MONGO_URI unset and nothing changes: dbPath is the one and only copy.
  // See lib/mongo-adapter.js for the full behaviour, including what happens
  // when the connection drops mid-game.
  //
  // Atlas gives you this string under Database → Connect → Drivers. It looks
  // like mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/ — keep it in
  // .env, never in this file: it is the password to all player data.
  mongoUri: env('MONGO_URI', ''),
  // Which database inside the cluster. Two bots can share one cluster safely
  // as long as they use different names here — that is also how you'd run a
  // test world next to the live one.
  mongoDbName: env('MONGO_DB_NAME', 'astral'),
  // Escape hatch for the cross-machine writer lock (lib/mongo-adapter.js).
  // Only ever set this true when you are certain no other bot process is
  // running, e.g. the lock is held by a VPS you already destroyed and you
  // don't want to wait 90s for the heartbeat to go stale. Two live writers on
  // one database silently corrupt each other's saves.
  mongoAllowSecondWriter: env('MONGO_ALLOW_SECOND_WRITER', 'false').trim().toLowerCase() === 'true',
  // ── Multi-VPS cluster mode (Phase 2, DORMANT) ───────────────────────────
  // OFF by default, and it MUST stay off on the live single-VPS deploy. When
  // true, player writes stop going through the whole-object save and instead
  // read each player fresh from MongoDB and write ONE player document back
  // atomically (an optimistic `rev` compare-and-swap in lib/mongo-adapter.js,
  // driven by lib/player-repo.js), so several VPS pointed at one database
  // cannot clobber each other's player saves. It also implies
  // mongoAllowSecondWriter above, since every node must be allowed to write.
  //
  // NOT YET SAFE to enable in production. Shared tables (market, empires,
  // parties, lottery, tourneys, guilds), the background sweeps in main.js and
  // the in-memory battle/PvP state are all still single-writer assumptions;
  // turning this on before those phases land would lose that shared state. It
  // exists now only so the per-player path can be tested in isolation (two
  // nodes against one throwaway MONGO_DB_NAME). Requires MONGO_URI. See the
  // mongo-multivps-migration notes for the remaining phases.
  clusterMode: env('CLUSTER_MODE', 'false').trim().toLowerCase() === 'true',
  // OMDb API key — used by .movies / .ss / .film (plugins/ss.js)
  omdbApiKey: env('OMDB_API_KEY', '7c3e0084'),
  // ImgBB API key — used by lib/imgbb.js to host .setpfp/.setbanner uploads
  // remotely instead of writing them to local disk (media/pfp, media/banner).
  // Get a free key at https://api.imgbb.com/ and paste it below in place of
  // 'PASTE_YOUR_NEW_IMGBB_KEY_HERE'. (Still overridable via IMGBB_API_KEY
  // in .env if you ever switch to that later.)
  imgbbApiKey: env('IMGBB_API_KEY', '793d661bf2241fffc3a1a321582e2488'),
  // Pixelcut API key — used by .upscale (plugins/downloader.js). No fallback:
  // there is no shared key to fall back to, and the command already prints a
  // "set PIXELCUT_API_KEY in .env" message when it's missing.
  pixelcutApiKey: env('PIXELCUT_API_KEY', ''),
  // Gemini API key - powers Echidna's voice (plugins/echidna.js talks to her
  // via plugins -> lib/gemini.js). Same rule as MONGO_URI: a real key lives
  // in .env (gitignored) or the deploy's environment variables, NEVER in
  // this file - committing it would publish it to every clone of the repo.
  // With no key set, .echidna chat says so in character and everything else
  // about Echidna (spin, .greed, the child) works unchanged.
  geminiApiKey: env('GEMINI_API_KEY', '') || env('GOOGLE_API_KEY', '').trim(),
  // Which Gemini model speaks as her. lib/gemini.js falls back down a small
  // ladder (gemini-2.5-flash -> 2.0-flash -> 1.5-flash) if a name 404s for
  // the key's tier, so this rarely needs touching.
  geminiModel: env('GEMINI_MODEL', 'gemini-2.5-flash'),
  // WhatsApp group invite link for player support — shown via .support.
  supportGroupLink: env('SUPPORT_GROUP_LINK', 'https://chat.whatsapp.com/KwYfA8cxD6N9q2d4mQfliT'),
  // Community invite links, one per platform — shown via .whatsapp / .telegram
  // / .discord (plugins/community-links.js). Each is independent of
  // supportGroupLink above: that one is the *support* group, these are the
  // general community hubs and may point somewhere different. Empty string
  // means "not set up yet" and the command says so instead of posting a dead
  // link.
  communityWhatsappLink: env('COMMUNITY_WHATSAPP_LINK', ''),
  communityTelegramLink: env('COMMUNITY_TELEGRAM_LINK', 'https://t.me/+7puzqa5_9bNjOTU0'),
  communityDiscordLink: env('COMMUNITY_DISCORD_LINK', 'https://discord.gg/sxVMZJ8vwq'),
  // Bank account shown in .premium buy / .topup buy payment-details replies.
  // No hardcoded fallback on purpose — a real account number does not belong
  // in source control, where it ends up in every clone, backup and zip of the
  // repo. Set BANK_NAME / BANK_ACCOUNT / BANK_ACCOUNT_NAME in .env (which is
  // gitignored). If they're unset the payment replies say "(not configured)"
  // rather than quietly billing to whoever was last hardcoded here.
  payment: {
    bankName:      env('BANK_NAME', 'Monipoint'),
    accountNumber: env('BANK_ACCOUNT', '5197434428'),
    accountName:   env('BANK_ACCOUNT_NAME', 'Flora'),
  },

  // ── API server ────────────────────────────────────────────────────────
  // The port the Express server listens on.
  // PORT first: Railway (and most PaaS) assign the port and expect the app to
  // listen on it — hardcoding 7002 there means the health check never passes
  // and the public domain 502s. API_PORT still wins on a VPS where you pick
  // the port yourself; 7002 is the last resort.
  apiPort: parseInt(env('PORT', env('API_PORT', '7002')), 10),

  // The public HTTPS origin this API is reachable at from the internet —
  // NOT the internal apiPort. On Railway this fills itself in from
  // RAILWAY_PUBLIC_DOMAIN (the xxx.up.railway.app name, or your custom
  // domain once you attach one), so no Cloudflare and no manual value is
  // needed. Used to build absolute image URLs
  // (avatarUrl/bannerUrl) for <img> tags on the site, since those don't
  // go through the frontend's API client base-URL rewriting. Override
  // with PUBLIC_API_URL in .env if the domain ever changes.
  publicApiUrl: env(
    'PUBLIC_API_URL',
    process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://animeastral.qzz.io',
  ).replace(/\/+$/, ''),

  // The player-facing WEBSITE origin — where people sign up, log in and read
  // their notification bell. This is the frontend, NOT publicApiUrl above
  // (that one is the API origin behind the Cloudflare Origin Rule). Used by
  // .connect to tell players exactly where to go and where to read their
  // link code. Override with SITE_URL in .env if the domain changes.
  siteUrl: env('SITE_URL', 'https://playastral.qzz.io').replace(/\/+$/, ''),

  // Country code assumed when someone types a LOCAL number on the login
  // page — i.e. one starting with a single 0, like 0706 230 1848. That 0 is
  // replaced with this, so 0706… becomes 234706….
  //
  // Get this wrong and the OTP goes to the wrong country's number: a
  // Pakistani player typing 0337… would be "corrected" into a Nigerian
  // 234337…, and if that number happens to exist on WhatsApp, a stranger
  // receives their login code. Set DEFAULT_COUNTRY_CODE in .env to whatever
  // your players actually dial from. Numbers typed in full international
  // form (+92…, 92…, 0092…) are never rewritten.
  defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '234').replace(/\D+/g, '') || '234',

  // Long random string used to sign session JWTs. Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  // Put the output in your VPS's .env as JWT_SECRET — never commit it.
  // A blank JWT_SECRET= line means "unset", not "the empty secret" — the API
  // server's length check then reports it properly instead of signing tokens
  // with ''.
  jwtSecret: env('JWT_SECRET', undefined),

  // Exact frontend origin(s) allowed to call this API with credentials.
  // Must be the literal Vercel URL (and/or your custom domain if you point
  // one at Vercel too) — no wildcards, no trailing slash. Defaults cover
  // the standard astral-web Vercel domain plus any preview/custom domain
  // you add later — extend via ALLOWED_ORIGINS in .env (comma-separated)
  // rather than editing this file, so it survives deploys.
  allowedOrigins: envList('ALLOWED_ORIGINS', [
    'https://playastral.qzz.io',
    'https://astral-play.vercel.app',
  ]).map(s => s.replace(/\/+$/, '')),
  // e.g. in .env: ALLOWED_ORIGINS=https://astral-web.vercel.app,https://astral.yourdomain.com

  // Vercel gives every branch and every commit its own URL
  // (astral-play-git-main-you.vercel.app, astral-play-a1b2c3.vercel.app…).
  // Listing them is impossible, so previews of the SAME project are matched
  // by pattern instead: the project names are taken from whatever
  // *.vercel.app entries are in allowedOrigins above, and nothing else on
  // vercel.app is allowed. Set ALLOW_VERCEL_PREVIEWS=false to require exact
  // matches only.
  allowVercelPreviews: env('ALLOW_VERCEL_PREVIEWS', 'true') !== 'false',

  // The bot's own WhatsApp number (digits only, no +, no @s.whatsapp.net),
  // used to build the wa.me premium-purchase deep link the frontend calls.
  // This is a PUBLIC number (people already DM it to use the bot) — safe
  // to expose, unlike jwtSecret.
  botPublicNumber: env('BOT_PUBLIC_NUMBER', undefined),

  // How many naira one US dollar is worth, for the website's price labels.
  // DISPLAY ONLY. Nothing is ever charged in dollars: plans and gem packages
  // are priced in naira in data/premium-plans.json and data/topup-packages.json,
  // and `.premium buy` / `.topup buy` still quote and collect naira. This value
  // exists so the premium page can show a dollar figure to players who don't
  // think in naira, with the naira amount beside it.
  //
  // It will drift, which is why it's an env var and not a literal: set
  // NAIRA_PER_USD in .env and restart the bot. The site reads it out of the
  // /api/premium payload, so a rate change needs no frontend redeploy. Use the
  // rate you actually receive rather than the mid-market one, or the dollar
  // label under-quotes what a payer really hands over. Zero, blank or
  // unparseable means "no rate", and the site shows naira only.
  nairaPerUsd: Number(env('NAIRA_PER_USD', '1385')) || 0,

  // How long a requested OTP code stays valid, in milliseconds.
  otpTtlMs: parseInt(env('OTP_TTL_MS', String(5 * 60_000)), 10),

  // When true, /api/auth/request-otp echoes the code back in its JSON
  // response instead of relying only on the WhatsApp DM — useful for local
  // testing. MUST be false/unset in production, or anyone could log in as
  // anyone else without needing the real phone.
  devMode: env('DEV_MODE', 'false').trim().toLowerCase() === 'true',
}

/**
 * WhatsApp numbers — each entry is one connection, run as a socket inside this
 * process (main.js loops over this array). This is now ONE number per process.
 *
 * Deploy model: one number per VPS. Copy the same files to each box, give each
 * its own paired_number.txt and auth_info, and point them all at one MONGO_URI
 * so a player is the same character on whichever number they message.
 *
 * NOT YET SAFE to run several VPS at once. The bot still loads the whole world
 * into RAM and saves it as one object, and lib/mongo-adapter.js only lets ONE
 * machine write (the __writer_lock). Until the per-player atomic write path
 * lands, run exactly one VPS live: two would clobber each other's saves, which
 * is the same data loss the single-process rule was built to stop. See the
 * mongo-multivps-migration notes for the phases.
 *
 * The entry needs its paired_number.txt to exist and hold the number, digits
 * only (e.g. 2348012345678), before starting. Without it main.js logs that the
 * file is missing or blank and won't pair. auth_info/ is created automatically
 * on first run, which requests a fresh pairing code.
 *
 * If the number gets banned, tighten its rateLimit below (lower maxPerMinute,
 * raise minGapMs) via RATE_LIMIT_MIN_GAP_MS / RATE_LIMIT_MAX_PER_MINUTE in .env
 * before re-pairing: a repeat ban usually means send volume, not the pairing.
 */
export const bots = [
  {
    botName: env('BOT_NAME', 'Astral of the Sun'),
    authFolder: env('AUTH_FOLDER', defaultAuthFolder()),
    phoneFile: env('PHONE_FILE', runtimePath('paired_number.txt')),
    rateLimit: {
      minGapMs: parseInt(env('RATE_LIMIT_MIN_GAP_MS', '1200'), 10),
      maxPerMinute: parseInt(env('RATE_LIMIT_MAX_PER_MINUTE', '40'), 10),
    },
  },
]

// Two transports so PM2's log split is meaningful: warn/info/debug go to
// stdout (pm2-out.log), error/fatal go to stderr (pm2-err.log). With a single
// stdout transport — the previous setup — pm2-err.log stayed empty and every
// failure had to be dug out of the noise in pm2-out.log.
export const logger = pino({
  level: env('LOG_LEVEL', 'warn'),
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        level: env('LOG_LEVEL', 'warn'),
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          destination: 1,          // stdout
        },
      },
      {
        target: 'pino-pretty',
        level: 'error',
        options: {
          colorize: false,         // err logs get read with grep/tail, not a TTY
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
          destination: 2,          // stderr
        },
      },
    ],
  },
})
