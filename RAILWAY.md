# Railway deployment notes

Three things about Railway differ from a VPS: the filesystem is rebuilt on
every deploy, the image has no fonts, and the port is assigned to you. All
three are handled in code now. With a volume already mounted, there is nothing
to configure on this side — see "Do I need to add all those variables?" at the
bottom.

## 1. State resets on every redeploy — the volume

Railway rebuilds the container from GitHub on every deploy. Anything the bot
wrote to disk inside the deployment is gone: group settings, moderation state,
spawn lists, night mode, spin locks.

**You already have a volume with `db.json` and `paired_number.txt` on it, so
there is nothing to add.** `lib/runtime-paths.js` finds it by itself, in this
order:

1. `RUNTIME_DATA_DIR` / `DATA_DIR`, if you set one.
2. **The folder `DB_PATH` already points at.** If `db.json` is on the volume,
   that *is* the volume, and the remaining state files are created beside it.
3. `RAILWAY_VOLUME_MOUNT_PATH` — Railway sets this automatically for whatever
   mount path you chose.
4. `/data`, `/mnt/data`, `/var/data`, `/app/data` if one exists and is writable.
5. `./data` — no persistence. You'll see a warning on boot if it gets here.

On the next boot you should see something like:

```
💾 Persistent state dir: /data — seeded 8 file(s) from the repo on first boot:
   group-settings.json, moderation.json, mod-gc.json, … — kept 2 existing file(s)
```

"kept" is your existing `db.json` and `paired_number.txt`. **Files already on
the volume are never overwritten**, so your players and your pairing are
untouched. The seeding happens once; after that the volume wins and deploys
can't revert it.

If that line says `./data`, the volume wasn't found — check that `DB_PATH`
really points onto the mount, or set `RUNTIME_DATA_DIR` to the mount path.

### What moved and what didn't

- **Moved (mutable state):** `group-settings.json`, `moderation.json`,
  `mod-gc.json`, `submissions.json`, `night-mode.json`, `spin-locks.json`,
  `premium-groups.json`, `card-spawn-groups.json`, `pokemon-spawn-groups.json`,
  `series-spawn-groups.json`, `telegram-groups.json`, `paired_number.txt`,
  `db.json`, `auth_info/`.
- **Did NOT move (static catalogs):** `items.json`, `monsters.json`,
  `locations.json`, `characters.json`, `pets.json`, `beasts.json` and the rest.
  Those are code — they *should* be replaced on every deploy, that's how
  balance changes ship.

Adding a new file the bot writes? Add its name to `MUTABLE_FILES` in
`lib/runtime-paths.js`, or it will start reverting on deploy again.

## 2. Generated images had no text — fixed in code, nothing to configure

Every `lib/*-render.mjs` asks for generic font families (`sans-serif`,
`serif`, `Georgia`). Those resolve against the host's installed fonts. Railway's
image has none, so `@napi-rs/canvas` drew the boxes, bars and artwork but
**every label, name and number came out blank**.

Fixed by shipping the fonts with the repo:

- `lib/assets/fonts/` now contains DejaVu Sans/Serif/Mono (free licence).
- `lib/fonts.js` registers each file under every family the renderers ask for,
  including the generic names, and is imported by every renderer.

Make sure `lib/assets/fonts/*.ttf` is actually committed — it's ~3 MB of
binaries and a `.gitignore` rule for assets would silently bring the bug back.
`.health` reports what got registered.

If you'd rather use system fonts as well, add `fonts-dejavu-core` and
`fontconfig` to the image; the bundled ones simply take priority.

## 3. Connecting the site on Vercel — no Cloudflare

The site calls its own Vercel domain and Vercel forwards `/api/*` to Railway.
One line in the site's `vercel.json`:

```json
{ "source": "/api/:path*", "destination": "https://your-bot.up.railway.app/api/:path*" }
```

Get that domain from Railway → service → **Settings → Networking → Public
Networking → Generate Domain**. Full instructions are in `DEPLOY.md` in the
site pack.

On this side, the code now handles the rest by itself:

- **Listens on `PORT`.** Railway assigns it; a hardcoded 7002 means the health
  check fails and the domain 502s. `API_PORT` still wins on a VPS.
- **Binds `0.0.0.0`.** A loopback-bound server is invisible to Railway's router.
- **`trust proxy` is on.** TLS terminates at Railway's edge, so without this
  `secure` cookies get dropped and every client looks like the proxy's IP.
- **`PUBLIC_API_URL` defaults to `https://$RAILWAY_PUBLIC_DOMAIN`**, so avatar
  and banner URLs are right with nothing set.
- **Session cookie flags adapt**: `SameSite=Lax` when the request is
  same-origin (the rewrite setup), `SameSite=None` when the browser hits
  Railway directly.
- **Vercel preview deploys are allowed** for the same project as any
  `*.vercel.app` entry in `ALLOWED_ORIGINS` — `astral-play-git-main-you.vercel.app`
  passes, `evil.vercel.app` doesn't. Turn it off with
  `ALLOW_VERCEL_PREVIEWS=false`.

A refused origin is logged with the exact value to add, so if the site loads
but nothing on it does, read the Railway logs before guessing.

## Do I need to add all those variables?

**No. For your setup, none of them are required.** Everything has a working
default, and the two that matter most fill themselves in from what Railway
already provides.

| Variable | Do you need it? |
|---|---|
| `RUNTIME_DATA_DIR` | **No** — your volume is found via `DB_PATH` / `RAILWAY_VOLUME_MOUNT_PATH`. Set it only if the boot log shows `./data`. |
| `DB_PATH` | Keep whatever you already have. |
| `AUTH_FOLDER` | **No** — defaults next to the database on the volume. Keep yours if it's already set. |
| `PORT` | **No** — Railway sets it. |
| `PUBLIC_API_URL` | **No** — derived from `RAILWAY_PUBLIC_DOMAIN`. Set it when you attach a custom domain. |
| `ALLOWED_ORIGINS` | **Only** if you make the browser call Railway directly instead of using the Vercel rewrite. |
| `ALLOW_VERCEL_PREVIEWS` | No — on by default. |
| `DUNGEON_RUNS_PER_DAY` | No — 7 is the default now. |
| `DUNGEON_RUNS_PER_DAY_PREMIUM` | No — 20 is the default now. |
| `RATE_LIMIT_MIN_GAP_MS` / `..._MAX_PER_MINUTE` | No — 1200 / 40, and the limiter backs off on its own when WhatsApp says `rate-overlimit`. |
| `JWT_SECRET` | **Yes** — this one has no safe default and the API refuses to sign tokens without it. You'll already have it. |
| `BOT_PUBLIC_NUMBER`, `DEFAULT_COUNTRY_CODE`, `SITE_URL` | Whatever you already had — unchanged by any of this. |

Short version: change nothing, deploy, and read the boot log. It prints the
state directory, the port, the public URL and the allowed origins.
