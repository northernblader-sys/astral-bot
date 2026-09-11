// ── Multi-number setup ───────────────────────────────────────────────────
// Both WhatsApp numbers run as sockets INSIDE ONE PM2 process (main.js
// loops over config.js's `bots` array and opens one Baileys connection per
// entry) — deliberately not one PM2 process per number, because that would
// mean two Node processes both reading/writing the same db.json with no
// shared write queue between them, which is a known way to silently lose
// player data (gold/items vanishing) under concurrent writes. See the
// comment at the top of main.js and in lib/player-repo.js for the full
// explanation.
//
// To add a third number, add an entry to the `bots` array in config.js
// (with matching AUTH_FOLDER_3 / PHONE_FILE_3 / BOT_NAME_3 env vars) — no
// changes needed here, since everything still runs as this single process.
// ── WhatsApp-only ─────────────────────────────────────────────────────────
// This launches main.js, which runs the WhatsApp number(s) plus the website
// API in one process. Telegram and Discord are intentionally not started: the
// adapters, their plugin directories and the multi-platform entry points were
// removed, so this is a WhatsApp-only deploy by design. To bring the other
// platforms back, restore those files and repoint this at their entry point.
module.exports = {
  apps: [
    {
      name: 'rpg-bot',
      script: 'main.js',
      interpreter: 'node',
      node_args: '--max-old-space-size=512',
      watch: false,
      autorestart: true,
      max_restarts: 999,
      min_uptime: '10s',
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
